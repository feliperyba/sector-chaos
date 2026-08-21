import {
  WeaponType,
  BARREL,
  AttackType,
  angleTo,
  distance,
  absAngleDelta,
} from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from './BotContext.ts';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import { validateFinalAngle } from './BotNavigationBlend.ts';
import { safeGetWeaponDef } from './BotLoadout.ts';
import { isBarrel } from './BotDestructibles.ts';
import { getEnemyHistory } from './BotContextEnemyHistory.ts';

const STRAFE_MIN_TICKS = 20;
const STRAFE_MAX_TICKS = 45;
const DASH_COOLDOWN_TICKS = 180;
const ENEMY_WHIFF_THRESHOLD = 8;
const AIM_ERROR_RAD = 0.03;
const ATTACK_RANGE_MARGIN = 0.88;
const PREDICTION_TICKS_MELEE = 4;
const PERCENT_TO_TICKS = 0.06;
const PROJECTILE_DODGE_RANGE = 250;
// (The windup-dodge gates and the dodge decision itself moved to the Reactor
// in bot-ai-v2 ticket 04: the windup reaction is now priority 5 of the
// reactor/ReactorConditions.ts priority walk, UN-GATED from the retired
// caution threshold for every archetype per DEC-004/DEC-010.2.)
// Hazard avoidance radii. Must EXCEED the lethal range so the bot steers away
// before it is already inside it. Barrels chain-explode across
// BARREL.EXPLOSION_RADIUS (256px) for 50 dmg — a single chain can kill — so
// they get a much wider berth and a stronger weight than traps. Kept tight
// (256+64) so the matching perception scan range stays cheap.
// Hazard avoidance radii. Traps have a 128px trigger radius; we avoid at 220px
// (was 180) to give reaction time — a bot moving at base speed covers ~17px/tick,
// so 220px gives ~5 ticks of steering correction before entering the lethal zone.
const TRAP_AVOID_RADIUS = 220;
const BARREL_AVOID_RADIUS = BARREL.EXPLOSION_RADIUS + 90;

export {
  STRAFE_MIN_TICKS,
  STRAFE_MAX_TICKS,
  DASH_COOLDOWN_TICKS,
  ENEMY_WHIFF_THRESHOLD,
  AIM_ERROR_RAD,
  ATTACK_RANGE_MARGIN,
  PREDICTION_TICKS_MELEE,
  PERCENT_TO_TICKS,
  PROJECTILE_DODGE_RANGE,
};

/**
 * Returns true if attacking right now would be suicidal — i.e. the attack
 * would HIT a barrel near enough that the resulting blast catches the bot.
 *
 * DIRECTIONAL + WEAPON-AWARE (was a flat "any barrel within 256px suppresses
 * all attacks"). The old check was non-directional: a barrel 200px BEHIND a
 * melee bot (opposite the swing arc) suppressed the attack, and ranged weapons
 * were fully blocked despite firing toward a distant enemy with no barrel on
 * the firing line. With cover-biased barrel placement (48-80/map), the
 * converged late-game zone center frequently had a barrel in blast range of
 * both survivors — so BOTH suppressed ALL attacks and the match stalled with
 * zero kills for 40+ seconds (confirmed in benchmark seed 2026).
 *
 * Now the suppression is keyed on whether the attack would actually intersect
 * a barrel's blast zone:
 *  - ARC melee: barrel within range AND within the swing arc (facing the aim
 *    direction) AND within blast radius of the bot → unsafe. A barrel behind
 *    the bot (outside the 90° arc) is safe — the swing can't clip it.
 *  - LINE: barrel within range along the thrust ray (narrow angular band) →
 *    unsafe.
 *  - RANGED/THROWN: barrel within blast radius of the bot→target SEGMENT →
 *    unsafe. A barrel beside the bot but off the firing line is safe; a barrel
 *    the projectile would pass near is unsafe (it detonates on the path).
 *
 * @param aimAngle   the direction the attack will fire/swing
 * @param range      the weapon's reach (px)
 * @param attackType ARC | LINE | RANGED | THROWN | SHIELD
 */
