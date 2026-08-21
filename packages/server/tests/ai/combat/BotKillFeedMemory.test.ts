import { describe, it, expect } from 'vitest';
import {
  KillFeedMemory,
  DANGER_HALF_LIFE_TICKS,
  SAFE_LOOT_WINDOW_TICKS,
} from '../../../src/ai/combat/BotKillFeedMemory.ts';

/**
 * Kill-feed awareness memory — the pure seam (DEC-010.4): exponential sector
 * decay, cluster accumulation, the linear safe-loot bias, and the
 * quiet-side interaction (danger memory bends the quiet-side candidate away
 * from the killing field — verified through scoreMacroGoals).
 */

const MAP_W = 8000;
const MAP_H = 8000;

describe('KillFeedMemory — decaying sector danger', () => {
  it('starts at zero everywhere', () => {
    const mem = new KillFeedMemory();
    expect(mem.dangerAt(4000, 4000, 100)).toBe(0);
  });

  it('accumulates clustered deaths in one sector', () => {
    const mem = new KillFeedMemory();
    mem.noteElimination(1000, 1000, MAP_W, MAP_H, 100);
    mem.noteElimination(1050, 1050, MAP_W, MAP_H, 110);
    expect(mem.dangerAt(1000, 1000, 110)).toBeCloseTo(2, 1); // 1 decayed (~0.995) + 1
    // A different sector is unaffected.
    expect(mem.dangerAt(7000, 7000, 110)).toBe(0);
  });

  it('decays exponentially off the write anchor (half-life)', () => {
    const mem = new KillFeedMemory();
    mem.noteElimination(1000, 1000, MAP_W, MAP_H, 0);
    const atHalf = mem.dangerAt(1000, 1000, DANGER_HALF_LIFE_TICKS);
    expect(atHalf).toBeCloseTo(0.5, 5);
    const atQuarter = mem.dangerAt(1000, 1000, DANGER_HALF_LIFE_TICKS * 2);
    expect(atQuarter).toBeCloseTo(0.25, 5);
    // Reads never compound: repeated reads at the same tick are identical.
    expect(mem.dangerAt(1000, 1000, DANGER_HALF_LIFE_TICKS)).toBeCloseTo(atHalf, 12);
  });

  it('memory survives match-long spans (still > 0 after several half-lives)', () => {
    const mem = new KillFeedMemory();
    mem.noteElimination(1000, 1000, MAP_W, MAP_H, 0);
    expect(mem.dangerAt(1000, 1000, DANGER_HALF_LIFE_TICKS * 5)).toBeGreaterThan(0.03);
  });
});

describe('KillFeedMemory — safe-loot window bias', () => {
  it('opens at bias 1 and fades linearly to 0 across the window', () => {
    const mem = new KillFeedMemory();
    mem.noteElimination(2000, 3000, MAP_W, MAP_H, 500);
    const t0 = mem.safeLootTarget(500);
    expect(t0).not.toBeNull();
    expect(t0!.bias).toBeCloseTo(1, 10);
    expect(t0!.x).toBe(2000);
    expect(t0!.y).toBe(3000);
    const mid = mem.safeLootTarget(500 + SAFE_LOOT_WINDOW_TICKS / 2);
    expect(mid!.bias).toBeCloseTo(0.5, 10);
    // Window closed → null (no stale-corpse biasing).
    expect(mem.safeLootTarget(500 + SAFE_LOOT_WINDOW_TICKS)).toBeNull();
    expect(mem.safeLootTarget(499)).toBeNull(); // before the kill: nothing
  });
});
