import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext } from '../../../src/ai/BotContext.ts';
import type { EnemyInfo } from '../../../src/ai/BotContext.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
  type SkillKnobs,
} from '../../../src/ai/intent/PersonalityProfile.ts';
import type { StimulusScanView } from '../../../src/ai/stimulus/StimulusScan.ts';
import { createReactorBotState } from '../../../src/ai/reactor/ReactorTypes.ts';
import {
  computeOutsideLethalZone,
  detectDamageStartle,
  detectExplosionHeard,
  detectImminentDeath,
  detectIncomingProjectile,
  detectTopReaction,
  detectWindupThreat,
} from '../../../src/ai/reactor/ReactorConditions.ts';

/**
 * Reactor condition checks — the pure seam (DEC-004): "given a context +
 * stimuli, which reaction fires". Each detector is a flag read over the
 * bot's published perception/stimulus state; these tests pin the firing
 * rules, the gates, and the UN-GATING of the windup reaction (no caution
 * threshold — every archetype reacts).
 */

const TILE = 128;

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  const ctx = new BotContext('cond-bot');
  ctx.x = 0;
  ctx.y = 0;
  ctx.tick = 100;
  ctx.zoneCenterX = 0;
  ctx.zoneCenterY = 0;
  ctx.zoneRadius = 500;
  ctx.zoneSafeX = 0;
  ctx.zoneSafeY = 0;
  Object.assign(ctx, overrides);
  return ctx;
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 100,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.LONG_SWORD, // range 224, windup 200ms = 12 ticks
    weaponTier: 0,
    isInWindup: true,
    windupRemaining: 12,
    lastAttackTick: -9999,
    facingAngle: Math.PI / 2, // facing +Y (toward a bot at y=100)
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

/** Elite knobs by default (0 latency — the skill gate never blocks). */
function knobs(overrides: Partial<SkillKnobs> = {}): SkillKnobs {
  return { aimErrorMultiplier: 1.0, reactionLatencyTicks: 0, commitMultiplier: 1.0, ...overrides };
}

function scanWith(
  explosion: { tick: number; x: number; y: number; strength: number } | null,
): StimulusScanView {
  const view: StimulusScanView = {
    entries: [],
    strongestByType: {},
    heardFightX: 0,
    heardFightY: 0,
    heardFightTick: -9999,
  };
  if (explosion) {
    const decayed = {
      type: 'explosion' as const,
      worldX: explosion.x,
      worldY: explosion.y,
      tick: explosion.tick,
      strength: explosion.strength,
      effectiveStrength: explosion.strength,
    };
    view.entries.push(decayed);
    view.strongestByType.explosion = decayed;
  }
  return view;
}

