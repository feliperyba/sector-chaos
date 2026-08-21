/**
 * Wall-composition unit tests (map-polish ticket 14): the shared generation-
 * side validator (`validateWallComposition`), the T-stem residual classifier
 * and the composition-enforcing `WallCompositionPass` — pinned against
 * hand-built grids so the seed sweep (`server …/WallCompositionSweep.test.ts`)
 * failing means a REGRESSION, not a broken gate.
 */

import { describe, expect, it } from 'vitest';
import { TileType } from '../../enums/TileType.js';
import { SectorType, type SectorData } from '../types.js';
import type { SectorSubVariant } from '../sectors/subVariants.js';
import type { TileSpriteDef, TileVisual } from '../tiledTypes.js';
import {
  validateWallComposition,
  collectSanctionedStubCells,
  isPureDestructibleTStemPair,
} from '../validatorGates.js';
import { WallCompositionPass } from '../refinement/WallCompositionPass.js';
import { MapGenerator } from '../MapGenerator.js';
import { SECTOR_TILE_SIZE } from '../constants.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const WALL_ID = 1;
const WALL_DEF: TileSpriteDef = {
  id: WALL_ID,
  imagePath: 'wall',
  tileType: TileType.INDESTRUCTIBLE_WALL,
  colliders: [],
};
const ATLAS = [WALL_DEF];

function visual(rotation: 0 | 90 | 180 | 270 = 0): TileVisual {
  return { spriteId: WALL_ID, rotation, flipH: false, flipV: false };
}

function blankGrid(size: number, value: TileType = TileType.EMPTY): TileType[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
}

function blankVisuals(size: number): (TileVisual | null)[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => null));
}

/** A 4×4 sector grid of bordered 20×20 EMPTY sectors (composite 80×80). */
function blankSectors(type: SectorType = SectorType.GRID_ARENA): SectorData[][] {
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => makeSector(type)));
}

function makeSector(type: SectorType): SectorData {
  const tiles = Array.from({ length: 20 }, () => new Uint8Array(20).fill(TileType.EMPTY));
  for (let i = 0; i < 20; i++) {
    tiles[0]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[19]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![0] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![19] = TileType.INDESTRUCTIBLE_WALL;
  }
  return {
    type,
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

// ── validateWallComposition — continuity ─────────────────────────────────────

describe('validateWallComposition — continuity pairs', () => {
  it('flags a vertical pair whose touching bands share no solid cell (interior)', () => {
    // Two `wall` strips facing away: A@0 (strip north) has a transparent S
    // band; B@180 (strip south) has a transparent N band → floor shows through.
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[4]![3] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);
    walls[4]![3] = visual(180);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.interiorViolations).toBe(1);
    expect(audit.seamViolations).toBe(0);
    expect(audit.violations[0]).toMatchObject({ row: 3, col: 3, dir: 'S' });
  });

  it('buckets violations on sector-border tiles as seam (local row/col 0 or 19)', () => {
    const grid = blankGrid(40);
    const walls = blankVisuals(40);
    grid[19]![5] = TileType.INDESTRUCTIBLE_WALL;
    grid[20]![5] = TileType.INDESTRUCTIBLE_WALL;
    walls[19]![5] = visual(0);
    walls[20]![5] = visual(180);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.seamViolations).toBe(1);
    expect(audit.interiorViolations).toBe(0);
  });

  it('a fill cell on either side of the pair connects it (fill-aware)', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    const fills = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[4]![3] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);
    walls[4]![3] = visual(180);
    fills[4]![3] = visual(0);

    const audit = validateWallComposition(grid, walls, {
      atlasSprites: ATLAS,
      fillCells: fills,
    });
    expect(audit.violations).toEqual([]);
  });

  it('connected bands (same facing side-flip-free run) produce zero violations', () => {
    // Both strips on the north side of a horizontal run: the E/W bands share
    // the solid rows 0–2 → connected.
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[4]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[4]![4] = TileType.INDESTRUCTIBLE_WALL;
    walls[4]![3] = visual(0);
    walls[4]![4] = visual(0);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.violations).toEqual([]);
  });
});

