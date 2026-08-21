import { WeaponType } from '../enums/WeaponType.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import {
  type WeaponDefinition,
  type Weapon,
  DURABILITY_BY_TIER,
  scaleStatsForTier,
  FISTS_INFINITE_DURABILITY,
} from './Weapon.js';
import { getDefaultDefinitions } from './definitions.js';
import { validateWeaponDefinitions } from './validateWeaponDefinitions.js';

export const ALL_WEAPON_TYPES: WeaponType[] = [
  WeaponType.DAGGER,
  WeaponType.SHORT_SWORD,
  WeaponType.LONG_SWORD,
  WeaponType.HAMMER,
  WeaponType.LARGE_AXE,
  WeaponType.BLADED_AXE,
  WeaponType.DOUBLE_AXE,
  WeaponType.SPEAR,
  WeaponType.POLEARM,
  WeaponType.STAFF,
  WeaponType.THROWING_AXE,
  WeaponType.SHORT_BOW,
  WeaponType.CROSSBOW,
  WeaponType.SMALL_SHIELD,
  WeaponType.LARGE_SHIELD,
];

export class WeaponRegistry {
  private definitions: Map<WeaponType, WeaponDefinition>;

  constructor(definitions?: Map<WeaponType, WeaponDefinition>) {
    this.definitions = definitions ?? getDefaultDefinitions();
    validateWeaponDefinitions(this.definitions, ALL_WEAPON_TYPES);
  }

  getDefinition(type: WeaponType): WeaponDefinition {
    const def = this.definitions.get(type);
    if (!def) {
      throw new Error(`Weapon definition not found for type: ${type}`);
    }
    return def;
  }

  createWeapon(type: WeaponType, tier?: WeaponTier): Weapon {
    const def = this.getDefinition(type);
    if (type === WeaponType.FISTS) {
      return {
        type: def.type,
        stats: {
          ...def.baseStats,
          durability: FISTS_INFINITE_DURABILITY,
          maxDurability: FISTS_INFINITE_DURABILITY,
        },
        currentDurability: FISTS_INFINITE_DURABILITY,
      };
    }
    const weaponTier = tier ?? WeaponTier.COMMON;
    const tierBase = DURABILITY_BY_TIER[weaponTier];
    const durability = Math.round(tierBase * (def.durabilityMultiplier ?? 1));
    const stats = scaleStatsForTier(def.baseStats, weaponTier, durability);
    return { type: def.type, stats, currentDurability: durability };
  }

  getAllTypes(): WeaponType[] {
    return [...this.definitions.keys()];
  }

  getSpawnableTypes(): WeaponType[] {
    return ALL_WEAPON_TYPES;
  }
}

export const weaponRegistry = new WeaponRegistry();