describe('detectImminentDeath (priority 1)', () => {
  it('fires when a pending siege-wall warning sits on the bot own tile', () => {
    const ctx = makeCtx({ x: TILE / 2, y: TILE / 2, siegeWarnings: [{ x: 0, y: 0 }] });
    const trigger = detectImminentDeath(ctx, createReactorBotState(), true, TILE);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe('imminentDeath');
    expect(trigger!.threatX).toBeNull(); // escape direction is zone-safe, not a threat
  });

  it('does not fire for a warning on an adjacent tile (crush tile only)', () => {
    const ctx = makeCtx({ x: TILE / 2, y: TILE / 2, siegeWarnings: [{ x: 1, y: 0 }] });
    expect(detectImminentDeath(ctx, createReactorBotState(), true, TILE)).toBeNull();
  });

  it('fires ONCE on the lethal-zone crossing (rising edge), not continuously', () => {
    // PURE-SEAM NOTE (review M3): the edge memory is written by the REACTOR
    // at the END of every tick (runReactionTick's finally) — the detector
    // only READS it as the previous tick's exposure. This seam test simulates
    // that write after each detector call; the every-tick/no-freeze behavior
    // is pinned at the reactor level in BotReactor.test.ts.
    const ctx = makeCtx({ x: 600, y: 0 }); // 600 > radius 500 → outside
    const st = createReactorBotState();
    expect(detectImminentDeath(ctx, st, true, TILE)).not.toBeNull();
    st.wasOutsideLethalZone = computeOutsideLethalZone(ctx, true); // end of tick
    // Still outside next tick: edge consumed — steady-state fleeing is the
    // SURVIVE_ZONE intent's job, not a per-tick reactor spike.
    expect(detectImminentDeath(ctx, st, true, TILE)).toBeNull();
    // Re-enter safety (memory flips back via the end-of-tick write)…
    ctx.x = 0;
    expect(detectImminentDeath(ctx, st, true, TILE)).toBeNull();
    st.wasOutsideLethalZone = computeOutsideLethalZone(ctx, true); // end of tick
    // …then cross again → fresh edge fires again.
    ctx.x = 600;
    expect(detectImminentDeath(ctx, st, true, TILE)).not.toBeNull();
  });

  it('computeOutsideLethalZone: pure exposure predicate (radius 0 / harmless zone / distance)', () => {
    const ctx = makeCtx({ x: 600, y: 0 });
    expect(computeOutsideLethalZone(ctx, true)).toBe(true); // 600 > 500
    expect(computeOutsideLethalZone(ctx, false)).toBe(false); // zone deals no damage
    ctx.zoneRadius = 0;
    expect(computeOutsideLethalZone(ctx, true)).toBe(false); // no geometry
    ctx.zoneRadius = 700;
    expect(computeOutsideLethalZone(ctx, true)).toBe(false); // inside
  });

  it('does not fire outside a harmless zone (phase < 2 deals no damage)', () => {
    const ctx = makeCtx({ x: 600, y: 0 });
    expect(detectImminentDeath(ctx, createReactorBotState(), false, TILE)).toBeNull();
  });
});

describe('detectIncomingProjectile (priority 2)', () => {
  it('fires for a projectile closing on the bot hitbox (perp within margin)', () => {
    const ctx = makeCtx({
      projectiles: [{ id: 'p1', x: -200, y: 0, vx: 20, vy: 0, distance: 200 }],
    });
    const trigger = detectIncomingProjectile(ctx, createReactorBotState());
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe('projectile');
    expect(trigger!.subjectId).toBe('p1');
  });

  it('does not fire for a receding projectile', () => {
    const ctx = makeCtx({
      projectiles: [{ id: 'p1', x: 200, y: 0, vx: 20, vy: 0, distance: 200 }],
    });
    expect(detectIncomingProjectile(ctx, createReactorBotState())).toBeNull();
  });

  it('does not fire for a projectile passing wide of the hitbox', () => {
    // Perp distance 60 > margin 56 → not an intercept course.
    const ctx = makeCtx({
      projectiles: [{ id: 'p1', x: -200, y: 60, vx: 20, vy: 0, distance: 212 }],
    });
    expect(detectIncomingProjectile(ctx, createReactorBotState())).toBeNull();
  });

  it('does not fire for an impact beyond the horizon', () => {
    // 900px away at 20px/tick = 45 ticks > horizon 30.
    const ctx = makeCtx({
      projectiles: [{ id: 'p1', x: -900, y: 0, vx: 20, vy: 0, distance: 900 }],
    });
    expect(detectIncomingProjectile(ctx, createReactorBotState())).toBeNull();
  });

  it('reacts once per projectile (dedupe by id)', () => {
    const ctx = makeCtx({
      projectiles: [{ id: 'p1', x: -200, y: 0, vx: 20, vy: 0, distance: 200 }],
    });
    const st = createReactorBotState();
    expect(detectIncomingProjectile(ctx, st)).not.toBeNull();
    st.reactedProjectiles.add('p1');
    expect(detectIncomingProjectile(ctx, st)).toBeNull();
  });
});

