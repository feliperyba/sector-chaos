import { describe, it, expect } from 'vitest';
import { TileType } from '@sector-battle/shared';
import { WallOrientationDetector } from '../WallOrientationDetector.ts';
import { WALL_MASK_BITS, classifyWall } from '../WallMaskClassifier.ts';

const B = WALL_MASK_BITS;

/**
 * Helper to build a grid from a string template.
 * '#' = INDESTRUCTIBLE_WALL, '.' = EMPTY
 */
function buildGrid(template: string[]): TileType[][] {
  return template.map((row) =>
    row.split('').map((ch) => (ch === '#' ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY)),
  );
}

describe('WallOrientationDetector', () => {
  const detector = new WallOrientationDetector();

  it('returns all nulls for an empty grid', () => {
    const grid = [
      [TileType.EMPTY, TileType.EMPTY],
      [TileType.EMPTY, TileType.EMPTY],
    ];
    const result = detector.detect(grid);
    for (const row of result) {
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
  });

  it('returns empty array for empty grid', () => {
    const result = detector.detect([]);
    expect(result).toEqual([]);
  });

  it('returns null for non-wall cells and a number mask for wall cells', () => {
    const grid = [
      [TileType.EMPTY, TileType.CHEST, TileType.EXIT],
      [TileType.DESTRUCTIBLE_CRATE, TileType.INDESTRUCTIBLE_WALL, TileType.EMPTY],
    ];
    const result = detector.detect(grid);
    expect(result[0]![0]).toBeNull();
    expect(result[0]![1]).toBeNull(); // CHEST is not wall-like
    expect(result[0]![2]).toBeNull();
    expect(result[1]![0]).toBeNull(); // DESTRUCTIBLE_CRATE is not wall-like
    expect(typeof result[1]![1]).toBe('number'); // the wall
    expect(result[1]![2]).toBeNull();
  });

  it('builds the mask with the T2 WALL_MASK_BITS weights (interior isolated wall)', () => {
    // A lone wall fully surrounded by floor, in the grid interior (no off-map
    // neighbours), has every bit clear → mask 0.
    const grid = buildGrid(['.....', '.....', '..#..', '.....', '.....']);
    expect(detector.detect(grid)[2]![2]).toBe(0);
  });

  it('treats off-map neighbours as wall-like', () => {
    // A lone wall at the very corner (0,0) of a floor field: N, NE, E?, ...
    // its N, W, NW, NE, SW neighbours are off-map (wall), only the interior
    // S / E / SE neighbours are open floor.
    const grid = buildGrid(['#...', '....', '....', '....']);
    const mask = detector.detect(grid)[0]![0]!;
    // Off-map: N, W, NW, NE, SW are set; in-bounds floor: E, S, SE clear.
    expect(mask & B.N).toBe(B.N);
    expect(mask & B.W).toBe(B.W);
    expect(mask & B.NW).toBe(B.NW);
    expect(mask & B.NE).toBe(B.NE);
    expect(mask & B.SW).toBe(B.SW);
    expect(mask & B.E).toBe(0);
    expect(mask & B.S).toBe(0);
    expect(mask & B.SE).toBe(0);
  });

  it('encodes a vertical straight run (N+S walls, E+W open)', () => {
    const grid = buildGrid(['.....', '..#..', '..#..', '..#..', '.....']);
    const mask = detector.detect(grid)[2]![2]!; // middle of the run, interior
    expect(mask & B.N).toBe(B.N);
    expect(mask & B.S).toBe(B.S);
    expect(mask & B.E).toBe(0);
    expect(mask & B.W).toBe(0);
    // classifyWall reads this as a straight facing the open side.
    expect(classifyWall(mask).role).toBe('straight');
  });

  it('encodes a horizontal straight run (E+W walls, N+S open)', () => {
    const grid = buildGrid(['.....', '.....', '.###.', '.....', '.....']);
    const mask = detector.detect(grid)[2]![2]!;
    expect(mask & B.E).toBe(B.E);
    expect(mask & B.W).toBe(B.W);
    expect(mask & B.N).toBe(0);
    expect(mask & B.S).toBe(0);
    expect(classifyWall(mask).role).toBe('straight');
  });

  it('encodes a convex outer corner (two adjacent walls, flanks open)', () => {
    // L-shaped corner with floor wrapping the outside.
    // .....
    // ..#..
    // ..##.
    // .....
    const grid = buildGrid(['.....', '..#..', '..##.', '.....']);
    const mask = detector.detect(grid)[2]![2]!; // the elbow at (2,2): N + E walls
    expect(mask & B.N).toBe(B.N);
    expect(mask & B.E).toBe(B.E);
    expect(mask & B.S).toBe(0);
    expect(mask & B.W).toBe(0);
    expect(classifyWall(mask).role).toBe('outer_corner');
  });

  it('encodes a concave inner corner at a solid mass pocket', () => {
    // A 2x2 solid block: its (1,1) cell has N, W walls and the NW diagonal also
    // wall, but the open SE quadrant makes the classifier pick inner vs outer by
    // the diagonal between the arms. Use a mass with a single open diagonal.
    // ###
    // ###
    // ##.   ← cell (2,2) opens only to SE corner (off-map elsewhere), concave.
    const grid = buildGrid(['###', '###', '##.']);
    const mask = detector.detect(grid)[1]![1]!; // center of the mass
    // Center is fully buried except the SE diagonal pocket is open.
    expect(mask & B.N).toBe(B.N);
    expect(mask & B.S).toBe(B.S);
    expect(mask & B.E).toBe(B.E);
    expect(mask & B.W).toBe(B.W);
    expect(mask & B.SE).toBe(0); // the open pocket
    expect(classifyWall(mask).role).toBe('inner_corner');
  });

  it('treats DESTRUCTIBLE_WALL and INDESTRUCTIBLE_CRATE as wall-like', () => {
    const grid = [
      [TileType.EMPTY, TileType.DESTRUCTIBLE_WALL, TileType.EMPTY],
      [TileType.INDESTRUCTIBLE_CRATE, TileType.INDESTRUCTIBLE_WALL, TileType.DESTRUCTIBLE_WALL],
      [TileType.EMPTY, TileType.DESTRUCTIBLE_WALL, TileType.EMPTY],
    ];
    const result = detector.detect(grid);
    const mask = result[1]![1]!; // center sees walls on all 4 cardinals
    expect(mask & B.N).toBe(B.N);
    expect(mask & B.S).toBe(B.S);
    expect(mask & B.E).toBe(B.E);
    expect(mask & B.W).toBe(B.W);
  });
});
