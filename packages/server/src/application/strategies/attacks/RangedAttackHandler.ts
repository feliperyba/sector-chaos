import { AttackType } from '@sector-battle/shared';
import { RangedHandler } from '../../../domain/handlers/RangedHandler.ts';
import type { Player } from '../../../domain/entities/index.ts';
import type { GameEvent } from '../../../domain/events/index.ts';
import type { IAttackHandler, AttackParams, AttackContext } from './types.ts';
import { Position } from '../../../domain/value-objects/index.ts';

export class RangedAttackHandler implements IAttackHandler {
  attackType = AttackType.RANGED;
  private rangedHandler = new RangedHandler();

  execute(player: Player, params: AttackParams, ctx: AttackContext): GameEvent[] {
    const { weapon, damage, stats } = params;
    const events: GameEvent[] = [];

    weapon.use();

    // Break weapon if ammo depleted — mirrors GameMatchWeapons.onWeaponBreak.
    // Without this, bows/crossbows stay in inventory at ammo=0, silently
    // failing every shot while the bot keeps trying to fire.
    if (weapon.isBroken) {
      player.onWeaponBreak(params.weaponSlot, false, 60);
    }

    const aimAngle = player.movement.facingAngle;
    if (stats.projectileSpeed === undefined) {
      throw new Error(`Weapon missing projectileSpeed: ${weapon.type}`);
    }
    const fireResult = this.rangedHandler.fire(
      player.id,
      new Position(ctx.spawnPosition.x, ctx.spawnPosition.y),
      weapon.type,
      damage,
      stats.knockback,
      stats.range,
      aimAngle,
      ctx.idGenerator,
      stats.projectileSpeed,
    );
    if (fireResult.projectile) {
      ctx.match.addProjectile(fireResult.projectile);
    }

    const fireEvent: GameEvent = {
      type: 'WeaponFired',
      tick: ctx.currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      weaponType: weapon.type,
      attackType: params.effectiveType,
      direction: player.movement.facingAngle,
      x: player.movement.position.x,
      y: player.movement.position.y,
    };
    events.push(fireEvent);
    ctx.match.emitEvent(fireEvent);
    player.combat.clearWindup();

    return events;
  }
}
