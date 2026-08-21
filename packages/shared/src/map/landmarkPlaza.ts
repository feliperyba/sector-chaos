import { TileType } from '../enums/TileType.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from './constants.js';
import { createsUnrenderableJunction } from './gridUtils.js';
import type { LandmarkAssignment, HeroLandmark } from './landmarks.js';
import type { SectorData } from './types.js';

/**
 * THE BEACON KEEP — one authored beacon-plaza structure (map-polish round-3
 * ticket 24; replaces the round-2 4-archetype grammar of ticket 16, which
 * replaced the round-1 16-layout grammar of ticket 05).
 *
 * Owner verdict on the round-2 grammar (verbatim): "The beacon plaza
 * composition is a fucking mess. do not do this overlapping composition,
 * just do a nice structure with the beacon light and some walls protecting
 * it. You are just clustering random objects and tiles together at this
 * point." The fix is not another grammar — it is ONE structure every hero
 * landmark shares: a small ruined keep. The beacon is the centerpiece at the
 * anchor; three straight wall runs form a partial enclosure (∩ shape) that
 * reads "walls protecting the light" at a glance; the keep is fully open on
 * the south so the beacon walk-in is unobstructed.
 *
 * THE STRUCTURE (anchor at [0,0]; offsets are [col, row]; north = row -2 —
 * the sector reads top-down, so the N run is the wall BEHIND the beacon):
 *
 * ```
 *        col: -2  -1   0   1   2
 *   row -2:   [W] [N] [N] [N] [E]   <- N run: the wall behind the beacon
 *   row -1:   [W]  .   .   .  [E]
 *   row  0:   [W]  .  (B)  .  [E]   <- (B) = beacon (the anchor, never touched)
 *   row  1:   [W]  .   .   .  [E]
 *   row  2:   [W]  .   .   .  [E]   <- gate piers (honest wall ends)
 *   row  3:    .  (P)  .  (P)  .    <- P = the prop pair flanking the approach
 * ```
 *
 * ART-AWARE RUN/CORNER ENCODING — walls are SUB-TILE top-down art (face bars
 * + L-corners, `wallArtShapes.ts`), never full squares, so the runs are
 * authored exactly as the autotiler wants them:
 *
 * - WEST/EAST runs are single straight vertical 5-tile runs — one face-bar
 *   line per side, no breaks, no offsets.
 * - NORTH run is a single straight horizontal 3-tile run between the side
 *   runs' top tiles — the screen behind the beacon.
 * - The joins at (-2,-2) and (2,-2) are L-CORNERS: exactly one run owns each
 *   corner tile (the side runs reach row -2; the N run spans only cols -1..1)
 *   so the autotiler stamps a clean wall_corner there instead of overlapping
 *   faces.
 * - The south ends of the side runs at (±2, 2) are the GATE PIERS — honest
 *   wall terminations framing the 3-wide south mouth.
 * - Every wall sits on the Chebyshev-2 ring — the enclosure is exactly ONE
 *   tile thick, so it can never contain a 2×2 solid clump (a clump would
 *   need a wall at Chebyshev < 2), and there is no checkerboard or dangling
 *   tile anywhere in the authored shape (two straight runs + one bar; the
 *   only two non-colinear joints are the authored corners above).
 *
 * PROPS: at most 2, symmetric, outside the enclosure — one DESTRUCTIBLE_CRATE
 * pair at (±1, 3) flanking the south approach corridor one tile past the gate
 * piers. NO props inside the enclosure (the court around the beacon stays
 * clean), no dais stacking, no extra tile decoration (the single uniform
 * floor patch under the beacon is the registry's baked composite dressing,
 * unchanged by this module).
 *
 * Stamping mechanics follow the paint-gate discipline (only EMPTY, interior,
 * non-corridor, non-macro, non-lootSpot tiles are ever written — the keep
 * NEVER overwrites authored geometry), plus ticket 16's CONFLICT-CLIP rule
 * for wall runs: each run stamps its longest fully-paintable contiguous
 * stretch when that stretch is ≥2 tiles (see {@link clipSegment}) — a run
 * blocked mid-wall degrades to its clean remainder, which reads as a ruin
 * breach instead of vanishing wholesale. A keep whose runs stamp zero wall
 * tiles (the documented hostile-site class: vault boxes / macro crossings)
 * degrades to the PORTAL PAIR (twin gate-pier runs) so every beacon keeps
 * its gate; a segment that would wall-seal the beacon is reverted (see
 * {@link anchorReachesWindowEdge}). The anchor tile, its 4 cardinal
 * neighbours and the whole south approach corridor [(0,2) → (0,1) → (0,0)]
 * are NEVER touched by any wall or prop, so the guaranteed walkway/sightline
 * to the light holds by construction and no STAMPED tile ever enters the 3×3
 * anchor core. Crates are grid `DESTRUCTIBLE_CRATE` tiles — they hydrate to
 * live HP entities through the existing `InteractiveLayerBuilder` grid scan →
 * `MapEntityHydrator` path (grid `DESTRUCTIBLE_BARREL` tiles have NO
 * hydration path).
 *
 * DETERMINISM (ADR 0035): the stamp is a PURE projection of the landmark
 * assignment onto the final pre-entity grid — ZERO RNG draws (neither the
 * main stream nor the LNDM stream is touched; `assignLandmarks` has already
 * consumed the LNDM stream before stamping runs), and there is exactly ONE
 * layout (no archetype menu, no per-seed variant draw — the ticket's ≤3
 * variant allowance is deliberately untaken: sixteen identical keeps read as
 * ONE map-wide structure, which is the cohesion the owner asked for), so
 * same seed ⇒ identical keeps with no stream extension to document.
 */

