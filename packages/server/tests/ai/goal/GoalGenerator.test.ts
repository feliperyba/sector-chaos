/**
 * Macro-goal generator cadence tests — bot-ai-v2 ticket 07 (DEC-008).
 *
 * Pure-seam assertions over updateMacroGoal: the staggered re-score cadence
 * (per-bot phase spread), the 3-6 s COMMIT-STICKY window (a committed goal
 * survives a higher-scoring challenger until its window lapses; the scoring
 * cadence alone never bounces it), arrival consumption, deterministic
 * commit windows, and the goal-mix telemetry counters.
 */

import { describe, it, expect } from 'vitest';
import {
  commitWindowTicks,
  consumeGoal,
  createMacroGoalState,
  nextRescoreTick,
  updateMacroGoal,
} from '../../../src/ai/goal/GoalGenerator.ts';
import {
  MACRO_GOAL_COMMIT_MAX_TICKS,
  MACRO_GOAL_COMMIT_MIN_TICKS,
  MACRO_GOAL_RESCORE_BASE_TICKS,
  MACRO_GOAL_RESCORE_STAGGER_TICKS,
} from '../../../src/ai/goal/GoalTables.ts';
import { hashPhase } from '../../../src/ai/BotContext.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';
import type { MacroGoalInputs } from '../../../src/ai/goal/GoalTypes.ts';
import { BotGoalTelemetry } from '../../../src/ai/BotGoalTelemetry.ts';

/** Inputs that yield ONLY the fallback candidate (no fights, no identity,
 *  no loot, unknown shrink clock) — the winner is the zone-safe anchor as a
 *  PRE_POSITION goal. `nextX` controls the fallback point. */
function minimalInputs(overrides: Partial<MacroGoalInputs> = {}): MacroGoalInputs {
  return {
    tick: 0,
    playerId: 'bot-cadence',
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
      timeUntilShrinkTicks: -1,
      isShrinking: false,
      lethal: true,
      damagePerTick: 5,
      nextX: 5000,
      nextY: 5000,
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
    barrelDensityAt: null,
    hotspotStalkers: 0,
    ...overrides,
  };
}

describe('rescore cadence (staggered per bot)', () => {
  it('the first rescore is staggered per bot (no lockstep goal passes)', () => {
    const a = createMacroGoalState('bot-a');
    const b = createMacroGoalState('bot-b');
    const spread = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const s = createMacroGoalState(`bot-${i}`);
      spread.add(s.nextRescoreTick);
    }
    expect(a.nextRescoreTick).toBe(
      MACRO_GOAL_RESCORE_BASE_TICKS + hashPhase('bot-a', MACRO_GOAL_RESCORE_STAGGER_TICKS),
    );
    expect(a.nextRescoreTick).not.toBe(b.nextRescoreTick);
    expect(spread.size).toBeGreaterThan(1);
    // Window bounds: every first rescore inside the 2-3 s band.
    for (let i = 0; i < 24; i++) {
      const t = createMacroGoalState(`bot-${i}`).nextRescoreTick;
      expect(t).toBeGreaterThanOrEqual(MACRO_GOAL_RESCORE_BASE_TICKS);
      expect(t).toBeLessThan(MACRO_GOAL_RESCORE_BASE_TICKS + MACRO_GOAL_RESCORE_STAGGER_TICKS);
    }
  });

  it('no commit before the cadence elapses (cheap between passes)', () => {
    const state = createMacroGoalState('bot-cadence');
    const firstTick = state.nextRescoreTick;
    const early = updateMacroGoal(state, 'bot-cadence', firstTick - 1, minimalInputs());
    expect(early.committed).toBe(false);
    expect(early.goal).toBeNull();
    // The inputs were not even consumed (no sector visit stamped — no identity).
  });

  it('the cadence commits at the staggered tick and re-arms deterministically', () => {
    const state = createMacroGoalState('bot-cadence');
    const at = state.nextRescoreTick;
    const r1 = updateMacroGoal(state, 'bot-cadence', at, minimalInputs({ tick: at }));
    expect(r1.committed).toBe(true);
    expect(r1.goal).not.toBeNull();
    expect(r1.goal!.kind).toBe('PRE_POSITION'); // the no-candidate fallback
    expect(r1.goal!.x).toBe(5120); // zone-safe anchor point
    // Next pass re-armed at the same staggered offset from THIS tick.
    expect(state.nextRescoreTick).toBe(nextRescoreTick('bot-cadence', at));
  });
});

