import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, BotState, type EnemyInfo } from '../../../src/ai/BotContext.ts';
import type { BotSystem } from '../../../src/ai/BotSystem.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
  type DifficultyLevel,
  type PersonalityWeights,
  type SkillKnobs,
} from '../../../src/ai/intent/PersonalityProfile.ts';
import { IntentSelector } from '../../../src/ai/intent/IntentSelector.ts';
import { buildPhase2Intents } from '../../../src/ai/intent/intents.ts';
import { BotBelievabilityCounters } from '../../../src/ai/BotBelievability.ts';
import {
  pursueBelievedEnemy,
  runBeliefScan,
  writeDamageDirectionBelief,
  writeHeardBelief,
  dropEliminatedBelief,
} from '../../../src/ai/belief/BeliefUpdate.ts';
import {
  DAMAGE_CONFIDENCE,
  DAMAGE_NO_DIRECTION_CONFIDENCE,
  HEARD_CONFIDENCE,
  SEARCH_FAILURE_TICKS,
} from '../../../src/ai/belief/BeliefConfig.ts';
import { angleFromFacingAbs, foveationNoiseScale } from '../../../src/ai/belief/BeliefMath.ts';

/**
 * BeliefUpdate — the believed-state mutation layer (bot-ai-v2 ticket 05,
 * DEC-003). Runs against REAL BotContexts + a structural BotSystem stub
 * (skill trackers + selectors + a controllable-LOS pathfinder) — no room.
 * Every scenario is byte-deterministic: the only RNG draws come from the
 * per-bot stream seeded by playerId.
 */

function weights(w: Partial<PersonalityWeights> = {}): PersonalityWeights {
  return { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5, ...w };
}

function skill(k: Partial<SkillKnobs> = {}): SkillKnobs {
  return { aimErrorMultiplier: 1.0, reactionLatencyTicks: 0, commitMultiplier: 1.0, ...k };
}

