import { describe, expect, it } from 'vitest';

import { MapGenerator } from '../MapGenerator.js';
import { MapValidator } from '../MapValidator.js';
import {
  BEACON_KEEP,
  PORTAL_PAIR,
  SOUTH_APPROACH_AXIS,
  type PlazaWallSegment,
} from '../landmarkPlaza.js';
import { landmarkCompositionById } from '../landmarkRegistry.js';
import { TileType } from '../../enums/TileType.js';
import { buildCompositeGrid, isTraversable } from '../gridUtils.js';
import { SECTOR_TILE_SIZE } from '../constants.js';
import type { MapData, SectorData } from '../types.js';

/**
 * Beacon-keep suite (map-polish round-3 ticket 24; replaces the round-2
 * archetype-grammar suite of ticket 16).
 *
 * Owner verdict on the round-2 grammar (verbatim): "The beacon plaza
 * composition is a fucking mess. do not do this overlapping composition,
 * just do a nice structure with the beacon light and some walls protecting
 * it." The grammar is gone — there is now exactly ONE structure, the beacon
 * keep (see the `landmarkPlaza.ts` module doc for the ASCII sketch):
 *
 * Layer 1 — STRUCTURE DATA (pure): the keep is what it says it is — three
 * straight runs on the Chebyshev-2 ring (∩-shaped partial enclosure: W/E
 * 5-tile side runs + the 3-tile N bar behind the beacon), L-corner joins
 * owned by exactly one run each, no 2×2 clumps / checkerboard / dangling
 * (the runs are 1-tile-thick ring lines), the SOUTH approach axis unstamped
 * by any wall or prop, and exactly 2 symmetric props OUTSIDE the enclosure
 * at (±1,3) flanking the approach.
 *
 * Layer 2 — ZERO-RNG DETERMINISM: same seed ⇒ byte-identical stamps (one
 * authored layout, no variant draw — the ≤3-variant allowance of the ticket
 * is deliberately untaken).
 *
 * Layer 3 — GENERATED GEOMETRY (the golden seed set {1, 42, 999,
 * 0xdeadbeef}): every stamped tile is attributable to the authored keep (or
 * the documented PORTAL PAIR fallback) — the stamp NEVER invents geometry;
 * the walkway/axis/core invariants hold; clipped runs stay stub-free; the
 * full validator gate set passes.
 *
 * Documented conflict-clip class: a run whose tiles hit non-EMPTY (skeleton
 * walls, vault crate carpets), corridor or border tiles clips to its longest
 * paintable ≥2-tile stretch — the degraded keep reads as a ruin breach (the
 * paint-gate NEVER overwrites authored geometry). The anchor walkway
 * assertions are STAMP-RELATIVE: a handful of heroes sit against
 * PRE-EXISTING skeleton walls (present before the keep; the paint-gate
 * cannot remove them) — the assertions require the stamp never WORSENS a
 * walkway tile, never places a wall in the 3×3 core, and keeps ≥2 real walls
 * framing every anchor (measured on the golden seeds: minimum 2 walls —
 * seed 42's (2,0) coin-fountain site, a single clipped pier; typical sites
 * stamp 5–12 of the keep's 13 walls).
 */

/** The golden-suite seed set — same seeds the whole-MapData fixtures pin. */
const GOLDEN_SEEDS: readonly number[] = [1, 42, 999, 0xdeadbeef];

const cheb = (dx: number, dy: number): number => Math.max(Math.abs(dx), Math.abs(dy));

/** A run is one orthogonally-connected line (BFS over orthogonal steps). */
function isOrthogonallyContiguous(segment: PlazaWallSegment): boolean {
  const tiles = segment.tiles;
  if (tiles.length < 2) return false;
  const key = (t: readonly [number, number]) => `${t[0]},${t[1]}`;
  const set = new Set(tiles.map(key));
  const visited = new Set([key(tiles[0]!)]);
  const queue = [tiles[0]!];
  while (queue.length > 0) {
    const [dx, dy] = queue.shift()!;
    for (const [nx, ny] of [
      [dx + 1, dy],
      [dx - 1, dy],
      [dx, dy + 1],
      [dx, dy - 1],
    ] as const) {
      const k = `${nx},${ny}`;
      if (set.has(k) && !visited.has(k)) {
        visited.add(k);
        queue.push([nx, ny]);
      }
    }
  }
  return visited.size === tiles.length;
}

const ALL_AUTHORED_WALLS: ReadonlyArray<readonly [number, number]> = [
  ...BEACON_KEEP.walls.flatMap((w) => w.tiles),
  ...PORTAL_PAIR.flatMap((w) => w.tiles),
];

