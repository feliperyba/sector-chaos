/**
 * Believed-state type definitions — bot-ai-v2 ticket 05 (DEC-003).
 *
 * A Belief is the bot's REMEMBERED knowledge about ONE enemy:
 * `{lastKnownX/Y, lastVelocity, lastSeenTick, confidence 0..1, source}`.
 * Beliefs sit on the per-bot context BETWEEN perception and the executors:
 * in-scan enemies remain ground truth (perception + live combat read
 * ctx.enemies); beliefs are what the bot acts on for enemies OUTSIDE the
 * current scan — HUNT investigations, target-lock freshness gating, and the
 * damage-direction estimate. On LOS re-acquisition a belief converges back
 * to truth (skilled difficulties faster — BeliefConfig.CONVERGENCE_RAMP).
 *
 * CONTRACTS (decision log DEC-003):
 *  - DAMAGE beliefs NEVER carry the attacker's true coordinates: the position
 *    is a direction + RNG-spread estimate (BeliefMath.estimateDamageOrigin,
 *    drawn from the per-bot BotRNG). Event IDENTITY (who fired / who hit me)
 *    rides the stimulus `sourcePlayerId` — the same information the kill
 *    feed carries — never position truth.
 *  - Determinism: every stochastic draw (foveation noise, damage-estimate
 *    spread) routes through the per-bot BotRNG; no wall-clock reads
 *    anywhere (tick-stamped only) — the benchmark's same-seed byte-identity
 *    contract holds.
 *  - Bounded memory: the store reuses the enemy-history ring's LRU
 *    discipline (least-recently-updated evicted first, cap 16 — the same
 *    measured bound as ENEMY_HISTORY_MAX_ENEMIES, which justified 16 as
 *    >2.5x the worst observed simultaneous live set).
 */

/** How a belief was formed. */
export type BeliefSource = 'seen' | 'heard' | 'damage';

/**
 * One enemy's believed state. Objects are MUTATED IN PLACE by the store on
 * update (confidence decay) — callers read values out; the store owns the
 * object lifecycle.
 */
export class EnemyBelief {
  constructor(
    /** Believed last-known world position (noised for `seen`, the event seat
     *  for `heard`, a direction+spread ESTIMATE for `damage`). */
    public x: number,
    public y: number,
    /** Last known velocity (dead-reckoning input; exact — the noise model is
     *  positional). (0,0) for heard/damage beliefs (no velocity signal). */
    public vx: number,
    public vy: number,
    /** Tick of the last belief WRITE (the sighting / the stimulus). The decay
     *  anchor: confidence is recomputed from `confidence0` over (now − tick),
     *  so repeated maintain passes never compound the decay. */
    public tick: number,
    /** 0..1 — CURRENT confidence (last maintained value; up to one scan
     *  stale between scans). Decays exponentially from confidence0. */
    public confidence: number,
    public source: BeliefSource,
    /** 0..1 — confidence at WRITE time (the decay source value). Equals
     *  `confidence` when omitted (fresh anchor). */
    public confidence0?: number,
  ) {
    if (this.confidence0 === undefined) this.confidence0 = this.confidence;
  }
}

/** Max distinct enemy beliefs one bot retains (LRU-evicted beyond this). */
export const BELIEF_MAX_ENEMIES = 16;

/**
 * Per-bot belief store: an insertion-ordered Map keyed by enemy playerId.
 * LRU discipline: every write MOVES the entry to the end (most-recently-
 * updated last); when the store exceeds {@link BELIEF_MAX_ENEMIES} the FIRST
 * entry (least-recently-updated) is evicted. Same discipline as the
 * enemy-history map's pruneEnemyHistoryMap, applied incrementally — the
 * currently-pursued target (`ctx.pursuitTargetId`) is exempt from eviction
 * (the same exemption the history ring grants targetId/nearestEnemy).
 */
export class BeliefStore {
  private readonly entries = new Map<string, EnemyBelief>();
  /** Eviction exemption: the enemy this bot is actively investigating. */
  exemptId: string | null = null;

  get size(): number {
    return this.entries.size;
  }

  get(id: string): EnemyBelief | undefined {
    return this.entries.get(id);
  }

  /** Insert or update a belief and mark it most-recently-updated. */
  set(id: string, belief: EnemyBelief): void {
    // delete+set moves the key to the Map's tail (refresh LRU order).
    this.entries.delete(id);
    this.entries.set(id, belief);
    this.evictOverCap();
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Read-only iteration in LRU order (least-recently-updated first). */
  forEach(cb: (belief: EnemyBelief, id: string) => void): void {
    for (const [id, belief] of this.entries) cb(belief, id);
  }

  /** Read-only [id, belief] iteration in LRU order (Map insertion order). */
  *entriesById(): IterableIterator<[string, EnemyBelief]> {
    yield* this.entries;
  }

  /**
   * The freshest (max-tick) belief, or null when empty. Deterministic
   * tie-break: iteration order (the first-inserted of equally-fresh wins).
   */
  freshest(): EnemyBelief | null {
    let best: EnemyBelief | null = null;
    for (const belief of this.entries.values()) {
      if (!best || belief.tick > best.tick) best = belief;
    }
    return best;
  }

  /** The freshest belief's enemy id (mirrors {@link freshest}). */
  freshestId(): string | null {
    let bestId: string | null = null;
    let bestTick = -Infinity;
    for (const [id, belief] of this.entries) {
      if (bestId === null || belief.tick > bestTick) {
        bestId = id;
        bestTick = belief.tick;
      }
    }
    return bestId;
  }

  private evictOverCap(): void {
    while (this.entries.size > BELIEF_MAX_ENEMIES) {
      let victim: string | null = null;
      for (const id of this.entries.keys()) {
        if (id === this.exemptId) continue;
        victim = id; // first non-exempt key = least-recently-updated
        break;
      }
      // No non-exempt victim: keep the bounded overshoot rather than evict
      // the entry the bot is actively investigating (same guard as
      // pruneEnemyHistoryMap).
      if (victim === null) break;
      this.entries.delete(victim);
    }
  }
}
