import { describe, it, expect } from 'vitest';
import { InputAction } from '@sector-battle/shared';
import {
  BotBelievabilityCounters,
  bucketLatencyTicks,
  intentFamilyEntropy,
  botStateFamilyIndex,
  INTENT_FAMILY_KEYS,
  LATENCY_BUCKET_COUNT,
  LATENCY_BUCKET_LABELS,
  summarizeBelievability,
  type BelievabilityTickView,
} from '../../src/ai/BotBelievability.ts';
import {
  makeDashInput,
  makeThrowInput,
  makeSwitchSlotInput,
  makeAttackInput,
  makePickupInput,
} from '../../src/ai/BotInput.ts';
import { tallyExecutorInputs } from '../../src/ai/BotTelemetry.ts';
import { BotSkillTracker, computeProfile } from '../../src/ai/BotSkillTracker.ts';
import { BotState } from '../../src/ai/BotContextTypes.ts';
import { IntentSelector } from '../../src/ai/intent/IntentSelector.ts';
import { IntentId } from '../../src/ai/intent/Intent.ts';
import { buildPhase2Intents } from '../../src/ai/intent/intents.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
  buildPersonality,
} from '../../src/ai/intent/PersonalityProfile.ts';
import { BotRNG } from '../../src/ai/BotContext.ts';

/** Tick-view factory: a walking WANDER bot at the origin by default. */
function view(overrides: Partial<BelievabilityTickView> = {}): BelievabilityTickView {
  return {
    tick: 0,
    x: 0,
    y: 0,
    vx: 5,
    vy: 0,
    state: BotState.WANDER,
    hasEnemy: false,
    forceWanderUntilTick: -9999,
    ...overrides,
  };
}

describe('bucketLatencyTicks (histogram bucketing)', () => {
  it('has consistent edges/labels/count', () => {
    expect(LATENCY_BUCKET_LABELS).toHaveLength(LATENCY_BUCKET_COUNT);
    expect(LATENCY_BUCKET_LABELS[0]).toBe('0-2');
    expect(LATENCY_BUCKET_LABELS[LATENCY_BUCKET_COUNT - 1]).toBe('60+');
  });

  it('maps deltas onto the correct buckets', () => {
    expect(bucketLatencyTicks(0)).toBe(0);
    expect(bucketLatencyTicks(2)).toBe(0);
    expect(bucketLatencyTicks(3)).toBe(1);
    expect(bucketLatencyTicks(5)).toBe(1);
    expect(bucketLatencyTicks(6)).toBe(2);
    expect(bucketLatencyTicks(11)).toBe(2);
    expect(bucketLatencyTicks(12)).toBe(3);
    expect(bucketLatencyTicks(17)).toBe(3);
    expect(bucketLatencyTicks(18)).toBe(4);
    expect(bucketLatencyTicks(29)).toBe(4);
    expect(bucketLatencyTicks(30)).toBe(5);
    expect(bucketLatencyTicks(59)).toBe(5);
    expect(bucketLatencyTicks(60)).toBe(6);
    expect(bucketLatencyTicks(10000)).toBe(6);
  });

  it('clamps negative deltas to bucket 0 (defensive)', () => {
    expect(bucketLatencyTicks(-5)).toBe(0);
  });
});

