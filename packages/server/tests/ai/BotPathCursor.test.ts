import { describe, it, expect } from 'vitest';
import { distance } from '@sector-battle/shared';
import { Pathfinder } from '../../src/ai/navigation/Pathfinder.ts';
import { navigateTo } from '../../src/ai/BotNavigation.ts';
import { BotContext } from '../../src/ai/BotContext.ts';
import type { Vec2 } from '../../src/ai/BotContext.ts';

/**
 * Perf ticket 30 — bot-path-cursor parity tests.
 *
 * The production consumption loop in `navigateTo` index-advances a cursor
 * instead of `Array.shift()`-ing the front waypoint. These tests pin:
 *   1. Per-tick waypoint-selection parity against a byte-faithful inline
 *      reimplementation of the OLD shift loop (same oracle pattern as
 *      BotEnemyHistory.test.ts "≡ old array semantics").
 *   2. `setPath` cursor-reset invariants (fresh assign never inherits a
 *      stale cursor).
 *   3. The aliasing fix: `ctx.path` may BE the pathfinder's cached array —
 *      the cursor must never mutate it (shift() used to corrupt the cache).
 */

function createGrid(width: number, height: number, walkable = true): boolean[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => walkable));
}

/** OLD consumption semantics (BotNavigation pre-ticket-30), verbatim:
 * shift() the front waypoint while within 50px of the lookahead waypoint,
 * then steer toward path[1] (fallback path[0]). Mutates `path` in place. */
function oldConsume(path: Vec2[], x: number, y: number): Vec2 {
  while (path.length >= 3) {
    const next = path[1]!;
    if (distance(x, y, next.x, next.y) < 50) {
      path.shift();
    } else {
      break;
    }
  }
  return path[1] ?? path[0]!;
}

function clonePath(path: Vec2[]): Vec2[] {
  return path.map((p) => ({ x: p.x, y: p.y }));
}

describe('BotPathCursor ≡ old shift semantics', () => {
  it('selects identical waypoints per tick across randomized walk trajectories', () => {
    const pf = new Pathfinder(createGrid(40, 40));
    const target = { x: 4608, y: 4608 }; // far corner of a 40x40 tile grid (128px tiles)

    // Deterministic walk generator (no Math.random): LCG seeded per case.
    const lcg = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let seed = 1; seed <= 12; seed++) {
      const rand = lcg(seed * 7919);
      const ctx = new BotContext(`parity-bot-${seed}`);
      ctx.x = 64;
      ctx.y = 64;
      ctx.tick = 0;

      // First call plans the path through production code.
      let input = navigateTo(ctx, target.x, target.y, pf);
      expect(ctx.path).not.toBeNull();
      // Freeze planning: no repath / no target change for the rest of the walk.
      ctx.pathRepathTick = 1_000_000;

      const refPath = clonePath(ctx.path!); // oracle copy for the shift semantics
      const originalLength = refPath.length;
      let steps = 0;

      while (input !== null && steps < 600) {
        steps++;
        ctx.tick++;

        // Production waypoint after this tick's consumption (cursor semantics).
        const prodWaypoint = ctx.path![ctx.pathCursor + 1] ?? ctx.path![ctx.pathCursor]!;
        // Oracle waypoint (shift semantics) at the same position.
        const refWaypoint = oldConsume(refPath, ctx.x, ctx.y);

        expect(prodWaypoint.x).toBe(refWaypoint.x);
        expect(prodWaypoint.y).toBe(refWaypoint.y);
        // Remaining-waypoint count must match: length-cursor ≡ post-shift length.
        expect(ctx.path!.length - ctx.pathCursor).toBe(refPath.length);
        // The production path array must stay immutable (no shift side effect).
        expect(ctx.path!.length).toBe(originalLength);

        // Advance the shared trajectory along the production move angle with
        // deterministic lateral jitter so the 50px advance threshold fires at
        // varied offsets (exercising multi-advance and skip-advance cases).
        const angle = Math.atan2(input.data.dy, input.data.dx);
        const speed = 55 + rand() * 30;
        const jitter = (rand() - 0.5) * 0.9;
        ctx.x += Math.cos(angle + jitter) * speed;
        ctx.y += Math.sin(angle + jitter) * speed;

        input = navigateTo(ctx, target.x, target.y, pf);
      }

      // The walk must actually consume the path (not stall on step 1).
      expect(steps).toBeGreaterThan(5);
      expect(refPath.length).toBeLessThan(originalLength);
    }
  });

  it('setPath always resets the cursor (fresh assign never inherits a stale cursor)', () => {
    const ctx = new BotContext('cursor-reset-bot');
    const a: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 300, y: 0 },
    ];
    ctx.setPath(a);
    expect(ctx.path).toBe(a);
    expect(ctx.pathCursor).toBe(0);

    ctx.pathCursor = 3; // simulate a mostly-consumed path
    ctx.setPath(a); // re-assign the same array (repath case)
    expect(ctx.pathCursor).toBe(0);

    ctx.pathCursor = 2;
    ctx.setPath(null); // abandon case
    expect(ctx.path).toBeNull();
    expect(ctx.pathCursor).toBe(0);

    const b: Vec2[] = [{ x: 5, y: 5 }, { x: 6, y: 6 }];
    ctx.setPath(b); // next path starts fresh
    expect(ctx.pathCursor).toBe(0);
    expect(ctx.path![1]).toEqual({ x: 6, y: 6 });
  });

  it('cursor consumption never mutates the pathfinder cached array (aliasing fix)', () => {
    const pf = new Pathfinder(createGrid(30, 30));
    const from = { x: 64, y: 64 };
    const to = { x: 3712, y: 3712 };

    const cached = pf.findPath(from, to);
    expect(cached).not.toBeNull();
    const again = pf.findPath(from, to);
    expect(again).toBe(cached); // cache hands out the SAME array instance

    const ctx = new BotContext('alias-bot');
    ctx.x = from.x;
    ctx.y = from.y;
    const preWalk = clonePath(cached!);
    ctx.setPath(clonePath(cached!)); // walk a clone so consumption runs many ticks
    ctx.pathRepathTick = 1_000_000;
    ctx.pathTargetX = to.x;
    ctx.pathTargetY = to.y;

    for (let i = 0; i < 55; i++) {
      ctx.tick++;
      const wp = ctx.path![ctx.pathCursor + 1] ?? ctx.path![ctx.pathCursor]!;
      const angle = Math.atan2(wp.y - ctx.y, wp.x - ctx.x);
      ctx.x += Math.cos(angle) * 70;
      ctx.y += Math.sin(angle) * 70;
      const input = navigateTo(ctx, to.x, to.y, pf);
      expect(input).not.toBeNull();
    }

    // The bot consumed waypoints (cursor advanced)...
    expect(ctx.pathCursor).toBeGreaterThan(0);
    // ...but the cached array is byte-identical to its pre-walk state.
    expect(cached!.length).toBe(preWalk.length);
    expect(cached).toEqual(preWalk);
    const fresh = pf.findPath(from, to);
    expect(fresh!.length).toBe(preWalk.length);
  });
});
