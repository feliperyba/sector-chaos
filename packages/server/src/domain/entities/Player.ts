import { Position, Health } from '../value-objects/index.ts';
import { WeaponEntity } from './Weapon.ts';
import { PlayerInventory } from './PlayerInventory.ts';
import { PlayerMovement } from './PlayerMovement.ts';
import { PlayerCombat } from './PlayerCombat.ts';
import { PlayerStatusEffects } from './PlayerStatusEffects.ts';
import {
  applyDamage,
  killPlayer,
  beginDying,
  completePlayerDeath,
  revivePlayer,
} from './PlayerLifecycle.ts';
import {
  canPickup,
  bypassesPlayerCollision,
  hasDeathCollision,
  isCorpse,
  canAttack,
  canThrow,
  canBlock,
  canDash,
  type PlayerCombatContext,
} from './PlayerCombatChecks.ts';
import {
  type PlayerConfig,
  COMBAT,
  WeaponTier,
  weaponRegistry,
  AttackType,
  resolveAttackType,
} from '@sector-battle/shared';

export interface DamageSource {
  playerId: string;
  weaponType: string;
  tick: number;
}

export interface DamageResult {
  killed: boolean;
  damageApplied: number;
}

export class Player {
  readonly id: string;
  name: string;
  color: number;
  health: Health;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  items: string[];
  itemsCollected: number;
  survivalStartTick: number;
  connected: boolean = true;
  connectionState: 'connected' | 'disconnected' | 'vulnerable' = 'connected';
  inputSuppressed: boolean = false;
  isBot: boolean = false;
  spawnTick: number;
  lastProcessedInput: number = 0;

  /**
   * Aliveness-transition hook (server-alive-counter). Registered by GameMatch
   * on addPlayer; fired by PlayerLifecycle exactly when the ALIVE status bit
   * flips (die / dieWithTick / completeDeath / revive). Pure derived-state
   * plumbing for the maintained alive count — game logic MUST NOT depend on
   * it. `null` for standalone/test players not owned by a GameMatch.
   */
  onAlivenessTransition: ((isAlive: boolean) => void) | null = null;

  readonly combat: PlayerCombat;
  readonly inventory: PlayerInventory;
  readonly movement: PlayerMovement;
  readonly statusEffects: PlayerStatusEffects;

  private readonly config: PlayerConfig;

  /**
   * server-combat-ctx-scratch (ticket 13): reusable combat-context backing the
   * can* checks (canPickup/canAttack/canThrow/canBlock/canDash). The four
   * component refs are set once in the constructor (all `readonly`, never
   * reassigned); only the three derived booleans are refreshed per call, so
   * #combatCtx() allocates zero objects. Safe to reuse across calls because
   * every consumer in PlayerCombatChecks.ts is a synchronous field-read that
   * never retains the ctx object (single-threaded, no re-entrancy).
   */
  readonly #combatCtxScratch: PlayerCombatContext;

  constructor(
    id: string,
    name: string,
    position: Position,
    config: PlayerConfig,
    color: number = 0,
  ) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.config = config;

    this.movement = new PlayerMovement(position, config.baseSpeed, 3);
    this.inventory = new PlayerInventory();
    this.combat = new PlayerCombat();
    this.statusEffects = new PlayerStatusEffects();

