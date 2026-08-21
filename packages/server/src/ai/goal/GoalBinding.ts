/**
 * Macro-goal executor binding — bot-ai-v2 ticket 07 (DEC-008).
 *
 * The glue between the pure goal seams and the live tick:
 *  - {@linkcode buildGoalInputs}: assemble the read-only MacroGoalInputs
 *    from the BotContext, zone view, stimulus scan, shared hotspot and the
 *    read-only map identity. Called ONLY on rescore ticks (cheap otherwise).
 *  - {@linkcode routeToGoal}: the ZONE-AS-COST route resolution — when the
 *    straight line to the goal leaves the safe circle, evaluate the
 *    HP-budgeted shortcut (ZoneTiming.evaluateZoneShortcut) and return
 *    either the direct goal (shortcut accepted) or the safe re-entry
 *    waypoint (rejected). Pure geometry + the fight-density field.
 *  - {@linkcode ringOrbitScore}: the ORBIT-RETIREMENT MEASURABLE — a pure
 *    positional-autocorrelation check that distinguishes the retired 37°
 *    repath-ring sweep from goal-driven movement. Unit-tested against the
 *    SYNTHETIC old pattern (must flag it) and goal-driven samples (must
 *    not); the bench assertion is a sweep-time gate over this metric.
 */

import { distance, ZONE } from '@sector-battle/shared';
import type { BotContext } from '../BotContext.ts';
import type { BotSystem } from '../BotSystem.ts';
import { clampToWalkable } from '../BotInput.ts';
import { HOTSPOT_MEMORY_TICKS } from '../BotSystemConstants.ts';
import { getBarrelDensityAt } from '../BotSpatialIndex.ts';
import type { PersonalityProfile } from '../intent/PersonalityProfile.ts';
import { ARCHETYPE_GOAL_PROFILES } from './GoalTables.ts';
import type { TickBlackboard } from '../TickBlackboard.ts';
import type { ZoneInfo } from '../BotZoneSafety.ts';
import { HOTSPOT_FIGHT_STRENGTH } from './GoalTables.ts';
import { fightDensityAt, stableAngleRad } from './GoalScoring.ts';
import { evaluateZoneShortcut, msToTicks, travelTicksEstimate } from './ZoneTiming.ts';
import type { FightPoint, GoalZoneView, MacroGoalInputs, MacroGoalKind } from './GoalTypes.ts';

/** The zone view for the goal layer, derived from the per-tick ZoneInfo
 *  (which carries msUntilShrink surfaced from ZoneService — server-side,
 *  read-only, wall-clock-free). */
export function goalZoneView(zoneInfo: ZoneInfo): GoalZoneView {
  const next = zoneInfo.nextPreview;
  const hasNext = next !== null && next.radius > 0;
  return {
    safeX: zoneInfo.centerX,
    safeY: zoneInfo.centerY,
    safeRadius: zoneInfo.radius,
    timeUntilShrinkTicks: zoneInfo.msUntilShrink < 0 ? -1 : msToTicks(zoneInfo.msUntilShrink),
    isShrinking: zoneInfo.isShrinking,
    lethal: zoneInfo.currentPhase >= 2,
    // Mirrors ZoneService.getTickDamage exactly (drop = 0, phase 6 on =
    // sudden-death damage, else the per-tick constant — reads the shared
    // constants so a balance tuning moves the bots' zone model with it).
    damagePerTick:
      zoneInfo.currentPhase <= 1
        ? 0
        : zoneInfo.currentPhase >= 6
          ? ZONE.ZONE_DAMAGE_SUDDEN_DEATH
          : ZONE.ZONE_DAMAGE_PER_TICK,
    nextX: hasNext ? next!.centerX : zoneInfo.targetCenterX,
    nextY: hasNext ? next!.centerY : zoneInfo.targetCenterY,
    nextRadius: hasNext ? next!.radius : zoneInfo.targetRadius,
  };
}

/**
 * Assemble the scoring inputs (READ-ONLY view of the bot + world). Called
 * only on a bot's rescore ticks (see updateMacroGoal) — the assembly walks
 * the stimulus scan view and the hotspot, which is cheap but not free.
 */
