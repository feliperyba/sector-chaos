/**
 * PlayerRendererReactions — deterministic combat reactions applied to the
 * animation drivers from server events (mirrors the server's impulses).
 */
import {
  AttackType,
  computeBlockClash,
  getMotionSpec,
  worldToLocalVec,
} from '@sector-battle/shared';
import { AnimationState } from '../types.js';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';
import { CONTACT_JUICE, getImpactJuice } from './JuiceConfig.js';

/** Contact hit-stop for the weapon the attack cycle is using (heft-scaled). */
function contactHitStopMs(weaponType: number): number {
  return getImpactJuice(weaponType).hitStopMs;
}

export interface ReactionContext {
  bundles: Map<string, PlayerRenderBundle>;
  localPlayerId: string | null;
}

/** Attacker-side hit-confirm: recoil impulse + hit-stop for the local player. */
export function triggerMeleeHitReaction(ctx: ReactionContext, key: string): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const driver = bundle.driver;
  const v = bundle.visual;
  if (driver.atkType === AttackType.THROWN || driver.atkType === AttackType.RANGED) return;
  if (
    driver.animState !== AnimationState.ATTACK_IMPACT &&
    driver.animState !== AnimationState.COOLDOWN
  )
    return;
  driver.applyAttackerRecoil();
  // Full per-weapon hit-stop ON CONTACT — the moment that sells the weight
  if (key === ctx.localPlayerId) {
    v.hitStopRemaining += contactHitStopMs(driver.attackWeaponType);
  }
}

/** Victim flinch from PlayerDamaged (world knockback vector from the event). */
export function applyHitFlinch(
  ctx: ReactionContext,
  key: string,
  kbWorldX: number,
  kbWorldY: number,
): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const driver = bundle.driver;
  const v = bundle.visual;
  driver.applyHitFlinch(kbWorldX, kbWorldY, v.facingAngle);

  // ── Victim body juice: squash + recoil ──
  // Convert world-space knockback to local space for directional squash
  const local = worldToLocalVec(v.facingAngle, kbWorldX, kbWorldY);
  const kbLen = Math.sqrt(local.x * local.x + local.y * local.y);
  if (kbLen < 0.001) return;
  const dirX = local.x / kbLen;
  const dirY = local.y / kbLen;

  // Impact force scaled by knockback magnitude — heavier weapons produce more
  // knockback, so the juice scales naturally with the hit's power.
  const force = Math.min(3.0, Math.max(0.6, kbLen * 0.15));

  v.victimImpactTime = performance.now();
  v.victimImpactDirX = dirX;
  v.victimImpactDirY = dirY;
  v.victimImpactHeft = force;

  // Inject body scale velocity — compress along hit axis, stretch perpendicular
  // Negative scaleX velocity = compress (shrink), positive scaleY = stretch
  v.bodyScaleVelX -= force * 12;
  v.bodyScaleVelY += force * 8;

  // Inject recoil offset velocity — shove body in knockback direction (local space)
  // Positive local X = forward (away from attacker if hit from front)
  v.victimOffsetVelX += dirX * force * 80;
  v.victimOffsetVelY += dirY * force * 80;
}

/** Weapon-vs-shield clash from ShieldBlocked: both sides recoil. */
export function triggerBlockClash(
  ctx: ReactionContext,
  defenderId: string,
  attackerId: string,
  contactX: number | undefined,
  contactY: number | undefined,
  attackerWeaponType: number | undefined,
): void {
  const defenderBundle = ctx.bundles.get(defenderId);
  const attackerBundle = ctx.bundles.get(attackerId);
  const defender = defenderBundle?.visual;
  const defenderDriver = defenderBundle?.driver;
  const attackerDriver = attackerBundle?.driver;
  const attacker = attackerBundle?.visual;

  const attackerSpec = getMotionSpec(Math.max(0, attackerWeaponType ?? 0), undefined);
  const defenderSpec = getMotionSpec(Math.max(0, defender?.equippedWeaponType ?? 0), undefined);

  // Contact normal: from the blade contact toward the defender's body
  let normalLocalX = 1;
  let normalLocalY = 0;
  if (defender && contactX !== undefined && contactY !== undefined) {
    const local = worldToLocalVec(
      defender.facingAngle,
      defender.body.x - contactX,
      defender.body.y - contactY,
    );
    normalLocalX = local.x;
    normalLocalY = local.y;
  }

  const clash = computeBlockClash(
    1, // attacker swing travels forward in its local space
    0,
    normalLocalX,
    normalLocalY,
    attackerSpec.reactions,
    defenderSpec.reactions,
  );
  attackerDriver?.applyImpulses(clash.attacker);
  attackerDriver?.interruptSwing();
  defenderDriver?.applyImpulses(clash.defender);
  if (attacker && attackerId === ctx.localPlayerId) {
    attacker.hitStopRemaining +=
      contactHitStopMs(attackerWeaponType ?? 0) * CONTACT_JUICE.clashHitStopScale;
  }
}

/** Melee swing struck a wall: recoil feedback (WeaponWallHit event). The
 *  swing continues — the blade is physically clamped, not cancelled. */
export function triggerWallHit(ctx: ReactionContext, key: string): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const driver = bundle.driver;
  const v = bundle.visual;
  driver.applyAttackerRecoil();
  // Dead stop against an indestructible wall — slightly shorter than flesh
  if (v && key === ctx.localPlayerId) {
    v.hitStopRemaining +=
      contactHitStopMs(driver.attackWeaponType) * CONTACT_JUICE.wallHitStopScale;
  }
}
