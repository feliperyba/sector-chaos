import { describe, it, expect } from 'vitest';
import { PLAYER_PHYSICS_CONFIG } from '../playerPhysicsConfig.js';
import { PLAYER } from '../../constants/player.js';
import { COMBAT } from '../../constants/combat.js';

/**
 * Contract pin for PLAYER_PHYSICS_CONFIG (ticket 02).
 *
 * Before ticket 02, this exact object existed as two byte-identical local
 * `PHYSICS_CONFIG` literals in `client-v3/src/prediction/PredictionService.ts`
 * and `client-v3/src/prediction/Reconciler.ts` (INVESTIGATION.md §5.2 row 5 /
 * §3.3 A-3). This test pins the shared replacement to those SAME field names
 * and values, so:
 * - the consolidation itself changed nothing (these assertions are the values
 *   the deleted literals evaluated to), and
 * - any future edit to the config (or to the PLAYER/COMBAT constants it
 *   derives from) trips a visible, attributable failure — a conscious contract
 *   edit, not silent drift.
 */

describe('PLAYER_PHYSICS_CONFIG (ticket 02 contract pin)', () => {
  it('equals the deleted client literals, field-for-field', () => {
    expect(PLAYER_PHYSICS_CONFIG.acceleration).toBe(4800); // PLAYER.ACCELERATION
    expect(PLAYER_PHYSICS_CONFIG.deceleration).toBe(6400); // PLAYER.DECELERATION
    expect(PLAYER_PHYSICS_CONFIG.dashSpeedMultiplier).toBe(2.0); // PLAYER.DASH_SPEED_MULTIPLIER
    expect(PLAYER_PHYSICS_CONFIG.dashDurationTicks).toBe(30); // PLAYER.DASH_DURATION_TICKS
    // 0.75 — the constant of record (COMBAT.STAGGER_MOVE_SPEED_PENALTY,
    // combat.ts; tuned, 3725faf3 — this pin was stale at 0.5, ticket 16 judge fix).
    expect(PLAYER_PHYSICS_CONFIG.staggerMoveSpeedPenalty).toBe(0.75);
    expect(PLAYER_PHYSICS_CONFIG.playerHalfW).toBe(48); // PLAYER.HITBOX_WIDTH (96) / 2
    expect(PLAYER_PHYSICS_CONFIG.playerHalfH).toBe(48); // PLAYER.HITBOX_HEIGHT (96) / 2
    expect(PLAYER_PHYSICS_CONFIG.baseSpeed).toBe(430); // PLAYER.BASE_SPEED
  });

  it('is derived from PLAYER/COMBAT exactly like the old literals were', () => {
    expect(PLAYER_PHYSICS_CONFIG.acceleration).toBe(PLAYER.ACCELERATION);
    expect(PLAYER_PHYSICS_CONFIG.deceleration).toBe(PLAYER.DECELERATION);
    expect(PLAYER_PHYSICS_CONFIG.dashSpeedMultiplier).toBe(PLAYER.DASH_SPEED_MULTIPLIER);
    expect(PLAYER_PHYSICS_CONFIG.dashDurationTicks).toBe(PLAYER.DASH_DURATION_TICKS);
    expect(PLAYER_PHYSICS_CONFIG.staggerMoveSpeedPenalty).toBe(COMBAT.STAGGER_MOVE_SPEED_PENALTY);
    expect(PLAYER_PHYSICS_CONFIG.playerHalfW).toBe(PLAYER.HITBOX_WIDTH / 2);
    expect(PLAYER_PHYSICS_CONFIG.playerHalfH).toBe(PLAYER.HITBOX_HEIGHT / 2);
    expect(PLAYER_PHYSICS_CONFIG.baseSpeed).toBe(PLAYER.BASE_SPEED);
  });

  it('exposes exactly the 8 PhysicsConfig fields (no additions, no omissions)', () => {
    expect(Object.keys(PLAYER_PHYSICS_CONFIG).sort()).toEqual([
      'acceleration',
      'baseSpeed',
      'dashDurationTicks',
      'dashSpeedMultiplier',
      'deceleration',
      'playerHalfH',
      'playerHalfW',
      'staggerMoveSpeedPenalty',
    ]);
  });

  it('is frozen (immutable singleton)', () => {
    expect(Object.isFrozen(PLAYER_PHYSICS_CONFIG)).toBe(true);
  });
});
