import { describe, it, expect } from 'vitest';
import { BotContext } from '../../../src/ai/BotContext.ts';
import {
  underProjectileFire,
  weaveSide,
  weaveMoveAngle,
  seedWeaveFromReaction,
  strafeDirFor,
  WEAVE_MIN_COMMIT_TICKS,
  WEAVE_MAX_COMMIT_TICKS,
} from '../../../src/ai/combat/BotCombatWeave.ts';
import { normalizeAngle } from '@sector-battle/shared';
import type { EnemyInfo } from '../../../src/ai/BotContext.ts';
import { WeaponType } from '@sector-battle/shared';

/**
 * Sticky weave — the pure seam (DEC-010.1): commitment window bounds,
 * direction stickiness (per-bot RNG draw, NO per-tick re-weaving), the
 * perpendicular math, the reactor handoff, and the under-fire predicate.
 */

function makeCtx(): BotContext {
  const ctx = new BotContext('weave-bot');
  ctx.tick = 1000;
  ctx.x = 0;
  ctx.y = 0;
  return ctx;
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 300,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 300,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.FISTS,
    weaponTier: 0,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    facingAngle: 0,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

describe('underProjectileFire', () => {
  it('true for a closing projectile inside the range', () => {
    const ctx = makeCtx();
    ctx.projectiles.push({ id: 'p1', x: -300, y: 0, vx: 600, vy: 0, distance: 300 });
    expect(underProjectileFire(ctx)).toBe(true);
  });

  it('false for a receding projectile (dot <= 0)', () => {
    const ctx = makeCtx();
    ctx.projectiles.push({ id: 'p1', x: 300, y: 0, vx: 600, vy: 0, distance: 300 });
    expect(underProjectileFire(ctx)).toBe(false);
  });

  it('false beyond the range and with no projectiles', () => {
    const ctx = makeCtx();
    expect(underProjectileFire(ctx)).toBe(false);
    ctx.projectiles.push({ id: 'p1', x: -5000, y: 0, vx: 600, vy: 0, distance: 5000 });
    expect(underProjectileFire(ctx)).toBe(false);
  });
});

describe('weaveSide — commitment window bounds + stickiness', () => {
  it('draws a side in {+1, -1} and a window within [min, max]', () => {
    // 200 draws across many ticks/windows: every side is ±1 and every
    // committed window lands inside the DEC-010.1 0.5-1 s band.
    for (let i = 0; i < 200; i++) {
      const ctx = new BotContext(`weave-${i}`);
      ctx.tick = 100;
      const side = weaveSide(ctx);
      expect(side === 1 || side === -1).toBe(true);
      const window = ctx.combat.weaveUntilTick - ctx.tick;
      expect(window).toBeGreaterThanOrEqual(WEAVE_MIN_COMMIT_TICKS);
      expect(window).toBeLessThanOrEqual(WEAVE_MAX_COMMIT_TICKS);
    }
  });

  it('does NOT re-draw inside the window (the anti-jitterbug gate)', () => {
    const ctx = makeCtx();
    const first = weaveSide(ctx);
    const until = ctx.combat.weaveUntilTick;
    // Advance to the last tick INSIDE the window: same side, no RNG consumed
    // by weaveSide (window unchanged).
    ctx.tick = until - 1;
    expect(weaveSide(ctx)).toBe(first);
    expect(ctx.combat.weaveUntilTick).toBe(until);
    // At/after expiry a fresh commitment (possibly the same side value, but a
    // NEW window) is drawn.
    ctx.tick = until;
    weaveSide(ctx);
    expect(ctx.combat.weaveUntilTick).toBeGreaterThan(until);
  });

  it('bumps pending telemetry once per fresh commitment', () => {
    const ctx = makeCtx();
    weaveSide(ctx);
    expect(ctx.combat.pendingWeaveCommits).toBe(1);
    expect(ctx.combat.pendingWeaveCommitTicks).toBe(ctx.combat.weaveUntilTick - ctx.tick);
    weaveSide(ctx); // same window — no second bump
    expect(ctx.combat.pendingWeaveCommits).toBe(1);
  });
});

describe('weaveMoveAngle', () => {
  it('is perpendicular to the threat axis on the committed side', () => {
    const ctx = makeCtx();
    const side = weaveSide(ctx);
    const a = weaveMoveAngle(ctx, 0); // threat along +X
    expect(a).toBeCloseTo(normalizeAngle((side * Math.PI) / 2), 10);
  });
});

describe('seedWeaveFromReaction — the reactor handoff', () => {
  it('adopts the dodge side with a full fresh window', () => {
    const ctx = makeCtx();
    seedWeaveFromReaction(ctx, -1);
    expect(ctx.combat.weaveDir).toBe(-1);
    const window = ctx.combat.weaveUntilTick - ctx.tick;
    expect(window).toBeGreaterThanOrEqual(WEAVE_MIN_COMMIT_TICKS);
    expect(window).toBeLessThanOrEqual(WEAVE_MAX_COMMIT_TICKS);
    // weaveSide continues the SEEDED side inside the window (the readable
    // dodge→strafe continuation).
    expect(weaveSide(ctx)).toBe(-1);
  });
});

describe('strafeDirFor — the combat seam', () => {
  it('uses the sticky weave under projectile fire', () => {
    const ctx = makeCtx();
    ctx.projectiles.push({ id: 'p1', x: -300, y: 0, vx: 600, vy: 0, distance: 300 });
    const side = strafeDirFor(ctx, enemy());
    expect(side).toBe(ctx.combat.weaveDir);
    expect(side === 1 || side === -1).toBe(true);
  });

  it('falls back to the legacy strafe window when not under fire', () => {
    const ctx = makeCtx();
    const side = strafeDirFor(ctx, enemy());
    expect(side).toBe(ctx.strafeDir); // legacy pick assigned the field
    expect(side === 1 || side === -1).toBe(true);
    // Legacy window: 20-45 ticks (unchanged behavior off-fire).
    expect(ctx.strafeUntilTick - ctx.tick).toBeGreaterThanOrEqual(20);
    expect(ctx.strafeUntilTick - ctx.tick).toBeLessThanOrEqual(45);
  });
});