describe('detectDamageStartle (priority 3)', () => {
  // TICKET-05 UPDATE (DEC-003): the startle origin is now the DAMAGE-
  // DIRECTION BELIEF (ctx.lastDamageBelief* — an estimated position written
  // by the stimulus router), replacing the retired nearest-enemy
  // attribution (ctx.lastDamageFrom*, removed with the misattribution it
  // embodied — AUDIT §3.3.1). The assertions are otherwise unchanged.
  it('fires on a fresh damage edge, once per hit, facing the belief estimate', () => {
    const ctx = makeCtx({
      lastDamageTick: 99,
      lastDamageBeliefX: 50,
      lastDamageBeliefY: 50,
      lastDamageBeliefTick: 99,
    });
    const st = createReactorBotState();
    const trigger = detectDamageStartle(ctx, st);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe('startle');
    expect(trigger!.stimulusTick).toBe(99);
    expect(trigger!.threatX).toBe(50); // the believed (estimated) origin
    st.lastReactedDamageTick = 99;
    expect(detectDamageStartle(ctx, st)).toBeNull();
  });

  it('does not fire on a stale damage tick (the flinch window passed)', () => {
    const ctx = makeCtx({ lastDamageTick: 90 }); // 10 ticks old at tick 100
    expect(detectDamageStartle(ctx, createReactorBotState())).toBeNull();
  });

  it('fires with a null threat when no estimable direction exists (no belief)', () => {
    const ctx = makeCtx({ lastDamageTick: 100 }); // never wrote a belief
    const trigger = detectDamageStartle(ctx, createReactorBotState());
    expect(trigger).not.toBeNull();
    expect(trigger!.threatX).toBeNull();
    expect(trigger!.threatY).toBeNull();
  });
});

describe('detectExplosionHeard (priority 4)', () => {
  it('fires for a strong, fresh explosion stimulus', () => {
    const ctx = makeCtx();
    const scan = scanWith({ tick: 95, x: 300, y: 0, strength: 0.8 });
    const trigger = detectExplosionHeard(ctx, scan, createReactorBotState());
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe('explosion');
    expect(trigger!.stimulusTick).toBe(95);
    expect(trigger!.threatX).toBe(300);
  });

  it('does not fire for a weak or stale explosion', () => {
    const ctx = makeCtx();
    expect(
      detectExplosionHeard(
        ctx,
        scanWith({ tick: 95, x: 300, y: 0, strength: 0.2 }),
        createReactorBotState(),
      ),
    ).toBeNull();
    expect(
      detectExplosionHeard(
        ctx,
        scanWith({ tick: 60, x: 300, y: 0, strength: 0.9 }),
        createReactorBotState(),
      ),
    ).toBeNull();
  });

  it('reacts once per explosion (dedupe by stimulus identity)', () => {
    const ctx = makeCtx();
    const scan = scanWith({ tick: 95, x: 300, y: 0, strength: 0.8 });
    const st = createReactorBotState();
    expect(detectExplosionHeard(ctx, scan, st)).not.toBeNull();
    st.reactedExplosionKeys.add(`boom:95:300:0`);
    expect(detectExplosionHeard(ctx, scan, st)).toBeNull();
  });

  it('returns null with no scan view (stimulus system absent)', () => {
    expect(detectExplosionHeard(makeCtx(), undefined, createReactorBotState())).toBeNull();
  });
});

