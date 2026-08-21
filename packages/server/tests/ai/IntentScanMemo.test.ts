import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, type EnemyInfo, type ItemInfo, type HotBarrelInfo } from '../../src/ai/BotContext.ts';
import { BotState } from '../../src/ai/BotContextTypes.ts';
import {
  HuntVulnerableIntent,
  BarrelTrapIntent,
  ContestLootIntent,
} from '../../src/ai/intent/intentEngage.ts';
import { PersonalityProfile, PersonalityArchetype } from '../../src/ai/intent/PersonalityProfile.ts';
import type { IntentContext, Intent } from '../../src/ai/intent/Intent.ts';

/**
 * Ticket 26 — per-(bot, tick) memoization of the engage-family inner scans.
 *
 * These tests pin the MEMO CONTRACT (not the tactical scoring, which is pinned
 * elsewhere): computed once per (intent, bot, tick), reused across score()/
 * isValid()/execute() in that tick, invalidated at every tick boundary,
 * isolated per bot, and VALUE-IDENTICAL to a cold (freshly computed) scan.
 *
 * The cold-twin parity cases are the executable form of the read-set proof in
 * intentEngage.ts: a memoized intent and a freshly built context holding the
 * same world data must produce identical decisions every tick.
 */

const PROFILE = new PersonalityProfile(
  PersonalityArchetype.DUELIST,
  { aggression: 0.7, greed: 0.5, caution: 0.4, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);

function makeIc(ctx: BotContext): IntentContext {
  return { ctx, profile: PROFILE, aliveBotCount: 20, enemyInFightRange: false, zoneIsLethal: true };
}

/** Deterministic LCG — tests must not use Math.random (repo rule). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function enemy(i: number, o: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: `e${i}`,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 100,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.FISTS,
    weaponTier: 0,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    facingAngle: 0,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...o,
  };
}

/** Armed bot with a THROWING_AXE (baseStats.range 800 — covers barrel traps). */
function makeBot(tick = 0): BotContext {
  const ctx = new BotContext('test-bot');
  ctx.tick = tick;
  ctx.weapons = [{ weaponType: WeaponType.THROWING_AXE, tier: 2, durability: 10, ammo: 10 }];
  ctx.activeSlot = 0;
  return ctx;
}

/** Barrel eligible for BARREL_TRAP: outside blast+margin (>=376) and inside
 *  THROWING_AXE range * 0.95 (<=760). */
function hotBarrel(distance: number, o: Partial<HotBarrelInfo> = {}): HotBarrelInfo {
  return { x: distance, y: 0, distance, ...o };
}

describe('engage-intent scan memo (ticket 26)', () => {
  it('runs the scan once per tick: a mid-tick world change must NOT affect later calls in the same tick', () => {
    // BARREL_TRAP: no hot barrels at first use → isValid computes and caches
    // null for this tick.
    const ctx = makeBot(100);
    const intent = new BarrelTrapIntent();
    expect(intent.isValid(makeIc(ctx))).toBe(false);

    // A barrel "appears" mid-tick (in production nothing does this between
    // select() and execute() — the read-set proof — but the memo contract is
    // that the tick's result is frozen once computed).
    ctx.hotBarrels.push(hotBarrel(500));
    expect(intent.isValid(makeIc(ctx))).toBe(false);

    // Tick boundary invalidates: the next tick sees the barrel.
    ctx.tick = 101;
    expect(intent.isValid(makeIc(ctx))).toBe(true);
  });

  it('caches a null result exactly once per tick (distinguishes computed-null from not-computed)', () => {
    // HUNT_VULNERABLE with an armed bot but no vulnerable enemy: null result
    // must be cached as COMPUTED (not re-derived into a hit mid-tick).
    const ctx = makeBot(200);
    const intent = new HuntVulnerableIntent();
    expect(intent.isValid(makeIc(ctx))).toBe(false);
    // Mid-tick insertion of a highly vulnerable looter stays invisible this
    // tick (frozen), visible next tick (invalidation).
    ctx.enemies.push(enemy(1, { isLooting: true, distance: 200 }));
    expect(intent.isValid(makeIc(ctx))).toBe(false);
    ctx.tick = 201;
    expect(intent.isValid(makeIc(ctx))).toBe(true);
  });

  it('is isolated per bot (per ctx): one bot memo does not leak into another at the same tick', () => {
    const barrelIntentA = new BarrelTrapIntent();
    const barrelIntentB = new BarrelTrapIntent();
    const a = makeBot(300);
    const b = makeBot(300);
    a.hotBarrels.push(hotBarrel(500));
    expect(barrelIntentA.isValid(makeIc(a))).toBe(true);
    expect(barrelIntentB.isValid(makeIc(b))).toBe(false);
    // And b later gains its own barrel at the SAME tick — still false (b's own
    // memo already computed null this tick), true next tick.
    b.hotBarrels.push(hotBarrel(600));
    expect(barrelIntentB.isValid(makeIc(b))).toBe(false);
    b.tick = 301;
    expect(barrelIntentB.isValid(makeIc(b))).toBe(true);
  });

  it('execute() reads the same memoized value the selector scored with (same object identity semantics)', () => {
    // HUNT_VULNERABLE: execute must lock the target the scan selected at the
    // start of the tick even after later (out-of-window) perception changes.
    const ctx = makeBot(400);
    ctx.enemies.push(enemy(1, { isLooting: true, distance: 300 })); // the prey
    const intent = new HuntVulnerableIntent();
    const ic = makeIc(ctx);
    expect(intent.score(ic)).toBeGreaterThan(0);
    // Out-of-window mutation (never happens in the real select→execute path).
    ctx.enemies.length = 0;
    const res = intent.execute(ic);
    expect(res.nextState).toBe(BotState.ENGAGE);
    expect(ctx.targetId).toBe('e1'); // frozen with the tick's scan result
  });
});

describe('engage-intent memo parity vs cold computation (ticket 26)', () => {
  /** Snapshot everything the three intents' score/isValid/execute read/write. */
  type World = {
    enemies: EnemyInfo[];
    items: ItemInfo[];
    hotBarrels: HotBarrelInfo[];
  };

  function buildWorld(rand: () => number, tick: number): World {
    const enemies: EnemyInfo[] = [];
    const nEnemies = Math.floor(rand() * 6);
    for (let i = 0; i < nEnemies; i++) {
      enemies.push(
        enemy(i, {
          isLooting: rand() < 0.3,
          barrierActive: rand() < 0.2,
          isFreshSpawn: rand() < 0.2,
          spawnInvulnTicksLeft: Math.floor(rand() * 12),
          engagedTargetId: rand() < 0.3 ? 'other' : null,
          health: Math.floor(rand() * 100),
          maxHealth: 100,
          weaponType: rand() < 0.5 ? WeaponType.FISTS : WeaponType.DAGGER,
          weaponTier: Math.floor(rand() * 4),
          distance: Math.floor(rand() * 2000),
          x: Math.floor(rand() * 2000 - 1000),
          y: Math.floor(rand() * 2000 - 1000),
          lastAttackTick: tick - Math.floor(rand() * 120),
        }),
      );
    }
    const items: ItemInfo[] = [];
    const nItems = Math.floor(rand() * 6);
    for (let i = 0; i < nItems; i++) {
      const isWeapon = rand() < 0.5;
      items.push({
        id: `it${i}`,
        x: Math.floor(rand() * 1400 - 700),
        y: Math.floor(rand() * 1400 - 700),
        distance: Math.floor(rand() * 1400),
        type: isWeapon ? 'weapon' : 'powerup',
        tier: isWeapon ? Math.floor(rand() * 4) : rand() < 0.5 ? 5 : 0,
      });
    }
    const hotBarrels: HotBarrelInfo[] = [];
    const nBarrels = Math.floor(rand() * 4);
    for (let i = 0; i < nBarrels; i++) {
      hotBarrels.push(hotBarrel(Math.floor(rand() * 1000), {
        x: Math.floor(rand() * 1000 - 500),
        y: Math.floor(rand() * 1000 - 500),
      }));
    }
    return { enemies, items, hotBarrels };
  }

  function cloneWorld(w: World): World {
    return {
      enemies: w.enemies.map((e) => ({ ...e })),
      items: w.items.map((i) => ({ ...i })),
      hotBarrels: w.hotBarrels.map((b) => ({ ...b })),
    };
  }

  /** Run the full selector-shaped call sequence (isValid → score → execute)
   *  against one ctx. The SECOND ctx is "cold" — a fresh object with identical
   *  data — so its memo is empty: any decision difference means the memo
   *  changed behavior. */
  function runIntentSequence(intent: Intent, ctx: BotContext, w: World): unknown[] {
    ctx.enemies = w.enemies;
    ctx.items = w.items;
    ctx.hotBarrels = w.hotBarrels;
    const ic = makeIc(ctx);
    const out: unknown[] = [intent.isValid(ic), intent.score(ic), intent.commitTicks(ic)];
    const exec = intent.execute(ic);
    out.push(exec.nextState);
    out.push({
      targetId: ctx.targetId,
      targetLockTick: ctx.targetLockTick,
      engageStartTick: ctx.engageStartTick,
      engageStartDist: ctx.engageStartDist,
      demolitionTargetX: ctx.demolitionTargetX,
      demolitionTargetY: ctx.demolitionTargetY,
      demolitionGridX: ctx.demolitionGridX,
      demolitionGridY: ctx.demolitionGridY,
      preDemolitionState: ctx.preDemolitionState,
    });
    return out;
  }

  it('memoized decisions are identical to cold-computed decisions across randomized worlds', () => {
    const rand = lcg(20260814);
    const intents: Array<() => Intent> = [
      () => new HuntVulnerableIntent(),
      () => new BarrelTrapIntent(),
      () => new ContestLootIntent(),
    ];
    for (let iter = 0; iter < 500; iter++) {
      const tick = 1000 + iter;
      const world = buildWorld(rand, tick);
      for (const makeIntent of intents) {
        // Warm ctx: the memo may be populated from this same tick's earlier
        // calls; cold ctx: fresh object, empty memo, identical data.
        const warm = makeBot(tick);
        const cold = makeBot(tick);
        const warmWorld = world; // used first (populates the memo)
        const coldWorld = cloneWorld(world); // structurally identical
        const a = runIntentSequence(makeIntent(), warm, warmWorld);
        const b = runIntentSequence(makeIntent(), cold, coldWorld);
        expect(a).toEqual(b);
      }
    }
  });

  it('re-running the whole sequence on the warm ctx within one tick returns the frozen decisions', () => {
    // Same tick, same data → identical results (idempotent within the tick).
    const rand = lcg(777);
    const world = buildWorld(rand, 5000);
    const ctx = makeBot(5000);
    const intent = new BarrelTrapIntent();
    const first = runIntentSequence(intent, ctx, world);
    const second = runIntentSequence(intent, ctx, world);
    expect(second).toEqual(first);
  });
});
