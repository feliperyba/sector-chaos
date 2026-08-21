import { Position } from '../value-objects/index.ts';
import { WeaponType, WeaponTier } from '@sector-battle/shared';

export type ProjectileType = 'arrow' | 'thrown';

export class Projectile {
  readonly id: string;
  readonly ownerId: string;
  position: Position;
  velocityX: number;
  velocityY: number;
  damage: number;
  bouncesRemaining: number;
  weaponType: WeaponType;
  tier: WeaponTier;
  durability: number;
  initialDurability: number;
  distanceTraveled: number;
  maxRange: number;
  projectileType: ProjectileType;
  isBoomerang: boolean;
  isReturning: boolean;
  returnTargetId: string | null;
  boomerangTimeoutTick: number;
  originalSlot: number;
  knockback: number;

  constructor(
    id: string,
    ownerId: string,
    position: Position,
    vx: number,
    vy: number,
    damage: number,
    bounces: number,
    weaponType: WeaponType,
    durability: number = 0,
    maxRange: number = 0,
    projectileType: ProjectileType = 'thrown',
    isBoomerang: boolean = false,
    returnTargetId: string | null = null,
    boomerangTimeoutTick: number = 0,
    originalSlot: number = -1,
    knockback: number = 0,
    tier: WeaponTier = WeaponTier.COMMON,
  ) {
    this.id = id;
    this.ownerId = ownerId;
    this.position = position;
    this.velocityX = vx;
    this.velocityY = vy;
    this.damage = damage;
    this.bouncesRemaining = bounces;
    this.weaponType = weaponType;
    this.tier = tier;
    this.durability = durability;
    this.initialDurability = durability;
    this.distanceTraveled = 0;
    this.maxRange = maxRange;
    this.projectileType = projectileType;
    this.isBoomerang = isBoomerang;
    this.isReturning = false;
    this.returnTargetId = returnTargetId;
    this.boomerangTimeoutTick = boomerangTimeoutTick;
    this.originalSlot = originalSlot;
    this.knockback = knockback;
  }

  update(dt: number): void {
    this.position = this.position.move(this.velocityX * dt, this.velocityY * dt);
  }

  bounce(normalX: number, normalY: number): void {
    const dot = this.velocityX * normalX + this.velocityY * normalY;
    this.velocityX -= 2 * dot * normalX;
    this.velocityY -= 2 * dot * normalY;
    this.bouncesRemaining--;
    if (this.isBoomerang) {
      this.isBoomerang = false;
      this.isReturning = false;
    }
  }
}
