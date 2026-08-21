import { DamageType, TRAP } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';
import type { TrapTriggeredEvent } from '../../domain/events/TrapEvents.ts';
import type { Trap, TrapEffect } from '../../domain/entities/Trap.ts';
import type { Player } from '../../domain/entities/Player.ts';
import { Position } from '../../domain/value-objects/Position.ts';

export interface TriggerTrapInput {
  playerId: string;
  trapId: string;
  tick: number;
}

interface ActiveFireArea {
  trapId: string;
  centerGridX: number;
  centerGridY: number;
  radius: number;
  dotPerTick: number;
  tickIntervalTicks: number;
  accumulator: number;
  sourceId: string;
  match: GameMatch;
}

export class TriggerTrapCommand {
  private activeFireAreas: ActiveFireArea[] = [];

  constructor(private match: GameMatch) {}

  execute(input: TriggerTrapInput): CommandResultType {
    const trap = this.match.getState().traps.get(input.trapId);
    if (!trap) return CommandResult.fail('Trap not found');

    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');

    if (!trap.canTrigger(input.tick)) return CommandResult.fail('Trap on cooldown');

    const distance = player.movement.position.distanceTo(trap.position);
    if (distance > trap.getTriggerRadius()) return CommandResult.fail('Out of range');

    const effects = trap.trigger(input.tick, input.playerId);
    const allEffects: TrapEffect[] = [];

    if (trap.type === 1) {
      const existing = this.activeFireAreas.find((a) => a.trapId === input.trapId);
      if (existing) {
        trap.resetFireCooldown();
      } else {
        const grid = this.match.worldToGrid(trap.position.x, trap.position.y);
        this.activeFireAreas.push({
          trapId: input.trapId,
          centerGridX: grid.gridX,
          centerGridY: grid.gridY,
          radius: trap.getFireAreaRadius(),
          dotPerTick: trap.getFireAreaDotPerTick(),
          tickIntervalTicks: TRAP.FIRE_DOT_INTERVAL_TICKS,
          accumulator: 0,
          sourceId: `fire_trap_${trap.id}`,
          match: this.match,
        });
      }
    }

    for (const effect of effects) {
      const enriched = this.enrichEffect(effect, trap, player, input.tick);
      allEffects.push(...enriched);
    }

    const event: TrapTriggeredEvent = {
      type: 'TrapTriggered',
      tick: this.match.currentTick,
      timestamp: Date.now(),
      trapId: input.trapId,
      trapType: trap.type,
      targetId: input.playerId,
      effects: allEffects,
    };
    this.match.emitEvent(event);

    return CommandResult.ok([event]);
  }

  private enrichEffect(
    effect: TrapEffect,
    sourceTrap: Trap,
    player: Player,
    tick: number,
  ): TrapEffect[] {
    switch (effect.type) {
      case 'damage': {
        const pos = player.movement.position;
        this.match.getDamagePipeline().processDamage(
          {
            sourceId: sourceTrap.id,
            damage: effect.amount ?? 0,
            damageType: DamageType.TRAP_DAMAGE,
            targetIds: [effect.targetId ?? ''],
            sourcePosition: { x: pos.x, y: pos.y },
            currentTick: tick,
          },
          (id) => this.match.getPlayer(id),
        );
        if (effect.stunDuration && effect.stunDuration > 0 && !player.isInvulnerable(tick)) {
          player.startStagger(effect.stunDuration * 1000, 60);
        }
        return [effect];
      }
      case 'knockback': {
        const dx = player.movement.position.x - sourceTrap.position.x;
        const dy = player.movement.position.y - sourceTrap.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const nx = dist > 0 ? dx / dist : 1;
        const ny = dist > 0 ? dy / dist : 0;
        const force = effect.knockbackForce ?? 128;
        const targetX = player.movement.position.x + nx * force;
        const targetY = player.movement.position.y + ny * force;
        const hw = 48;
        const hh = 48;
        const grid = this.match.getGrid();
        const collisionService = this.match.getCollisionService();
        if (collisionService && grid) {
          const resolved = collisionService.resolveTileCollision(
            { x: targetX - hw, y: targetY - hh, width: hw * 2, height: hh * 2 },
            grid,
          );
          player.movement.position = new Position(resolved.x + hw, resolved.y + hh);
        } else {
          player.movement.position = new Position(targetX, targetY);
        }
        player.startStagger(300, 60);
        return [effect];
      }
      case 'teleport': {
        const targetId = effect.targetId ?? '';
        const teleportPlayer = this.match.getPlayer(targetId);
        if (teleportPlayer) {
          const destination = this.match.handleTeleportTrap(targetId);
          if (destination) {
            this.match.movePlayer(targetId, destination);
            return [{ ...effect, destination: { x: destination.x, y: destination.y } }];
          }
        }
        return [effect];
      }
      default:
        return [effect];
    }
  }

  tickFireAreas(currentTick: number): void {
    const remaining: ActiveFireArea[] = [];
    for (const area of this.activeFireAreas) {
      const trap = this.match.getState().traps.get(area.trapId);
      if (!trap || !trap.fireAreaActive) continue;

      area.accumulator++;
      if (area.accumulator >= area.tickIntervalTicks) {
        area.accumulator = 0;
        const damage = area.dotPerTick;
        const targetIds: string[] = [];
        for (const player of this.match.getPlayers()) {
          if (!player.isActive) continue;
          const pg = this.match.worldToGrid(player.movement.position.x, player.movement.position.y);
          const dx = Math.abs(pg.gridX - area.centerGridX);
          const dy = Math.abs(pg.gridY - area.centerGridY);
          if (dx <= area.radius && dy <= area.radius) {
            targetIds.push(player.id);
          }
        }
        if (targetIds.length > 0) {
          this.match.getDamagePipeline().processDamage(
            {
              sourceId: area.sourceId,
              damage,
              damageType: DamageType.TRAP_DAMAGE,
              targetIds,
              sourcePosition: { x: area.centerGridX * 128 + 64, y: area.centerGridY * 128 + 64 },
              currentTick,
            },
            (id) => this.match.getPlayer(id),
          );
        }
      }
      remaining.push(area);
    }
    this.activeFireAreas = remaining;
  }

  private isPlayerInvulnerable(player: Player, tick: number): boolean {
    return player.isInvulnerable(tick);
  }
}