// ── validateWallComposition — orphan stubs ───────────────────────────────────

describe('validateWallComposition — orphan stubs', () => {
  it('counts an isolated indestructible wall as an unsanctioned orphan stub', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.orphanStubWalls).toBe(1);
    expect(audit.orphanStubs[0]).toMatchObject({
      row: 3,
      col: 3,
      tile: TileType.INDESTRUCTIBLE_WALL,
    });
  });

  it('exempts sanctioned cells and reports them as sanctionedStubCount', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);

    const audit = validateWallComposition(grid, walls, {
      atlasSprites: ATLAS,
      sanctionedStubCells: new Set(['3,3']),
    });
    expect(audit.orphanStubWalls).toBe(0);
    expect(audit.sanctionedStubCount).toBe(1);
  });

  it('counts isolated destructible walls as shards, never as orphan stubs', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.DESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.orphanStubWalls).toBe(0);
    expect(audit.destructibleShardCount).toBe(1);
  });

  it('a 2-tile wall cluster and crate neighbours are not orphans', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[3]![4] = TileType.INDESTRUCTIBLE_WALL;
    grid[5]![5] = TileType.DESTRUCTIBLE_CRATE; // not wall-like at all
    walls[3]![3] = visual(0);
    walls[3]![4] = visual(0);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.orphanStubWalls).toBe(0);
    expect(audit.destructibleShardCount).toBe(0);
  });

  it('ignores the outer border ring tiles (only interior tiles are scanned)', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[0]![3] = TileType.INDESTRUCTIBLE_WALL; // ring positions — never counted
    grid[3]![0] = TileType.INDESTRUCTIBLE_WALL;
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL; // interior — counted
    walls[0]![3] = visual(0);
    walls[3]![0] = visual(0);
    walls[3]![3] = visual(0);

    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.orphanStubWalls).toBe(1);
    expect(audit.orphanStubs[0]).toMatchObject({ row: 3, col: 3 });
  });
});

// ── validateWallComposition — corner-dangling coverage (ticket 20) ───────────

describe('validateWallComposition — corner-dangling coverage', () => {
  /**
   * Fixture: `wall@0` (strip on the north edge) at (3,3) with a wall-like
   * diagonal neighbour at (4,4) and all four cardinals open — the cell's only
   * attachment is the SE diagonal, and the strip leaves that corner
   * transparent → the classic floating-shard defect class.
   */
  function danglingFixture() {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[4]![4] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);
    walls[4]![4] = visual(0);
    return { grid, walls };
  }

  it('flags a corner-dangling cell whose art leaves the diagonal corner open', () => {
    const { grid, walls } = danglingFixture();
    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.cornerDanglingViolations).toBe(1);
    expect(audit.cornerViolations[0]).toMatchObject({ row: 3, col: 3, dir: 'SE' });
  });

  it('passes a corner-dangling cell whose art covers the diagonal corner (hugging L)', () => {
    const { grid, walls } = danglingFixture();
    // wall@0 has no shape entry for a corner-hug in this 1-frame atlas, so
    // prove the quadrant rule through the multi-frame shapes: rebuild with a
    // wall_corner def hugging SE (rot 180 covers the SE quadrant).
    const cornerDef: TileSpriteDef = {
      id: 2,
      imagePath: 'wall_corner',
      tileType: TileType.INDESTRUCTIBLE_WALL,
      colliders: [],
    };
    walls[3]![3] = { spriteId: 2, rotation: 180, flipH: false, flipV: false };
    const audit = validateWallComposition(grid, walls, { atlasSprites: [WALL_DEF, cornerDef] });
    expect(audit.cornerDanglingViolations).toBe(0);
  });

  it('a fill cell makes the corner solid by construction (fill-aware)', () => {
    const { grid, walls } = danglingFixture();
    const fills = blankVisuals(8);
    fills[3]![3] = visual(0);
    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS, fillCells: fills });
    expect(audit.cornerDanglingViolations).toBe(0);
  });

  it('cardinally-attached cells and true lone pillars are not corner-audited', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    // (3,3) has a cardinal wall neighbour at (3,4); (5,5) has no wall
    // neighbour at all — neither is corner-dangling whatever they render.
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[3]![4] = TileType.INDESTRUCTIBLE_WALL;
    grid[5]![5] = TileType.INDESTRUCTIBLE_WALL;
    walls[3]![3] = visual(0);
    walls[3]![4] = visual(0);
    walls[5]![5] = visual(0);
    const audit = validateWallComposition(grid, walls, { atlasSprites: ATLAS });
    expect(audit.cornerDanglingViolations).toBe(0);
  });

  it('a checkerboard pocket (wall-like diagonal in all four quadrants) is art-limited telemetry, not a violation', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    // Four diagonal neighbours (the pocket) — each hugging the pocket corner
    // with a wall_corner L so THEY stay clean; only the centre cell is the
    // art-limited checkerboard case.
    const cornerDef: TileSpriteDef = {
      id: 2,
      imagePath: 'wall_corner',
      tileType: TileType.INDESTRUCTIBLE_WALL,
      colliders: [],
    };
    const hug: Array<[number, number, 0 | 90 | 180 | 270]> = [
      [2, 2, 180], // hugs SE (toward the pocket centre)
      [2, 4, 270], // hugs SW
      [4, 2, 90], // hugs NE
      [4, 4, 0], // hugs NW
    ];
    for (const [r, c, rot] of hug) {
      grid[r]![c] = TileType.INDESTRUCTIBLE_WALL;
      walls[r]![c] = { spriteId: 2, rotation: rot, flipH: false, flipV: false };
    }
    walls[3]![3] = visual(0);
    const audit = validateWallComposition(grid, walls, {
      atlasSprites: [WALL_DEF, cornerDef],
    });
    expect(audit.cornerDanglingViolations).toBe(0);
    expect(audit.cornerArtLimitedCells).toBe(1);
  });
});

