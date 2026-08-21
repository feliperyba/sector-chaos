import {
  DamageType,
  WeaponType,
  getMotionSpec,
  computeAttackerRecoil,
  computeBlockClash,
  computeHitFlinch,
  computeWallRecoil,
  worldToLocalVec,
  type Vec2,
} from '@sector-battle/shared';
import type { Player } from '../entities/index.ts';
import type { MeleeSweepHandler, SwingState } from './MeleeSweepHandler.ts';
import { swingDirection } from './MeleeSweepGeometry.ts';

/**
 * Contact resolution for the melee sweep pipeline. Mechanical extraction from
 * MeleeSweepHandler — bodies verbatim, `this.→handler.` only.
 */

/**
 * Route a contacted player through the damage pipeline at the contact tick.
 * sourcePosition = blade contact point → the shield block arc check and the
 * knockback direction are both contact-accurate. Returns true if blocked.
 */
export function resolvePlayerContact(
  handler: MeleeSweepHandler,
  swing: SwingState,
  attacker: Player,
  targetId: string,
  contact: Vec2,
  tip: Vec2,
  prevTip: Vec2,
  tick: number,
): boolean {
  const swingDir = swingDirection(attacker, tip, prevTip);

  const events = handler.match.getDamagePipeline().processAttack(
    {
      attackerId: attacker.id,
      weaponType: swing.weapon.type,
      damage: swing.damage,
      knockbackForce: swing.knockback,
      damageType: DamageType.MELEE_HIT,
      hitTargetIds: [targetId],
      attackAngle: Math.atan2(swingDir.y, swingDir.x),
      sourcePosition: { x: contact.x, y: contact.y },
      currentTick: tick,
      tickRate: 60,
      alivePlayerCount: handler.match.getAlivePlayerCount(),
    },
    (id) => handler.match.getPlayer(id),
  );

  let blocked = false;
  for (const event of events) {
    if (event.type === 'ShieldBlocked') {
      blocked = true;
      event.contactX = contact.x;
      event.contactY = contact.y;
      event.attackerWeaponType = swing.weapon.type;
    }
    handler.match.emitEvent(event);
  }

  const target = handler.match.getPlayer(targetId);

  if (blocked && target) {
    // Clash: attacker bounces back, defender's guard compresses; defender
    // takes a reduced pushback (block zeroes the pipeline's knockback).
    const defenderSpec = getMotionSpec(
      target.getActiveWeapon()?.type ?? WeaponType.FISTS,
      undefined,
    );
    const attackerLocal = worldToLocalVec(attacker.movement.facingAngle, swingDir.x, swingDir.y);
    const normalX = target.movement.position.x - contact.x;
    const normalY = target.movement.position.y - contact.y;
    const defenderLocal = worldToLocalVec(target.movement.facingAngle, normalX, normalY);
    const clash = computeBlockClash(
      attackerLocal.x,
      attackerLocal.y,
      defenderLocal.x,
      defenderLocal.y,
      swing.spec.reactions,
      defenderSpec.reactions,
    );
    handler.animationSystem.applyImpulses(attacker.id, clash.attacker);
    handler.animationSystem.applyImpulses(targetId, clash.defender);

    // GDD §7.1/§7.3: blocked attacks deal 0 damage AND 0 knockback to the
    // defender. The previous code applied swing.knockback * 0.4 on every
    // successful block, which shoved the defender backward out of melee range
    // — repeated blocks then silently stopped landing (the attacker's sweep
    // could no longer reach), reading in gameplay as "my shield worked for a
    // couple hits then stopped." The defender stays put; only the visual clash
    // impulse (animation-only, no position drift) plays. normalX/normalY are
    // still consumed by the clash impulse computation above.
    return true;
  }

  // Flesh hit: victim flinch (from the event's knockback vector — clients
  // replicate from PlayerDamaged) + attacker hit-confirm recoil.
  for (const event of events) {
    if (event.type === 'PlayerDamaged' && target) {
      const localKb = worldToLocalVec(
        target.movement.facingAngle,
        event.knockbackX,
        event.knockbackY,
      );
      handler.animationSystem.applyImpulses(
        targetId,
        computeHitFlinch(localKb.x, localKb.y, weightClassOf(handler, target)),
      );
      const attackerLocal = worldToLocalVec(attacker.movement.facingAngle, swingDir.x, swingDir.y);
      handler.animationSystem.applyImpulses(
        attacker.id,
        computeAttackerRecoil(attackerLocal.x, attackerLocal.y, swing.spec.reactions),
      );
    }
  }
  return false;
}

export function onWallHit(
  handler: MeleeSweepHandler,
  swing: SwingState,
  player: Player,
  wallHit: { x: number; y: number; gridX: number; gridY: number },
  _grip: Vec2,
  tip: Vec2,
  prevTip: Vec2 | null,
  tick: number,
): void {
  handler.match.emitEvent({
    type: 'WeaponWallHit',
    tick,
    timestamp: Date.now(),
    playerId: player.id,
    weaponType: swing.weapon.type,
    x: wallHit.x,
    y: wallHit.y,
    gridX: wallHit.gridX,
    gridY: wallHit.gridY,
  });

  const swingDir = swingDirection(player, tip, prevTip ?? tip);
  const local = worldToLocalVec(player.movement.facingAngle, swingDir.x, swingDir.y);
  handler.animationSystem.applyImpulses(
    player.id,
    computeWallRecoil(local.x, local.y, swing.spec.reactions),
  );
}

export function weightClassOf(handler: MeleeSweepHandler, player: Player): number {
  const type = player.getActiveWeapon()?.type ?? WeaponType.FISTS;
  return getMotionSpec(type, undefined).weightClass;
}
