import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotState, type BotContext, type EnemyInfo } from '../../../src/ai/BotContext.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
} from '../../../src/ai/intent/PersonalityProfile.ts';
import type { IntentContext } from '../../../src/ai/intent/Intent.ts';
import { DuelIntent, HuntVulnerableIntent } from '../../../src/ai/intent/intentEngage.ts';
import {
  ArmUpIntent,
  HuntIntent,
  SurviveZoneIntent,
} from '../../../src/ai/intent/intentSurvival.ts';
import { LootIntent } from '../../../src/ai/intent/intentLoot.ts';
import {
  applyArcMod,
  arcModFor,
  computeMatchArc,
  IDENTITY_MATCH_ARC,
  matchArcBandFor,
} from '../../../src/ai/arc/MatchArc.ts';
import {
  ARCHETYPE_ARC_SLOPES,
  EARLY_BAND_ALIVE_RATIO_ABOVE,
  GDD_PHASE_WEIGHTS,
  LATE_BAND_ALIVE_RATIO_BELOW,
} from '../../../src/ai/arc/MatchArcTables.ts';
import { scoreMacroGoals, stableAngleRad } from '../../../src/ai/goal/GoalScoring.ts';
import { travelTicksEstimate } from '../../../src/ai/goal/ZoneTiming.ts';
import { ARCHETYPE_GOAL_PROFILES } from '../../../src/ai/goal/GoalTables.ts';
import type { MacroGoalInputs } from '../../../src/ai/goal/GoalTypes.ts';

/**
 * Match arc (bot-ai-v2 ticket 10, DEC-011) — the GDD §14.3 phase-weight
 * table applied as intent-family score multipliers.
 *
 * Three assertion families:
 *  1. The GDD table VERBATIM (band edges AND multiplier values are business
 *     rules — pins the data module against accidental tuning).
 *  2. The per-archetype slope shapes (AGGRESSOR's early combatMod stays high;
 *     SURVIVOR's late combatMod stays bounded — the Viktor/Marcus dissent
 *     obligations).
 *  3. The application seams (intent-family scores + the PRE_POSITION rotation
 *     margins), including the identity default that keeps every pre-arc suite
 *     green: an absent arc is the mid band (no shaping), the same optionality
 *     pattern as IntentContext.pathfinder/stimulusScan.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 63-player lobby arcs (the bench configuration). */
const EARLY = computeMatchArc(40, 63); // 63.5% alive
const MID = computeMatchArc(20, 63); // 31.7% alive
const LATE = computeMatchArc(10, 63); // 15.9% alive

function profile(archetype: PersonalityArchetype, aggression = 0.7): PersonalityProfile {
  return new PersonalityProfile(
    archetype,
    { aggression, greed: 0.5, caution: 0.4, opportunism: 0.5, trapper: 0.3 },
    { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
  );
}

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    tick: 1000,
    x: 0,
    y: 0,
    health: 100,
    maxHealth: 100,
    weapons: [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }],
    activeSlot: 0,
    nearestEnemy: null,
    nearestHealth: null,
    nearestBarrier: null,
    nearestSpeedBoost: null,
    nearestWeapon: null,
    enemies: [],
    items: [],
    hotBarrels: [],
    zoneRadius: 500,
    zoneCenterX: 0,
    zoneCenterY: 0,
    zoneIsShrinking: false,
    siegeWarnings: [],
    selfBarrierActive: false,
    hasRealWeapon: () => true,
    getActiveWeapon: () => ({ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }),
    getWeaponRange: () => 160,
    ...overrides,
  } as unknown as BotContext;
}

