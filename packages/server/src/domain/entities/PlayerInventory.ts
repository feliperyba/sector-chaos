import { WeaponEntity } from './Weapon.ts';
import {
  PLAYER,
  WeaponTier,
  COMBAT,
  FISTS_INFINITE_DURABILITY,
  WeaponType,
  NETWORK,
} from '@sector-battle/shared';

/**
 * Inventory and weapon management — stateful domain object.
 * Owns the weapons array, active slot, and switch state.
 *
 * Slot 0 is ALWAYS fists (non-removable). Slots 1-3 hold picked-up weapons.
 */
export class PlayerInventory {
  weapons: (WeaponEntity | null)[];
  activeSlot: number;
  switchTarget: number | null = null;
  switchRemaining: number = 0;
  queuedSlotSwitch: number | null = null;

  constructor() {
    this.weapons = PlayerInventory.createInitialInventory();
    this.activeSlot = 0;
  }

  private static fistsCounter = 0;

  static createInitialInventory(): (WeaponEntity | null)[] {
    const fistsIdCounter = PlayerInventory.fistsCounter++;
    const fistsCooldown = Math.ceil(400 / NETWORK.TICK_INTERVAL); // 400ms in ticks
    const fists = new WeaponEntity(
      `__fists_${fistsIdCounter}`,
      WeaponType.FISTS,
      WeaponTier.COMMON,
      FISTS_INFINITE_DURABILITY,
      FISTS_INFINITE_DURABILITY,
      fistsCooldown,
    );
    return [fists, null, null, null];
  }

  // --- Array access helpers ---

  /** Make inventory iterable over weapons array */
  [Symbol.iterator](): Iterator<WeaponEntity | null> {
    return this.weapons[Symbol.iterator]();
  }

  /** Index access delegates to weapons array */
  get(slot: number): WeaponEntity | null {
    return this.weapons[slot] ?? null;
  }

  set(slot: number, weapon: WeaponEntity | null): void {
    this.weapons[slot] = weapon;
  }

  // --- Weapon management (slot 0 = fists, always protected) ---

  static addWeapon(inventory: (WeaponEntity | null)[], weapon: WeaponEntity): number {
    const slot = PlayerInventory.findFirstEmptySlot(inventory);
    if (slot === null) return -1;
    inventory[slot] = weapon;
    return slot;
  }

  static removeWeapon(
    inventory: (WeaponEntity | null)[],
    activeSlot: number,
    slot: number,
  ): { removed: WeaponEntity | null; newActiveSlot: number } {
    // Slot 0 is fists — cannot be removed
    if (slot === 0) return { removed: null, newActiveSlot: activeSlot };
    if (slot < 1 || slot >= PLAYER.INVENTORY_SIZE)
      return { removed: null, newActiveSlot: activeSlot };

    const removed = inventory[slot] ?? null;
    inventory[slot] = null;

    // If removing active slot, fall back to fists (slot 0)
    const newActiveSlot = activeSlot === slot ? 0 : activeSlot;
    return { removed, newActiveSlot };
  }

  static switchSlot(
    inventory: (WeaponEntity | null)[],
    activeSlot: number,
    targetSlot: number,
    canSwitch: boolean,
  ): { success: boolean; switchTarget: number | null; switchRemaining: number } {
    if (!canSwitch) return { success: false, switchTarget: null, switchRemaining: 0 };
    if (targetSlot === activeSlot)
      return { success: false, switchTarget: null, switchRemaining: 0 };
    if (targetSlot < 0 || targetSlot >= inventory.length)
      return { success: false, switchTarget: null, switchRemaining: 0 };
    if (inventory[targetSlot] === null)
      return { success: false, switchTarget: null, switchRemaining: 0 };

    return {
      success: true,
      switchTarget: targetSlot,
      switchRemaining: Math.ceil(COMBAT.WEAPON_SWITCH_TIME * 60), // seconds → ticks
    };
  }

  static canSwitch(context: {
    isActive: boolean;
    isStaggered: boolean;
    isInWindup: boolean;
    isInAttackCooldown: boolean;
    hasThrowInFlight: boolean;
    switchRemaining: number;
  }): boolean {
    if (!context.isActive) return false;
    if (context.isStaggered) return false;
    if (context.isInWindup) return false;
    if (context.isInAttackCooldown) return false;
    if (context.hasThrowInFlight) return false;
    if (context.switchRemaining > 0) return false;
    return true;
  }

  static updateSwitch(
    switchRemaining: number,
    switchTarget: number | null,
    ticks: number,
  ): { switchRemaining: number; switchTarget: number | null; newActiveSlot: number | null } {
    if (switchRemaining <= 0) {
      return { switchRemaining: 0, switchTarget: null, newActiveSlot: null };
    }

    const remaining = switchRemaining - ticks;
    if (remaining <= 0 && switchTarget !== null) {
      return { switchRemaining: 0, switchTarget: null, newActiveSlot: switchTarget };
    }

    return { switchRemaining: Math.max(0, remaining), switchTarget, newActiveSlot: null };
  }

  static forceSwitchSlot(
    inventory: (WeaponEntity | null)[],
    slot: number,
  ): { activeSlot: number; switchTarget: number | null; switchRemaining: number } | null {
    if (slot < 0 || slot >= inventory.length) return null;
    if (inventory[slot] === null) return null;
    return {
      activeSlot: slot,
      switchTarget: null,
      switchRemaining: 0,
    };
  }

  static getActiveWeapon(inventory: (WeaponEntity | null)[], activeSlot: number): WeaponEntity {
    return inventory[activeSlot]!;
  }

  /** Check slots 1+ only (slot 0 = fists is always occupied) */
  static hasEmptySlot(inventory: (WeaponEntity | null)[]): boolean {
    for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
      if (inventory[i] === null) return true;
    }
    return false;
  }

  /** Find first empty slot in 1+ range (slot 0 = fists, always occupied) */
  static findFirstEmptySlot(inventory: (WeaponEntity | null)[]): number | null {
    for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
      if (inventory[i] === null) return i;
    }
    return null;
  }

  static tierPriority(tier: WeaponTier | null): number {
    switch (tier) {
      case WeaponTier.LEGENDARY:
        return 4;
      case WeaponTier.RARE:
        return 3;
      case WeaponTier.UNCOMMON:
        return 2;
      case WeaponTier.COMMON:
        return 1;
      default:
        return 0;
    }
  }

  /** Find lowest-tier non-fists weapon to swap out */
  static findSwapTarget(inventory: (WeaponEntity | null)[], activeSlot: number): number {
    // If not on fists, swap the active slot
    if (activeSlot !== 0) return activeSlot;

    // Otherwise find the lowest-tier weapon in slots 1+
    let lowestPriority = Infinity;
    let targetSlot = 1;
    for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
      const weapon = inventory[i];
      if (!weapon) continue;
      const priority = PlayerInventory.tierPriority(weapon.tier as WeaponTier | null);
      if (priority < lowestPriority || (priority === lowestPriority && i > targetSlot)) {
        lowestPriority = priority;
        targetSlot = i;
      }
    }
    return targetSlot;
  }

  /** Find first occupied slot starting from slot 1 (skips fists) */
  static findLowestOccupiedSlot(inventory: (WeaponEntity | null)[]): number {
    for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
      if (inventory[i] !== null) return i;
    }
    return 0; // fall back to fists
  }

  static isWeaponOnCooldown(inventory: (WeaponEntity | null)[], activeSlot: number): boolean {
    const weapon = inventory[activeSlot];
    if (!weapon) return false;
    return weapon.cooldownRemaining > 0;
  }
}