describe('intentFamilyEntropy (entropy math)', () => {
  it('returns 0 for an all-in-one-intent bot', () => {
    expect(intentFamilyEntropy([0, 0, 0, 0, 0, 0, 100])).toBe(0);
  });

  it('returns 0 for an empty / all-zero vector', () => {
    expect(intentFamilyEntropy([0, 0, 0, 0, 0, 0, 0])).toBe(0);
    expect(intentFamilyEntropy([])).toBe(0);
  });

  it('returns 1 for an even mix over the observed intents', () => {
    expect(intentFamilyEntropy([10, 10, 10, 10, 10, 10, 10])).toBeCloseTo(1, 10);
    // Even over a SUBSET of buckets: normalized by ln(nonzero buckets).
    expect(intentFamilyEntropy([5, 5, 0, 0, 0, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns ln(2)/ln(7)-style normalized value for a known two-bucket split', () => {
    // 75/25 over 2 nonzero buckets: H = -(0.75ln0.75 + 0.25ln0.25); norm by ln 2.
    const h = -(0.75 * Math.log(0.75) + 0.25 * Math.log(0.25));
    expect(intentFamilyEntropy([75, 25, 0, 0, 0, 0, 0])).toBeCloseTo(h / Math.log(2), 10);
  });
});

describe('BotBelievabilityCounters state machine', () => {
  it('tallies intent-family ticks per BotState (incl. DEMOLITION → engage)', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ state: BotState.WANDER }));
    c.observeTick(view({ state: BotState.WANDER }));
    c.observeTick(view({ state: BotState.ENGAGE }));
    c.observeTick(view({ state: BotState.DEMOLITION }));
    c.observeTick(view({ state: BotState.SEEK_WEAPON }));
    expect(c.intentFamilyTicks[INTENT_FAMILY_KEYS.indexOf('wander')]).toBe(2);
    expect(c.intentFamilyTicks[INTENT_FAMILY_KEYS.indexOf('engage')]).toBe(2);
    expect(c.intentFamilyTicks[INTENT_FAMILY_KEYS.indexOf('armUp')]).toBe(1);
    expect(botStateFamilyIndex(BotState.FLEE_ZONE)).toBe(INTENT_FAMILY_KEYS.indexOf('fleeZone'));
    expect(botStateFamilyIndex(BotState.RETREAT)).toBe(INTENT_FAMILY_KEYS.indexOf('retreat'));
    expect(botStateFamilyIndex(BotState.LOOT)).toBe(INTENT_FAMILY_KEYS.indexOf('loot'));
    expect(botStateFamilyIndex(BotState.HUNT)).toBe(INTENT_FAMILY_KEYS.indexOf('hunt'));
  });

  it('records damage→state-change latency when the state changes after a hit', () => {
    const c = new BotBelievabilityCounters();
    // Ticks 0..5 in LOOT; the StimulusRouter delivers the PlayerDamaged
    // stimulus for tick 5 AFTER tick 5's observation (the orchestrator taps
    // the event stream after the tick's bot pass) — noteDamageStimulus(5)
    // is called between ticks; state flips to HUNT at 7.
    for (let t = 0; t <= 5; t++) c.observeTick(view({ tick: t, state: BotState.LOOT }));
    c.noteDamageStimulus(5);
    c.observeTick(view({ tick: 6, state: BotState.LOOT }));
    c.observeTick(view({ tick: 7, state: BotState.HUNT }));
    expect(c.damageResponse.stimuli).toBe(1);
    expect(c.damageResponse.responded).toBe(1);
    expect(c.damageResponse.censored).toBe(0);
    // Delta 7-5=2 → bucket 0 ('0-2').
    expect(c.damageResponse.buckets[0]).toBe(1);
    expect(c.damageResponseTickSum).toBe(2);
  });

  it('censors a damage stimulus whose window expires without a state change', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ tick: 0, state: BotState.LOOT }));
    c.observeTick(view({ tick: 1, state: BotState.LOOT }));
    c.noteDamageStimulus(1);
    // 90-tick window: tick 92 is past it with no response.
    c.observeTick(view({ tick: 92, state: BotState.LOOT }));
    expect(c.damageResponse.stimuli).toBe(1);
    expect(c.damageResponse.responded).toBe(0);
    expect(c.damageResponse.censored).toBe(1);
  });

  it('minimum true-latency delta is 1 tick: the earliest response lands the tick after delivery', () => {
    const c = new BotBelievabilityCounters();
    // Damage lands during tick 1 (pre-botAI); the stimulus is delivered after
    // tick 1's pass; the earliest observable response is tick 2's selection.
    c.observeTick(view({ tick: 0, state: BotState.LOOT }));
    c.observeTick(view({ tick: 1, state: BotState.LOOT }));
    c.noteDamageStimulus(1);
    c.observeTick(view({ tick: 2, state: BotState.ENGAGE }));
    expect(c.damageResponse.responded).toBe(1);
    expect(c.damageResponse.buckets[0]).toBe(1); // delta 1 → '0-2'
    expect(c.damageResponseTickSum).toBe(1);
  });

  it('back-to-back damage stimuli right-censor the unanswered one (window discipline)', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ tick: 0, state: BotState.LOOT }));
    c.observeTick(view({ tick: 1, state: BotState.LOOT }));
    c.noteDamageStimulus(1);
    c.observeTick(view({ tick: 2, state: BotState.LOOT }));
    c.noteDamageStimulus(2);
    c.observeTick(view({ tick: 3, state: BotState.RETREAT }));
    expect(c.damageResponse.stimuli).toBe(2);
    expect(c.damageResponse.censored).toBe(1); // the tick-1 stimulus
    expect(c.damageResponse.responded).toBe(1); // the tick-2 stimulus, delta 1
    expect(c.damageResponseTickSum).toBe(1);
  });

  it('a stimulus noted before any observation has no state baseline — it can only censor', () => {
    const c = new BotBelievabilityCounters();
    c.noteDamageStimulus(0); // bot registered mid-tick, no observeTick yet
    c.observeTick(view({ tick: 0, state: BotState.ENGAGE }));
    c.observeTick(view({ tick: 1, state: BotState.WANDER }));
    expect(c.damageResponse.stimuli).toBe(1);
    expect(c.damageResponse.responded).toBe(0);
    c.observeTick(view({ tick: 91, state: BotState.WANDER }));
    expect(c.damageResponse.censored).toBe(1);
  });

  it('resolves enemy-seen→first-attack from an emitted ATTACK and ignores pre-sighting attacks', () => {
    const c = new BotBelievabilityCounters();
    // Real pipeline order per tick: noteEmittedInputs (executor) runs BEFORE
    // observeTick (telemetry). An attack BEFORE the sighting must not resolve.
    c.noteEmittedInputs([makeAttackInput('b', 0, 3)], 3);
    c.observeTick(view({ tick: 3, hasEnemy: false }));
    // Enemy first seen at tick 10 (stimulus; stamp=3 < 10 → unresolved).
    c.observeTick(view({ tick: 10, hasEnemy: true }));
    expect(c.seenToAttack.responded).toBe(0);
    // First attack after the sighting lands at tick 13 (stamp written before
    // tick 13's observation) → resolved with delta 3.
    c.noteEmittedInputs([makeAttackInput('b', 0, 13)], 13);
    c.observeTick(view({ tick: 13, hasEnemy: true }));
    expect(c.seenToAttack.stimuli).toBe(1);
    expect(c.seenToAttack.responded).toBe(1);
    expect(c.seenToAttack.censored).toBe(0);
    // Delta 13-10=3 → bucket 1 ('3-5').
    expect(c.seenToAttack.buckets[1]).toBe(1);
  });

  it('censors a seen stimulus when the enemy is lost before any attack', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ tick: 0, hasEnemy: false }));
    c.observeTick(view({ tick: 1, hasEnemy: true }));
    c.observeTick(view({ tick: 2, hasEnemy: false }));
    expect(c.seenToAttack.stimuli).toBe(1);
    expect(c.seenToAttack.responded).toBe(0);
    expect(c.seenToAttack.censored).toBe(1);
  });

  it('counts forced-wander activations on the rising edge only', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ tick: 0, forceWanderUntilTick: -9999 }));
    c.observeTick(view({ tick: 1, forceWanderUntilTick: 61 })); // armed
    c.observeTick(view({ tick: 2, forceWanderUntilTick: 61 })); // held — not a new activation
    c.observeTick(view({ tick: 70, forceWanderUntilTick: -9999 })); // expired (falls — not counted)
    c.observeTick(view({ tick: 100, forceWanderUntilTick: 160 })); // re-armed
    expect(c.forcedWanderActivations).toBe(2);
  });

  it('credits a whole stuck window when displacement stays under the stall threshold', () => {
    const c = new BotBelievabilityCounters();
    // 0..89 stationary at the origin (window [0,90) completes at tick 90).
    for (let t = 0; t < 90; t++) c.observeTick(view({ tick: t, x: 0, y: 0 }));
    c.observeTick(view({ tick: 90, x: 10, y: 0 })); // <25px over the window → stuck
    expect(c.stuckTicks).toBe(90);
    // A MOVING window: 1000px traveled over 90 ticks → not stuck.
    for (let t = 91; t < 180; t++) c.observeTick(view({ tick: t, x: 10 + (t - 90) * 12, y: 0 }));
    c.observeTick(view({ tick: 181, x: 10 + 91 * 12, y: 0 }));
    expect(c.stuckTicks).toBe(90); // unchanged
  });

  it('counts idle ticks only below the stillness threshold', () => {
    const c = new BotBelievabilityCounters();
    c.observeTick(view({ tick: 0, vx: 0, vy: 0 })); // stopped
    c.observeTick(view({ tick: 1, vx: 0.5, vy: 0 })); // below 1 px/tick
    c.observeTick(view({ tick: 2, vx: 5, vy: 0 })); // walking
    c.observeTick(view({ tick: 3, vx: 3, vy: -4 })); // 5 px/tick — walking
    expect(c.movement.idleTicks).toBe(2);
  });

  it('accumulates path efficiency as windowed straight-line over traveled', () => {
    const c = new BotBelievabilityCounters();
    // Walk in a straight line: 4 px/tick for 180 ticks → efficiency 1.
    for (let t = 0; t <= 180; t++) c.observeTick(view({ tick: t, x: t * 4, y: 0 }));
    expect(c.traveledPx).toBeGreaterThan(0);
    expect(c.straightPx / c.traveledPx).toBeCloseTo(1, 6);
    // Then walk a closed loop back to the start: straight ≈ 0, traveled > 0.
    const c2 = new BotBelievabilityCounters();
    for (let t = 0; t <= 180; t++)
      c2.observeTick(view({ tick: t, x: t <= 90 ? t * 4 : (180 - t) * 4, y: 0 }));
    expect(c2.traveledPx).toBeGreaterThan(0);
    expect(c2.straightPx).toBeCloseTo(0, 6);
  });
});

