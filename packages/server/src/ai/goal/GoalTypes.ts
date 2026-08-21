/**
 * Macro-goal type definitions — bot-ai-v2 ticket 07 (DEC-008).
 *
 * The macro-goal generator replaces wander-target noise with scored,
 * COMMITTED strategic goals. Layer position: ABOVE the intent layer (the
 * goal survives intent churn — a bot keeps rotating to its quiet side
 * through ENGAGE↔HUNT flips), BELOW survival (SURVIVE_ZONE/FLEE_ZONE ignore
 * goals entirely). WANDER/LOOT/HUNT executors BIND to the active goal.
 *
 * CONTRACTS (decision log DEC-008):
 *  - Commit-sticky: the winner is committed for 3-6 s (GoalTables); the
 *    re-score pass runs every ~2-3 s STAGGERED per bot (hashPhase — no RNG).
 *  - RNG-FREE scoring: candidate evaluation is a pure function of the read
 *    inputs; ties break by fixed kind order + incumbent bonus. Any
 *    stochastic seam would break the same-seed byte-identity contract.
 *  - ZERO wall-clock reads: every timing input is tick- or ms-accumulation
 *    based (timeUntilShrink comes from ZoneService's phaseElapsedMs, which
 *    the benchmark virtual clock drives — never from Date.now()).
 *  - Read-only world: the generator consumes perception, stimulus history,
 *    zone state and map identity data; it mutates ONLY its own per-bot
 *    MacroGoalState. Bots remain players on the input pipeline.
 */

/** The macro-goal candidate kinds (DEC-008's set + the endgame hold). */
export type MacroGoalKind =
  | 'LOOT_CLUSTER'
  | 'QUIET_SIDE'
  | 'UNEXPLORED_SECTOR'
  | 'PRE_POSITION'
  | 'HOTSPOT_STALK'
  | 'ENDGAME_HOLD';

/**
 * JSON-stable enumeration order. Scoring iterates candidates in this order
 * (deterministic tie-break); telemetry keys index by these labels. Never
 * reorder — benchmark JSON consumers index by key.
 */
export const MACRO_GOAL_KIND_KEYS: readonly MacroGoalKind[] = [
  'LOOT_CLUSTER',
  'QUIET_SIDE',
  'UNEXPLORED_SECTOR',
  'PRE_POSITION',
  'HOTSPOT_STALK',
  'ENDGAME_HOLD',
];

/** Human-readable labels (telemetry Record keys use these). */
export const MACRO_GOAL_KIND_LABELS: Record<MacroGoalKind, string> = {
  LOOT_CLUSTER: 'lootCluster',
  QUIET_SIDE: 'quietSide',
  UNEXPLORED_SECTOR: 'unexploredSector',
  PRE_POSITION: 'prePosition',
  HOTSPOT_STALK: 'hotspotStalk',
  ENDGAME_HOLD: 'endgameHold',
};

/** One committed macro-goal (value object — replaced, never mutated). */
export interface MacroGoal {
  readonly kind: MacroGoalKind;
  /** World-space destination point (already the goal POINT; executors clamp
   *  to walkable + apply the zone-as-cost waypoint when routing). */
  readonly x: number;
  readonly y: number;
  /** Tick this goal was committed. */
  readonly bornTick: number;
  /** Tick until which the goal is committed (commit-sticky window). */
  readonly commitUntilTick: number;
  /** Map-identity flavor (read-only): destination POI name when the map
   *  carries one (map redesign payload); undefined on tier-less maps. */
  readonly poiName?: string;
  /** Destination sector tier flavor: 0=COLD, 1=WARM, 2=HOT (−1 unknown). */
  readonly poiTier: number;
}

/** One fight-density sample: where a fight was heard, how loud. */
export interface FightPoint {
  readonly x: number;
  readonly y: number;
  /** Effective strength (age-decayed stimulus strength; hotspot ~0.5). */
  readonly strength: number;
}

/** Zone timing/geometry the scorer + rotation model consume. All derived
 *  from the server zone state (read-only) — see GoalBinding.buildGoalInputs
 *  for the assembly and ZoneService.getMsUntilShrink for the timing source. */
export interface GoalZoneView {
  /** Safe anchor (current or next center per pickZoneSafePoint). */
  safeX: number;
  safeY: number;
  safeRadius: number;
  /** Ticks until the current (or first) radius transition begins; −1 when
   *  unknown (no zone data). 0 = transition underway / sudden death. */
  timeUntilShrinkTicks: number;
  /** True while center/radius is actively interpolating. */
  isShrinking: boolean;
  /** True when the zone deals damage (phase ≥ 2) — the zone-as-cost gate. */
  lethal: boolean;
  /** Zone damage per tick outside the circle (5, or 10 in sudden death). */
  damagePerTick: number;
  /** Next-ring geometry the rotation targets (preview or current target). */
  nextX: number;
  nextY: number;
  nextRadius: number;
}

