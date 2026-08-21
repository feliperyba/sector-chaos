/**
 * THE PREFAB LIBRARY (map-polish ticket 25) — ten authored compositions that
 * replace the generator's per-cell probability scatter with logical, reused
 * structures. Owner demand (verbatim): "STOP TO PLACE THINGS IN THE MAP AT
 * RANDOM. DO CREATE LOGICAL PREFABS AND COMPOSITIONS AND RE-USE THEM SMARTLY
 * IN THE SEED MAP GENERATOR, SO THE MAP DOES NOT FEEL 100% RANDOM" — and the
 * art annotation: walls "MUST NEVER COLLIDE LIKE A FULL TILE, NEITHER
 * REPRESENT A FULL TILE".
 *
 * ENCODING (the beacon-keep discipline of ticket 24, `landmarkPlaza.ts`):
 * every prefab's walls are STRAIGHT RUNS of ≥2 tiles — the autotiler renders
 * each run as continuous top-down face bars, with at most authored L-CORNERS
 * where one run ENDS beside another run's end tile (exactly one run owns the
 * corner tile). No prefab ever places two parallel adjacent wall lines, so no
 * 2×2 wall-like clump can exist in an authored layout — a clump would need a
 * wall one tile inside the run, and runs are exactly one tile thick. Every
 * wall tile keeps a CARDINAL run-mate, so no stamped wall is ever
 * corner-dangling (zero wall-like cardinals) no matter how the conflict-clip
 * trims a run (the clip keeps only ≥2-tile contiguous stretches).
 *
 * Props are DESTRUCTIBLE_CRATE object tiles (grid barrels have no hydration
 * path). Prefabs never fully enclose space — U/L/pier/bar shapes with wide
 * mouths — and the placement pass adds a windowed never-seal revert on top.
 *
 * Offsets are `[col, row]` from the prefab's stamp anchor (0,0); max extent
 * ±3 (the placement pass stamps inside an all-EMPTY 5×5 window; every
 * out-of-window cell of a footprint is per-cell paint-gated + clipped).
 */

import { TileType } from '../../enums/TileType.js';
import { SectorType } from '../types.js';
import type { PrefabDef, PrefabWallRun } from './PrefabTypes.js';

/** Author one straight wall run from flat `[col,row, ...]` pairs (≥2 tiles). */
function seg(
  tile: TileType.INDESTRUCTIBLE_WALL | TileType.DESTRUCTIBLE_WALL,
  ...flat: number[]
): PrefabWallRun {
  const tiles: Array<readonly [number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    tiles.push([flat[i]!, flat[i + 1]!] as const);
  }
  return { tiles, tile };
}

const ALL_TYPES: readonly SectorType[] = [
  SectorType.GRID_ARENA,
  SectorType.OPEN_ARENA,
  SectorType.MAZE,
  SectorType.RESOURCE_RICH,
];

// ── 1. GATE PIERS (universal fallback vocabulary — the portal pair) ──────────

/**
 * GATE PIERS — twin 3-tile vertical runs framing a 5-wide mouth, with a crate
 * anchored at each pier base (round 6: the grounded-gate read — the crossing
 * keeps its honest open mouth; the crates sit OUTSIDE it, in the pier line's
 * extension, so they never narrow the gap).
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row  0:    .   .   .   .   .
 *   row  1:   [W]  .   .   .  [W]
 *   row  2:   [W]  .   .   .  [W]
 *   row  3:   (C)  .   .   .  (C)
 * ```
 * Encoding: two disjoint straight runs; no joins, no corners, 1 tile thick.
 */
const GATE_PIERS: PrefabDef = {
  id: 'gate-piers',
  fiction: 'a gateway — two honest wall terminations framing a crossing',
  allowedSectorTypes: ALL_TYPES,
  weight: 10,
  orientations: 'rot4',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -2, 0, -2, 1, -2, 2),
    seg(TileType.INDESTRUCTIBLE_WALL, 2, 0, 2, 1, 2, 2),
  ],
  props: [
    [-2, 3],
    [2, 3],
  ],
};