/** One stamped plaza tile (audit record; NOT stored on MapData). */
export interface PlazaStamp {
  sectorRow: number;
  sectorCol: number;
  /** Local tile coords inside the sector (row-major grid 20×20). */
  tileRow: number;
  tileCol: number;
  tile: TileType.INDESTRUCTIBLE_WALL | TileType.DESTRUCTIBLE_CRATE;
}

/** One authored wall run of the keep. */
export interface PlazaWallSegment {
  /** Local `[col, row]` offsets from the anchor (Chebyshev 2 ring). */
  tiles: ReadonlyArray<readonly [number, number]>;
}

/**
 * The guaranteed aligned approach corridor (local `[col, row]` offsets,
 * outside-in). No wall or prop of the keep ever stamps an axis tile — the
 * walk-in to the beacon is aligned and unobstructed.
 */
export const SOUTH_APPROACH_AXIS: ReadonlyArray<readonly [number, number]> = [
  [0, 2],
  [0, 1],
  [0, 0],
];

/** Pair flat `[dx,dy, dx,dy, ...]` coords into `[col, row]` tuples. */
function pairCoords(flat: readonly number[]): ReadonlyArray<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!] as const);
  return out;
}

/** Author one wall run from flat `[dx,dy, ...]` pairs (≥2 tiles per run). */
function seg(...flat: number[]): PlazaWallSegment {
  return { tiles: pairCoords(flat) };
}

/** The ONE beacon-keep structure every hero landmark shares (see module doc). */
export const BEACON_KEEP: {
  /** The keep's wall runs: straight lines + two authored L-corners. */
  walls: ReadonlyArray<PlazaWallSegment>;
  /** The symmetric prop pair flanking the south approach (outside the keep). */
  props: ReadonlyArray<readonly [number, number]>;
  /** The never-stamped aligned south walk-in (see {@link SOUTH_APPROACH_AXIS}). */
  approachAxis: ReadonlyArray<readonly [number, number]>;
} = {
  walls: [
    // WEST run — straight vertical 5-tile run; its top tile (-2,-2) is the
    // NW L-corner join with the N run, its bottom tile (-2,2) the gate pier.
    seg(-2, -2, -2, -1, -2, 0, -2, 1, -2, 2),
    // NORTH run — straight horizontal 3-tile bar between the corner tiles
    // (never overlaps them): the wall protecting the beacon from behind.
    seg(-1, -2, 0, -2, 1, -2),
    // EAST run — mirror of the WEST run; top tile (2,-2) is the NE corner.
    seg(2, -2, 2, -1, 2, 0, 2, 1, 2, 2),
  ],
  props: [
    [-1, 3],
    [1, 3],
  ],
  approachAxis: SOUTH_APPROACH_AXIS,
};

/**
 * The PORTAL PAIR — the twin 3-tile gate-pier runs, the keep's universal
 * FALLBACK: a keep whose runs stamped zero wall tiles (an anchor site whose
 * skeleton/macro geometry blocks every run) still gets its gate — the piers
 * frame the south approach axis, so even the degraded plaza keeps the
 * one read every beacon shares. Deterministic (a pure function of
 * paintability), zero RNG, and clipped/skipped exactly like authored runs.
 */
export const PORTAL_PAIR: ReadonlyArray<PlazaWallSegment> = [
  seg(-2, 0, -2, 1, -2, 2),
  seg(2, 0, 2, 1, 2, 2),
];

/** Corridor-tile key format used by SectorConnector (`sRow,sCol,tRow,tCol`). */
function corridorKey(row: number, col: number, tileRow: number, tileCol: number): string {
  return `${row},${col},${tileRow},${tileCol}`;
}

