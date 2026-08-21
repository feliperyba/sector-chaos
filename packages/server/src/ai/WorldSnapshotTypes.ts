import { WeaponType } from '@sector-battle/shared';

const MAX_PLAYERS = 64;
const MAX_ITEMS = 2048;
const MAX_DESTRUCTIBLES = 2048;
const MAX_TRAPS = 2048;
const MAX_PROJECTILES = 2048;

export { MAX_PLAYERS, MAX_ITEMS, MAX_DESTRUCTIBLES, MAX_TRAPS, MAX_PROJECTILES };

export interface WorldSnapshotConfig {
  maxItems?: number;
  maxDestructibles?: number;
  maxTraps?: number;
  maxProjectiles?: number;
}

export function tierToNumber(tier: string): number {
  switch (tier) {
    case 'common':
      return 0;
    case 'uncommon':
      return 1;
    case 'rare':
      return 2;
    case 'legendary':
      return 3;
    default:
      return 0;
  }
}

export interface WeaponDTO {
  weaponType: WeaponType;
  tier: number;
  ammo: number;
  durability: number;
}

export interface PlayerDTO {
  id: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  facingAngle: number;
  health: number;
  maxHealth: number;
  isAlive: boolean;
  isBot: boolean;
  weaponCount: number;
  weapons: WeaponDTO[];
  hasWeapon: boolean;
  weaponTier: number;
  weaponType: WeaponType;
  activeSlot: number;
  isFreshSpawn: boolean;
  /** Tick at which fresh-spawn invulnerability expires (0 if not fresh spawn).
   *  Lets the AI time an attack to land the instant invuln clears — the moment
   *  a newly-spawned player is most vulnerable (full HP but fists-only, no
   *  i-frames). Read-only passthrough of PlayerStatusEffects.freshSpawnExpiryTick. */
  freshSpawnExpiryTick: number;
  barrierActive: boolean;
  /** True while the player is in attack windup (committed, can't act). */
  isInWindup: boolean;
  /** Ticks remaining in the current windup (0 if not winding up). */
  windupRemaining: number;
  /** Last tick the player started an attack. Used for cooldown tracking. */
  lastAttackTick: number;
}

export interface ItemDTO {
  id: string;
  x: number;
  y: number;
  type: string;
  tier: number;
  /** For weapon pickups: the WeaponType on the ground (lets the bot evaluate
   *  loadout fit — e.g. grab a melee weapon when only holding a bow). Undefined
   *  for powerups/chests. */
  weaponType: WeaponType | undefined;
  powerUpType: 'health_pack' | 'barrier' | 'speed_boost' | undefined;
}

/**
 * A chest currently being opened (state === 'opening'). Synced separately from
 * the ItemDTO stream because closed chests are items, but an OPENING chest is
 * a signal about the PLAYER opening it — that player is committed (locked out
 * of most actions during the open) and therefore highly vulnerable. Bots use
 * this to recognize "is the enemy I'm looking at looting?" without any domain
 * change: Chest already exposes openingPlayerId/state (Chest.ts:36-40), it was
 * just dropped by the closed-only item filter (syncItems:478).
 */
export interface OpeningChestDTO {
  id: string;
  /** Player currently committed to opening this chest — the vulnerable target. */
  openingPlayerId: string;
  x: number;
  y: number;
}

export interface DestructibleDTO {
  id: string;
  x: number;
  y: number;
  type: string;
  hp: number;
  maxHp: number;
  isDestroyed: boolean;
}

export interface TrapDTO {
  id: string;
  x: number;
  y: number;
  type: string;
}

export interface ProjectileDTO {
  id: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}