describe('Beacon keep structure data (authored contract, pure)', () => {
  it('is exactly three straight runs: W/E 5-tile side runs + the 3-tile N bar behind the beacon', () => {
    expect(BEACON_KEEP.walls.length).toBe(3);
    const [west, north, east] = BEACON_KEEP.walls as [
      PlazaWallSegment,
      PlazaWallSegment,
      PlazaWallSegment,
    ];
    // Straight vertical side runs at cols ±2 spanning ring rows -2..2.
    expect(west.tiles).toEqual([
      [-2, -2],
      [-2, -1],
      [-2, 0],
      [-2, 1],
      [-2, 2],
    ]);
    expect(east.tiles).toEqual([
      [2, -2],
      [2, -1],
      [2, 0],
      [2, 1],
      [2, 2],
    ]);
    // Straight horizontal bar between the corner tiles (never overlapping
    // them) — the wall protecting the beacon from behind.
    expect(north.tiles).toEqual([
      [-1, -2],
      [0, -2],
      [1, -2],
    ]);
    for (const run of BEACON_KEEP.walls) {
      expect(run.tiles.length).toBeGreaterThanOrEqual(2);
      expect(isOrthogonallyContiguous(run)).toBe(true);
    }
  });

  it('encodes clean art-aware L-corners: each corner tile is owned by exactly ONE run', () => {
    // The autotiler stamps a wall_corner where the N bar meets the side
    // runs; a corner tile present in TWO runs would double-draw the face.
    for (const corner of [
      [-2, -2],
      [2, -2],
    ] as const) {
      const owners = BEACON_KEEP.walls.filter((w) =>
        w.tiles.some(([dx, dy]) => dx === corner[0] && dy === corner[1]),
      );
      expect(owners.length).toBe(1);
      // The corner owner is the SIDE run (the N bar spans cols -1..1 only).
      expect(owners[0]!.tiles[0]![0]).toBe(corner[0]);
    }
  });

  it('every wall sits on the Chebyshev-2 ring — a 1-tile-thick enclosure with no 2×2 clump', () => {
    const walls = BEACON_KEEP.walls.flatMap((w) => w.tiles);
    expect(walls.length).toBe(13); // 5 + 3 + 5 — the whole keep
    for (const [dx, dy] of walls) {
      expect(cheb(dx, dy)).toBe(2);
    }
    // No FULL 2×2 solid block anywhere in the keep's footprint. (Round-4
    // landing fix: the original assertion banned ANY diagonal wall pair, but
    // the two authored L-corner joins — (-2,-1)+(-1,-2) and (1,-2)+(2,-1) —
    // ARE diagonal pairs by design: exactly the junctions the autotiler
    // stamps as wall_corner. A diagonal pair with its orthogonal cells open
    // is a legal L-junction; the actual ban is the full block, which would
    // break the sub-tile wall art contract.)
    const wallSet = new Set(walls.map(([dx, dy]) => `${dx},${dy}`));
    for (let r = -2; r <= 1; r++) {
      for (let c = -2; c <= 1; c++) {
        const block = [
          [r, c],
          [r + 1, c],
          [r, c + 1],
          [r + 1, c + 1],
        ].filter(([dr, dc]) => wallSet.has(`${dr},${dc}`)).length;
        expect(block, `2×2 window at (${r},${c}) is a solid block`).toBeLessThan(4);
      }
    }
  });

  it('the SOUTH approach axis is guaranteed open: no wall or prop of the structure stamps an axis tile', () => {
    expect(JSON.stringify(SOUTH_APPROACH_AXIS)).toBe(
      JSON.stringify([
        [0, 2],
        [0, 1],
        [0, 0],
      ]),
    );
    expect(BEACON_KEEP.approachAxis).toBe(SOUTH_APPROACH_AXIS);
    const axis = new Set(SOUTH_APPROACH_AXIS.map(([dx, dy]) => `${dx},${dy}`));
    for (const [dx, dy] of [...BEACON_KEEP.walls.flatMap((w) => w.tiles), ...BEACON_KEEP.props]) {
      expect(axis.has(`${dx},${dy}`), `structure tile on the approach axis (${dx},${dy})`).toBe(
        false,
      );
    }
  });

  it('props are minimal: exactly 2 symmetric crates OUTSIDE the enclosure, flanking the south approach', () => {
    expect(BEACON_KEEP.props).toEqual([
      [-1, 3],
      [1, 3],
    ]);
    for (const [dx, dy] of BEACON_KEEP.props) {
      // Outside the enclosure: beyond the wall ring (Chebyshev 3) and south
      // of it — the gate-brazier flank read, never court furniture.
      expect(cheb(dx, dy)).toBe(3);
      expect(dy).toBeGreaterThan(2);
      // The mirror partner is present — pairs only, never a lone prop.
      expect(BEACON_KEEP.props.some(([mx, my]) => mx === -dx && my === dy)).toBe(true);
    }
  });

  it('the PORTAL PAIR fallback is the twin gate-pier runs — ring-only, straight, axis-clean', () => {
    expect(PORTAL_PAIR.length).toBe(2);
    for (const run of PORTAL_PAIR) {
      expect(run.tiles.length).toBe(3);
      expect(isOrthogonallyContiguous(run)).toBe(true);
      for (const [dx, dy] of run.tiles) {
        expect(cheb(dx, dy)).toBe(2);
      }
    }
    // Piers flank the south approach axis (cols ±2, rows 0..2).
    expect(PORTAL_PAIR[0]!.tiles.map(([dx, dy]) => [dx, dy])).toEqual([
      [-2, 0],
      [-2, 1],
      [-2, 2],
    ]);
    expect(PORTAL_PAIR[1]!.tiles.map(([dx, dy]) => [dx, dy])).toEqual([
      [2, 0],
      [2, 1],
      [2, 2],
    ]);
  });
});

