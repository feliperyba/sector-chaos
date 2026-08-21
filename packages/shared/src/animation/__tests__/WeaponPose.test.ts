import { describe, it, expect } from 'vitest';
import {
  solveWeaponPosition,
  computeWeaponSegment,
  CARRY_TILT,
  FIST_SEGMENT_LENGTH,
  type WeaponPositionInput,
} from '../WeaponPose.js';

function baseInput(overrides: Partial<WeaponPositionInput>): WeaponPositionInput {
  return {
    leftHand: { x: 36, y: -62 },
    rightHand: { x: 38, y: 60 },
    bodyX: 0,
    bodyY: 0,
    angle: 0,
    handOffset: 10,
    rotOffset: Math.PI / 2,
    strategy: 'radial-right',
    ...overrides,
  };
}

describe('solveWeaponPosition', () => {
  it('radial-right at attackBlend=1 points from body through right hand', () => {
    const input = baseInput({ rightHand: { x: 50, y: 0 }, attackBlend: 1 });
    const out = solveWeaponPosition(input);
    expect(out.pointAngle).toBeCloseTo(0, 10);
    expect(out.x).toBeCloseTo(60, 10); // hand + handOffset along pointAngle
    expect(out.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('radial-right at attackBlend=0 uses carry tilt', () => {
    const input = baseInput({ rightHand: { x: 50, y: 0 }, attackBlend: 0 });
    const out = solveWeaponPosition(input);
    expect(out.pointAngle).toBeCloseTo(CARRY_TILT, 10);
  });

  it('along-hands runs butt→grip through both hands', () => {
    const input = baseInput({
      strategy: 'along-hands',
      leftHand: { x: 80, y: 0 },
      rightHand: { x: 20, y: 0 },
      handOffset: 0,
    });
    const out = solveWeaponPosition(input);
    expect(out.pointAngle).toBeCloseTo(0, 10);
    expect(out.x).toBeCloseTo(20, 10);
    expect(out.y).toBeCloseTo(0, 10);
  });
});

describe('computeWeaponSegment', () => {
  it('blade extends bladeLength along pointAngle (radial-right)', () => {
    const input = baseInput({ rightHand: { x: 50, y: 0 }, attackBlend: 1 });
    const pos = solveWeaponPosition(input);
    const seg = computeWeaponSegment(pos, input, 100);
    expect(seg.grip.x).toBeCloseTo(60, 10);
    expect(seg.tip.x).toBeCloseTo(160, 10);
    expect(seg.tip.y).toBeCloseTo(0, 10);
  });

  it('shield face spans perpendicular to facing (follow-both-hands)', () => {
    const input = baseInput({
      strategy: 'follow-both-hands',
      leftHand: { x: 60, y: -26 },
      rightHand: { x: 60, y: 26 },
      angle: 0,
      handOffset: 0,
    });
    const pos = solveWeaponPosition(input);
    const seg = computeWeaponSegment(pos, input, 80);
    // Face centered at hand midpoint (60, 0), spanning ±40 in Y
    expect(seg.grip.x).toBeCloseTo(60, 6);
    expect(seg.tip.x).toBeCloseTo(60, 6);
    expect(Math.abs(seg.tip.y - seg.grip.y)).toBeCloseTo(80, 6);
  });

  it('fists use the forward-most hand with a short reach segment', () => {
    const input = baseInput({
      strategy: 'hidden',
      leftHand: { x: 45, y: -58 },
      rightHand: { x: 90, y: 42 }, // punching hand (further forward)
      angle: 0,
      handOffset: 0,
    });
    const pos = solveWeaponPosition(input);
    const seg = computeWeaponSegment(pos, input, 0);
    expect(seg.grip.x).toBe(90);
    expect(seg.grip.y).toBe(42);
    const len = Math.hypot(seg.tip.x - seg.grip.x, seg.tip.y - seg.grip.y);
    expect(len).toBeCloseTo(FIST_SEGMENT_LENGTH, 6);
    // Tip extends outward (away from body)
    expect(Math.hypot(seg.tip.x, seg.tip.y)).toBeGreaterThan(Math.hypot(90, 42));
  });
});
