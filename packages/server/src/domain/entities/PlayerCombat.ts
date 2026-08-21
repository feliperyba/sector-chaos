import { COMBAT, NETWORK } from '@sector-battle/shared';

/**
 * Combat state — stateful domain object.
 * Owns windup, blocking, throws, weapon type tracking.
 */
export class PlayerCombat {
  windupRemaining: number = 0;
  windupWeaponSlot: number = -1;
  windupAttackType: string | null = null;
  lastAttackTick: number = -Infinity;
  isBlocking: boolean = false;
  throwsInFlight: Set<string> = new Set();
  private weaponTypesUsed: Set<number> = new Set();

  // --- Windup ---

  isInWindup(): boolean {
    return this.windupRemaining > 0;
  }

  startWindup(ticks: number, weaponSlot: number, attackType: string): void {
    this.windupRemaining = ticks;
    this.windupWeaponSlot = weaponSlot;
    this.windupAttackType = attackType;
  }

  clearWindup(): void {
    this.windupRemaining = 0;
    this.windupWeaponSlot = -1;
    this.windupAttackType = null;
  }

  tickWindup(): boolean {
    if (this.windupRemaining <= 0) return false;
    this.windupRemaining--;
    return this.windupRemaining <= 0;
  }

  // --- Attack checks ---

  static canAttack(context: {
    isFreshSpawnActive: boolean;
    isStaggered: boolean;
    isInWindup: boolean;
    isDashing: boolean;
    isSwitching: boolean;
    lastAttackTick: number;
    currentTick: number;
  }): boolean {
    // Convert ms-based rate limit to ticks for tick-based comparison
    const attackRateLimitTicks = Math.ceil(COMBAT.ATTACK_RATE_LIMIT / (1000 / NETWORK.TICK_RATE));
    if (context.isFreshSpawnActive) return false;
    if (context.isStaggered) return false;
    if (context.isInWindup) return false;
    if (context.isDashing) return false;
    if (context.isSwitching) return false;
    if (context.currentTick - context.lastAttackTick < attackRateLimitTicks) return false;
    return true;
  }

  static canThrow(context: {
    isActive: boolean;
    isFreshSpawnActive: boolean;
    isStaggered: boolean;
    isInWindup: boolean;
    isInAttackCooldown: boolean;
    isDashing: boolean;
    activeSlot: number;
    hasWeaponInActiveSlot: boolean;
  }): boolean {
    if (!context.isActive) return false;
    if (context.isFreshSpawnActive) return false;
    if (context.isStaggered) return false;
    if (context.isInWindup) return false;
    if (context.isInAttackCooldown) return false;
    if (context.isDashing) return false;
    // Cannot throw fists (slot 0)
    if (context.activeSlot === 0) return false;
    if (!context.hasWeaponInActiveSlot) return false;
    return true;
  }

  static canBlock(context: {
    isFreshSpawnActive: boolean;
    isStaggered: boolean;
    isDashing: boolean;
  }): boolean {
    if (context.isFreshSpawnActive) return false;
    if (context.isStaggered) return false;
    if (context.isDashing) return false;
    return true;
  }

  static canDash(context: {
    isFreshSpawnActive: boolean;
    isStaggered: boolean;
    isDashing: boolean;
    dashCooldownRemaining: number;
  }): boolean {
    if (context.isFreshSpawnActive) return false;
    if (context.isStaggered) return false;
    if (context.isDashing) return false;
    if (context.dashCooldownRemaining > 0) return false;
    return true;
  }

  static canPickup(context: {
    isDashing: boolean;
    isStaggered: boolean;
    isInWindup: boolean;
    isInAttackCooldown: boolean;
  }): boolean {
    if (context.isDashing) return false;
    if (context.isStaggered) return false;
    if (context.isInWindup) return false;
    if (context.isInAttackCooldown) return false;
    return true;
  }

  // --- Throws ---

  addThrowInFlight(id: string): void {
    this.throwsInFlight.add(id);
  }

  removeThrowInFlight(id: string): void {
    this.throwsInFlight.delete(id);
  }

  hasThrowInFlight(): boolean {
    return this.throwsInFlight.size > 0;
  }

  // --- Collision ---

  static bypassesPlayerCollision(isDashing: boolean): boolean {
    return isDashing;
  }

  /**
   * Whether a dying player's corpse still has collision (during death animation).
   * Returns true DURING the death animation, false after it ends.
   */
  static hasDeathCollision(deathTick: number, isDying: boolean, currentTick: number): boolean {
    if (deathTick < 0) return false;
    if (!isDying) return false;
    const deathAnimationTicks = Math.round(COMBAT.DEATH_ANIMATION_DURATION * NETWORK.TICK_RATE);
    return currentTick - deathTick < deathAnimationTicks;
  }

  static isCorpse(deathTick: number, isDying: boolean): boolean {
    return deathTick >= 0 && isDying;
  }

  // --- Weapon type tracking ---

  trackWeaponType(weaponType: number): void {
    this.weaponTypesUsed.add(weaponType);
  }

  get weaponsUsedCount(): number {
    return this.weaponTypesUsed.size;
  }

  recordAttack(currentTick: number): void {
    this.lastAttackTick = currentTick;
  }
}
