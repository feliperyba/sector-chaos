import type { AnimSimState, ArmImpulses, TickSegments, WeaponType } from '@sector-battle/shared';
import type { GameMatch } from '../aggregates/GameMatch.ts';
import type { GameEvent } from '../events/index.ts';

/**
 * Domain-owned port describing the animation reads the melee sweep pipeline
 * needs. The application-layer PlayerAnimationSystem satisfies this structurally
 * and is injected at the composition root — the domain no longer imports the
 * application layer (fixes the DDD dependency inversion flagged in #275).
 */
export interface PlayerAnimationPort {
  getState(playerId: string): AnimSimState | undefined;
  getFrame(playerId: string): TickSegments | undefined;
  interruptSwing(playerId: string): void;
  applyImpulses(playerId: string, impulses: ArmImpulses): void;
}

/**
 * Domain-owned port for batching destructible damage from the melee sweep.
 * The application-layer DestructibleDamageHandler satisfies this structurally.
 */
export interface DestructibleDamagePort {
  handleDamage(
    destIds: string[],
    match: GameMatch,
    events: GameEvent[],
    weaponType: WeaponType,
  ): void;
}