export function buildGoalInputs(
  system: BotSystem,
  ctx: BotContext,
  zoneInfo: ZoneInfo,
  bb: TickBlackboard,
  profile: Pick<PersonalityProfile, 'archetype' | 'greed'> & {
    skill: Pick<PersonalityProfile['skill'], 'commitMultiplier'>;
  },
): MacroGoalInputs {
  // Fight-density samples: the bot's OWN stimulus history (attack/explosion
  // stimuli — what the player heard too) plus the shared hotspot folded in
  // at a fixed mid strength while fresh (shared with the executor-side
  // routing read — one field, two consumers).
  const fightPoints = collectFightPoints(system, ctx, bb);

  // Remembered loot: freshest in-scan chest (value 1.0) or upgrade weapon
  // (0.7); heard chest seat from stimulus memory.
  let inScanLoot: MacroGoalInputs['inScanLoot'] = null;
  if (ctx.nearestChest) inScanLoot = { x: ctx.nearestChest.x, y: ctx.nearestChest.y, value: 1.0 };
  else if (ctx.nearestWeapon && ctx.nearestWeapon.tier > ctx.getActiveWeapon().tier) {
    inScanLoot = { x: ctx.nearestWeapon.x, y: ctx.nearestWeapon.y, value: 0.7 };
  }
  let heardChest: MacroGoalInputs['heardChest'] = null;
  const chestView = system.stimulusRouter?.getState(ctx.playerId)?.scan?.strongestByType['chest'];
  if (chestView) {
    heardChest = { x: chestView.worldX, y: chestView.worldY, tick: chestView.tick };
  }

  // KILL-FEED AWARENESS (bot-ai-v2 ticket 09, DEC-010.4): the safe-loot
  // window (fresh corpse seat from the elimination memory — a nearby fight
  // just ended; LOOT_CLUSTER biases toward it) + the decaying sector-danger
  // read (quiet-side scoring bends away from killing fields). Both come off
  // the per-bot ctx.combat.killFeed memory the stimulus router writes.
  const killFeed = ctx.combat?.killFeed ?? null;
  const safeLoot = killFeed ? killFeed.safeLootTarget(ctx.tick) : null;
  const heardElimination = safeLoot
    ? { x: safeLoot.x, y: safeLoot.y, tick: killFeed!.lastElimTick }
    : null;
  const dangerAt = killFeed
    ? (x: number, y: number): number => killFeed.dangerAt(x, y, ctx.tick)
    : null;

  return {
    tick: ctx.tick,
    playerId: ctx.playerId,
    x: ctx.x,
    y: ctx.y,
    health: ctx.health,
    maxHealth: ctx.maxHealth,
    armed: ctx.hasRealWeapon(),
    archetype: profile.archetype as number,
    greed: profile.greed,
    commitMultiplier: profile.skill.commitMultiplier,
    zone: goalZoneView(zoneInfo),
    fightPoints,
    heardChest,
    heardElimination,
    dangerAt,
    inScanLoot,
    aliveCount: system.worldSnapshot.aliveBotCount,
    mapWidth: system.mapWidth,
    mapHeight: system.mapHeight,
    mapIdentity: system.mapIdentity,
    sectorVisits: system.macroGoals.get(ctx.playerId)?.sectorVisits ?? EMPTY_VISITS,
    barrelDensityAt: (x, y) => getBarrelDensityAt(system, x, y),
    hotspotStalkers: bb.convergingCount,
    // MATCH ARC (ticket 10, DEC-011): the rotation-margin consumer reads
    // positioningMod off the per-tick arc state (identity when absent).
    arc: system.matchArc,
  };
}

const EMPTY_VISITS = new Float64Array(16);

// ---------------------------------------------------------------------------
// Executor binding (WANDER/LOOT/HUNT consume the active macro-goal)
// ---------------------------------------------------------------------------

/**
 * Collect the fight-density samples (stimulus history + fresh shared
 * hotspot). Shared by buildGoalInputs (scoring) and goalNavTarget (the
 * zone-as-cost corridor danger read) so both see the SAME field. The
 * blackboard is optional: legacy unit-test call paths (and the
 * executeSeekWeapon internal wander fall-through) run without one — the
 * bot's own hearing still feeds the field, only the shared-hotspot fold is
 * skipped.
 */
