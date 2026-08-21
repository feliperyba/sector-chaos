import { Position, Speed, Direction } from '../value-objects/index.ts';
import { COMBAT, PLAYER, type AABB, type TileType } from '@sector-battle/shared';
import type { ICollisionService } from '../services/ICollisionService.ts';

/**
 * Movement and knockback physics — stateful domain object.
 * Owns position, velocity, speed, dash, and knockback state.
 */
export class PlayerMovement {
  position: Position;
  velocityX: number = 0;
  velocityY: number = 0;
  speed: Speed;
  baseSpeed: number;
  direction: Direction;
  lastMoveDirection: Direction;
  facingAngle: number = 0;
  isDashing: boolean = false;
  dashCooldownRemaining: number = 0;
  dashEndTick: number = 0;
  private preDashSpeed: number = -1;
  knockbackVelocityX: number = 0;
  knockbackVelocityY: number = 0;

  constructor(position: Position, baseSpeed: number, dashSpeedMultiplier: number) {
    this.position = position;
    this.baseSpeed = baseSpeed;
    this.speed = new Speed(baseSpeed, baseSpeed * dashSpeedMultiplier);
    this.direction = Direction.NONE;
    this.lastMoveDirection = Direction.NONE;
  }

  // --- Dash ---

  updateDashCooldown(ticks: number): void {
    if (this.dashCooldownRemaining > 0) {
      this.dashCooldownRemaining = Math.max(0, this.dashCooldownRemaining - ticks);
    }
  }

  canStartDash(isStaggered: boolean): boolean {
    if (isStaggered) return false;
    if (this.isDashing) return false;
    if (this.dashCooldownRemaining > 0) return false;
    return true;
  }

  startDash(dashCooldown: number): void {
    this.dashCooldownRemaining = dashCooldown;
    this.isDashing = true;
  }

  endDash(): void {
    this.isDashing = false;
  }

  startDashSpeed(): void {
    this.preDashSpeed = this.speed.value;
    this.speed = new Speed(this.baseSpeed * PLAYER.DASH_SPEED_MULTIPLIER, this.speed.max);
  }

  endDashSpeed(): void {
    const speed = this.preDashSpeed >= 0 ? this.preDashSpeed : this.baseSpeed;
    this.speed = new Speed(speed, this.speed.max);
    this.preDashSpeed = -1;
  }

  cancelDash(): void {
    if (!this.isDashing) return;
    this.isDashing = false;
    this.endDashSpeed();
  }

  // --- Knockback ---

  isKnockedBack(): boolean {
    return this.knockbackVelocityX !== 0 || this.knockbackVelocityY !== 0;
  }

  applyKnockbackVelocity(vx: number, vy: number): void {
    this.knockbackVelocityX = vx;
    this.knockbackVelocityY = vy;
  }

  updateKnockback(
    dt: number,
    hitboxWidth: number,
    hitboxHeight: number,
    grid: TileType[][],
    collisionService: ICollisionService,
  ): void {
    if (this.knockbackVelocityX === 0 && this.knockbackVelocityY === 0) {
      return;
    }

    const hw = hitboxWidth / 2;
    const hh = hitboxHeight / 2;

    // Resolve X
    const moveX = this.knockbackVelocityX * dt;
    const newPosX = this.position.x + moveX;
    const aabbX: AABB = {
      x: newPosX - hw,
      y: this.position.y - hh,
      width: hitboxWidth,
      height: hitboxHeight,
    };
    const resolvedX = collisionService.resolveTileCollision(aabbX, grid);
    const actualMoveX = resolvedX.x + hw - this.position.x;
    let newKvx = this.knockbackVelocityX;
    if (Math.abs(actualMoveX) < Math.abs(moveX) * 0.5) {
      newKvx = 0;
    }
    const posX = resolvedX.x + hw;

    // Resolve Y
    const moveY = this.knockbackVelocityY * dt;
    const newPosY = this.position.y + moveY;
    const aabbY: AABB = {
      x: posX - hw,
      y: newPosY - hh,
      width: hitboxWidth,
      height: hitboxHeight,
    };
    const resolvedY = collisionService.resolveTileCollision(aabbY, grid);
    const actualMoveY = resolvedY.y + hh - this.position.y;
    let newKvy = this.knockbackVelocityY;
    if (Math.abs(actualMoveY) < Math.abs(moveY) * 0.5) {
      newKvy = 0;
    }
    const posY = resolvedY.y + hh;

    // Decay
    const magnitude = Math.sqrt(newKvx ** 2 + newKvy ** 2);
    const decay = COMBAT.KNOCKBACK_DECAY * dt;

    if (magnitude <= decay) {
      this.position = new Position(posX, posY);
      this.knockbackVelocityX = 0;
      this.knockbackVelocityY = 0;
      return;
    }

    const scaleFactor = Math.max(0, magnitude - decay) / magnitude;
    this.position = new Position(posX, posY);
    this.knockbackVelocityX = newKvx * scaleFactor;
    this.knockbackVelocityY = newKvy * scaleFactor;
  }

  // --- Speed ---

  setSpeed(speed: Speed): void {
    this.speed = speed;
  }
}
