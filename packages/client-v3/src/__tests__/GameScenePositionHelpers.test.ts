// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PlayerStatus } from '@sector-battle/shared';
import {
  getAllPlayerPositions,
  NEARBY_PLAYER_DEAD_MASK,
  NEARBY_PLAYER_RANGE_PX,
} from '../GameScenePositionHelpers.js';
import type { GameState } from '../controllers/GameState.js';
import type { StateSync } from '../network/StateSync.js';
import type { EntityInterpolator } from '../prediction/EntityInterpolator.js';
import type { PlayerState } from '../types.js';

/**
 * TICKET #42 ORACLE BATTERY — fused nearby-collision membership equivalence.
 *
 * The nearby-collision set used to be built by a THIRD full iteration over the
 * positions map in GameScene.update (the block at GameScene.ts:576-599 before
 * this ticket): per remote it did a `stateSync.getPlayer(pid)` lookup, skipped
 * dead/dying/spectating players via the dead mask, preferred the
 * latest-received authoritative position (falling back to the interpolated map
 * entry), and pushed remotes within 320px (strict less-than, squared form) into
 * a pool — in map iteration order.
 *
 * Ticket #42 fuses that build into the SAME pass that constructs the positions
 * map. `oracleNearby` below is a VERBATIM transcription of the removed third
 * pass (only `this.X` → parameter references and `.push` instead of the pooled
 * write). Every case asserts the fused pool ([0, count), order included) equals
 * the oracle — including the exact-320 boundary, dead statuses, source
 * selection, self-exclusion, and entry ORDER (the pool order feeds collision
 * separation order, which must not change).
 */

interface InterpSpec {
  /** getInterpolatedPosition result: false, or the emitted {x,y}. */
  interp?: { x: number; y: number } | false;
  /** getLatestReceivedPosition result: false, or the emitted {x,y}. */
  latest?: { x: number; y: number } | false;
}

interface Fixture {
  myId: string;
  localPos: { x: number; y: number };
  /** entity-status per pid (what the old stateSync.getPlayer(pid).status read). */
  status?: Record<string, number>;
  interp: Record<string, InterpSpec>;
  /** Insertion-ordered players map (JS Maps preserve insertion order). */
  players?: string[];
}

function makeInterpolator(interp: Record<string, InterpSpec>): EntityInterpolator {
  return {
    getInterpolatedPosition(id: string, out: { x: number; y: number }) {
      const spec = interp[id]?.interp;
      if (!spec) return false;
      out.x = spec.x;
      out.y = spec.y;
      return true;
    },
    getLatestReceivedPosition(id: string, out: { x: number; y: number }) {
      const spec = interp[id]?.latest;
      if (!spec) return false;
      out.x = spec.x;
      out.y = spec.y;
      return true;
    },
  } as unknown as EntityInterpolator;
}

interface Harness {
  run: () => Map<string, { x: number; y: number }>;
  nearbyPool: { x: number; y: number }[];
  nearbyCount: { count: number };
  getPlayer: (id: string) => PlayerState | undefined;
  interpolator: EntityInterpolator;
}

function makeHarness(fixture: Fixture): Harness {
  const players = new Map<string, PlayerState>();
  for (const pid of fixture.players ?? Object.keys(fixture.interp)) {
    players.set(
      pid,
      { x: 0, y: 0, status: fixture.status?.[pid] ?? PlayerStatus.ALIVE } as unknown as PlayerState,
    );
  }
  const stateSync = {
    getEntities: () => ({ players }),
    getPlayer: (id: string) => players.get(id),
  } as unknown as StateSync;
  const state = { myId: fixture.myId, localPos: fixture.localPos } as unknown as GameState;
  const interpolator = makeInterpolator(fixture.interp);
  const playerPositionsMap = new Map<string, { x: number; y: number }>();
  const playerPositionsPool: { x: number; y: number }[] = [];
  const nearbyPool: { x: number; y: number }[] = [];
  const nearbyCount: { count: number } = { count: 0 };
  return {
    interpolator,
    getPlayer: stateSync.getPlayer,
    nearbyPool,
    nearbyCount,
    run: () =>
      getAllPlayerPositions({
        state,
        stateSync,
        interpolator,
        playerPositionsMap,
        playerPositionsPool,
        interpolatorOut: { x: 0, y: 0 },
        nearbyPool,
        nearbyScratch: { x: 0, y: 0 },
        nearbyCountOut: nearbyCount,
      }),
  };
}