export function collectFightPoints(
  system: BotSystem,
  ctx: BotContext,
  bb?: TickBlackboard,
): FightPoint[] {
  const fightPoints: FightPoint[] = [];
  const scan = system.stimulusRouter?.getState(ctx.playerId)?.scan;
  if (scan) {
    for (const s of scan.entries) {
      if (s.type === 'attack' || s.type === 'explosion') {
        fightPoints.push({ x: s.worldX, y: s.worldY, strength: s.effectiveStrength });
      }
    }
  }
  if (bb) {
    const hotspotAge = ctx.tick - bb.hotspot.tick;
    if (hotspotAge >= 0 && hotspotAge < HOTSPOT_MEMORY_TICKS) {
      fightPoints.push({ x: bb.hotspot.x, y: bb.hotspot.y, strength: HOTSPOT_FIGHT_STRENGTH });
    }
  }
  return fightPoints;
}

/** The zone view from the per-bot synced context fields (executor side —
 *  the ctx is refreshed every tick by syncZoneState; msUntilShrink is not
 *  needed for ROUTING, only for scoring, so −1 stands in). Lethality is
 *  derived from the synced damage ladder (damage > 0 ⇔ phase ≥ 2) — no
 *  blackboard dependency. */
export function ctxZoneView(ctx: BotContext): GoalZoneView {
  return {
    safeX: ctx.zoneCenterX,
    safeY: ctx.zoneCenterY,
    safeRadius: ctx.zoneRadius,
    timeUntilShrinkTicks: -1,
    isShrinking: ctx.zoneIsShrinking,
    lethal: ctx.zoneDamagePerTick > 0,
    damagePerTick: ctx.zoneDamagePerTick,
    nextX: ctx.zoneSafeX,
    nextY: ctx.zoneSafeY,
    nextRadius: ctx.zoneSafeRadius,
  };
}

/** The bot's zone-as-cost HP-budget fraction (per-archetype data table). */
export function zoneBudgetFraction(system: BotSystem, playerId: string): number {
  const profile = system.profiles.get(playerId);
  if (!profile) return 0.08; // defensive mid value (DEFAULT lives on the table)
  return (
    ARCHETYPE_GOAL_PROFILES[profile.archetype as keyof typeof ARCHETYPE_GOAL_PROFILES]
      ?.zoneShortcutBudgetFraction ?? 0.08
  );
}

export interface GoalNavTarget {
  readonly x: number;
  readonly y: number;
  readonly kind: MacroGoalKind;
  /** True when the zone-as-cost model accepted a shallow-zone shortcut. */
  readonly shortcut: boolean;
}

/**
 * The EXECUTOR-facing binding: resolve the active macro-goal into a
 * navigation target (walkable-clamped, zone-as-cost routed).
 *  - `kinds` filters which goal kinds this executor binds to (null = all).
 *  - `bb` is optional (blackboard-less legacy paths skip the hotspot fold).
 *  - Returns null when there is no goal state (unregister race / unit-test
 *    fakes / pre-cadence ticks) or the active kind is filtered out — the
 *    caller falls back to its deterministic anchor (NEVER random noise).
 */
export function goalNavTarget(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard | null,
  kinds: readonly MacroGoalKind[] | null,
): GoalNavTarget | null {
  const goal = system.macroGoals?.get(ctx.playerId)?.current ?? null;
  if (!goal) return null;
  if (kinds !== null && !kinds.includes(goal.kind)) return null;
  const clamped = clampToWalkable(system.pathfinder, goal.x, goal.y);
  const route = routeToGoal(
    ctx.x,
    ctx.y,
    clamped.x,
    clamped.y,
    ctxZoneView(ctx),
    ctx.health,
    zoneBudgetFraction(system, ctx.playerId),
    collectFightPoints(system, ctx, bb ?? undefined),
  );
  return { x: route.x, y: route.y, kind: goal.kind, shortcut: route.shortcut };
}

/**
 * Deterministic goal-less fallback point (pre-cadence ticks / fakes): a
 * stable-angle offset from the bot toward the zone-safe anchor when the
 * zone has formed, else a fixed-spread step in the bot's stable direction.
 * NOT random (the barrel-sparse random picker is retired — DEC-008); just
 * enough movement to bridge the first ~2 s before the generator commits.
 */