describe('reason-tag tallying', () => {
  it('reads tags attached by the input factories (WeakMap side channel)', () => {
    const tagged = makeDashInput('b', 1, 10, 'engage-windup-dodge');
    const untagged = makeThrowInput('b', 1, 11);
    const sw = makeSwitchSlotInput('b', 2, 12, 'retreat-switch-spare');
    const c = new BotBelievabilityCounters();
    c.noteEmittedInputs([tagged, untagged, sw], 12);
    expect(c.dashByReason['engage-windup-dodge']).toBe(1);
    expect(c.dashTotal).toBe(1);
    expect(c.throwByReason['untagged']).toBe(1);
    expect(c.throwTotal).toBe(1);
    expect(c.switchByReason['retreat-switch-spare']).toBe(1);
    expect(c.switchTotal).toBe(1);
  });

  it('tallyExecutorInputs keeps the legacy counters and stamps attack ticks', () => {
    const tracker = new BotSkillTracker();
    tallyExecutorInputs(tracker, 42, [
      makeAttackInput('b', 0, 42),
      makePickupInput('b', 'item1', 42),
      makeDashInput('b', 0, 42, 'mobility-commute'),
    ]);
    expect(tracker.attacksAttempted).toBe(1);
    expect(tracker.pickupAttempts).toBe(1);
    expect(tracker.believability.dashByReason['mobility-commute']).toBe(1);
    // The attack stamp resolves a pending seen→attack stimulus with delta 0.
    tracker.believability.observeTick(view({ tick: 42, hasEnemy: true }));
    expect(tracker.believability.seenToAttack.responded).toBe(1);
    expect(tracker.believability.seenToAttack.buckets[0]).toBe(1);
  });

  it('THROW inputs also stamp the attack tick (offensive response)', () => {
    const c = new BotBelievabilityCounters();
    c.noteEmittedInputs([makeThrowInput('b', 0, 7, 'retreat-throw-deny')], 7);
    c.observeTick(view({ tick: 7, hasEnemy: true }));
    expect(c.seenToAttack.responded).toBe(1);
  });
});

