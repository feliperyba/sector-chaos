import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import type { EnemyInfo } from '../../../src/ai/BotContext.ts';
import {
  RecentDamageTracker,
  RECENT_DAMAGE_WINDOW_TICKS,
  RECENT_DAMAGE_CAP_HP,
} from '../../../src/ai/combat/BotRecentDamage.ts';

/**
 * Per-enemy recent-damage tracking — the restored GDD §14.8 term's feed
 * (DEC-010.6): per-scan health drops accumulate; the window (5 s) and the
 * 100-HP normalization cap shape the targeting bias.
 */

function enemy(id: string, health: number): EnemyInfo {
  return {
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 100,
    health,
    maxHealth: 100,
    weaponType: WeaponType.DAGGER,
    weaponTier: 1,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    facingAngle: 0,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
  };
}

describe('RecentDamageTracker', () => {
  it('accumulates observed health drops across scans', () => {
    const t = new RecentDamageTracker();
    t.noteScan([enemy('a', 100)], 0);
    t.noteScan([enemy('a', 70)], 3); // −30
    t.noteScan([enemy('a', 40)], 6); // −30 more
    expect(t.normalized('a', 6)).toBeCloseTo(0.6, 10); // 60/100
  });

  it('caps at 1.0 (100 HP within the window)', () => {
    const t = new RecentDamageTracker();
    t.noteScan([enemy('a', 100)], 0);
    t.noteScan([enemy('a', 10)], 10); // −90
    t.noteScan([enemy('a', 5)], 12); // −5 → 95 total
    t.noteScan([enemy('a', 1)], 14); // −4 → 99
    t.noteScan([enemy('a', 0)], 16); // −1 → 100
    expect(t.normalized('a', 16)).toBe(1);
  });

  it('ages events out of the 5s window', () => {
    const t = new RecentDamageTracker();
    t.noteScan([enemy('a', 100)], 0);
    t.noteScan([enemy('a', 50)], 10); // −50 at tick 10
    expect(t.normalized('a', 10 + RECENT_DAMAGE_WINDOW_TICKS - 1)).toBeCloseTo(0.5, 10);
    expect(t.normalized('a', 10 + RECENT_DAMAGE_WINDOW_TICKS)).toBe(0);
  });

  it('heals clamp to zero (a healed enemy is not weakened)', () => {
    const t = new RecentDamageTracker();
    t.noteScan([enemy('a', 100)], 0);
    t.noteScan([enemy('a', 60)], 5); // −40
    t.noteScan([enemy('a', 100)], 10); // healed +40 → no event
    expect(t.normalized('a', 10)).toBeCloseTo(0.4, 10); // only the real damage
  });

  it('unknown enemies read 0 and clear() drops the bookkeeping', () => {
    const t = new RecentDamageTracker();
    expect(t.normalized('ghost', 0)).toBe(0);
    t.noteScan([enemy('a', 100)], 0);
    t.noteScan([enemy('a', 80)], 5);
    expect(t.normalized('a', 5)).toBeCloseTo(0.2, 10);
    t.clear('a');
    expect(t.normalized('a', 5)).toBe(0);
  });

  it('the window and cap are the GDD §14.8 values', () => {
    expect(RECENT_DAMAGE_WINDOW_TICKS).toBe(300); // "last 5s" at 60 t/s
    expect(RECENT_DAMAGE_CAP_HP).toBe(100); // "cap: 100 HP = 1.0"
  });
});