// ── 2. COVER BRACE (GRID / MAZE / RICH) ──────────────────────────────────────

/**
 * COVER BRACE — two staggered 4-tile vertical runs (one starts a row above the
 * other) with the slalom's pivot crate at lane center (round 6: the lane keeps
 * its hard cover on both flanks; the mid-lane crate is the smashable pivot the
 * brawl plays around). A brawler's slalom: hard cover on both flanks of a
 * lane, never aligned, so there is no safe standoff behind both.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -2:   [W]  .   .   .   .
 *   row -1:   [W]  .   .   .   .
 *   row  0:   [W]  .  (C)  .  [W]
 *   row  1:   [W]  .   .   .  [W]
 *   row  2:    .   .   .   .  [W]
 *   row  3:    .   .   .   .  [W]
 * ```
 * Encoding: two disjoint straight runs, staggered — no corners, 1 tile thick.
 */
const COVER_BRACE: PrefabDef = {
  id: 'cover-brace',
  fiction: 'staggered hard cover bracketing a fight lane',
  allowedSectorTypes: [SectorType.GRID_ARENA, SectorType.MAZE, SectorType.RESOURCE_RICH],
  weight: 12,
  orientations: 'full',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -2, -2, -2, -1, -2, 0, -2, 1),
    seg(TileType.INDESTRUCTIBLE_WALL, 2, 0, 2, 1, 2, 2, 2, 3),
  ],
  props: [[0, 0]],
};

// ── 3. WATCH POST (GRID / MAZE / RICH) ───────────────────────────────────────

/**
 * WATCH POST — an L of two runs with the corner owned by the horizontal run
 * (the vertical run starts one tile BELOW it), plus a crate pair on the open
 * side. Reads as a corner emplacement overlooking the props.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -2:   [W] [W] [W] [W]  .
 *   row -1:   [W]  .   .   .   .
 *   row  0:   [W]  .   .   .  (C)
 *   row  1:   [W]  .   .   .  (C)
 *   row  2:    .   .   .   .   .
 * ```
 * Encoding: ONE authored L-corner at (-2,-2) — the H run owns the corner
 * tile, the V run joins cardinally below it, so the autotiler stamps a single
 * clean wall_corner. 1 tile thick everywhere (the inner diagonal (-1,-1)
 * stays EMPTY, so no 2×2 clump can form even against pre-existing walls —
 * the placement pass re-checks per write regardless).
 */
const WATCH_POST: PrefabDef = {
  id: 'watch-post',
  fiction: 'a corner emplacement watching over the goods',
  allowedSectorTypes: [SectorType.GRID_ARENA, SectorType.MAZE, SectorType.RESOURCE_RICH],
  weight: 12,
  orientations: 'full',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -2, -2, -1, -2, 0, -2, 1, -2),
    seg(TileType.INDESTRUCTIBLE_WALL, -2, -1, -2, 0, -2, 1),
  ],
  props: [
    [2, 0],
    [2, 1],
  ],
};

// ── 4. CAMP SITE (OPEN / RICH) ───────────────────────────────────────────────

/**
 * CAMP SITE — a smashable lean-to: the beacon-keep ∩ topology in
 * DESTRUCTIBLE_WALL, one size class smaller (3-tile sides, 3-tile back bar),
 * fully open to the south, with the camp's two crates OUTSIDE the walls
 * flanking the gate-pier ends (the keep's prop discipline — props never
 * narrow a mouth into a pluggable 1-wide slot). The wall runs are breakable,
 * so camping it is a choice, not a right.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -2:   [W] [W] [W] [W] [W]   <- back bar spans the two corner tiles
 *   row -1:   [W]  .   .   .  [W]
 *   row  0:   [W]  .   .   .  [W]   <- 3-wide mouth, fully open south
 *   row  1:   (C)  .   .   .  (C)   <- crates flank the gate-pier ends
 *   row  2:    .   .   .   .   .
 * ```
 * Encoding: the ticket-24 keep grammar — WEST run owns the NW corner (-2,-2),
 * EAST run owns the NE corner (2,-2), and the NORTH bar spans only cols
 * -1..1 between them (never overlapping the corner tiles). Exactly 1 tile
 * thick; the south mouth is 5 wide (never sealed, never slotted).
 */
