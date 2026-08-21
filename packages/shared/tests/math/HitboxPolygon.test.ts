import { describe, it, expect } from 'vitest';
import { buildSectorPolygon, buildRotatedRect } from '../../src/math/HitboxPolygon.js';
import type { Vec2 } from '../../src/math/Vec2.js';

function distFromOrigin(p: Vec2): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

function allUnique(pts: Vec2[]): boolean {
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i].x - pts[j].x) < 1e-10 && Math.abs(pts[i].y - pts[j].y) < 1e-10) {
        return false;
      }
    }
  }
  return true;
}

describe('buildSectorPolygon', () => {
  it('90-degree arc with facing=0 produces 7 correct vertices at known positions', () => {
    const pts = buildSectorPolygon(0, 0, 0, Math.PI / 2, 10, 50);

    expect(pts).toHaveLength(7);

    const half = Math.PI / 4;
    const quarter = Math.PI / 8;

    const expected = [
      { x: 10 * Math.cos(-half), y: 10 * Math.sin(-half) },
      { x: 50 * Math.cos(-half), y: 50 * Math.sin(-half) },
      { x: 50 * Math.cos(-quarter), y: 50 * Math.sin(-quarter) },
      { x: 50 * Math.cos(0), y: 50 * Math.sin(0) },
      { x: 50 * Math.cos(quarter), y: 50 * Math.sin(quarter) },
      { x: 50 * Math.cos(half), y: 50 * Math.sin(half) },
      { x: 10 * Math.cos(half), y: 10 * Math.sin(half) },
    ];

    for (let i = 0; i < 7; i++) {
      expect(pts[i].x).toBeCloseTo(expected[i].x, 4);
      expect(pts[i].y).toBeCloseTo(expected[i].y, 4);
    }
  });

  it('90-degree arc with facing=PI/4 rotates all vertices correctly', () => {
    const facing = Math.PI / 4;
    const pts = buildSectorPolygon(0, 0, facing, Math.PI / 2, 10, 50);

    expect(pts).toHaveLength(7);

    const half = Math.PI / 4;
    const quarter = Math.PI / 8;

    const expected = [
      { x: 10 * Math.cos(facing - half), y: 10 * Math.sin(facing - half) },
      { x: 50 * Math.cos(facing - half), y: 50 * Math.sin(facing - half) },
      { x: 50 * Math.cos(facing - quarter), y: 50 * Math.sin(facing - quarter) },
      { x: 50 * Math.cos(facing), y: 50 * Math.sin(facing) },
      { x: 50 * Math.cos(facing + quarter), y: 50 * Math.sin(facing + quarter) },
      { x: 50 * Math.cos(facing + half), y: 50 * Math.sin(facing + half) },
      { x: 10 * Math.cos(facing + half), y: 10 * Math.sin(facing + half) },
    ];

    for (let i = 0; i < 7; i++) {
      expect(pts[i].x).toBeCloseTo(expected[i].x, 4);
      expect(pts[i].y).toBeCloseTo(expected[i].y, 4);
    }
  });

  it('inner radius < outer radius: vertices are at correct radii', () => {
    const pts = buildSectorPolygon(0, 0, 0, Math.PI / 2, 20, 60);

    expect(distFromOrigin(pts[0])).toBeCloseTo(20, 4);
    expect(distFromOrigin(pts[6])).toBeCloseTo(20, 4);

    for (let i = 1; i <= 5; i++) {
      expect(distFromOrigin(pts[i])).toBeCloseTo(60, 4);
    }
  });

  it('arcAngle PI/2: no degenerate polygons (all vertices unique)', () => {
    const pts = buildSectorPolygon(0, 0, 0, Math.PI / 2, 10, 50);
    expect(allUnique(pts)).toBe(true);
  });

  it('arcAngle=0 returns exactly 2 vertices (inner to outer along facing)', () => {
    const facing = Math.PI / 3;
    const pts = buildSectorPolygon(0, 0, facing, 0, 10, 50);

    expect(pts).toHaveLength(2);

    expect(pts[0].x).toBeCloseTo(10 * Math.cos(facing), 4);
    expect(pts[0].y).toBeCloseTo(10 * Math.sin(facing), 4);
    expect(pts[1].x).toBeCloseTo(50 * Math.cos(facing), 4);
    expect(pts[1].y).toBeCloseTo(50 * Math.sin(facing), 4);
  });
});

describe('buildRotatedRect', () => {
  it('facing=0 produces axis-aligned rectangle starting at startOffset', () => {
    const pts = buildRotatedRect(0, 0, 0, 10, 20, 5);

    expect(pts).toHaveLength(4);

    expect(pts[0].x).toBeCloseTo(5, 4);
    expect(pts[0].y).toBeCloseTo(5, 4);
    expect(pts[1].x).toBeCloseTo(25, 4);
    expect(pts[1].y).toBeCloseTo(5, 4);
    expect(pts[2].x).toBeCloseTo(25, 4);
    expect(pts[2].y).toBeCloseTo(-5, 4);
    expect(pts[3].x).toBeCloseTo(5, 4);
    expect(pts[3].y).toBeCloseTo(-5, 4);
  });

  it('facing=PI/2 rotates 90 degrees (forward becomes +Y)', () => {
    const pts = buildRotatedRect(0, 0, Math.PI / 2, 10, 20, 5);

    expect(pts).toHaveLength(4);

    expect(pts[0].x).toBeCloseTo(-5, 4);
    expect(pts[0].y).toBeCloseTo(5, 4);
    expect(pts[1].x).toBeCloseTo(-5, 4);
    expect(pts[1].y).toBeCloseTo(25, 4);
    expect(pts[2].x).toBeCloseTo(5, 4);
    expect(pts[2].y).toBeCloseTo(25, 4);
    expect(pts[3].x).toBeCloseTo(5, 4);
    expect(pts[3].y).toBeCloseTo(5, 4);
  });

  it('startOffset pushes rectangle away from center', () => {
    const pts = buildRotatedRect(0, 0, 0, 10, 20, 30);

    const minX = Math.min(...pts.map((p) => p.x));
    expect(minX).toBeCloseTo(30, 4);
  });

  it('width=20, length=320 (spear dimensions from GDD)', () => {
    const pts = buildRotatedRect(0, 0, 0, 20, 320, 30);

    expect(pts).toHaveLength(4);

    expect(pts[0].x).toBeCloseTo(30, 4);
    expect(pts[0].y).toBeCloseTo(10, 4);
    expect(pts[1].x).toBeCloseTo(350, 4);
    expect(pts[1].y).toBeCloseTo(10, 4);
    expect(pts[2].x).toBeCloseTo(350, 4);
    expect(pts[2].y).toBeCloseTo(-10, 4);
    expect(pts[3].x).toBeCloseTo(30, 4);
    expect(pts[3].y).toBeCloseTo(-10, 4);
  });

  it('width=0: degenerate line (still produces 4 vertices, width collapses)', () => {
    const pts = buildRotatedRect(0, 0, 0, 0, 20, 5);

    expect(pts).toHaveLength(4);

    expect(pts[0].x).toBeCloseTo(5, 4);
    expect(pts[0].y).toBeCloseTo(0, 4);
    expect(pts[1].x).toBeCloseTo(25, 4);
    expect(pts[1].y).toBeCloseTo(0, 4);
    expect(pts[2].x).toBeCloseTo(25, 4);
    expect(pts[2].y).toBeCloseTo(0, 4);
    expect(pts[3].x).toBeCloseTo(5, 4);
    expect(pts[3].y).toBeCloseTo(0, 4);
  });
});
