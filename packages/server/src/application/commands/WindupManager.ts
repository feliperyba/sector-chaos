import { weaponRegistry, AttackType, NETWORK } from '@sector-battle/shared';
import type { Player } from '../../domain/entities/index.ts';
import type { WeaponEntity } from '../../domain/entities/index.ts';

export interface WindupResult {
  effectiveType: AttackType;
}

export class WindupManager {
  private playerLastAttackTick = new Map<string, number>();
  private playerRecentAttacks = new Map<string, Array<{ tick: number }>>();

  startWindup(player: Player, weapon: WeaponEntity, forceAttackType?: AttackType): WindupResult {
    const definition = weaponRegistry.getDefinition(weapon.type);
    const stats = definition.baseStats;
    const effectiveAttackType =
      forceAttackType ??
      (definition.meleeStats ? definition.meleeStats.attackType : stats.attackType);
    const isMeleeMode =
      effectiveAttackType !== AttackType.THROWN &&
      effectiveAttackType !== AttackType.RANGED &&
      effectiveAttackType !== AttackType.SHIELD &&
      definition.meleeStats;
    const windupMs = isMeleeMode ? definition.meleeStats!.windupMs : stats.windupMs;
    const windupTicks = Math.ceil(windupMs / NETWORK.TICK_INTERVAL);
    player.combat.startWindup(windupTicks, player.inventory.activeSlot, effectiveAttackType);

    return { effectiveType: effectiveAttackType };
  }

  checkRateLimit(playerId: string, currentTick: number): boolean {
    const recentAttacks = this.playerRecentAttacks.get(playerId) ?? [];
    const windowStart = currentTick - 60;
    const attacksInWindow = recentAttacks.filter((a) => a.tick > windowStart);
    return attacksInWindow.length <= 10;
  }

  recordRate(playerId: string, currentTick: number): void {
    const recentAttacks = this.playerRecentAttacks.get(playerId) ?? [];
    recentAttacks.push({ tick: currentTick });
    if (recentAttacks.length > 20) recentAttacks.shift();
    this.playerRecentAttacks.set(playerId, recentAttacks);
  }

  getLastAttackTick(playerId: string): number {
    return this.playerLastAttackTick.get(playerId) ?? -Infinity;
  }

  setLastAttackTick(playerId: string, tick: number): void {
    this.playerLastAttackTick.set(playerId, tick);
  }

  cleanupPlayer(playerId: string): void {
    this.playerLastAttackTick.delete(playerId);
    this.playerRecentAttacks.delete(playerId);
  }
}
