/**
 * Movement-feature telemetry — bot-ai-v2 ticket 08 (DEC-009.2).
 *
 * Per-bot, read-only observation of the movement stream: the IDLE ratio's
 * physical-stillness ticks (pre-existing, moved here with the family it
 * belongs to) and the ticket-08 MOVEMENT FEATURES — per-tick speed moments
 * (mean/variance → the speed coefficient of variation) and near-zero-speed
 * tick counts (the anchor-loiter/stop surface). These are the measurable
 * surface of the archetype movement-signature profiles: micro-pauses and
 * loiters show up as speed dips and stops, and the benchmark's per-archetype
 * avgSpeedCv / avgStoppedTickRatio cuts + the no-clones η² gate read them.
 *
 * Standing alone as its own module (like `.beliefs` / `.goals`) keeps
 * BotBelievability.ts inside the 500-line gate.
 *
 * OBSERVATION-ONLY by contract: values are pure functions of the
 * (deterministic) tick stream — no RNG, no clock reads, never fed back into a
 * decision. Covered by the benchmark's same-seed byte-identity gate.
 */

/** Speed below which a tick counts as idle (60 px/s vs the 430 px/s base
 *  walk speed ≈ 7.2 px/tick — a walking bot never lands here). */
const IDLE_SPEED_PX_PER_TICK = 1;

/** Speed below which a tick counts as STOPPED for the movement-feature
 *  telemetry (bot-ai-v2 ticket 08): a 1-tick signature micro-pause dips the
 *  bot to a fraction of walk speed for that tick, and an anchor loiter holds
 *  it near zero — 25% of base walk speed catches both without counting
 *  ordinary turning slowdowns. */
const STOPPED_SPEED_PX_PER_TICK = 7.2 * 0.25;

export class BotMovementTelemetry {
  /** Ticks at idle physical stillness (the idleRatio numerator). */
  idleTicks = 0;
  /** Σ per-tick speed (px/tick) — the speed-mean numerator. */
  speedSum = 0;
  /** Σ per-tick speed² — the speed-variance numerator. */
  speedSqSum = 0;
  /** Ticks the speed was observed (denominator). */
  speedSamples = 0;
  /** Ticks at near-zero speed (the stop/loiter surface). */
  stoppedTicks = 0;

  /** Observe one alive tick's velocity. Single sqrt, no allocation. */
  observe(vx: number, vy: number): void {
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed < IDLE_SPEED_PX_PER_TICK) this.idleTicks++;
    this.speedSum += speed;
    this.speedSqSum += speed * speed;
    this.speedSamples++;
    if (speed < STOPPED_SPEED_PX_PER_TICK) this.stoppedTicks++;
  }
}
