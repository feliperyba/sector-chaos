/**
 * StuckLadder — the human-legible anti-stuck escalation ladder
 * (bot-ai-v2 ticket 06 / DEC-005.2).
 *
 * THE PROBLEM THIS SOLVES: the old anti-stick was two crude mechanisms — a
 * blind ±90° unstuck jitter (`shouldUnstuck`) that often pushed the bot
 * straight back into the same wall, and goal-suspension (`checkGoalStall`)
 * that fired as soon as ~90 ticks of <25px displacement accumulated. A bot
 * wedged against geometry either vibrated forever or silently teleported its
 * GOAL elsewhere; nothing in between read as a human recovering.
 *
 * THE LADDER (ordered, per-rung dwell ticks, ESCALATING — all rungs emit
 * visible behavior; suspension is DEMOTED to the last resort):
 *   (a) SIDESTEP  — commit a perpendicular sidestep for SIDE_STEP dwell
 *                   ticks (visible lateral move).
 *   (b) BACK_UP   — back up ~1–2 tiles while FACING the obstacle (visible
 *                   retreat-and-reassess; the aim stays on the blocker).
 *   (c) REPLAN    — clear the path and re-route on an ALTERNATE LANE (the
 *                   next navigateTo repath targets a lane-offset point — a
 *                   visible wide swing around the obstacle).
 *   (d) SMASH     — probe the faced tile for a DESTRUCTIBLE and route the
 *                   EXISTING demolition executor at it (the genre-signature
 *                   escape: windups are visible, so a bot winding up on a
 *                   crate reads as intentional — DEC-005 dissent). If the
 *                   blocker is not destructible, escalate immediately.
 *   (e) RELOCATE  — goal suspension + relocation via the EXISTING mechanism
 *                   (IntentSelector.suspend + forced wander + stall
 *                   epicenter) — last resort only.
 *
 * DETECTION: an independent 18-tick / 16px displacement window (same shape
 * as `checkStuck`, but on the ladder's OWN anchor so the executors'
 * `checkStuck` path resets don't consume it). On each stuck window:
 *   - rung NONE → enter (a);
 *   - rung active and dwell expired → escalate;
 *   - rung active and dwell unexpired → hold (keep emitting the rung).
 * RESET: displacement-toward-goal within a window (the ladder worked or the
 * wedge cleared). Moving AWAY from the goal (e.g. rung (b) backing up) does
 * NOT reset the ladder — otherwise a/b would loop forever without ever
 * reaching the smash rung.
 *
 * DETERMINISM: the only draws (sidestep side, lane side) come from the
 * per-bot BotRNG at rung ENTRY (not per tick). No wall-clock, no unseeded
 * randomness. Telemetry: `firedByRung` counts every rung ENTRY; drained
 * into the believability counters by recordTickTelemetry (ticket 01
 * surface — observation-only).
 */

import type { BotContext } from '../BotContext.ts';
import type { Pathfinder } from './Pathfinder.ts';
import { packGridKey } from '../BotDestructibles.ts';

/** Ladder rungs, in escalation order. NONE = inactive (moving fine). */
export enum StuckLadderRung {
  NONE = 0,
  SIDESTEP = 1,
  BACK_UP = 2,
  REPLAN = 3,
  SMASH = 4,
  RELOCATE = 5,
}

/** JSON-stable rung labels (telemetry keys — do not rename, they are bench
 *  JSON contract). */
export const STUCK_LADDER_RUNG_KEYS = [
  'sidestep',
  'backUp',
  'replan',
  'smash',
  'relocate',
] as const;

/** Per-rung key for a rung ≥ SIDESTEP. */
export function stuckLadderRungKey(rung: StuckLadderRung): string {
  return STUCK_LADDER_RUNG_KEYS[rung - 1]!;
}

/**
 * Per-rung dwell ticks. Each rung OWNS its tick window un-interrupted so the
 * behavior is visible (> one 18-tick detection window); escalation only
 * happens on a stuck window whose dwell has expired. SMASH/RELOCATE are
 * event-driven (demolition episode / one-shot relocation) — no dwell.
 */