const CAMP_SITE: PrefabDef = {
  id: 'camp-site',
  fiction: 'a breakable lean-to — smash the walls, take the camp',
  allowedSectorTypes: [SectorType.OPEN_ARENA, SectorType.RESOURCE_RICH],
  weight: 12,
  orientations: 'rot4',
  walls: [
    seg(TileType.DESTRUCTIBLE_WALL, -2, -2, -2, -1, -2, 0),
    seg(TileType.DESTRUCTIBLE_WALL, 2, -2, 2, -1, 2, 0),
    seg(TileType.DESTRUCTIBLE_WALL, -1, -2, 0, -2, 1, -2),
  ],
  props: [
    [-2, 1],
    [2, 1],
  ],
};

// ── 5. GROVE COPSE (OPEN) ────────────────────────────────────────────────────

/**
 * GROVE COPSE — five crates in a quincunx (four corners + center). No walls:
 * an organic thicket of objects, soft cover that reads as planted, not
 * rolled. Props-only compositions never seal anything (crates are
 * traversable smashables, not wall-like).
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -2:  (C)   .   .   .  (C)
 *   row -1:    .   .   .   .   .
 *   row  0:    .   .  (C)  .   .
 *   row  1:    .   .   .   .   .
 *   row  2:  (C)   .   .   .  (C)
 * ```
 */
const GROVE_COPSE: PrefabDef = {
  id: 'grove-copse',
  fiction: 'a planted thicket — five trees in a quincunx',
  allowedSectorTypes: [SectorType.OPEN_ARENA],
  weight: 10,
  orientations: 'rot4',
  walls: [],
  props: [
    [-2, -2],
    [2, -2],
    [0, 0],
    [-2, 2],
    [2, 2],
  ],
};

// ── 6. BARRICADE LINE (OPEN / RICH / GRID) ───────────────────────────────────

/**
 * BARRICADE LINE — one straight 5-tile DESTRUCTIBLE_WALL bar with crate
 * end-caps flanking the line one tile past each end. The lane-breaker: a
 * single honest wall you can smash through, not a scatter of dots.
 *
 * ```
 *        col: -3  -2  -1   0   1   2   3
 *   row  0:  (C) [W] [W] [W] [W] [W] (C)
 *   row -1:   .   .   .   .   .   .   .
 *   row  1:   .   .   .   .   .   .   .
 * ```
 * Encoding: one straight run (no corners); crates are objects, not wall-like,
 * so the end-caps never extend the wall art.
 */
const BARRICADE_LINE: PrefabDef = {
  id: 'barricade-line',
  fiction: 'a smashed-through roadblock across the lane',
  allowedSectorTypes: [SectorType.OPEN_ARENA, SectorType.RESOURCE_RICH, SectorType.GRID_ARENA],
  weight: 12,
  orientations: 'rot4',
  walls: [seg(TileType.DESTRUCTIBLE_WALL, -2, 0, -1, 0, 0, 0, 1, 0, 2, 0)],
  props: [
    [-3, 0],
    [3, 0],
  ],
};

// ── 7. RUIN FRAGMENT (OPEN / MAZE) ───────────────────────────────────────────

