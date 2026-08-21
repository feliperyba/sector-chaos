import { AttackType, NETWORK } from '@sector-battle/shared';
import { MeleeLineHandler } from '../../../domain/handlers/MeleeLineHandler.ts';
import type { Player } from '../../../domain/entities/index.ts';
import type { GameEvent } from '../../../domain/events/index.ts';
import type { IAttackHandler, AttackParams, AttackContext } from './types.ts';

export class LineAttackHandler implements IAttackHandler {
  attackType = AttackType.LINE;
  private lineHandler = new MeleeLineHandler();

  execute(player: Player, params: AttackParams, ctx: AttackContext): GameEvent[] {
    const { weapon, weaponSlot, damage, stats, definition } = params;
    const events: GameEvent[] = [];

    if (definition.meleeStats) {
      const meleeCooldownTicks = Math.ceil(definition.meleeStats.cooldown / NETWORK.TICK_INTERVAL);
      weapon.startAttackWithCooldown(meleeCooldownTicks);
    } else {
      weapon.startAttack();
    }

    const hitResult = this.lineHandler.execute(player, stats.range, ctx.entities);
    weapon.consumeDurability(hitResult.durabilityCost);
    if (weapon.isBroken) {
      ctx.match.handleWeaponBreak(player.id, weaponSlot);
      player.combat.clearWindup();
      return events;
    }
    if (hitResult.hitEntityIds.length > 0) {
      ctx.resolveMeleeDamage(
        player,
        hitResult.hitEntityIds,
        damage,
        stats.knockback,
        weapon.type,
        weaponSlot,
        events,
      );
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
