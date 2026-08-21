import { AttackType, shortestAngleDelta } from '@sector-battle/shared';
import type { Player } from '../../../domain/entities/index.ts';
import type { GameEvent } from '../../../domain/events/index.ts';
import type { IAttackHandler, AttackParams, AttackContext } from './types.ts';

const BASH_ARC_HALF = Math.PI / 3;

export class ShieldAttackHandler implements IAttackHandler {
  attackType = AttackType.SHIELD;

  execute(player: Player, params: AttackParams, ctx: AttackContext): GameEvent[] {
    const events: GameEvent[] = [];

    const fireEvent: GameEvent = {
      type: 'WeaponFired',
      tick: ctx.currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      weaponType: params.weapon.type,
      attackType: AttackType.SHIELD,
      direction: player.movement.facingAngle,
      x: player.movement.position.x,
      y: player.movement.position.y,
    };
    events.push(fireEvent);
    ctx.match.emitEvent(fireEvent);
    player.combat.clearWindup();
    player.combat.isBlocking = true;

    const range = params.stats.range;
    const facing = player.movement.facingAngle;
    const px = player.movement.position.x;
    const py = player.movement.position.y;

    const hitIds: string[] = [];
    for (const entity of ctx.entities) {
      if (entity.kind !== 'player') continue;
      if (entity.id === player.id) continue;
      const dx = entity.position.x - px;
      const dy = entity.position.y - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > range) continue;
      const angleToTarget = Math.atan2(dy, dx);
      const delta = Math.abs(shortestAngleDelta(facing, angleToTarget));
      if (delta > BASH_ARC_HALF) continue;
      hitIds.push(entity.id);
    }

    if (hitIds.length > 0) {
      params.weapon.consumeDurability(1);
    }

    ctx.resolveMeleeDamage(
      player,
      hitIds,
      params.damage,
      params.stats.knockback,
      params.weapon.type,
      params.weaponSlot,
      events,
    );

    return events;
  }
}
