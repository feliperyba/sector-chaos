import { AttackType, COMBAT } from '@sector-battle/shared';
import { ThrowHandler } from '../../../domain/handlers/ThrowHandler.ts';
import type { Player } from '../../../domain/entities/index.ts';
import type { GameEvent } from '../../../domain/events/index.ts';
import type { IAttackHandler, AttackParams, AttackContext } from './types.ts';
import { Position } from '../../../domain/value-objects/index.ts';

export class ThrownAttackHandler implements IAttackHandler {
  attackType = AttackType.THROWN;
  private throwHandler = new ThrowHandler();

  execute(player: Player, params: AttackParams, ctx: AttackContext): GameEvent[] {
    const { weapon, weaponSlot, damage, stats } = params;
    const events: GameEvent[] = [];

    if (stats.throwSpeed === undefined) {
      throw new Error(`Weapon missing throwSpeed: ${weapon.type}`);
    }
    const throwSpeed = stats.throwSpeed;
    const throwRange = Math.min(stats.throwRange ?? stats.range, COMBAT.THROW_RANGE);
    const throwDurability = weapon.isBroken ? 1 : weapon.ammo;
    const throwResult = this.throwHandler.throw(
      player.id,
      new Position(ctx.spawnPosition.x, ctx.spawnPosition.y),
      weapon.type,
      damage,
      stats.knockback,
      COMBAT.MAX_BOUNCES,
      player.movement.facingAngle,
      throwSpeed,
      throwRange,
      ctx.idGenerator,
      throwDurability,
      ctx.currentTick,
      weaponSlot,
      weapon.tier,
    );
    if (throwResult.projectile) {
      ctx.match.addProjectile(throwResult.projectile);
      player.combat.addThrowInFlight(throwResult.projectile.id);
    }
    player.removeWeapon(weaponSlot);

    const fireEvent: GameEvent = {
      type: 'WeaponFired',
      tick: ctx.currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      weaponType: weapon.type,
      attackType: AttackType.THROWN,
      direction: player.movement.facingAngle,
      x: player.movement.position.x,
      y: player.movement.position.y,
    };
    events.push(fireEvent);
    ctx.match.emitEvent(fireEvent);

    ctx.match.emitEvent({
      type: 'WeaponThrown',
      tick: ctx.currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      weaponType: weapon.type,
      weaponSlot,
      x: player.movement.position.x,
      y: player.movement.position.y,
    });

    player.combat.clearWindup();

    return events;
  }
}
