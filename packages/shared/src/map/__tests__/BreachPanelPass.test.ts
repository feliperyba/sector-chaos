/**
 * Breach-panel unit tests (map-polish round 6): the material pass pinned
 * against hand-built 4×4 sector grids so a sweep failure means a REGRESSION,
 * not a broken rule. Assertions use GLOBAL composite coordinates
 * (sector-local + sector offset): sector (1,1) occupies global rows/cols
 * 20..39.
 */

import { describe, expect, it } from 'vitest';
import { TileType } from '../../enums/TileType.js';
import { SectorType, type SectorData } from '../types.js';
import type { SectorSubVariant } from '../sectors/subVariants.js';
import { BreachPanelPass } from '../refinement/BreachPanelPass.js';

function makeSector(): SectorData {
  const tiles = Array.from({ length: 20 }, () => new Uint8Array(20).fill(TileType.EMPTY));
  for (let i = 0; i < 20; i++) {
    tiles[0]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[19]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![0] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![19] = TileType.INDESTRUCTIBLE_WALL;
  }
  return {
    type: SectorType.GRID_ARENA,
    subVariant: 'Classic Lattice' as SectorSubVariant,
    tiles,
    elevation: null,
    lootSpots: [],
    landmarkAnchor: { x: 10, y: 10 },
    mirrored: false,
    subBlockMask: 0,
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    theme: 'default',
  };
}

/** A 4×4 sector grid of bordered 20×20 EMPTY sectors (composite 80×80). */
function blankSectors(): SectorData[][] {
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => makeSector()));
}

const pass = new BreachPanelPass();

/** Row string of a sector-local row (I = indestructible, D = destructible, . = other). */
function rowString(sectors: SectorData[][], sRow: number, sCol: number, localRow: number): string {
  let out = '';
  const tiles = sectors[sRow]![sCol]!.tiles[localRow]!;
  for (let c = 0; c < 20; c++) {
    const t = tiles[c]!;
    out += t === TileType.INDESTRUCTIBLE_WALL ? 'I' : t === TileType.DESTRUCTIBLE_WALL ? 'D' : '.';
  }
  return out;
}