/**
 * ORACLE — verbatim body of the removed third pass (GameScene.ts:576-599
 * pre-ticket-42). `this.state.myId` → `myId`, `this.stateSync.getPlayer` →
 * `getPlayer`, `this.interpolator` → `interpolator`, pooled push → array push.
 */
function oracleNearby(
  positions: Map<string, { x: number; y: number }>,
  fixture: Fixture,
  getPlayer: (id: string) => PlayerState | undefined,
  interpolator: EntityInterpolator,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const lpx = fixture.localPos.x;
  const lpy = fixture.localPos.y;
  const deadMask = PlayerStatus.DEAD | PlayerStatus.DYING | PlayerStatus.SPECTATING;
  const scratch = { x: 0, y: 0 };
  for (const [pid, interpolated] of positions) {
    if (pid === fixture.myId) continue;
    const p = getPlayer(pid);
    if (p && (p.status & deadMask)) continue;
    const src = interpolator.getLatestReceivedPosition(pid, scratch) ? scratch : interpolated;
    const ddx = src.x - lpx;
    const ddy = src.y - lpy;
    if (ddx * ddx + ddy * ddy < 320 * 320) {
      out.push({ x: src.x, y: src.y });
    }
  }
  return out;
}

/** Run fused + oracle on a fixture and assert pool[0,count) ≡ oracle (order incl.). */
function assertMembershipEquivalence(fixture: Fixture): {
  positions: Map<string, { x: number; y: number }>;
  fused: { x: number; y: number }[];
} {
  const h = makeHarness(fixture);
  const positions = h.run();
  const fused = h.nearbyPool.slice(0, h.nearbyCount.count).map((e) => ({ x: e.x, y: e.y }));
  const oracle = oracleNearby(positions, fixture, h.getPlayer, h.interpolator);
  expect(fused).toEqual(oracle);
  return { positions, fused };
}

