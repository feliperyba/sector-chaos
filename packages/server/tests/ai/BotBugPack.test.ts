import { describe, it, expect } from 'vitest';
import { WeaponType, InputAction, NETWORK, BARREL, TILE_PIXEL_SIZE } from '@sector-battle/shared';
import type { BotContext, ItemInfo } from '../../src/ai/BotContext.ts';
import { BotContext, BotState } from '../../src/ai/BotContext.ts';
import { BotRNG } from '../../src/ai/BotContext.ts';
import { isOnSiegeWarning } from '../../src/ai/intent/intentHelpers.ts';
import { buildPersonality } from '../../src/ai/intent/PersonalityProfile.ts';
import type { IntentContext } from '../../src/ai/intent/Intent.ts';
import { BarrelTrapIntent } from '../../src/ai/intent/intentEngage.ts';
import { packGridKey } from '../../src/ai/BotDestructibles.ts';
import { executeLoot } from '../../src/ai/BotEconomyExecutors.ts';
import { rescanHazards } from '../../src/ai/BotSelfState.ts';
import { createTickBlackboard } from '../../src/ai/TickBlackboard.ts';
import type { BotSystem } from '../../src/ai/BotSystem.ts';
import type { PlayerDTO } from '../../src/ai/WorldSnapshot.ts';
import type { DestructibleDTO } from '../../src/ai/WorldSnapshotTypes.ts';

