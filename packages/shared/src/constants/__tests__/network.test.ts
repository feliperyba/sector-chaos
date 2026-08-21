import { describe, it, expect } from 'vitest';
import { NETWORK, SIM_TICK_DT } from '../network.js';

describe('NETWORK constants', () => {
  it('TICK_INTERVAL is 1000 / 60 (the network tick period in ms)', () => {
    expect(NETWORK.TICK_INTERVAL).toBe(1000 / 60);
  });

  it('TICK_RATE is 60', () => {
    expect(NETWORK.TICK_RATE).toBe(60);
  });
});

describe('SIM_TICK_DT (determinism contract — ADR-0035)', () => {
  // This guard is the prime determinism anchor. SIM_TICK_DT feeds every
  // physics-relevant call site (server MovementService.validateAndMove via
  // MovePlayerCommand, client simulatePhysicsStepInto via Reconciler and
  // GameState.FIXED_DT, TickTimer, projectile integration, knockback, chest
  // openings). If the derived value ever drifts from 1/60 in IEEE-754, server
  // authority and client prediction would diverge silently. Fail loud here.
  it('SIM_TICK_DT is exactly 1 / 60 (exact equality, not closeTo)', () => {
    expect(SIM_TICK_DT).toBe(1 / 60);
  });

  it('SIM_TICK_DT equals NETWORK.TICK_INTERVAL / 1000 (derivation chain intact)', () => {
    expect(SIM_TICK_DT).toBe(NETWORK.TICK_INTERVAL / 1000);
  });

  it('SIM_TICK_DT is ~0.016666... (sanity bound, 6 decimals)', () => {
    expect(SIM_TICK_DT).toBeCloseTo(0.016667, 5);
  });
});
