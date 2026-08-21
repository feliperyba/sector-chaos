import { PlayerCombat } from './PlayerCombat.ts';
import type { PlayerMovement } from './PlayerMovement.ts';
import type { PlayerInventory } from './PlayerInventory.ts';
import type { PlayerStatusEffects } from './PlayerStatusEffects.ts';

export interface PlayerCombatContext {
  movement: PlayerMovement;
  combat: PlayerCombat;
  inventory: PlayerInventory;
  statusEffects: PlayerStatusEffects;
  isActive: boolean;
  isSwitching: boolean;
  isInAttackCooldown: boolean;
}

/**
 * server-combat-ctx-scratch (ticket 13): shared scratch param objects for the
 * pure `PlayerCombat.canX` statics, so the can* check path (player.canX →
 * wrapper → static) allocates zero objects per call. Safe: each wrapper fills
 * its scratch synchronously and the static consumes it immediately — the
 * statics only read fields and never retain their param (PlayerCombat.ts),
 * nothing in the chain can re-enter, and JS is single-threaded. One instance
 * per param shape.
 */
const scratchPickupCtx: Parameters<typeof PlayerCombat.canPickup>[0] = {
  isDashing: false,
  isStaggered: false,
  isInWindup: false,
  isInAttackCooldown: false,
};

const scratchAttackCtx: Parameters<typeof PlayerCombat.canAttack>[0] = {
  isFreshSpawnActive: false,
  isStaggered: false,
  isInWindup: false,
  isDashing: false,
  isSwitching: false,
  lastAttackTick: 0,
  currentTick: 0,
};

const scratchThrowCtx: Parameters<typeof PlayerCombat.canThrow>[0] = {
  isActive: false,
  isFreshSpawnActive: false,
  isStaggered: false,
  isInWindup: false,
  isInAttackCooldown: false,
  isDashing: false,
  activeSlot: 0,
  hasWeaponInActiveSlot: false,
};

const scratchBlockCtx: Parameters<typeof PlayerCombat.canBlock>[0] = {
  isFreshSpawnActive: false,
  isStaggered: false,
  isDashing: false,
};

const scratchDashCtx: Parameters<typeof PlayerCombat.canDash>[0] = {
  isFreshSpawnActive: false,
  isStaggered: false,
  isDashing: false,
  dashCooldownRemaining: 0,
};

export function canPickup(ctx: PlayerCombatContext): boolean {
  const p = scratchPickupCtx;
  p.isDashing = ctx.movement.isDashing;
  p.isStaggered = ctx.statusEffects.isStaggered();
  p.isInWindup = ctx.combat.isInWindup();
  p.isInAttackCooldown = ctx.isInAttackCooldown;
  return PlayerCombat.canPickup(p);
}

export function bypassesPlayerCollision(movement: PlayerMovement): boolean {
  return PlayerCombat.bypassesPlayerCollision(movement.isDashing);
}

export function hasDeathCollision(
  deathTick: number,
  isDying: boolean,
  currentTick: number,
): boolean {
  return PlayerCombat.hasDeathCollision(deathTick, isDying, currentTick);
}

export function isCorpse(deathTick: number, isDying: boolean): boolean {
  return PlayerCombat.isCorpse(deathTick, isDying);
}

export function canAttack(ctx: PlayerCombatContext, currentTick: number): boolean {
  const p = scratchAttackCtx;
  p.isFreshSpawnActive = ctx.statusEffects.isFreshSpawnActive(currentTick);
  p.isStaggered = ctx.statusEffects.isStaggered();
  p.isInWindup = ctx.combat.isInWindup();
  p.isDashing = ctx.movement.isDashing;
  p.isSwitching = ctx.isSwitching;
  p.lastAttackTick = ctx.combat.lastAttackTick;
  p.currentTick = currentTick;
  return PlayerCombat.canAttack(p);
}

export function canThrow(ctx: PlayerCombatContext, currentTick: number): boolean {
  const p = scratchThrowCtx;
  p.isActive = ctx.isActive;
  p.isFreshSpawnActive = ctx.statusEffects.isFreshSpawnActive(currentTick);
  p.isStaggered = ctx.statusEffects.isStaggered();
  p.isInWindup = ctx.combat.isInWindup();
  p.isInAttackCooldown = ctx.isInAttackCooldown;
  p.isDashing = ctx.movement.isDashing;
  p.activeSlot = ctx.inventory.activeSlot;
  p.hasWeaponInActiveSlot = ctx.inventory.weapons[ctx.inventory.activeSlot] !== null;
  return PlayerCombat.canThrow(p);
}

export function canBlock(ctx: PlayerCombatContext, currentTick: number): boolean {
  const p = scratchBlockCtx;
  p.isFreshSpawnActive = ctx.statusEffects.isFreshSpawnActive(currentTick);
  p.isStaggered = ctx.statusEffects.isStaggered();
  p.isDashing = ctx.movement.isDashing;
  return PlayerCombat.canBlock(p);
}

export function canDash(ctx: PlayerCombatContext, currentTick: number): boolean {
  const p = scratchDashCtx;
  p.isFreshSpawnActive = ctx.statusEffects.isFreshSpawnActive(currentTick);
  p.isStaggered = ctx.statusEffects.isStaggered();
  p.isDashing = ctx.movement.isDashing;
  p.dashCooldownRemaining = ctx.movement.dashCooldownRemaining;
  return PlayerCombat.canDash(p);
}
