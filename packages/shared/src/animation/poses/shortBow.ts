/** Short Bow — smooth draw to cheek, string-hand release whip, bow kicks forward. */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.SHORT_BOW);

export const SHORT_BOW_MOTION: WeaponMotionSpec = buildSpec({
  category: 'ranged',
  weaponType: WeaponType.SHORT_BOW,
  weightClass: 1,
  strikeTicks: 5,
  activeFrom: 0.1,
  activeTo: 0.3,
  meleeRange: 0, // projectile resolution — segment not used for damage
  handOffset: def.visual.handOffset,
  fixedBladeLength: 30,
});
