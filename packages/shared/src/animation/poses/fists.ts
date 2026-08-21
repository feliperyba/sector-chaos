/** Fists — alternating jab-cross: chamber, piston snap, guard return. */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.FISTS);

export const FISTS_MOTION: WeaponMotionSpec = buildSpec({
  category: 'fists',
  weaponType: WeaponType.FISTS,
  weightClass: 0,
  strikeTicks: 3,
  activeFrom: 0.0,
  activeTo: 0.85,
  meleeRange: def.baseStats.range,
  handOffset: def.visual.handOffset,
});
