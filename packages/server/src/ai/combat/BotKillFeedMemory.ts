/**
 * Kill-feed awareness memory — bot-ai-v2 ticket 09 (DEC-010.4).
 *
 * Two per-bot memories fed by ROUTED ELIMINATION STIMULI (the kill-feed
 * source — ticket 03 delivers 'elimination' stimuli within hearing radius;
 * the wiring lives in BotSystemRouterWiring.noteEliminationHeard):
 *
 *  1. SAFE-LOOT WINDOW: a nearby fight just ENDED (someone died) — the
 *     aftermath is safe to loot for a short window (the winner is busy
 *     looting/healing, the loot is on the ground at the corpse seat). The
 *     macro-goal generator biases LOOT_CLUSTER toward the fresh elimination
 *     seat while the window is open (GoalBinding feeds the seat; GoalScoring
 *     consumes it). This is the "bots loot the aftermath of a nearby fight"
 *     user story (SPEC #25).
 *
 *  2. DECAYING SECTOR DANGER MEMORY: deaths CLUSTERING in a sector make that
 *     sector read as dangerous for the REST OF THE MATCH (with exponential
 *     decay — old blood fades). The quiet-side scorer subtracts the decayed
 *     pressure from each candidate point (SPEC #16: "the map's danger has
 *     memory"), so rotations bend away from killing fields.
 *
 * Determinism: RNG-free, wall-clock-free — pressure decays lazily from
 * write-time anchors (the same discipline as belief confidence), so repeated
 * reads never compound and there is no per-tick maintenance pass.
 */

/** Sector grid resolution (matches BotSystem's 8×8 barrel-density grid). */
export const DANGER_GRID_COLS = 8;
export const DANGER_GRID_CELLS = DANGER_GRID_COLS * DANGER_GRID_COLS;
/** Pressure halved per this many ticks (~25 s — match-long memory, decaying). */
export const DANGER_HALF_LIFE_TICKS = 1500;
/** How long a heard elimination keeps the safe-loot window open (ticks, 8 s). */
export const SAFE_LOOT_WINDOW_TICKS = 480;
/** LOOT_CLUSTER source value of a fresh elimination seat at full bias. */
export const SAFE_LOOT_BASE_VALUE = 0.75;
/** Pressure added per heard death (before clustering accumulation). */
export const DANGER_PRESSURE_PER_DEATH = 1;

/**
 * The per-bot kill-feed memory. One instance on ctx.combat.killFeed; written
 * only by the router wiring (between ticks), read by the goal layer.
 */
export class KillFeedMemory {
  /** Decay-anchored pressure per flat sector index (write-time value). */
  private readonly pressure = new Float64Array(DANGER_GRID_CELLS);
  /** Write tick of each sector's pressure anchor (−1 = never written; tick 0
   *  is a LEGAL write tick — the zero-default Float64Array would silently
   *  erase any elimination recorded on the first tick). */
  private readonly stampTick: Float64Array;
  /** Map dims captured at the first note (reads before any note return 0). */
  private mapWidth = 0;
  private mapHeight = 0;
  /** The freshest heard elimination seat. */
  lastElimX = 0;
  lastElimY = 0;
  lastElimTick = -9999;

  constructor() {
    this.stampTick = new Float64Array(DANGER_GRID_CELLS).fill(-1);
  }

  /** Record one heard elimination (router wiring seam). */
  noteElimination(x: number, y: number, mapWidth: number, mapHeight: number, tick: number): void {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.lastElimX = x;
    this.lastElimY = y;
    this.lastElimTick = tick;
    const flat = this.sectorOf(x, y);
    // Cluster accumulation: decay the stored pressure to NOW first, then add
    // the new death — deaths in the same sector SUM into pressure.
    const decayed = this.pressureAt(flat, tick);
    this.pressure[flat] = decayed + DANGER_PRESSURE_PER_DEATH;
    this.stampTick[flat] = tick;
  }

  /**
   * Decayed danger pressure at a world position (0 when no map known).
   * Lazy exponential decay off the write anchor — reads never mutate.
   */
  dangerAt(x: number, y: number, tick: number): number {
    if (this.mapWidth <= 0 || this.mapHeight <= 0) return 0;
    return this.pressureAt(this.sectorOf(x, y), tick);
  }

  /**
   * The safe-loot target while the window is open: the freshest elimination
   * seat with its linear age bias (1 → 0 across SAFE_LOOT_WINDOW_TICKS).
   * Null when no elimination was heard or the window closed.
   */
  safeLootTarget(tick: number): { x: number; y: number; bias: number } | null {
    const age = tick - this.lastElimTick;
    if (age < 0 || age >= SAFE_LOOT_WINDOW_TICKS) return null;
    const bias = 1 - age / SAFE_LOOT_WINDOW_TICKS;
    return { x: this.lastElimX, y: this.lastElimY, bias };
  }

  private sectorOf(x: number, y: number): number {
    const col = Math.min(
      DANGER_GRID_COLS - 1,
      Math.max(0, Math.floor((x / Math.max(1, this.mapWidth)) * DANGER_GRID_COLS)),
    );
    const row = Math.min(
      DANGER_GRID_COLS - 1,
      Math.max(0, Math.floor((y / Math.max(1, this.mapHeight)) * DANGER_GRID_COLS)),
    );
    return row * DANGER_GRID_COLS + col;
  }

  /** p × 0.5^(dt / halfLife) — the lazy decay read (0 for never-written). */
  private pressureAt(flat: number, tick: number): number {
    const stamp = this.stampTick[flat]!;
    if (stamp < 0) return 0;
    const dt = tick - stamp;
    if (dt <= 0) return this.pressure[flat]!;
    return this.pressure[flat]! * Math.pow(0.5, dt / DANGER_HALF_LIFE_TICKS);
  }
}