function makeIc(
  ctx: BotContext,
  prof: PersonalityProfile,
  arc?: IntentContext['arc'],
): IntentContext {
  return {
    ctx,
    profile: prof,
    aliveBotCount: 20,
    enemyInFightRange: false,
    zoneIsLethal: true,
    ...(arc !== undefined ? { arc } : {}),
  };
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 100,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. GDD §14.3 table verbatim (band edges + multiplier values)
// ---------------------------------------------------------------------------

describe('GDD §14.3 phase-weight table (verbatim business rules)', () => {
  it('carries the table values exactly: early 0.5/1.5/1.0, mid 1/1/1, late 1.5/0.5/1.5', () => {
    // docs/GDD.md §14.3 "Game Phase Awareness":
    //   Early >50% alive  → combatMod 0.5, lootingMod 1.5, positioningMod 1.0
    //   Mid   25-50%      → 1.0 / 1.0 / 1.0
    //   Late  <25% alive  → 1.5 / 0.5 / 1.5
    expect(GDD_PHASE_WEIGHTS.early).toEqual({
      combatMod: 0.5,
      lootingMod: 1.5,
      positioningMod: 1.0,
    });
    expect(GDD_PHASE_WEIGHTS.mid).toEqual({
      combatMod: 1.0,
      lootingMod: 1.0,
      positioningMod: 1.0,
    });
    expect(GDD_PHASE_WEIGHTS.late).toEqual({
      combatMod: 1.5,
      lootingMod: 0.5,
      positioningMod: 1.5,
    });
  });

  it('band edges: Early strictly >50%, Late strictly <25%, boundaries are MID', () => {
    expect(EARLY_BAND_ALIVE_RATIO_ABOVE).toBe(0.5);
    expect(LATE_BAND_ALIVE_RATIO_BELOW).toBe(0.25);
    expect(matchArcBandFor(0.51)).toBe('early');
    expect(matchArcBandFor(0.5)).toBe('mid'); // exactly 50% alive = mid
    expect(matchArcBandFor(0.25)).toBe('mid'); // exactly 25% alive = mid
    expect(matchArcBandFor(0.2499)).toBe('late');
  });

  it('computeMatchArc derives the band from alive counts (64-player boundaries)', () => {
    expect(computeMatchArc(64, 64).band).toBe('early');
    expect(computeMatchArc(33, 64).band).toBe('early'); // 51.6%
    expect(computeMatchArc(32, 64).band).toBe('mid'); // exactly 50%
    expect(computeMatchArc(17, 64).band).toBe('mid'); // 26.6%
    expect(computeMatchArc(16, 64).band).toBe('mid'); // exactly 25%
    expect(computeMatchArc(15, 64).band).toBe('late'); // 23.4%
    expect(computeMatchArc(0, 64).band).toBe('late');
  });

  it('the arc state carries the band weights and the alive ratio', () => {
    expect(EARLY).toEqual({
      band: 'early',
      aliveRatio: 40 / 63,
      combatMod: 0.5,
      lootingMod: 1.5,
      positioningMod: 1.0,
    });
    expect(MID.combatMod).toBe(1);
    expect(LATE.lootingMod).toBe(0.5);
    expect(LATE.positioningMod).toBe(1.5);
  });

  it('no denominator (pre-lobby) reads as ratio 1.0 → early (nothing eliminated)', () => {
    const empty = computeMatchArc(0, 0);
    expect(empty.band).toBe('early');
    expect(empty.aliveRatio).toBe(1);
  });

  it('is a PURE function of alive counts — identical inputs, identical state', () => {
    expect(computeMatchArc(17, 63)).toEqual(computeMatchArc(17, 63));
    expect(computeMatchArc(17, 63)).not.toEqual(computeMatchArc(16, 63));
  });
});

// ---------------------------------------------------------------------------
// 2. Per-archetype slope shapes (escalation data — DEC-011 dissents)
// ---------------------------------------------------------------------------

describe('per-archetype slopes (1 + (bandMod − 1) × slope)', () => {
  it('AGGRESSOR early combatMod stays high (0.85 — never fully suppressed)', () => {
    // Viktor dissent: early fights must still exist for AGGRESSOR players.
    const mod = arcModFor(EARLY, PersonalityArchetype.AGGRESSOR, 'combat');
    expect(mod).toBeCloseTo(0.85, 10); // 1 + (0.5 − 1) × 0.3
    expect(mod).toBeGreaterThan(0.75); // "stays high"
    expect(mod).toBeGreaterThan(arcModFor(EARLY, PersonalityArchetype.SURVIVOR, 'combat'));
  });

  it('AGGRESSOR late combatMod ramps FULLY to the GDD value (1.5)', () => {
    expect(arcModFor(LATE, PersonalityArchetype.AGGRESSOR, 'combat')).toBeCloseTo(1.5, 10);
  });

  it('SURVIVOR early combatMod takes the full table suppression (0.5)', () => {
    expect(arcModFor(EARLY, PersonalityArchetype.SURVIVOR, 'combat')).toBeCloseTo(0.5, 10);
  });

  it('SURVIVOR late combatMod stays bounded (1.2 — never fully ramps)', () => {
    const mod = arcModFor(LATE, PersonalityArchetype.SURVIVOR, 'combat');
    expect(mod).toBeCloseTo(1.2, 10); // 1 + (1.5 − 1) × 0.4
    expect(mod).toBeLessThan(1.5);
    expect(mod).toBeGreaterThan(1);
  });

  it('the mid band is the identity for every archetype × family', () => {
    const archetypes = [
      PersonalityArchetype.AGGRESSOR,
      PersonalityArchetype.SCAVENGER,
      PersonalityArchetype.TRAPPER,
      PersonalityArchetype.DUELIST,
      PersonalityArchetype.SURVIVOR,
    ];
    for (const archetype of archetypes) {
      for (const kind of ['combat', 'looting', 'positioning'] as const) {
        expect(arcModFor(MID, archetype, kind)).toBe(1);
      }
    }
  });

  it('an absent arc is the identity (the default that keeps pre-arc suites green)', () => {
    expect(arcModFor(undefined, PersonalityArchetype.AGGRESSOR, 'combat')).toBe(1);
    expect(arcModFor(null, PersonalityArchetype.SURVIVOR, 'looting')).toBe(1);
    expect(IDENTITY_MATCH_ARC.band).toBe('mid');
    expect(IDENTITY_MATCH_ARC.combatMod).toBe(1);
    expect(IDENTITY_MATCH_ARC.lootingMod).toBe(1);
    expect(IDENTITY_MATCH_ARC.positioningMod).toBe(1);
  });

  it('slope table rows exist for all five archetypes (data completeness)', () => {
    expect(Object.keys(ARCHETYPE_ARC_SLOPES)).toHaveLength(5);
  });

  it('applyArcMod clamps to the 0..1 Intent contract (amplified scores cap at survival)', () => {
    expect(applyArcMod(0.95, EARLY, PersonalityArchetype.SURVIVOR, 'looting')).toBe(1); // 1.425 → 1
    expect(applyArcMod(0.6, LATE, PersonalityArchetype.AGGRESSOR, 'combat')).toBeCloseTo(0.9, 10); // 0.6 × 1.5, under the cap
  });
});

// ---------------------------------------------------------------------------
// 3a. Intent application seams (combat family: DUEL / HUNT_VULNERABLE / HUNT)
// ---------------------------------------------------------------------------

describe('combat-family application (DUEL / HUNT_VULNERABLE / HUNT)', () => {
  const duelCtx = makeCtx({
    nearestEnemy: enemy({ distance: 300, weaponType: WeaponType.FISTS }),
  });

  it('DUEL: mid band and absent arc are identical (identity semantics)', () => {
    const duel = new DuelIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    expect(duel.score(makeIc(duelCtx, prof, MID))).toBe(duel.score(makeIc(duelCtx, prof)));
  });

  it('DUEL: early band suppresses — exactly half for the full-suppression archetype', () => {
    const duel = new DuelIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    const base = duel.score(makeIc(duelCtx, prof));
    expect(base).toBeGreaterThan(0);
    expect(duel.score(makeIc(duelCtx, prof, EARLY))).toBeCloseTo(base * 0.5, 10);
  });

  it('DUEL: AGGRESSOR keeps fighting early (0.85× > SURVIVOR 0.5×), full 1.5× late', () => {
    const duel = new DuelIntent();
    const aggr = profile(PersonalityArchetype.AGGRESSOR, 0.7);
    const surv = profile(PersonalityArchetype.SURVIVOR, 0.7);
    const aggrEarly = duel.score(makeIc(duelCtx, aggr, EARLY));
    const survEarly = duel.score(makeIc(duelCtx, surv, EARLY));
    expect(aggrEarly).toBeCloseTo(survEarly * (0.85 / 0.5), 9);
    // Late: amplified to the clamp for a high-aggression build (base ~0.955 × 1.5 > 1).
    expect(duel.score(makeIc(duelCtx, aggr, LATE))).toBe(1);
  });

  it('HUNT: combat-shaped (early suppressed, late amplified, mid identity)', () => {
    const hunt = new HuntIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.8); // base 0.3 + 0.32 = 0.62
    const ctx = makeCtx({ tick: 1000 }); // past HUNT's 600-tick gate, armed, no enemy
    expect(hunt.score(makeIc(ctx, prof, EARLY))).toBeCloseTo(0.62 * 0.5, 10);
    expect(hunt.score(makeIc(ctx, prof, MID))).toBeCloseTo(0.62, 10);
    expect(hunt.score(makeIc(ctx, prof))).toBeCloseTo(0.62, 10);
    expect(hunt.score(makeIc(ctx, profile(PersonalityArchetype.AGGRESSOR, 0.8), LATE))).toBeCloseTo(
      Math.min(1, 0.62 * 1.5),
      10,
    );
  });

  it('HUNT_VULNERABLE: combat-shaped when a prey exists', () => {
    const huntV = new HuntVulnerableIntent();
    // A looting enemy at close range is vulnerable (vulnerabilityScore > 0.5).
    const ctx = makeCtx({
      nearestEnemy: enemy({ distance: 200, isLooting: true }),
      enemies: [enemy({ distance: 200, isLooting: true })],
    });
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    expect(huntV.isValid(makeIc(ctx, prof))).toBe(true);
    const base = huntV.score(makeIc(ctx, prof, MID));
    expect(base).toBeGreaterThan(0);
    expect(huntV.score(makeIc(ctx, prof, EARLY))).toBeCloseTo(base * 0.5, 10);
    expect(huntV.score(makeIc(ctx, prof))).toBeCloseTo(base, 10);
  });
});

