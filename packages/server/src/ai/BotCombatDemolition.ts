import { angleTo, distance, normalizeAngle } from '@sector-battle/shared';
import type { BotContext } from './BotContext.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import { makeMoveInput, makeAttackInput, makeSwitchSlotInput } from './BotInput.ts';
import { PERCENT_TO_TICKS } from './BotCombatShared.ts';
import { botCanSwitchSlotNow } from './skill/RestrictionTables.ts';
import { safeGetWeaponDef } from './BotLoadout.ts';

export function executeDemolition(
  ctx: BotContext,
  targetX: number,
  targetY: number,
): QueuedInput[] {
  const inputs: QueuedInput[] = [];

  // WEAPON-AWARE SLOT SELECTION: switch to the best wall-breaking weapon before
  // swinging. The active weapon may be a low-destructibleDamage type (Dagger 3,
  // Fists 2) while the bot holds a Hammer (10). Breaking a HP-10 wall takes 1
  // Hammer hit vs 4 Dagger hits — and each miss against the off-center SAT
  // polygon wastes a durability point. Switch first (10-tick gate), then break.
  // Only switch if there's a strictly better option than the active slot.
  // MID-FIGHT SWITCH RESTRICTION (DEC-009.3, review M2): gated on
  // botCanSwitchSlotNow — a locked tier in DEMOLITION state breaks the
  // destructible with whatever it is holding (the learnable habit; the
  // weapon-break switch remains the exempt forced-re-arm seam).
  const switchReady = ctx.tick - ctx.lastSwitchSlotTick > 9;
  if (switchReady && botCanSwitchSlotNow(ctx)) {
    const bestSlot = ctx.getBestSlotForDestructibles();
    if (bestSlot !== ctx.activeSlot) {
      inputs.push(
        makeSwitchSlotInput(ctx.playerId, bestSlot, ctx.tick, 'demolition-switch-breaker'),
      );
      ctx.lastSwitchSlotTick = ctx.tick;
      return inputs; // wait a tick for the switch to take effect before attacking
    }
  }

  const weapon = ctx.getActiveWeapon();
  const def = safeGetWeaponDef(weapon.weaponType);
  if (!def) return inputs; // unknown weapon type — bail (defensive; unreachable for registry-minted weapons)
  const range = def.baseStats.range;
  const cooldownTicks = Math.ceil((def.baseStats.cooldown ?? 400) * PERCENT_TO_TICKS);
  const dist = distance(ctx.x, ctx.y, targetX, targetY);
  const aimAngle = angleTo(ctx.x, ctx.y, targetX, targetY);

  // ATTACK DISTANCE — the aim point is now the destructible's REAL SAT polygon
  // centroid (set by executeDemolitionState via destructibleCentroidMap), so the
  // standard weapon range applies: stand at range*0.8 and the blade/projectile
  // reaches the polygon. ARC weapons sweep a 90° cone that comfortably covers
  // the polygon from this distance; LINE thrust through; RANGED fire a point.
  // (Previously this was a hardcoded 110px band-aid to compensate for aiming at
  // tile-center and missing the off-center polygon ~88% of the time — no longer
  // needed now that the aim reads the actual collider.)
  const attackDist = range * 0.8;
  const approachDist = range * 0.8;

  const cooldownReady = ctx.tick - ctx.lastAttackTick >= cooldownTicks;
  if (dist <= attackDist + 20 && cooldownReady) {
    // Within striking distance + cooldown ready → swing. The +20 slack accounts
    // for the bot drifting during the windup.
    inputs.push(makeAttackInput(ctx.playerId, aimAngle, ctx.tick));
    ctx.lastAttackTick = ctx.tick;
  } else if (dist > approachDist) {
    // Too far — close in. Approach to approachDist so we're in arc range.
    inputs.push(makeMoveInput(ctx.playerId, aimAngle, aimAngle, ctx.tick));
  } else {
    // In range but on cooldown — micro-strafe along the wall face so the bot
    // visibly repositions (looks alive, finds a cleaner strike angle) instead
    // of standing frozen against the wall reading as "stuck." Face the wall
    // (aimAngle) for the next swing while drifting perpendicular. The strafeDir
    // periodically flips (managed in BotCombat's strafe cadence) so the bot
    // oscillates gently rather than wandering off the wall it's breaking.
    const strafeAngle = normalizeAngle(aimAngle + (ctx.strafeDir * Math.PI) / 3);
    inputs.push(makeMoveInput(ctx.playerId, strafeAngle, aimAngle, ctx.tick));
  }

  if (inputs.length === 0) {
    inputs.push(makeMoveInput(ctx.playerId, aimAngle, aimAngle, ctx.tick));
  }
  return inputs;
}
