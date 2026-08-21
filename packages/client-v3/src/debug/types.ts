import type {
  PlayerState,
  ProjectileState,
  WeaponPickupState,
  ChestState,
  DestructibleState,
  TrapState,
  PowerUpState,
  ExplosionState,
  WeaponState,
} from '../types.js';
import type { Connection } from '../network/Connection.js';
import type { StateSync } from '../network/StateSync.js';
import type { InputBuffer } from '../prediction/InputBuffer.js';

// ── Snapshot types (subset of game state, JSON-serializable) ─────────────

export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: number;
  speed: number;
  activeSlot: number;
  lastDamageTick: number;
  dashCooldown: number;
  barrierActive: boolean;
  speedBoostActive: boolean;
  weapons: WeaponState[];
  connected: boolean;
  isBot: boolean;
}

export interface ProjectileSnapshot {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  damage: number;
  bounces: number;
  weaponType: number;
  tier: number;
}

export interface WeaponPickupSnapshot {
  id: string;
  weaponType: number;
  tier: number;
  x: number;
  y: number;
  lifetime: number;
}

export interface ChestSnapshot {
  id: string;
  x: number;
  y: number;
  state: number;
  tier: number;
}

export interface DestructibleSnapshot {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  isDestroyed: boolean;
}

export interface TrapSnapshot {
  id: string;
  x: number;
  y: number;
  type: number;
  isRevealed: boolean;
  cooldownRemaining: number;
}

export interface PowerUpSnapshot {
  id: string;
  x: number;
  y: number;
  type: number;
  isActive: boolean;
}

export interface ExplosionSnapshot {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface ZoneSnapshot {
  centerX: number;
  centerY: number;
  currentRadius: number;
  phaseEndTime: number;
}

export interface PredictionBufferSnapshot {
  size: number;
  firstSeq: number;
  lastSeq: number;
  droppedInputs: number;
}

export interface DebugStateSnapshot {
  scene: string;
  myId: string;
  tick: number;
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  localSpeed: number;
  lastProcessedInput: number;
  players: PlayerSnapshot[];
  projectiles: ProjectileSnapshot[];
  weaponPickups: WeaponPickupSnapshot[];
  chests: ChestSnapshot[];
  destructibles: DestructibleSnapshot[];
  traps: TrapSnapshot[];
  powerUps: PowerUpSnapshot[];
  explosions: ExplosionSnapshot[];
  zone: ZoneSnapshot;
  mapLoaded: boolean;
  connected: boolean;
  gameActive: boolean;
  predictionBuffer: PredictionBufferSnapshot;
  reconciliationErrors: number;
}

// ── Other types ──────────────────────────────────────────────────────────

export interface MessageLogEntry {
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
  playerId?: string;
  tick?: number;
}

export interface DebugBridgeOptions {
  connection: Connection;
  stateSync: StateSync;
  inputBuffer: InputBuffer;
  scene: Phaser.Scene;
  myId: string;
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
}

export interface RawInputOptions {
  skipPrediction?: boolean;
  targetId?: string;
  sequence?: number;
}

export type WaitForStatePredicate = (state: DebugStateSnapshot) => boolean;

export interface ConnectRoomOptions {
  roomName: 'game' | 'test-room' | 'bot-e2e';
  mapType?: 'demo' | 'seeded';
  botCount?: number;
  debug?: boolean;
}

// ── Mappers: entity types → snapshot types ───────────────────────────────

export function mapPlayer(p: PlayerState): PlayerSnapshot {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    health: p.health,
    maxHealth: p.maxHealth,
    status: p.status,
    speed: p.speed,
    activeSlot: p.activeSlot,
    lastDamageTick: p.lastDamageTick,
    dashCooldown: p.dashCooldown,
    barrierActive: p.barrierActive,
    speedBoostActive: p.speedBoostActive,
    weapons: p.weapons,
    connected: p.connected,
    isBot: p.isBot,
  };
}

export function mapProjectile(p: ProjectileState): ProjectileSnapshot {
  return {
    id: p.id,
    ownerId: p.ownerId,
    x: p.x,
    y: p.y,
    velocityX: p.velocityX,
    velocityY: p.velocityY,
    damage: p.damage,
    bounces: p.bounces,
    weaponType: p.weaponType,
    tier: p.tier,
  };
}

export function mapWeaponPickup(wp: WeaponPickupState): WeaponPickupSnapshot {
  return {
    id: wp.id,
    weaponType: wp.weaponType,
    tier: wp.tier,
    x: wp.x,
    y: wp.y,
    lifetime: wp.lifetime,
  };
}

export function mapChest(c: ChestState): ChestSnapshot {
  return { id: c.id, x: c.x, y: c.y, state: c.state, tier: c.tier };
}

export function mapDestructible(d: DestructibleState): DestructibleSnapshot {
  return { id: d.id, x: d.x, y: d.y, hp: d.hp, maxHp: d.maxHp, isDestroyed: d.isDestroyed };
}

export function mapTrap(t: TrapState): TrapSnapshot {
  return {
    id: t.id,
    x: t.x,
    y: t.y,
    type: t.type,
    isRevealed: t.isRevealed,
    cooldownRemaining: t.cooldownRemaining,
  };
}

export function mapPowerUp(p: PowerUpState): PowerUpSnapshot {
  return { id: p.id, x: p.x, y: p.y, type: p.type, isActive: p.isActive };
}

export function mapExplosion(e: ExplosionState): ExplosionSnapshot {
  return { id: e.id, x: e.x, y: e.y, radius: e.radius };
}

export function collect<V, S>(map: Map<string, V>, mapper: (v: V) => S): S[] {
  const result: S[] = [];
  for (const v of map.values()) {
    result.push(mapper(v));
  }
  return result;
}