/**
 * Whether a local sector tile may receive a keep stamp: interior (never a
 * border/corridor ring tile), EMPTY in the final pre-entity grid (paint-gate
 * — the keep NEVER overwrites authored geometry), not a corridor tile, not a
 * macro-feature carved tile (the compound/Citadel and highway own their
 * footprints — a keep wall inside the Citadel would break its authored gap
 * approaches), and not one of the sector's authored `lootSpots` (the Ring
 * Fortress gap-derived loot framing — loot placement owns those tiles).
 */
function isPaintable(
  sector: SectorData,
  sRow: number,
  sCol: number,
  tileRow: number,
  tileCol: number,
  corridorTiles: Set<string>,
  macroTiles: Set<string>,
): boolean {
  if (tileRow < 1 || tileRow > SECTOR_TILE_SIZE - 2) return false;
  if (tileCol < 1 || tileCol > SECTOR_TILE_SIZE - 2) return false;
  if (sector.tiles[tileRow]![tileCol] !== TileType.EMPTY) return false;
  if (corridorTiles.has(corridorKey(sRow, sCol, tileRow, tileCol))) return false;
  const globalR = sRow * SECTOR_TILE_SIZE + tileRow;
  const globalC = sCol * SECTOR_TILE_SIZE + tileCol;
  if (macroTiles.has(`${globalR},${globalC}`)) return false;
  return !sector.lootSpots.some((spot) => spot.y === tileRow && spot.x === tileCol);
}

/**
 * The longest fully-paintable CONTIGUOUS stretch of an authored run (ties →
 * the first stretch), or null when no stretch reaches the 2-tile minimum.
 * The conflict-clip rule (ticket 16): an authored 5-tile side run blocked at
 * one end degrades to its clean remainder instead of vanishing wholesale —
 * pure geometry, zero RNG, and the ≥2-contiguity/stub-free discipline holds
 * in the STAMPED result, not just the authored data. On the keep a clipped
 * run reads as a ruin breach (a collapsed wall section), which is exactly
 * the fiction the structure wants.
 */
function clipSegment(
  segment: PlazaWallSegment,
  isOffsetPaintable: (dx: number, dy: number) => boolean,
): ReadonlyArray<readonly [number, number]> | null {
  let best: Array<readonly [number, number]> = [];
  let current: Array<readonly [number, number]> = [];
  for (const [dx, dy] of segment.tiles) {
    if (isOffsetPaintable(dx, dy)) {
      current.push([dx, dy]);
    } else {
      if (current.length > best.length) best = current;
      current = [];
    }
  }
  if (current.length > best.length) best = current;
  return best.length >= 2 ? best : null;
}

/**
 * Whether the anchor can still reach the edge of its local window (±4 tiles,
 * sector-clipped) without crossing an indestructible tile — the keep's
 * NEVER-SEAL guard. Anchor sites routinely sit beside pre-existing skeleton
 * walls; a keep run that completes the last gaps of an indestructible collar
 * would wall-seal the beacon. Passability matches `isTraversable`
 * semantics: destructibles count as open (a pocket behind breakable cover is
 * reachable by smashing).
 */
function anchorReachesWindowEdge(
  sector: SectorData,
  anchorRow: number,
  anchorCol: number,
): boolean {
  const r0 = Math.max(0, anchorRow - 4);
  const r1 = Math.min(SECTOR_TILE_SIZE - 1, anchorRow + 4);
  const c0 = Math.max(0, anchorCol - 4);
  const c1 = Math.min(SECTOR_TILE_SIZE - 1, anchorCol + 4);
  const passable = (r: number, c: number): boolean => {
    const t = sector.tiles[r]![c]!;
    return t !== TileType.INDESTRUCTIBLE_WALL && t !== TileType.INDESTRUCTIBLE_CRATE;
  };
  if (!passable(anchorRow, anchorCol)) return false;
  const visited = new Set<string>([`${anchorRow},${anchorCol}`]);
  const queue: Array<[number, number]> = [[anchorRow, anchorCol]];
  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    if (r === r0 || r === r1 || c === c0 || c === c1) return true;
    for (const [nr, nc] of [
      [r + 1, c],
      [r - 1, c],
      [r, c + 1],
      [r, c - 1],
    ] as const) {
      const k = `${nr},${nc}`;
      if (nr < r0 || nr > r1 || nc < c0 || nc > c1 || visited.has(k)) continue;
      if (!passable(nr, nc)) continue;
      visited.add(k);
      queue.push([nr, nc]);
    }
  }
  return false;
}