/**
 * RUIN FRAGMENT — two residual runs of a collapsed room: a 3-tile header and
 * a 3-tile jamb, offset with a 2-wide breach where the corner used to be (a
 * 1-wide gap between wall ends would be a pluggable slot — the breach stays
 * wide enough to walk through sideways). Two rubble crates sit in the room's
 * lost corner (round 6: the fallen masonry, hauled into a pair). One
 * indestructible: old masonry.
 *
 * ```
 *        col: -2  -1   0   1   2   3
 *   row -2:   [W] [W] [W]  .   .  [W]
 *   row -1:    .   .   .   .   .  [W]
 *   row  0:    .   .  (C) (C)  .  [W]
 *   row  1:    .   .   .   .   .   .
 * ```
 * Encoding: two DISJOINT straight runs (the ruin's corner is deliberately
 * missing — no join, no corner tile), 1 tile thick, 2-wide breach.
 */
const RUIN_FRAGMENT: PrefabDef = {
  id: 'ruin-fragment',
  fiction: 'the standing remnant of a collapsed room',
  allowedSectorTypes: [SectorType.OPEN_ARENA, SectorType.MAZE],
  weight: 12,
  orientations: 'full',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -2, -2, -1, -2, 0, -2),
    seg(TileType.INDESTRUCTIBLE_WALL, 3, -2, 3, -1, 3, 0),
  ],
  props: [
    [0, 0],
    [1, 0],
  ],
};

// ── 8. BROKEN ARCH (MAZE / OPEN) ─────────────────────────────────────────────

/**
 * BROKEN ARCH — two 2-tile piers with the lintel gone; a single crate stands
 * under the gap's south side (the fallen span, hauled clear — centered
 * BETWEEN the piers it would leave 1-wide pluggable slots against them). A
 * doorway that no longer closes.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -1:   [W]  .   .   .  [W]
 *   row  0:   [W]  .   .   .  [W]
 *   row  1:    .   .  (C)  .   .
 *   row  2:    .   .   .   .   .
 * ```
 * Encoding: two disjoint 2-tile runs (the minimum honest run — the pass
 * drops any run that cannot keep 2 tiles).
 */
const BROKEN_ARCH: PrefabDef = {
  id: 'broken-arch',
  fiction: 'a doorway whose lintel fell — the crate is the span',
  allowedSectorTypes: [SectorType.MAZE, SectorType.OPEN_ARENA],
  weight: 10,
  orientations: 'rot4',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -2, -1, -2, 0),
    seg(TileType.INDESTRUCTIBLE_WALL, 2, -1, 2, 0),
  ],
  props: [[0, 1]],
};

// ── 9. CRATE STASH (RICH / GRID) ─────────────────────────────────────────────

/**
 * CRATE STASH — a tidy 3×2 block of six crates against nothing: the supply
 * drop someone stacked and left. Props-only (traversable smashables, never
 * wall-like), so it can never seal or clump as wall art.
 *
 * ```
 *        col: -1   0   1
 *   row -1:  (C) (C) (C)
 *   row  0:  (C) (C) (C)
 *   row  1:   .   .   .
 * ```
 */
const CRATE_STASH: PrefabDef = {
  id: 'crate-stash',
  fiction: 'a stacked supply drop — six crates, one haul',
  allowedSectorTypes: [SectorType.RESOURCE_RICH, SectorType.GRID_ARENA],
  weight: 12,
  orientations: 'rot4',
  walls: [],
  props: [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
  ],
};

// ── 10. MARKET STALL (RICH / GRID / MAZE) ────────────────────────────────────

/**
 * MARKET STALL — a 3-tile breakable counter with two goods-crates flanking
 * one row back. The counter is the wall (smashable — the stall can be
 * looted bare), the goods sit in the shopper's pocket behind it.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -1:  (C)  .   .   .  (C)
 *   row  0:   .  [W] [W] [W]  .
 *   row  1:   .   .   .   .   .
 * ```
 * Encoding: one straight DESTRUCTIBLE run; crates are off-line objects.
 */