const RUNG_DWELL_TICKS: Readonly<Record<StuckLadderRung, number>> = {
  [StuckLadderRung.NONE]: 0,
  [StuckLadderRung.SIDESTEP]: 24, // ~0.4s of committed lateral motion
  [StuckLadderRung.BACK_UP]: 36, // ~260px at base speed ≈ 2 tiles reversed
  [StuckLadderRung.REPLAN]: 48, // one lane repath + the swing it produces
  [StuckLadderRung.SMASH]: 0,
  [StuckLadderRung.RELOCATE]: 0,
};

/** Detection window (same operational "wedged" shape as checkStuck). */
const LADDER_WINDOW_TICKS = 18;
const LADDER_WINDOW_PX = 16;
/**
 * Total ladder budget before the legacy goal-stall/anti-stall backstops may
 * suspend again (suspension is demoted to LAST resort — DEC-005.2: the old
 * short-window suspension must yield to the ladder while the ladder still
 * has runway).
 */
export const LADDER_MAX_TOTAL_TICKS = 180;

/** How far the alternate-lane repath swings the goal direction (radians). */
export const LANE_SWING_RAD = 0.9;

/** What the ladder wants navigateTo to do this tick. */
export interface LadderEmit {
  /** Movement-angle override (rungs a/b), or null for no override. */
  angleOverride: number | null;
  /** Aim override (rung b faces the obstacle while backing up). */
  aimOverride: number | null;
  /** Rung (d) armed a demolition target — navigateTo must return null so
   *  the caller's executor flips into the DEMOLITION state. */
  demolition: boolean;
}

/** Per-bot ladder state (one instance per BotContext — `ctx.ladder`). */
export class StuckLadderState {
  rung: StuckLadderRung = StuckLadderRung.NONE;
  /** Tick the CURRENT rung was entered (dwell anchor). */
  rungEnteredTick = -9999;
  /** Tick the current rung's dwell expires. */
  dwellUntilTick = -9999;
  /** Tick the ladder FIRST engaged this episode (age anchor for the
   *  legacy-backstop gate). */
  firstStuckTick = -9999;
  /** Direction of the obstacle we are wedged on (toward the goal heading at
   *  escalation time — rungs (b)/(d) face it). */
  obstacleAngle = 0;
  /** Per-bot RNG-drawn sidestep side (+1/-1), drawn at rung (a) entry. */
  sidestepDir = 0;
  /** Lane-bias side for rung (c) (+1/-1), drawn at entry; consumed as a
   *  one-shot by the next navigateTo repath (`laneArmed`). */
  laneBias = 0;
  /** True while the alternate-lane repath has not yet been consumed. */
  laneArmed = false;
  /** Rung (e) request — consumed by the per-tick stall phase (needs the
   *  BotSystem, which navigateTo does not have). */
  relocationPending = false;
  /** Independent displacement-window anchor. */
  anchorX = 0;
  anchorY = 0;
  anchorTick = -9999;
  /** Telemetry: rung ENTRY counts (STUCK_LADDER_RUNG_KEYS order). */
  readonly firedByRung: number[] = [0, 0, 0, 0, 0];
  /** Last counts drained into believability (delta accounting). */
  private reportedByRung: number[] = [0, 0, 0, 0, 0];

  /** Ladder episode age (ticks since first engagement; 0 when inactive). */
  age(tick: number): number {
    return this.firstStuckTick < 0 ? 0 : tick - this.firstStuckTick;
  }

  /**
   * True while the ladder should preempt the legacy short-window goal-stall
   * suspension (suspension demoted to last resort: the ladder gets its full
   * runway first; after LADDER_MAX_TOTAL_TICKS the legacy backstops win so a
   * pathological wedge can never suspend-suspend nothing forever).
   */
  preemptsLegacySuspension(tick: number): boolean {
    return this.rung !== StuckLadderRung.NONE && this.age(tick) < LADDER_MAX_TOTAL_TICKS;
  }

  /** Drain new rung firings for telemetry: [rungKey, delta] per fired rung. */
  drainFirings(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (let i = 0; i < this.firedByRung.length; i++) {
      const fired = this.firedByRung[i]!;
      const delta = fired - this.reportedByRung[i]!;
      if (delta > 0) {
        out.push([STUCK_LADDER_RUNG_KEYS[i]!, delta]);
        this.reportedByRung[i] = fired;
      }
    }
    return out;
  }