/** Read-only map identity view (map redesign payload: sector tiers + POI
 *  names + hero-landmark anchors). NULL on tier-less maps (demo TMX) —
 *  every consumer must tolerate null (the flavor bonus simply vanishes).
 *  CONSUMED READ-ONLY (DEC-008 map-identity clause): the AI never mutates
 *  map data; server-authoritative generation stays intact. */
export interface MapIdentityView {
  /** Sector grid columns/rows (4×4 today). */
  readonly cols: number;
  readonly rows: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Effective tier per sector (0=COLD, 1=WARM, 2=HOT incl. the per-match
   *  hot-sector upgrade), row-major [row][col]. */
  readonly tierGrid: ReadonlyArray<ReadonlyArray<number>>;
  /** POI display name per sector (row-major), when the map carries names. */
  readonly poiNames: ReadonlyArray<ReadonlyArray<string>> | null;
  /** Hero-landmark anchor world position per sector (row-major), nullable. */
  readonly anchors: ReadonlyArray<ReadonlyArray<{ x: number; y: number } | null>> | null;
}

/** Sector-index lookup on a MapIdentityView (row-major flat index). */
export function mapIdentitySectorIndex(view: MapIdentityView, x: number, y: number): number {
  const col = Math.min(view.cols - 1, Math.max(0, Math.floor((x / view.mapWidth) * view.cols)));
  const row = Math.min(view.rows - 1, Math.max(0, Math.floor((y / view.mapHeight) * view.rows)));
  return row * view.cols + col;
}

/** Effective tier (0..2) at a world position; −1 outside/unknown. */
export function mapTierAt(view: MapIdentityView, x: number, y: number): number {
  const col = Math.min(view.cols - 1, Math.max(0, Math.floor((x / view.mapWidth) * view.cols)));
  const row = Math.min(view.rows - 1, Math.max(0, Math.floor((y / view.mapHeight) * view.rows)));
  const tier = view.tierGrid[row]?.[col];
  return tier === undefined ? -1 : tier;
}

/** POI display name at a world position; undefined when unnamed/absent. */
export function mapPoiNameAt(view: MapIdentityView, x: number, y: number): string | undefined {
  if (!view.poiNames) return undefined;
  const col = Math.min(view.cols - 1, Math.max(0, Math.floor((x / view.mapWidth) * view.cols)));
  const row = Math.min(view.rows - 1, Math.max(0, Math.floor((y / view.mapHeight) * view.rows)));
  return view.poiNames[row]?.[col] || undefined;
}

/** Hero-landmark anchor world position for a sector (row, col); null when
 *  the map carries no landmarks for it. */
export function mapAnchorAt(
  view: MapIdentityView,
  row: number,
  col: number,
): { x: number; y: number } | null {
  if (!view.anchors) return null;
  return view.anchors[row]?.[col] ?? null;
}

/** World center of a sector (row, col) — the anchor when present (loot
 *  goals prefer the named, structured ground), else the geometric center. */
export function mapSectorPoint(
  view: MapIdentityView,
  row: number,
  col: number,
): { x: number; y: number; poiName?: string } {
  const anchor = mapAnchorAt(view, row, col);
  const cx = ((col + 0.5) / view.cols) * view.mapWidth;
  const cy = ((row + 0.5) / view.rows) * view.mapHeight;
  if (anchor) {
    return { x: anchor.x, y: anchor.y, poiName: view.poiNames?.[row]?.[col] || undefined };
  }
  return { x: cx, y: cy, poiName: view.poiNames?.[row]?.[col] || undefined };
}

/**
 * Build the read-only identity view from the map redesign payload (room
 * lifecycle): base tier grid + per-match hot sector (effective tiers — HOT
 * upgrade applied), POI names, and hero-landmark anchors (tile → world via
 * the tile size). Returns NULL when the map carries no tier grid (demo TMX
 * maps) — the AI stays tier-blind and every consumer tolerates it.
 * Pure function; the caller owns the source data (never mutated).
 */
export function buildMapIdentityView(source: {
  cols: number;
  rows: number;
  mapWidth: number;
  mapHeight: number;
  tilePixelSize: number;
  sectorTiers: ReadonlyArray<ReadonlyArray<string>> | undefined;
  hotSector: { row: number; col: number } | undefined;
  poiNames: ReadonlyArray<ReadonlyArray<string>> | undefined;
  landmarkTiles: ReadonlyArray<ReadonlyArray<{ tileX: number; tileY: number } | null>> | undefined;
}): MapIdentityView | null {
  if (!source.sectorTiers || source.sectorTiers.length === 0) return null;
  const rows = source.rows;
  const cols = source.cols;
  const tierGrid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const base = source.sectorTiers[r]?.[c];
      const hot = source.hotSector;
      const isHot = hot !== undefined && hot.row === r && hot.col === c;
      // 0=COLD, 1=WARM, 2=HOT (the effective tier: base upgraded by the
      // per-match hot sector — mirrors shared effectiveSectorTier).
      const tier = base === 'HOT' || isHot ? 2 : base === 'WARM' ? 1 : 0;
      row.push(tier);
    }
    tierGrid.push(row);
  }
  let anchors: MapIdentityView['anchors'] = null;
  if (source.landmarkTiles) {
    anchors = source.landmarkTiles.map((row) =>
      row.map((tile) =>
        tile
          ? {
              x: tile.tileX * source.tilePixelSize + source.tilePixelSize / 2,
              y: tile.tileY * source.tilePixelSize + source.tilePixelSize / 2,
            }
          : null,
      ),
    );
  }
  return {
    cols,
    rows,
    mapWidth: source.mapWidth,
    mapHeight: source.mapHeight,
    tierGrid,
    poiNames: source.poiNames ? source.poiNames.map((r) => [...r]) : null,
    anchors,
  };
}