export function isAttackUnsafeNearBarrel(
  ctx: BotContext,
  aimAngle: number,
  range: number,
  attackType: AttackType,
): boolean {
  const blast = BARREL.EXPLOSION_RADIUS;
  // Angular half-width of the threat cone. ARC weapons swing a 90° cone
  // (Math.PI/2) so a barrel within ±45° of the aim is in the arc. LINE thrusts
  // a narrow hitbox (~20px) — use a tight ±10° band. RANGED/THROWN projectiles
  // travel a ray to the target — use a moderate ±18° band to catch barrels the
  // projectile passes near (projectile + barrel have finite size, and chain-
  // explosions extend the effective radius). SHIELD bash is a short frontal
  // arc like a weak ARC.
  const arcHalf =
    attackType === AttackType.ARC
      ? Math.PI / 4
      : attackType === AttackType.LINE
        ? Math.PI / 18
        : attackType === AttackType.SHIELD
          ? Math.PI / 4
          : Math.PI / 10; // RANGED / THROWN
  const cosHalf = Math.cos(arcHalf);
  const aimX = Math.cos(aimAngle);
  const aimY = Math.sin(aimAngle);
  for (const danger of ctx.dangers) {
    if (!isBarrel(danger.type)) continue;
    const dx = danger.x - ctx.x;
    const dy = danger.y - ctx.y;
    const distToBarrel = Math.sqrt(dx * dx + dy * dy) || 1;
    // Is the barrel in the attack's threat cone? dot(aimDir, toBarrel) > cosHalf.
    const dot = (aimX * dx + aimY * dy) / distToBarrel;
    if (dot < cosHalf) continue; // barrel is outside the swing/firing arc
    if (attackType === AttackType.RANGED || attackType === AttackType.THROWN) {
      // Projectile travels to max range along the ray. A barrel is threatened
      // if it's within blast radius of any point on the bot→max-range segment
      // (the projectile passes close enough to detonate it). Approximate: barrel
      // is within blast of the segment if its perpendicular distance to the ray
      // is < blast AND its projection onto the ray is within [0, range+blast].
      const perpDist = Math.abs(aimX * dy - aimY * dx) / 1; // |cross| / |aim|=1
      const proj = dot * distToBarrel; // distance along the ray
      if (perpDist < blast && proj > -blast && proj < range + blast) return true;
    } else {
      // Melee (ARC/LINE/SHIELD): the barrel is in the cone. Unsafe only if it's
      // close enough that the bot is inside the resulting blast (a barrel at the
      // edge of a 224px range swing, 256px blast → 224+256=480px from bot, but
      // the blast catches the bot only if barrel is within blast of the bot).
      // Also gate on range — a barrel beyond weapon range can't be hit by the
      // swing even if it's in the cone.
      if (distToBarrel < blast && distToBarrel < range + 32) return true;
    }
  }
  return false;
}

export function getBackoffTicks(weaponType: WeaponType): number {
  if (weaponType === WeaponType.FISTS) return 0;
  // WEIGHT-TIER-AWARE BACKOFF: heavy ARC weapons (Long Sword, Hammer, Large Axe,
  // Bladed Axe, Double Axe — weightTier 2-3) have long cooldowns and long
  // windups, so after swinging they're committed and vulnerable to a faster
  // enemy's counter. Retreating further after the swing avoids the trade. Light
  // weapons (weightTier 0-1: Dagger, Short Sword) win by attack FREQUENCY, so
  // they keep pressure with a short backoff. The old flat 3 (Dagger) / 6 (rest)
  // made a Hammer and a Short Sword back off identically — heavy weapons traded
  // into counters they should have retreated from, light weapons lost pressure
  // they should have maintained. weightTier is the game's own heaviness axis
  // (0=light/fast → 3=heavy/slow); scaling backoff by it gives each class the
  // recovery window its weapon profile demands.
  // Unknown weapon → null → default weightTier 1 (generic backoff)
  const weightTier = safeGetWeaponDef(weaponType)?.baseStats.weightTier ?? 1;
  if (weightTier <= 0) return 3; // light: keep pressure
  if (weightTier === 1) return 5; // medium (Short Sword tier)
  if (weightTier === 2) return 8; // heavy (Long Sword / Large Axe)
  return 12; // very heavy (Hammer / Double Axe) — long recovery, retreat hard
}

