import { Health } from '../value-objects/index.ts';
import { PlayerStatus } from '@sector-battle/shared';
import type { Player } from './Player.ts';
import type { DamageResult } from './Player.ts';

export function applyDamage(
  player: Player,
  amount: number,
  tick: number,
  skipInvulnerability: boolean = false,
): DamageResult {
  if (!player.isActive) {
    return { killed: false, damageApplied: 0 };
  }

  if (!skipInvulnerability && player.statusEffects.isInvulnerable(tick)) {
    return { killed: false, damageApplied: 0 };
  }

  player.statusEffects.lastDamageTick = tick;
  player.health = player.health.damage(amount);
  player.damageTaken += amount;

  if (player.health.isDead) {
    return { killed: true, damageApplied: amount };
  }

  return { killed: false, damageApplied: amount };
}

/**
 * server-alive-counter: fire the player's aliveness-transition hook iff the
 * ALIVE status bit actually flipped across a lifecycle write. Callers capture
 * `wasAlive` BEFORE mutating `statusEffects.status`. No-op when the bit did
 * not change (guards idempotent re-calls such as revive on an already-alive
 * player).
 */
function fireAlivenessIfFlipped(player: Player, wasAlive: boolean): void {
  const isAlive = player.statusEffects.isAlive();
  if (isAlive !== wasAlive) player.onAlivenessTransition?.(isAlive);
}

export function killPlayer(player: Player): void {
  if (player.statusEffects.isSpectating() || player.statusEffects.isDead()) return;
  const wasAlive = player.statusEffects.isAlive();
  player.combat.clearWindup();
  player.combat.isBlocking = false;
  player.movement.knockbackVelocityX = 0;
  player.movement.knockbackVelocityY = 0;
  player.movement.velocityX = 0;
  player.movement.velocityY = 0;
  player.statusEffects.status = PlayerStatus.SPECTATING;
  player.statusEffects.deathTick = -1;
  fireAlivenessIfFlipped(player, wasAlive);
}

export function beginDying(player: Player, currentTick: number): void {
  if (
    player.statusEffects.isDying() ||
    player.statusEffects.isSpectating() ||
    player.statusEffects.isDead()
  )
    return;
  const wasAlive = player.statusEffects.isAlive();
  player.combat.clearWindup();
  player.movement.knockbackVelocityX = 0;
  player.movement.knockbackVelocityY = 0;
  player.movement.velocityX = 0;
  player.movement.velocityY = 0;
  player.statusEffects.barrierActive = false;
  player.combat.isBlocking = false;
  player.statusEffects.barrierExpiryTick = 0;
  player.statusEffects.speedBoostExpiryTick = 0;
  player.statusEffects.status = PlayerStatus.DYING;
  player.statusEffects.deathTick = currentTick;
  player.inventory.queuedSlotSwitch = null;
  player.inventory.switchTarget = null;
  player.inventory.switchRemaining = 0;
  fireAlivenessIfFlipped(player, wasAlive);
}

export function completePlayerDeath(player: Player): void {
  const wasAlive = player.statusEffects.isAlive();
  player.statusEffects.status = PlayerStatus.SPECTATING;
  fireAlivenessIfFlipped(player, wasAlive);
}

export function revivePlayer(
  player: Player,
  currentTick: number,
  baseHealth: number,
  maxHealth: number,
): void {
  const wasAlive = player.statusEffects.isAlive();
  player.statusEffects.status =
    PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.FRESH_SPAWN;
  player.health = new Health(baseHealth, maxHealth);
  player.spawnTick = currentTick;
  player.statusEffects.initFreshSpawn(currentTick);
  player.statusEffects.barrierExpiryTick = 0;
  player.statusEffects.speedBoostExpiryTick = 0;
  player.combat.isBlocking = false;
  player.movement.velocityX = 0;
  player.movement.velocityY = 0;
  fireAlivenessIfFlipped(player, wasAlive);
}
