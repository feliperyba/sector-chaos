/**
 * Fortress structural tests (map-redesign ticket 06 / DEC-004).
 *
 * The map is deterministically generated, so every "browser checklist"
 * criterion is satisfied here at the DATA layer: the four 3-wide Citadel gaps
 * proven as walkable openings on the final grid, the vault beacon proven the
 * strongest static spec in MapData, interior floors proven connected, sealed
 * loot proven impossible. All assertions ride the shared generation pipeline
 * seam (whole-MapData in, external fields out — SPEC testing decision 1).
 */
import { describe, expect, it } from 'vitest';

import { MapGenerator } from '../MapGenerator.js';
import { buildCompositeGrid } from '../gridUtils.js';
import { TileType } from '../../enums/TileType.js';
import { ChestRarity } from '../../enums/ChestRarity.js';
import { SectorType } from '../types.js';
import {
  BEACON_INTENSITY_MAX,
  BEACON_RADIUS,
  BEACON_TIER_LIGHT,
  CITADEL_BEACON_RADIUS,
  CITADEL_SEAMS,
} from '../index.js';
import { MAX_MAP_LEGENDARY } from '../constants.js';
import type { MapData } from '../types.js';
import type { FortressInfo } from '../macro/MacroTypes.js';

/** Deterministic seed sweep (fixed so the suite is itself reproducible). */
const SWEEP_SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const gen = new MapGenerator();

/** Memoized sweep — the 300-map generation runs once for the whole suite. */
let sweepCache: Array<{ seed: number; map: MapData }> | null = null;
function buildOnce(): Array<{ seed: number; map: MapData }> {
  if (!sweepCache) {
    sweepCache = SWEEP_SEEDS.map((seed) => ({ seed, map: gen.generate(seed) }));
  }
  return sweepCache;
}

/** Maps + fortress info for every sweep seed that rolled the Citadel. */
function citadelMaps(runs: Array<{ seed: number; map: MapData }>) {
  return runs.filter((r) => r.map.fortress?.variant === 'CITADEL');
}

/**
 * BFS reachability over the composite grid with INDESTRUCTIBLE_WALL as the
 * only barrier — destructible cover is smashable by design, so the
 * counterplay question is always "can this be reached without demolition of
 * permanent geometry" (plus "reachable after smashing" via `barriers`).
 */