/**
 * Combat-path hazard blend + THE WALL-VALIDATION CHOKE POINT (DEC-005.1,
 * review M1): blend barrels/traps/incoming-projectile repulsion into the
 * intended move angle, then validate the FINAL angle against walls via
 * {@linkcode validateFinalAngle} — ALWAYS, on every path, including the
 * no-dangers fast path (a raw combat angle — flee/strafe/kite geometry — can
 * itself point into a wall). Every combat emission that is not already on
 * navigateTo's pipeline routes through here, so the invariant "no emitted
 * movement angle points into a wall" holds at THIS seam by construction:
 * walkable → unchanged; blocked → stateful slide / deterministic ring scan
 * (see BotNavigationBlend.validateFinalAngle). One isWalkable probe in the
 * common case — the budget cost is one grid lookup per emitted combat move.
 */
export function blendDangerAvoidance(ctx: BotContext, moveAngle: number, pf: Pathfinder): number {
  let pushX = 0;
  let pushY = 0;
  let maxUrgency = 0;
  let count = 0;
  for (const danger of ctx.dangers) {
    if (danger.distance <= 0) continue;
    // Barrels get a wide, strong berth (chain-explosions are lethal); traps get
    // a moderate one (2.0 — was 1.0). Traps deal significant damage and are
    // now the #2 environmental killer, so the avoidance weight was doubled to
    // ensure bots actually steer around them during aggressive movement.
    const isBarrelDanger = isBarrel(danger.type);
    const radius = isBarrelDanger ? BARREL_AVOID_RADIUS : TRAP_AVOID_RADIUS;
    if (danger.distance > radius) continue;
    const strength = 1 - danger.distance / radius;
    // Barrels chain-explode for 50 dmg (lethal). During combat a bot under fire
    // can't afford to be near one an enemy might detonate, so weight barrels
    // heavily (3.5) to steer clear even while approaching a target.
    const weight = isBarrelDanger ? 3.5 : 2.0;
    pushX += ((ctx.x - danger.x) / danger.distance) * strength * weight;
    pushY += ((ctx.y - danger.y) / danger.distance) * strength * weight;
    if (strength * weight > maxUrgency) maxUrgency = strength * weight;
    count++;
  }
  for (const proj of ctx.projectiles) {
    if (proj.distance > PROJECTILE_DODGE_RANGE) continue;
    const dx = proj.x - ctx.x;
    const dy = proj.y - ctx.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 10) continue;
    const incomingAngle = Math.atan2(proj.vy, proj.vx);
    const toBotAngle = Math.atan2(dy, dx);
    // absAngleDelta(from, to) === |normalizeAngle(to - from)| — the exact shape
    // of the deleted bot-AI angleDiff twin (BotInput.ts, ticket 06).
    const angleDiff = absAngleDelta(toBotAngle, incomingAngle);
    if (angleDiff < Math.PI / 3) {
      const perpX = -proj.vy / (Math.abs(proj.vy) + Math.abs(proj.vx) + 1);
      const perpY = proj.vx / (Math.abs(proj.vy) + Math.abs(proj.vx) + 1);
      const sign = ctx.x * perpY - ctx.y * perpX > 0 ? 1 : -1;
      pushX += perpX * sign * 2;
      pushY += perpY * sign * 2;
      if (2 > maxUrgency) maxUrgency = 2;
      count++;
    }
  }
  if (count === 0) return validateFinalAngle(ctx, moveAngle, pf);
  const avoidAngle = Math.atan2(pushY, pushX);
  // Urgency drives how much the avoidance overrides the intended move. A barrel
  // right next to us nearly overrides movement; a far trap barely nudges it.
  const w = Math.min(0.92, 0.3 + maxUrgency * 0.2);
  const bx = Math.cos(moveAngle) * (1 - w) + Math.cos(avoidAngle) * w;
  const by = Math.sin(moveAngle) * (1 - w) + Math.sin(avoidAngle) * w;
  // The hazard push may re-point the blend INTO a wall (the DEC-005.1 blend-
  // order defect, now covered at this seam too) — validate as the LAST step.
  return validateFinalAngle(ctx, Math.atan2(by, bx), pf);
}

