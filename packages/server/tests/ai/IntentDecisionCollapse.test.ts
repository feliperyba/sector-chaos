import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, BotState, type EnemyInfo, type ItemInfo } from '../../src/ai/BotContext.ts';
import { LootIntent } from '../../src/ai/intent/intentLoot.ts';
import { RetreatAndResetIntent } from '../../src/ai/intent/intentSurvival.ts';
import { loadoutHasRole, weaponRole } from '../../src/ai/BotLoadout.ts';
import {
  distToZoneCenter,
  hpRatio,
  SEEK_HEALTH_HP_PERCENT,
} from '../../src/ai/intent/intentHelpers.ts';
import { KILL_SECURE_ENEMY_HP_PERCENT } from '../../src/ai/BotSystemConstants.ts';
import {
  DISENGAGE_COOLDOWN_TICKS,
  DISENGAGE_SCORE,
  evaluateDisengage,
} from '../../src/ai/combat/DiscretionTables.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
} from '../../src/ai/intent/PersonalityProfile.ts';
import type { IntentContext, Intent } from '../../src/ai/intent/Intent.ts';

/**
 * Ticket 27 — one loot/retreat decision per tick (isValid/score collapse).
 *
 * These tests pin the COLLAPSE CONTRACT (not the tactical scoring values,
 * which are spot-pinned below): the merged decision is computed once per
 * (intent, bot, tick), reused across score()/isValid() in that tick,
 * invalidated at every tick boundary, isolated per bot, isolated per intent,
 * and VALUE-IDENTICAL to a cold (freshly computed) decision.
 *
 * The cold-twin parity cases are the executable form of the mechanical-union
 * proof: a memoized intent and a freshly built context holding the same world
 * data must produce identical (valid, score) every tick.
 */

