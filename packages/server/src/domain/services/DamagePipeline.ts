import { DamageType, WeaponType, EntityType, PLAYER, weaponRegistry } from '@sector-battle/shared';
import type { Player } from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import { Position, type GridCoord } from '../value-objects/index.ts';
import { ShieldHandler } from '../handlers/ShieldHandler.ts';

export interface AttackContext {
  attackerId: string;
  weaponType: WeaponType;
  damage: number;
  knockbackForce: number;
  damageType: DamageType;
  hitTargetIds: string[];
  attackAngle: number;
  sourcePosition: { x: number; y: number };
  currentTick: number;
  tickRate: number;
  alivePlayerCount: number;
}

export interface DamageContext {
  sourceId: string;
  damage: number;
  damageType: DamageType;
  targetIds: string[];
  sourcePosition: { x: number; y: number };
  currentTick: number;
  knockbackForce?: number;
  alivePlayerCount?: number;
  tickRate?: number;
  sourceType?: EntityType;
}

export interface PlayerInExplosion {
  playerId: string;
  cellX: number;
  cellY: number;
}

export class DamagePipeline {
  constructor(private readonly shieldHandler: ShieldHandler) {}

  processAttack(
    context: AttackContext,
    playerLookup: (id: string) => Player | undefined,
  ): GameEvent[] {
    return this.resolveHit({
      targetIds: context.hitTargetIds,
      playerLookup,
      attacker: playerLookup(context.attackerId),
      sourceId: context.attackerId,
      sourcePosition: context.sourcePosition,
      // Weapon hits angle the shield check at the live attacker (falling back
      // to sourcePosition when the attacker is gone) — see resolveHit.
      shieldAngleFromAttacker: true,
      damage: context.damage,
      knockbackForce: context.knockbackForce,
      damageType: context.damageType,
      currentTick: context.currentTick,
      tickRate: context.tickRate,
      weaponType: context.weaponType,
      sourceType: EntityType.PLAYER,
      alivePlayerCount: context.alivePlayerCount,
    }).events;
  }

  processDamage(
    context: DamageContext,
    playerLookup: (id: string) => Player | undefined,
  ): { events: GameEvent[]; killed: boolean; damageApplied: number } {
    return this.resolveHit({
      targetIds: context.targetIds,
      playerLookup,
      attacker: playerLookup(context.sourceId),
      sourceId: context.sourceId,
      sourcePosition: context.sourcePosition,
      // Environmental/generic damage angles the shield check at the source
      // position (explosion/trap center), never at the recorded source player.
      shieldAngleFromAttacker: false,
      damage: context.damage,
      knockbackForce: context.knockbackForce ?? 0,
      damageType: context.damageType,
      currentTick: context.currentTick,
      tickRate: context.tickRate ?? 60,
      weaponType: undefined,
      sourceType: context.sourceType ?? EntityType.PLAYER,
      alivePlayerCount: context.alivePlayerCount,
    });
  }

