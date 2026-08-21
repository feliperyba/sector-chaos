import { DamageType, WeaponType, shortestAngleDelta, weaponRegistry } from '@sector-battle/shared';
import type { Player } from '../entities/index.ts';

export interface ProcessedDamage {
  damage: number;
  knockback: number;
  blocked: boolean;
  shieldBroken: boolean;
}

const BLOCKABLE_DAMAGE_TYPES: ReadonlySet<DamageType> = new Set([
  DamageType.MELEE_HIT,
  DamageType.THROWN_HIT,
  DamageType.RANGED_HIT,
]);

export class ShieldHandler {
  processIncomingDamage(
    player: Player,
    damage: number,
    knockback: number,
    attackAngle: number,
    shieldDurability: number,
    damageType: DamageType,
    currentTick: number,
  ): ProcessedDamage {
    if (!BLOCKABLE_DAMAGE_TYPES.has(damageType)) {
      return { damage, knockback, blocked: false, shieldBroken: false };
    }

    const weapon = player.getActiveWeapon();
    if (!isShieldWeaponType(weapon.type)) {
      return { damage, knockback, blocked: false, shieldBroken: false };
    }

    if (!player.canBlock(currentTick)) {
      return { damage, knockback, blocked: false, shieldBroken: false };
    }

    const def = weaponRegistry.getDefinition(weapon.type);
    const blockArcHalf = ((def?.baseStats.blockArcDegrees ?? 90) * Math.PI) / 360;
    if (!this.isFrontAttack(player, attackAngle, blockArcHalf)) {
      return { damage, knockback, blocked: false, shieldBroken: false };
    }

    const newDurability = shieldDurability - 1;
    return {
      damage: 0,
      knockback: 0,
      blocked: true,
      shieldBroken: newDurability <= 0,
    };
  }

  clearPlayer(_playerId: string): void {}

  private isFrontAttack(player: Player, attackAngle: number, blockArcHalf: number): boolean {
    const facingAngle = player.movement.facingAngle;
    const delta = Math.abs(shortestAngleDelta(facingAngle, attackAngle));
    return delta <= blockArcHalf;
  }
}

function isShieldWeaponType(weaponType: WeaponType): boolean {
  const definition = weaponRegistry.getDefinition(weaponType);
  return definition?.baseStats.attackType === ('shield' as const);
}