/**
 * Stamp every hero landmark's beacon keep into the sector grids.
 *
 * Runs in `MapGenerator` AFTER `assignLandmarks` (needs the final anchors)
 * and BEFORE `EntityPlacer.place` (the entity pool must see the keep: its
 * walls are real cover/collision and its props are real entities — the
 * entity placer skips them because it only ever claims EMPTY tiles). Zero
 * RNG; heroes processed row-major. `macroTiles` are the macro-feature carved
 * tiles (highway/compound — the compound owns its footprint). Wall runs
 * stamp their longest paintable contiguous stretch (≥2 tiles — see
 * {@link clipSegment}), never seal the beacon (see
 * {@link anchorReachesWindowEdge}), and fall back to the PORTAL PAIR when
 * the keep stamped nothing; props stamp individually. Returns the audit
 * record of every stamped tile (consumed by the shared purity test to
 * invert the stamp when replaying `assignLandmarks` — keep tiles are NOT
 * stored on MapData, the golden fixtures pin them via `sector.tiles`).
 */
export function stampLandmarkPlazas(
  sectors: SectorData[][],
  corridorTiles: Set<string>,
  landmarks: LandmarkAssignment,
  macroTiles: Set<string> = new Set<string>(),
): PlazaStamp[] {
  const stamps: PlazaStamp[] = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const hero: HeroLandmark | undefined = landmarks.heroes[row]?.[col];
      if (!hero) continue;
      const sector = sectors[row]![col]!;
      const anchorRow = hero.tileY - row * SECTOR_TILE_SIZE;
      const anchorCol = hero.tileX - col * SECTOR_TILE_SIZE;
      const paintable = (tileRow: number, tileCol: number): boolean =>
        isPaintable(sector, row, col, tileRow, tileCol, corridorTiles, macroTiles);
      // NEVER-SEAL baseline: if the beacon can reach its surroundings
      // pre-stamp, every keep wall run must keep it that way (a run that
      // completes an indestructible collar around the anchor is reverted).
      const baseReachable = anchorReachesWindowEdge(sector, anchorRow, anchorCol);
      const stampWalls = (segments: ReadonlyArray<PlazaWallSegment>): number => {
        let stamped = 0;
        // Own-stamp wall cells (this hero's keep so far) — runs join WITHIN
        // the authored composition, never a foreign wall.
        const ownWalls = new Set<string>();
        for (const segment of segments) {
          // Conflict-clip stamp: the longest ≥2-tile paintable stretch of
          // the authored run (never a stub, never a sub-2 segment). The
          // run-join guard (round 8) clips candidates that would push a
          // foreign D neighbour onto both axes (unrenderable junction —
          // the WallContinuityGate D-class); own walls never constrain.
          const run = clipSegment(
            segment,
            (dx, dy) =>
              paintable(anchorRow + dy, anchorCol + dx) &&
              !createsUnrenderableJunction(
                sector.tiles,
                anchorRow + dy,
                anchorCol + dx,
                TileType.INDESTRUCTIBLE_WALL,
                ownWalls,
              ),
          );
          if (!run) continue;
          const stampedTiles: Array<[number, number]> = [];
          for (const [dx, dy] of run) {
            const tr = anchorRow + dy;
            const tc = anchorCol + dx;
            sector.tiles[tr]![tc] = TileType.INDESTRUCTIBLE_WALL;
            stampedTiles.push([tr, tc]);
          }
          if (baseReachable && !anchorReachesWindowEdge(sector, anchorRow, anchorCol)) {
            // This run wall-sealed the beacon — revert it (the tiles were
            // EMPTY by the paint-gate, so EMPTY restores exactly).
            for (const [tr, tc] of stampedTiles) sector.tiles[tr]![tc] = TileType.EMPTY;
            continue;
          }
          for (const [tr, tc] of stampedTiles) {
            ownWalls.add(`${tr},${tc}`);
            stamps.push({
              sectorRow: row,
              sectorCol: col,
              tileRow: tr,
              tileCol: tc,
              tile: TileType.INDESTRUCTIBLE_WALL,
            });
          }
          stamped += run.length;
        }
        return stamped;
      };

      stampWalls(BEACON_KEEP.walls) ||
        // Zero wall tiles survived the keep's zones (the documented
        // hostile-site class: vault boxes / macro crossings) — degrade to
        // the PORTAL PAIR so the beacon keeps its gate.
        stampWalls(PORTAL_PAIR);

      for (const [dx, dy] of BEACON_KEEP.props) {
        const tr = anchorRow + dy;
        const tc = anchorCol + dx;
        if (!paintable(tr, tc)) continue;
        sector.tiles[tr]![tc] = TileType.DESTRUCTIBLE_CRATE;
        stamps.push({
          sectorRow: row,
          sectorCol: col,
          tileRow: tr,
          tileCol: tc,
          tile: TileType.DESTRUCTIBLE_CRATE,
        });
      }
    }
  }
  return stamps;
}