describe('BreachPanelPass — straight 1-thick runs', () => {
  it('a long run converts its middle in the 2-on/2-off cadence; endpoints stay rigid', () => {
    const sectors = blankSectors();
    // Sector (1,1) local row 10, cols 4..11 (8 tiles).
    for (let c = 4; c <= 11; c++) sectors[1]![1]!.tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
    const stats = pass.run(sectors);
    // Span = cols 5..10 (6 tiles) → cadence D D # # D D.
    expect(rowString(sectors, 1, 1, 10)).toBe('I...IDDIIDDI.......I');
    expect(stats.converted).toBe(4);
    expect(stats.panels).toBe(2);
  });

  it('spans of 2–4 convert whole (a clean centered breach)', () => {
    const sectors = blankSectors();
    // Local row 12, cols 4..9 (6 tiles) → span 4 → whole.
    for (let c = 4; c <= 9; c++) sectors[1]![1]!.tiles[12]![c] = TileType.INDESTRUCTIBLE_WALL;
    pass.run(sectors);
    expect(rowString(sectors, 1, 1, 12)).toBe('I...IDDDDI.........I');
  });

  it('a span of 1 never converts (no 1-tile scatter)', () => {
    const sectors = blankSectors();
    for (let c = 4; c <= 6; c++) sectors[1]![1]!.tiles[14]![c] = TileType.INDESTRUCTIBLE_WALL;
    pass.run(sectors);
    expect(rowString(sectors, 1, 1, 14)).toBe('I...III............I');
  });

  it('corners and T-junctions stay rigid', () => {
    const sectors = blankSectors();
    const tiles = sectors[1]![1]!.tiles;
    // L: horizontal cols 4..9 row 10 + vertical col 4 rows 10..15.
    for (let c = 4; c <= 9; c++) tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
    for (let r = 10; r <= 15; r++) tiles[r]![4] = TileType.INDESTRUCTIBLE_WALL;
    // T-stem on the horizontal run: col 7 rows 11..13.
    for (let r = 11; r <= 13; r++) tiles[r]![7] = TileType.INDESTRUCTIBLE_WALL;
    pass.run(sectors);
    // (10,4) is the L corner (E+S walls) — rigid. (10,7) is the T junction
    // (E+W+S) — rigid. The clean middles (10,5),(10,6) form a span-2 panel;
    // (10,8),(10,9): (10,8) has E+W and (10,9) is the endpoint → span 1, rigid.
    // Vertical arm: rows 11..14 at col 4 (row 15 endpoint) → span 3 → DDD…
    // except (11,4),(12,4),(13,4) → span 3 whole… but (11..13,4) has E/W open
    // and N/S walls → converts whole (span 3 ≤ 4).
    expect(sectors[1]![1]!.tiles[10]![4]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(sectors[1]![1]!.tiles[10]![7]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(rowString(sectors, 1, 1, 10)).toBe('I...IDDIII.........I');
    let v = '';
    for (let r = 11; r <= 15; r++) {
      v += sectors[1]![1]!.tiles[r]![4] === TileType.DESTRUCTIBLE_WALL ? 'D' : 'I';
    }
    expect(v).toBe('DDDDI');
  });
});

describe('BreachPanelPass — bands', () => {
  it('a 2-thick interior band stays rigid (converted bands deadlock the visual repair)', () => {
    const sectors = blankSectors();
    const tiles = sectors[1]![1]!.tiles;
    // Rows 5-6, cols 4..11 → 2-thick band: every tile has a perpendicular
    // wall cardinal → rigid (the D-D flip deadlock class).
    for (let c = 4; c <= 11; c++) {
      tiles[5]![c] = TileType.INDESTRUCTIBLE_WALL;
      tiles[6]![c] = TileType.INDESTRUCTIBLE_WALL;
    }
    pass.run(sectors);
    expect(rowString(sectors, 1, 1, 5)).toBe('I...IIIIIIII.......I');
    expect(rowString(sectors, 1, 1, 6)).toBe('I...IIIIIIII.......I');
  });

  it('a 3-thick mass stays fully rigid (no fake breaches stripping to a core)', () => {
    const sectors = blankSectors();
    const tiles = sectors[2]![2]!.tiles;
    for (let c = 4; c <= 11; c++) {
      tiles[8]![c] = TileType.INDESTRUCTIBLE_WALL;
      tiles[9]![c] = TileType.INDESTRUCTIBLE_WALL;
      tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
    }
    pass.run(sectors);
    expect(rowString(sectors, 2, 2, 8)).toBe('I...IIIIIIII.......I');
    expect(rowString(sectors, 2, 2, 9)).toBe('I...IIIIIIII.......I');
    expect(rowString(sectors, 2, 2, 10)).toBe('I...IIIIIIII.......I');
  });

  it('inter-sector seam bands (border rings) NEVER convert — borders stay rigid', () => {
    const sectors = blankSectors();
    pass.run(sectors);
    // Seam between sector rows 0 and 1 = sector (0,1) local 19 + sector (1,1)
    // local 0. The double border band stays fully indestructible (owner rule:
    // only INTERNAL composition is breachable).
    expect(rowString(sectors, 0, 1, 19)).toBe('IIIIIIIIIIIIIIIIIIII');
    expect(rowString(sectors, 1, 1, 0)).toBe('IIIIIIIIIIIIIIIIIIII');
    // Same discipline on the vertical seams and every other border ring.
    for (const [sr, sc, lr, lc] of [
      [1, 1, 19, -1],
      [1, 1, 0, -1],
      [2, 2, 19, -1],
    ] as const) {
      const row = rowString(sectors, sr, sc, lr);
      expect(row).toBe('IIIIIIIIIIIIIIIIIIII');
    }
    for (const [sr, sc] of [
      [1, 1],
      [2, 3],
      [3, 2],
    ] as const) {
      let colStr = '';
      for (let r = 0; r < 20; r++) {
        const t = sectors[sr]![sc]!.tiles[r]![0]!;
        colStr +=
          t === TileType.INDESTRUCTIBLE_WALL ? 'I' : t === TileType.DESTRUCTIBLE_WALL ? 'D' : '.';
      }
      expect(colStr).toBe('IIIIIIIIIIIIIIIIIIII');
    }
  });
});

describe('BreachPanelPass — guards', () => {
  it('the global map-edge ring never converts', () => {
    const sectors = blankSectors();
    pass.run(sectors);
    // Sector (0,1) local row 0 IS the global map edge.
    expect(rowString(sectors, 0, 1, 0)).toBe('IIIIIIIIIIIIIIIIIIII');
    expect(rowString(sectors, 1, 0, 0)).toMatch(/^I/); // col-0 edge (spot check)
  });

  it('preserve-set tiles keep their authored material', () => {
    const sectors = blankSectors();
    for (let c = 4; c <= 11; c++) sectors[1]![1]!.tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
    // Global coords of local (1,1)+(10,5..6): sector offset (20,20).
    const preserve = new Set(['30,25', '30,26']);
    pass.run(sectors, preserve);
    // Preserved tiles stay rigid AND are excluded from the span; the
    // remaining eligible span (cols 7..10) converts whole.
    expect(rowString(sectors, 1, 1, 10)).toBe('I...IIIDDDDI.......I');
    expect(sectors[1]![1]!.tiles[10]![5]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(sectors[1]![1]!.tiles[10]![6]).toBe(TileType.INDESTRUCTIBLE_WALL);
  });

  it('determinism: identical input ⇒ identical output', () => {
    const a = blankSectors();
    const b = blankSectors();
    for (let c = 4; c <= 17; c++) {
      a[1]![1]!.tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
      b[1]![1]!.tiles[10]![c] = TileType.INDESTRUCTIBLE_WALL;
    }
    pass.run(a);
    pass.run(b);
    expect(rowString(a, 1, 1, 10)).toBe(rowString(b, 1, 1, 10));
  });
});
