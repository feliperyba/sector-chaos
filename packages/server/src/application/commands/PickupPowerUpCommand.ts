import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { PowerUpCollectedEvent } from '../../domain/events/index.ts';
import { PowerUpType, PLAYER } from '@sector-battle/shared';
import type { GamePowerUpType } from '../../domain/entities/index.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';
import { Speed } from '../../domain/value-objects/index.ts';

export interface PickupPowerUpInput {
  playerId: string;
  powerUpId: string;
  tick: number;
}

interface ActiveEffectEntry {
  type: string;
  playerId: string;
  appliedTick: number;
  durationTicks: number;
  multiplier: number;
}

// Must match the walkover trigger radius (PLAYER.PICKUP_RADIUS). The walkover
// (GameSimulationWalkovers.checkPowerUpWalkOverSim) fires this command whenever
// a player is within PICKUP_RADIUS; if this gate used a tighter value, powerups
// at distances between the two would trigger the walkover then fail the command
// (silent no-op), leaving the powerup stuck on the ground.
const PICKUP_RANGE = PLAYER.PICKUP_RADIUS;

const TICKS_PER_SECOND = 60;

const POWER_UP_TYPE_MAP: Record<GamePowerUpType, PowerUpType> = {
  health_pack: PowerUpType.HEALTH_PACK,
  barrier: PowerUpType.BARRIER,
  speed_boost: PowerUpType.SPEED_BOOST,
};

export class PickupPowerUpCommand {
  private activeEffects: Map<string, ActiveEffectEntry[]> = new Map();

  constructor(private match: GameMatch) {}

  execute(input: PickupPowerUpInput): CommandResultType {
    const powerUp = this.match.getState().powerUps.get(input.powerUpId);
    if (!powerUp) return CommandResult.fail('PowerUp not found');

    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');

    if (!powerUp.isActive) return CommandResult.fail('PowerUp not active');

    const distance = player.movement.position.distanceTo(powerUp.position);
    if (distance > PICKUP_RANGE) return CommandResult.fail('Out of range');

    if (powerUp.type === 'health_pack' && player.health.current >= player.health.max) {
      return CommandResult.fail('Already at full health');
    }

    const playerEffects = this.activeEffects.get(input.playerId);
    const hasSpeedBoost = PickupPowerUpCommand.hasEffect(playerEffects, 'speed_boost');
    const hasBarrier = PickupPowerUpCommand.hasEffect(playerEffects, 'barrier');

    const hasExistingEffect =
      powerUp.type === 'speed_boost'
        ? hasSpeedBoost
        : powerUp.type === 'barrier'
          ? hasBarrier
          : false;

    const effect = powerUp.applyTo(hasExistingEffect);

    const durationTicks = Math.round(effect.duration * TICKS_PER_SECOND);

    switch (effect.type) {
      case 'speed_boost':
        if (!effect.isRefresh) {
          player.movement.speed = new Speed(
            player.movement.baseSpeed * (effect.multiplier ?? 2.0),
            player.movement.speed.max,
          );
        }
        player.statusEffects.speedBoostExpiryTick = input.tick + durationTicks;
        this.trackEffect(
          input.playerId,
          'speed_boost',
          input.tick,
          durationTicks,
          effect.multiplier ?? 2.0,
        );
        break;
      case 'barrier':
        player.activateBarrier(this.match.currentTick, durationTicks);
        this.trackEffect(input.playerId, 'barrier', input.tick, durationTicks, 1);
        break;
      case 'health_pack':
        player.heal(effect.amount ?? 30);
        break;
    }

    powerUp.deactivate();
    this.match.removePowerUpById(input.powerUpId);

    player.recordItemCollected();

    const event: PowerUpCollectedEvent = {
      type: 'PowerUpCollected',
      tick: this.match.currentTick,
      timestamp: Date.now(),
      powerUpId: input.powerUpId,
      powerUpType: POWER_UP_TYPE_MAP[powerUp.type],
      playerId: input.playerId,
    };
    this.match.emitEvent(event);

    return CommandResult.ok([event]);
  }

  private trackEffect(
    playerId: string,
    effectType: string,
    appliedTick: number,
    durationTicks: number,
    multiplier: number,
  ): void {
    let effects = this.activeEffects.get(playerId);
    if (!effects) {
      effects = [];
      this.activeEffects.set(playerId, effects);
    }
    const existing = effects.find((e) => e.type === effectType);
    if (existing) {
      existing.appliedTick = appliedTick;
      existing.durationTicks = durationTicks;
    } else {
      effects.push({ type: effectType, playerId, appliedTick, durationTicks, multiplier });
    }
  }

  expireEffects(currentTick: number, match: GameMatch): void {
    for (const [playerId, effects] of this.activeEffects) {
      const remaining: ActiveEffectEntry[] = [];
      for (const effect of effects) {
        if (currentTick >= effect.appliedTick + effect.durationTicks) {
          const player = match.getPlayer(playerId);
          if (player) {
            if (effect.type === 'speed_boost') {
              player.movement.speed = new Speed(
                player.movement.baseSpeed,
                player.movement.speed.max,
              );
              player.statusEffects.speedBoostExpiryTick = 0;
            }
          }
          match.emitEvent({
            type: 'PowerUpEffectExpired',
            tick: currentTick,
            timestamp: Date.now(),
            playerId,
            effectType: effect.type,
          });
        } else {
          remaining.push(effect);
        }
      }
      if (remaining.length === 0) {
        this.activeEffects.delete(playerId);
      } else {
        this.activeEffects.set(playerId, remaining);
      }
    }
  }

  private static hasEffect(effects: ActiveEffectEntry[] | undefined, type: string): boolean {
    if (!effects) return false;
    return effects.some((e) => e.type === type);
  }

  clearAllEffectsForPlayer(playerId: string): void {
    this.activeEffects.delete(playerId);
  }

  clearAllEffects(): void {
    this.activeEffects.clear();
  }
}
