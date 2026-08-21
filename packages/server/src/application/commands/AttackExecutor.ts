import {
  AttackType,
  FEATURES,
  DamageType,
  WeaponType,
  IdGenerator,
  weaponRegistry,
  TIER_STAT_MULTIPLIER,
  NETWORK,
  type HurtboxEntity,
} from '@sector-battle/shared';
import type { MeleeSweepHandler } from '../../domain/handlers/MeleeSweepHandler.ts';
import { gatherHurtboxEntities } from '../../domain/handlers/HurtboxGathering.ts';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { Player } from '../../domain/entities/index.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import type { GameEvent } from '../../domain/events/index.ts';
import { AttackHandlerRegistry } from '../strategies/attacks/index.ts';
import type { AttackParams, AttackContext } from '../strategies/attacks/index.ts';
import type { ShieldHandler } from '../../domain/handlers/ShieldHandler.ts';
import type { DestructibleDamageHandler } from './DestructibleDamageHandler.ts';

export class AttackExecutor {
  private sweepHandler: MeleeSweepHandler | null = null;
  private getHandWorld: ((playerId: string) => { x: number; y: number } | null) | null = null;

  constructor(
    private match: GameMatch,
    private shieldHandler: ShieldHandler,
    private idGenerator: IdGenerator,
    private destructibleHandler: DestructibleDamageHandler,
  ) {}

  setSweepHandler(sweepHandler: MeleeSweepHandler): void {
    this.sweepHandler = sweepHandler;
  }

  setHandWorldProvider(provider: (playerId: string) => { x: number; y: number } | null): void {
    this.getHandWorld = provider;
  }

  /**
   * Projectile spawn point: the simulated weapon hand at release. Wall-safe —
   * if an enriched collider sits between the body and the hand (hugging a
   * wall), fall back to the player center so projectiles can't start inside
   * walls. Uses SAT point-sampling (same path as the melee blade) so thin /
   * partial wall colliders are respected, not just tile-grid occupancy.
   */
  private getProjectileSpawn(player: Player): { x: number; y: number } {
    const center = { x: player.movement.position.x, y: player.movement.position.y };
    const hand = this.getHandWorld?.(player.id);
    if (!hand) return center;

    const dx = hand.x - center.x;
    const dy = hand.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return center;

    const collision = this.match.getCollisionService();
    const grid = this.match.getGrid();
    const dirX = dx / dist;
    const dirY = dy / dist;
    const step = 4;
    for (let d = step; d < dist; d += step) {
      if (collision.isPointBlocked(center.x + dirX * d, center.y + dirY * d, grid)) {
        return center;
      }
    }
    if (collision.isPointBlocked(hand.x, hand.y, grid)) return center;
    return hand;
  }

  executeAttack(player: Player, weapon: WeaponEntity, weaponSlot: number): void {
    const definition = weaponRegistry.getDefinition(weapon.type);
    const effectiveType =
      (player.combat.windupAttackType as AttackType | null) ??
      (definition.meleeStats ? definition.meleeStats.attackType : definition.baseStats.attackType);
    const m = TIER_STAT_MULTIPLIER[weapon.tier];
    const rawStats =
      effectiveType !== AttackType.THROWN && definition.meleeStats
        ? (definition.meleeStats as typeof definition.baseStats)
        : definition.baseStats;
    const stats = {
      ...rawStats,
      damage: Math.round(rawStats.damage * m),
      range: Math.round(rawStats.range * m),
      knockback: Math.round(rawStats.knockback * m),
    };
    const damage = stats.damage;
    const isMelee =
      effectiveType === AttackType.ARC ||
      effectiveType === AttackType.LINE ||
      effectiveType === AttackType.SHIELD;

    // Swept melee: the simulated weapon segment is the hitbox — register the
    // swing and let MeleeSweepHandler resolve contacts tick-by-tick during
    // the strike. Cooldown anchoring stays here (legacy parity).
    if (FEATURES.SWEPT_MELEE && isMelee && this.sweepHandler) {
      if (definition.meleeStats) {
        const meleeCooldownTicks = Math.ceil(
          definition.meleeStats.cooldown / NETWORK.TICK_INTERVAL,
        );
        weapon.startAttackWithCooldown(meleeCooldownTicks);
      } else {
        weapon.startAttack();
      }
      this.sweepHandler.startSwing(
        player,
        weapon,
        weaponSlot,
        effectiveType,
        damage,
        stats.knockback,
        stats.range,
      );
      this.match.emitEvent({
        type: 'WeaponFired',
        tick: this.match.currentTick,
        timestamp: Date.now(),
        playerId: player.id,
        weaponType: weapon.type,
        attackType: effectiveType,
        direction: player.movement.facingAngle,
        x: player.movement.position.x,
        y: player.movement.position.y,
      });
      player.combat.clearWindup();
      if (effectiveType === AttackType.SHIELD) {
        player.combat.isBlocking = true;
      }
      return;
    }

    let entities: HurtboxEntity[] = [];
    let entityMap = new Map<string, HurtboxEntity>();

    if (isMelee) {
      const gathered = this.gatherHurtboxEntities(player, stats.range);
      entities = gathered.entities;
      entityMap = gathered.entityMap;

      entities = this.filterByOcclusion(player, entities);
    }

    const ctx: AttackContext = {
      match: this.match,
      currentTick: this.match.currentTick,
      idGenerator: this.idGenerator,
      shieldHandler: this.shieldHandler,
      entities,
      spawnPosition: this.getProjectileSpawn(player),
      resolveMeleeDamage: (
        p: Player,
        hitEntityIds: string[],
        dmg: number,
        kb: number,
        wType: WeaponType,
        wSlot: number,
        events: GameEvent[],
      ) => {
        this.resolveMeleeDamage(p, hitEntityIds, dmg, kb, wType, wSlot, events, entityMap);
      },
    };

    const params: AttackParams = {
      weapon,
      weaponSlot,
      damage,
      stats,
      effectiveType,
      definition,
    };

    const handler = AttackHandlerRegistry.get(effectiveType);
    if (!handler) {
      player.combat.clearWindup();
      return;
    }

    handler.execute(player, params, ctx);
  }

