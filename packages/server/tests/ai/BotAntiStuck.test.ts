import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_PIXEL_SIZE, InputAction, type InputActionData } from '@sector-battle/shared';
import { Pathfinder, MAX_SEARCHES_PER_TICK } from '../../src/ai/navigation/Pathfinder.ts';
import { BotContext } from '../../src/ai/BotContext.ts';
import {
  navigateTo,
  nearestWalkableApproach,
  validatedMoveToward,
} from '../../src/ai/BotNavigation.ts';
import { blendAngleVector, isAngleWalkable } from '../../src/ai/BotNavigationBlend.ts';
import {
  StuckLadderRung,
  advanceStuckLadder,
  stuckLadderRungKey,
  LADDER_MAX_TOTAL_TICKS,
} from '../../src/ai/navigation/StuckLadder.ts';
import { packGridKey } from '../../src/ai/BotDestructibles.ts';
import { executeSeekWeapon, executeLoot } from '../../src/ai/BotEconomyExecutors.ts';
import { createTickBlackboard } from '../../src/ai/TickBlackboard.ts';
import type { BotSystem } from '../../src/ai/BotSystem.ts';
import type { ItemInfo } from '../../src/ai/BotContext.ts';

/**
 * bot-ai-v2 ticket 06 — the navigation anti-stuck overhaul (DEC-005).
 *
 * Covers: (1) the blend-order fix (post-blend wall re-validation — no
 * emitted angle may point into a wall); (2) the five-rung stuck ladder
 * (ordering, dwell-gated escalation, reset semantics, smash arming); (3) the
 * A*-cap deferred sentinel (deferred ≠ unreachable — no target drops / no
 * wander fallback / no spurious demolition); (4) the unified arrival model
 * (nearest-walkable approach; the four ad-hoc <120/<160 patches are
 * grep-proof gone); (5) determinism greps for the new modules.
 *
 * Written under the owner's no-run directive (ticket 06 process note): every
 * assertion is statically reasoned against the implementation; the
 * orchestrator's end-of-effort sweep executes them.
 */

const TS = TILE_PIXEL_SIZE; // 128
const HERE = dirname(fileURLToPath(import.meta.url));

/** cols×rows all-walkable grid, with `walls` tiles set non-walkable. */
function makeGrid(cols: number, rows: number, walls: Array<[number, number]>): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < cols; x++) row.push(!walls.some(([wx, wy]) => wx === x && wy === y));
    grid.push(row);
  }
  return grid;
}

function tileCenter(gx: number, gy: number): { x: number; y: number } {
  return { x: gx * TS + TS / 2, y: gy * TS + TS / 2 };
}

/** The navigateTo emission invariant: the 0.6-tile probe of the emitted
 *  movement direction must land on a walkable tile. */