    this.#combatCtxScratch = {
      movement: this.movement,
      combat: this.combat,
      inventory: this.inventory,
      statusEffects: this.statusEffects,
      isActive: false,
      isSwitching: false,
      isInAttackCooldown: false,
    };

    this.health = new Health(config.baseHealth, config.maxHealth);
    this.kills = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.items = [];
    this.itemsCollected = 0;
    this.survivalStartTick = 0;
    this.spawnTick = 0;
  }

  // --- Lifecycle ---

  get isActive(): boolean {
    return this.statusEffects.isAlive();
  }

  takeDamage(amount: number, tick: number, skipInvulnerability: boolean = false): DamageResult {
    return applyDamage(this, amount, tick, skipInvulnerability);
  }

  die(): void {
    killPlayer(this);
  }

  dieWithTick(currentTick: number): void {
    beginDying(this, currentTick);
  }

  completeDeath(): void {
    completePlayerDeath(this);
  }
  revive(currentTick: number): void {
    revivePlayer(this, currentTick, this.config.baseHealth, this.config.maxHealth);
  }

  // --- Stats ---

  heal(amount: number): void {
    this.health = this.health.heal(amount);
  }

  addSpeed(factor: number): void {
    this.movement.speed = this.movement.speed.scale(factor);
  }

  recordDamageDealt(amount: number): void {
    this.damageDealt += amount;
  }

  recordKill(): void {
    this.kills++;
  }

  recordItemCollected(): void {
    this.itemsCollected++;
  }

  hasItem(itemId: string): boolean {
    return this.items.includes(itemId);
  }

  consumeItem(itemId: string): boolean {
    const idx = this.items.indexOf(itemId);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  getSurvivalTimeMs(currentTick: number, tickRate: number): number {
    return (currentTick - this.survivalStartTick) * (1000 / tickRate);
  }

  // --- Inventory ---

  addWeapon(weapon: WeaponEntity): number {
    const slot = PlayerInventory.addWeapon(this.inventory.weapons, weapon);
    if (slot >= 0) this.combat.trackWeaponType(weapon.type);
    return slot;
  }

  removeWeapon(slot: number): WeaponEntity | null {
    const result = PlayerInventory.removeWeapon(
      this.inventory.weapons,
      this.inventory.activeSlot,
      slot,
    );
    this.inventory.activeSlot = result.newActiveSlot;
    this.clearBlockingIfShieldGone();
    return result.removed;
  }

  switchSlot(slot: number): boolean {
    const result = PlayerInventory.switchSlot(
      this.inventory.weapons,
      this.inventory.activeSlot,
      slot,
      this.canSwitch(),
    );
    if (result.success) {
      this.inventory.switchTarget = result.switchTarget;
      this.inventory.switchRemaining = result.switchRemaining;
      this.clearBlockingIfShieldGone();
    }
    return result.success;
  }

  private clearBlockingIfShieldGone(): void {
    if (
      this.combat.isBlocking &&
      resolveAttackType(this.getActiveWeapon().type) !== AttackType.SHIELD
    ) {
      this.combat.isBlocking = false;
    }
  }

  canSwitch(): boolean {
    return PlayerInventory.canSwitch({
      isActive: this.isActive,
      isStaggered: this.statusEffects.isStaggered(),
      isInWindup: this.combat.isInWindup(),
      isInAttackCooldown: this.isInAttackCooldown(),
      hasThrowInFlight: this.combat.hasThrowInFlight(),
      switchRemaining: this.inventory.switchRemaining,
    });
  }

  isSwitching(): boolean {
    return this.inventory.switchRemaining > 0;
  }

  updateSwitch(ticks: number): void {
    const result = PlayerInventory.updateSwitch(
      this.inventory.switchRemaining,
      this.inventory.switchTarget,
      ticks,
    );
    this.inventory.switchRemaining = result.switchRemaining;
    this.inventory.switchTarget = result.switchTarget;
    if (result.newActiveSlot !== null) {
      this.inventory.activeSlot = result.newActiveSlot;
    }
  }

  forceSwitchSlot(slot: number): void {
    const result = PlayerInventory.forceSwitchSlot(this.inventory.weapons, slot);
    if (result) {
      this.inventory.activeSlot = result.activeSlot;
      this.inventory.switchTarget = result.switchTarget;
      this.inventory.switchRemaining = result.switchRemaining;
    }
  }
  getActiveWeapon(): WeaponEntity {
    return PlayerInventory.getActiveWeapon(this.inventory.weapons, this.inventory.activeSlot);
  }
  hasEmptySlot(): boolean {
    return PlayerInventory.hasEmptySlot(this.inventory.weapons);
  }
  findFirstEmptySlot(): number | null {
    return PlayerInventory.findFirstEmptySlot(this.inventory.weapons);
  }
  static tierPriority(tier: WeaponTier | null): number {
    return PlayerInventory.tierPriority(tier);
  }
  findSwapTarget(_incomingTier: WeaponTier | null): number {
    return PlayerInventory.findSwapTarget(this.inventory.weapons, this.inventory.activeSlot);
  }
  findLowestOccupiedSlot(): number {
    return PlayerInventory.findLowestOccupiedSlot(this.inventory.weapons);
  }
  isInAttackCooldown(): boolean {
    return PlayerInventory.isWeaponOnCooldown(this.inventory.weapons, this.inventory.activeSlot);
  }

  updateDashCooldown(ticks: number): void {
    this.movement.updateDashCooldown(ticks);
  }
  endDash(): void {
    this.movement.endDash();
  }
  startDashSpeed(): void {
    this.movement.startDashSpeed();
  }
  endDashSpeed(): void {
    this.movement.endDashSpeed();
  }
  cancelDash(): void {
    this.movement.cancelDash();
  }
  isKnockedBack(): boolean {
    return this.movement.isKnockedBack();
  }
  applyKnockbackVelocity(vx: number, vy: number): void {
    this.movement.applyKnockbackVelocity(vx, vy);
  }
  startDash(): boolean {
    if (!this.movement.canStartDash(this.statusEffects.isStaggered())) return false;
    this.movement.startDash(this.config.dashCooldown);
    return true;
  }

  updateKnockback(
    dt: number,
    grid: import('@sector-battle/shared').TileType[][],
    collisionService: import('../services/ICollisionService.ts').ICollisionService,
  ): void {
    this.movement.updateKnockback(
      dt,
      this.config.hitboxWidth,
      this.config.hitboxHeight,
      grid,
      collisionService,
    );
  }

  canPickup(): boolean {
    return canPickup(this.#combatCtx());
  }
  bypassesPlayerCollision(): boolean {
    return bypassesPlayerCollision(this.movement);
  }
  hasDeathCollision(currentTick: number): boolean {
    return hasDeathCollision(
      this.statusEffects.deathTick,
      this.statusEffects.isDying(),
      currentTick,
    );
  }
  isCorpse(): boolean {
    return isCorpse(this.statusEffects.deathTick, this.statusEffects.isDying());
  }
  onWeaponBreak(slotIndex: number, isShield: boolean, tickRate: number): void {
    const weapon = this.inventory.weapons[slotIndex];
    const weaponType = weapon?.type ?? null;
    this.removeWeapon(slotIndex);
    let durationMs = COMBAT.WEAPON_BREAK_STAGGER * 1000;
    if (isShield) {
      const def = weaponType != null ? weaponRegistry.getDefinition(weaponType) : null;
      durationMs = def?.baseStats.staggerOnBreakMs ?? COMBAT.SHIELD_BREAK_STAGGER * 1000;
    }
    this.statusEffects.startStagger(durationMs, tickRate);
    this.inventory.queuedSlotSwitch = this.findLowestOccupiedSlot();
  }

  canAttack(currentTick: number): boolean {
    return canAttack(this.#combatCtx(), currentTick);
  }

  recordAttack(currentTick: number): void {
    this.combat.recordAttack(currentTick);
  }

  canThrow(currentTick: number): boolean {
    return canThrow(this.#combatCtx(), currentTick);
  }

  canBlock(currentTick: number): boolean {
    return canBlock(this.#combatCtx(), currentTick);
  }

  canDash(currentTick: number): boolean {
    return canDash(this.#combatCtx(), currentTick);
  }

  #combatCtx(): PlayerCombatContext {
    // Mutate-and-return the private scratch (see #combatCtxScratch) instead of
    // building a fresh literal per can* call — the checks run per attack input
    // and every melee attempt.
    const ctx = this.#combatCtxScratch;
    ctx.isActive = this.isActive;
    ctx.isSwitching = this.isSwitching();
    ctx.isInAttackCooldown = this.isInAttackCooldown();
    return ctx;
  }

  // --- Status ---

  isAlive(): boolean {
    return this.statusEffects.isAlive();
  }
  isDead(): boolean {
    return this.statusEffects.isDead();
  }
  isSpectating(): boolean {
    return this.statusEffects.isSpectating();
  }
  isInvincibleStatus(): boolean {
    return this.statusEffects.isInvincibleStatus();
  }
  isStaggered(): boolean {
    return this.statusEffects.isStaggered();
  }
  isDying(): boolean {
    return this.statusEffects.isDying();
  }
  isFreshSpawn(): boolean {
    return this.statusEffects.isFreshSpawn();
  }
  isFreshSpawnActive(currentTick: number): boolean {
    return this.statusEffects.isFreshSpawnActive(currentTick);
  }
  isFreshSpawnInvulnerable(currentTick: number): boolean {
    return this.statusEffects.isFreshSpawnInvulnerable(currentTick);
  }
  isInvulnerable(currentTick: number, bypassBarrier: boolean = false): boolean {
    const barrierActive = !bypassBarrier && this.statusEffects.isBarrierActive(currentTick);
    return barrierActive || this.statusEffects.isFreshSpawnInvulnerable(currentTick);
  }

  isBarrierActive(currentTick: number): boolean {
    return this.statusEffects.isBarrierActive(currentTick);
  }

  activateBarrier(currentTick: number, durationTicks: number): void {
    this.statusEffects.activateBarrier(currentTick, durationTicks);
  }

  expireBarrier(currentTick: number): void {
    this.statusEffects.expireBarrier(
      currentTick,
      this.statusEffects.isFreshSpawnInvulnerable(currentTick),
    );
  }

  expireFreshSpawn(currentTick: number): void {
    this.statusEffects.expireFreshSpawn(
      currentTick,
      this.statusEffects.isBarrierActive(currentTick),
    );
  }

  startStagger(durationMs: number, tickRate: number): void {
    this.statusEffects.startStagger(durationMs, tickRate);
  }

  updateStagger(ticks: number): void {
    const staggerEnded = this.statusEffects.updateStagger(ticks);
    if (staggerEnded && this.inventory.queuedSlotSwitch !== null) {
      this.forceSwitchSlot(this.inventory.queuedSlotSwitch);
      this.inventory.queuedSlotSwitch = null;
    }
  }

  applyDOT(sourceId: string, damagePerTick: number, duration: number, tickInterval: number): void {
    this.statusEffects.applyDOT(sourceId, damagePerTick, duration, tickInterval);
  }

  tickDOTs(): Array<{ sourceId: string; amount: number }> {
    return this.statusEffects.tickDOTs();
  }

  // --- Hitbox ---

  get hitbox(): import('@sector-battle/shared').AABB {
    return {
      x: this.movement.position.x - this.config.hitboxWidth / 2,
      y: this.movement.position.y - this.config.hitboxHeight / 2,
      width: this.config.hitboxWidth,
      height: this.config.hitboxHeight,
    };
  }
}
