import { describe, it, expect } from 'vitest';
import { RttSmoother } from '../RttSmoother.js';

/**
 * RttSmoother — client-side round-trip estimator. Replaces the server-side
 * `PlayerRttTracker` value as the snap-threshold source. The legacy tracker
 * computed RTT from `serverTick - clientTick` (independent counters) whose
 * difference grows monotonically even at ZERO latency → rtt climbed to 15+ s on
 * localhost and pinned the snap threshold at 64px. These tests pin the correct
 * behavior the client-measured round-trip must deliver.
 */
describe('RttSmoother — client-measured RTT (replaces broken server player.rtt)', () => {
  it('returns 0 until MIN_SAMPLES (3) samples arrive', () => {
    const s = new RttSmoother();
    expect(s.value).toBe(0);
    s.addSample(1, 40);
    expect(s.value).toBe(0);
    s.addSample(2, 40);
    expect(s.value).toBe(0);
    s.addSample(3, 40);
    expect(s.value).toBeGreaterThan(0);
  });

  it('EMA-smooths toward new samples without losing the prior estimate', () => {
    const s = new RttSmoother();
    // Seed with a high RTT.
    s.addSample(1, 100);
    s.addSample(2, 100);
    s.addSample(3, 100);
    expect(s.value).toBeCloseTo(100, 0);
    // A single low sample barely moves the EMA (alpha 0.15).
    const before = s.value;
    s.addSample(4, 20);
    expect(s.value).toBeLessThan(before);
    expect(s.value).toBeGreaterThan(60); // 100 -> ~87, not 20
  });

  // =========================================================================
  // THE BUG THIS CLASS FIXES: the legacy server tracker derived RTT from
  // `serverTick - clientTick`. Both are independent monotonic counters, so the
  // diff grows forever even when the real round-trip is ~0. Live data showed
  // rtt = 15.8s on localhost. The client-measured round-trip (send time → ack
  // time) must NOT exhibit this: with zero-latency send/ack pairs, the estimate
  // stays ~0 regardless of how high the sequence counter climbs.
  // =========================================================================
  it('REGRESSION: zero-latency send/ack pairs do NOT inflate RTT with sequence count', () => {
    const s = new RttSmoother();
    // Simulate 500 consecutive inputs all acked "instantly" (send time === ack
    // time → 0ms round-trip). The legacy tracker would return 2 * (serverTick -
    // clientTick) * TICK_INTERVAL, growing roughly linearly with the sequence.
    for (let seq = 1; seq <= 500; seq++) {
      s.addSample(seq, 0);
    }
    expect(s.value).toBeLessThan(1); // ~0, NOT thousands of ms
    // Contrast: the legacy formula at seq=500, serverTick≈clientTick+K grows
    // unbounded — this estimate stays pinned at the true ~0 round-trip.
  });

  it('REGRESSION: a stable real latency stays stable, not growing over time', () => {
    // 30ms real round-trip, sustained over many sequence numbers.
    const s = new RttSmoother();
    for (let seq = 1; seq <= 300; seq++) {
      s.addSample(seq, 30);
    }
    // After warmup the estimate must reflect the real 30ms, not climb toward
    // 15 seconds the way the legacy tick-diff formula did.
    expect(s.value).toBeGreaterThanOrEqual(28);
    expect(s.value).toBeLessThanOrEqual(32);
  });

  it('ignores non-advancing acks (duplicate/reordered patch)', () => {
    const s = new RttSmoother();
    s.addSample(5, 50);
    s.addSample(6, 50);
    s.addSample(7, 50);
    const before = s.value;
    // A duplicate ack for seq 6 (older than lastAckSeq 7) must NOT move the EMA.
    s.addSample(6, 999);
    expect(s.value).toBe(before);
    // A same-seq ack is also ignored.
    s.addSample(7, 999);
    expect(s.value).toBe(before);
  });

  it('discards absurd samples (clock jump / throttle) and keeps the prior estimate', () => {
    const s = new RttSmoother();
    s.addSample(1, 40);
    s.addSample(2, 40);
    s.addSample(3, 40);
    const before = s.value;
    // A 6-second "sample" (background tab throttle / clock skew) must not poison it.
    s.addSample(4, 6000);
    expect(s.value).toBe(before);
    // Negative sample (clock regression) likewise.
    s.addSample(5, -10);
    expect(s.value).toBe(before);
  });

  it('reset() clears state for a new match/session', () => {
    const s = new RttSmoother();
    s.addSample(1, 80);
    s.addSample(2, 80);
    s.addSample(3, 80);
    expect(s.value).toBeGreaterThan(0);
    s.reset();
    expect(s.value).toBe(0);
    // Works again from scratch after reset.
    s.addSample(1, 30);
    s.addSample(2, 30);
    s.addSample(3, 30);
    expect(s.value).toBeGreaterThanOrEqual(28);
  });
});
