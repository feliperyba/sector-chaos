/**
 * Ex-Gaussian reaction latency — bot-ai-v2 ticket 04 (DEC-007).
 *
 * Human reaction time is ex-Gaussian: a Gaussian body (fast bulk) plus an
 * exponential tail (occasional slow responses). Every perception→action
 * channel of the Reactor draws its latency from this distribution via the
 * bot's OWN BotRNG, so:
 *  - same bot + same seed → same draws (benchmark byte-identity holds);
 *  - two bots receiving the SAME stimulus draw DIFFERENT latencies (per-bot
 *    RNG streams) — groups never react identically or simultaneously.
 *
 * Parameterization (see ReactorConfig.REACTION_LATENCY_BY_DIFFICULTY): a draw
 * in ms is `gauss(meanMs - tauMs, sigmaMs) + exp(tauMs)`, so the distribution
 * MEAN equals the GDD §14.2 table value (Easy 600 / Medium 300 / Hard 100 ms
 * consumed as distribution means — DEC-007 rejected the literal fixed delay).
 * All functions are pure over the passed RNG — no clock, no unseeded
 * randomness.
 */

import type { BotRNG } from '../BotContext.ts';
import { REACTION_LATENCY_MAX_TICKS } from './ReactorConfig.ts';
import type { ReactionLatencyParams } from './ReactorConfig.ts';

/** Milliseconds per game tick (NETWORK.TICK_RATE = 60 Hz). */
const MS_PER_TICK = 1000 / 60;

/**
 * One standard-normal sample (Box–Muller transform) from two BotRNG uniforms.
 * Deterministic: consumes exactly two rng.next() draws per call.
 */
export function gaussStandard(rng: BotRNG): number {
  // Box–Muller with the two-uniform form. u1 ∈ (0, 1] avoids ln(0); BotRNG
  // returns [0, 1) so 1 - u1 is a safe (0, 1] operand.
  const u1 = 1 - rng.next();
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gaussian sample with explicit mean/σ. */
export function gauss(rng: BotRNG, mean: number, sigma: number): number {
  if (sigma <= 0) return mean;
  return mean + gaussStandard(rng) * sigma;
}

/** Exponential sample with scale τ (mean τ). Inverse-CDF method. */
export function expDraw(rng: BotRNG, tau: number): number {
  if (tau <= 0) return 0;
  const u = 1 - rng.next(); // (0, 1] — avoids ln(0)
  return -tau * Math.log(u);
}

/** A raw ex-Gaussian latency draw in MILLISECONDS (uncapped, unrounded). */
export function drawReactionLatencyMs(rng: BotRNG, p: ReactionLatencyParams): number {
  // Gaussian body centered at meanMs - tau so the ex-Gaussian MEAN (body +
  // tail expectation) equals the GDD table value exactly.
  return gauss(rng, p.meanMs - p.tauMs, p.sigmaMs) + expDraw(rng, p.tauMs);
}

/**
 * A reaction latency draw in TICKS: the arming delay applied to a detected
 * trigger. Clamped to [0, REACTION_LATENCY_MAX_TICKS] and rounded — the tail
 * is real but a reaction must still land (see the cap's rationale in
 * ReactorConfig).
 */
export function drawReactionLatencyTicks(rng: BotRNG, p: ReactionLatencyParams): number {
  const ms = drawReactionLatencyMs(rng, p);
  const ticks = Math.round(ms / MS_PER_TICK);
  if (ticks < 0) return 0;
  if (ticks > REACTION_LATENCY_MAX_TICKS) return REACTION_LATENCY_MAX_TICKS;
  return ticks;
}