describe('getAllPlayerPositions — fused nearby-collision build (ticket #42)', () => {
  it('exports the extracted predicate constants verbatim', () => {
    expect(NEARBY_PLAYER_RANGE_PX).toBe(320);
    expect(NEARBY_PLAYER_DEAD_MASK).toBe(
      PlayerStatus.DEAD | PlayerStatus.DYING | PlayerStatus.SPECTATING,
    );
  });

  it('empty players → empty map, zero nearby', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {},
    });
    expect(fused).toEqual([]);
  });

  it('self only → map has self entry, nearby stays empty (self-skip)', () => {
    const { positions, fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 100, y: 200 },
      interp: { me: { interp: false } }, // self branch ignores the interpolator
    });
    expect([...positions.keys()]).toEqual(['me']);
    expect(positions.get('me')).toMatchObject({ x: 100, y: 200 });
    expect(fused).toEqual([]);
  });

  it('self at distance 0 from itself is still excluded (origin = local player)', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: { me: { interp: { x: 0, y: 0 } } },
    });
    expect(fused).toEqual([]);
  });

  it('near remote is included; remote positions are the latest-received source', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        a: { interp: { x: 10, y: 20 }, latest: { x: 30, y: 40 } },
      },
    });
    expect(fused).toEqual([{ x: 30, y: 40 }]);
  });

  it('EXACT 320px boundary is EXCLUDED (strict <, squared form preserved)', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        axis: { interp: { x: 320, y: 0 }, latest: { x: 320, y: 0 } }, // 320² = cutoff → out
        diag: { interp: { x: 226.3, y: 226.3 }, latest: { x: 226.3, y: 226.3 } }, // √512.2… > 320
      },
    });
    expect(fused).toEqual([]);
  });

  it('just inside the cutoff is included (axis and diagonal)', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        axis: { interp: { x: 319.999, y: 0 }, latest: { x: 319.999, y: 0 } },
        diag: { interp: { x: 225, y: 225 }, latest: { x: 225, y: 225 } }, // 101250 < 102400
      },
    });
    expect(fused).toEqual([
      { x: 319.999, y: 0 },
      { x: 225, y: 225 },
    ]);
  });

  it('distance is measured to the local player position, not the world origin', () => {
    // 1000,2000-relative: 'near' at +100 from local; 'far' would be near (0,0).
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 1000, y: 2000 },
      interp: {
        near: { interp: { x: 1100, y: 2000 }, latest: { x: 1100, y: 2000 } },
        worldOriginHoneytrap: { interp: { x: 0, y: 0 }, latest: { x: 0, y: 0 } },
      },
    });
    expect(fused).toEqual([{ x: 1100, y: 2000 }]);
  });

  it.each([
    ['DEAD', PlayerStatus.DEAD],
    ['DYING', PlayerStatus.DYING],
    ['SPECTATING', PlayerStatus.SPECTATING],
    ['DEAD|SPECTATING', PlayerStatus.DEAD | PlayerStatus.SPECTATING],
    ['DYING|STAGGERED', PlayerStatus.DYING | PlayerStatus.STAGGERED],
  ])('dead-mask status %s excludes an otherwise-near remote', (_label, status) => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      status: { corpse: status },
      interp: { me: { interp: false }, corpse: { interp: { x: 50, y: 50 }, latest: { x: 50, y: 50 } } },
    });
    expect(fused).toEqual([]);
  });

  it.each([
    ['ALIVE', PlayerStatus.ALIVE],
    ['INVINCIBLE', PlayerStatus.INVINCIBLE],
    ['STAGGERED', PlayerStatus.STAGGERED],
    ['FRESH_SPAWN', PlayerStatus.FRESH_SPAWN],
  ])('non-dead status %s keeps an otherwise-near remote', (_label, status) => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      status: { pal: status },
      interp: { me: { interp: false }, pal: { interp: { x: 50, y: 50 }, latest: { x: 50, y: 50 } } },
    });
    expect(fused).toEqual([{ x: 50, y: 50 }]);
  });

  it('remote with no interpolatable position is absent from BOTH map and nearby set', () => {
    const { positions, fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        ghost: { interp: false, latest: { x: 5, y: 5 } }, // close + alive, but invisible
      },
    });
    expect([...positions.keys()]).toEqual(['me']);
    expect(fused).toEqual([]);
  });

  it('latest-received unavailable → falls back to the interpolated map entry (old semantics)', () => {
    // Stub-only case (with the real EntityInterpolator, interp-ok implies
    // latest-ok — both gate on count >= 1); locks the fallback branch anyway.
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        fb: { interp: { x: 60, y: 0 }, latest: false },
      },
    });
    expect(fused).toEqual([{ x: 60, y: 0 }]);
  });

  it('latest-received drives inclusion, not the interpolated display position (NET-29)', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        interpNearLatestFar: { interp: { x: 10, y: 0 }, latest: { x: 500, y: 0 } }, // → out
        interpFarLatestNear: { interp: { x: 500, y: 0 }, latest: { x: 10, y: 0 } }, // → in
      },
    });
    expect(fused).toEqual([{ x: 10, y: 0 }]);
  });

  it('entry ORDER matches the old third pass (players-map order) with dead/far players interleaved', () => {
    const { fused } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 1000, y: 1000 },
      status: { s3: PlayerStatus.DEAD },
      interp: {
        me: { interp: false },
        s1: { interp: { x: 1100, y: 1000 }, latest: { x: 1100, y: 1000 } }, // in
        s2: { interp: { x: 5000, y: 5000 }, latest: { x: 5000, y: 5000 } }, // far
        s3: { interp: { x: 1050, y: 1050 }, latest: { x: 1050, y: 1050 } }, // dead
        s4: { interp: false, latest: { x: 900, y: 900 } }, // not in map
        s5: { interp: { x: 1200, y: 1000 }, latest: { x: 1200, y: 1000 } }, // in
      },
    });
    expect(fused).toEqual([
      { x: 1100, y: 1000 },
      { x: 1200, y: 1000 },
    ]);
  });

  it('stale pool tail beyond the live count is not part of the set (ticket #37 view semantics)', () => {
    const h = makeHarness({
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        a: { interp: { x: 10, y: 0 }, latest: { x: 10, y: 0 } },
        b: { interp: { x: 20, y: 0 }, latest: { x: 20, y: 0 } },
      },
    });
    h.run();
    expect(h.nearbyCount.count).toBe(2);
    // Next frame: only 'a' qualifies — the pool keeps a stale [1] entry but the
    // count view must exclude it.
    const h2Players: Record<string, InterpSpec> = {
      me: { interp: false },
      a: { interp: { x: 15, y: 0 }, latest: { x: 15, y: 0 } },
    };
    const h2 = makeHarness({ myId: 'me', localPos: { x: 0, y: 0 }, interp: h2Players });
    // Reuse the SAME pool to simulate the persistent GameScene field.
    const positions = getAllPlayerPositions({
      state: { myId: 'me', localPos: { x: 0, y: 0 } } as unknown as GameState,
      stateSync: {
        getEntities: () => ({
          players: new Map(
            Object.entries(h2Players).map(([pid]) => [pid, { x: 0, y: 0, status: 1 }]),
          ),
        }),
      } as unknown as StateSync,
      interpolator: makeInterpolator(h2Players),
      playerPositionsMap: new Map(),
      playerPositionsPool: [],
      interpolatorOut: { x: 0, y: 0 },
      nearbyPool: h.nearbyPool, // carries the stale tail
      nearbyScratch: { x: 0, y: 0 },
      nearbyCountOut: h.nearbyCount,
    });
    const fused = h.nearbyPool.slice(0, h.nearbyCount.count).map((e) => ({ x: e.x, y: e.y }));
    const oracle = oracleNearby(
      positions,
      { myId: 'me', localPos: { x: 0, y: 0 }, interp: h2Players },
      (id) => ({ x: 0, y: 0, status: PlayerStatus.ALIVE }) as unknown as PlayerState,
      makeInterpolator(h2Players),
    );
    expect(h.nearbyCount.count).toBe(1);
    expect(fused).toEqual(oracle);
    expect(fused).toEqual([{ x: 15, y: 0 }]);
  });

  it('map contents are unchanged for the other consumers (auras / fire-dots read x,y by key)', () => {
    const { positions } = assertMembershipEquivalence({
      myId: 'me',
      localPos: { x: 7, y: 8 },
      status: { dead: PlayerStatus.DEAD },
      interp: {
        me: { interp: false },
        r1: { interp: { x: 10, y: 20 }, latest: { x: 30, y: 40 } },
        dead: { interp: { x: 50, y: 60 }, latest: { x: 50, y: 60 } }, // in MAP despite dead
        r2: { interp: false }, // not in map
      },
    });
    // Display path still sees the INTERPOLATED positions (not latest-received),
    // dead players included — the map is display-only input for these consumers.
    expect([...positions.entries()].map(([k, v]) => [k, { x: v.x, y: v.y }])).toEqual([
      ['me', { x: 7, y: 8 }],
      ['r1', { x: 10, y: 20 }],
      ['dead', { x: 50, y: 60 }],
    ]);
  });

  it('pool and map entries are reused across frames (no steady-state allocation)', () => {
    const fixture: Fixture = {
      myId: 'me',
      localPos: { x: 0, y: 0 },
      interp: {
        me: { interp: false },
        a: { interp: { x: 10, y: 0 }, latest: { x: 10, y: 0 } },
      },
    };
    const h = makeHarness(fixture);
    h.run();
    const poolEntryRef = h.nearbyPool[0];
    const countBefore = h.nearbyPool.length;
    h.run();
    expect(h.nearbyPool[0]).toBe(poolEntryRef); // same object, mutated in place
    expect(h.nearbyPool.length).toBe(countBefore); // no growth for same load
    expect(h.nearbyCount.count).toBe(1);
  });
});
