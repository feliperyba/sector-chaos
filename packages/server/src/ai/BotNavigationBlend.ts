/**
 * Navigation steering-blend + wall-validation partial (bot-ai-v2 ticket 06,
 * DEC-005.1), extracted from BotNavigation.ts so both files stay under the
 * module-length gate.
 *
 * Contains the whole LOCAL-STEERING pipeline that surrounds navigateTo's
 * pathfollowing:
 *  - `resolveWallSlide`   — stateful (hysteresis) slide along blocking walls;
 *  - `computeSeparation`  — inverse-distance neighbor repulsion;
 *  - `computeDangerAvoidance` — barrel/trap hazard repulsion;
 *  - `blendAngleVector`   — vector-space angle blending;
 *  - `validateFinalAngle` — THE BLEND-ORDER FIX: the FINAL blended angle is
 *    re-validated against walls and re-slid if blocked.
 *
 * THE ORDERING DEFECT THIS FIXES (AUDIT §5.1): separation and danger
 * blending were applied AFTER wall-slide resolution and the result was never
 * re-checked — a hazard push could re-point the bot into the very wall the
 * slide had just avoided, EVERY TICK (a concrete oscillation generator: the
 * bot alternated slide→blend-into-wall→slide). The invariant now holds at
 * the emission seam: no movement angle leaves this pipeline pointing into a
 * wall, because the last step is always a wall probe.
 */

import { BARREL } from '@sector-battle/shared';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import type { BotContext } from './BotContext.ts';
import { isBarrel } from './BotDestructibles.ts';

/** Probe distance for the wall checks, in tiles-of-lookahead (0.6 — enough
 *  that the 96px hitbox clears a corner before committing the heading). */
const WALL_PROBE_TILE_FACTOR = 0.6;
/** Directions scanned by the sealed-box fallback of validateFinalAngle. */
const FINAL_FALLBACK_STEPS = 16;

/**
 * Resolve a movement angle blocked by an obstacle into a viable slide angle.
 *
 * STATEFUL (hysteresis): remembers which side the bot is sliding via
 * `ctx.slideDir` and keeps it while walkable. A stateless slide re-probes
 * ±30/60/90° every tick and, as the bot shifts 1px, alternates +offset and
 * -offset — swinging the move angle ~60° between ticks (the back-and-forth
 * bounce). Committing makes the slide coherent: the bot hugs one side until it
 * clears the obstacle or the commit window expires.
 */
const SLIDE_OFFSETS = [Math.PI / 6, Math.PI / 3, Math.PI / 2];
const SLIDE_COMMIT_TICKS = 24; // ~0.4s — long enough to clear an obstacle, short enough to not lock in
export function resolveWallSlide(ctx: BotContext, angle: number, pf: Pathfinder): number {
  const tileSize = pf.getTileSize();
  const checkDist = tileSize * WALL_PROBE_TILE_FACTOR;
  const probe = (offset: number): boolean => {
    const a = angle + offset;
    const checkX = ctx.x + Math.cos(a) * checkDist;
    const checkY = ctx.y + Math.sin(a) * checkDist;
    const grid = pf.worldToGrid({ x: checkX, y: checkY });
    return pf.isWalkable(grid.x, grid.y);
  };

  // If the direct heading is clear, go straight — no slide needed. Clear the
  // commit so the bot picks a fresh slide direction next wall, not a stale one.
  if (probe(0)) {
    ctx.slideCommitTick = -9999;
    return angle;
  }

  // If we're within a commit window, honour the chosen slide direction while it
  // is still walkable. This is what stops the per-tick sign flip.
  const committed = ctx.slideCommitTick > ctx.tick && ctx.slideDir !== 0;
  if (committed) {
    for (const base of SLIDE_OFFSETS) {
      const off = ctx.slideDir * base;
      if (probe(off)) return angle + off;
    }
    // committed side exhausted — fall through to re-pick below
  }

  // Re-pick a slide direction, trying the SAME side as the previous slide first
  // (continuity), then the opposite side.
  const order = ctx.slideDir >= 0 ? [1, -1] : [-1, 1];
  for (const sign of order) {
    for (const base of SLIDE_OFFSETS) {
      const off = sign * base;
      if (probe(off)) {
        ctx.slideDir = sign;
        ctx.slideCommitTick = ctx.tick + SLIDE_COMMIT_TICKS;
        return angle + off;
      }
    }
  }
  // Fully boxed in — no slide helps. Return the raw angle (the bot pushes into
  // the wall; the caller's stuck-detection / demolition handles the escape).
  return angle;
}

/** Separation radius — wider than legacy 100px so bots spread BEFORE they overlap
 *  (by 100px they're already colliding; the push is too late). */
const SEPARATION_RADIUS_NAV = 160;

