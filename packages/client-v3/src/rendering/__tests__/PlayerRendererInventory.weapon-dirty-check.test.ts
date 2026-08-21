/**
 * Ticket 20 — updateWeapon dirty-check branch matrix.
 *
 * WHY THIS SEAM:
 * `PlayerVisualSync.handlePlayerChange` calls `updateWeapon` for every
 * non-dead player on every 60Hz patch (~64 players ⇒ ~3,840 calls/sec), and
 * the armed branch unconditionally re-applied ~6 texture/sprite ops
 * (setTexture/setScale/setOrigin/setFlipX/setTint + the idempotent C1
 * re-show) even when weapon/tier were unchanged. Ticket 20 gates the body on
 * the (equippedWeaponType, lastTier, weaponHidden) change-key.
 *
 * THE CRITICAL CONSTRAINT (behavior, not redundancy):
 * the C1/D1 throw/break branches MUST stay reachable exactly as before —
 * PlayerRenderer.hide.test.ts pins them end-to-end through PlayerRenderer;
 * this file pins the FULL branch matrix at the exported-function level with
 * COUNTING stubs, so "zero redundant ops" and "every state transition still
 * applies its ops" are both asserted:
 *
 *   armed steady       → zero sprite ops, no driver.setWeapon
 *   tier change        → ops re-applied (tint), no driver churn
 *   type change        → ops + driver.setWeapon(newType)
 *   hidden + stale     → ops re-applied but NO re-show (C1 stale-patch gate)
 *   hidden + re-equip  → re-show + driver.setWeapon (C1 genuine path)
 *   armed → empty      → hide + driver.setWeapon(FISTS) once (D1/B1)
 *   empty steady       → zero sprite ops, no driver call
 *
 * `updateWeapon` is exported standalone (InventoryContext is injectable), so
 * no Phaser-bound PlayerRenderer construction is needed — a recording weapon
 * sprite + driver stub suffice (jsdom-clean, like PlayerRenderer.hide.test).
 */
import { describe, it, expect, vi } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { updateWeapon, hideWeapon } from '../PlayerRendererInventory.js';
import type { InventoryContext } from '../PlayerRendererInventory.js';
import type { PlayerState } from '../../types.js';
import type { PlayerRenderBundle, PlayerVisual } from '../PlayerRendererTypes.js';

interface OpCounts {
  setTexture: number;
  setScale: number;
  setOrigin: number;
  setFlipX: number;
  setTint: number;
  setAlpha: number;
  setVisible: number;
}

/** Recording weapon sprite: counts every mutator, tracks visible/alpha state. */
function makeCountingWeaponSprite() {
  const calls: OpCounts = {
    setTexture: 0,
    setScale: 0,
    setOrigin: 0,
    setFlipX: 0,
    setTint: 0,
    setAlpha: 0,
    setVisible: 0,
  };
  const state = { visible: false, alpha: 0 };
  const sprite = {
    state,
    calls,
    setTexture: () => {
      calls.setTexture++;
      return sprite;
    },
    setScale: () => {
      calls.setScale++;
      return sprite;
    },
    setOrigin: () => {
      calls.setOrigin++;
      return sprite;
    },
    setFlipX: () => {
      calls.setFlipX++;
      return sprite;
    },
    setTint: () => {
      calls.setTint++;
      return sprite;
    },
    setAlpha: (a: number) => {
      calls.setAlpha++;
      state.alpha = a;
      return sprite;
    },
    setVisible: (v: boolean) => {
      calls.setVisible++;
      state.visible = v;
      return sprite;
    },
    setRotation: () => sprite,
    setPosition: () => sprite,
    destroy: () => {},
  };
  return sprite;
}

type WeaponSpriteStub = ReturnType<typeof makeCountingWeaponSprite>;

/** Minimal PlayerVisual carrying exactly the updateWeapon dirty-check state. */
function makeVisual(sprite: WeaponSpriteStub): PlayerVisual {
  return {
    weapon: sprite as unknown as PlayerVisual['weapon'],
    equippedWeaponType: -1,
    lastTier: -1,
    weaponHidden: true, // mirrors the factory's unarmed init (!hasWeapon)
  } as unknown as PlayerVisual;
}

function makePlayerWithWeapon(weaponType: number, tier = 0, slot = 0): PlayerState {
  return {
    activeSlot: slot,
    weapons: [{ id: 'w0', weaponType, tier, ammo: 10, maxAmmo: 10 }],
  } as unknown as PlayerState;
}

function makeEmptySlotPlayer(): PlayerState {
  return {
    activeSlot: 0,
    weapons: [{ id: '', weaponType: 0, tier: 0, ammo: 0, maxAmmo: 0 }],
  } as unknown as PlayerState;
}

interface Harness {
  ctx: InventoryContext;
  sprite: WeaponSpriteStub;
  visual: PlayerVisual;
  driverSetWeapon: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const sprite = makeCountingWeaponSprite();
  const visual = makeVisual(sprite);
  const driverSetWeapon = vi.fn();
  const ctx = {
    bundles: new Map<string, PlayerRenderBundle>([
      ['p1', { visual, driver: { setWeapon: driverSetWeapon } } as unknown as PlayerRenderBundle],
    ]),
    // `has() → true` so the setTexture branch is exercised and counted.
    scene: { textures: { get: () => ({ has: () => true }) } },
    armRenderer: {},
    trailRenderer: {},
  } as unknown as InventoryContext;
  return { ctx, sprite, visual, driverSetWeapon };
}

/** Zero all op counters + the driver mock (call AFTER setup steps). */
function resetOps(h: Harness): void {
  for (const k of Object.keys(h.sprite.calls) as (keyof OpCounts)[]) h.sprite.calls[k] = 0;
  h.driverSetWeapon.mockClear();
}

