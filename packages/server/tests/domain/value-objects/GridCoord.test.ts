import { GridCoord } from '../../../src/domain/value-objects/index.ts';

describe('GridCoord', () => {
  it('constructor sets x and y', () => {
    const coord = new GridCoord(3, 7);
    expect(coord.x).toBe(3);
    expect(coord.y).toBe(7);
  });

  it('neighbors4 returns 4 cardinal adjacent coordinates', () => {
    const coord = new GridCoord(5, 5);
    const neighbors = coord.neighbors4();
    expect(neighbors).toHaveLength(4);
    expect(neighbors[0]).toEqual(new GridCoord(5, 4));
    expect(neighbors[1]).toEqual(new GridCoord(5, 6));
    expect(neighbors[2]).toEqual(new GridCoord(4, 5));
    expect(neighbors[3]).toEqual(new GridCoord(6, 5));
  });

  it('neighbors8 returns 8 surrounding coordinates', () => {
    const coord = new GridCoord(5, 5);
    const neighbors = coord.neighbors8();
    expect(neighbors).toHaveLength(8);
    const expected = [
      new GridCoord(4, 4),
      new GridCoord(5, 4),
      new GridCoord(6, 4),
      new GridCoord(4, 5),
      new GridCoord(6, 5),
      new GridCoord(4, 6),
      new GridCoord(5, 6),
      new GridCoord(6, 6),
    ];
    for (let i = 0; i < 8; i++) {
      expect(neighbors[i].equals(expected[i])).toBe(true);
    }
  });

  it('distance computes Manhattan distance', () => {
    const a = new GridCoord(1, 2);
    const b = new GridCoord(4, 6);
    expect(a.distance(b)).toBe(7);
  });

  it('distance is 0 for same coordinates', () => {
    const a = new GridCoord(3, 3);
    expect(a.distance(a)).toBe(0);
  });

  it('equals returns true for same coordinates', () => {
    const a = new GridCoord(2, 8);
    const b = new GridCoord(2, 8);
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different coordinates', () => {
    const a = new GridCoord(2, 8);
    const b = new GridCoord(8, 2);
    expect(a.equals(b)).toBe(false);
  });
});
