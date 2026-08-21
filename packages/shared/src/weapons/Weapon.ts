import { AttackType } from '../enums/AttackType.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import { WeaponType } from '../enums/WeaponType.js';

export interface WeaponStats {
  damage: number;
  destructibleDamage: number;
  range: number;
  cooldown: number;
  knockback: number;
  bounces: number;
  durability: number;
  maxDurability: number;
  tier: WeaponTier | null;
  attackType: AttackType;
  weightTier: number;
  windupMs: number;
  arcAngle?: number;
  projectileSpeed?: number;
  blockReduction?: number;
  throwSpeed?: number;
  throwRange?: number;
  throwKnockback?: number;
  blockArcDegrees?: number;
  staggerOnBreakMs?: number;
  /**
   * Stagger inflicted on a player this weapon damages (ms; 0/undefined = none).
   * The victim plays the stagger anim with halved move speed — heavy weapons
   * trade attack speed for tempo control. Server-authoritative. Must stay
   * well below the weapon's own cooldown so hits can never stun-lock.
   */
  hitStaggerMs?: number;
  isBoomerang?: boolean;
  lineStartOffset?: number;
}

export interface WeaponVisualConfig {
  /** Uniform scale factor. Applied via setScale() — preserves aspect ratio.
   *  All textures are 128×128, so displayed size = 128 × scale. */
  scale: number;

  /** Rotation offset in radians when equipped.
   *  All sprites point UP in the texture (blade tip at top).
   *  Melee (ARC/LINE): PI/2 (rotate 90° CW to point right/forward).
   *  Ranged/Shield: 0 (art already horizontal). */
  rotationOffset: number;

  /** Distance from player center to weapon grip point (world pixels).
   *  Positions the weapon's origin (pivot) at this offset from the body. */
  handOffset: number;

  /** Sprite origin X (0–1). 0.5 = horizontal center. */
  originX: number;

  /** Sprite origin Y (0–1). Determines where the grip/pivot is.
   *  0.5 = center (bows, shields). 0.85 = near bottom (swords, spears). */
  originY: number;

  /** Mirror the sprite horizontally (flipX). Default false. Set true when the
   *  art's edge/face points the wrong way relative to the swing — e.g. the
   *  throwing axe is a side-profile whose flat side faces the player at the
   *  default rotation, so flipping presents the edge outward. */
  flipX: boolean;
}

export interface WeaponDefinition {
  type: WeaponType;
  visual: WeaponVisualConfig;
  name: string;
  baseStats: Omit<WeaponStats, 'durability' | 'maxDurability'>;
  tier: WeaponTier | null;
  attackType: AttackType;
  canThrow: boolean;
  durabilityByTier: Record<WeaponTier, number>;
  meleeStats?: {
    damage: number;
    range: number;
    cooldown: number;
    knockback: number;
    attackType: AttackType.ARC;
    arcAngle: number;
    windupMs: number;
  };
  durabilityMultiplier?: number;
}

export interface Weapon {
  type: WeaponType;
  stats: WeaponStats;
  currentDurability: number;
}

export const DURABILITY_BY_TIER: Record<WeaponTier, number> = {
  [WeaponTier.COMMON]: 8,
  [WeaponTier.UNCOMMON]: 10,
  [WeaponTier.RARE]: 15,
  [WeaponTier.LEGENDARY]: 20,
} as const;

export const TIER_STAT_MULTIPLIER: Record<WeaponTier, number> = {
  [WeaponTier.COMMON]: 1.0,
  [WeaponTier.UNCOMMON]: 1.25,
  [WeaponTier.RARE]: 1.75,
  [WeaponTier.LEGENDARY]: 2.0,
} as const;

export function scaleStatsForTier(
  baseStats: Omit<WeaponStats, 'durability' | 'maxDurability'>,
  tier: WeaponTier,
  durability: number,
): WeaponStats {
  const m = TIER_STAT_MULTIPLIER[tier];
  return {
    ...baseStats,
    tier,
    damage: Math.round(baseStats.damage * m),
    range: Math.round(baseStats.range * m),
    knockback: Math.round(baseStats.knockback * m),
    durability,
    maxDurability: durability,
  };
}

export const FISTS_INFINITE_DURABILITY = -1;