const W = WeaponType.DAGGER;
const X = WeaponType.LONG_SWORD;

function totalOps(c: OpCounts): number {
  return (
    c.setTexture + c.setScale + c.setOrigin + c.setFlipX + c.setTint + c.setAlpha + c.setVisible
  );
}

describe('ticket 20 — updateWeapon dirty-check branch matrix', () => {
  it('armed steady state: repeated identical patches perform ZERO sprite ops', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    expect(totalOps(h.sprite.calls)).toBeGreaterThan(0); // first apply styles + shows
    expect(h.driverSetWeapon).toHaveBeenCalledTimes(1);
    resetOps(h);

    // Steady state: same weapon, same tier, no hide in effect.
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    expect(totalOps(h.sprite.calls)).toBe(0);
    expect(h.driverSetWeapon).not.toHaveBeenCalled();
    expect(h.sprite.state.visible).toBe(true);
    expect(h.visual.weaponHidden).toBe(false);
  });

  it('tier change re-applies the ops (tint is tier-colored) without driver churn', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    resetOps(h);

    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 2));
    expect(h.sprite.calls.setTexture).toBe(1);
    expect(h.sprite.calls.setScale).toBe(1);
    expect(h.sprite.calls.setOrigin).toBe(1);
    expect(h.sprite.calls.setFlipX).toBe(1);
    expect(h.sprite.calls.setTint).toBe(1);
    expect(h.driverSetWeapon).not.toHaveBeenCalled(); // same weaponType
    expect(h.visual.lastTier).toBe(2);
    // ...and the new (weapon, tier) pair is now steady:
    resetOps(h);
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 2));
    expect(totalOps(h.sprite.calls)).toBe(0);
  });

  it('weapon-type change re-applies ops AND calls driver.setWeapon', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    resetOps(h);

    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(X, 1));
    expect(h.sprite.calls.setTexture).toBe(1);
    expect(h.sprite.calls.setScale).toBe(1);
    expect(h.driverSetWeapon).toHaveBeenCalledTimes(1);
    expect(h.driverSetWeapon).toHaveBeenCalledWith(X);
    expect(h.visual.equippedWeaponType).toBe(X);
    expect(h.sprite.state.visible).toBe(true);
  });

  it('C1 preserved: hidden weapon + STALE same-weapon patch does NOT re-show', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    hideWeapon(h.ctx, 'p1');
    expect(h.sprite.state.visible).toBe(false);
    expect(h.visual.weaponHidden).toBe(true);
    resetOps(h);

    // Stale patch carrying the same pre-event weapon (slot-clear lags ≥1 RTT).
    // The dirty-check deliberately FAILS on weaponHidden so this branch stays
    // reachable — ops re-apply, but the C1 gate suppresses the re-show.
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    expect(h.sprite.calls.setTint).toBe(1); // ops ran (dirty on weaponHidden)
    expect(h.sprite.calls.setVisible).toBe(0); // ...but no re-show
    expect(h.sprite.calls.setAlpha).toBe(0);
    expect(h.sprite.state.visible).toBe(false);
    expect(h.visual.weaponHidden).toBe(true);
    expect(h.visual.equippedWeaponType).toBe(W);
    expect(h.driverSetWeapon).not.toHaveBeenCalled(); // same weaponType
  });

  it('C1 preserved: hidden weapon + tier change while hidden still does NOT re-show', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    hideWeapon(h.ctx, 'p1');

    // The C1 gate keys on weaponType only (pre-ticket-20 behavior) — a tier
    // change on a hidden weapon must not resurrect the sprite.
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 3));
    expect(h.sprite.state.visible).toBe(false);
    expect(h.visual.weaponHidden).toBe(true);
  });

  it('C1 preserved: genuine re-equip (different weaponType) re-shows', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    hideWeapon(h.ctx, 'p1');

    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(X, 1));
    expect(h.sprite.state.visible).toBe(true);
    expect(h.sprite.state.alpha).toBe(1);
    expect(h.visual.weaponHidden).toBe(false);
    expect(h.driverSetWeapon).toHaveBeenCalledWith(X);
  });

  it('D1/B1 preserved: armed → empty transition hides + switches driver to FISTS once', () => {
    const h = makeHarness();
    updateWeapon(h.ctx, 'p1', makePlayerWithWeapon(W, 1));
    resetOps(h);

    updateWeapon(h.ctx, 'p1', makeEmptySlotPlayer());
    expect(h.sprite.calls.setAlpha).toBe(1); // the D1 secondary-defense hide
    expect(h.sprite.calls.setVisible).toBe(1);
    expect(h.sprite.state.visible).toBe(false);
    expect(h.sprite.state.alpha).toBe(0);
    expect(h.visual.weaponHidden).toBe(true);
    expect(h.visual.equippedWeaponType).toBe(-1);
    expect(h.driverSetWeapon).toHaveBeenCalledTimes(1);
    expect(h.driverSetWeapon).toHaveBeenCalledWith(WeaponType.FISTS);
  });

  it('empty steady state: repeated empty patches perform ZERO sprite ops', () => {
    const h = makeHarness();
    // Init state IS empty (equippedWeaponType -1 + weaponHidden) — the first
    // call exercises the empty-branch early-out, exactly like a steady patch.
    updateWeapon(h.ctx, 'p1', makeEmptySlotPlayer());
    resetOps(h);

    updateWeapon(h.ctx, 'p1', makeEmptySlotPlayer());
    updateWeapon(h.ctx, 'p1', makeEmptySlotPlayer());
    expect(totalOps(h.sprite.calls)).toBe(0);
    expect(h.driverSetWeapon).not.toHaveBeenCalled();
    expect(h.sprite.state.visible).toBe(false);
  });
});