export function computeSeparation(ctx: BotContext): number | null {
  let pushX = 0;
  let pushY = 0;
  let count = 0;
  for (const enemy of ctx.enemies) {
    const d = enemy.distance;
    if (d > 0 && d < SEPARATION_RADIUS_NAV) {
      // Inverse-distance weighting so the closest neighbor dominates the push
      // — equal-weight blends under-powered escapes from real pile-ups.
      const weight = 1 - d / SEPARATION_RADIUS_NAV;
      pushX += ((ctx.x - enemy.x) / d) * weight;
      pushY += ((ctx.y - enemy.y) / d) * weight;
      count++;
    }
  }
  if (count === 0) return null;
  return Math.atan2(pushY, pushX);
}

/** Hazard avoidance radii. Barrels chain-explode across BARREL.EXPLOSION_RADIUS
 *  (256px), so they need a wider berth than traps (see BotCombatShared for the
 *  matching combat-path values). */
const TRAP_AVOID_RADIUS = 220;
const BARREL_AVOID_RADIUS = BARREL.EXPLOSION_RADIUS + 90;

export function computeDangerAvoidance(ctx: BotContext): { angle: number; urgency: number } | null {
  let pushX = 0;
  let pushY = 0;
  let maxUrgency = 0;
  let count = 0;
  for (const danger of ctx.dangers) {
    if (danger.distance <= 0) continue;
    // Barrels get a wide, strong berth (chain-explosions are lethal); traps moderate.
    const isBarrelDanger = isBarrel(danger.type);
    const radius = isBarrelDanger ? BARREL_AVOID_RADIUS : TRAP_AVOID_RADIUS;
    if (danger.distance > radius) continue;
    const strength = 1 - danger.distance / radius;
    const weight = isBarrelDanger ? 3.0 : 2.0;
    pushX += ((ctx.x - danger.x) / danger.distance) * strength * weight;
    pushY += ((ctx.y - danger.y) / danger.distance) * strength * weight;
    if (strength * weight > maxUrgency) maxUrgency = strength * weight;
    count++;
  }
  if (count === 0) return null;
  return { angle: Math.atan2(pushY, pushX), urgency: maxUrgency };
}

export function blendAngleVector(primaryAngle: number, blendAngle: number, weight: number): number {
  const x = Math.cos(primaryAngle) * (1 - weight) + Math.cos(blendAngle) * weight;
  const y = Math.sin(primaryAngle) * (1 - weight) + Math.sin(blendAngle) * weight;
  return Math.atan2(y, x);
}

/** True when heading `angle` from the bot's current position does not point
 *  into a wall (0.6-tile probe — the same probe the slide uses, so "valid"
 *  is consistent everywhere in this pipeline). */
export function isAngleWalkable(ctx: BotContext, angle: number, pf: Pathfinder): boolean {
  const ts = pf.getTileSize();
  const px = ctx.x + Math.cos(angle) * ts * WALL_PROBE_TILE_FACTOR;
  const py = ctx.y + Math.sin(angle) * ts * WALL_PROBE_TILE_FACTOR;
  const grid = pf.worldToGrid({ x: px, y: py });
  return pf.isWalkable(grid.x, grid.y);
}

/**
 * THE BLEND-ORDER FIX (DEC-005.1): validate the FINAL blended angle against
 * walls and re-slide if blocked. Applied as the LAST step of navigateTo's
 * steering pipeline — after separation and hazard blending — so that no
 * emitted movement angle may point into a wall:
 *
 *  1. walkable as-is → unchanged;
 *  2. blocked → resolveWallSlide (the same stateful hysteresis slide the
 *     pre-blend heading went through — commit sides carry over coherently);
 *  3. still blocked (boxed against the slide offsets) → deterministic
 *     16-direction ring scan; emit the walkable direction closest to the
 *     desired one (the bot visibly scrapes along the best exit rather than
 *     pressing into the wall);
 *  4. nothing walkable in any direction (fully sealed — physics zeroes any
 *     input) → the desired angle unchanged; the stuck ladder owns the escape.
 */
export function validateFinalAngle(ctx: BotContext, angle: number, pf: Pathfinder): number {
  if (isAngleWalkable(ctx, angle, pf)) return angle;
  const slid = resolveWallSlide(ctx, angle, pf);
  if (isAngleWalkable(ctx, slid, pf)) return slid;
  const ts = pf.getTileSize();
  const checkDist = ts * WALL_PROBE_TILE_FACTOR;
  let best = angle;
  let bestDelta = Infinity;
  for (let i = 0; i < FINAL_FALLBACK_STEPS; i++) {
    const a = (i / FINAL_FALLBACK_STEPS) * Math.PI * 2;
    const px = ctx.x + Math.cos(a) * checkDist;
    const py = ctx.y + Math.sin(a) * checkDist;
    const grid = pf.worldToGrid({ x: px, y: py });
    if (!pf.isWalkable(grid.x, grid.y)) continue;
    // Angular distance to the desired heading, in [0, π].
    let delta = Math.abs(a - angle) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = a;
    }
  }
  return best;
}