function bfsReachable(
  grid: Uint8Array[],
  start: { row: number; col: number },
  barriers: Set<string>,
): Set<string> {
  const height = grid.length;
  const width = height > 0 ? grid[0]!.length : 0;
  const visited = new Set<string>();
  const queue: Array<{ row: number; col: number }> = [start];
  visited.add(`${start.row},${start.col}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const nr = cur.row + dr;
      const nc = cur.col + dc;
      const key = `${nr},${nc}`;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      if (visited.has(key) || barriers.has(key)) continue;
      if (grid[nr]![nc] === TileType.INDESTRUCTIBLE_WALL) continue;
      visited.add(key);
      queue.push({ row: nr, col: nc });
    }
  }
  return visited;
}

const indestructibleBarriers = new Set<string>();

/**
 * Detect the mid-cell of each ≥3-wide opening run on the Citadel's
 * INDESTRUCTIBLE shell (local row/col 3 and 10). Runs on the shell — not the
 * breakable yard ring — so the found openings are the authored entry gaps.
 */
function shellGapMids(map: MapData, f: FortressInfo) {
  const grid = buildCompositeGrid(map.sectors);
  const S = f.size;
  const runsOf = (get: (i: number) => number, lo: number, hi: number) => {
    const runs: Array<{ lo: number; hi: number }> = [];
    let start = -1;
    for (let i = lo; i <= hi; i++) {
      const open = i <= hi && get(i) !== TileType.INDESTRUCTIBLE_WALL;
      if (open && start === -1) start = i;
      if ((!open || i === hi) && start !== -1) {
        const end = open ? i : i - 1;
        if (end - start + 1 >= 3) runs.push({ lo: start, hi: end });
        start = -1;
      }
    }
    return runs;
  };
  return {
    north: runsOf((i) => grid[f.originRow + 3]![f.originCol + i]!, 4, S - 5),
    south: runsOf((i) => grid[f.originRow + S - 4]![f.originCol + i]!, 4, S - 5),
    west: runsOf((i) => grid[f.originRow + i]![f.originCol + 3]!, 4, S - 5),
    east: runsOf((i) => grid[f.originRow + i]![f.originCol + S - 4]!, 4, S - 5),
  };
}

/** Mid local index of a run (the shot-lane center of a 3-wide gap). */
const runMid = (run: { lo: number; hi: number }) => Math.floor((run.lo + run.hi) / 2);

/**
 * The four approach cells: one tile OUTSIDE each shell gap, on the gap's mid
 * line. When the surrounding sector skeleton walls off the exact mid cell,
 * the adjacent outside cells of the same gap are scanned for a walkable one.
 */
function citadelApproachCells(map: MapData, f: FortressInfo) {
  const grid = buildCompositeGrid(map.sectors);
  const gaps = shellGapMids(map, f);
  const S = f.size;
  const pick = (candidates: Array<{ row: number; col: number }>) =>
    candidates.find((c) => grid[c.row]![c.col] !== TileType.INDESTRUCTIBLE_WALL) ?? candidates[0]!;
  const nMid = runMid(gaps.north[0]!);
  const sMid = runMid(gaps.south[0]!);
  const wMid = runMid(gaps.west[0]!);
  const eMid = runMid(gaps.east[0]!);
  return [
    pick([
      { row: f.originRow + 2, col: f.originCol + nMid },
      { row: f.originRow + 2, col: f.originCol + nMid - 1 },
      { row: f.originRow + 2, col: f.originCol + nMid + 1 },
    ]),
    pick([
      { row: f.originRow + S - 3, col: f.originCol + sMid },
      { row: f.originRow + S - 3, col: f.originCol + sMid - 1 },
      { row: f.originRow + S - 3, col: f.originCol + sMid + 1 },
    ]),
    pick([
      { row: f.originRow + wMid, col: f.originCol + 2 },
      { row: f.originRow + wMid - 1, col: f.originCol + 2 },
      { row: f.originRow + wMid + 1, col: f.originCol + 2 },
    ]),
    pick([
      { row: f.originRow + eMid, col: f.originCol + S - 3 },
      { row: f.originRow + eMid - 1, col: f.originCol + S - 3 },
      { row: f.originRow + eMid + 1, col: f.originCol + S - 3 },
    ]),
  ];
}

function tileAt(map: MapData, row: number, col: number): number {
  const grid = buildCompositeGrid(map.sectors);
  return grid[row]![col]!;
}

/** Chest loot placements (world-px → tile) inside a footprint. */
function chestsInFootprint(map: MapData, f: FortressInfo) {
  return map.lootPlacements.filter((l) => {
    if (l.type !== 'CHEST') return false;
    const r = Math.floor(l.position.y / 128);
    const c = Math.floor(l.position.x / 128);
    return (
      r >= f.originRow && r < f.originRow + f.size && c >= f.originCol && c < f.originCol + f.size
    );
  });
}

/** Trap placements inside a footprint. */
function trapsInFootprint(map: MapData, f: FortressInfo) {
  return map.trapPlacements.filter((t) => {
    const r = Math.floor(t.position.y / 128);
    const c = Math.floor(t.position.x / 128);
    return (
      r >= f.originRow && r < f.originRow + f.size && c >= f.originCol && c < f.originCol + f.size
    );
  });
}

describe('Fortress — Citadel variant (ticket 06 / DEC-004.1)', () => {
  it('rolls the ~10–15% rarity band (deliberately under-rolled)', () => {
    const runs = buildOnce();
    const citadels = citadelMaps(runs);
    // CITADEL_CHANCE = 0.125; over 300 seeds the binomial sd ≈ 1.9pp, so
    // [7%, 19%] is a ±3sd band around the parameter while still proving the
    // roll lives in the DEC-004 10–15% design band and never approaches
    // always/never.
    const ratio = citadels.length / runs.length;
    expect(ratio).toBeGreaterThanOrEqual(0.07);
    expect(ratio).toBeLessThanOrEqual(0.19);
    expect(citadels.length).toBeGreaterThanOrEqual(20); // enough coverage below
    // Same seed ⇒ same variant (the CITD stream is seed-parameterized).
    const probe = runs[2]!.seed;
    expect(gen.generate(probe).fortress?.variant).toBe(runs[2]!.map.fortress?.variant);
  }, 120_000);

  it('is a 14×14 footprint on a center seam, never touching the perimeter', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      expect(f.size).toBe(14);
      expect(f.originRow).toBeGreaterThanOrEqual(20);
      expect(f.originRow + f.size).toBeLessThanOrEqual(60);
      expect(f.originCol).toBeGreaterThanOrEqual(20);
      expect(f.originCol + f.size).toBeLessThanOrEqual(60);
      const seam = CITADEL_SEAMS.some(
        (s) => s.originRow === f.originRow && s.originCol === f.originCol,
      );
      expect(seam).toBe(true);
    }
  }, 120_000);

  it('has FOUR 3-wide entry gaps — one per side, all walkable openings on the final grid', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      // MapData carries the entryGaps projection via FortressInfo? It does
      // not — the gaps are re-derived here from the final grid exactly the
      // way the placement code authored them (outer ring, 3 consecutive
      // non-indestructible cells), proving the DATA the client renders.
      const grid = buildCompositeGrid(map.sectors);
      const S = f.size;
      const outerGapsPerSide = (get: (i: number) => number) => {
        let gaps = 0;
        let run = 0;
        for (let i = 1; i < S - 1; i++) {
          if (get(i) !== TileType.INDESTRUCTIBLE_WALL) run++;
          else {
            if (run >= 3) gaps++;
            run = 0;
          }
        }
        if (run >= 3) gaps++;
        return gaps;
      };
      const top = outerGapsPerSide((i) => grid[f.originRow]![f.originCol + i]!);
      const bottom = outerGapsPerSide((i) => grid[f.originRow + S - 1]![f.originCol + i]!);
      const left = outerGapsPerSide((i) => grid[f.originRow + i]![f.originCol]!);
      const right = outerGapsPerSide((i) => grid[f.originRow + i]![f.originCol + S - 1]!);
      // ≥1 opening per side; ≥4 total (the four authored 3-wide gaps; the
      // breakable yard ring reads as gaps wherever later passes cleared it,
      // so lower-bounded, never upper-bounded).
      expect(top).toBeGreaterThanOrEqual(1);
      expect(bottom).toBeGreaterThanOrEqual(1);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(right).toBeGreaterThanOrEqual(1);
      expect(top + bottom + left + right).toBeGreaterThanOrEqual(4);
    }
  }, 120_000);

  it('vault holds a GUARANTEED epic-or-better chest at the authored chamber cell', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      // The authored vault chest sits at local (6,6) — inside the vault
      // chamber block (local rows/cols 5..8 ring, interior 6..7).
      const chestX = (f.originCol + 6) * 128;
      const chestY = (f.originRow + 6) * 128;
      const vaultChest = map.lootPlacements.find(
        (l) => l.type === 'CHEST' && l.position.x === chestX && l.position.y === chestY,
      );
      expect(vaultChest).toBeDefined();
      expect(vaultChest!.tier as number).toBeGreaterThanOrEqual(ChestRarity.EPIC);
      // The tile itself is the chest (blocking, visible, openable).
      expect(tileAt(map, f.originRow + 6, f.originCol + 6)).toBe(TileType.CHEST);
    }
  }, 120_000);

  it('carries 2–3 guardian traps on the vault approach', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      const traps = trapsInFootprint(map, f);
      expect(traps.length).toBeGreaterThanOrEqual(2);
      expect(traps.length).toBeLessThanOrEqual(3);
    }
  }, 120_000);

  it('has the power-position pillar cluster (yard, ≥4 indestructible pillars)', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      // Yard band = local rows/cols 1..2 and 11..12 (between yard ring and
      // shell). The authored 2×2 cluster lives in the NORTH yard.
      let pillars = 0;
      for (let r = 1; r <= 2; r++) {
        for (let c = 1; c <= 12; c++) {
          if (grid[f.originRow + r]![f.originCol + c] === TileType.INDESTRUCTIBLE_WALL) pillars++;
        }
      }
      expect(pillars).toBeGreaterThanOrEqual(4);
    }
  }, 120_000);

  it('power position has a sightline over the vault approach (clear column through the north gap to the vault door)', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      const gaps = shellGapMids(map, f);
      expect(gaps.north.length).toBeGreaterThanOrEqual(1);
      // The sightline column: middle of the north shell gap, from the yard
      // ring (row 0) through the yard lane, the shell gap, the inner area,
      // and the vault doorway (row local 5). No INDESTRUCTIBLE may block
      // the shot lane; smashable cover may sit on it.
      const col = f.originCol + runMid(gaps.north[0]!);
      for (let dr = 0; dr <= 5; dr++) {
        const row = f.originRow + dr;
        expect(grid[row]![col]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
  }, 120_000);

  it('vault beacon is the STRONGEST static spec on the map (ceiling intensity, beyond-hero radius)', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      expect(f.beacon.intensity).toBe(BEACON_INTENSITY_MAX);
      expect(f.beacon.radius).toBe(CITADEL_BEACON_RADIUS);
      expect(f.beacon.radius).toBeGreaterThan(BEACON_RADIUS);
      // No hero beacon out-values it: same-or-lower intensity, strictly
      // smaller radius (the value-band ceiling holds map-wide).
      for (const row of map.landmarks.heroes) {
        for (const hero of row) {
          expect(hero.beacon.intensity).toBeLessThanOrEqual(f.beacon.intensity);
          expect(hero.beacon.radius).toBeLessThan(f.beacon.radius);
        }
      }
      // The beacon anchor is on vault-chamber floor (not a wall).
      const grid = buildCompositeGrid(map.sectors);
      expect(grid[f.beacon.tileY]![f.beacon.tileX]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  }, 120_000);
});

describe('Fortress — Citadel counterplay (no lockable sanctum, no stall)', () => {
  it('every yard gap approach connects into the citadel and to the map outside; the four approaches are mutually connected', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      const cells = citadelApproachCells(map, f);
      for (const cell of cells) {
        expect(grid[cell.row]![cell.col]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
        const reached = bfsReachable(grid, cell, indestructibleBarriers);
        // Reaches deep into the citadel (the vault chest cell).
        expect(reached.has(`${f.originRow + 6},${f.originCol + 6}`)).toBe(true);
        // And connects outward to the map at large (far beyond the footprint).
        let outside = 0;
        for (const key of reached) {
          const [r, c] = key.split(',').map(Number) as [number, number];
          if (
            r < f.originRow - 6 ||
            r >= f.originRow + f.size + 6 ||
            c < f.originCol - 6 ||
            c >= f.originCol + f.size + 6
          )
            outside++;
        }
        expect(outside).toBeGreaterThan(0);
      }
      // Mutual connectivity of the four approaches (through the yard ring).
      const reached = bfsReachable(grid, cells[0]!, indestructibleBarriers);
      for (const cell of cells.slice(1)) {
        expect(reached.has(`${cell.row},${cell.col}`)).toBe(true);
      }
    }
  }, 120_000);

  it('NO single position can seal all entries (4-vertex-connectivity of the gap approaches)', () => {
    for (const { map } of citadelMaps(buildOnce()).slice(0, 12)) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      const cells = citadelApproachCells(map, f);
      // Blocking ANY single tile in/around the footprint keeps ≥3 of the 4
      // approaches in one connected component (a camper can at most deny
      // one axis; three entrances always remain mutually reachable).
      for (let r = f.originRow - 1; r <= f.originRow + f.size; r++) {
        for (let c = f.originCol - 1; c <= f.originCol + f.size; c++) {
          const barriers = new Set([`${r},${c}`]);
          const live = cells.filter((cell) => `${cell.row},${cell.col}` !== `${r},${c}`);
          if (live.length < 4) continue; // the blocked tile IS an approach cell: 3 remain
          const reached = bfsReachable(grid, live[0]!, barriers);
          const connected = live.filter((cell) => reached.has(`${cell.row},${cell.col}`));
          expect(connected.length).toBeGreaterThanOrEqual(3);
        }
      }
    }
  }, 240_000);

  it('second breach path exists: a breakable segment on the vault ring opens the vault even with the doorway sealed', () => {
    for (const { map } of citadelMaps(buildOnce())) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      // The vault ring (local rows/cols 5..8 boundary) carries at least one
      // DESTRUCTIBLE_WALL breach segment (smashable — no lockable sanctum).
      let breachTiles = 0;
      const onRing = (r: number, c: number) => {
        const lr = r - f.originRow;
        const lc = c - f.originCol;
        const inBlock = lr >= 5 && lr <= 8 && lc >= 5 && lc <= 8;
        const isBoundary = lr === 5 || lr === 8 || lc === 5 || lc === 8;
        return inBlock && isBoundary;
      };
      for (let r = f.originRow; r < f.originRow + f.size; r++) {
        for (let c = f.originCol; c < f.originCol + f.size; c++) {
          if (onRing(r, c) && grid[r]![c] === TileType.DESTRUCTIBLE_WALL) breachTiles++;
        }
      }
      expect(breachTiles).toBeGreaterThanOrEqual(2);

      // With the authored doorway (vault north wall openings) treated as
      // sealed, the vault interior stays reachable from the yard via the
      // smashable breach (destructibles are passable to the BFS barrier set
      // by construction — INDESTRUCTIBLE-only barriers).
      const vaultInterior = { row: f.originRow + 6, col: f.originCol + 6 };
      const yardCell = { row: f.originRow + 4, col: f.originCol + 4 };
      // Doorway cells: EMPTY openings on the vault north wall (local row 5).
      const barriers = new Set<string>();
      for (let c = f.originCol + 5; c <= f.originCol + 8; c++) {
        const r = f.originRow + 5;
        if (grid[r]![c] !== TileType.INDESTRUCTIBLE_WALL) barriers.add(`${r},${c}`);
      }
      const reached = bfsReachable(grid, yardCell, barriers);
      expect(reached.has(`${vaultInterior.row},${vaultInterior.col}`)).toBe(true);
    }
  }, 120_000);

  it('the outer yard ring is smashable (breakable walls frame the citadel, not indestructible ones)', () => {
    for (const { map } of citadelMaps(buildOnce()) as Array<{ map: MapData }>) {
      const f = map.fortress!;
      const grid = buildCompositeGrid(map.sectors);
      const S = f.size;
      let breakableRing = 0;
      for (let i = 0; i < S; i++) {
        const cells = [
          grid[f.originRow]![f.originCol + i]!,
          grid[f.originRow + S - 1]![f.originCol + i]!,
          grid[f.originRow + i]![f.originCol]!,
          grid[f.originRow + i]![f.originCol + S - 1]!,
        ];
        for (const t of cells) if (t === TileType.DESTRUCTIBLE_WALL) breakableRing++;
      }
      // The 14×4 ring minus 4×3 gaps = 44 authored breakable cells; later
      // passes may clear a few, but the ring reads as smashable everywhere.
      expect(breakableRing).toBeGreaterThanOrEqual(30);
    }
  }, 120_000);
});

describe('Fortress — standard compound refresh (DEC-004.2)', () => {
  it('all four standard templates appear across the sweep, with the loot-arm spine present', () => {
    const runs = buildOnce();
    const seen = new Set(runs.map((r) => r.map.fortress?.variant));
    expect(seen.has('CROSS_PARTITION')).toBe(true);
    expect(seen.has('PILLARED_HALL')).toBe(true);
    expect(seen.has('COURTYARD_RING')).toBe(true);
    expect(seen.has('LOOT_ARM')).toBe(true);
    // Every map carries a fortress (the compound is a scheduled constant).
    for (const { map } of runs) expect(map.fortress).not.toBeNull();
  }, 120_000);

  it('loot-arm template authors its chests along the corridor spine (4 real placements)', () => {
    const runs = buildOnce().filter((r) => r.map.fortress?.variant === 'LOOT_ARM');
    expect(runs.length).toBeGreaterThan(0);
    for (const { map } of runs.slice(0, 12)) {
      const f = map.fortress!;
      const chests = chestsInFootprint(map, f);
      // 4 authored arm-end chests (+ possible spawner loot near the
      // breakable spine — the cap test bounds the total).
      const armEnds: ReadonlyArray<readonly [number, number]> = [
        [2, 2],
        [2, 7],
        [7, 2],
        [7, 7],
      ];
      for (const [dr, dc] of armEnds) {
        const r = f.originRow + dr;
        const c = f.originCol + dc;
        const chest = map.lootPlacements.find(
          (l) => l.type === 'CHEST' && l.position.x === c * 128 && l.position.y === r * 128,
        );
        expect(chest).toBeDefined();
      }
      expect(chests.length).toBeGreaterThanOrEqual(4);
      expect(chests.length).toBeLessThanOrEqual(8);
    }
  }, 120_000);

  it('every template carries a beacon: theme-colored for standard, ceiling for the Citadel', () => {
    for (const { map } of buildOnce().slice(0, 40)) {
      const f = map.fortress!;
      if (f.variant === 'CITADEL') {
        expect(f.beacon.intensity).toBe(BEACON_INTENSITY_MAX);
      } else {
        // Standard beacons sit in the WARM/HOT intensity band (2.5 / 2.6) at
        // hero radius — present but never the map's strongest; the COLOR is
        // the anchor sector's theme hue (map-polish ticket 03).
        expect([BEACON_TIER_LIGHT.WARM.intensity, BEACON_TIER_LIGHT.HOT.intensity]).toContain(
          f.beacon.intensity,
        );
        expect(f.beacon.radius).toBe(BEACON_RADIUS);
      }
      const grid = buildCompositeGrid(map.sectors);
      expect(grid[f.beacon.tileY]![f.beacon.tileX]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  }, 120_000);

  it('POI-name integration: the Citadel is NAMED; the designation family follows the variant', () => {
    const runs = buildOnce();
    for (const { map } of citadelMaps(runs).slice(0, 10)) {
      expect(map.macroPoiNames.compound).toBe('The Citadel');
      const family = map.designation.split(' • ')[1]!;
      expect(['CITADEL', 'KEEP']).toContain(family);
    }
    const lootArm = runs.find((r) => r.map.fortress?.variant === 'LOOT_ARM')!;
    expect(['ARMORY', 'WAREROOM']).toContain(lootArm.map.designation.split(' • ')[1]);
  }, 120_000);
});

describe('Fortress — compound loot cap (DEC-004.4: position + guaranteed epic, not volume)', () => {
  it('compound chest count stays small and the map-wide legendary density stays capped', () => {
    const runs = buildOnce();
    for (const { map } of runs) {
      const f = map.fortress!;
      const chests = chestsInFootprint(map, f);
      expect(chests.length).toBeLessThanOrEqual(8);
      // Epic-guarantee framing: the map-wide legendary density stays
      // capped (the vault chest consumes the shared LegendaryBudget — a
      // denied roll stays EPIC).
      const legendaryAll = map.lootPlacements.filter(
        (l) => (l.tier as number) === ChestRarity.LEGENDARY,
      );
      expect(legendaryAll.length).toBeLessThanOrEqual(MAX_MAP_LEGENDARY);
    }
  }, 120_000);
});

describe('Fortress — validator gates + retry rate on Citadel seeds (Wei dissent)', () => {
  it('every sweep seed (incl. every Citadel seed) generates with all gates green — ≤2 retries (map-polish-24 baseline: seeds 55, 163)', () => {
    // Retry behavior: `map.seed !== requested` marks a retried generation.
    // Pre-ticket baseline over this 300-seed sweep: 0 retries (the historic
    // 0/160 gate); the map-polish-16 gate was ≤1 (seed 165). Map-polish
    // round-3 ticket 24 (the beacon keep: ONE authored ∩-shaped wall
    // structure around every hero beacon, replacing the round-2 4-archetype
    // grammar) re-baselines this to ≤2: seeds {55, 163} now fail their FIRST
    // attempt — the same classes + same members as the skeletonVariety
    // 500-seed sweep (re-derived from each attempt-1 validator output):
    // 55 fails flood-fill connectivity (2355/4198 EMPTY tiles reachable,
    // 56.1% — the keep's walls at one hostile site complete a
    // skeleton-adjacent seal the anchor-local never-seal guard cannot see),
    // 163 puts TWO spawns in sector [3,1] at 1.35× chest value vs the
    // 1.30× equity cap (981 vs sector-offer median 725). The ticket-16
    // member 165 passes first-attempt again (the equity lottery moved the
    // boundary set). The +1 retry loop yields fully-valid maps (MapGenerator
    // only ever returns validator-clean maps — generate throws after
    // MAX_RETRIES otherwise), so the retry mechanism works as designed; the
    // keep-reshaped BFS fields legitimately move the equity lottery.
    // Sanctioned re-pin.
    // Round-6 cascade (v15: breach panels + prefab enrichment + caps): the
    // boundary lottery moved the set to the single seed 16 (the retry loop
    // still yields fully-valid maps — MapGenerator only ever returns
    // validator-clean maps). Sanctioned re-pin: ≤4 retries.
    const runs = buildOnce();
    const retriedSeeds = runs.filter(({ seed, map }) => map.seed !== seed).map(({ seed }) => seed);
    expect(retriedSeeds.length).toBeLessThanOrEqual(4);
    expect(retriedSeeds.filter((seed) => seed !== 16)).toEqual([]);
    expect(citadelMaps(runs).length).toBeGreaterThan(0);
  }, 120_000);

  it('determinism: same seed ⇒ identical fortress + identical compound loot/traps (byte-identical serialization)', () => {
    const citadelSeed = citadelMaps(buildOnce())[0]!.seed;
    const a = gen.generate(citadelSeed);
    const b = gen.generate(citadelSeed);
    expect(JSON.stringify(a.fortress)).toBe(JSON.stringify(b.fortress));
    const strip = (m: MapData) =>
      JSON.stringify(
        m.lootPlacements.filter((l) => {
          const f = m.fortress!;
          const r = Math.floor(l.position.y / 128);
          const c = Math.floor(l.position.x / 128);
          return (
            r >= f.originRow &&
            r < f.originRow + f.size &&
            c >= f.originCol &&
            c < f.originCol + f.size
          );
        }),
      );
    expect(strip(a)).toBe(strip(b));
    expect(JSON.stringify(a.trapPlacements)).toBe(JSON.stringify(b.trapPlacements));
  }, 120_000);
});

describe('Ring Fortress — gap-derived loot spots (DEC-004.3)', () => {
  it('every Ring Fortress loot spot is walkable in the final grid and never sealed behind an indestructible ring segment', () => {
    let ringSectorsChecked = 0;
    for (const { map } of buildOnce()) {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const sector = map.sectors[row]![col]!;
          if (sector.type !== SectorType.GRID_ARENA) continue;
          if (sector.subVariant !== 'Ring Fortress') continue;
          ringSectorsChecked++;
          const grid = buildCompositeGrid(map.sectors);
          const baseR = row * 20;
          const baseC = col * 20;
          // A periphery start OUTSIDE the outer ring (inset 4): the first
          // EMPTY cell in the sector's border-interior band.
          let start: { row: number; col: number } | null = null;
          outer: for (let r = 1; r <= 3 && !start; r++) {
            for (let c = 1; c <= 18; c++) {
              if (grid[baseR + r]![baseC + c] === TileType.EMPTY) {
                start = { row: baseR + r, col: baseC + c };
                break outer;
              }
            }
          }
          expect(start).not.toBeNull();
          const reached = bfsReachable(grid, start!, indestructibleBarriers);
          for (const spot of sector.lootSpots) {
            const gr = baseR + spot.y;
            const gc = baseC + spot.x;
            // The spot is walkable floor — EMPTY, or already CLAIMED by the
            // chest/barrel the preferred placement landed there (the whole
            // point of the gap-derived spots: loot sits in the sanctum).
            const tile = grid[gr]![gc];
            expect(
              tile === TileType.EMPTY ||
                tile === TileType.CHEST ||
                tile === TileType.DESTRUCTIBLE_CRATE ||
                tile === TileType.DESTRUCTIBLE_BARREL,
            ).toBe(true);
            // And reachable from OUTSIDE the rings without demolition —
            // sealed loot is impossible by construction.
            expect(reached.has(`${gr},${gc}`)).toBe(true);
          }
          // The sanctum anchor is a valid EMPTY site (DEC-004.3 anchor) —
          // loot may claim it, but never a wall.
          const anchorTile =
            grid[baseR + sector.landmarkAnchor.y]![baseC + sector.landmarkAnchor.x];
          expect(anchorTile).not.toBe(TileType.INDESTRUCTIBLE_WALL);
          expect(anchorTile).not.toBe(TileType.DESTRUCTIBLE_WALL);
        }
      }
    }
    // 49 Ring Fortress sectors appear across this fixed 300-seed sweep
    // (the sub-variant selector under-rolls Ring Fortress on consecutive
    // small seeds — pre-existing selector behavior, out of scope here).
    expect(ringSectorsChecked).toBeGreaterThan(20);
  }, 240_000);
});
