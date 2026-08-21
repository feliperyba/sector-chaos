import { describe, it, expect } from 'vitest';
import { WeaponType, InputAction } from '@sector-battle/shared';
import { BotContext } from '../../../src/ai/BotContext.ts';
import type { EnemyInfo } from '../../../src/ai/BotContext.ts';
import {
  reactToWeaponBreak,
  weaponBrokeBetween,
  WEAPON_BREAK_FRESH_TICKS,
} from '../../../src/ai/combat/WeaponBreakReaction.ts';
import { readInputReason } from '../../../src/ai/BotInput.ts';

/**
 * Weapon-break reaction — the executor seam (DEC-010.7): the detection
 * predicate over the held slot's before/after view, and the immediate
 * visible response (forced switch when a spare exists; fighting withdrawal
 * + forced re-evaluation otherwise).
 */

function slot(
  weaponType: WeaponType,
  ammo: number,
  durability: number,
): { weaponType: WeaponType; tier: number; durability: number; ammo: number } {
  return { weaponType, tier: 1, durability, ammo };
}

const DAGGER = () => slot(WeaponType.DAGGER, 10, 10);
const BROKEN_DAGGER = () => slot(WeaponType.DAGGER, 0, 0);

describe('weaponBrokeBetween — the detection predicate', () => {
  it('fires when the held slot empties', () => {
    expect(weaponBrokeBetween(DAGGER(), null)).toBe(true);
    expect(weaponBrokeBetween(DAGGER(), slot(WeaponType.FISTS, 0, -1))).toBe(true);
  });

  it('fires when the same weapon exhausts in place', () => {
    expect(weaponBrokeBetween(DAGGER(), BROKEN_DAGGER())).toBe(true);
  });

  it('does not fire on intact weapons, FISTS, or already-dead weapons', () => {
    expect(weaponBrokeBetween(DAGGER(), DAGGER())).toBe(false);
    expect(weaponBrokeBetween(null, DAGGER())).toBe(false);
    expect(weaponBrokeBetween(slot(WeaponType.FISTS, 0, -1), null)).toBe(false);
    expect(weaponBrokeBetween(BROKEN_DAGGER(), null)).toBe(false); // no fresh edge
  });

  it('a durability-only weapon breaks when durability hits zero', () => {
    const held = slot(WeaponType.HAMMER, 0, 5);
    expect(weaponBrokeBetween(held, slot(WeaponType.HAMMER, 0, 0))).toBe(true);
  });
});

function makeDeps() {
  let reevaluated = 0;
  return {
    deps: { selectors: new Map([['wb-bot', { forceReevaluate: () => reevaluated++ }]]) },
    reevaluated: () => reevaluated,
  };
}

function makeCtx(): BotContext {
  const ctx = new BotContext('wb-bot');
  ctx.tick = 1000;
  ctx.x = 0;
  ctx.y = 0;
  return ctx;
}

function enemyAt(x: number, y: number): EnemyInfo {
  return {
    id: 'e1',
    x,
    y,
    vx: 0,
    vy: 0,
    distance: Math.hypot(x, y),
    health: 100,
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

describe('reactToWeaponBreak — the executor seam', () => {
  it('switches to the spare immediately (visible forced re-arm)', () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    ctx.weapons = [
      slot(WeaponType.FISTS, 0, -1),
      null, // the broken slot (held)
      slot(WeaponType.SHORT_SWORD, 12, 12), // the spare
      null,
    ];
    ctx.activeSlot = 1;
    ctx.combat.weaponBrokeTick = ctx.tick;
    const inputs = reactToWeaponBreak(deps, ctx);
    expect(inputs).not.toBeNull();
    expect(inputs).toHaveLength(1);
    expect(inputs![0]!.action).toBe(InputAction.SWITCH_SLOT);
    expect(readInputReason(inputs![0]!)).toBe('weapon-break-switch');
    expect((inputs![0]!.data as { slot: number }).slot).toBe(2);
    // Handled: a second call does not react again.
    expect(reactToWeaponBreak(deps, ctx)).toBeNull();
    expect(ctx.combat.pendingWeaponBreakReactions['switch']).toBe(1);
  });

  it('no spare: fighting withdrawal + forced re-evaluation (disengage to re-arm)', () => {
    const { deps, reevaluated } = makeDeps();
    const ctx = makeCtx();
    ctx.weapons = [
      slot(WeaponType.FISTS, 0, -1),
      null, // broken slot (held)
      null,
      null,
    ];
    ctx.activeSlot = 1;
    ctx.combat.weaponBrokeTick = ctx.tick;
    ctx.nearestEnemy = enemyAt(300, 0);
    const inputs = reactToWeaponBreak(deps, ctx);
    expect(inputs).not.toBeNull();
    expect(inputs![0]!.action).toBe(InputAction.MOVE);
    expect(reactToWeaponBreak(deps, ctx)).toBeNull();
    expect(reevaluated()).toBe(1);
    expect(ctx.combat.pendingWeaponBreakReactions['disengage']).toBe(1);
  });

  it('no enemy and no spare: no input, but the re-evaluation still fires', () => {
    const { deps, reevaluated } = makeDeps();
    const ctx = makeCtx();
    ctx.weapons = [slot(WeaponType.FISTS, 0, -1), null, null, null];
    ctx.activeSlot = 1;
    ctx.combat.weaponBrokeTick = ctx.tick;
    expect(reactToWeaponBreak(deps, ctx)).toBeNull();
    expect(reevaluated()).toBe(1);
  });

  it('a stale stamp is not reacted to (freshness window)', () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    ctx.weapons = [slot(WeaponType.FISTS, 0, -1), slot(WeaponType.SHORT_SWORD, 12, 12), null, null];
    ctx.activeSlot = 0;
    ctx.combat.weaponBrokeTick = ctx.tick - WEAPON_BREAK_FRESH_TICKS - 1;
    expect(reactToWeaponBreak(deps, ctx)).toBeNull();
  });
});
