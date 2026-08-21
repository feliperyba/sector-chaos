import { AttackType, WeaponType, angleTo, distance } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from './BotContext.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { PersonalityProfile } from './intent/PersonalityProfile.ts';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import { safeGetWeaponDef } from './BotLoadout.ts';
import { clampToWalkable } from './BotInput.ts';
import { navigateTo } from './BotNavigation.ts';
import {
  makeMoveInput,
  makeAttackInput,
  makeDashInput,
  makeSwitchSlotInput,
  makeThrowInput,
} from './BotInput.ts';
import {
  DASH_COOLDOWN_TICKS,
  AIM_ERROR_RAD,
  ATTACK_RANGE_MARGIN,
  PERCENT_TO_TICKS,
  isAttackUnsafeNearBarrel,
  predictAim,
} from './BotCombatShared.ts';
import { botCanDashDuringOwnWindup, botCanSwitchSlotNow } from './skill/RestrictionTables.ts';

/**
 * NAVIGATED BREAK-LINE RETREAT (bot-ai-v2 ticket 06, DEC-005.4).
 *
 * THE DEFECT THIS REPLACES: executeRetreat moved in a STRAIGHT line away
 * from the pursuer (raw fleeAngle / health-pack angle) — no pathfinding at
 * all. A low-HP bot fleeing toward a wall line wedged against it and died
 * there ("wall deaths").
 *
 * THE MODEL: the retreat GOAL is re-picked every ~30 ticks (or when the
 * pursuer moves >120px) from 7 deterministic candidates spread across the
 * away semicircle. Each candidate is scored:
 *   - BREAK-LINE BONUS when the pathfinder's LOS ray from the PURSUER to
 *     the candidate is blocked — retreat routes that cut line-of-sight are
 *     preferred (the human "get out of his sightline" move);
 *   - distance gained from the pursuer;
 *   - a heal bias when a health pack is near the candidate (the old
 *     straight-line health detour, now one term among several);
 *   - a small proximity penalty (prefer nearer reachable candidates).
 * The bot then PATHFINDS to the goal (navigateTo — destructible-aware, so
 * breaking a wall/crate when that is the shorter safe path, and the
 * blend-order wall guarantee on the emitted angle) while FACING the
 * pursuer (aim stays on the threat — running backward reads as a fighting
 * withdrawal, not a panic bolt).
 *
 * DETERMINISM: candidate angles are FIXED offsets (no RNG); LOS raycasts
 * are pure grid queries. No wall-clock reads.
 */

const RETREAT_GOAL_DISTANCE = 520;
const RETREAT_GOAL_REPICK_TICKS = 30;
/** Pursuer movement that forces a goal re-pick (px). */
const RETREAT_REPICK_PURSUER_MOVE_PX = 120;
/** Fixed candidate offsets around the flee axis (radians multiplier set —
 *  deterministic, spreads the away semicircle ±~75°). */
const RETREAT_CANDIDATE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
const RETREAT_CANDIDATE_STEP_RAD = Math.PI / 7.2; // 25°
const BREAK_LINE_BONUS = 600;
const HEAL_SEEK_RADIUS = 300;
const HEAL_SEEK_BONUS = 220;
const RETREAT_ARRIVAL_RADIUS = 80;

/** Candidate validity: the clamped point must sit on a walkable tile (the
 *  straight-line fallback below tolerates a non-walkable last resort —
 *  navigateTo's arrival model handles it). */
function candidateValid(pf: Pathfinder, x: number, y: number): boolean {
  const g = pf.worldToGrid({ x, y });
  return pf.isWalkable(g.x, g.y);
}

/**
 * Refresh ctx.retreatGoal* (the cached break-line retreat destination).
 * Kept as a separate exported unit for testability (pure pf + ctx reads).
 */