  private gatherHurtboxEntities(
    player: Player,
    range: number,
  ): { entities: HurtboxEntity[]; entityMap: Map<string, HurtboxEntity> } {
    return gatherHurtboxEntities(this.match, player, range);
  }

  private filterByOcclusion(player: Player, entities: HurtboxEntity[]): HurtboxEntity[] {
    return entities.filter((entity) => {
      const excludeGridPos =
        entity.kind === 'destructible' && entity.gridX !== undefined && entity.gridY !== undefined
          ? { x: entity.gridX, y: entity.gridY }
          : undefined;

      return !this.isOccluded(
        player.movement.position.x,
        player.movement.position.y,
        entity.position.x,
        entity.position.y,
        excludeGridPos,
      );
    });
  }

  private isOccluded(
    originX: number,
    originY: number,
    targetX: number,
    targetY: number,
    excludeGridPos?: { x: number; y: number },
  ): boolean {
    const dx = targetX - originX;
    const dy = targetY - originY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return false;

    const collision = this.match.getCollisionService();
    const grid = this.match.getGrid();
    const tileSize = this.match.tileWidth;
    const dirX = dx / dist;
    const dirY = dy / dist;
    const step = 4;
    for (let d = step; d < dist; d += step) {
      const sx = originX + dirX * d;
      const sy = originY + dirY * d;
      if (excludeGridPos) {
        const gx = Math.floor(sx / tileSize);
        const gy = Math.floor(sy / tileSize);
        if (gx === excludeGridPos.x && gy === excludeGridPos.y) continue;
      }
      if (collision.isPointBlocked(sx, sy, grid)) return true;
    }
    return false;
  }

  private resolveMeleeDamage(
    player: Player,
    hitEntityIds: string[],
    damage: number,
    knockback: number,
    weaponType: WeaponType,
    weaponSlot: number,
    events: GameEvent[],
    entityMap: Map<string, HurtboxEntity>,
  ): void {
    const playerIds: string[] = [];
    const destIds: string[] = [];

    for (const id of hitEntityIds) {
      const entity = entityMap.get(id);
      if (entity?.kind === 'player') playerIds.push(id);
      else if (entity?.kind === 'destructible') destIds.push(id);
    }

    if (playerIds.length > 0) {
      const pipelineEvents = this.match.getDamagePipeline().processAttack(
        {
          attackerId: player.id,
          weaponType,
          damage,
          knockbackForce: knockback,
          damageType: DamageType.MELEE_HIT,
          hitTargetIds: playerIds,
          attackAngle: player.movement.facingAngle,
          sourcePosition: { x: player.movement.position.x, y: player.movement.position.y },
          currentTick: this.match.currentTick,
          tickRate: 60,
          alivePlayerCount: this.match.getAlivePlayerCount(),
        },
        (id) => this.match.getPlayer(id),
      );
      for (const e of pipelineEvents) {
        this.match.emitEvent(e);
        events.push(e);
      }
    }

    if (destIds.length > 0) {
      this.destructibleHandler.handleDamage(destIds, this.match, events, weaponType);
    }
  }
}
