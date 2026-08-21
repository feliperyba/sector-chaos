import { describe, it, expect } from 'vitest';
import { PLAYER } from '../../constants/player.js';
import { AABBCollision, type AABB } from '../../math/AABBCollision.js';
import type { MTV } from '../../math/Vec2.js';
import { resolvePlayerSeparation } from '../resolvePlayerSeparation.js';

/**
 * Characterization test for `resolvePlayerSeparation` (ticket 03, wired into
 * production by ticket 44).
 *
 * Proves the shared function is bit-for-bit numeric-identical to BOTH
 * production implementations it extracts, WITHOUT importing server/client
 * sources: the shared package cannot depend on them (they depend on shared,
 * not vice versa), so each implementation's separation loop is transcribed
 * VERBATIM below as a reference — same statements, same order of operations,
 * same scratch-per-caller contract — running against the real shared
 * `AABBCollision.getMTVInto` (the only dependency both loops have).
 *
 * - SERVER reference: `packages/server/src/domain/services/MovementService.ts`
 *   `resolvePlayerCollision`. Since ticket 44 the method delegates to the
 *   shared function (filter/pack → one call); the replica below transcribes
 *   the loop as it stood pre-44 (identical math pre- and post- the ticket-12
 *   scratch rewrite — 12 only changed allocation). Caller-side semantics
 *   EXCLUDED (they stay in the caller per the ticket): the dashing
 *   early-return, the id-sorted alive cache, and the self/isActive/
 *   death-collision/dashing filters.
 * - CLIENT reference: `packages/client-v3/src/collision/ClientCollisionService.ts`
 *   `resolveCollision` nearby-player separation. Since ticket 44 that block
 *   also delegates to the shared function; the replica transcribes the loop as
 *   it stood pre-44 (identical math through the ticket-36/37 scratch and
 *   pooled-view rewrites). The caller-side corner→center conversion
 *   (`resolvedX + halfW`) is EXCLUDED — the reference starts from the center,
 *   exactly what the shared function receives.
 *
 * These replicas are the MATH GATE for the deleted production loops: any drift
 * in the shared body vs either replica fails these assertions, and both
 * production consumers (now calling this function directly) inherit the proof.
 */

/** VERBATIM replica of MovementService.ts:157-183 (see header for exclusions). */
function serverResolvePlayerCollisionReference(
  startX: number,
  startY: number,
  others: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  // Mirrors `const pos = this._collisionPos; pos.x = resolvedPos.x; ...`
  const pos = { x: startX, y: startY };
  // Mirrors `private readonly mtvScratch: MTV` (one scratch per call chain).
  const mtvScratch: MTV = { x: 0, y: 0, depth: 0 };

  for (let i = 0; i < others.length; i++) {
    const other = others[i]!;

    const movingAABB: AABB = {
      x: pos.x - PLAYER.HITBOX_WIDTH / 2,
      y: pos.y - PLAYER.HITBOX_HEIGHT / 2,
      width: PLAYER.HITBOX_WIDTH,
      height: PLAYER.HITBOX_HEIGHT,
    };
    const otherAABB: AABB = {
      x: other.x - PLAYER.HITBOX_WIDTH / 2,
      y: other.y - PLAYER.HITBOX_HEIGHT / 2,
      width: PLAYER.HITBOX_WIDTH,
      height: PLAYER.HITBOX_HEIGHT,
    };

    const mtv = mtvScratch;
    if (AABBCollision.getMTVInto(movingAABB, otherAABB, mtv)) {
      const offsetX = mtv.x !== 0 ? mtv.x * mtv.depth : 0;
      const offsetY = mtv.y !== 0 ? mtv.y * mtv.depth : 0;
      pos.x += offsetX;
      pos.y += offsetY;
    }
  }

  return { x: pos.x, y: pos.y };
}