const MARKET_STALL: PrefabDef = {
  id: 'market-stall',
  fiction: 'a market counter — smash it open, the goods are behind',
  allowedSectorTypes: [SectorType.RESOURCE_RICH, SectorType.GRID_ARENA, SectorType.MAZE],
  weight: 12,
  orientations: 'full',
  walls: [seg(TileType.DESTRUCTIBLE_WALL, -1, 0, 0, 0, 1, 0)],
  props: [
    [-2, -1],
    [2, -1],
  ],
};

// ── 11. STOCKYARD (RICH / GRID) ──────────────────────────────────────────────

/**
 * STOCKYARD (round 6) — the pen: two parallel breakable fence bars with the
 * goods penned between them. Smash either fence to spill the stock into your
 * lane — the round-6 material grammar as a composition (breakable walls WITH
 * the structure, goods WITH the walls).
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -1:  [d] [d] [d]  .   .
 *   row  0:  (C) (C) (C)  .   .
 *   row  1:  [d] [d] [d]  .   .
 * ```
 * Encoding: two disjoint 3-tile DESTRUCTIBLE runs (1 tile apart east-open —
 * never a seal), crates are objects between them (no wall-like 2×2 possible).
 */
const STOCKYARD: PrefabDef = {
  id: 'stockyard',
  fiction: 'a pen — breakable fences, goods penned between',
  allowedSectorTypes: [SectorType.RESOURCE_RICH, SectorType.GRID_ARENA],
  weight: 12,
  orientations: 'rot4',
  walls: [
    seg(TileType.DESTRUCTIBLE_WALL, -2, -1, -1, -1, 0, -1),
    seg(TileType.DESTRUCTIBLE_WALL, -2, 1, -1, 1, 0, 1),
  ],
  props: [
    [-2, 0],
    [-1, 0],
    [0, 0],
  ],
};

// ── 12. SUPPLY DEPOT (RICH / OPEN / GRID) ────────────────────────────────────

/**
 * SUPPLY DEPOT (round 6) — the shelf row: a rigid 3-tile back bar, a breakable
 * 2-tile counter one row south, and the goods crate at the counter's west end.
 * Layered like the market stall but with a hard back wall — loot rushes get a
 * rigid frame to fight around and a smashable front to open.
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -1:   .  [W] [W] [W]  .
 *   row  0:  (C)  .  [d] [d]  .
 *   row  1:   .   .   .   .   .
 * ```
 * Encoding: one INDESTRUCTIBLE run + one DESTRUCTIBLE run, parallel with an
 * offset (the counter spans cols 0..1 under the bar's east half — no 2×2
 * wall-like block: the west 2×2 holds the crate).
 */
const SUPPLY_DEPOT: PrefabDef = {
  id: 'supply-depot',
  fiction: 'the depot shelf — hard back wall, smashable counter, goods at the end',
  allowedSectorTypes: [SectorType.RESOURCE_RICH, SectorType.OPEN_ARENA, SectorType.GRID_ARENA],
  weight: 12,
  orientations: 'rot4',
  walls: [
    seg(TileType.INDESTRUCTIBLE_WALL, -1, -1, 0, -1, 1, -1),
    seg(TileType.DESTRUCTIBLE_WALL, 0, 0, 1, 0),
  ],
  props: [[-2, 0]],
};

/**
 * The prefab library (12 compositions across the four biome families; the
 * gate-piers vocabulary is universal). Selection is drawn by the deterministic
 * smart-reuse placement pass — same seed ⇒ same picks.
 */
export const PREFAB_LIBRARY: readonly PrefabDef[] = [
  GATE_PIERS,
  COVER_BRACE,
  WATCH_POST,
  CAMP_SITE,
  GROVE_COPSE,
  BARRICADE_LINE,
  RUIN_FRAGMENT,
  BROKEN_ARCH,
  CRATE_STASH,
  MARKET_STALL,
  STOCKYARD,
  SUPPLY_DEPOT,
];

/** All library ids (telemetry vocabulary; stable order). */
export const PREFAB_IDS: readonly string[] = PREFAB_LIBRARY.map((p) => p.id);