export function goallessFallbackPoint(
  system: BotSystem,
  ctx: BotContext,
): { x: number; y: number } {
  if (ctx.zoneSafeRadius > 0) {
    return clampToWalkable(system.pathfinder, ctx.zoneSafeX, ctx.zoneSafeY);
  }
  const angle = stableAngleRad(ctx.playerId);
  return clampToWalkable(
    system.pathfinder,
    ctx.x + Math.cos(angle) * 800,
    ctx.y + Math.sin(angle) * 800,
  );
}

// ---------------------------------------------------------------------------
// Zone-as-cost routing
// ---------------------------------------------------------------------------

export interface RouteWaypoint {
  readonly x: number;
  readonly y: number;
  /** True when the direct (zone-clipping) route was accepted. */
  readonly shortcut: boolean;
}

/**
 * Resolve the route to a goal point. When the straight segment from the bot
 * to the goal stays inside the safe circle, the goal IS the waypoint. When
 * it leaves, the HP-budgeted shortcut model decides between the direct
 * point (accept) and the safe re-entry waypoint (reject) — the point where
 * the segment re-enters the circle, clamped inside. Pure.
 */
export function routeToGoal(
  botX: number,
  botY: number,
  goalX: number,
  goalY: number,
  zone: GoalZoneView,
  health: number,
  budgetFraction: number,
  fights: readonly FightPoint[],
): RouteWaypoint {
  const cx = zone.safeX;
  const cy = zone.safeY;
  const r = zone.safeRadius;
  const total = distance(botX, botY, goalX, goalY);
  const clip = segmentOutsideCircleLength(botX, botY, goalX, goalY, cx, cy, r);
  const noClip = clip <= 0 || !zone.lethal;
  if (noClip) return { x: goalX, y: goalY, shortcut: false };
  const outsideTicks = travelTicksEstimate(clip);
  const directTicks = travelTicksEstimate(total);
  // Safe alternative: bot → re-entry point → goal along the ring chord; the
  // honest cheap estimate is the chord-hug length (re-entry point then goal).
  const reentry = circleReentryPoint(botX, botY, goalX, goalY, cx, cy, r);
  const safeTicks = travelTicksEstimate(
    distance(botX, botY, reentry.x, reentry.y) + distance(reentry.x, reentry.y, goalX, goalY),
  );
  const dangerAlongSafe = fightDensityAt(reentry.x, reentry.y, fights);
  const verdict = evaluateZoneShortcut({
    outsideTicks,
    directTicks,
    safeTicks,
    dangerAlongSafe,
    zoneDamagePerTick: zone.damagePerTick,
    health,
    budgetFraction,
  });
  if (verdict.accept) return { x: goalX, y: goalY, shortcut: true };
  return { x: reentry.x, y: reentry.y, shortcut: false };
}

/**
 * Length of the portion of segment A→B that lies OUTSIDE the circle
 * (center C, radius R). 0 when the segment never leaves. Pure geometry.
 */
export function segmentOutsideCircleLength(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number {
  if (r <= 0) return distance(ax, ay, bx, by); // degenerate: everything "outside"
  const aIn = distance(ax, ay, cx, cy) <= r;
  const bIn = distance(bx, by, cx, cy) <= r;
  if (aIn && bIn) {
    // Both endpoints inside — the chord could still dip out only if the
    // circle is non-convex, which it is not: a segment of a convex set is
    // contained. No clip.
    return 0;
  }
  // Collect the two intersection parameters t∈[0,1] of the segment with the
  // circle; the outside portion is the complement of the inside interval.
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a <= 0) return aIn ? 0 : 0; // degenerate zero-length segment
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    // No intersection: the segment is entirely on one side.
    return aIn ? 0 : Math.sqrt(a);
  }
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  // Inside interval ∩ [0,1] = [max(0,t1), min(1,t2)] (for a segment crossing
  // or touching the circle); outside length = total − inside length.
  const inStart = Math.max(0, Math.min(1, t1));
  const inEnd = Math.max(0, Math.min(1, t2));
  const insideLen = Math.max(0, inEnd - inStart) * Math.sqrt(a);
  return Math.max(0, Math.sqrt(a) - insideLen);
}