function rig(playerId: string, difficulty: DifficultyLevel = 'hard') {
  const ctx = new BotContext(playerId);
  ctx.tick = 100;
  ctx.x = 0;
  ctx.y = 0;
  ctx.facingAngle = 0;
  const counters = new BotBelievabilityCounters();
  const selector = new IntentSelector(buildPhase2Intents());
  let los = true;
  const system = {
    skillTrackers: new Map([[playerId, { believability: counters }]]),
    selectors: new Map([[playerId, selector]]),
    pathfinder: { hasLineOfSightWorld: () => los },
  } as unknown as BotSystem;
  const profile = new PersonalityProfile(
    PersonalityArchetype.DUELIST,
    weights(),
    skill(),
    difficulty,
  );
  return { ctx, counters, selector, system, profile, setLos: (v: boolean) => (los = v) };
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 300,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 300,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.DAGGER,
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

describe('seen beliefs (foveated per-scan writes)', () => {
  it('writes an exact-position, high-confidence belief for a facing-sector sighting in detection range', () => {
    // Hard difficulty: 300px is inside the 512px detection range, the enemy is
    // straight ahead (angle 0 → ZERO foveation noise scale), LOS clear.
    const { ctx, counters, system, profile } = rig('belief-seen-a', 'hard');
    ctx.enemies = [enemy()];
    runBeliefScan(system, ctx, profile);
    const b = ctx.beliefs.get('e1')!;
    expect(b).toBeDefined();
    expect(b.x).toBe(300); // zero noise scale → exact position
    expect(b.y).toBe(0);
    expect(b.source).toBe('seen');
    expect(b.tick).toBe(100);
    expect(b.confidence).toBeCloseTo(0.9, 10); // hard convergence ramp from no prior
    expect(counters.beliefs.writesBySource.seen).toBe(1);
    expect(counters.beliefs.writesTotal).toBe(1);
  });

  it('peripheral + LOS-blocked + beyond-range sightings decay into low-confidence noised beliefs', () => {
    // Easy difficulty, enemy 600px BEHIND (facing west π, enemy east), LOS
    // blocked: the GDD §14.2 range fade × the §14.3 halving compose into a
    // low sample, and the position carries foveation noise bounded by the scale.
    const { ctx, counters, system, profile, setLos } = rig('belief-seen-b', 'easy');
    setLos(false);
    ctx.facingAngle = Math.PI; // facing west — the enemy at +600 is directly behind
    ctx.enemies = [enemy({ x: 600, distance: 600 })];
    runBeliefScan(system, ctx, profile);
    const b = ctx.beliefs.get('e1')!;
    expect(b.confidence).toBeLessThan(0.35); // easy ramp on a faded+halved sample
    expect(b.confidence).toBeGreaterThan(0.05);
    const scale = foveationNoiseScale(
      angleFromFacingAbs(ctx.facingAngle, 600, 0, 0, 0),
      600,
      'easy',
    );
    expect(scale).toBeGreaterThan(0);
    expect(Math.abs(b.x - 600)).toBeLessThanOrEqual(scale + 1e-9);
    expect(Math.abs(b.y)).toBeLessThanOrEqual(scale + 1e-9);
    expect(counters.beliefs.writesBySource.seen).toBe(1);
  });

  it('converges back toward truth on re-acquisition, FASTER at higher difficulty', () => {
    const hard = rig('belief-conv-hard', 'hard');
    const easy = rig('belief-conv-easy', 'easy');
    const scan = (r: ReturnType<typeof rig>, tick: number): number => {
      r.ctx.tick = tick;
      r.ctx.enemies = [enemy()];
      runBeliefScan(r.system, r.ctx, r.profile);
      return r.ctx.beliefs.get('e1')!.confidence;
    };
    const hardC1 = scan(hard, 100);
    const easyC1 = scan(easy, 100);
    expect(hardC1).toBeGreaterThanOrEqual(0.9);
    expect(easyC1).toBeLessThan(0.5);
    let easyC = easyC1;
    for (let tick = 103; tick <= 100 + 5 * 3; tick += 3) easyC = scan(easy, tick);
    expect(easyC).toBeLessThan(0.95); // easy still closing after 5 scans
    const hardC2 = scan(hard, 103);
    expect(hardC2).toBeGreaterThan(0.95); // hard is ~certain after 2
    expect(hardC2).toBeGreaterThan(easyC);
  });
});

describe('heard beliefs (attack-stimulus seats)', () => {
  it('writes a low-confidence belief about the firer at the stimulus seat', () => {
    const { ctx, counters } = rig('belief-heard-a');
    writeHeardBelief(ctx, counters.beliefs, 'firer', 500, 400, 120);
    const b = ctx.beliefs.get('firer')!;
    expect(b.x).toBe(500);
    expect(b.y).toBe(400);
    expect(b.confidence).toBe(HEARD_CONFIDENCE);
    expect(b.source).toBe('heard');
    expect(counters.beliefs.writesBySource.heard).toBe(1);
  });

  it('a 2-tick-old seen belief does NOT starve the heard channel (stride-3 scans)', () => {
    // Regression pin (validation sweep): the seen-preemption window was 3
    // ticks — exactly the perception scan stride — so with the attack hearing
    // radius (900px) inside the perception range (1000px), EVERY heard firer
    // was seen within 3 ticks and the channel wrote 0 beliefs across a full
    // 24-bot match (belief-pursuit-termination e2e red). "Just seen" means
    // the freshest class (0-1 ticks): a 2-tick-old foveated sighting must
    // yield to the heard seat (the firer's TRUE fire position).
    const { ctx, counters, system, profile } = rig('belief-heard-stride');
    ctx.enemies = [enemy()];
    ctx.tick = 120;
    runBeliefScan(system, ctx, profile);
    expect(ctx.beliefs.get('e1')!.source).toBe('seen');
    writeHeardBelief(ctx, counters.beliefs, 'e1', 700, 700, 122); // gap 2
    const b = ctx.beliefs.get('e1')!;
    expect(b.source).toBe('heard');
    expect(b.tick).toBe(122);
    expect(counters.beliefs.writesBySource.heard).toBe(1);
  });

  it('never downgrades fresher data: stale or just-seen beliefs win', () => {
    const { ctx, counters, system, profile } = rig('belief-heard-b');
    writeHeardBelief(ctx, counters.beliefs, 'e1', 500, 400, 120);
    // An older tick is stale-ordered — skipped.
    writeHeardBelief(ctx, counters.beliefs, 'e1', 900, 900, 119);
    expect(ctx.beliefs.get('e1')!.tick).toBe(120);
    expect(ctx.beliefs.get('e1')!.source).toBe('heard');
    expect(counters.beliefs.writesBySource.heard).toBe(1); // the second write did not land
    // A fresh SEEN belief (within 3 ticks) is better data — the heard write is skipped.
    ctx.enemies = [enemy()];
    ctx.tick = 123;
    runBeliefScan(system, ctx, profile);
    expect(ctx.beliefs.get('e1')!.source).toBe('seen');
    writeHeardBelief(ctx, counters.beliefs, 'e1', 700, 700, 124);
    expect(ctx.beliefs.get('e1')!.source).toBe('seen');
    expect(counters.beliefs.writesBySource.heard).toBe(1);
  });
});

describe('damage-direction beliefs (the estimated origin)', () => {
  it('writes an ESTIMATED attacker position — direction envelope, low confidence, belief seam', () => {
    const { ctx, counters } = rig('belief-dmg-a');
    // Victim at (0,0), knockback says the attacker is EAST (dir 1,0).
    writeDamageDirectionBelief(ctx, counters.beliefs, 'sniper', 100, 0, 0, 1, 0);
    const b = ctx.beliefs.get('sniper')!;
    expect(b.source).toBe('damage');
    expect(b.confidence).toBe(DAMAGE_CONFIDENCE);
    expect(b.confidence).toBeLessThan(0.5); // LOW confidence by design
    const dx = b.x - 0;
    const dy = b.y - 0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    expect(dist).toBeGreaterThanOrEqual(220);
    expect(dist).toBeLessThanOrEqual(700);
    expect(Math.abs(Math.atan2(dy, dx))).toBeLessThanOrEqual(0.5 + 1e-9);
    // The Reactor's startle seam publishes the same estimate.
    expect(ctx.lastDamageBeliefX).toBe(b.x);
    expect(ctx.lastDamageBeliefY).toBe(b.y);
    expect(ctx.lastDamageBeliefTick).toBe(100);
    expect(counters.beliefs.writesBySource.damage).toBe(1);
  });

  it('is deterministic per bot (same playerId → same estimate) and sourceless without direction', () => {
    const a = rig('belief-dmg-det');
    const b = rig('belief-dmg-det');
    writeDamageDirectionBelief(a.ctx, a.counters.beliefs, 's', 100, 0, 0, 1, 0);
    writeDamageDirectionBelief(b.ctx, b.counters.beliefs, 's', 100, 0, 0, 1, 0);
    expect(a.ctx.lastDamageBeliefX).toBe(b.ctx.lastDamageBeliefX);
    expect(a.ctx.lastDamageBeliefY).toBe(b.ctx.lastDamageBeliefY);
    // No knockback direction: the belief collapses to the victim's position.
    const c = rig('belief-dmg-none');
    writeDamageDirectionBelief(c.ctx, c.counters.beliefs, 's', 100, 40, 40, 0, 0);
    expect(c.ctx.beliefs.get('s')!.x).toBe(40);
    expect(c.ctx.beliefs.get('s')!.confidence).toBe(DAMAGE_NO_DIRECTION_CONFIDENCE);
  });

  it('keeps a JUST-SEEN attacker belief (visible truth beats the estimate) but still publishes the flinch origin', () => {
    const { ctx, counters, system, profile } = rig('belief-dmg-seen');
    ctx.enemies = [enemy({ id: 'sniper', x: 300 })];
    ctx.tick = 100;
    runBeliefScan(system, ctx, profile); // fresh seen belief on 'sniper' at tick 100
    writeDamageDirectionBelief(ctx, counters.beliefs, 'sniper', 101, 0, 0, 1, 0);
    const b = ctx.beliefs.get('sniper')!;
    expect(b.source).toBe('seen'); // not downgraded to a damage estimate
    expect(b.confidence).toBeGreaterThan(DAMAGE_CONFIDENCE);
    // The startle still faces where the hit came from.
    expect(ctx.lastDamageBeliefTick).toBe(101);
    expect(counters.beliefs.writesBySource.damage).toBe(1);
  });
});

describe('pursuits + search-failure memory (the suspension extension)', () => {
  function openHeardPursuit(r: ReturnType<typeof rig>, id = 'e1'): void {
    writeHeardBelief(r.ctx, r.counters.beliefs, id, 500, 400, 100);
    const p = pursueBelievedEnemy(r.ctx, r.counters.beliefs);
    expect(p).not.toBeNull();
    expect(p!.id).toBe(id);
  }

  it('opens a pursuit on the freshest out-of-scan above-threshold belief', () => {
    const r = rig('belief-purs-a');
    openHeardPursuit(r);
    expect(r.ctx.pursuitTargetId).toBe('e1');
    expect(r.ctx.pursuitStartTick).toBe(100);
    expect(r.ctx.beliefs.exemptId).toBe('e1');
    expect(r.counters.beliefs.pursuitsStarted).toBe(1);
    // Re-calling is idempotent while the same pursuit is open.
    pursueBelievedEnemy(r.ctx, r.counters.beliefs);
    expect(r.counters.beliefs.pursuitsStarted).toBe(1);
  });

  it('never pursues an enemy that is IN the current scan (ground truth owns it)', () => {
    const r = rig('belief-purs-inscan');
    r.ctx.enemies = [enemy()]; // e1 visible right now
    r.ctx.tick = 100;
    writeHeardBelief(r.ctx, r.counters.beliefs, 'e1', 500, 400, 100);
    expect(pursueBelievedEnemy(r.ctx, r.counters.beliefs)).toBeNull();
    expect(r.ctx.pursuitTargetId).toBeNull();
  });

  it('skips below-threshold beliefs (decayed memories are not worth investigating)', () => {
    const r = rig('belief-purs-low');
    writeHeardBelief(r.ctx, r.counters.beliefs, 'e1', 500, 400, 100);
    const b = r.ctx.beliefs.get('e1')!;
    b.confidence = 0.19; // below PURSUIT_MIN_CONFIDENCE (0.2)
    expect(pursueBelievedEnemy(r.ctx, r.counters.beliefs)).toBeNull();
  });

  it('REVENGE-PURSUIT TERMINATION: drops + suspends the family after ~90 failed ticks', () => {
    const r = rig('belief-purs-fail');
    openHeardPursuit(r);
    r.ctx.state = BotState.HUNT;
    // Investigating scans at the perception cadence — the bound is ~90 ticks:
    // at exactly SEARCH_FAILURE_TICKS elapsed the pursuit is STILL open…
    let dropped = false;
    for (let t = 103; t <= 100 + SEARCH_FAILURE_TICKS; t += 3) {
      r.ctx.tick = t;
      r.ctx.enemies = [];
      runBeliefScan(r.system, r.ctx, r.profile);
      if (r.ctx.pursuitTargetId === null) {
        dropped = true;
        break;
      }
    }
    expect(dropped).toBe(false); // no premature drop inside the window
    // …and one scan past it the investigation is over: belief deleted…
    r.ctx.tick = 100 + SEARCH_FAILURE_TICKS + 3;
    runBeliefScan(r.system, r.ctx, r.profile);
    expect(r.ctx.pursuitTargetId).toBeNull();
    expect(r.ctx.beliefs.get('e1')).toBeUndefined();
    expect(r.counters.beliefs.pursuitsDropped).toBe(1);
    // …the pursuing intent family is SUSPENDED (the goal-suspension mechanism
    // extended from goals to targets — selector.suspend, same as stalls)…
    expect(r.selector.suspensionsIssued).toBe(1);
    expect(r.counters.suspensionsByFamily['HUNT']).toBe(1);
    expect(r.counters.suspensionsByReason['search-failure']).toBe(1);
    expect(r.counters.suspensionsByReason['stall']).toBeUndefined();
    // …and the exemption cleared.
    expect(r.ctx.beliefs.exemptId).toBeNull();
  });

  it('RE-ACQUISITION closes the pursuit as a success and converges the belief', () => {
    const r = rig('belief-purs-reacq');
    openHeardPursuit(r);
    r.ctx.tick = 110;
    r.ctx.enemies = [enemy()]; // the investigated enemy walks back into scan
    runBeliefScan(r.system, r.ctx, r.profile);
    expect(r.ctx.pursuitTargetId).toBeNull();
    expect(r.counters.beliefs.pursuitsReacquired).toBe(1);
    expect(r.counters.beliefs.pursuitsDropped).toBe(0);
    expect(r.ctx.beliefs.get('e1')!.source).toBe('seen'); // converged on truth
  });

  it('target ELIMINATION drops the belief and closes an open pursuit', () => {
    const r = rig('belief-purs-elim');
    openHeardPursuit(r, 'e2');
    dropEliminatedBelief(r.ctx, r.counters.beliefs, 'e2');
    expect(r.ctx.beliefs.get('e2')).toBeUndefined();
    expect(r.ctx.pursuitTargetId).toBeNull();
    expect(r.counters.beliefs.pursuitsDropped).toBe(1);
  });

  it('unpursued beliefs expire with age (bounded memory)', () => {
    const r = rig('belief-expiry');
    r.ctx.enemies = [enemy()];
    runBeliefScan(r.system, r.ctx, r.profile); // seen belief at tick 100
    expect(r.ctx.beliefs.get('e1')).toBeDefined();
    r.ctx.tick = 100 + 481; // past the absolute age cap
    r.ctx.enemies = [];
    runBeliefScan(r.system, r.ctx, r.profile);
    expect(r.ctx.beliefs.get('e1')).toBeUndefined();
  });
});
