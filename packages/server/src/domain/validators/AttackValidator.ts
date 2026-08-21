import { PlayerStatus, MatchPhase } from '@sector-battle/shared';
import type { Player, WeaponEntity } from '../entities/index.ts';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export class AttackValidator {
  validate(
    player: Player,
    weapon: WeaponEntity | null,
    lastAttackTick: number,
    currentTick: number,
    matchPhase: number,
    options?: { skipCanUse?: boolean },
  ): ValidationResult {
    if (player.combat.isInWindup()) {
      return { valid: false, reason: 'PLAYER_IN_WINDUP' };
    }

    if (player.statusEffects.status & PlayerStatus.STAGGERED) {
      return { valid: false, reason: 'PLAYER_STAGGERED' };
    }

    if (!player.isActive) {
      return { valid: false, reason: 'PLAYER_NOT_ALIVE' };
    }

    if (weapon === null) {
      return { valid: false, reason: 'NO_WEAPON' };
    }

    if (!options?.skipCanUse && !weapon.canUse) {
      return { valid: false, reason: 'WEAPON_NOT_READY' };
    }

    if (currentTick - lastAttackTick < weapon.cooldown) {
      return { valid: false, reason: 'COOLDOWN_NOT_ELAPSED' };
    }

    if (
      matchPhase !== MatchPhase.ACTIVE &&
      matchPhase !== MatchPhase.ZONE_SHRINKING &&
      matchPhase !== MatchPhase.FINAL_CLOSURE &&
      matchPhase !== MatchPhase.OVERTIME
    ) {
      return { valid: false, reason: 'MATCH_NOT_ACTIVE' };
    }

    return { valid: true };
  }

  validateRate(
    playerId: string,
    recentAttacks: Array<{ tick: number }>,
    currentTick: number,
  ): boolean {
    const windowStart = currentTick - 60;
    const attacksInWindow = recentAttacks.filter((a) => a.tick > windowStart);
    return attacksInWindow.length <= 10;
  }

  validateWeaponInInventory(player: Player, weapon: WeaponEntity): boolean {
    return player.inventory.weapons.some((w) => w?.id === weapon.id);
  }
}