/**
 * The SAFE waypoint for a rejected shortcut: the point where the segment
 * A→B re-enters the circle (pulled a safety margin inside the ring so the
 * bot is not scraping the damage boundary). When the geometry degenerates
 * (no clean re-entry), the safe anchor itself.
 */
export function circleReentryPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a <= 0 || r <= 0) return { x: cx, y: cy };
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return { x: cx, y: cy };
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  // Heading B-ward from A: when A is OUTSIDE the ring the re-entry is the
  // FIRST intersection (where the segment enters the circle); when A is
  // inside it is the LAST (where the path would leave — pulled back inside).
  // Clamping max(t1,t2) alone is wrong for the outside→inside leg: the exit
  // parameter lies past B, so the clamp lands ON B instead of the boundary.
  const aIn = distance(ax, ay, cx, cy) <= r;
  const t = aIn
    ? Math.max(0, Math.min(1, Math.max(t1, t2)))
    : Math.max(0, Math.min(1, Math.min(t1, t2)));
  const px = ax + dx * t;
  const py = ay + dy * t;
  // Pull inside by the safety margin (10% of the radius, capped 120px).
  const margin = Math.min(120, r * 0.1);
  const toC = distance(px, py, cx, cy);
  if (toC <= 0) return { x: cx, y: cy };
  const scale = Math.max(0, (toC - margin) / toC);
  return { x: cx + (px - cx) * scale, y: cy + (py - cy) * scale };
}

// ---------------------------------------------------------------------------
// Orbit-retirement measurable (positional autocorrelation)
// ---------------------------------------------------------------------------

export interface OrbitSample {
  readonly x: number;
  readonly y: number;
  readonly tick: number;
}

export interface OrbitScore {
  /** Mean signed angular step around the anchor per sample (degrees). */
  readonly meanStepDeg: number;
  /** Fraction of consecutive steps sharing the dominant rotation sign. */
  readonly signConsistency: number;
  /** ORBITAL verdict: a mechanically consistent same-sign sweep in the
   *  retired pattern's step band. Goal-driven movement fails at least one
   *  condition (direction reverses, steps vary, or displacement is radial). */
  readonly orbital: boolean;
}

/**
 * Positional autocorrelation around an anchor: unwinds each sample's angle
 * around (cx,cy) and measures the consistency of the angular progression.
 * The retired HUNT priority-3 pattern (deterministic angle + ~37° advance
 * per repath ring) yields high sign-consistency with a stable step;
 * goal-driven movement (committed destinations, re-scored on cadence)
 * reverses direction and varies steps. The BENCH gate (sweep-time) asserts
 * the per-archetype population's orbital share drops to ~0 vs baseline.
 */
export function ringOrbitScore(
  samples: readonly OrbitSample[],
  cx: number,
  cy: number,
): OrbitScore {
  if (samples.length < 6) {
    return { meanStepDeg: 0, signConsistency: 0, orbital: false };
  }
  let prevAngle: number | null = null;
  let unwrapped = 0;
  const steps: number[] = [];
  for (const s of samples) {
    const a = Math.atan2(s.y - cy, s.x - cx);
    if (prevAngle !== null) {
      let d = a - prevAngle;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      unwrapped += d;
      steps.push(d);
    }
    prevAngle = a;
  }
  if (steps.length === 0) return { meanStepDeg: 0, signConsistency: 0, orbital: false };
  const total = steps.reduce((acc, s) => acc + s, 0);
  const meanRad = total / steps.length;
  const meanStepDeg = (meanRad * 180) / Math.PI;
  const pos = steps.filter((s) => s > 0.02).length;
  const neg = steps.filter((s) => s < -0.02).length;
  const signConsistency = steps.length > 0 ? Math.max(pos, neg) / steps.length : 0;
  // The retired pattern: consistent rotation (≥0.85 of steps same sign)
  // with a meaningful mean step (≥3°/sample — the ring sweep) sustained
  // over the window. Radial or reversing movement breaks the sign chain.
  const orbital =
    signConsistency >= 0.85 && Math.abs(meanStepDeg) >= 3 && Math.abs(unwrapped) >= Math.PI;
  return { meanStepDeg, signConsistency, orbital };
}
