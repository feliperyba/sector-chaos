/**
 * simulation/ — the prediction-parity home (ticket 14 / research C3).
 *
 * Family rule for everything landing here: pure value-in/value-out calculators
 * with `Into`-receptacles for zero-alloc writes, config defaulted to the frozen
 * `PLAYER_PHYSICS_CONFIG` (single object identity — drift impossible by
 * construction), and collision injected as a function seam (`CollisionFn`) —
 * never imported. No Phaser, no Colyseus, no DOM globals — enforced by
 * `__tests__/purity.test.ts` so these primitives stay consumable by both the
 * server simulation and the client prediction.
 */
export type { PhysicsState, PhysicsInput, PhysicsConfig, CollisionFn } from './PhysicsTypes.js';
export { applyAccelerationInto } from './applyAcceleration.js';
export { simulatePhysicsStepInto } from './simulatePhysicsStep.js';
export { PLAYER_PHYSICS_CONFIG } from './playerPhysicsConfig.js';
export { normalizeMoveInputInto } from './normalizeMoveInputInto.js';
export { effectiveWalkSpeed } from './effectiveWalkSpeed.js';
export { clampToMapExtent } from './clampToMapExtent.js';