describe('detectWindupThreat (priority 5 — UN-GATED from personality)', () => {
  // Bot at (0,100); enemy at (0,0) facing +Y with a 12-tick Long Sword windup.
  function windupCtx(): BotContext {
    return makeCtx({ x: 0, y: 100, nearestEnemy: enemy() });
  }

  it('fires for EVERY archetype — low caution no longer suppresses the reaction', () => {
    // THE un-gating pin (DEC-010.2): the retired shouldDodgeWindup returned
    // null below caution 0.55; the reactor windup reaction must fire for all
    // five archetypes, including an extreme AGGRESSOR-shaped profile (caution
    // 0.05, the clamp floor).
    const ALL_ARCHETYPES: PersonalityArchetype[] = [
      PersonalityArchetype.AGGRESSOR,
      PersonalityArchetype.SCAVENGER,
      PersonalityArchetype.TRAPPER,
      PersonalityArchetype.DUELIST,
      PersonalityArchetype.SURVIVOR,
    ];
    for (const archetype of ALL_ARCHETYPES) {
      const profile = new PersonalityProfile(
        archetype,
        { aggression: 0.98, greed: 0.05, caution: 0.05, opportunism: 0.5, trapper: 0.05 },
        knobs(),
        'hard',
      );
      const trigger = detectWindupThreat(windupCtx(), createReactorBotState(), profile);
      expect(
        trigger,
        `archetype ${PersonalityArchetype[archetype]} must react to windups`,
      ).not.toBeNull();
    }
  });

  it('keeps the SKILL gate: a slow bot cannot react to a short windup', () => {
    const profile = new PersonalityProfile(
      PersonalityArchetype.SURVIVOR,
      { aggression: 0.5, greed: 0.5, caution: 0.9, opportunism: 0.5, trapper: 0.5 },
      knobs({ reactionLatencyTicks: 8 }),
      'easy',
    );
    // 6 remaining ≤ 8 latency + 2 lead → unreactable (fast weapons beat slow bots).
    const ctx = makeCtx({
      x: 0,
      y: 100,
      nearestEnemy: enemy({ windupRemaining: 6 }),
    });
    expect(detectWindupThreat(ctx, createReactorBotState(), profile)).toBeNull();
  });

  it('keeps the THREAT gates: swing aimed away / out of enemy reach → null', () => {
    const profile = new PersonalityProfile(
      PersonalityArchetype.AGGRESSOR,
      { aggression: 0.9, greed: 0.3, caution: 0.2, opportunism: 0.6, trapper: 0.3 },
      knobs(),
      'hard',
    );
    // Facing -Y (away from the bot at y=100).
    const away = makeCtx({
      x: 0,
      y: 100,
      nearestEnemy: enemy({ facingAngle: -Math.PI / 2 }),
    });
    expect(detectWindupThreat(away, createReactorBotState(), profile)).toBeNull();
    // 250px > Long Sword 224 × 1.1 = 246.4 → outside the swing's reach.
    const far = makeCtx({
      x: 0,
      y: 250,
      nearestEnemy: enemy({ distance: 250 }),
    });
    expect(detectWindupThreat(far, createReactorBotState(), profile)).toBeNull();
  });

  it('reacts once per windup EPISODE (per-enemy cooldown)', () => {
    const profile = new PersonalityProfile(
      PersonalityArchetype.DUELIST,
      { aggression: 0.75, greed: 0.25, caution: 0.4, opportunism: 0.55, trapper: 0.25 },
      knobs(),
      'hard',
    );
    const st = createReactorBotState();
    expect(detectWindupThreat(windupCtx(), st, profile)).not.toBeNull();
    st.windupReactTicks.set('e1', 100); // reacted this tick
    expect(detectWindupThreat(windupCtx(), st, profile)).toBeNull();
    // A new episode (30+ ticks later) reacts again.
    const later = windupCtx();
    later.tick = 131;
    expect(detectWindupThreat(later, st, profile)).not.toBeNull();
  });
});

describe('detectTopReaction (the priority walk)', () => {
  it('returns the highest-priority trigger: projectile beats windup', () => {
    const ctx = makeCtx({
      x: 0,
      y: 100,
      projectiles: [{ id: 'p1', x: -200, y: 100, vx: 20, vy: 0, distance: 200 }],
      nearestEnemy: enemy(),
    });
    const profile = new PersonalityProfile(
      PersonalityArchetype.SURVIVOR,
      { aggression: 0.3, greed: 0.5, caution: 0.85, opportunism: 0.45, trapper: 0.35 },
      knobs(),
      'hard',
    );
    const trigger = detectTopReaction(
      ctx,
      scanWith(null),
      createReactorBotState(),
      profile,
      false,
      TILE,
    );
    expect(trigger!.type).toBe('projectile');
  });

  it('imminent death beats everything (zone crossing + projectile + windup)', () => {
    const ctx = makeCtx({
      x: 600,
      y: 0,
      zoneRadius: 500,
      projectiles: [{ id: 'p1', x: 400, y: 0, vx: 20, vy: 0, distance: 200 }],
      nearestEnemy: enemy({ x: 600, y: 100, distance: 100, facingAngle: -Math.PI / 2 }),
    });
    const profile = new PersonalityProfile(
      PersonalityArchetype.SCAVENGER,
      { aggression: 0.35, greed: 0.85, caution: 0.55, opportunism: 0.5, trapper: 0.3 },
      knobs(),
      'hard',
    );
    const trigger = detectTopReaction(
      ctx,
      scanWith(null),
      createReactorBotState(),
      profile,
      true,
      TILE,
    );
    expect(trigger!.type).toBe('imminentDeath');
  });
});
