import { PLAYER } from '../constants/player.js';
import { COMBAT } from '../constants/combat.js';
import type { PhysicsConfig } from './PhysicsTypes.js';

/**
 * Single-source player physics config for the shared movement simulation
 * (`simulatePhysicsStepInto`) — the ADR-0033/0035 prediction↔reconciliation
 * parity surface.
 *
 * Until ticket 02 (docs/perf-optimization INVESTIGATION.md §5.2 row 5) this
 * exact 8-field object was duplicated as two byte-identical local
 * `PHYSICS_CONFIG` literals in `client-v3/src/prediction/PredictionService.ts`
 * and `client-v3/src/prediction/Reconciler.ts`. Both consumers now import THIS
 * frozen object, guaranteeing the prediction step and the rewind-replay
 * integrate with identical physics forever (config drift is impossible by
 * construction — one object identity).
 *
 * Field names and values are byte-identical to the deleted literals. The
 * values are DERIVED (not transcribed) from `PLAYER`/`COMBAT` so a constant
 * change flows to every consumer — `playerPhysicsConfig.test.ts` pins the
 * current numbers so any change is a conscious, visible contract edit.
 *
 * Frozen: `simulatePhysicsStepInto` must never observe a mutated config.
 * (Also the perf-optimization §5.5 note: a single shared frozen object has a
 * single hidden class for both call sites.)
 */
export const PLAYER_PHYSICS_CONFIG: Readonly<PhysicsConfig> = Object.freeze({
  acceleration: PLAYER.ACCELERATION,
  deceleration: PLAYER.DECELERATION,
  dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
  dashDurationTicks: PLAYER.DASH_DURATION_TICKS,
  staggerMoveSpeedPenalty: COMBAT.STAGGER_MOVE_SPEED_PENALTY,
  playerHalfW: PLAYER.HITBOX_WIDTH / 2,
  playerHalfH: PLAYER.HITBOX_HEIGHT / 2,
  baseSpeed: PLAYER.BASE_SPEED,
});