// ---------------------------------------------------------------------------
// 3b. Intent application seams (looting family: LOOT / ARM_UP)
// ---------------------------------------------------------------------------

describe('looting-family application (LOOT / ARM_UP)', () => {
  /** HP 40% + a health pack in range → the heal branch (best = 0.64). */
  const lootCtx = makeCtx({
    health: 40,
    nearestHealth: { id: 'h1', x: 100, y: 0, distance: 200, type: 'powerup', tier: 0 },
  });

  it('LOOT: early amplified ×1.5, late suppressed ×0.5, mid/absent identity', () => {
    const loot = new LootIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7); // greed 0.5 → ×0.85
    const base = loot.score(makeIc(lootCtx, prof)); // 0.64 × 0.85 = 0.544
    expect(base).toBeCloseTo(0.544, 10);
    expect(loot.score(makeIc(lootCtx, prof, MID))).toBeCloseTo(base, 10);
    expect(loot.score(makeIc(lootCtx, prof, EARLY))).toBeCloseTo(base * 1.5, 10); // 0.816
    expect(loot.score(makeIc(lootCtx, prof, LATE))).toBeCloseTo(base * 0.5, 10); // 0.272
  });

  it('LOOT: validity is NEVER arc-shaped (the gate surface is untouched)', () => {
    const loot = new LootIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    expect(loot.isValid(makeIc(lootCtx, prof))).toBe(true);
    expect(loot.isValid(makeIc(lootCtx, prof, EARLY))).toBe(true);
    expect(loot.isValid(makeIc(lootCtx, prof, LATE))).toBe(true);
  });

  it('ARM_UP: early outranks everything but survival; late still beats WANDER', () => {
    const armUp = new ArmUpIntent();
    const unarmed = makeCtx({
      hasRealWeapon: () => false,
      getActiveWeapon: () => ({ weaponType: WeaponType.FISTS, tier: 0, durability: 0, ammo: 0 }),
    });
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    expect(armUp.score(makeIc(unarmed, prof))).toBeCloseTo(0.95, 10);
    expect(armUp.score(makeIc(unarmed, prof, MID))).toBeCloseTo(0.95, 10);
    expect(armUp.score(makeIc(unarmed, prof, EARLY))).toBe(1); // 0.95 × 1.5 clamped
    expect(armUp.score(makeIc(unarmed, prof, LATE))).toBeCloseTo(0.475, 10); // > WANDER 0.15
  });

  it('the memo reflects the CURRENT arc at the same tick (IC-shape guard)', () => {
    // Same ctx, same tick, two DIFFERENT arc objects: the score must track the
    // arc actually passed (no stale carry from the first call's memo entry).
    const loot = new LootIntent();
    const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);
    const icEarly = makeIc(lootCtx, prof, EARLY);
    const icLate = makeIc(lootCtx, prof, computeMatchArc(10, 63));
    const earlyScore = loot.score(icEarly);
    const lateScore = loot.score(icLate);
    expect(earlyScore).toBeCloseTo(lateScore * 3, 9); // 1.5× vs 0.5× on the same base
    // And repeating with the SAME arc object is stable (memo hit, same value).
    expect(loot.score(icEarly)).toBeCloseTo(earlyScore, 10);
  });
});

