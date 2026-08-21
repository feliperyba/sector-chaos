import { describe, it, expect } from 'vitest';
import { actionsToBitmask, hasAction, bitmaskToActions } from '../bitmask.js';

describe('actionsToBitmask', () => {
  it('returns 0 for empty actions', () => {
    expect(actionsToBitmask([])).toBe(0);
  });

  it('maps ATTACK to bit 1 (0b000010 = 2)', () => {
    expect(actionsToBitmask(['ATTACK'])).toBe(2);
  });

  it('maps DASH to bit 5 (0b100000 = 32)', () => {
    expect(actionsToBitmask(['DASH'])).toBe(32);
  });

  it('maps ATTACK + DASH to 34 (0b100010)', () => {
    expect(actionsToBitmask(['ATTACK', 'DASH'])).toBe(34);
  });

  it('ignores unknown action strings', () => {
    expect(actionsToBitmask(['UNKNOWN'])).toBe(0);
    expect(actionsToBitmask(['ATTACK', 'UNKNOWN'])).toBe(2);
  });

  it('maps all 6 actions to 63 (0b111111)', () => {
    expect(actionsToBitmask(['MOVE', 'ATTACK', 'THROW', 'PICKUP', 'SWITCH_SLOT', 'DASH'])).toBe(63);
  });
});

describe('hasAction', () => {
  it('returns true for DASH in bitmask 34', () => {
    expect(hasAction(34, 'DASH')).toBe(true);
  });

  it('returns false for MOVE in bitmask 34', () => {
    expect(hasAction(34, 'MOVE')).toBe(false);
  });

  it('returns false for unknown action string', () => {
    expect(hasAction(0, 'UNKNOWN')).toBe(false);
  });
});

describe('bitmaskToActions', () => {
  it('returns [] for bitmask 0', () => {
    expect(bitmaskToActions(0)).toEqual([]);
  });

  it('returns ["ATTACK", "DASH"] for bitmask 34', () => {
    expect(bitmaskToActions(34)).toEqual(['ATTACK', 'DASH']);
  });

  it('round-trips: actions → bitmask → actions equals original (minus unknowns)', () => {
    const original = ['MOVE', 'THROW', 'DASH'];
    const roundTripped = bitmaskToActions(actionsToBitmask(original));
    expect(roundTripped).toEqual(['MOVE', 'THROW', 'DASH']);
  });

  it('round-trips with unknowns filtered out', () => {
    const withUnknown = ['ATTACK', 'FAKE_ACTION', 'PICKUP'];
    const roundTripped = bitmaskToActions(actionsToBitmask(withUnknown));
    expect(roundTripped).toEqual(['ATTACK', 'PICKUP']);
  });
});
