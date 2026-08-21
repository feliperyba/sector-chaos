/** Deterministic per-id phase in [0, mod). Spreads periodic per-bot work
 *  (perception scans, repaths) evenly across ticks so 60+ bots don't all
 *  fire on the same tick and spike the 16ms tick budget. */
export function hashPhase(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

/** Hash a string to a 32-bit uint seed. */
export function hashToSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic per-bot PRNG (mulberry32). Replaces Math.random() in the bot
 * AI so that a given bot + game seed always produces the same behavior. This
 * eliminates run-to-run variance in benchmarks (same seed → same result) and
 * makes tuning measurable instead of noisy.
 *
 * Each bot gets its own BotRNG seeded from its playerId. All stochastic AI
 * decisions (strafe direction, wander targets, repath jitter, aim error,
 * unstuck direction) draw from this RNG, producing different but deterministic
 * behavior per bot.
 */
export class BotRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    // Ensure non-zero state
    if (this.state === 0) this.state = 1;
  }

  /** Returns a float in [0, 1), equivalent to Math.random(). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns a float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Returns an int in [min, max) (max exclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max));
  }
}