describe('summarizeBelievability', () => {
  it('derives ratios, entropy, and histogram means from the counters', () => {
    const c = new BotBelievabilityCounters();
    for (let t = 0; t < 100; t++) c.observeTick(view({ tick: t, vx: 0, vy: 0 }));
    c.noteSuspension('LOOT');
    c.noteSuspension('LOOT');
    c.noteSuspension('HUNT');
    c.noteDash('mobility-commute');
    const s = summarizeBelievability(c, 100);
    expect(s.intentEntropy).toBe(0); // all WANDER
    expect(s.idleRatio).toBe(1);
    expect(s.stuckTimeRatio).toBe(0.9); // 90 stuck ticks / 100 alive
    expect(s.suspensions).toBe(3);
    expect(s.suspensionsByFamily).toEqual({ LOOT: 2, HUNT: 1 });
    expect(s.dashByReason).toEqual({ 'mobility-commute': 1 });
    expect(s.damageResponse.avgTicks).toBe(-1); // no responses
    expect(s.pathEfficiency).toBe(1); // no travel → defined as 1
  });

  it('flows through computeProfile as SkillProfile.believability', () => {
    const tracker = new BotSkillTracker();
    tracker.believability.noteDash('engage-backoff');
    const profile = computeProfile(tracker, 600, 100, 100, 1, 600);
    expect(profile.believability.dashByReason['engage-backoff']).toBe(1);
    expect(profile.believability.intentFamilyTicks).toHaveLength(INTENT_FAMILY_KEYS.length);
  });
});