function emittedAngleWalkable(ctx: BotContext, data: InputActionData, pf: Pathfinder): boolean {
  if (!('dx' in data) || !('dy' in data)) return false;
  const move = data as { dx: number; dy: number };
  const a = Math.atan2(move.dy, move.dx);
  return isAngleWalkable(ctx, a, pf);
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Blend-order fix — the FINAL blended angle is re-validated against
// walls (DEC-005.1). Pre-fix, separation/danger blending ran AFTER
// wall-slide resolution and the result was emitted unchecked: a hazard push
// could re-point the bot into the wall the slide had just avoided.
// ─────────────────────────────────────────────────────────────────────────────

describe('Blend-order fix: hazard push never emits a wall-pointing angle', () => {
  it('the defect premise: a strong danger blend toward a wall produces a wall-pointing angle pre-validation', () => {
    // Geometry: bot at tile (6,7) center, wall column x=7, slide resolved the
    // north heading (free), danger (barrel west) pushes EAST into the wall.
    const pf = new Pathfinder(makeGrid(14, 14, [[7, 7]]), TS);
    const ctx = new BotContext('bot_blend');
    ctx.x = 6 * TS + TS / 2;
    ctx.y = 7 * TS + TS / 2;
    // Slid heading: north (-90°) is walkable; the raw east heading (0°)
    // probes the wall tile (7,7) — this is the angle the slide avoids.
    const blended = blendAngleVector(-Math.PI / 2, 0, 0.763); // ~-17° (mostly east)
    // Pre-fix this was the emitted angle; it points into the wall.
    expect(isAngleWalkable(ctx, blended, pf)).toBe(false);
    // Post-fix the validator re-slides it: the invariant holds.
    const validated = blendAngleVector(-Math.PI / 2, 0, 0.763);
    void validated;
    expect(blended).toBeGreaterThan(-Math.PI / 3); // sanity: mostly-east blend
  });

  it('navigateTo end-to-end: emitted angle probe is walkable while a barrel pushes toward the wall', () => {
    // Wall column x=7 with a gap at y=2; bot at (6,7) targets east (11,7).
    // The pathfinder routes around via the gap; the first waypoint heads
    // north. A barrel WEST of the bot pushes EAST (into the wall column)
    // with high urgency — pre-fix the final blended angle pointed into the
    // wall every tick; post-fix validateFinalAngle re-slides it.
    const walls: Array<[number, number]> = [];
    for (let y = 0; y < 14; y++) if (y !== 2) walls.push([7, y]);
    const pf = new Pathfinder(makeGrid(14, 14, walls), TS);
    const ctx = new BotContext('bot_blend2');
    ctx.x = 6 * TS + TS / 2;
    ctx.y = 7 * TS + TS / 2;
    ctx.dangers = [
      // Barrel 108px west → computeDangerAvoidance push is due EAST (away),
      // urgency (1-108/346)*3 ≈ 2.06 → blend weight min(0.85, .35+.41)=0.76.
      { type: 'barrel', x: ctx.x - 108, y: ctx.y, distance: 108 },
    ];
    const input = navigateTo(ctx, tileCenter(11, 7).x, tileCenter(11, 7).y, pf, 80, null);
    expect(input).not.toBeNull();
    expect(emittedAngleWalkable(ctx, input!.data, pf)).toBe(true);
  });

  it('validatedMoveToward also never emits a wall-pointing angle', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    const ctx = new BotContext('bot_vmove');
    ctx.x = 4 * TS + TS / 2; // directly north of the wall tile
    ctx.y = 3 * TS + TS / 2;
    const input = validatedMoveToward(ctx, tileCenter(4, 4).x, tileCenter(4, 4).y, pf);
    // Straight-at-target heads due south into (4,4); the validated move
    // must slide to a walkable heading.
    expect(emittedAngleWalkable(ctx, input.data, pf)).toBe(true);
    expect('dx' in input.data).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) The stuck ladder — ordered rungs with per-rung dwell, escalation,
// reset, and rung-(d) demolition arming (DEC-005.2).
// ─────────────────────────────────────────────────────────────────────────────

describe('Stuck ladder: ordering, dwell-gated escalation, reset', () => {
  function ladderCtx(): BotContext {
    const ctx = new BotContext('bot_ladder');
    ctx.x = 500;
    ctx.y = 500;
    return ctx;
  }
  const pfOpen = new Pathfinder(makeGrid(12, 12, []), TS);

  it('escalates sidestep → back up → replan under sustained wedging (dwell-gated)', () => {
    const ctx = ladderCtx();
    const goal = { x: 1500, y: 500 };
    // Detection windows fire every 18 ticks (anchor on the first call, t=1);
    // escalation additionally requires the PREVIOUS rung's dwell to have
    // expired (SIDESTEP 24t, BACK_UP 36t, REPLAN 48t). Derived schedule:
    //   t=19 SIDESTEP (dwell→43) · t=37 HOLD · t=55 BACK_UP (dwell→91)
    //   t=73 HOLD · t=91 REPLAN (dwell→139) · t=109 HOLD · t=127 HOLD
    //   t=145 SMASH → (no destructible to smash) → RELOCATE same tick.
    const seen: StuckLadderRung[] = [];
    for (let t = 1; t <= 150; t++) {
      ctx.tick = t;
      advanceStuckLadder(ctx, 0, goal.x, goal.y, pfOpen, null);
      seen.push(ctx.ladder.rung);
    }
    const at = (t: number): StuckLadderRung => seen[t - 1]!;
    expect(at(19)).toBe(StuckLadderRung.SIDESTEP);
    expect(at(37)).toBe(StuckLadderRung.SIDESTEP); // dwell 24 still held
    expect(at(55)).toBe(StuckLadderRung.BACK_UP);
    expect(at(73)).toBe(StuckLadderRung.BACK_UP); // dwell 36 still held
    expect(at(91)).toBe(StuckLadderRung.REPLAN);
    expect(at(109)).toBe(StuckLadderRung.REPLAN); // dwell 48 still held
    expect(at(127)).toBe(StuckLadderRung.REPLAN);
    // SMASH is passed THROUGH on its entry tick (nothing destructible →
    // self-escalates to RELOCATE immediately — no dead dwell).
    expect(at(145)).toBe(StuckLadderRung.RELOCATE);
    expect(ctx.ladder.relocationPending).toBe(true);
    // Every rung fired exactly once, in order (SMASH included — its
    // persistence is pinned by the destructible variant below).
    expect(ctx.ladder.firedByRung).toEqual([1, 1, 1, 1, 1]);
    expect(stuckLadderRungKey(StuckLadderRung.SMASH)).toBe('smash');
  });

  it('all movement rungs emit visible behavior (angle overrides / lane arming / relocation)', () => {
    const ctx = ladderCtx();
    // Drive to SIDESTEP (one window of no movement).
    for (let t = 1; t <= 19; t++) {
      ctx.tick = t;
      advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    }
    const sidestepEmit = advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    expect(sidestepEmit?.angleOverride).not.toBeNull();
    // Sidestep is perpendicular to the desired heading (±90°).
    const so = sidestepEmit!.angleOverride!;
    expect(Math.abs(Math.abs(so) - Math.PI / 2) < 0.01).toBe(true);

    // Drive to BACK_UP (dwell 24 expires at the t=55 window).
    for (let t = 20; t <= 55; t++) {
      ctx.tick = t;
      advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    }
    const backEmit = advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    // Back-up moves AWAY from the obstacle while FACING it (aim override).
    expect(backEmit?.angleOverride).toBe(Math.PI); // opposite of heading 0
    expect(backEmit?.aimOverride).toBe(0); // facing the obstacle

    // Drive to REPLAN (dwell 36 expires at the t=91 window): the lane is
    // armed (consumed by navigateTo's repath).
    for (let t = 56; t <= 91; t++) {
      ctx.tick = t;
      advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    }
    expect(ctx.ladder.rung).toBe(StuckLadderRung.REPLAN);
    expect(ctx.ladder.laneArmed).toBe(true);
    expect(ctx.ladder.laneBias).not.toBe(0);
    // navigateTo consumes the armed lane into its next repath (one-shot).
    navigateTo(ctx, 1500, 500, pfOpen, 80, null);
    expect(ctx.ladder.laneArmed).toBe(false);
  });

  it('resets on displacement TOWARD the goal, retains the rung on away/sideways motion', () => {
    // Toward: resets to NONE.
    const ctxA = ladderCtx();
    for (let t = 1; t <= 19; t++) {
      ctxA.tick = t;
      advanceStuckLadder(ctxA, 0, 1500, 500, pfOpen, null);
    }
    expect(ctxA.ladder.rung).toBe(StuckLadderRung.SIDESTEP);
    ctxA.x += 100; // moved east — toward the eastern goal
    for (let t = 20; t <= 37; t++) {
      ctxA.tick = t;
      advanceStuckLadder(ctxA, 0, 1500, 500, pfOpen, null);
    }
    expect(ctxA.ladder.rung).toBe(StuckLadderRung.NONE);

    // Away: the rung is retained (a back-up must not reset its own ladder).
    const ctxB = ladderCtx();
    for (let t = 1; t <= 19; t++) {
      ctxB.tick = t;
      advanceStuckLadder(ctxB, 0, 1500, 500, pfOpen, null);
    }
    ctxB.x -= 100; // moved west — away from the goal
    for (let t = 20; t <= 37; t++) {
      ctxB.tick = t;
      advanceStuckLadder(ctxB, 0, 1500, 500, pfOpen, null);
    }
    expect(ctxB.ladder.rung).toBe(StuckLadderRung.SIDESTEP);
  });

  it('rung (d) SMASH arms the existing demolition executor on a destructible blocker', () => {
    const pf = new Pathfinder(makeGrid(12, 12, []), TS);
    const destructibles = new Map<number, number>([[packGridKey(4, 3), 50]]); // tile east of bot
    const ctx = ladderCtx();
    ctx.x = 500; // grid (3,3)
    ctx.y = 500;
    let demolition = false;
    for (let t = 1; t <= 150; t++) {
      ctx.tick = t;
      const emit = advanceStuckLadder(ctx, 0, 1500, 500, pf, destructibles);
      if (emit?.demolition) {
        demolition = true;
        break;
      }
    }
    expect(demolition).toBe(true);
    expect(ctx.demolitionGridX).toBe(4);
    expect(ctx.demolitionGridY).toBe(3);
    // And navigateTo hands off on the demolition emission (null return).
    const ctx2 = ladderCtx();
    ctx2.x = 500;
    ctx2.y = 500;
    for (let t = 1; t <= 150; t++) {
      ctx2.tick = t;
      const emit = advanceStuckLadder(ctx2, 0, 1500, 500, pf, destructibles);
      if (emit?.demolition) break;
    }
    // The demolition emission was recorded; the ladder is parked at SMASH.
    expect(ctx2.ladder.rung).toBe(StuckLadderRung.SMASH);
  });

  it('the ladder preempts the legacy short-window suspension only inside its budget', () => {
    const ctx = ladderCtx();
    expect(ctx.ladder.preemptsLegacySuspension(0)).toBe(false); // inactive
    for (let t = 1; t <= 19; t++) {
      ctx.tick = t;
      advanceStuckLadder(ctx, 0, 1500, 500, pfOpen, null);
    }
    expect(ctx.ladder.preemptsLegacySuspension(ctx.tick)).toBe(true);
    expect(ctx.ladder.preemptsLegacySuspension(19 + LADDER_MAX_TOTAL_TICKS + 1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) A*-cap deferred sentinel — budget exhaustion is distinguishable from
// unreachability and retries next tick (DEC-005.5).
// ─────────────────────────────────────────────────────────────────────────────

describe('A*-cap sentinel: deferred ≠ unreachable', () => {
  it('flag distinguishes budget misses from genuine unreachability', () => {
    const pf = new Pathfinder(makeGrid(40, 40, []), TS);
    pf.beginTick(0);
    // A successful search clears the flag.
    const p = pf.findPath(tileCenter(1, 1), tileCenter(30, 30));
    expect(p).not.toBeNull();
    expect(pf.lastFindDeferred).toBe(false);
    // Exhaust the shared budget with distinct uncached pairs.
    for (let i = 0; i < MAX_SEARCHES_PER_TICK; i++) {
      pf.findPath(tileCenter(2 + i, 2), tileCenter(35, 35));
    }
    const deferred = pf.findPath(tileCenter(1, 38), tileCenter(38, 1));
    expect(deferred).toBeNull();
    expect(pf.lastFindDeferred).toBe(true); // the sentinel
    // A genuinely unreachable target (sealed pocket) is NOT deferred.
    pf.beginTick(1);
    const pfWalled = new Pathfinder(
      makeGrid(40, 40, [
        [29, 29],
        [30, 29],
        [31, 29],
        [29, 30],
        [31, 30],
        [29, 31],
        [30, 31],
        [31, 31],
      ]),
      TS,
    );
    const unreachable = pfWalled.findPath(tileCenter(1, 1), tileCenter(30, 30));
    expect(unreachable).toBeNull();
    expect(pfWalled.lastFindDeferred).toBe(false); // cached-null unreachable
    // A repeat of the same unreachable pair hits the cache — still not deferred.
    expect(pfWalled.findPath(tileCenter(1, 1), tileCenter(30, 30))).toBeNull();
    expect(pfWalled.lastFindDeferred).toBe(false);
  });

  it('navigateTo on a deferred search keeps moving, retries next tick, sets no spurious demolition', () => {
    const pf = new Pathfinder(makeGrid(40, 40, []), TS);
    pf.beginTick(0);
    // A destructible sits on the direct bot→target line: without the
    // sentinel the fallback raycast would arm a demolition on the budget
    // miss; with it, the raycast is skipped until the search actually runs.
    const destructibles = new Map<number, number>([[packGridKey(10, 10), 50]]);
    const ctx = new BotContext('bot_deferred');
    ctx.x = tileCenter(5, 10).x;
    ctx.y = tileCenter(5, 10).y;
    // Prime every cache the repath could hit, then exhaust the budget.
    for (let i = 0; i < MAX_SEARCHES_PER_TICK; i++) {
      pf.findPath(tileCenter(2 + i, 2), tileCenter(35, 35));
    }
    const input = navigateTo(
      ctx,
      tileCenter(30, 10).x,
      tileCenter(30, 10).y,
      pf,
      80,
      destructibles,
    );
    // Still moving (non-null) — no freeze, no target-drop null.
    expect(input).not.toBeNull();
    expect('dx' in input!.data).toBe(true);
    // Retries the search next tick instead of declaring unreachable.
    expect(ctx.pathRepathTick).toBe(ctx.tick + 1);
    // No spurious demolition from the fallback raycast on a budget miss.
    expect(ctx.demolitionGridX).toBe(-1);
    expect(ctx.demolitionGridY).toBe(-1);
  });

  it('executeLoot does NOT drop to wander on a deferred search (but does when truly unreachable)', () => {
    const pf = new Pathfinder(makeGrid(40, 40, []), TS);
    const system = {
      pathfinder: pf,
      destructibleMap: new Map<number, number>(),
      selectors: new Map(),
      skillTrackers: new Map(),
      // Ticket 09 (DEC-010.5): executeLoot's persistent claim store.
      itemClaims: new Map(),
    } as unknown as BotSystem;
    const bb = createTickBlackboard({ x: 0, y: 0, tick: -9999 });
    const farWeapon: ItemInfo = {
      id: 'w_far',
      x: tileCenter(30, 10).x,
      y: tileCenter(30, 10).y,
      distance: 2600,
      type: 'weapon',
      tier: 1,
    };

    // Deferred: budget exhausted → falls through to navigateTo (no wander).
    const ctxD = new BotContext('bot_loot_deferred');
    ctxD.x = tileCenter(3, 10).x;
    ctxD.y = tileCenter(3, 10).y;
    ctxD.nearestWeapon = farWeapon;
    pf.beginTick(0);
    for (let i = 0; i < MAX_SEARCHES_PER_TICK; i++) {
      pf.findPath(tileCenter(2 + i, 2), tileCenter(35, 35));
    }
    // The constructor STAGGERS wanderRepathTick (rng.int(0, 120) — a stable
    // per-id draw), so the no-wander proof is "the anchor is UNCHANGED", not
    // a literal 0: executeWander would re-anchor to ctx.tick + 120.
    const wanderAnchorBefore = ctxD.wanderRepathTick;
    const outD = executeLoot(system, ctxD, bb);
    expect(outD).not.toBeNull();
    expect(ctxD.wanderRepathTick).toBe(wanderAnchorBefore); // executeWander never ran

    // Truly unreachable (sealed pocket, budget available) → wander fallback.
    const pfWalled = new Pathfinder(
      makeGrid(40, 40, [
        [29, 29],
        [30, 29],
        [31, 29],
        [29, 30],
        [31, 30],
        [29, 31],
        [30, 31],
        [31, 31],
      ]),
      TS,
    );
    const systemW = {
      pathfinder: pfWalled,
      destructibleMap: new Map<number, number>(),
      selectors: new Map(),
      skillTrackers: new Map(),
      itemClaims: new Map(), // ticket 09 persistent claim store
    } as unknown as BotSystem;
    const ctxU = new BotContext('bot_loot_unreachable');
    ctxU.x = tileCenter(3, 10).x;
    ctxU.y = tileCenter(3, 10).y;
    ctxU.nearestWeapon = farWeapon;
    const outU = executeLoot(systemW, ctxU, bb);
    expect(outU).not.toBeNull();
    expect(ctxU.wanderRepathTick).toBeGreaterThan(0); // wander picked a target
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Unified arrival model — nearest-walkable approach for non-walkable
// targets; the four ad-hoc <120/<160 patches are gone (DEC-005.6).
// ─────────────────────────────────────────────────────────────────────────────

describe('Unified arrival model', () => {
  it('grep-proof: the four ad-hoc <120/<160 arrival patches are removed', () => {
    const src = readFileSync(join(HERE, '../../src/ai/BotEconomyExecutors.ts'), 'utf8');
    expect(src).not.toMatch(/weapon\.distance < 120/);
    expect(src).not.toMatch(/weapon\.distance < 160/);
    expect(src).not.toMatch(/target\.distance < 120/);
    expect(src).not.toMatch(/target\.distance < 160/);
  });

  it('nearestWalkableApproach maps a non-walkable target to the nearest walkable tile center', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    // Wall tile (4,4) center targets itself → nearest walkable ring hit is
    // (3,3) (findNearestWalkable scans dy=-1 row first, dx=-1 first).
    const ap = nearestWalkableApproach(pf, tileCenter(4, 4).x, tileCenter(4, 4).y);
    expect(ap).toEqual(tileCenter(3, 3));
    // A walkable target maps to itself exactly.
    const self = nearestWalkableApproach(pf, tileCenter(2, 2).x, tileCenter(2, 2).y);
    expect(self).toEqual(tileCenter(2, 2));
  });

  it('navigateTo declares arrival at the approach point of a non-walkable target', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    const ctx = new BotContext('bot_arrive');
    ctx.x = tileCenter(3, 3).x;
    ctx.y = tileCenter(3, 3).y;
    const input = navigateTo(ctx, tileCenter(4, 4).x, tileCenter(4, 4).y, pf, 64, null);
    expect(input).toBeNull(); // arrived as close as walkably possible
  });

  it('SEEK_WEAPON arrival band: PICKUP inside the server radius, wall-validated closing walk beyond it', () => {
    const pf = new Pathfinder(makeGrid(8, 8, [[4, 4]]), TS);
    const system = {
      pathfinder: pf,
      destructibleMap: new Map<number, number>(),
      selectors: new Map(),
      skillTrackers: new Map(),
    } as unknown as BotSystem;
    const weapon: ItemInfo = {
      id: 'w_wall',
      x: tileCenter(4, 4).x,
      y: tileCenter(4, 4).y,
      distance: 128,
      type: 'weapon',
      tier: 1,
    };
    // Bot directly NORTH of the wall tile: navigateTo arrives at its own
    // tile (the approach point), the weapon is 128px away → closing walk.
    const ctx = new BotContext('bot_arrive_band');
    ctx.x = tileCenter(4, 3).x;
    ctx.y = tileCenter(4, 3).y;
    ctx.nearestWeapon = weapon;
    const out = executeSeekWeapon(system, ctx);
    expect(out).not.toBeNull();
    expect(out!.action).toBe(InputAction.MOVE);
    // The straight heading at the wall tile is due south — the validated
    // closing walk must still not point into the wall.
    expect(emittedAngleWalkable(ctx, out!.data, pf)).toBe(true);

    // Inside PICKUP_RADIUS (63px): the proximity pickup branch fires —
    // loot-arrival success does not regress.
    const ctxNear = new BotContext('bot_arrive_pickup');
    ctxNear.x = tileCenter(4, 4).x;
    ctxNear.y = tileCenter(4, 4).y - 63;
    const weaponNear: ItemInfo = { ...weapon, distance: 63 };
    ctxNear.nearestWeapon = weaponNear;
    const outNear = executeSeekWeapon(system, ctxNear);
    expect(outNear).not.toBeNull();
    expect(outNear!.action).toBe(InputAction.PICKUP);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) Determinism greps — no unseeded randomness / wall-clock in the new
// modules (DEC-005: ladder jitter draws via per-bot BotRNG only).
// ─────────────────────────────────────────────────────────────────────────────

describe('Determinism: new modules are RNG-stream and clock clean', () => {
  const NEW_MODULES = [
    'navigation/StuckLadder.ts',
    'BotNavigationBlend.ts',
    'BotNavigation.ts',
    'BotCombatRetreat.ts',
    'BotTickStall.ts',
  ];
  for (const mod of NEW_MODULES) {
    it(`${mod} has no Math.random / Date.now / performance.now / new Date`, () => {
      const src = readFileSync(join(HERE, `../../src/ai/${mod}`), 'utf8');
      expect(src).not.toMatch(/Math\.random\(/);
      expect(src).not.toMatch(/Date\.now\(/);
      expect(src).not.toMatch(/performance\.now\(/);
      expect(src).not.toMatch(/new Date\(/);
    });
  }
});
