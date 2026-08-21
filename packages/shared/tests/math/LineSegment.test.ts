import {
  pointToSegmentDistance,
  segmentCircleIntersection,
  isPointInFront,
  type LineSegment,
} from '../../src/math/LineSegment.js';

describe('pointToSegmentDistance', () => {
  it('returns 0 for point on segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(5, 0, seg)).toBeCloseTo(0);
  });

  it('returns perpendicular distance to segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(5, 3, seg)).toBeCloseTo(3);
  });

  it('returns distance to closest endpoint when beyond segment', () => {
    const seg: LineSegment = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(pointToSegmentDistance(15, 0, seg)).toBeCloseTo(5);
    expect(pointToSegmentDistance(-5, 0, seg)).toBeCloseTo(5);
  });

  it('returns distance to point for degenerate segment (zero length)', () => {
    const seg: LineSegment = { x1: 3, y1: 4, x2: 3, y2: 4 };
    expect(pointToSegmentDistance(0, 0, seg)).toBeCloseTo(5);
  });
});

describe('segmentCircleIntersection', () => {
  it('returns true when segment overlaps circle (distance < radius)', () => {
    const seg: LineSegment = { x1: -10, y1: 0, x2: 10, y2: 0 };
    expect(segmentCircleIntersection(seg, 0, 0, 5)).toBe(true);
  });

  it('returns false when segment does not touch circle', () => {
    const seg: LineSegment = { x1: 10, y1: 10, x2: 20, y2: 10 };
    expect(segmentCircleIntersection(seg, 0, 0, 5)).toBe(false);
  });

  it('returns true when segment exactly touches circle (distance === radius)', () => {
    const seg: LineSegment = { x1: 5, y1: 0, x2: 15, y2: 0 };
    expect(segmentCircleIntersection(seg, 0, 0, 5)).toBe(true);
  });
});

describe('isPointInFront', () => {
  it('returns true for point in facing direction', () => {
    expect(isPointInFront(10, 0, 1, 0, 0, 0)).toBe(true);
  });

  it('returns false for point opposite to facing direction', () => {
    expect(isPointInFront(-10, 0, 1, 0, 0, 0)).toBe(false);
  });

  it('returns true for perpendicular point (dot product = 0)', () => {
    expect(isPointInFront(0, 10, 1, 0, 0, 0)).toBe(true);
  });
});