describe('Beacon keep determinism (zero RNG — ADR 0035)', () => {
  it('same seed ⇒ byte-identical stamps from fresh generator instances', () => {
    const a = new MapGenerator();
    const b = new MapGenerator();
    a.generate(777);
    b.generate(777);
    expect(b.getLastPlazaStamps()).toEqual(a.getLastPlazaStamps());
  });
});

describe('Beacon keep real geometry on the golden seeds (map-polish ticket 24)', () => {
  it('every stamped tile is attributable to the authored keep or the portal fallback — no invented geometry', () => {
    const authored = new Set(ALL_AUTHORED_WALLS.map(([dx, dy]) => `${dx},${dy}`));
    const authoredProps = new Set(BEACON_KEEP.props.map(([dx, dy]) => `${dx},${dy}`));
    for (const seed of GOLDEN_SEEDS) {
      const gen = new MapGenerator();
      const map = gen.generate(seed);
      for (const stamp of gen.getLastPlazaStamps()) {
        const hero = map.landmarks.heroes[stamp.sectorRow]![stamp.sectorCol]!;
        const dx = stamp.tileCol + stamp.sectorCol * SECTOR_TILE_SIZE - hero.tileX;
        const dy = stamp.tileRow + stamp.sectorRow * SECTOR_TILE_SIZE - hero.tileY;
        const set = stamp.tile === TileType.INDESTRUCTIBLE_WALL ? authored : authoredProps;
        expect(
          set.has(`${dx},${dy}`),
          `seed ${seed} stamp outside the authored keep (${dx},${dy})`,
        ).toBe(true);
      }
    }
  }, 20_000);

  it('every hero anchor is framed by ≥2 real walls in its zone (measured min: 2)', () => {
    for (const seed of GOLDEN_SEEDS) {
      const gen = new MapGenerator();
      const map = gen.generate(seed);
      const grid = buildCompositeGrid(map.sectors);
      for (const hero of map.landmarks.heroes.flat()) {
        let walls = 0;
        const radius = landmarkCompositionById(hero.compositionId)?.exclusionRadius ?? 2;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (grid[hero.tileY + dy]?.[hero.tileX + dx] === TileType.INDESTRUCTIBLE_WALL) walls++;
          }
        }
        // Measured on the golden seeds under the keep: min 2 (seed 42's
        // (2,0) site — a single clipped pier), typical 5–12 of the 13.
        expect(walls, `seed ${seed} ${hero.compositionId} framing walls`).toBeGreaterThanOrEqual(2);
      }
    }
  }, 20_000);

  it('guaranteed walkway + approach axis: anchor traversable and the stamp never touches the anchor, its cardinals, or the south axis', () => {
    for (const seed of GOLDEN_SEEDS) {
      const gen = new MapGenerator();
      const map = gen.generate(seed);
      const grid = buildCompositeGrid(map.sectors);
      // The walkway (anchor + cardinals) PLUS the approach-axis corridor
      // tile at (0, 2) — the aligned beacon walk-in.
      const WALKWAY: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [0, 2],
      ];
      for (const hero of map.landmarks.heroes.flat()) {
        expect(isTraversable(grid[hero.tileY]![hero.tileX]!), `seed ${seed} anchor`).toBe(true);
      }
      // Stamp-relative property: no keep stamp (wall OR prop) ever lands on
      // a walkway/axis tile of ANY hero (the authored keep is ring-only and
      // its props sit at (±1,3) — Chebyshev 3, off every axis tile by
      // construction), and every such tile that was traversable pre-keep
      // stays traversable (pre-existing skeleton walls on cardinals predate
      // the keep and are untouchable under the paint-gate).
      const stamps = gen.getLastPlazaStamps();
      for (const stamp of stamps) {
        const hero = map.landmarks.heroes[stamp.sectorRow]![stamp.sectorCol]!;
        const dx = stamp.tileCol + stamp.sectorCol * SECTOR_TILE_SIZE - hero.tileX;
        const dy = stamp.tileRow + stamp.sectorRow * SECTOR_TILE_SIZE - hero.tileY;
        const onWalkway = WALKWAY.some(([wx, wy]) => wx === dx && wy === dy);
        expect(onWalkway, `seed ${seed} stamp on walkway/axis (${dx},${dy})`).toBe(false);
      }
      // Pre-keep reconstruction: invert the stamps, then require every
      // walkway/axis tile unchanged (traversable stayed traversable, wall
      // stayed wall — the keep never modifies any walkway tile).
      const sectors: SectorData[][] = structuredClone(map.sectors);
      for (const stamp of stamps) {
        sectors[stamp.sectorRow]![stamp.sectorCol]!.tiles[stamp.tileRow]![stamp.tileCol] =
          TileType.EMPTY;
      }
      const pre = buildCompositeGrid(sectors);
      for (const hero of map.landmarks.heroes.flat()) {
        for (const [dx, dy] of WALKWAY) {
          const before = pre[hero.tileY + dy]![hero.tileX + dx]!;
          const after = grid[hero.tileY + dy]![hero.tileX + dx]!;
          expect(after, `seed ${seed} walkway tile changed (${dx},${dy})`).toBe(before);
          if (isTraversable(before)) {
            expect(isTraversable(after), `seed ${seed} walkway (${dx},${dy})`).toBe(true);
          }
        }
      }
    }
  }, 20_000);

  it('no keep wall in the 3×3 anchor core; the core is byte-unchanged by the stamp', () => {
    for (const seed of GOLDEN_SEEDS) {
      const gen = new MapGenerator();
      const map = gen.generate(seed);
      const stamps = gen.getLastPlazaStamps();
      for (const stamp of stamps) {
        if (stamp.tile !== TileType.INDESTRUCTIBLE_WALL) continue;
        const hero = map.landmarks.heroes[stamp.sectorRow]![stamp.sectorCol]!;
        const dx = stamp.tileCol + stamp.sectorCol * SECTOR_TILE_SIZE - hero.tileX;
        const dy = stamp.tileRow + stamp.sectorRow * SECTOR_TILE_SIZE - hero.tileY;
        expect(cheb(dx, dy), `seed ${seed} wall in anchor core`).toBeGreaterThanOrEqual(2);
      }
    }
  }, 20_000);

  it('conflict-clip keeps the stamped geometry stub-free: every stamped wall cluster is ≥2 contiguous tiles', () => {
    // The clip rule stamps the longest paintable ≥2-tile stretch of each
    // authored run — so the STAMPED walls per hero must form only clusters
    // of ≥2 orthogonally-contiguous tiles (never an isolated stub, never a
    // sub-2 segment, even after clipping).
    for (const seed of GOLDEN_SEEDS) {
      const gen = new MapGenerator();
      gen.generate(seed);
      const wallStamps = gen
        .getLastPlazaStamps()
        .filter((s) => s.tile === TileType.INDESTRUCTIBLE_WALL);
      const byHero = new Map<string, Array<[number, number]>>();
      for (const s of wallStamps) {
        const k = `${s.sectorRow},${s.sectorCol}`;
        const list = byHero.get(k) ?? [];
        list.push([s.tileRow, s.tileCol]);
        byHero.set(k, list);
      }
      for (const [heroKey, tiles] of byHero) {
        const key = (t: readonly [number, number]) => `${t[0]},${t[1]}`;
        const set = new Set(tiles.map(key));
        const visited = new Set<string>();
        for (const start of tiles) {
          if (visited.has(key(start))) continue;
          // BFS this stamp cluster.
          const cluster: number[] = [];
          const queue = [start];
          visited.add(key(start));
          while (queue.length > 0) {
            const [r, c] = queue.shift()!;
            cluster.push(1);
            for (const [nr, nc] of [
              [r + 1, c],
              [r - 1, c],
              [r, c + 1],
              [r, c - 1],
            ] as const) {
              const k2 = `${nr},${nc}`;
              if (set.has(k2) && !visited.has(k2)) {
                visited.add(k2);
                queue.push([nr, nc]);
              }
            }
          }
          expect(
            cluster.length,
            `seed ${seed} hero ${heroKey}: stamped wall stub (cluster of 1)`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }
  }, 20_000);

  it('all validator gates pass on the golden seeds (connectivity, open space, spawns, loot, stubs, landmarks, equity)', () => {
    const validator = new MapValidator();
    for (const seed of GOLDEN_SEEDS) {
      const map: MapData = new MapGenerator().generate(seed);
      const result = validator.validate(map);
      expect(result.errors, `seed ${seed}`).toEqual([]);
    }
  }, 20_000);
});