describe('IntentSelector suspension counters (read-only exposure)', () => {
  it('suspend() increments issued + byFamily; SURVIVE_ZONE is a no-op', () => {
    const sel = new IntentSelector(buildPhase2Intents());
    sel.suspend(IntentId.LOOT, 100);
    sel.suspend(IntentId.LOOT, 200);
    sel.suspend(IntentId.HUNT, 300);
    sel.suspend(IntentId.SURVIVE_ZONE, 400); // guarded — never counted
    expect(sel.suspensionsIssued).toBe(3);
    expect(sel.suspensionsByFamily.get(IntentId.LOOT)).toBe(2);
    expect(sel.suspensionsByFamily.get(IntentId.HUNT)).toBe(1);
    expect(sel.suspensionsByFamily.has(IntentId.SURVIVE_ZONE)).toBe(false);
  });

  it('counts expiries at read time and clears via clearSuspensions', () => {
    const sel = new IntentSelector(buildPhase2Intents());
    sel.suspend(IntentId.LOOT, 100);
    // Full-ish ctx (the intent implementations read weapons/enemies/zone).
    const ctx = {
      tick: 200,
      x: 0,
      y: 0,
      health: 100,
      maxHealth: 100,
      weapons: [{ weaponType: 'DAGGER', tier: 1, durability: 10, ammo: 10 }],
      activeSlot: 0,
      nearestEnemy: null,
      nearestHealth: null,
      nearestBarrier: null,
      nearestSpeedBoost: null,
      nearestWeapon: null,
      enemies: [],
      items: [],
      dangers: [],
      hotBarrels: [],
      zoneRadius: 500,
      zoneCenterX: 0,
      zoneCenterY: 0,
      zoneIsShrinking: false,
      siegeWarnings: [],
      selfBarrierActive: false,
      rng: new BotRNG(1),
      hasRealWeapon: () => true,
      getActiveWeapon: () => ({ weaponType: 'DAGGER', tier: 1, durability: 10, ammo: 10 }),
      getWeaponRange: () => 160,
    } as never;
    sel.select({
      ctx,
      profile: new PersonalityProfile(
        PersonalityArchetype.DUELIST,
        { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5 },
        { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
      ),
      aliveBotCount: 10,
      enemyInFightRange: false,
      zoneIsLethal: false,
    }); // tick 200 > 100 → the LOOT suspension expires during scoring
    expect(sel.suspensionsExpired).toBeGreaterThanOrEqual(1);
    sel.suspend(IntentId.HUNT, 1000);
    sel.clearSuspensions();
    expect(sel.suspensionsCleared).toBeGreaterThanOrEqual(1);
  });
});

describe('PersonalityProfile difficulty label (per-difficulty cut join)', () => {
  it('stores the difficulty it was built with', () => {
    const p = buildPersonality(new BotRNG(12345), 'hard');
    expect(p.difficulty).toBe('hard');
    const p2 = buildPersonality(new BotRNG(12345), 'easy');
    expect(p2.difficulty).toBe('easy');
  });

  it('defaults the constructor label to medium (back-compat with test factories)', () => {
    const p = new PersonalityProfile(
      PersonalityArchetype.SURVIVOR,
      { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5 },
      { aimErrorMultiplier: 1, reactionLatencyTicks: 3, commitMultiplier: 1 },
    );
    expect(p.difficulty).toBe('medium');
  });
});

describe('Reactor reaction tally (bot-ai-v2 ticket 04, DEC-004)', () => {
  it('noteReaction counts per type and buckets the true stimulus→activation delta', () => {
    const c = new BotBelievabilityCounters();
    c.noteReaction('windup', 0);
    c.noteReaction('windup', 3);
    c.noteReaction('explosion', 30);
    expect(c.reactionsByType).toEqual({ windup: 2, explosion: 1 });
    expect(c.reactionsTotal).toBe(3);
    expect(c.reactionLatency.stimuli).toBe(3);
    expect(c.reactionLatency.responded).toBe(3);
    // bucketLatencyTicks: 0,3 → bucket 0 (0-2)... 3 → bucket 1 (3-5); 30 → 59? no: 30 ≤ 59 → bucket 5.
    expect(c.reactionLatency.buckets[0]).toBe(1); // delta 0
    expect(c.reactionLatency.buckets[1]).toBe(1); // delta 3
    expect(c.reactionLatency.buckets[5]).toBe(1); // delta 30 (18-29 is 4; 30-59 is 5)
    expect(c.reactionLatencyTickSum).toBe(33);
  });

  it('flows into the summary (reactionsByType / reactionsTotal / reactionLatency)', () => {
    const c = new BotBelievabilityCounters();
    c.noteReaction('startle', 6);
    const s = summarizeBelievability(c, 10);
    expect(s.reactionsByType).toEqual({ startle: 1 });
    expect(s.reactionsTotal).toBe(1);
    expect(s.reactionLatency.responded).toBe(1);
    expect(s.reactionLatency.avgTicks).toBeCloseTo(6, 10);
  });
});