// ---------------------------------------------------------------------------
// 3c. Intent application seams (positioning family: SURVIVE_ZONE pre-position)
// ---------------------------------------------------------------------------

describe('positioning-family application (SURVIVE_ZONE pre-positioning)', () => {
  const prof = profile(PersonalityArchetype.SURVIVOR, 0.7);

  it('proactive level: late amplifies to 0.75 (0.5 × 1.5); early/mid unchanged', () => {
    const zone = new SurviveZoneIntent();
    // Inside the zone, not shrinking, not on siege → the proactive branch.
    const ctx = makeCtx({ x: 0, y: 0 });
    expect(zone.score(makeIc(ctx, prof))).toBeCloseTo(0.5, 10);
    expect(zone.score(makeIc(ctx, prof, EARLY))).toBeCloseTo(0.5, 10); // base positioningMod 1.0
    expect(zone.score(makeIc(ctx, prof, MID))).toBeCloseTo(0.5, 10);
    expect(zone.score(makeIc(ctx, prof, LATE))).toBeCloseTo(0.75, 10);
  });

  it('hard survival is NEVER arc-shaped: siege stays 1.0, lethal-outside stays 1.0', () => {
    const zone = new SurviveZoneIntent();
    // Siege warning near the bot (grid coords × TILE_PIXEL_SIZE).
    const siegeCtx = makeCtx({ siegeWarnings: [{ x: 0, y: 0 }] });
    expect(zone.score(makeIc(siegeCtx, prof, LATE))).toBe(1);
    // Outside the lethal zone with NO fightable enemy → hard flee.
    const outsideCtx = makeCtx({ x: 9999, y: 9999, nearestEnemy: null });
    expect(zone.score(makeIc(outsideCtx, prof, LATE))).toBe(1);
    expect(zone.score(makeIc(outsideCtx, prof, EARLY))).toBe(1); // never suppressed either
    // Outside + fightable enemy (combat-aware survival) → 0.5, unshaped.
    const fightableCtx = makeCtx({
      x: 9999,
      y: 9999,
      nearestEnemy: enemy({ distance: 400, weaponType: WeaponType.FISTS }),
    });
    expect(zone.score(makeIc(fightableCtx, prof, LATE))).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// 3d. Goal application seam (PRE_POSITION rotation margins × positioningMod)
// ---------------------------------------------------------------------------

describe('goal application (PRE_POSITION rotation margins)', () => {
  /** Mid-map armed SURVIVOR with a formed next ring (mirrors GoalScoring
   *  suite fixtures). */
  function goalInputs(overrides: Partial<MacroGoalInputs> = {}): MacroGoalInputs {
    return {
      tick: 3600,
      playerId: 'bot-arc',
      x: 5120,
      y: 5120,
      health: 100,
      maxHealth: 100,
      armed: true,
      archetype: PersonalityArchetype.SURVIVOR,
      greed: 0.5,
      commitMultiplier: 1,
      zone: {
        safeX: 5120,
        safeY: 5120,
        safeRadius: 2600,
        timeUntilShrinkTicks: 99999,
        isShrinking: false,
        lethal: true,
        damagePerTick: 5,
        nextX: 4600,
        nextY: 4600,
        nextRadius: 2400,
      },
      fightPoints: [],
      heardChest: null,
      inScanLoot: null,
      aliveCount: 40,
      mapWidth: 10240,
      mapHeight: 10240,
      mapIdentity: null,
      sectorVisits: new Float64Array(16),
      barrelDensityAt: () => 0,
      hotspotStalkers: 0,
      ...overrides,
    };
  }

  /** The PRE_POSITION candidate's travel estimate, derived with the same pure
   *  helpers the scorer uses (holdR = max(200, nextRadius × 0.6)). */
  function prePositionTravel(inputs: MacroGoalInputs): number {
    const holdR = Math.max(200, inputs.zone.nextRadius * 0.6);
    const a = stableAngleRad(inputs.playerId);
    const px = inputs.zone.nextX + Math.cos(a) * holdR;
    const py = inputs.zone.nextY + Math.sin(a) * holdR;
    return travelTicksEstimate(Math.hypot(inputs.x - px, inputs.y - py));
  }

  function prePositionOf(inputs: MacroGoalInputs) {
    return scoreMacroGoals(inputs).find((c) => c.kind === 'PRE_POSITION');
  }

  it('absent arc = identity: the rotation fires exactly on the raw archetype margin', () => {
    // SURVIVOR rotationMargin 1.8 (GoalTables): fires iff
    // timeUntil < travel × 1.8. Park timeUntil BETWEEN travel×1.8 and
    // travel×2.7 — the raw margin says "not yet".
    const base = goalInputs();
    const travel = prePositionTravel(base);
    const timeUntil = Math.ceil(travel * 2.2);
    const gated = goalInputs({ zone: { ...base.zone, timeUntilShrinkTicks: timeUntil } });
    expect(prePositionOf(gated)).toBeUndefined();
  });

  it('late band: positioningMod 1.5 multiplies the margin → the SAME bot rotates EARLIER', () => {
    const base = goalInputs();
    const travel = prePositionTravel(base);
    const timeUntil = Math.ceil(travel * 2.2); // > travel×1.8, < travel×2.7
    const gated = goalInputs({ zone: { ...base.zone, timeUntilShrinkTicks: timeUntil } });
    // SURVIVOR takes the full positioning arc (slope 1.0): margin 1.8 × 1.5 = 2.7.
    const early = goalInputs({
      zone: { ...base.zone, timeUntilShrinkTicks: timeUntil },
      arc: computeMatchArc(10, 63), // late band, positioningMod 1.5
    });
    expect(prePositionOf(gated)).toBeUndefined();
    expect(prePositionOf(early)).toBeDefined();
  });

  it('mid band arc = absent arc (identity); score scales by positioningMod', () => {
    // With the shrink imminent BOTH produce the candidate; the late-band one
    // carries the ×1.5 positioningMod on the pre-position weight (1.3).
    const base = goalInputs();
    const zoneClosing = { ...base.zone, timeUntilShrinkTicks: 1 };
    const noArc = prePositionOf(goalInputs({ zone: zoneClosing }))!;
    const midArc = prePositionOf(goalInputs({ zone: zoneClosing, arc: computeMatchArc(20, 63) }))!;
    expect(midArc.score).toBeCloseTo(noArc.score, 10);
    const lateArc = prePositionOf(goalInputs({ zone: zoneClosing, arc: computeMatchArc(10, 63) }))!;
    // Recompute the expected late score with the scorer's own formula:
    // weight × 1.5 × urgency(margin = 1.8 × 1.5), no shrink multiplier.
    const travel = prePositionTravel(base);
    const margin = ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR]!.rotationMargin * 1.5;
    const ramp = Math.max(1, travel * margin * 3);
    const urgency = Math.max(0, Math.min(1, 1 - 1 / ramp));
    const expected =
      ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR]!.prePositionWeight *
      1.5 *
      (0.5 + 0.5 * urgency);
    expect(lateArc.score).toBeCloseTo(expected, 9);
    expect(lateArc.score).toBeGreaterThan(noArc.score);
  });
});

// ---------------------------------------------------------------------------
// Selector mechanics are untouched by the arc (scores only)
// ---------------------------------------------------------------------------

describe('selector mechanics under the arc', () => {
  it('hard survival can be TIED but never DOMINATED by amplified late-band combat', () => {
    // A late-band AGGRESSOR outside the lethal zone with a NON-fightable
    // enemy (beyond the 1000px combat-aware window): SURVIVE_ZONE's hard
    // flee scores 1.0, amplified DUEL clamps AT 1.0 (never above) — and
    // SURVIVE_ZONE is first in the intent array, so the tie keeps survival.
    const ctx = makeCtx({
      x: 9999,
      y: 9999,
      nearestEnemy: enemy({ distance: 1500, weaponType: WeaponType.FISTS }),
    });
    const prof = profile(PersonalityArchetype.AGGRESSOR, 0.9);
    const zone = new SurviveZoneIntent();
    const duel = new DuelIntent();
    expect(zone.score(makeIc(ctx, prof, LATE))).toBe(1);
    expect(duel.score(makeIc(ctx, prof, LATE))).toBe(1); // clamped tie, not dominance
    // The enemy beyond the combat-override range → still a hard flee.
    expect(zone.execute(makeIc(ctx, prof, LATE)).nextState).toBe(BotState.FLEE_ZONE);
    // Within the override range the legacy combat-override still routes to
    // ENGAGE (the endgame-stall breaker is arc-independent).
    const fightable = makeCtx({
      x: 9999,
      y: 9999,
      nearestEnemy: enemy({ distance: 300, weaponType: WeaponType.FISTS }),
    });
    expect(zone.execute(makeIc(fightable, prof, LATE)).nextState).toBe(BotState.ENGAGE);
  });

  it('the arc never manufactures validity (HUNT stays gated at tick <= 600)', () => {
    const hunt = new HuntIntent();
    const prof = profile(PersonalityArchetype.AGGRESSOR, 0.9);
    const ctx = makeCtx({ tick: 100 });
    expect(hunt.isValid(makeIc(ctx, prof, LATE))).toBe(false);
    expect(hunt.score(makeIc(ctx, prof, LATE))).toBe(0);
  });
});
