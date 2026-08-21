import { WeaponType } from '@sector-battle/shared';

export interface EnemyInfo {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  distance: number;
  health: number;
  maxHealth: number;
  weaponType: WeaponType;
  /** Tier of the enemy's active weapon (0 common..3 legendary). From PlayerDTO
   *  (already synced). Lets a bot decide NOT to duel a tier-3 weapon with fists,
   *  or to prioritize disarming a high-tier threat. */
  weaponTier: number;
  isInWindup: boolean;
  windupRemaining: number;
  lastAttackTick: number;
  facingAngle: number;
  barrierActive: boolean;
  isFreshSpawn: boolean;
  /** Ticks until this fresh-spawn enemy's invulnerability clears. >0 means the
   *  enemy is currently invulnerable (cannot be damaged) but WILL become
   *  vulnerable at a known instant — a fun bot can pre-position and time an
   *  attack to land the moment invuln drops. 0 (or negative) = already
   *  vulnerable. Derived in IntentSignals from windup/lastAttack-independent
   *  spawn timing. */
  spawnInvulnTicksLeft: number;
  /** True while this enemy is opening a chest (committed, locked out of most
   *  actions, highly vulnerable). Derived from the openingChests snapshot. */
  isLooting: boolean;
  /** If non-null, this enemy appears to be engaged fighting ANOTHER specific
   *  player — the ideal third-party target. Heuristic (IntentSignals): the
   *  enemy recently attacked and is facing/near a different enemy, not me. */
  engagedTargetId: string | null;
}

export interface ItemInfo {
  id: string;
  x: number;
  y: number;
  distance: number;
  type: string;
  tier: number;
  /** For weapon pickups: the WeaponType on the ground. Lets the bot decide
   *  whether a floor weapon fills a loadout gap (e.g. needs melee, has only
   *  ranged) rather than purely comparing tier. Undefined for powerups/chests. */
  weaponType?: WeaponType;
  powerUpType?: string;
}

export interface DangerInfo {
  x: number;
  y: number;
  type: string;
  distance: number;
}

/**
 * A barrel that is dangerous not just because the bot is near it, but because
 * an ENEMY is near it too — meaning the enemy can detonate it at any moment.
 * The bot must hard-flee the blast radius of these "hot" barrels even if the
 * bot itself isn't attacking. This is the key to cutting chain-explosion
 * deaths: the victim doesn't trigger the barrel, the enemy does, but the bot
 * is still in the blast zone and dies instantly.
 */
export interface HotBarrelInfo {
  x: number;
  y: number;
  distance: number;
}

export interface ProjectileInfo {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  distance: number;
}

export const enum BotState {
  FLEE_ZONE,
  SEEK_WEAPON,
  ENGAGE,
  RETREAT,
  LOOT,
  HUNT,
  WANDER,
  DEMOLITION,
}

export interface WeaponSlot {
  weaponType: WeaponType;
  tier: number;
  durability: number;
  ammo: number;
}
