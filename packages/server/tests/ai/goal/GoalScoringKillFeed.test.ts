import { describe, it, expect } from 'vitest';
import { scoreMacroGoals, type ScoredCandidate } from '../../../src/ai/goal/GoalScoring.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';
import type { MacroGoalInputs } from '../../../src/ai/goal/GoalTypes.ts';

/**
 * Kill-feed awareness at the goal seam (DEC-010.4, ticket 09):
 *  - SAFE-LOOT WINDOW: a fresh heard elimination becomes a LOOT_CLUSTER
 *    candidate at the corpse seat, fading with the window;
 *  - DANGER MEMORY: the quiet-side candidate bends AWAY from the sector
 *    where deaths have been clustering (the ticket-07 interaction).
 */

function baseInputs(overrides: Partial<MacroGoalInputs> = {}): MacroGoalInputs {
  return {
    tick: 3600,
    playerId: 'bot-kf',
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
      nextX: 5120,
      nextY: 5120,
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

function pickKind(candidates: ScoredCandidate[], kind: string): ScoredCandidate | undefined {
  return candidates.find((c) => c.kind === kind);
}

describe('LOOT_CLUSTER — the safe-loot window (heard elimination source)', () => {
  it('routes the loot cluster toward the fresh corpse seat', () => {
    const candidates = scoreMacroGoals(
      baseInputs({ heardElimination: { x: 6000, y: 5200, tick: 3590 } }),
    );
    const loot = pickKind(candidates, 'LOOT_CLUSTER');
    expect(loot).toBeDefined();
    expect(loot!.x).toBe(6000);
    expect(loot!.y).toBe(5200);
    expect(loot!.score).toBeGreaterThan(0);
  });

  it('fades as the window ages and vanishes past it', () => {
    const fresh = pickKind(
      scoreMacroGoals(baseInputs({ heardElimination: { x: 6000, y: 5200, tick: 3595 } })),
      'LOOT_CLUSTER',
    );
    const stale = pickKind(
      scoreMacroGoals(baseInputs({ heardElimination: { x: 6000, y: 5200, tick: 3120 } })),
      'LOOT_CLUSTER',
    );
    expect(fresh).toBeDefined();
    // 480-tick window: at age 5 the value is near-full; at age 480 it is 0
    // (no candidate at all — nothing else scores a loot cluster here).
    expect(stale).toBeUndefined();
    const mid = pickKind(
      scoreMacroGoals(baseInputs({ heardElimination: { x: 6000, y: 5200, tick: 3360 } })),
      'LOOT_CLUSTER',
    );
    expect(mid).toBeDefined();
    expect(fresh!.score).toBeGreaterThan(mid!.score);
  });

  it('a heard chest still outranks a stale corpse (source priority)', () => {
    // Chest seats come from the 700 px hearing radius (StimulusConfig), so a
    // fresh (age-5-ticks) chest sits well inside LOOT_CLUSTER_RANGE_PX — the
    // fixture below is ~1580 px from the bot. The stale corpse is closer and
    // fresher-looking by distance, but the CHEST source wins by priority.
    const both = scoreMacroGoals(
      baseInputs({
        heardChest: { x: 4000, y: 4000, tick: 3595 },
        heardElimination: { x: 6000, y: 5200, tick: 3300 },
      }),
    );
    const loot = pickKind(both, 'LOOT_CLUSTER');
    expect(loot).toBeDefined();
    expect(loot!.x).toBe(4000);
    expect(loot!.y).toBe(4000);
  });
});

describe('QUIET_SIDE — the decaying danger memory interaction (ticket 07 + 09)', () => {
  // Ring points: nextX/Y 5120, ringR = max(240, 2400*0.55) = 1320. The eight
  // candidates sit at 45° steps around the ring. A fight on the EAST side
  // makes the WEST point the quiet side; danger memory at the WEST point
  // must flip the choice EAST-ward (away from the killing field).
  const eastFight = [{ x: 5120 + 1320, y: 5120, strength: 0.8 }];

  it('picks the far side of a fight without danger memory (ticket-07 baseline)', () => {
    const quiet = pickKind(scoreMacroGoals(baseInputs({ fightPoints: eastFight })), 'QUIET_SIDE');
    expect(quiet).toBeDefined();
    expect(quiet!.x).toBeLessThan(5120); // west of center
  });

  it('bends AWAY from the sector where deaths cluster', () => {
    // Danger pressure at the WEST candidate point (the would-be quiet side).
    const dangerAt = (x: number, _y: number): number => (x < 5120 ? 1.5 : 0);
    const quiet = pickKind(
      scoreMacroGoals(baseInputs({ fightPoints: eastFight, dangerAt })),
      'QUIET_SIDE',
    );
    expect(quiet).toBeDefined();
    // The west point is now penalized (0.5 weight × 1.5 pressure > the
    // density spread) — the quiet side flips to the east-of-center band.
    expect(quiet!.x).toBeGreaterThan(5120);
  });

  it('no danger read → identical to the baseline choice (null tolerance)', () => {
    const a = pickKind(scoreMacroGoals(baseInputs({ fightPoints: eastFight })), 'QUIET_SIDE');
    const b = pickKind(
      scoreMacroGoals(baseInputs({ fightPoints: eastFight, dangerAt: null })),
      'QUIET_SIDE',
    );
    expect(a!.x).toBe(b!.x);
    expect(a!.y).toBe(b!.y);
    expect(a!.score).toBeCloseTo(b!.score, 12);
  });
});
