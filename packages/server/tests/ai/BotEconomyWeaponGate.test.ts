import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext } from '../../src/ai/BotContext.ts';
import { isWeaponUpgrade, isAtDropSite } from '../../src/ai/BotEconomyExecutors.ts';
import type { ItemInfo } from '../../src/ai/BotContext.ts';
import { PICKUP_RADIUS } from '../../src/ai/BotSystemConstants.ts';

/**
 * Regression tests for the bot swap-grab loop fix.
 *
 * The bug: a full-inventory bot picks up a floor weapon → server swaps the
 * held weapon and drops it at the bot's feet → bot perceives the just-dropped
 * weapon as nearestWeapon next tick → picks it up again → infinite A↔B loop.
 *
 * The fix has two layers:
 * 1. isWeaponUpgrade — gates weapon nomination on genuine improvement
 *    (tier upgrade, or role-fill only when there's an empty slot to avoid
 *    the swap opening the very gap it fills)
 * 2. isAtDropSite — skips weapons at the bot's last full-inventory pickup
 *    position (the drop site) for a cooldown window
 */

function makeBotContext(weapons: (BotContext['weapons'][number] | null)[]): BotContext {
  const ctx = new BotContext('bot_test');
  ctx.weapons = weapons;
  ctx.activeSlot = weapons.findIndex((w) => w !== null && w.weaponType !== WeaponType.FISTS);
  if (ctx.activeSlot < 0) ctx.activeSlot = 0;
  return ctx;
}

function makeFloorWeapon(
  weaponType: WeaponType,
  tier: number,
  x = 0,
  y = 0,
  id = 'floor_1',
): ItemInfo {
  return {
    id,
    x,
    y,
    distance: 10,
    type: 'weapon',
    tier,
    weaponType,
  };
}

describe('isWeaponUpgrade — swap-grab loop gate', () => {
  it('tier upgrade: always nominates even with full inventory', () => {
    // Bot holds a tier-1 sword (melee), inventory full. Floor has tier-2 sword.
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.DAGGER, tier: 1, durability: 100, ammo: 100 },
    ]);
    const floor = makeFloorWeapon(WeaponType.LONG_SWORD, 2);

    expect(isWeaponUpgrade(ctx, floor)).toBe(true);
  });

  it('equal tier + different role + FULL inventory: does NOT nominate (prevents loop)', () => {
    // Bot holds melee + ranged (both covered), inventory full. Floor has an
    // equal-tier ranged weapon. Picking it up would swap out a weapon, and
    // the role-diversity gate requires an empty slot — so this is NOT an upgrade.
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.DAGGER, tier: 1, durability: 100, ammo: 100 },
    ]);
    const floor = makeFloorWeapon(WeaponType.CROSSBOW, 1); // ranged, same tier

    // This is the exact loop scenario: equal tier, different role, full inv.
    expect(isWeaponUpgrade(ctx, floor)).toBe(false);
  });

  it('equal tier + missing role + EMPTY slot: nominates (role-fill, no swap)', () => {
    // Bot holds only melee (ranged gap), has an empty slot. Floor has an
    // equal-tier bow. Picking it up fills the empty slot — no swap, no loop.
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      null, // empty slot
      null, // empty slot
    ]);
    const floor = makeFloorWeapon(WeaponType.SHORT_BOW, 1); // ranged, fills gap

    expect(isWeaponUpgrade(ctx, floor)).toBe(true);
  });

  it('lower tier: does NOT nominate (downgrade)', () => {
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.LONG_SWORD, tier: 2, durability: 100, ammo: 100 },
      null,
      null,
    ]);
    const floor = makeFloorWeapon(WeaponType.SHORT_SWORD, 1); // lower tier

    expect(isWeaponUpgrade(ctx, floor)).toBe(false);
  });

  it('broken weapon (ammo=0) does not count for role coverage', () => {
    // Bot "has" a bow but it's broken (ammo=0). Floor bow should count as
    // filling the ranged gap — loadoutHasRole skips broken weapons.
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 0, ammo: 0 }, // broken
      null,
    ]);
    const floor = makeFloorWeapon(WeaponType.SHORT_BOW, 1);

    expect(isWeaponUpgrade(ctx, floor)).toBe(true);
  });
});

describe('isAtDropSite — drop-site cooldown', () => {
  it('weapon at recent pickup position: detected as drop site', () => {
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 100, ammo: 100 },
      { weaponType: WeaponType.DAGGER, tier: 1, durability: 100, ammo: 100 },
    ]);
    ctx.tick = 1000;
    ctx.lastFullPickupTick = 1000; // just picked up
    ctx.lastFullPickupX = 500;
    ctx.lastFullPickupY = 500;

    const droppedWeapon = makeFloorWeapon(WeaponType.SHORT_SWORD, 1, 500, 510, 'dropped');
    expect(isAtDropSite(ctx, droppedWeapon)).toBe(true);
  });

  it('weapon far from pickup position: not a drop site', () => {
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      null,
      null,
    ]);
    ctx.tick = 1000;
    ctx.lastFullPickupTick = 1000;
    ctx.lastFullPickupX = 500;
    ctx.lastFullPickupY = 500;

    const farWeapon = makeFloorWeapon(WeaponType.SHORT_SWORD, 1, 700, 700, 'far');
    expect(isAtDropSite(ctx, farWeapon)).toBe(false);
  });

  it('weapon at OLD pickup position (past cooldown): not a drop site', () => {
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      null,
      null,
    ]);
    // Cooldown is 180 ticks (3s). Pickup was 200 ticks ago — expired.
    ctx.tick = 1200;
    ctx.lastFullPickupTick = 1000;
    ctx.lastFullPickupX = 500;
    ctx.lastFullPickupY = 500;

    const oldDrop = makeFloorWeapon(WeaponType.SHORT_SWORD, 1, 500, 500, 'old_drop');
    expect(isAtDropSite(ctx, oldDrop)).toBe(false);
  });

  it('boundary: weapon exactly at PICKUP_RADIUS from drop site', () => {
    const ctx = makeBotContext([
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.SHORT_SWORD, tier: 1, durability: 100, ammo: 100 },
      null,
      null,
    ]);
    ctx.tick = 1000;
    ctx.lastFullPickupTick = 1000;
    ctx.lastFullPickupX = 500;
    ctx.lastFullPickupY = 500;

    // Exactly PICKUP_RADIUS away on x-axis
    const edgeWeapon = makeFloorWeapon(WeaponType.SHORT_SWORD, 1, 500 + PICKUP_RADIUS, 500, 'edge');
    expect(isAtDropSite(ctx, edgeWeapon)).toBe(true);
  });
});
