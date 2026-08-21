import { Position, Health, Speed, Direction } from '../value-objects/index.ts';
import { WeaponEntity } from './Weapon.ts';
import { type PlayerConfig, type AABB } from '@sector-battle/shared';

// ---------------------------------------------------------------------------
// Core state — identity, position, health, stats
// ---------------------------------------------------------------------------

export interface PlayerCoreState {
  readonly id: string;
  name: string;
  color: number;
  position: Position;
  health: Health;
  speed: Speed;
  direction: Direction;
  lastMoveDirection: Direction;
  facingAngle: number;
  baseSpeed: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  items: string[];
  itemsCollected: number;
  survivalStartTick: number;
  spawnTick: number;
  connected: boolean;
  connectionState: 'connected' | 'disconnected' | 'vulnerable';
  inputSuppressed: boolean;
  isBot: boolean;
  readonly config: PlayerConfig;
}

// ---------------------------------------------------------------------------
// Inventory state
// ---------------------------------------------------------------------------

export interface PlayerInventoryState {
  inventory: (WeaponEntity | null)[];
  activeSlot: number;
}

// ---------------------------------------------------------------------------
// Movement / dash / knockback state
// ---------------------------------------------------------------------------

export interface PlayerMovementState {
  dashCooldownRemaining: number;
  isDashing: boolean;
  dashEndTick: number;
  preDashSpeed: number;
  knockbackVelocityX: number;
  knockbackVelocityY: number;
}

// ---------------------------------------------------------------------------
// Combat state — windup, attack cooldowns, throws
// ---------------------------------------------------------------------------

export interface PlayerCombatState {
  windupRemaining: number;
  windupWeaponSlot: number;
  windupAttackType: string | null;
  lastAttackTick: number;
  throwsInFlight: Set<string>;
  weaponTypesUsed: Set<number>;
}

// ---------------------------------------------------------------------------
// Status state — barrier, fresh-spawn, stagger, DOTs, death, connection
// ---------------------------------------------------------------------------

export interface PlayerStatusState {
  status: number;
  deathTick: number;
  barrierActive: boolean;
  barrierExpiryTick: number;
  speedBoostExpiryTick: number;
  freshSpawnExpiryTick: number;
  stunExpiryTick: number;
  lastDamageTick: number;
  lastDamageSource: DamageSourceEntry | null;
  staggerRemaining: number;
  activeDOTs: Map<string, DOTEntry>;
  queuedSlotSwitch: number | null;
  switchTarget: number | null;
  switchRemaining: number;
}

export interface DamageSourceEntry {
  playerId: string;
  weaponType: string;
  tick: number;
}

export interface DOTEntry {
  damagePerTick: number;
  remainingTicks: number;
  tickIntervalTicks: number;
  accumulator: number;
}

// ---------------------------------------------------------------------------
// Aggregate — all state combined
// ---------------------------------------------------------------------------

export interface PlayerFullState
  extends
    PlayerCoreState,
    PlayerInventoryState,
    PlayerMovementState,
    PlayerCombatState,
    PlayerStatusState {}

// ---------------------------------------------------------------------------
// Hitbox helper
// ---------------------------------------------------------------------------

export function computeHitbox(position: Position, config: PlayerConfig): AABB {
  return {
    x: position.x - config.hitboxWidth / 2,
    y: position.y - config.hitboxHeight / 2,
    width: config.hitboxWidth,
    height: config.hitboxHeight,
  };
}