  /** Full reset (movement toward goal resumed — the wedge cleared). */
  reset(): void {
    this.rung = StuckLadderRung.NONE;
    this.rungEnteredTick = -9999;
    this.dwellUntilTick = -9999;
    this.firstStuckTick = -9999;
    this.sidestepDir = 0;
    this.laneBias = 0;
    this.laneArmed = false;
    this.relocationPending = false;
  }
}

/**
 * Advance the ladder one movement tick. Called from navigateTo (the movement
 * seam — every navigate-driven tick) with the bot's CURRENT desired heading
 * (`obstacleAngle` candidates) and the goal it is trying to reach.
 *
 * @param ctx the bot (position, tick, per-bot RNG, ladder state).
 * @param desiredAngle the pre-ladder movement heading (toward the waypoint,
 *  post wall-slide) — where the bot WANTS to go; the obstacle sits along it.
 * @param goalX/goalY the navigation goal (approach point) — displacement
 *  toward it resets the ladder.
 * @param pf the pathfinder (SMASH probes its grid).
 * @param destructibleMap live destructibles (SMASH target source); null
 *  disables rung (d) (non-destructible worlds escalate straight to (e)).
 * @returns the emission for this tick, or null when the ladder is inactive.
 */
export function advanceStuckLadder(
  ctx: BotContext,
  desiredAngle: number,
  goalX: number,
  goalY: number,
  pf: Pathfinder,
  destructibleMap: Map<number, number> | null,
): LadderEmit | null {
  const l = ctx.ladder;
  const tick = ctx.tick;

  // ── window bookkeeping ─────────────────────────────────────────────────
  if (l.anchorTick < 0) {
    l.anchorX = ctx.x;
    l.anchorY = ctx.y;
    l.anchorTick = tick;
    return emitFor(ctx, l, desiredAngle, pf, destructibleMap);
  }
  const elapsed = tick - l.anchorTick;
  if (elapsed < LADDER_WINDOW_TICKS) {
    return emitFor(ctx, l, desiredAngle, pf, destructibleMap);
  }
  // Window elapsed: re-anchor and judge displacement.
  const dx = ctx.x - l.anchorX;
  const dy = ctx.y - l.anchorY;
  const moved = Math.sqrt(dx * dx + dy * dy);
  l.anchorX = ctx.x;
  l.anchorY = ctx.y;
  l.anchorTick = tick;
  if (moved >= LADDER_WINDOW_PX) {
    // Reset only on displacement TOWARD the goal. Away/sideways motion
    // (rung (b) backing up, rung (a) sidestep) keeps the ladder engaged —
    // otherwise a/back-up would ping-pong forever without escalating.
    const toGoalX = goalX - l.anchorX;
    const toGoalY = goalY - l.anchorY;
    const goalDist = Math.sqrt(toGoalX * toGoalX + toGoalY * toGoalY) || 1;
    if ((dx * toGoalX + dy * toGoalY) / goalDist > LADDER_WINDOW_PX) {
      l.reset();
      return null;
    }
    return emitFor(ctx, l, desiredAngle, pf, destructibleMap);
  }

  // ── stuck window fired ─────────────────────────────────────────────────
  if (l.rung === StuckLadderRung.NONE) {
    enterRung(l, StuckLadderRung.SIDESTEP, desiredAngle, tick, ctx);
  } else if (tick >= l.dwellUntilTick && l.rung !== StuckLadderRung.SMASH) {
    // Dwell expired — escalate. SMASH is excluded: it escalates PAST ITSELF
    // inside emitFor the moment its destructible probe comes up empty (no
    // dead dwell on an unexecutable rung).
    enterRung(l, (l.rung + 1) as StuckLadderRung, desiredAngle, tick, ctx);
  }
  return emitFor(ctx, l, desiredAngle, pf, destructibleMap);
}

