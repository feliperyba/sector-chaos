/**
 * AnimTiming.ts — Single source of truth for attack timing in 60Hz ticks.
 *
 * Replaces the server WindupManager's inline tick math and the client's
 * AttackTiming.ts mirror. Both sides MUST use these numbers so the simulated
 * strike (and therefore the live weapon hitbox) lands on the same ticks.
 */
import { AttackType } from '../enums/AttackType.js';
import { NETWORK } from '../constants/network.js';
import { weaponRegistry } from '../weapons/WeaponRegistry.js';
import type { WeaponType } from '../enums/WeaponType.js';

export const TICK_MS = 1000 / NETWORK.TICK_RATE;

/** Round a millisecond duration up to whole 60Hz ticks. */
export function msToTicks(ms: number): number {
  return Math.ceil(ms / TICK_MS);
}

/**
 * Resolve the effective attack type the server will use for an attack with
 * this weapon (mirrors AttackExecutor: meleeStats take precedence unless the
 * attack is forced, e.g. right-click THROWN).
 */
export function resolveAttackType(weaponType: number, forceAttackType?: AttackType): AttackType {
  try {
    const def = weaponRegistry.getDefinition(weaponType as WeaponType);
    return (
      forceAttackType ?? (def.meleeStats ? def.meleeStats.attackType : def.baseStats.attackType)
    );
  } catch {
    return forceAttackType ?? AttackType.ARC;
  }
}

function isMeleeMode(weaponType: number, attackType: AttackType): boolean {
  if (
    attackType === AttackType.THROWN ||
    attackType === AttackType.RANGED ||
    attackType === AttackType.SHIELD
  ) {
    return false;
  }
  try {
    return !!weaponRegistry.getDefinition(weaponType as WeaponType).meleeStats;
  } catch {
    return false;
  }
}

/** Windup duration in ticks (windup completes → STRIKE begins). */
export function getWindupTicks(weaponType: number, forceAttackType?: AttackType): number {
  const attackType = resolveAttackType(weaponType, forceAttackType);
  try {
    const def = weaponRegistry.getDefinition(weaponType as WeaponType);
    const windupMs = isMeleeMode(weaponType, attackType)
      ? def.meleeStats!.windupMs
      : def.baseStats.windupMs;
    return msToTicks(windupMs);
  } catch {
    return msToTicks(150);
  }
}

/** Cooldown window in ticks from windup completion (next attack allowed after). */
export function getCooldownTicks(weaponType: number): number {
  try {
    const def = weaponRegistry.getDefinition(weaponType as WeaponType);
    return msToTicks(def.baseStats.cooldown);
  } catch {
    return msToTicks(400);
  }
}
