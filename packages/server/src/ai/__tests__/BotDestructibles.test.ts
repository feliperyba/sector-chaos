import { describe, it, expect } from 'vitest';
import { isBarrel, isCrate, isWall, packGridKey } from '../BotDestructibles.ts';

/**
 * Truth table for the destructible-type taxonomy, transcribed verbatim from
 * the pre-consolidation check sites (see BotDestructibles.ts header for the
 * dual-form analysis). Every predicate must reproduce the OLD behavior:
 *
 *  - DTO-form sites accepted BOTH the lowercase entity form and the uppercase
 *    enum-name form: `t !== 'barrel' && t !== 'DESTRUCTIBLE_BARREL'` etc.
 *  - Danger-form sites used bare `t === 'barrel'`; the danger domain is
 *    {'barrel'} ∪ String(TrapType) = {'barrel','0','1','2'}, on which the
 *    dual-form isBarrel is identical to the bare equality.
 */
describe('destructible taxonomy', () => {
  it('isBarrel accepts both barrel forms and rejects every other type', () => {
    expect(isBarrel('barrel')).toBe(true);
    expect(isBarrel('DESTRUCTIBLE_BARREL')).toBe(true);
    // Every other destructible type string (entity union + enum-name aliases).
    expect(isBarrel('crate')).toBe(false);
    expect(isBarrel('DESTRUCTIBLE_CRATE')).toBe(false);
    expect(isBarrel('wall')).toBe(false);
    expect(isBarrel('DESTRUCTIBLE_WALL')).toBe(false);
    expect(isBarrel('iron')).toBe(false);
    // Danger-domain non-barrel values (String(TrapType)).
    expect(isBarrel('0')).toBe(false);
    expect(isBarrel('1')).toBe(false);
    expect(isBarrel('2')).toBe(false);
  });

  it('isCrate accepts both crate forms and rejects every other type', () => {
    expect(isCrate('crate')).toBe(true);
    expect(isCrate('DESTRUCTIBLE_CRATE')).toBe(true);
    expect(isCrate('barrel')).toBe(false);
    expect(isCrate('DESTRUCTIBLE_BARREL')).toBe(false);
    expect(isCrate('wall')).toBe(false);
    expect(isCrate('DESTRUCTIBLE_WALL')).toBe(false);
    expect(isCrate('iron')).toBe(false);
  });

  it('isWall accepts both wall forms and rejects every other type', () => {
    expect(isWall('wall')).toBe(true);
    expect(isWall('DESTRUCTIBLE_WALL')).toBe(true);
    expect(isWall('crate')).toBe(false);
    expect(isWall('barrel')).toBe(false);
    expect(isWall('iron')).toBe(false);
  });

  it('packGridKey produces keys identical to the former gy*10000+gx scheme', () => {
    expect(packGridKey(0, 0)).toBe(0);
    expect(packGridKey(3, 7)).toBe(7 * 10000 + 3);
    expect(packGridKey(9999, 0)).toBe(9999);
    expect(packGridKey(0, 1)).toBe(10000);
    // Offset forms (former `(gy + dy) * 10000 + (gx + dx)` sites).
    expect(packGridKey(5 + 1, 9 + (-1))).toBe(8 * 10000 + 6);
    // Round-trips against the inline unpack in PathfinderSearch.
    const key = packGridKey(42, 17);
    expect(key % 10000).toBe(42);
    expect((key / 10000) | 0).toBe(17);
  });
});