function enterRung(
  l: StuckLadderState,
  rung: StuckLadderRung,
  desiredAngle: number,
  tick: number,
  ctx: BotContext,
): void {
  l.rung = rung;
  l.rungEnteredTick = tick;
  l.dwellUntilTick = tick + RUNG_DWELL_TICKS[rung]!;
  if (l.firstStuckTick < 0) l.firstStuckTick = tick;
  l.obstacleAngle = desiredAngle;
  l.firedByRung[rung - 1]!++;
  if (rung === StuckLadderRung.SIDESTEP) {
    // Per-bot RNG side draw, ONCE per rung entry (determinism: BotRNG).
    l.sidestepDir = ctx.rng.next() > 0.5 ? 1 : -1;
  } else if (rung === StuckLadderRung.REPLAN) {
    l.laneBias = ctx.rng.next() > 0.5 ? 1 : -1;
    l.laneArmed = true;
  } else if (rung === StuckLadderRung.RELOCATE) {
    l.relocationPending = true;
  }
}

/** Compose this tick's emission for the current rung (null when NONE).
 *  SMASH arms the demolition here (and self-escalates to RELOCATE when there
 *  is nothing breakable in front of the bot — no dead ticks). */
function emitFor(
  ctx: BotContext,
  l: StuckLadderState,
  desiredAngle: number,
  pf: Pathfinder,
  destructibleMap: Map<number, number> | null,
): LadderEmit | null {
  if (l.rung === StuckLadderRung.NONE) return null;
  const base: LadderEmit = { angleOverride: null, aimOverride: null, demolition: false };
  switch (l.rung) {
    case StuckLadderRung.SIDESTEP:
      // (a) committed perpendicular sidestep — the direction is drawn once
      // at rung entry and held for the dwell (a human commits to a hop).
      base.angleOverride = desiredAngle + l.sidestepDir * (Math.PI / 2);
      return base;
    case StuckLadderRung.BACK_UP:
      // (b) back AWAY from the obstacle while FACING it: the move opposes
      // the obstacle direction, the aim stays on it (retreat-and-reassess).
      base.angleOverride = l.obstacleAngle + Math.PI;
      base.aimOverride = l.obstacleAngle;
      return base;
    case StuckLadderRung.REPLAN:
      // (c) no angle override — the lane repath (consumed in navigateTo's
      // repath block via laneArmed) produces the visible wide swing; the bot
      // keeps waypoint-following the lane path.
      return base;
    case StuckLadderRung.SMASH:
      // (d) arm the demolition on the faced destructible; when the blocker
      // is not destructible, escalate to (e) on the spot.
      if (armSmash(ctx, pf, destructibleMap)) {
        base.demolition = true;
        return base;
      }
      enterRung(l, StuckLadderRung.RELOCATE, desiredAngle, ctx.tick, ctx);
      return base;
    case StuckLadderRung.RELOCATE:
    default:
      // (e) executed at ENTRY (relocationPending), consumed by the per-tick
      // stall phase; no angle override — the bot keeps moving this tick and
      // the forced wander takes over next tick.
      return base;
  }
}

/**
 * Rung (d) arming — probes the faced tile for a destructible and, on a hit,
 * plants the EXISTING demolition target fields (the standard executor takes
 * over from there). Returns false when the blocker is not destructible (the
 * caller escalates to RELOCATE — nothing to smash). Also called from
 * emitFor while the ladder sits at SMASH.
 */
export function armSmash(
  ctx: BotContext,
  pf: Pathfinder,
  destructibleMap: Map<number, number> | null,
): boolean {
  const l = ctx.ladder;
  if (l.rung !== StuckLadderRung.SMASH) return false;
  if (!destructibleMap || destructibleMap.size === 0) return false;
  const ts = pf.getTileSize();
  const probeX = ctx.x + Math.cos(l.obstacleAngle) * ts;
  const probeY = ctx.y + Math.sin(l.obstacleAngle) * ts;
  const grid = pf.worldToGrid({ x: probeX, y: probeY });
  if (!destructibleMap.has(packGridKey(grid.x, grid.y))) return false;
  ctx.demolitionTargetX = grid.x * ts + ts / 2;
  ctx.demolitionTargetY = grid.y * ts + ts / 2;
  ctx.demolitionGridX = grid.x;
  ctx.demolitionGridY = grid.y;
  return true;
}
