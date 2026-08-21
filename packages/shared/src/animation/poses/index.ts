/**
 * poses/index.ts — WEAPON_MOTIONS registry + category mapping.
 *
 * getAttackCategory / getAttackCategoryForAttack moved from the client's
 * PoseConfigs.ts — the server needs strategy/category info too.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { AttackType } from '../../enums/AttackType.js';
import type { AttackCategory, WeaponMotionSpec } from './types.js';
import { buildSpec } from './categoryTemplates.js';
import { FISTS_MOTION } from './fists.js';
import { DAGGER_MOTION } from './dagger.js';
import { SHORT_SWORD_MOTION } from './shortSword.js';
import { LONG_SWORD_MOTION } from './longSword.js';
import { HAMMER_MOTION } from './hammer.js';
import { LARGE_AXE_MOTION } from './largeAxe.js';
import { BLADED_AXE_MOTION } from './bladedAxe.js';
import { DOUBLE_AXE_MOTION } from './doubleAxe.js';
import { SPEAR_MOTION } from './spear.js';
import { POLEARM_MOTION } from './polearm.js';
import { STAFF_MOTION } from './staff.js';
import { THROWING_AXE_MOTION } from './throwingAxe.js';
import { SHORT_BOW_MOTION } from './shortBow.js';
import { CROSSBOW_MOTION } from './crossbow.js';
import { SMALL_SHIELD_MOTION } from './smallShield.js';
import { LARGE_SHIELD_MOTION } from './largeShield.js';

export * from './types.js';
export * from './commonPoses.js';
export {
  buildSpec,
  getCategoryTemplate,
  kf,
  type SpecParams,
  type SpecOverrides,
} from './categoryTemplates.js';
export { solveBladeLength, maxTipRadius } from './solveBladeLength.js';

/** Primary-attack motion spec per weapon. */
export const WEAPON_MOTIONS: Record<WeaponType, WeaponMotionSpec> = {
  [WeaponType.FISTS]: FISTS_MOTION,
  [WeaponType.DAGGER]: DAGGER_MOTION,
  [WeaponType.SHORT_SWORD]: SHORT_SWORD_MOTION,
  [WeaponType.LONG_SWORD]: LONG_SWORD_MOTION,
  [WeaponType.HAMMER]: HAMMER_MOTION,
  [WeaponType.LARGE_AXE]: LARGE_AXE_MOTION,
  [WeaponType.BLADED_AXE]: BLADED_AXE_MOTION,
  [WeaponType.DOUBLE_AXE]: DOUBLE_AXE_MOTION,
  [WeaponType.SPEAR]: SPEAR_MOTION,
  [WeaponType.POLEARM]: POLEARM_MOTION,
  [WeaponType.STAFF]: STAFF_MOTION,
  [WeaponType.THROWING_AXE]: THROWING_AXE_MOTION,
  [WeaponType.SHORT_BOW]: SHORT_BOW_MOTION,
  [WeaponType.CROSSBOW]: CROSSBOW_MOTION,
  [WeaponType.SMALL_SHIELD]: SMALL_SHIELD_MOTION,
  [WeaponType.LARGE_SHIELD]: LARGE_SHIELD_MOTION,
};

/**
 * Generic throw motion — ANY weapon can be thrown (right-click) and plays
 * this. The released weapon is a projectile entity; the segment is not a
 * damage hitbox during throws.
 */
export const THROWN_MOTION: WeaponMotionSpec = buildSpec({
  category: 'thrown',
  weightClass: 0,
  strikeTicks: 8,
  activeFrom: 0,
  activeTo: 0,
  meleeRange: 0,
  handOffset: 16,
  fixedBladeLength: 40,
});

// ─── Category Mapping (moved from client PoseConfigs.ts) ────────────────────

const ARC_WEAPONS = new Set<number>([
  WeaponType.DAGGER,
  WeaponType.SHORT_SWORD,
  WeaponType.LONG_SWORD,
  WeaponType.HAMMER,
  WeaponType.LARGE_AXE,
  WeaponType.BLADED_AXE,
  WeaponType.DOUBLE_AXE,
]);

const LINE_WEAPONS = new Set<number>([WeaponType.SPEAR, WeaponType.POLEARM, WeaponType.STAFF]);

const RANGED_WEAPONS = new Set<number>([WeaponType.SHORT_BOW, WeaponType.CROSSBOW]);

const SHIELD_WEAPONS = new Set<number>([WeaponType.SMALL_SHIELD, WeaponType.LARGE_SHIELD]);

/** Map a weapon type number to its attack category for pose lookup. */
export function getAttackCategory(weaponType: number): AttackCategory {
  if (weaponType < 0 || weaponType === WeaponType.FISTS) return 'fists';
  if (ARC_WEAPONS.has(weaponType)) return 'arc';
  if (LINE_WEAPONS.has(weaponType)) return 'line';
  if (RANGED_WEAPONS.has(weaponType)) return 'ranged';
  if (SHIELD_WEAPONS.has(weaponType)) return 'shield';
  if (weaponType === WeaponType.THROWING_AXE) return 'thrown';
  return 'fists';
}

export function getAttackCategoryForAttack(weaponType: number, attackType: string): AttackCategory {
  // ANY weapon can be thrown (right-click) — always plays the thrown poses
  if (attackType === AttackType.THROWN) return 'thrown';
  if (weaponType === WeaponType.THROWING_AXE && attackType === AttackType.ARC) return 'arc';
  return getAttackCategory(weaponType);
}

/**
 * Motion spec for a specific attack: thrown attacks use the generic throw
 * motion; everything else uses the weapon's primary spec.
 */
export function getMotionSpec(weaponType: number, attackType?: string): WeaponMotionSpec {
  if (attackType === AttackType.THROWN) return THROWN_MOTION;
  const spec = WEAPON_MOTIONS[weaponType as WeaponType];
  return spec ?? FISTS_MOTION;
}