describe('commit window (3-6 s, commit-sticky)', () => {
  it('commit windows are deterministic per bot and inside the 3-6 s band', () => {
    for (const id of ['bot-a', 'bot-b', 'bot-c']) {
      const t0 = 1000;
      const until = commitWindowTicks(id, 1, t0);
      expect(commitWindowTicks(id, 1, t0)).toBe(until); // deterministic
      const span = until - t0;
      expect(span).toBeGreaterThanOrEqual(MACRO_GOAL_COMMIT_MIN_TICKS);
      expect(span).toBeLessThanOrEqual(MACRO_GOAL_COMMIT_MAX_TICKS);
    }
  });

  it('a committed goal SURVIVES a higher-scoring challenger inside its window', () => {
    const state = createMacroGoalState('bot-sticky');
    // First pass at the cadence tick: commits the fallback PRE_POSITION at
    // the safe anchor (5120, 5120).
    const t1 = state.nextRescoreTick;
    const r1 = updateMacroGoal(state, 'bot-sticky', t1, minimalInputs({ tick: t1 }));
    expect(r1.committed).toBe(true);

    // The next cadence pass (≈2-3 s later) is still INSIDE the 3-6 s commit
    // window (rescore cadence 120-180 < commit window 180-360). Feed inputs
    // whose ONLY candidate is a LOOT_CLUSTER far away — even though it is
    // now the sole (highest) scorer, the committed goal must hold.
    const t2 = state.nextRescoreTick;
    expect(t2).toBeGreaterThan(t1);
    expect(t2).toBeLessThan(r1.goal!.commitUntilTick); // cadence inside window
    const challengerInputs = minimalInputs({
      tick: t2,
      inScanLoot: { x: 6000, y: 6000, value: 1 },
    });
    const r2 = updateMacroGoal(state, 'bot-sticky', t2, challengerInputs);
    expect(r2.committed).toBe(false); // no re-commit inside the window
    expect(r2.goal).toBe(r1.goal); // SAME goal object — sticky
    expect(r2.goal!.kind).toBe('PRE_POSITION');
  });

  it('after the window lapses, the next cadence pass commits the new winner', () => {
    const state = createMacroGoalState('bot-sticky');
    const t1 = state.nextRescoreTick;
    updateMacroGoal(state, 'bot-sticky', t1, minimalInputs({ tick: t1 }));
    const committed = state.current!;
    // Advance past BOTH the commit window and any pending rescore cadence
    // (the rescore re-arm after the sticky pass is at most t1 + 2×(base+
    // stagger), so +2 full windows is safely beyond it).
    const t3 = committed.commitUntilTick + 2 * MACRO_GOAL_COMMIT_MAX_TICKS;
    const r3 = updateMacroGoal(
      state,
      'bot-sticky',
      t3,
      minimalInputs({ tick: t3, inScanLoot: { x: 6000, y: 6000, value: 1 } }),
    );
    expect(r3.committed).toBe(true);
    expect(r3.goal!.kind).toBe('LOOT_CLUSTER');
    expect(r3.goal!.x).toBe(6000);
  });

  it('arrival consumption (consumeGoal) regenerates on the FOLLOWING tick', () => {
    const state = createMacroGoalState('bot-arrive');
    const t1 = state.nextRescoreTick;
    const r1 = updateMacroGoal(state, 'bot-arrive', t1, minimalInputs({ tick: t1 }));
    const window = r1.goal!.commitUntilTick;
    consumeGoal(state, t1); // the executor arrived at the goal point
    const r2 = updateMacroGoal(state, 'bot-arrive', t1 + 1, minimalInputs({ tick: t1 + 1 }));
    expect(r2.committed).toBe(true); // immediate regeneration
    expect(r2.goal!.bornTick).toBe(t1 + 1);
    expect(window).toBeGreaterThan(t1); // (sanity: the consumed goal had a window)
  });
});

describe('goal-mix telemetry (BotGoalTelemetry)', () => {
  it('counts commits by kind and buckets pre-position ticks-ahead', () => {
    const t = new BotGoalTelemetry();
    t.noteMacroGoal('prePosition');
    t.noteMacroGoal('prePosition');
    t.noteMacroGoal('quietSide');
    expect(t.commitsByKind['prePosition']).toBe(2);
    expect(t.commitsByKind['quietSide']).toBe(1);
    expect(t.commitsTotal).toBe(3);

    t.notePrePosition(100); // 0-180 bucket
    t.notePrePosition(400); // 181-600 bucket
    t.notePrePosition(3000); // 2401+ bucket
    expect(t.prePositionSamples).toBe(3);
    expect(t.prePositionTicksAheadSum).toBe(3500);
    expect(t.prePositionBuckets[0]).toBe(1);
    expect(t.prePositionBuckets[1]).toBe(1);
    expect(t.prePositionBuckets[4]).toBe(1);
  });
});