/**
 * bot-ai-v2 ticket 02 — the DEC-006 verified bug pack.
 *
 * One red/green regression test per audited defect (AUDIT §11 / decision_log
 * DEC-006). Each describe documents the buggy pre-fix behavior its assertions
 * fail on (the "red" half, verified by running this file against the pre-fix
 * tree) and the fixed behavior it pins.
 *
 * Fix 6 (dead-code deletion: the ContextSteering module, the pickWanderTarget
 * wander picker, five dead BotSystemConstants exports) is not unit-testable —
 * its proof is grep-zero-references + typecheck + lint + suites green, per the
 * ticket.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — siege-warning proximity used tile size 64 instead of the shared
// TILE_PIXEL_SIZE (128), so the checked point sat at HALF the pending wall's
// true world position. The SURVIVE_ZONE siege hard-flee (score 1.0) almost
// never activated from the proximity path (AUDIT §11.1).
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 1: isOnSiegeWarning uses the shared tile size', () => {
  function siegeCtx(x: number, y: number, warnings: Array<{ x: number; y: number }>): BotContext {
    return { x, y, siegeWarnings: warnings } as unknown as BotContext;
  }

  it('warns for a bot standing AT the pending wall drop (true world position)', () => {
    // Warning in GRID coords (BotZoneSafety stores {x: gridX, y: gridY}); the
    // wall's world position is grid * TILE_PIXEL_SIZE.
    const ctx = siegeCtx(10 * TILE_PIXEL_SIZE, 10 * TILE_PIXEL_SIZE, [{ x: 10, y: 10 }]);
    // Pre-fix: checked point (640, 640) vs bot (1280, 1280) — 905px away, no
    // warning. The bot gets crushed by a wall it was standing on.
    expect(isOnSiegeWarning(ctx)).toBe(true);
  });

  it('does NOT warn at the old 64-px ghost position (half-coordinate error)', () => {
    // A bot at 64-scaled coordinates is NOT near the real wall.
    const ctx = siegeCtx(10 * 64, 10 * 64, [{ x: 10, y: 10 }]);
    // Pre-fix: the ghost point coincided with the bot — warning fired on a
    // wall that is actually 905px away (false positive, the inverse symptom).
    expect(isOnSiegeWarning(ctx)).toBe(false);
  });

  it('warns within tileSize * 2.5 of the wall center and not beyond', () => {
    const wallGridX = 20;
    const wallWorldX = wallGridX * TILE_PIXEL_SIZE; // 2560
    const near = TILE_PIXEL_SIZE * 2.5; // 320 — the proximity radius
    // 300px from the wall center → warned (pre-fix: 980px from the ghost → not).
    expect(isOnSiegeWarning(siegeCtx(wallWorldX - 300, 0, [{ x: wallGridX, y: 0 }]))).toBe(true);
    // 340px from the wall center → outside the radius.
    expect(isOnSiegeWarning(siegeCtx(wallWorldX - 340, 0, [{ x: wallGridX, y: 0 }]))).toBe(false);
  });

  it('no warnings → false regardless of position', () => {
    expect(isOnSiegeWarning(siegeCtx(0, 0, []))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — the personality jitter draw was sign-clamped
// (Math.max(0.05, Math.min(0.98, draw))): every draw below +0.05 (≈71% of
// them) collapsed to exactly +0.05, so weights only ever moved UP from base
// and intra-archetype variance collapsed (AUDIT §11.2). The fix keeps the raw
// signed (rng.next() - 0.5) * 0.24 draw and clamps the RESULT (base + jitter)
// to [0.05, 0.98].
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 2: symmetric personality jitter with result clamping', () => {
  const SEEDS = 800;
  const WEIGHT_KEYS = ['aggression', 'greed', 'caution', 'opportunism', 'trapper'] as const;

  /** Group weight values per (archetype, weight) across seeded profiles. */
  function collectGroups(): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    for (let seed = 0; seed < SEEDS; seed++) {
      const p = buildPersonality(new BotRNG(seed), 'hard');
      for (const key of WEIGHT_KEYS) {
        const g = `${p.archetype}:${key}`;
        let arr = groups.get(g);
        if (!arr) {
          arr = [];
          groups.set(g, arr);
        }
        arr.push(p.weights[key]);
      }
    }
    return groups;
  }

  it('no point mass: the +0.05 clamp spike (~71% of draws pre-fix) is gone', () => {
    const groups = collectGroups();
    let maxModeFrac = 0;
    let worst = '';
    for (const [g, values] of groups) {
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      let mode = 0;
      for (const c of counts.values()) mode = Math.max(mode, c);
      const frac = mode / values.length;
      if (frac > maxModeFrac) {
        maxModeFrac = frac;
        worst = g;
      }
    }
    // Pre-fix: every group's mode (base + 0.05 exactly) covers ~71% of draws.
    // Post-fix: values are continuous floats with ONE legitimate point mass —
    // the RESULT clamp's top edge. TRAPPER's trapper weight (base 0.9, the
    // only base where base + 0.12 ≥ 0.98) lands exactly at 0.98 for
    // P(jitter ≥ 0.08) = 0.04/0.24 = 1/6 ≈ 16.7% of draws; no other weight
    // can reach either clamp edge (lowest base 0.2 > 0.05 + 0.12). The gate
    // therefore sits above the 1/6 edge mass + sampling noise and far below
    // the pre-fix ~71% spike.
    expect(maxModeFrac).toBeLessThan(0.35);
    expect(worst).not.toBe(''); // sanity: at least one group was sampled
  });

  it('intra-archetype weight spread spans the ±0.12 jitter band (not just +0.05..+0.12)', () => {
    const groups = collectGroups();
    let maxSpan = 0;
    for (const [, values] of groups) {
      const span = Math.max(...values) - Math.min(...values);
      maxSpan = Math.max(maxSpan, span);
    }
    // Pre-fix: values live in [base+0.05, base+0.12] → span ≤ 0.07.
    // Post-fix: interior-base groups span nearly the full 0.24 band — which
    // also proves draws land on BOTH sides of the base (symmetric).
    expect(maxSpan).toBeGreaterThan(0.18);
  });

  it('jitter draws land below the archetype base (negative side restored)', () => {
    // Without exporting the base table, the provable negative-side signal is
    // the MODE value: pre-fix every group's dominant value is base + 0.05
    // (above base) and NO value can be below base + 0.05, so every group's
    // minimum equals its mode. Post-fix the minimum sits strictly below the
    // mode for essentially every group.
    const groups = collectGroups();
    let groupsWithMinBelowMode = 0;
    let groupsChecked = 0;
    for (const [, values] of groups) {
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      let modeValue = values[0]!;
      let modeCount = -1;
      for (const [v, c] of counts) {
        if (c > modeCount) {
          modeCount = c;
          modeValue = v;
        }
      }
      groupsChecked++;
      if (Math.min(...values) < modeValue) groupsWithMinBelowMode++;
    }
    expect(groupsChecked).toBeGreaterThan(0);
    // Pre-fix: 0 groups (min === mode === base + 0.05 everywhere).
    expect(groupsWithMinBelowMode / groupsChecked).toBeGreaterThan(0.9);
  });

  it('results stay clamped to the valid [0.05, 0.98] weight range', () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const p = buildPersonality(new BotRNG(seed), 'medium');
      for (const key of WEIGHT_KEYS) {
        expect(p.weights[key]).toBeGreaterThanOrEqual(0.05);
        expect(p.weights[key]).toBeLessThanOrEqual(0.98);
      }
    }
  });

  it('same seed still reproduces the identical profile (determinism)', () => {
    const a = buildPersonality(new BotRNG(424242), 'hard');
    const b = buildPersonality(new BotRNG(424242), 'hard');
    expect(a.weights).toEqual(b.weights);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — HEALTH_FULL_BLACKLIST_MS (3000, commented "3s") was added directly
// to tick counters: 3000 TICKS = 50 seconds at NETWORK.TICK_RATE 60. A bot
// that blacklisted a health pack at full HP ignored it for 50s after taking
// damage (AUDIT §11.3). Fixed: ms → ticks via the tick-rate constant.
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 3: health-full blacklist is 3 seconds, not 50', () => {
  const HEALTH_PACK_ID = 'hp1';
  const BARRIER_ID = 'bar1';
  const THREE_SECONDS_TICKS = Math.round(3 * NETWORK.TICK_RATE); // 180 at 60Hz

  function makeLootCtx(): BotContext {
    const ctx = new BotContext('bot-hp-blacklist');
    ctx.x = 0;
    ctx.y = 0;
    ctx.health = 100;
    ctx.maxHealth = 100;
    ctx.nearestHealth = {
      id: HEALTH_PACK_ID,
      x: 0,
      y: 300, // due north — move angle π/2
      distance: 300,
      type: 'powerup',
      tier: 0,
      powerUpType: 'health_pack',
    } satisfies ItemInfo;
    // A second, worse candidate so the executor returns a walk-over MOVE
    // instead of falling through to executeWander when the pack is gated.
    ctx.nearestBarrier = {
      id: BARRIER_ID,
      x: 400, // due east — move angle 0
      y: 0,
      distance: 400,
      type: 'powerup',
      tier: 0,
      powerUpType: 'barrier',
    } satisfies ItemInfo;
    return ctx;
  }

  // Ticket 09 (DEC-010.5): executeLoot's claim step writes the PERSISTENT
  // claim store (system.itemClaims), and the walk-over band closes through
  // the wall-validated move (system.pathfinder — ticket 06) — the stub now
  // carries both. The pathfinder is a minimal always-walkable duck type: on
  // open ground validatedMoveToward returns the raw angle unchanged, so the
  // move-angle assertions below keep their meaning.
  const systemStub = {
    mapCenter: { x: 0, y: 0 },
    itemClaims: new Map(),
    pathfinder: {
      getTileSize: () => TILE_PIXEL_SIZE,
      worldToGrid: (p: { x: number; y: number }) => ({ x: 0, y: 0 }),
      isWalkable: () => true,
    },
  } as unknown as BotSystem;
  const bb = () => createTickBlackboard({ x: 0, y: 0, tick: -9999 });

  function moveAngle(input: { data: { dx: number; dy: number } }): number {
    return Math.atan2(input.data.dy, input.data.dx);
  }

  it('full-health bot blacklists the pack for exactly 3s of ticks', () => {
    const ctx = makeLootCtx();
    const out = executeLoot(systemStub, ctx, bb());
    // Blacklist expiry is stored in TICKS: 3s at NETWORK.TICK_RATE.
    // Pre-fix: 3000 ticks (50s).
    expect(ctx.blacklistedItems.get(HEALTH_PACK_ID)).toBe(THREE_SECONDS_TICKS);
    // The pack is gated out; the bot moves toward the barrier instead.
    expect(out?.action).toBe(InputAction.MOVE);
    expect(moveAngle(out!)).toBeCloseTo(0, 5);
  });

  it('damaged bot reconsiders the pack after ~3s (blacklist expiry unblocks it)', () => {
    const ctx = makeLootCtx();
    executeLoot(systemStub, ctx, bb()); // t=0: full HP → blacklist
    ctx.tick = THREE_SECONDS_TICKS + 20; // 3.33s later
    ctx.health = 40; // took damage — the pack is now needed
    const out = executeLoot(systemStub, ctx, bb());
    // Post-fix: the pack is a candidate again and wins (300px beats 400px);
    // the bot turns toward it (angle π/2). Pre-fix: still blacklisted at
    // tick 320 of 3000 → the bot keeps ignoring a pack it needs for ~50s.
    expect(ctx.blacklistedItems.has(HEALTH_PACK_ID)).toBe(false);
    expect(out?.action).toBe(InputAction.MOVE);
    expect(moveAngle(out!)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('damaged bot still skips the pack WITHIN the 3s window (cooldown is real)', () => {
    const ctx = makeLootCtx();
    executeLoot(systemStub, ctx, bb()); // t=0: full HP → blacklist
    ctx.tick = THREE_SECONDS_TICKS - 60; // 2s later — still inside 3s
    ctx.health = 40;
    const out = executeLoot(systemStub, ctx, bb());
    expect(ctx.blacklistedItems.has(HEALTH_PACK_ID)).toBe(true);
    expect(out?.action).toBe(InputAction.MOVE);
    expect(moveAngle(out!)).toBeCloseTo(0, 5); // still heading for the barrier
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 4 — BARREL_TRAP hardcoded ts=128 for its grid math and set the
// demolition target to the barrel DTO position, bypassing the shared
// pathfinder tile-size accessor and the SAT-centroid map every other
// demolition path aims through (AUDIT §11.4). Fixed: the intent computes its
// grid key via the shared accessor and routes the target through the
// centroid map, so the swing aligns with the server's SAT contact test.
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 4: barrel-trap demolition uses the shared tile size + SAT centroid', () => {
  const intent = new BarrelTrapIntent();

  function makeTrapCtx(): BotContext {
    return {
      tick: 100,
      hotBarrels: [{ x: 1000, y: 100, distance: 400 }], // ≥376 blast margin, ≤ range*0.95
      activeSlot: 1,
      getActiveWeapon: () => ({
        weaponType: WeaponType.HAMMER,
        tier: 1,
        durability: 10,
        ammo: 0,
      }),
      getWeaponRange: () => 480,
      demolitionGridX: -1,
      demolitionGridY: -1,
      demolitionTargetX: 0,
      demolitionTargetY: 0,
    } as unknown as BotContext;
  }

  it('aims at the real collider centroid and keys the grid via the shared accessor', () => {
    const ctx = makeTrapCtx();
    const pfTile = 64; // NOT 128 — proves the accessor is used, not a literal
    const gx = Math.floor(1000 / pfTile); // 15
    const gy = Math.floor(100 / pfTile); // 1
    const centroid = { x: 990, y: 110 }; // artist-authored off-center collider
    const ic = {
      ctx,
      profile: undefined as never,
      aliveBotCount: 20,
      enemyInFightRange: false,
      zoneIsLethal: false,
      pathfinder: { getTileSize: () => pfTile },
      destructibleCentroidMap: new Map([[packGridKey(gx, gy), centroid]]),
    } as IntentContext;

    const res = intent.execute(ic);

    expect(res.nextState).toBe(BotState.DEMOLITION);
    // Pre-fix: ts hardcoded 128 → grid (7, 0), target = barrel DTO position
    // (1000, 100) — the wrong tile key AND the tile-center aim the centroid
    // map exists to fix.
    expect(ctx.demolitionGridX).toBe(gx);
    expect(ctx.demolitionGridY).toBe(gy);
    expect(ctx.demolitionTargetX).toBe(centroid.x);
    expect(ctx.demolitionTargetY).toBe(centroid.y);
    expect(ctx.preDemolitionState).toBe(BotState.ENGAGE);
  });

  it('falls back to the barrel position when no centroid entry exists', () => {
    const ctx = makeTrapCtx();
    const ic = {
      ctx,
      profile: undefined as never,
      aliveBotCount: 20,
      enemyInFightRange: false,
      zoneIsLethal: false,
      pathfinder: { getTileSize: () => TILE_PIXEL_SIZE },
      destructibleCentroidMap: new Map(), // no enriched atlas → no centroids
    } as IntentContext;

    const res = intent.execute(ic);

    expect(res.nextState).toBe(BotState.DEMOLITION);
    expect(ctx.demolitionGridX).toBe(Math.floor(1000 / TILE_PIXEL_SIZE));
    expect(ctx.demolitionGridY).toBe(Math.floor(100 / TILE_PIXEL_SIZE));
    expect(ctx.demolitionTargetX).toBe(1000); // barrel's real position
    expect(ctx.demolitionTargetY).toBe(100);
  });

  it('production tile size: grid + centroid resolve through the shared maps', () => {
    const ctx = makeTrapCtx();
    const gx = Math.floor(1000 / TILE_PIXEL_SIZE); // 7
    const gy = Math.floor(100 / TILE_PIXEL_SIZE); // 0
    const centroid = { x: 1010, y: 90 };
    const ic = {
      ctx,
      profile: undefined as never,
      aliveBotCount: 20,
      enemyInFightRange: false,
      zoneIsLethal: false,
      pathfinder: { getTileSize: () => TILE_PIXEL_SIZE },
      destructibleCentroidMap: new Map([[packGridKey(gx, gy), centroid]]),
    } as IntentContext;

    intent.execute(ic);

    expect(ctx.demolitionGridX).toBe(gx);
    expect(ctx.demolitionGridY).toBe(gy);
    expect(ctx.demolitionTargetX).toBe(centroid.x);
    expect(ctx.demolitionTargetY).toBe(centroid.y);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 5 — the per-tick hazard rescan scanned barrels at
// BARREL.EXPLOSION_RADIUS + 80 (336px) while the full staggered scan used
// BARREL.EXPLOSION_RADIUS + 200 (456px): barrels in the 336–456 shell
// flickered in/out of the danger view across the scan cycle (AUDIT §11.6).
// Fixed: one shared range constant consumed by both paths.
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix 5: hazard rescan uses the full scan barrel range (no flicker)', () => {
  const FULL_SCAN_BARREL_RANGE = BARREL.EXPLOSION_RADIUS + 200; // 456

  /** Stub system whose queries HONOR the requested radius (unlike the pool
   *  tests' always-iterate stub) and record the ranges they were asked for. */
  function makeRangeHonoringSystem(destructibles: DestructibleDTO[]): {
    system: BotSystem;
    destructibleQueryRanges: number[];
  } {
    const destructibleQueryRanges: number[] = [];
    const system = {
      worldSnapshot: {
        queryTraps: (_cx: number, _cy: number, _r: number, _cb: (d: unknown) => void) => {},
        queryDestructibles: (
          cx: number,
          cy: number,
          r: number,
          cb: (d: DestructibleDTO) => void,
        ) => {
          destructibleQueryRanges.push(r);
          const r2 = r * r;
          for (const d of destructibles) {
            const dx = d.x - cx;
            const dy = d.y - cy;
            if (dx * dx + dy * dy <= r2) cb(d);
          }
        },
        queryProjectiles: (_cx: number, _cy: number, _r: number, _cb: (d: unknown) => void) => {},
      },
    } as unknown as BotSystem;
    return { system, destructibleQueryRanges };
  }

  function barrelAt(dist: number): DestructibleDTO {
    return { id: `b${dist}`, x: dist, y: 0, type: 'barrel', hp: 1, maxHp: 1, isDestroyed: false };
  }

  const DTO_STUB = {} as PlayerDTO;

  it('a barrel in the 336–456 shell stays present in consecutive hazard views', () => {
    const ctx = new BotContext('bot-hazard-flicker');
    ctx.x = 0;
    ctx.y = 0;
    const { system } = makeRangeHonoringSystem([barrelAt(400)]); // in the shell
    for (let i = 0; i < 3; i++) {
      rescanHazards(system, ctx, DTO_STUB);
      const present = ctx.dangers.some((d) => d.type === 'barrel' && d.x === 400);
      // Pre-fix: rescan radius 336 → the barrel vanishes on every rescan
      // tick and reappears on the next full scan — avoidance flicker.
      expect(present, `rescan #${i}`).toBe(true);
    }
  });

  it('the rescan queries destructibles at the full scan barrel range', () => {
    const ctx = new BotContext('bot-hazard-range');
    ctx.x = 0;
    ctx.y = 0;
    const { system, destructibleQueryRanges } = makeRangeHonoringSystem([]);
    rescanHazards(system, ctx, DTO_STUB);
    // One shared constant: the rescan's destructible query radius must equal
    // the full scan's BARREL_SCAN_RANGE (456). Pre-fix: 336.
    expect(destructibleQueryRanges[0]).toBe(FULL_SCAN_BARREL_RANGE);
  });

  it('barrels beyond the range are still excluded (the range is bounded)', () => {
    const ctx = new BotContext('bot-hazard-bounded');
    ctx.x = 0;
    ctx.y = 0;
    const { system } = makeRangeHonoringSystem([barrelAt(FULL_SCAN_BARREL_RANGE + 60)]);
    rescanHazards(system, ctx, DTO_STUB);
    expect(ctx.dangers).toHaveLength(0);
  });
});