export function refreshRetreatGoal(ctx: BotContext, enemy: EnemyInfo, pf: Pathfinder): void {
  const fresh =
    ctx.retreatGoalTick > 0 &&
    ctx.tick - ctx.retreatGoalTick < RETREAT_GOAL_REPICK_TICKS &&
    distance(enemy.x, enemy.y, ctx.retreatGoalFromX, ctx.retreatGoalFromY) <
      RETREAT_REPICK_PURSUER_MOVE_PX;
  if (fresh) return;

  const fleeAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
  // Straight-away fallback (clamped; may be non-walkable — the arrival model
  // degrades gracefully and the next repick rotates off it).
  const fallback = clampToWalkable(
    pf,
    ctx.x + Math.cos(fleeAngle) * RETREAT_GOAL_DISTANCE,
    ctx.y + Math.sin(fleeAngle) * RETREAT_GOAL_DISTANCE,
  );
  let bestX = fallback.x;
  let bestY = fallback.y;
  let bestScore = -Infinity;
  const health = ctx.nearestHealth;
  for (const k of RETREAT_CANDIDATE_OFFSETS) {
    const a = fleeAngle + k * RETREAT_CANDIDATE_STEP_RAD;
    const c = clampToWalkable(
      pf,
      ctx.x + Math.cos(a) * RETREAT_GOAL_DISTANCE,
      ctx.y + Math.sin(a) * RETREAT_GOAL_DISTANCE,
    );
    if (!candidateValid(pf, c.x, c.y)) continue;
    // BREAK-LINE: a candidate the pursuer CANNOT see is worth far more than
    // raw distance — cutting line-of-sight ends the ranged damage, which is
    // what actually kills fleeing bots.
    const losFromPursuer = pf.hasLineOfSightWorld({ x: enemy.x, y: enemy.y }, c);
    let score =
      (losFromPursuer ? 0 : BREAK_LINE_BONUS) +
      distance(enemy.x, enemy.y, c.x, c.y) -
      distance(ctx.x, ctx.y, c.x, c.y) * 0.25;
    if (
      health &&
      health.distance < 500 &&
      distance(c.x, c.y, health.x, health.y) < HEAL_SEEK_RADIUS
    ) {
      score += HEAL_SEEK_BONUS;
    }
    if (score > bestScore) {
      bestScore = score;
      bestX = c.x;
      bestY = c.y;
    }
  }
  ctx.retreatGoalX = bestX;
  ctx.retreatGoalY = bestY;
  ctx.retreatGoalTick = ctx.tick;
  ctx.retreatGoalFromX = enemy.x;
  ctx.retreatGoalFromY = enemy.y;
}

/**
 * Execute one RETREAT tick. @param startleAimPenalty the Reactor's startle
 * accuracy penalty at this tick (0 when not startled — DEC-007; see
 * executeEngage's parameter note): a startled retreating bot throws/swings
 * wild while the flinch decays.
 */