/** The read-only inputs one scoring pass consumes. Structural on purpose —
 *  unit tests feed plain literals; GoalBinding assembles it per rescore. */
export interface MacroGoalInputs {
  readonly tick: number;
  readonly playerId: string;
  readonly x: number;
  readonly y: number;
  readonly health: number;
  readonly maxHealth: number;
  /** True when the bot holds a weapon with ammo (drives loot-vs-hunt mix). */
  readonly armed: boolean;
  /** Personality archetype (indexes GoalTables.ARCHETYPE_GOAL_PROFILES). */
  readonly archetype: number;
  /** Greed weight 0..1 (loot-cluster amplification). */
  readonly greed: number;
  /** Commit multiplier (commit window scaling, data-table clamped). */
  readonly commitMultiplier: number;
  readonly zone: GoalZoneView;
  /** Fight-density samples (stimulus history + shared hotspot). */
  readonly fightPoints: readonly FightPoint[];
  /** Strongest remembered loot seat from stimulus history (chest opens),
   *   null when nothing heard recently. */
  readonly heardChest: { x: number; y: number; tick: number } | null;
  /**
   * KILL-FEED AWARENESS (bot-ai-v2 ticket 09, DEC-010.4): the safe-loot
   * target from the per-bot elimination memory (fresh corpse seat + window
   * bias), null when the window closed. Optional — pre-ticket-09 callers and
   * test literals omit it (the scorer treats absence as null).
   */
  readonly heardElimination?: { x: number; y: number; tick: number } | null;
  /**
   * KILL-FEED AWARENESS (DEC-010.4): decayed sector-danger read (deaths
   * clustering per sector, match-long with decay). Feeds the quiet-side
   * scorer's away-from-killing-fields bias. Optional for the same reason.
   */
  readonly dangerAt?: ((x: number, y: number) => number) | null;
  /** Freshest in-scan loot (chest or upgrade weapon), null when none. */
  readonly inScanLoot: { x: number; y: number; value: number } | null;
  readonly aliveCount: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly mapIdentity: MapIdentityView | null;
  /** Sector visit memory (row-major flat, last-visit tick; 0 = never).
   *  ArrayLike so both Float64Array states and plain test literals fit. */
  readonly sectorVisits: ArrayLike<number>;
  /** Barrel density read (0..255 per cell) — the hotspot-edge stalk picks
   *  low-density approach angles. Null when no grid is available. */
  readonly barrelDensityAt: ((x: number, y: number) => number) | null;
  /** How many bots already committed to the hotspot stalk this tick
   *  (saturation — a fight draws a few stalkers, not the lobby). */
  readonly hotspotStalkers: number;
  /**
   * MATCH-ARC STATE (bot-ai-v2 ticket 10, DEC-011): the per-tick GDD §14.3
   * phase-weight state. The PRE_POSITION candidate reads positioningMod ×
   * archetype slope (rotation margin + pre-position weight — the "rotation
   * margins" consumer DEC-011 names). Optional: absent/null = identity (no
   * shaping) — the pre-ticket-10 literals and pre-cadence paths; production
   * (GoalBinding.buildGoalInputs) always sets it.
   */
  readonly arc?: import('../arc/MatchArc.ts').MatchArcState | null;
}

/** The per-bot macro-goal generator state (mutated only by
 *  GoalGenerator.updateMacroGoal). */
export interface MacroGoalState {
  /** The committed goal; null before the first commit. */
  current: MacroGoal | null;
  /** Next tick a scoring pass may run (staggered per bot). */
  nextRescoreTick: number;
  /** Total commits by kind label (observation-only; feeds the goal-mix
   *  telemetry through the believability counters). */
  readonly commitsByKind: Record<string, number>;
  /** Sector visit memory: last-visit tick per row-major sector (4×4 = 16
   *  slots max; sized from the identity view when present, else 16). */
  sectorVisits: Float64Array;
  /** Sector the bot currently occupies (flat index) — avoids rewriting the
   *  visit stamp every tick. */
  currentSector: number;
}
