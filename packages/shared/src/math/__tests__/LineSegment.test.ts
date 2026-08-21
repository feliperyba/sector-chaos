import { describe, it, expect } from 'vitest';
import {
  pointToSegmentDistance,
  segmentCircleIntersection,
  isPointInFront,
} from '../LineSegment.js';
import type { LineSegment } from '../LineSegment.js';

describe('pointToSegmentDistance', () => {
  it('returns 0 when point is on segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(5, 0, seg)).toBe(0);
  });

  it('returns correct distance when point is off segment perpendicular', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(5, 3, seg)).toBeCloseTo(3);
  });

  it('returns distance to nearest endpoint when projection falls outside segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(15, 3, seg)).toBeCloseTo(Math.sqrt(25 + 9));
  });

  it('returns distance to start endpoint when point is before segment', () => {
    const seg: LineSegment = { x1: 5, y1: 5, x2: 15, y2: 5 };
    expect(pointToSegmentDistance(2, 9, seg)).toBeCloseTo(5);
  });

  it('returns distance to point when segment is zero-length', () => {
    const seg: LineSegment = { x1: 5, y1: 5, x2: 5, y2: 5 };
    expect(pointToSegmentDistance(5, 5, seg)).toBe(0);
    expect(pointToSegmentDistance(5, 8, seg)).toBeCloseTo(3);
  });
});

describe('segmentCircleIntersection', () => {
  it('returns true when circle intersects segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 20, y2: 0 };
    expect(segmentCircleIntersection(seg, 10, 5, 6)).toBe(true);
  });

  it('returns false when circle does not intersect segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 20, y2: 0 };
    expect(segmentCircleIntersection(seg, 10, 20, 5)).toBe(false);
  });

  it('returns true when circle is tangent to segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 20, y2: 0 };
    expect(segmentCircleIntersection(seg, 10, 5, 5)).toBe(true);
  });

  it('returns true when circle center is on segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 20, y2: 0 };
    expect(segmentCircleIntersection(seg, 10, 0, 1)).toBe(true);
  });
});

describe('isPointInFront', () => {
  it('returns true when point is in front', () => {
    expect(isPointInFront(10, 0, 1, 0, 0, 0)).toBe(true);
  });

  it('returns false when point is behind', () => {
    expect(isPointInFront(-10, 0, 1, 0, 0, 0)).toBe(false);
  });

  it('returns true when point is perpendicular (dot product = 0)', () => {
    expect(isPointInFront(0, 10, 1, 0, 0, 0)).toBe(true);
  });

  it('returns true for diagonal front', () => {
    expect(isPointInFront(5, 5, 1, 1, 0, 0)).toBe(true);
  });
});