export function executeRetreat(
  ctx: BotContext,
  enemy: EnemyInfo,
  _profile: PersonalityProfile,
  startleAimPenalty = 0,
  pf?: Pathfinder,
  destructibleMap: Map<number, number> | null = null,
): QueuedInput[] {
  const inputs: QueuedInput[] = [];
  const fleeAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
  const retreatAimAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);

  // RETREAT DASH + DASH-CANCEL RESTRICTION (DEC-009.3, review M2): cooldown
  // ready AND the tier may dash out of its own windup (a low tier mid-swing
  // waits for the swing to finish — the learnable habit, now enforced here
  // too, not only at the engage sites).
  const dashReady = ctx.tick - ctx.lastDashTick >= DASH_COOLDOWN_TICKS;
  if (dashReady && botCanDashDuringOwnWindup(ctx) && enemy.distance < 200) {
    inputs.push(makeDashInput(ctx.playerId, fleeAngle, ctx.tick, 'retreat-dash'));
    ctx.lastDashTick = ctx.tick;
  }

  const weapon = ctx.getActiveWeapon();
  const def = safeGetWeaponDef(weapon.weaponType);
  if (!def) return inputs; // unknown weapon type — bail (defensive; unreachable for registry-minted weapons)
  const range = def.baseStats.range;
  const cooldownReady =
    ctx.tick - ctx.lastAttackTick >= Math.ceil((def.baseStats.cooldown ?? 400) * PERCENT_TO_TICKS);

  // TACTICAL THROW while fleeing: throw the active weapon backward at the
  // pursuer to damage/slow the chase. Only throw if we have a SPARE weapon to
  // switch to afterward (don't disarm ourselves), OR the active weapon is a
  // dedicated thrown weapon (THROWING_AXE — its purpose is to be thrown). The
  // thrown weapon becomes a projectile that can hit the pursuer.
  const hasSpareWeapon = ctx.weapons.some(
    (w, i) => i !== ctx.activeSlot && w && w.weaponType !== WeaponType.FISTS && w.ammo > 0,
  );
  const isDedicatedThrow = def.baseStats.attackType === AttackType.THROWN;
  const throwCooldownReady =
    ctx.tick - ctx.lastAttackTick >= Math.ceil((def.baseStats.cooldown ?? 400) * PERCENT_TO_TICKS);
  // Lead the throw slightly — the pursuer is moving toward us. Computed before
  // the safety check so the directional barrel check can use the actual throw
  // ray (a barrel off the throw line is safe to throw past). Scaled by the
  // startle penalty (DEC-007): a flinched bot's deny-throw sprays.
  const throwAim = predictAim(ctx, enemy, 6, AIM_ERROR_RAD * 0.5 * (1 + startleAimPenalty));
  const throwUnsafe =
    hasSpareWeapon || isDedicatedThrow
      ? isAttackUnsafeNearBarrel(ctx, throwAim, def.baseStats.throwRange ?? 700, AttackType.THROWN)
      : false;
  if (
    throwCooldownReady &&
    enemy.distance > 150 &&
    enemy.distance < 700 &&
    (hasSpareWeapon || isDedicatedThrow) &&
    !throwUnsafe
  ) {
    inputs.push(makeThrowInput(ctx.playerId, throwAim, ctx.tick, 'retreat-throw-deny'));
    ctx.lastAttackTick = ctx.tick;
    // Switch to the spare weapon next tick so we're not left with FISTS.
    // MID-FIGHT SWITCH RESTRICTION (DEC-009.3, review M2): gated on
    // botCanSwitchSlotNow — a locked tier in RETREAT state does not fumble
    // with its inventory under pressure (it keeps throwing/swinging the
    // active weapon; the weapon-break switch is the separate exempt seam).
    if (hasSpareWeapon) {
      const spareSlot = ctx.weapons.findIndex(
        (w, i) => i !== ctx.activeSlot && w && w.weaponType !== WeaponType.FISTS && w.ammo > 0,
      );
      if (spareSlot >= 0 && ctx.tick - ctx.lastSwitchSlotTick > 9 && botCanSwitchSlotNow(ctx)) {
        inputs.push(makeSwitchSlotInput(ctx.playerId, spareSlot, ctx.tick, 'retreat-switch-spare'));
        ctx.lastSwitchSlotTick = ctx.tick;
      }
    }
    return inputs;
  }

  if (
    cooldownReady &&
    enemy.distance <= range * ATTACK_RANGE_MARGIN &&
    !isAttackUnsafeNearBarrel(ctx, retreatAimAngle, range, def.baseStats.attackType)
  ) {
    inputs.push(makeAttackInput(ctx.playerId, retreatAimAngle, ctx.tick));
    ctx.lastAttackTick = ctx.tick;
  }

  // ── MOVEMENT: the navigated break-line retreat (DEC-005.4) ──────────────
  if (pf) {
    refreshRetreatGoal(ctx, enemy, pf);
    const nav = navigateTo(
      ctx,
      ctx.retreatGoalX,
      ctx.retreatGoalY,
      pf,
      RETREAT_ARRIVAL_RADIUS,
      destructibleMap,
    );
    if (nav === null) {
      if (ctx.demolitionGridX >= 0) {
        // Route through a destructible — the standard demolition handoff
        // (executeRetreatState flips state on the null return).
        return inputs;
      }
      // Arrived at the retreat goal: expire it so the next tick re-picks
      // further away (the pursuer is still coming — keep running).
      ctx.retreatGoalTick = 0;
      inputs.push(makeMoveInput(ctx.playerId, fleeAngle, retreatAimAngle, ctx.tick));
      return inputs;
    }
    // Re-emit the navigated move FACING the pursuer (fighting withdrawal).
    const navMove = nav.data as { dx?: number; dy?: number };
    if (typeof navMove.dx === 'number' && typeof navMove.dy === 'number') {
      const navAngle = Math.atan2(navMove.dy, navMove.dx);
      inputs.push(makeMoveInput(ctx.playerId, navAngle, retreatAimAngle, ctx.tick));
      return inputs;
    }
  }

  // No pathfinder (defensive — the executor always passes one): the old
  // straight-line flee, with the health-pack detour, as a degraded fallback.
  const nearestHealth = ctx.nearestHealth;
  let moveAngle = fleeAngle;
  if (nearestHealth && nearestHealth.distance < 500) {
    moveAngle = angleTo(ctx.x, ctx.y, nearestHealth.x, nearestHealth.y);
  }
  inputs.push(makeMoveInput(ctx.playerId, moveAngle, retreatAimAngle, ctx.tick));
  return inputs;
}