export function pickStrafeDir(ctx: BotContext, enemy: EnemyInfo): number {
  const angleToEnemy = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
  const leftX = ctx.x + Math.cos(angleToEnemy - Math.PI / 2) * 200;
  const leftY = ctx.y + Math.sin(angleToEnemy - Math.PI / 2) * 200;
  const rightX = ctx.x + Math.cos(angleToEnemy + Math.PI / 2) * 200;
  const rightY = ctx.y + Math.sin(angleToEnemy + Math.PI / 2) * 200;

  // Score each side by how far it is from the nearest hazard. Barrels are
  // weighted more (chain-explosions are lethal). The bot strafes toward the
  // side with more clearance, keeping it out of barrel blast radii during
  // combat. This is the main lever for reducing barrel deaths during fights.
  let leftMinBarrel = Infinity;
  let leftMinTrap = Infinity;
  let rightMinBarrel = Infinity;
  let rightMinTrap = Infinity;
  for (const d of ctx.dangers) {
    const ld = distance(d.x, d.y, leftX, leftY);
    const rd = distance(d.x, d.y, rightX, rightY);
    if (isBarrel(d.type)) {
      leftMinBarrel = Math.min(leftMinBarrel, ld);
      rightMinBarrel = Math.min(rightMinBarrel, rd);
    } else {
      leftMinTrap = Math.min(leftMinTrap, ld);
      rightMinTrap = Math.min(rightMinTrap, rd);
    }
  }
  // Barrel clearance dominates: if one side has a barrel within blast radius,
  // avoid it at all costs. Score = barrelClearance*3 + trapClearance.
  const leftScore = Math.min(leftMinBarrel, 400) * 3 + Math.min(leftMinTrap, 200);
  const rightScore = Math.min(rightMinBarrel, 400) * 3 + Math.min(rightMinTrap, 200);

  if (leftScore > rightScore + 50) return -1;
  if (rightScore > leftScore + 50) return 1;
  return ctx.rng.next() > 0.5 ? 1 : -1;
}

export function predictAim(
  ctx: BotContext,
  enemy: EnemyInfo,
  predictionTicks: number,
  precisionRad = AIM_ERROR_RAD,
): number {
  const history = getEnemyHistory(ctx, enemy.id);

  if (!history || history.length < 2) {
    // THIN-HISTORY VELOCITY LEAD: at engagement start (perception staggered
    // every 3 ticks), history often has 0-1 samples. The old fallback was raw
    // angleTo + full noise — at 300px vs a moving target that's a guaranteed
    // miss on the opening shot, contributing to the low combat-skill score.
    // The EnemyInfo already carries the perceived velocity (enemy.vx/vy from
    // the DTO), so use it for a single-sample lead. Only fall back to the raw
    // angle when velocity is ~zero (stationary target — no lead needed).
    const speed = Math.sqrt(enemy.vx * enemy.vx + enemy.vy * enemy.vy);
    let predX = enemy.x;
    let predY = enemy.y;
    if (speed > 1) {
      predX = enemy.x + enemy.vx * predictionTicks;
      predY = enemy.y + enemy.vy * predictionTicks;
    }
    const angle = angleTo(ctx.x, ctx.y, predX, predY);
    return angle + (ctx.rng.next() - 0.5) * 2 * precisionRad;
  }

  // Ring walk over the 5 most recent samples in chronological order —
  // identical sequence to the previous `history.slice(-5)` on the capped-8
  // array (perf ticket 28 converted the storage; `at()` walks oldest→newest).
  const start = history.length > 5 ? history.length - 5 : 0;
  let dirChanges = 0;
  for (let i = start + 2; i < history.length; i++) {
    const prev = history.at(i - 1);
    const curr = history.at(i);
    const prevAngle = Math.atan2(prev.vy, prev.vx);
    const currAngle = Math.atan2(curr.vy, curr.vx);
    if (absAngleDelta(prevAngle, currAngle) > Math.PI / 3) dirChanges++;
  }

  const last = history.at(history.length - 1);
  const first = history.at(start);
  const dt = last.t - first.t;
  let predX = enemy.x;
  let predY = enemy.y;

  if (dt > 0) {
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    const confidence = dirChanges > 0 ? 0.4 : 1.0;
    predX = enemy.x + vx * predictionTicks * confidence;
    predY = enemy.y + vy * predictionTicks * confidence;
  }

  const angle = angleTo(ctx.x, ctx.y, predX, predY);
  return angle + (ctx.rng.next() - 0.5) * 2 * precisionRad;
}
