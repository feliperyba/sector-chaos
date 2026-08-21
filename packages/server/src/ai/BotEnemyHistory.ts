/**
 * Fixed-capacity ring buffer for one enemy's position history + the per-bot
 * history-map bound (perf ticket 28).
 *
 * Replaces the previous `Array<{x,y,vx,vy,t}>` with `push()` + `shift()` at
 * cap 8 (`BotContext.recordEnemyPosition`): every sample was a fresh object
 * literal and every overflow an O(n) `shift()` (element move). Here the 8
 * slot objects are allocated once per tracked enemy and mutated in place —
 * the perception hot path (`scanWorld` → `recordEnemyPosition`, ~every enemy
 * per scan) performs zero allocations and zero element moves.
 *
 * Chronological order is identical to the old array semantics: after `k ≥ 8`
 * pushes the old array held pushes `k-7 .. k` in order; `at(j)` returns the
 * same sequence (`at(0)` = oldest retained, `at(length-1)` = newest). The
 * aim-prediction reader (`predictAim`'s former `history.slice(-5)`) walks
 * `at(length-5) .. at(length-1)` — the same 5 most recent samples in the same
 * order. Equivalence is pinned by a randomized ring-vs-array test
 * (`tests/ai/bot-enemy-history.test.ts`).
 */

/** One position sample of one enemy. Slot objects are MUTATED IN PLACE by
 *  {@link EnemyHistoryRing.push} — callers must copy out values (or read them
 *  immediately); they must NOT retain references across pushes. */
export interface EnemyHistorySample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

export class EnemyHistoryRing {
  /** Samples retained per enemy. Was `if (hist.length > 8) hist.shift()`. */
  static readonly CAPACITY = 8;

  /** Slot storage, indexed modulo {@link CAPACITY}. Entries are lazily
   *  allocated on first write to that slot and then reused forever. */
  private readonly slots: EnemyHistorySample[] = [];
  /** Index where the NEXT sample is written (one past the newest). */
  private head = 0;
  /** Number of valid samples (0 .. CAPACITY). */
  private count = 0;

  /** Number of retained samples (oldest dropped once CAPACITY is exceeded). */
  get length(): number {
    return this.count;
  }

  /** Tick of the newest sample — the LRU recency marker for map eviction.
   *  `-Infinity` when empty (an empty ring always loses the "least-recently-
   *  seen" comparison, so it is evicted first — correct: it carries no data). */
  get newestTick(): number {
    return this.count === 0 ? -Infinity : this.at(this.count - 1).t;
  }

  /** Write one sample, overwriting the oldest when full. Zero-allocation on
   *  the steady-state path (all 8 slots already materialized). */
  push(x: number, y: number, vx: number, vy: number, t: number): void {
    let slot = this.slots[this.head];
    if (!slot) {
      slot = { x: 0, y: 0, vx: 0, vy: 0, t: 0 };
      this.slots[this.head] = slot;
    }
    slot.x = x;
    slot.y = y;
    slot.vx = vx;
    slot.vy = vy;
    slot.t = t;
    this.head = (this.head + 1) % EnemyHistoryRing.CAPACITY;
    if (this.count < EnemyHistoryRing.CAPACITY) this.count++;
  }

  /** Chronological read: index 0 = oldest retained sample, `length - 1` =
   *  newest — the same order the old array exposed after push+shift-at-8.
   *  Requires `0 <= index < length` (same contract as array indexing). */
  at(index: number): EnemyHistorySample {
    const raw = this.head - this.count + index;
    return this.slots[((raw % EnemyHistoryRing.CAPACITY) + EnemyHistoryRing.CAPACITY) % EnemyHistoryRing.CAPACITY]!;
  }
}

/**
 * Cap on the number of distinct enemy ids whose history one bot tracks (the
 * per-bot `enemyHistory` map size). Bounds per-bot history memory at
 * `ENEMY_HISTORY_MAX_ENEMIES × EnemyHistoryRing.CAPACITY` sample objects.
 *
 * Justification (measured on the full-match 63-bot hard bench,
 * `BENCH_MAP=procedural`, seed 12345, 366s game-time): the maximum number of
 * enemies simultaneously inside one bot's 1000px perception range was 6, and
 * the maximum map size any bot accumulated over the whole match was 14. A cap
 * of 16 is >2.5× the worst observed simultaneous live set, so eviction can
 * only ever remove entries that have not been perceived for a long time —
 * every currently-perceived entry carries a fresh `newestTick` (its push this
 * scan) and loses the least-recently-seen comparison to any stale entry.
 *
 * The eviction exemption set (`targetId` + `nearestEnemy.id`, see
 * `BotContext.pruneEnemyHistory`) guarantees the only two ids whose history
 * is ever READ (`predictAim` via `executeEngage`/`executeRetreat`) never lose
 * data even in the theoretical >16-live-enemies deathball (final zone radius
 * ≈410px can force all survivors inside mutual 1000px perception).
 */
export const ENEMY_HISTORY_MAX_ENEMIES = 16;

/**
 * Enforce the {@link ENEMY_HISTORY_MAX_ENEMIES} bound on one bot's history map
 * by evicting least-recently-seen entries (recency = the ring's `newestTick`,
 * i.e. the tick of the enemy's most recent perceived sample).
 *
 * Called by `BotContext.pruneEnemyHistory` once at the END of each perception
 * scan (`BotPerception.scanWorld`), after all pushes for the scan and after
 * `ctx.nearestEnemy` has been recomputed — so both exemptions below are valid
 * at eviction time. Between scans nothing inserts, so nothing needs evicting.
 *
 * READER AUDIT (perf ticket 28, mandatory guardrail): the ONLY reader of
 * history contents is `predictAim` (`BotCombatShared.ts`), called with either
 * (a) `selectTarget(ctx)`'s pick — which sets `ctx.targetId` — from
 * `executeEngage` (`BotCombatEngage.ts:79,143`), or (b) `ctx.nearestEnemy`
 * from `executeRetreatState` (`BotCombatExecutors.ts:232`) → `executeRetreat`
 * (`BotCombatRetreat.ts:57`). No other code reads a non-cleared history
 * (telemetry, skill tracker, and intents never touch it; `BotTargeting.ts:62`
 * / `BotCombatExecutors.ts:74,111` only CLEAR the dropped target's entry).
 * Therefore the exemption set {targetId, nearestEnemyId} covers every read,
 * and eviction can never remove data a reader will consume this tick. All
 * other entries are write-only until their enemy is re-perceived — which
 * re-pushes a fresh sample before that enemy can re-enter the exemption set
 * (selectTarget and the nearestEnemy scan both pick only from the freshly
 * scanned ctx.enemies).
 */
export function pruneEnemyHistoryMap(
  history: Map<string, EnemyHistoryRing>,
  targetId: string | null,
  nearestEnemyId: string | null,
): void {
  while (history.size > ENEMY_HISTORY_MAX_ENEMIES) {
    let victimId: string | null = null;
    let victimTick = Infinity;
    for (const [id, ring] of history) {
      if (id === targetId || id === nearestEnemyId) continue;
      const newest = ring.newestTick;
      // Strict `<`: on ties (e.g. a cluster all seen the same tick) the
      // first-inserted entry wins — Map preserves insertion order, so the
      // victim choice is deterministic per bot.
      if (newest < victimTick) {
        victimTick = newest;
        victimId = id;
      }
    }
    // No non-exempt victim (only reachable if every entry except at most the
    // two exempt ids is already gone): keep the bounded overshoot rather than
    // evicting a reader-visible entry.
    if (victimId === null) break;
    history.delete(victimId);
  }
}