/** VERBATIM replica of ClientCollisionService.ts:131-157 (see header for exclusions). */
function clientNearbyPlayerSeparationReference(
  startCenterX: number,
  startCenterY: number,
  halfW: number,
  halfH: number,
  others: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  let outX = startCenterX;
  let outY = startCenterY;
  const mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  const othersList = others;
  if (othersList.length > 0) {
    const mtv = mtvScratch;
    for (let i = 0; i < othersList.length; i++) {
      const o = othersList[i]!;
      const moving: AABB = {
        x: outX - halfW,
        y: outY - halfH,
        width: halfW * 2,
        height: halfH * 2,
      };
      const otherAabb: AABB = {
        x: o.x - halfW,
        y: o.y - halfH,
        width: halfW * 2,
        height: halfH * 2,
      };
      if (AABBCollision.getMTVInto(moving, otherAabb, mtv)) {
        const ox = mtv.x !== 0 ? mtv.x * mtv.depth : 0;
        const oy = mtv.y !== 0 ? mtv.y * mtv.depth : 0;
        outX += ox;
        outY += oy;
      }
    }
  }
  return { x: outX, y: outY };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PRODUCTION_HALF_W = PLAYER.HITBOX_WIDTH / 2; // 48 — PLAYER_PHYSICS_CONFIG.playerHalfW
const PRODUCTION_HALF_H = PLAYER.HITBOX_HEIGHT / 2; // 48 — PLAYER_PHYSICS_CONFIG.playerHalfH

/** Shared mtv/out scratch pair reused across calls (mirrors per-instance scratch). */
const mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
const outScratch: { x: number; y: number } = { x: 0, y: 0 };

/** Packs other-player centers into the flat [x0, y0, x1, y1, ...] layout. */
function packFlat(others: ReadonlyArray<{ x: number; y: number }>): number[] {
  const flat: number[] = [];
  for (const o of others) {
    flat.push(o.x, o.y);
  }
  return flat;
}

function runShared(
  centerX: number,
  centerY: number,
  halfW: number,
  halfH: number,
  others: ReadonlyArray<{ x: number; y: number }>,
  flat?: ArrayLike<number>,
): { x: number; y: number } {
  const othersFlat = flat ?? packFlat(others);
  resolvePlayerSeparation(centerX, centerY, halfW, halfH, othersFlat, others.length, mtvScratch, outScratch);
  return { x: outScratch.x, y: outScratch.y };
}

/**
 * Asserts the shared output is bit-for-bit identical (Object.is — stricter
 * than ===: distinguishes +0/-0 and matches the exact IEEE-754 payload) to
 * BOTH production-loop replicas, for every geometric configuration fed in.
 */
function expectMatchesBothImplementations(
  centerX: number,
  centerY: number,
  others: ReadonlyArray<{ x: number; y: number }>,
  label: string,
  halfW: number = PRODUCTION_HALF_W,
  halfH: number = PRODUCTION_HALF_H,
): { x: number; y: number } {
  const shared = runShared(centerX, centerY, halfW, halfH, others);
  const server = serverResolvePlayerCollisionReference(centerX, centerY, others);
  const client = clientNearbyPlayerSeparationReference(centerX, centerY, halfW, halfH, others);

  expect(
    Object.is(shared.x, server.x) && Object.is(shared.y, server.y),
    `${label}: shared (${shared.x}, ${shared.y}) vs server replica (${server.x}, ${server.y})`,
  ).toBe(true);
  expect(
    Object.is(shared.x, client.x) && Object.is(shared.y, client.y),
    `${label}: shared (${shared.x}, ${shared.y}) vs client replica (${client.x}, ${client.y})`,
  ).toBe(true);
  return shared;
}

// ---------------------------------------------------------------------------
// Characterization sweep
// ---------------------------------------------------------------------------

describe('resolvePlayerSeparation (ticket 03 — shared player-vs-player MTV separation)', () => {
  it('matches both implementations: overlapping from each side (single other)', () => {
    const cx = 1000;
    const cy = 2000;
    // 60px center offset on one axis → 36px overlap on that axis, 96 on the
    // other → MTV resolves along the offset axis.
    const left = expectMatchesBothImplementations(cx, cy, [{ x: cx - 60, y: cy }], 'left');
    const right = expectMatchesBothImplementations(cx, cy, [{ x: cx + 60, y: cy }], 'right');
    const above = expectMatchesBothImplementations(cx, cy, [{ x: cx, y: cy - 60 }], 'above');
    const below = expectMatchesBothImplementations(cx, cy, [{ x: cx, y: cy + 60 }], 'below');

    // Direction sanity (not just equivalence): pushed AWAY from the other.
    expect(left.x).toBeGreaterThan(cx);
    expect(right.x).toBeLessThan(cx);
    expect(above.y).toBeGreaterThan(cy);
    expect(below.y).toBeLessThan(cy);
    // The untouched axis is exactly the input (bit-for-bit passthrough).
    expect(Object.is(left.y, cy)).toBe(true);
    expect(Object.is(above.x, cx)).toBe(true);
  });

  it('matches both implementations: corner overlaps (diagonal)', () => {
    const cx = 512.5;
    const cy = 1024.25;
    // Symmetric diagonal (overlapX === overlapY → tie goes to the Y branch in
    // getMTVInto) and asymmetric diagonals (shallower axis wins).
    expectMatchesBothImplementations(cx, cy, [{ x: cx - 60, y: cy - 60 }], 'corner NW');
    expectMatchesBothImplementations(cx, cy, [{ x: cx + 60, y: cy - 60 }], 'corner NE');
    expectMatchesBothImplementations(cx, cy, [{ x: cx - 60, y: cy + 60 }], 'corner SW');
    expectMatchesBothImplementations(cx, cy, [{ x: cx + 60, y: cy + 60 }], 'corner SE');
    expectMatchesBothImplementations(cx, cy, [{ x: cx - 60.5, y: cy - 80.25 }], 'corner shallow-X');
    expectMatchesBothImplementations(cx, cy, [{ x: cx - 80.25, y: cy - 60.5 }], 'corner shallow-Y');
    // Deep diagonal — nearly full overlap on both axes.
    expectMatchesBothImplementations(cx, cy, [{ x: cx - 10, y: cy + 10 }], 'corner deep');
  });

  it('matches both implementations: multiple simultaneous others (chained accumulation)', () => {
    const cx = 3000;
    const cy = 3000;
    // Two on opposite sides — pushes may chain (second MTV computed from the
    // already-shifted position, exactly like both originals).
    expectMatchesBothImplementations(
      cx,
      cy,
      [
        { x: cx - 60, y: cy },
        { x: cx + 60, y: cy },
      ],
      'two opposite X',
    );
    // Mixed axes.
    expectMatchesBothImplementations(
      cx,
      cy,
      [
        { x: cx - 60, y: cy },
        { x: cx, y: cy + 70 },
        { x: cx + 50.5, y: cy - 30.25 },
      ],
      'three mixed',
    );
    // Dense cluster: five others at deterministic fractional offsets.
    const cluster: Array<{ x: number; y: number }> = [];
    for (let k = 1; k <= 5; k++) {
      cluster.push({ x: cx - 70 + k * 11.375, y: cy - 40 + k * 17.625 });
    }
    expectMatchesBothImplementations(cx, cy, cluster, 'cluster of five');
  });

  it('matches both implementations: non-overlapping others are a no-op passthrough', () => {
    const cx = 4096.75;
    const cy = 2048.125;
    // Far away.
    const far = expectMatchesBothImplementations(cx, cy, [{ x: cx + 500, y: cy + 500 }], 'far');
    expect(Object.is(far.x, cx)).toBe(true);
    expect(Object.is(far.y, cy)).toBe(true);
    // Exact edge contact — `intersects` uses strict `<`, so kissing edges do
    // NOT overlap (96px center distance on one axis, 0 on the other).
    const touching = expectMatchesBothImplementations(
      cx,
      cy,
      [
        { x: cx - 96, y: cy },
        { x: cx + 96, y: cy },
        { x: cx, y: cy - 96 },
        { x: cx, y: cy + 96 },
      ],
      'exact edge contact',
    );
    expect(Object.is(touching.x, cx)).toBe(true);
    expect(Object.is(touching.y, cy)).toBe(true);
  });

  it('matches both implementations: identical centers (full symmetric overlap)', () => {
    const cx = 777.333;
    const cy = 555.666;
    const shared = expectMatchesBothImplementations(cx, cy, [{ x: cx, y: cy }], 'identical');
    // overlapX === overlapY === 96 → tie takes the Y branch; mover center is
    // NOT below other center → sign +1 → pushed +Y by the full overlap.
    expect(Object.is(shared.x, cx)).toBe(true);
    expect(shared.y).toBe(cy + 96);
  });

  it('matches both implementations: deterministic fractional-offset sweep (single other)', () => {
    const cx = 1234.5;
    const cy = 2345.75;
    const offsets = [-120, -96.5, -73.3, -48.1, -12.7, -0.001, 0, 0.001, 12.7, 48.1, 73.3, 96.5, 120];
    for (const dx of offsets) {
      for (const dy of offsets) {
        expectMatchesBothImplementations(cx, cy, [{ x: cx + dx, y: cy + dy }], `sweep dx=${dx} dy=${dy}`);
      }
    }
  });

  it('matches both implementations: deterministic multi-other fractional sweep', () => {
    const cx = 8192.25;
    const cy = 4096.5;
    const offsets = [-60.5, -33.25, 0.75, 41.125, 77.875];
    for (const dx1 of offsets) {
      for (const dy1 of offsets) {
        for (const dy2 of offsets) {
          expectMatchesBothImplementations(
            cx,
            cy,
            [
              { x: cx + dx1, y: cy + dy1 },
              { x: cx - dx1 * 0.5, y: cy + dy2 },
            ],
            `multi sweep dx1=${dx1} dy1=${dy1} dy2=${dy2}`,
          );
        }
      }
    }
  });

  it('processes the flat array strictly in order (ordering is caller-owned)', () => {
    const cx = 1000;
    const cy = 1000;
    const leftThenRight = [
      { x: cx - 60, y: cy },
      { x: cx + 60, y: cy },
    ];
    const rightThenLeft = [
      { x: cx + 60, y: cy },
      { x: cx - 60, y: cy },
    ];

    const a = expectMatchesBothImplementations(cx, cy, leftThenRight, 'order L,R');
    const b = expectMatchesBothImplementations(cx, cy, rightThenLeft, 'order R,L');

    // Both production loops are order-sensitive (the second MTV is computed
    // from the already-displaced position) — the shared function preserves
    // that exactly, which is why ORDERING STAYS IN THE CALLERS (the server
    // feeds an id-sorted list, MovementService.ts:153).
    expect(a.x).not.toBe(b.x);
  });

  it('reads only the first otherCount pairs (count-truncated buffer)', () => {
    const cx = 2000;
    const cy = 2000;
    const active = [
      { x: cx - 60, y: cy },
      { x: cx + 20.5, y: cy + 44.25 },
    ];
    const others = [...active, { x: cx, y: cy }]; // third entry would push hard
    const flat = packFlat(others);
    // count = 2 → the identical-centers third entry must be IGNORED even
    // though it sits in the buffer (preallocated-buffer + count contract).
    const shared = runShared(cx, cy, PRODUCTION_HALF_W, PRODUCTION_HALF_H, active, flat);
    const server = serverResolvePlayerCollisionReference(cx, cy, active);
    const client = clientNearbyPlayerSeparationReference(
      cx,
      cy,
      PRODUCTION_HALF_W,
      PRODUCTION_HALF_H,
      active,
    );
    expect(Object.is(shared.x, server.x) && Object.is(shared.y, server.y)).toBe(true);
    expect(Object.is(shared.x, client.x) && Object.is(shared.y, client.y)).toBe(true);
  });

  it('otherCount 0 is a no-op (empty list, and buffer with garbage)', () => {
    const cx = 3210.125;
    const cy = 1230.625;
    const shared = runShared(cx, cy, PRODUCTION_HALF_W, PRODUCTION_HALF_H, [], [999, -999, 42]);
    expect(Object.is(shared.x, cx)).toBe(true);
    expect(Object.is(shared.y, cy)).toBe(true);
  });

  it('accepts a Float64Array buffer (zero-alloc packing target)', () => {
    const cx = 1500;
    const cy = 2500;
    const others = [
      { x: cx - 55.5, y: cy },
      { x: cx, y: cy + 61.25 },
    ];
    const flat = new Float64Array(packFlat(others));
    const shared = runShared(cx, cy, PRODUCTION_HALF_W, PRODUCTION_HALF_H, others, flat);
    const server = serverResolvePlayerCollisionReference(cx, cy, others);
    expect(Object.is(shared.x, server.x) && Object.is(shared.y, server.y)).toBe(true);
  });

  it('scratch reuse across calls stays correct (module-pooled AABB scratch)', () => {
    // Call 1 — heavy overlap, leaves accumulated state in the pooled scratch.
    const first = expectMatchesBothImplementations(100, 100, [{ x: 100, y: 100 }], 'reuse-1');
    expect(first.y).toBe(196);
    // Call 2 — must not observe call 1's leftovers.
    const second = expectMatchesBothImplementations(5000.5, 6000.75, [{ x: 5100, y: 6000.75 }], 'reuse-2');
    expect(Object.is(second.y, 6000.75)).toBe(true);
  });

  it('matches the client implementation for non-production half-extents (parameterized path)', () => {
    // The server loop hardcodes PLAYER.HITBOX_* (96x96), so bit-for-bit
    // equivalence vs BOTH is only defined at the production half-extents
    // (covered above). The client loop is parameterized (halfW/halfH args) —
    // pin the shared parameterization against the client replica alone.
    const cx = 911.5;
    const cy = 417.25;
    const halfPairs: Array<[number, number]> = [
      [32, 40],
      [48, 24],
      [64, 64],
      [12.5, 88.75],
    ];
    for (const [halfW, halfH] of halfPairs) {
      const others = [
        { x: cx - halfW - 20.25, y: cy },
        { x: cx + halfW * 0.75, y: cy + halfH * 0.5 },
      ];
      const shared = runShared(cx, cy, halfW, halfH, others);
      const client = clientNearbyPlayerSeparationReference(cx, cy, halfW, halfH, others);
      expect(
        Object.is(shared.x, client.x) && Object.is(shared.y, client.y),
        `halfW=${halfW} halfH=${halfH}: shared (${shared.x}, ${shared.y}) vs client (${client.x}, ${client.y})`,
      ).toBe(true);
    }
  });
});