  /**
   * The single shield → barrier/fresh-spawn → takeDamage → knockback →
   * stagger → events sequence shared by both public entry points. It is
   * parameterized over exactly the genuine differences between the weapon
   * attack path (`processAttack`) and the generic damage path
   * (`processDamage`):
   *
   * - `shieldAngleFromAttacker` — weapon hits prefer the attacker's live
   *   position for the shield block-arc angle; generic damage always uses
   *   `sourcePosition` (deliberate split since the shield refactor).
   * - `weaponType` — present only for weapon hits: drives the per-weapon hit
   *   stagger, the `lastDamageSource` weapon label, and the elimination
   *   event's `weapon` field (generic damage emits `-1` and never staggers).
   * - `sourceType` — weapon attackers are always `EntityType.PLAYER`;
   *   generic damage may pass e.g. `EntityType.EXPLOSION`.
   * - `alivePlayerCount` — optional; when omitted, no elimination event is
   *   emitted (generic callers like zone damage lack placement data).
   */
  private resolveHit(params: {
    targetIds: readonly string[];
    playerLookup: (id: string) => Player | undefined;
    attacker: Player | undefined;
    sourceId: string;
    sourcePosition: { x: number; y: number };
    shieldAngleFromAttacker: boolean;
    damage: number;
    knockbackForce: number;
    damageType: DamageType;
    currentTick: number;
    tickRate: number;
    weaponType?: WeaponType;
    sourceType: EntityType;
    alivePlayerCount?: number;
  }): { events: GameEvent[]; killed: boolean; damageApplied: number } {
    const events: GameEvent[] = [];
    let killed = false;
    let totalDamageApplied = 0;
    const { attacker, sourcePosition, currentTick, damageType, tickRate } = params;
    const isSiegeCrush = damageType === DamageType.SIEGE_CRUSH;

    for (const targetId of params.targetIds) {
      const target = params.playerLookup(targetId);
      if (!target || !target.isActive) continue;

      const shieldAngle =
        params.shieldAngleFromAttacker && attacker
          ? Math.atan2(
              attacker.movement.position.y - target.movement.position.y,
              attacker.movement.position.x - target.movement.position.x,
            )
          : Math.atan2(
              sourcePosition.y - target.movement.position.y,
              sourcePosition.x - target.movement.position.x,
            );

      if (!isSiegeCrush) {
        const shieldWeapon = target.getActiveWeapon();
        const shieldResult = this.shieldHandler.processIncomingDamage(
          target,
          params.damage,
          params.knockbackForce,
          shieldAngle,
          shieldWeapon.durability,
          damageType,
          currentTick,
        );

        if (shieldResult.blocked) {
          shieldWeapon.consumeDurability(1);

          events.push({
            type: 'ShieldBlocked',
            tick: currentTick,
            timestamp: Date.now(),
            playerId: target.id,
            damageType,
            sourceId: params.sourceId,
            x: target.movement.position.x,
            y: target.movement.position.y,
          });

          if (shieldResult.shieldBroken && shieldWeapon.type !== WeaponType.FISTS) {
            target.onWeaponBreak(target.inventory.activeSlot, true, tickRate);
          }

          continue;
        }
      }

      if (!isSiegeCrush) {
        if (target.isBarrierActive(currentTick) || target.isFreshSpawnActive(currentTick)) {
          continue;
        }
      }

      const takeResult = target.takeDamage(params.damage, currentTick, isSiegeCrush);

      if (takeResult.damageApplied > 0) {
        totalDamageApplied += takeResult.damageApplied;
        if (takeResult.killed) killed = true;

        target.statusEffects.lastDamageSource = {
          playerId: params.sourceId,
          weaponType: params.weaponType !== undefined ? params.weaponType.toString() : '',
          tick: currentTick,
        };
        if (attacker) {
          attacker.recordDamageDealt(takeResult.damageApplied);
        }

        let knockbackX = 0;
        let knockbackY = 0;
        if (params.knockbackForce > 0) {
          const kb = this.calculateKnockback(
            target.movement.position,
            new Position(sourcePosition.x, sourcePosition.y),
            params.knockbackForce,
          );
          knockbackX = kb.knockbackX;
          knockbackY = kb.knockbackY;
          this.applyKnockback(target, knockbackX, knockbackY);
        }

        // Per-weapon hit stagger — heavy weapons interrupt the victim's tempo
        // (weapon hits only; generic damage has no weapon to stagger with)
        if (params.weaponType !== undefined && !takeResult.killed) {
          this.applyHitStagger(target, params.weaponType, tickRate);
        }

        events.push({
          type: 'PlayerDamaged',
          tick: currentTick,
          timestamp: Date.now(),
          playerId: target.id,
          damage: takeResult.damageApplied,
          sourceId: params.sourceId,
          sourceType: params.sourceType,
          damageType,
          knockbackX,
          knockbackY,
          killed: takeResult.killed,
          x: target.movement.position.x,
          y: target.movement.position.y,
        });

        if (takeResult.killed && params.alivePlayerCount !== undefined) {
          events.push({
            type: 'PlayerEliminated',
            tick: currentTick,
            timestamp: Date.now(),
            playerId: target.id,
            playerName: target.name,
            killedBy: params.sourceId,
            killerName: attacker?.name ?? '',
            placement: params.alivePlayerCount,
            weapon: params.weaponType ?? (-1 as never),
            x: target.movement.position.x,
            y: target.movement.position.y,
            cause: damageType,
          });
        }
      }
    }

    return { events, killed, damageApplied: totalDamageApplied };
  }

  checkPlayersInExplosion(
    cells: GridCoord[],
    players: Map<string, Player>,
    tileSize: number,
  ): PlayerInExplosion[] {
    const affected: PlayerInExplosion[] = [];
    const cellSet = new Set(cells.map((c) => `${c.x},${c.y}`));

    for (const [playerId, player] of players) {
      if (!player.isActive) continue;
      const halfW = PLAYER.HITBOX_WIDTH / 2;
      const halfH = PLAYER.HITBOX_HEIGHT / 2;
      const minGX = Math.floor((player.movement.position.x - halfW) / tileSize);
      const maxGX = Math.floor((player.movement.position.x + halfW) / tileSize);
      const minGY = Math.floor((player.movement.position.y - halfH) / tileSize);
      const maxGY = Math.floor((player.movement.position.y + halfH) / tileSize);

      for (let gy = minGY; gy <= maxGY; gy++) {
        for (let gx = minGX; gx <= maxGX; gx++) {
          if (cellSet.has(`${gx},${gy}`)) {
            affected.push({ playerId, cellX: gx, cellY: gy });
            break;
          }
        }
        if (affected.length > 0 && affected[affected.length - 1]!.playerId === playerId) break;
      }
    }
    return affected;
  }

  /** Weapon-specific stagger on a damaging hit (hitStaggerMs in the registry). */
  private applyHitStagger(target: Player, weaponType: WeaponType, tickRate: number): void {
    let staggerMs = 0;
    try {
      staggerMs = weaponRegistry.getDefinition(weaponType).baseStats.hitStaggerMs ?? 0;
    } catch {
      return; // non-weapon damage source
    }
    if (staggerMs <= 0) return;
    // Never shorten an already-running longer stagger
    const currentMs = (target.statusEffects.staggerRemaining / tickRate) * 1000;
    if (currentMs >= staggerMs) return;
    target.startStagger(staggerMs, tickRate);
  }

  private calculateKnockback(
    targetPosition: Position,
    sourcePosition: Position,
    force: number,
  ): { knockbackX: number; knockbackY: number } {
    const dx = targetPosition.x - sourcePosition.x;
    const dy = targetPosition.y - sourcePosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance === 0) return { knockbackX: 0, knockbackY: 0 };
    return {
      knockbackX: (dx / distance) * force,
      knockbackY: (dy / distance) * force,
    };
  }

  private applyKnockback(player: Player, knockbackX: number, knockbackY: number): void {
    if (player.movement.isDashing) {
      player.cancelDash();
    }
    const VELOCITY_SCALE = 20;
    player.applyKnockbackVelocity(knockbackX * VELOCITY_SCALE, knockbackY * VELOCITY_SCALE);
  }
}