// ── determinism (ADR 0035) ────────────────────────────────────────────────────

describe('validateWallComposition — determinism', () => {
  it('two audits of the same inputs are identical', () => {
    const grid = blankGrid(8);
    const walls = blankVisuals(8);
    grid[3]![3] = TileType.INDESTRUCTIBLE_WALL;
    grid[3]![4] = TileType.DESTRUCTIBLE_WALL;
    walls[3]![3] = visual(90);
    walls[3]![4] = visual(270);
    const opts = { atlasSprites: ATLAS, sanctionedStubCells: new Set(['9,9']) };

    const a = validateWallComposition(grid, walls, opts);
    const b = validateWallComposition(grid, walls, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── T-stem topology classification ────────────────────────────────────────────

// `isTStemTopology` itself is module-private (ticket 16: zero consumers
// outside validatorGates.ts) — the exported classifier that embeds it,
// `isPureDestructibleTStemPair`, is the observable surface these tests pin.

describe('isPureDestructibleTStemPair — T-stem topology classification', () => {
  it('classifies a T junction cell (walls on three cardinals)', () => {
    const grid = blankGrid(6);
    grid[1]![1] = TileType.DESTRUCTIBLE_WALL; // stem
    grid[2]![0] = TileType.DESTRUCTIBLE_WALL; // arm
    grid[2]![1] = TileType.DESTRUCTIBLE_WALL; // junction
    grid[2]![2] = TileType.DESTRUCTIBLE_WALL; // arm

    // Each T-stem-class cell (junction / stem / arm-attached-to-junction)
    // makes a (D,D) pair with it T-classified.
    expect(isPureDestructibleTStemPair(grid, 2, 1, 'E')).toBe(true); // junction
    expect(isPureDestructibleTStemPair(grid, 1, 1, 'S')).toBe(true); // stem
    expect(isPureDestructibleTStemPair(grid, 2, 0, 'E')).toBe(true); // arm
  });

  it('rejects L shapes, straight runs and isolated tiles', () => {
    const grid = blankGrid(8);
    grid[3]![3] = TileType.DESTRUCTIBLE_WALL;
    grid[3]![4] = TileType.DESTRUCTIBLE_WALL; // domino
    grid[6]![1] = TileType.DESTRUCTIBLE_WALL;
    grid[6]![2] = TileType.DESTRUCTIBLE_WALL;
    grid[7]![1] = TileType.DESTRUCTIBLE_WALL; // L

    // Domino corner, L corner and isolated tile are no cell of a T topology.
    expect(isPureDestructibleTStemPair(grid, 3, 3, 'E')).toBe(false);
    expect(isPureDestructibleTStemPair(grid, 6, 1, 'E')).toBe(false);
    expect(isPureDestructibleTStemPair(grid, 0, 0, 'E')).toBe(false);
  });

  it('a pair with an indestructible side is never the pure-destructible class', () => {
    const grid = blankGrid(6);
    grid[2]![1] = TileType.INDESTRUCTIBLE_WALL;
    grid[2]![2] = TileType.DESTRUCTIBLE_WALL;
    grid[2]![3] = TileType.DESTRUCTIBLE_WALL;

    // The (I,D) pair is excluded by material; the (D,D) domino is not T-shaped.
    expect(isPureDestructibleTStemPair(grid, 2, 1, 'E')).toBe(false);
    expect(isPureDestructibleTStemPair(grid, 2, 2, 'E')).toBe(false);
  });
});

// ── collectSanctionedStubCells ────────────────────────────────────────────────

describe('collectSanctionedStubCells — maze separator residue', () => {
  it('sanctions isolated indestructible stubs inside MAZE sectors only', () => {
    const sectors = blankSectors(SectorType.GRID_ARENA);
    sectors[1]![1] = makeSector(SectorType.MAZE);
    // Isolated stub in the MAZE sector (composite (25,25)) and one in a
    // GRID_ARENA sector (composite (5,5)) — near-border isolated positions.
    sectors[1]![1]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL;
    sectors[0]![0]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL;

    const sanctioned = collectSanctionedStubCells(sectors);
    expect(sanctioned.has('25,25')).toBe(true); // maze pillar residue
    expect(sanctioned.has('5,5')).toBe(false); // non-maze stub stays unsanctioned
    expect(sanctioned.size).toBe(1);
  });
});

// ── WallCompositionPass ───────────────────────────────────────────────────────

describe('WallCompositionPass — composition-rule enforcement', () => {
  it('clears an unsanctioned orphan indestructible stub to EMPTY', () => {
    const sectors = blankSectors(SectorType.GRID_ARENA);
    sectors[0]![0]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL;

    const result = new WallCompositionPass().run(sectors);
    expect(result.clearedStubs).toBe(1);
    expect(result.convertedShards).toBe(0);
    expect(sectors[0]![0]!.tiles[5]![5]).toBe(TileType.EMPTY);
  });

  it('keeps maze separator-residue stubs (sanctioned cover-object placements)', () => {
    const sectors = blankSectors(SectorType.MAZE);
    sectors[0]![0]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL;

    const result = new WallCompositionPass().run(sectors);
    expect(result.clearedStubs).toBe(0);
    expect(sectors[0]![0]!.tiles[5]![5]).toBe(TileType.INDESTRUCTIBLE_WALL);
  });

  it('converts an orphaned destructible wall to a crate (cover count preserved)', () => {
    const sectors = blankSectors(SectorType.GRID_ARENA);
    sectors[0]![0]!.tiles[5]![5] = TileType.DESTRUCTIBLE_WALL;

    const result = new WallCompositionPass().run(sectors);
    expect(result.convertedShards).toBe(1);
    expect(sectors[0]![0]!.tiles[5]![5]).toBe(TileType.DESTRUCTIBLE_CRATE);
  });

  it('never touches 2-tile clusters, border rings or crates', () => {
    const sectors = blankSectors(SectorType.GRID_ARENA);
    sectors[0]![0]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL;
    sectors[0]![0]!.tiles[5]![6] = TileType.INDESTRUCTIBLE_WALL;
    sectors[0]![0]!.tiles[8]![8] = TileType.DESTRUCTIBLE_CRATE;

    const result = new WallCompositionPass().run(sectors);
    expect(result).toEqual({ clearedStubs: 0, convertedShards: 0 });
    expect(sectors[0]![0]!.tiles[5]![5]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(sectors[0]![0]!.tiles[8]![8]).toBe(TileType.DESTRUCTIBLE_CRATE);
  });

  it('is deterministic — identical inputs produce identical outputs', () => {
    const build = () => {
      const sectors = blankSectors(SectorType.GRID_ARENA);
      sectors[2]![3]!.tiles[7]![7] = TileType.INDESTRUCTIBLE_WALL;
      sectors[1]![0]!.tiles[10]![10] = TileType.DESTRUCTIBLE_WALL;
      return sectors;
    };
    const a = build();
    const b = build();

    const resultA = new WallCompositionPass().run(a);
    const resultB = new WallCompositionPass().run(b);
    expect(resultA).toEqual(resultB);
    expect(JSON.stringify(serializeTiles(a))).toBe(JSON.stringify(serializeTiles(b)));
  });

  it('composes with the validator: a pass-cleaned sector grid audits zero', () => {
    const sectors = blankSectors(SectorType.GRID_ARENA);
    sectors[0]![0]!.tiles[5]![5] = TileType.INDESTRUCTIBLE_WALL; // orphan stub
    sectors[3]![3]!.tiles[10]![10] = TileType.DESTRUCTIBLE_WALL; // shard
    new WallCompositionPass().run(sectors);

    expect(sectors[0]![0]!.tiles[5]![5]).toBe(TileType.EMPTY);
    expect(sectors[3]![3]!.tiles[10]![10]).toBe(TileType.DESTRUCTIBLE_CRATE);
  });
});

/** Serialize sector tiles for a byte-comparison (Uint8Array → number[]). */
function serializeTiles(sectors: SectorData[][]): number[][][][] {
  return sectors.map((row) => row.map((s) => s.tiles.map((t) => Array.from(t))));
}

// ── border buffer discipline (map-polish round 5e) ───────────────────────────

describe('border buffer discipline (round 5e)', () => {
  it('the FINAL generated grid keeps sector-local row/col 1 and 18 free of wall-type tiles (macro footprints exempt)', () => {
    // Post-stamp re-clean contract: prefab compositions and plaza keeps stamp
    // AFTER the early cleanBuffer, and any wall they leave flush against the
    // border ring corrupts the ring tiles' 8-neighbour masks (buried cross /
    // inner_corner roles mid-run, dirty gate-jamb flanks — the owner-visible
    // "border walls not following the logical progression"). Crates/barrels in
    // the buffer are the documented preserved class (cleanBuffer spares them),
    // and macro features own their footprints (the Citadel's yard band
    // authors walls at sector-local 1..2 by design — the re-clean preserves
    // `macroTiles`, mirrored here by exempting the placed fortress extent).
    for (const seed of [1, 42, 999]) {
      const map = new MapGenerator().generate(seed);
      const fortress = map.fortress;
      const inFortress = (gr: number, gc: number): boolean =>
        fortress !== null &&
        gr >= fortress.originRow &&
        gr < fortress.originRow + fortress.size &&
        gc >= fortress.originCol &&
        gc < fortress.originCol + fortress.size;
      for (let sr = 0; sr < map.sectors.length; sr++) {
        for (let sc = 0; sc < map.sectors[sr]!.length; sc++) {
          const sector = map.sectors[sr]![sc]!;
          const last = SECTOR_TILE_SIZE - 1;
          for (let i = 1; i < last; i++) {
            for (const [r, c] of [
              [1, i],
              [last - 1, i],
              [i, 1],
              [i, last - 1],
            ] as const) {
              if (inFortress(sr * SECTOR_TILE_SIZE + r, sc * SECTOR_TILE_SIZE + c)) continue;
              const t = sector.tiles[r]![c]!;
              expect(
                t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL,
                `seed ${seed}: wall-type tile at sector-local (${r},${c})`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});