const PROFILE = new PersonalityProfile(
  PersonalityArchetype.DUELIST,
  { aggression: 0.7, greed: 0.5, caution: 0.4, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);
// Greedy profile: does NOT hit the "don't divert mid-fight" gate (greed >= 0.7).
const GREEDY_PROFILE = new PersonalityProfile(
  PersonalityArchetype.SCAVENGER,
  { aggression: 0.3, greed: 0.9, caution: 0.4, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);

function makeIc(
  ctx: BotContext,
  o: Partial<IntentContext> = {},
  profile: PersonalityProfile = PROFILE,
): IntentContext {
  return {
    ctx,
    profile,
    aliveBotCount: 20,
    enemyInFightRange: false,
    zoneIsLethal: true,
    ...o,
  };
}

/** Deterministic LCG — tests must not use Math.random (repo rule). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function enemy(o: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
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

function item(o: Partial<ItemInfo> = {}): ItemInfo {
  return { id: 'it1', x: 0, y: 0, distance: 100, type: 'powerup', tier: 0, ...o };
}

function makeBot(tick = 0): BotContext {
  const ctx = new BotContext('test-bot');
  ctx.tick = tick;
  ctx.weapons = [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }];
  ctx.activeSlot = 0;
  return ctx;
}

describe('loot/retreat decision collapse — memo contract (ticket 27)', () => {
  it('freezes the decision within a tick: a mid-tick world change must NOT affect later calls', () => {
    // LOOT: no chest at first use → isValid computes and caches valid=false.
    const ctx = makeBot(100);
    const loot = new LootIntent();
    expect(loot.isValid(makeIc(ctx))).toBe(false);

    // A chest "appears" mid-tick (in production nothing does this between
    // select() and execute() — the purity-window proof — but the contract is
    // that the tick's decision is frozen once computed).
    ctx.nearestChest = item({ distance: 200 });
    expect(loot.isValid(makeIc(ctx))).toBe(false);
    expect(loot.score(makeIc(ctx))).toBe(0);

    // Tick boundary invalidates: the next tick sees the chest.
    ctx.tick = 101;
    expect(loot.isValid(makeIc(ctx))).toBe(true);
  });

  it('caches a valid-but-zero-score decision (score gate does not leak into validity)', () => {
    // Mid-fight diversion gate: enemy in range, healthy, non-greedy → score 0
    // while the loot source itself keeps the intent VALID.
    const ctx = makeBot(200);
    ctx.nearestChest = item({ distance: 200 }); // active tier 1 < 2 → valid
    const loot = new LootIntent();
    const ic = makeIc(ctx, { enemyInFightRange: true });
    expect(loot.isValid(ic)).toBe(true);
    expect(loot.score(ic)).toBe(0);
    // Repeated calls in the same tick are idempotent (same frozen decision).
    expect(loot.isValid(ic)).toBe(true);
    expect(loot.score(ic)).toBe(0);
  });

  it('is isolated per bot (per ctx): one bot decision does not leak into another at the same tick', () => {
    const lootA = new LootIntent();
    const lootB = new LootIntent();
    const a = makeBot(300);
    const b = makeBot(300);
    a.nearestChest = item({ distance: 200 });
    expect(lootA.isValid(makeIc(a))).toBe(true);
    expect(lootB.isValid(makeIc(b))).toBe(false);
    // And b later gains its own chest at the SAME tick — still false (b's own
    // decision already computed this tick), true next tick.
    b.nearestChest = item({ distance: 200 });
    expect(lootB.isValid(makeIc(b))).toBe(false);
    b.tick = 301;
    expect(lootB.isValid(makeIc(b))).toBe(true);
  });

  it('is isolated per intent: the LOOT memo key never collides with RETREAT_AND_RESET', () => {
    const ctx = makeBot(400);
    ctx.nearestEnemy = enemy({ health: 100 }); // healthy enemy, kill-secure gate closed
    ctx.health = 10; // r = 0.1 < retreat floor → retreat valid
    const retreat = new RetreatAndResetIntent();
    expect(retreat.isValid(makeIc(ctx))).toBe(true);
    // LOOT must compute its OWN decision at the same tick (no cross-poisoning).
    const loot = new LootIntent();
    expect(loot.isValid(makeIc(ctx))).toBe(false);
    expect(retreat.isValid(makeIc(ctx))).toBe(true);
  });

  it('retreat decision is frozen within a tick and recomputed at the boundary', () => {
    const ctx = makeBot(500);
    ctx.health = 100;
    const retreat = new RetreatAndResetIntent();
    expect(retreat.isValid(makeIc(ctx))).toBe(false); // no enemy
    ctx.nearestEnemy = enemy({ health: 100 });
    expect(retreat.isValid(makeIc(ctx))).toBe(false); // frozen: no enemy at compute time
    ctx.tick = 501;
    expect(retreat.isValid(makeIc(ctx))).toBe(false); // r=1.0 > floor, not in outer ring
    ctx.health = 10;
    ctx.tick = 502;
    expect(retreat.isValid(makeIc(ctx))).toBe(true); // r=0.1 below floor
  });
});

describe('decision collapse — mechanical-union spot pins (thresholds unchanged)', () => {
  it('LOOT: barrier close grab scores 0.85 base, greed-weighted', () => {
    const ctx = makeBot(600);
    ctx.health = 90; // healthy — exercises the non-lowHp path
    ctx.nearestBarrier = item({ distance: 150 }); // < 180 close
    const loot = new LootIntent();
    // 0.85 * (0.55 + 0.5*0.6) = 0.85 * 0.85
    expect(loot.score(makeIc(ctx))).toBeCloseTo(0.85 * 0.85, 12);
    expect(loot.isValid(makeIc(ctx))).toBe(true);
  });

  it('LOOT: endgame heal uses the 0.85 threshold + 1600 search radius', () => {
    const ctx = makeBot(610);
    ctx.health = 80; // r = 0.8 — below endgame threshold 0.85, above normal 0.6
    ctx.nearestHealth = item({ distance: 1200 }); // beyond normal 1000, inside 1600
    const loot = new LootIntent();
    // Not endgame (20 alive): invalid + 0.
    expect(loot.isValid(makeIc(ctx, { aliveBotCount: 20 }))).toBe(false);
    expect(loot.score(makeIc(ctx, { aliveBotCount: 20 }))).toBe(0);
    // Endgame (8 alive): 0.4 + (1-0.8)*0.4 = 0.48 base, × (0.55+0.5*0.6)=0.85.
    expect(loot.isValid(makeIc(ctx, { aliveBotCount: 8 }))).toBe(true);
    expect(loot.score(makeIc(ctx, { aliveBotCount: 8 }))).toBeCloseTo(0.48 * 0.85, 12);
  });

  it('LOOT: chest at tier<2 is valid at up to 1100px; tier>=2 only under 500px', () => {
    const ctx = makeBot(620);
    ctx.nearestChest = item({ distance: 1000 });
    const loot = new LootIntent();
    expect(loot.isValid(makeIc(ctx))).toBe(true); // active tier 1 < 2
    expect(loot.score(makeIc(ctx))).toBeCloseTo(0.7 * 0.85, 12);
    // Fresh bot (fresh tick) for the tier-2 loadout — the decision is frozen
    // per tick, and the loadout cannot change within one.
    const t2 = makeBot(621);
    t2.weapons = [{ weaponType: WeaponType.DAGGER, tier: 2, durability: 10, ammo: 10 }];
    t2.nearestChest = item({ distance: 600 });
    expect(loot.isValid(makeIc(t2))).toBe(false); // tier 2, chest not under 500
    t2.nearestChest = item({ distance: 400 });
    expect(loot.isValid(makeIc(t2))).toBe(false); // frozen at 600 from the line above
    const t3 = makeBot(622);
    t3.weapons = [{ weaponType: WeaponType.DAGGER, tier: 2, durability: 10, ammo: 10 }];
    t3.nearestChest = item({ distance: 400 });
    expect(loot.isValid(makeIc(t3))).toBe(true);
    expect(loot.score(makeIc(t3))).toBeCloseTo(0.45 * 0.85, 12);
  });

  it('LOOT: greedy bots divert mid-fight, non-greedy healthy bots do not (score-only gate)', () => {
    const ctx = makeBot(630);
    ctx.nearestBarrier = item({ distance: 150 });
    const loot = new LootIntent();
    const ic = makeIc(ctx, { enemyInFightRange: true });
    expect(loot.score(ic)).toBe(0); // greed 0.5 < 0.7, healthy
    expect(loot.score(makeIc(ctx, { enemyInFightRange: true }, GREEDY_PROFILE))).toBeCloseTo(
      0.85 * (0.55 + 0.9 * 0.6),
      12,
    );
  });

  it('RETREAT: below-floor danger curve and the deep-outer-ring valid-but-zero quirk', () => {
    const ctx = makeBot(640);
    ctx.nearestEnemy = enemy({ health: 50, maxHealth: 100 }); // 0.5 >= 0.15 kill-secure gate
    ctx.health = 5; // r = 0.05; floor = 0.1 + 0.4*0.16 - 0.7*0.05 = 0.129
    const retreat = new RetreatAndResetIntent();
    expect(retreat.isValid(makeIc(ctx))).toBe(true);
    // danger = (0.129-0.05)/0.129; score = 0.5 + danger*0.5 — but ticket 09's
    // discretion fold (DEC-010.3) floors it: r=0.05 < DUELIST's hpFloor 0.2
    // fires the 'hp' cause, and score = max(danger, DISENGAGE_SCORE.hp).
    expect(retreat.score(makeIc(ctx))).toBeCloseTo(
      Math.max(0.5 + ((0.129 - 0.05) / 0.129) * 0.5, DISENGAGE_SCORE.hp),
      12,
    );

    // Quirk pinned: r above the floor but < 0.4 + deep outer ring → VALID with
    // score 0 (validity and score are independent views).
    const ring = makeBot(641);
    ring.nearestEnemy = enemy({ health: 50, maxHealth: 100 });
    ring.health = 30; // r = 0.3 > floor 0.129
    ring.zoneRadius = 1000;
    ring.x = 900;
    ring.y = 0; // dist 900 > 0.85 * 1000
    expect(retreat.isValid(makeIc(ring))).toBe(true);
    expect(retreat.score(makeIc(ring))).toBe(0);

    // Kill-secureable enemy → invalid regardless of own HP (fresh tick — the
    // decision is frozen per tick).
    const secure = makeBot(642);
    secure.health = 5;
    secure.nearestEnemy = enemy({ health: 10, maxHealth: 100 });
    expect(retreat.isValid(makeIc(secure))).toBe(false);
    expect(retreat.score(makeIc(secure))).toBe(0);
  });
});

/** Snapshot everything the two intents' score/isValid/execute read. */
type World = {
  health: number;
  selfBarrierActive: boolean;
  nearestEnemy: EnemyInfo | null;
  nearestBarrier: ItemInfo | null;
  nearestSpeedBoost: ItemInfo | null;
  nearestHealth: ItemInfo | null;
  nearestWeapon: ItemInfo | null;
  nearestChest: ItemInfo | null;
  weapons: BotContext['weapons'];
  zoneRadius: number;
  x: number;
  y: number;
  aliveBotCount: number;
  enemyInFightRange: boolean;
  greed: number;
  caution: number;
  aggression: number;
};

function buildWorld(rand: () => number): World {
  const weaponTypes = [
    WeaponType.DAGGER, // melee (ARC)
    WeaponType.SHORT_BOW, // ranged (RANGED, no meleeStats)
    WeaponType.THROWING_AXE, // THROWN base but meleeStats → classifies melee
  ];
  const weapons: BotContext['weapons'] = [null, null, null, null].map((_, i) => {
    if (i === 0) {
      return { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 };
    }
    if (rand() < 0.4) return null;
    return {
      weaponType: weaponTypes[Math.floor(rand() * weaponTypes.length)]!,
      tier: Math.floor(rand() * 4),
      durability: Math.floor(rand() * 10) + 1,
      ammo: Math.floor(rand() * 10),
    };
  });
  const maybeItem = (p: number, weapon?: boolean): ItemInfo | null =>
    rand() < p
      ? item({
          distance: Math.floor(rand() * 2000),
          tier: Math.floor(rand() * 4),
          type: weapon ? 'weapon' : 'powerup',
          weaponType: weapon ? weaponTypes[Math.floor(rand() * weaponTypes.length)] : undefined,
        })
      : null;
  return {
    health: Math.floor(rand() * 101),
    selfBarrierActive: rand() < 0.2,
    nearestEnemy:
      rand() < 0.6
        ? enemy({
            health: Math.floor(rand() * 101),
            maxHealth: 100,
            distance: Math.floor(rand() * 1500),
          })
        : null,
    nearestBarrier: maybeItem(0.3),
    nearestSpeedBoost: maybeItem(0.3),
    nearestHealth: maybeItem(0.3),
    nearestWeapon: maybeItem(0.5, true),
    nearestChest: maybeItem(0.3),
    weapons,
    zoneRadius: rand() < 0.2 ? 0 : 500 + Math.floor(rand() * 1500),
    x: Math.floor(rand() * 2000 - 1000),
    y: Math.floor(rand() * 2000 - 1000),
    aliveBotCount: [0, 5, 8, 9, 20][Math.floor(rand() * 5)]!,
    enemyInFightRange: rand() < 0.4,
    greed: Math.floor(rand() * 101) / 100,
    caution: Math.floor(rand() * 101) / 100,
    aggression: Math.floor(rand() * 101) / 100,
  };
}

function cloneWorld(w: World): World {
  return {
    ...w,
    nearestEnemy: w.nearestEnemy ? enemy({ ...w.nearestEnemy }) : null,
    nearestBarrier: w.nearestBarrier ? item({ ...w.nearestBarrier }) : null,
    nearestSpeedBoost: w.nearestSpeedBoost ? item({ ...w.nearestSpeedBoost }) : null,
    nearestHealth: w.nearestHealth ? item({ ...w.nearestHealth }) : null,
    nearestWeapon: w.nearestWeapon ? item({ ...w.nearestWeapon }) : null,
    nearestChest: w.nearestChest ? item({ ...w.nearestChest }) : null,
    weapons: w.weapons.map((slot) => (slot ? { ...slot } : null)),
  };
}

function applyWorld(ctx: BotContext, w: World): void {
  ctx.health = w.health;
  ctx.selfBarrierActive = w.selfBarrierActive;
  ctx.nearestEnemy = w.nearestEnemy;
  ctx.nearestBarrier = w.nearestBarrier;
  ctx.nearestSpeedBoost = w.nearestSpeedBoost;
  ctx.nearestHealth = w.nearestHealth;
  ctx.nearestWeapon = w.nearestWeapon;
  ctx.nearestChest = w.nearestChest;
  ctx.weapons = w.weapons;
  ctx.zoneRadius = w.zoneRadius;
  ctx.zoneCenterX = 0;
  ctx.zoneCenterY = 0;
  ctx.x = w.x;
  ctx.y = w.y;
}

function profileOf(w: World): PersonalityProfile {
  return new PersonalityProfile(
    PersonalityArchetype.DUELIST,
    {
      aggression: w.aggression,
      greed: w.greed,
      caution: w.caution,
      opportunism: 0.5,
      trapper: 0.5,
    },
    { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
  );
}

describe('decision collapse parity vs cold computation (ticket 27)', () => {
  /** Run the full selector-shaped call sequence (isValid → score → commitTicks
   *  → execute) against one ctx. The SECOND ctx is "cold" — a fresh object
   *  with identical data — so its memo AND role cache are empty: any decision
   *  difference means the collapse changed behavior. */
  function runIntentSequence(intent: Intent, ctx: BotContext, w: World): unknown[] {
    applyWorld(ctx, w);
    const ic = makeIc(
      ctx,
      {
        aliveBotCount: w.aliveBotCount,
        enemyInFightRange: w.enemyInFightRange,
      },
      profileOf(w),
    );
    const out: unknown[] = [intent.isValid(ic), intent.score(ic), intent.commitTicks(ic)];
    out.push(intent.execute(ic).nextState);
    // Second pass in the same tick (the selector calls isValid+score in both
    // its preempt loop and its re-score loop) — must return the frozen values.
    out.push(intent.isValid(ic), intent.score(ic));
    return out;
  }

  it('memoized decisions are identical to cold-computed decisions across randomized worlds', () => {
    const rand = lcg(20260815);
    const intents: Array<() => Intent> = [
      () => new LootIntent(),
      () => new RetreatAndResetIntent(),
    ];
    for (let iter = 0; iter < 500; iter++) {
      const tick = 1000 + iter;
      const world = buildWorld(rand);
      for (const makeIntent of intents) {
        // Warm ctx: memo + role cache may be populated from this same tick's
        // earlier calls; cold ctx: fresh object, empty caches, identical data.
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
    const rand = lcg(888);
    const world = buildWorld(rand);
    const ctx = makeBot(7000);
    const loot = new LootIntent();
    const first = runIntentSequence(loot, ctx, world);
    const second = runIntentSequence(loot, ctx, world);
    expect(second).toEqual(first);
  });
});

describe('loadoutHasRole per-tick cache (ticket 27)', () => {
  // SHORT_BOW is the ranged-role weapon here: resolveAttackType prefers
  // meleeStats, and THROWING_AXE HAS meleeStats (ARC), so it classifies as
  // 'melee' despite its THROWN base attack. Only pure-RANGED definitions
  // (SHORT_BOW/CROSSBOW) cover the 'ranged' role.
  it('freezes the loadout classification within a tick, recomputes at the boundary', () => {
    const ctx = makeBot(800);
    ctx.weapons = [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }];
    expect(loadoutHasRole(ctx, 'melee')).toBe(true);
    expect(loadoutHasRole(ctx, 'ranged')).toBe(false);

    // Out-of-window mutation (never happens in the real AI phase — inputs are
    // applied after the whole bot pass): the tick's classification is frozen.
    ctx.weapons = [{ weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 10, ammo: 10 }];
    expect(loadoutHasRole(ctx, 'melee')).toBe(true); // frozen
    expect(loadoutHasRole(ctx, 'ranged')).toBe(false); // frozen

    // Tick boundary invalidates.
    ctx.tick = 801;
    expect(loadoutHasRole(ctx, 'melee')).toBe(false);
    expect(loadoutHasRole(ctx, 'ranged')).toBe(true);
  });

  it('is isolated per bot (per ctx)', () => {
    const a = makeBot(900);
    const b = makeBot(900);
    a.weapons = [{ weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 10, ammo: 10 }];
    expect(loadoutHasRole(a, 'ranged')).toBe(true);
    expect(loadoutHasRole(b, 'ranged')).toBe(false); // b: melee-only loadout
    expect(loadoutHasRole(b, 'melee')).toBe(true);
  });

  it('skips broken (ammo 0) and FISTS weapons exactly like the uncached check', () => {
    const ctx = makeBot(910);
    ctx.weapons = [
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 0 }, // broken melee
      null,
      { weaponType: WeaponType.SHORT_BOW, tier: 1, durability: 10, ammo: 3 }, // live ranged
    ];
    expect(loadoutHasRole(ctx, 'melee')).toBe(false); // broken melee does not cover
    expect(loadoutHasRole(ctx, 'ranged')).toBe(true);
  });
});

// ---------- Frozen pre-refactor reference (the mechanical-union oracle) ----------
//
// VERBATIM copies of the pre-ticket-27 LootIntent/RetreatAndResetIntent
// score+isValid bodies (methods → free functions; `this.isValid` → the local
// function). They are intentionally NOT refactored — any drift between the
// collapsed single-pass decision and these originals must show up as a test
// failure. This is the executable form of the mechanical-union table.

function legacyLootScore(ic: IntentContext): number {
  const ctx = ic.ctx;
  if (!legacyLootIsValid(ic)) return 0;
  const r = hpRatio(ctx);
  const lowHp = r < 0.4;
  if (ic.enemyInFightRange && !lowHp && ic.profile.greed < 0.7) return 0;
  let best = 0;
  if (ctx.nearestBarrier && !ctx.selfBarrierActive) {
    const close = ctx.nearestBarrier.distance < 180;
    const lowHpGrab = r < 0.5 && ctx.nearestBarrier.distance < 600;
    const preFight =
      ctx.nearestEnemy && ctx.nearestEnemy.distance < 700 && ctx.nearestBarrier.distance < 450;
    if (close) {
      best = Math.max(best, 0.85);
    } else if (lowHpGrab || preFight) {
      best = Math.max(best, 0.8);
    }
  }
  if (ctx.nearestSpeedBoost) {
    const close = ctx.nearestSpeedBoost.distance < 160;
    const chase =
      ctx.nearestEnemy &&
      ctx.nearestEnemy.distance > 350 &&
      ctx.nearestEnemy.distance < 900 &&
      ctx.nearestSpeedBoost.distance < 300;
    const escape = r < 0.3 && ctx.nearestSpeedBoost.distance < 350;
    if (close || chase || escape) best = Math.max(best, 0.6);
  }
  const endgame = ic.aliveBotCount > 0 && ic.aliveBotCount <= 8;
  const healThreshold = endgame ? 0.85 : SEEK_HEALTH_HP_PERCENT;
  const healSearchDist = endgame ? 1600 : 1000;
  if (ctx.nearestHealth && r < healThreshold && ctx.nearestHealth.distance < healSearchDist) {
    const need = 1 - r;
    best = Math.max(best, 0.4 + need * 0.4);
  }
  const upgradeDist = endgame ? 900 : 600;
  if (
    ctx.nearestWeapon &&
    ctx.nearestWeapon.tier > ctx.getActiveWeapon().tier &&
    ctx.nearestWeapon.distance < upgradeDist
  ) {
    const tierGain = (ctx.nearestWeapon.tier - ctx.getActiveWeapon().tier) / 3;
    best = Math.max(best, 0.4 + tierGain * 0.3);
  }
  if (ctx.nearestWeapon && ctx.nearestWeapon.weaponType !== undefined) {
    const floorRole = weaponRole(ctx.nearestWeapon.weaponType);
    if (floorRole && !loadoutHasRole(ctx, floorRole)) {
      const roleDist = endgame ? 700 : 450;
      if (ctx.nearestWeapon.distance < roleDist) {
        best = Math.max(best, 0.35);
      }
    }
  }
  if (
    endgame &&
    ctx.nearestWeapon &&
    ctx.getActiveWeapon().ammo > 0 &&
    ctx.getActiveWeapon().ammo < 3 &&
    ctx.nearestWeapon.distance < 500
  ) {
    best = Math.max(best, 0.7);
  }
  if (ctx.nearestChest && ctx.nearestChest.distance < 1100) {
    const activeTier = ctx.getActiveWeapon().tier;
    if (activeTier < 2) {
      best = Math.max(best, 0.7);
    } else if (ctx.nearestChest.distance < 500) {
      best = Math.max(best, 0.45);
    }
  }
  if (best <= 0) return 0;
  return Math.min(1, best * (0.55 + ic.profile.greed * 0.6));
}

function legacyLootIsValid(ic: IntentContext): boolean {
  const ctx = ic.ctx;
  const r = hpRatio(ctx);
  const endgame = ic.aliveBotCount > 0 && ic.aliveBotCount <= 8;
  const healThreshold = endgame ? 0.85 : SEEK_HEALTH_HP_PERCENT;
  const healSearchDist = endgame ? 1600 : 1000;
  const upgradeDist = endgame ? 900 : 600;
  const anything =
    (ctx.nearestBarrier &&
      !ctx.selfBarrierActive &&
      (ctx.nearestBarrier.distance < 180 ||
        (r < 0.5 && ctx.nearestBarrier.distance < 600) ||
        (ctx.nearestEnemy &&
          ctx.nearestEnemy.distance < 700 &&
          ctx.nearestBarrier.distance < 450))) ||
    (ctx.nearestSpeedBoost &&
      (ctx.nearestSpeedBoost.distance < 160 ||
        (ctx.nearestEnemy &&
          ctx.nearestEnemy.distance > 350 &&
          ctx.nearestEnemy.distance < 900 &&
          ctx.nearestSpeedBoost.distance < 300) ||
        (r < 0.3 && ctx.nearestSpeedBoost.distance < 350))) ||
    (ctx.nearestHealth && r < healThreshold && ctx.nearestHealth.distance < healSearchDist) ||
    (ctx.nearestWeapon &&
      ctx.nearestWeapon.tier > ctx.getActiveWeapon().tier &&
      ctx.nearestWeapon.distance < upgradeDist) ||
    (ctx.nearestWeapon &&
      ctx.nearestWeapon.weaponType !== undefined &&
      weaponRole(ctx.nearestWeapon.weaponType) !== undefined &&
      !loadoutHasRole(ctx, weaponRole(ctx.nearestWeapon.weaponType)!) &&
      ctx.nearestWeapon.distance < (endgame ? 700 : 450)) ||
    (endgame &&
      ctx.nearestWeapon &&
      ctx.getActiveWeapon().ammo > 0 &&
      ctx.getActiveWeapon().ammo < 3 &&
      ctx.nearestWeapon.distance < 500) ||
    (ctx.nearestChest &&
      ctx.nearestChest.distance < 1100 &&
      (ctx.getActiveWeapon().tier < 2 || ctx.nearestChest.distance < 500));
  return Boolean(anything);
}

// Ticket 09 (DEC-010.3) folded the engagement-discretion triggers + the
// hold clause into the retreat decision AFTER ticket 27 froze this reference.
// The reference mirrors the CURRENT canonical composition — the cause comes
// from the same shared evaluator the intent uses, so the parity check below
// stays a MEMOIZATION/collapse proof (memoized == uncached), not a stale-
// semantics proof. The fold's own behavior is pinned in IntentDiscretion.
function referenceRetreatDecision(ic: IntentContext): { valid: boolean; score: number } {
  const ctx = ic.ctx;
  if (!ctx.nearestEnemy) return { valid: false, score: 0 };
  const enemyHpRatio = ctx.nearestEnemy.health / ctx.nearestEnemy.maxHealth;
  if (enemyHpRatio < KILL_SECURE_ENEMY_HP_PERCENT) return { valid: false, score: 0 };
  const r = hpRatio(ctx);
  const retreatFloor = 0.1 + ic.profile.caution * 0.16 - ic.profile.aggression * 0.05;
  let valid: boolean;
  if (r < retreatFloor) {
    valid = true;
  } else {
    const deepOuterRing = ctx.zoneRadius > 0 && distToZoneCenter(ctx) > ctx.zoneRadius * 0.85;
    valid = r < 0.4 && deepOuterRing;
  }
  const danger = r < retreatFloor ? (retreatFloor - r) / retreatFloor : 0;
  const legacyDanger = r < retreatFloor ? Math.min(1, 0.5 + danger * 0.5) : 0;
  const cause = evaluateDisengage(ctx, ic.stimulusScan, ic.profile);
  if (cause) return { valid: true, score: Math.max(legacyDanger, DISENGAGE_SCORE[cause]!) };
  const c = ctx.combat;
  if (
    c &&
    ctx.state === BotState.RETREAT &&
    ctx.tick - c.lastDisengageTick < DISENGAGE_COOLDOWN_TICKS
  ) {
    return { valid: true, score: 0.6 };
  }
  if (r > retreatFloor) return { valid, score: 0 };
  return { valid, score: legacyDanger };
}

function referenceRetreatScore(ic: IntentContext): number {
  return referenceRetreatDecision(ic).score;
}

function referenceRetreatIsValid(ic: IntentContext): boolean {
  return referenceRetreatDecision(ic).valid;
}

describe('decision collapse parity vs the reference implementations (memoization proof)', () => {
  it('randomized worlds: collapsed (memoized) decisions are exactly the reference decisions', () => {
    const rand = lcg(424242);
    const loot = new LootIntent();
    const retreat = new RetreatAndResetIntent();
    for (let iter = 0; iter < 1000; iter++) {
      const world = buildWorld(rand);
      // Fresh ctx (cold memo + role cache) per iteration; the reference
      // functions are stateless so they can share the same world objects.
      const ctx = makeBot(20000 + iter);
      applyWorld(ctx, world);
      const ic = makeIc(
        ctx,
        { aliveBotCount: world.aliveBotCount, enemyInFightRange: world.enemyInFightRange },
        profileOf(world),
      );
      expect(loot.isValid(ic)).toBe(legacyLootIsValid(ic));
      expect(loot.score(ic)).toBe(legacyLootScore(ic));
      expect(retreat.isValid(ic)).toBe(referenceRetreatIsValid(ic));
      expect(retreat.score(ic)).toBe(referenceRetreatScore(ic));
      // Warm second pass within the tick (selector's preempt loop + re-score
      // loop both call isValid+score) — must stay equal to the reference values.
      expect(loot.score(ic)).toBe(legacyLootScore(ic));
      expect(retreat.isValid(ic)).toBe(referenceRetreatIsValid(ic));
    }
  });
});
