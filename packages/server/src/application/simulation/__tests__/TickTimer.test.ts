import { describe, it, expect } from 'vitest';
import { SIM_TICK_DT } from '@sector-battle/shared';
import { TickTimer } from '../TickTimer.js';

/**
 * Regression test for the "micro-stutter" root cause.
 *
 * The server's TickTimer is fed the REAL wall-clock delta per Colyseus callback
 * (see GameRoom.onSimulationTick). Colyseus's setSimulationInterval drifts under
 * event-loop load — measured ~51Hz vs the configured 60Hz. For the sim to hold
 * 60Hz sim-time despite slow callbacks, TickTimer MUST be able to run more than
 * one tick per callback (catch-up) when the accumulator has built up a backlog.
 *
 * The old MAX_STEPS=1 (ADR-0025) forbade catch-up, so the sim ran at ~85%
 * real-time → the client (true 60Hz prediction) drifted ahead ~9 ticks/sec →
 * periodic reconciliation snaps (the visible "hitch forward"). These tests pin
 * the catch-up contract that prevents that drift.
 */
describe('TickTimer catch-up (micro-stutter fix)', () => {
  it('runs multiple ticks per callback to catch up after a delayed callback', () => {
    const t = new TickTimer();
    // A normal callback: exactly one tick's worth of time → 1 step.
    expect(t.consume(SIM_TICK_DT * 1000)).toBe(1);
    // A delayed callback delivering ~2 ticks of accumulated time → 2 steps
    // (catch-up). With MAX_STEPS=1 this returned 1, losing a tick → drift.
    expect(t.consume(SIM_TICK_DT * 2 * 1000)).toBe(2);
  });

  it('holds 60Hz sim-time when callbacks arrive at ~51Hz (the measured drift)', () => {
    // Model the real failure: callbacks every ~19.6ms (51Hz) instead of 16.67ms
    // (60Hz). Over 1 second of wall-clock that's ~51 callbacks delivering ~1000ms.
    // The sim must still run ~60 ticks (1000ms / SIM_TICK_DT) to stay at real-time.
    const t = new TickTimer();
    const callbackIntervalMs = 19.6; // 51Hz
    const durationMs = 1000;
    let ticks = 0;
    for (let elapsed = 0; elapsed < durationMs; elapsed += callbackIntervalMs) {
      ticks += t.consume(callbackIntervalMs);
    }
    // 51 callbacks × 1 step each = 51 ticks with the old MAX_STEPS=1 (the bug).
    // With catch-up, the accumulated backlog yields ~60 ticks over the second.
    expect(ticks).toBeGreaterThanOrEqual(58);
    expect(ticks).toBeLessThanOrEqual(62);
  });

  it('caps per-callback work at MAX_STEPS to prevent spiral-of-death', () => {
    const t = new TickTimer();
    // A pathological gap (e.g. backgrounded tab). frameTime is clamped to 0.25s
    // (15 ticks worth) internally, but MAX_STEPS caps the per-callback step count
    // so a single callback can never run an unbounded number of ticks.
    const steps = t.consume(1000); // 1 second gap
    expect(steps).toBe(4);
    // The remaining backlog is retained and cleared gradually over subsequent
    // callbacks — not dropped, not runaway.
    expect(t.consume(SIM_TICK_DT * 1000)).toBeGreaterThanOrEqual(1);
  });

  it('returns 0 steps when less than a tick has elapsed (sub-tick accumulation)', () => {
    const t = new TickTimer();
    expect(t.consume(5)).toBe(0); // 5ms < 16.67ms
    // Residual is retained; the next small delta pushes it over one tick.
    expect(t.consume(12)).toBe(1); // 5 + 12 = 17ms ≥ one tick
  });
});
