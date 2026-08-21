import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext } from '../../../src/ai/BotContext.ts';
import type { EnemyInfo } from '../../../src/ai/BotContext.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
} from '../../../src/ai/intent/PersonalityProfile.ts';
import type { StimulusScanView } from '../../../src/ai/stimulus/StimulusScan.ts';
import {
  ARCHETYPE_DISCRETION,
  DISENGAGE_COOLDOWN_TICKS,
  evaluateDisengage,
  incomingThreatCount,
} from '../../../src/ai/combat/DiscretionTables.ts';

/**
 * Engagement discretion — the per-archetype data table + the four trigger
 * evaluations (DEC-010.3). Each trigger fires on its own cause; the
 * kill-secure suppression and cooldown hold; the archetype scaling differs
 * (the Marcus-dissent no-passivity-collapse guard).
 */

function makeCtx(): BotContext {
  const ctx = new BotContext('disc-bot');
  ctx.tick = 1000;
  ctx.x = 0;
  ctx.y = 0;
  ctx.health = 100;
  ctx.maxHealth = 100;
  return ctx;
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
    weaponTier: 1,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    facingAngle: Math.PI, // facing the bot at origin
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

function profileFor(archetype: PersonalityArchetype): PersonalityProfile {
  return new PersonalityProfile(
    archetype,
    { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5 },
    { aimErrorMultiplier: 1.0, reactionLatencyTicks: 3, commitMultiplier: 1.0 },
  );
}

const SCAN: StimulusScanView = {
  entries: [],
  strongestByType: {},
  heardFightX: 0,
  heardFightY: 0,
  heardFightTick: -9999,
};

function scanWithAttack(x: number, y: number, tick: number, source?: string): StimulusScanView {
  return {
    entries: [
      {
        type: 'attack',
        worldX: x,
        worldY: y,
        tick,
        strength: 0.7,
        effectiveStrength: 0.7,
        ...(source !== undefined ? { sourcePlayerId: source } : {}),
      },
    ],
    strongestByType: {},
    heardFightX: x,
    heardFightY: y,
    heardFightTick: tick,
  };
}

describe('incomingThreatCount — the outnumbered aggregation', () => {
  it('counts enemies engaged with me (deriveEngagement flag)', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy({ id: 'a', engagedTargetId: ctx.playerId }));
    ctx.enemies.push(enemy({ id: 'b', engagedTargetId: 'someone-else' }));
    expect(incomingThreatCount(ctx)).toBe(1);
  });

  it('counts recent attackers facing me', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: 0 }), // facing away
      enemy({ id: 'c', lastAttackTick: ctx.tick - 999 }), // too old
    );
    expect(incomingThreatCount(ctx)).toBe(1);
  });

  it('combines both sources (2v1)', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', engagedTargetId: ctx.playerId }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
    );
    expect(incomingThreatCount(ctx)).toBe(2);
  });
});

describe('evaluateDisengage — per-trigger unit checks (DUELIST row)', () => {
  it('hp: fires below the archetype floor', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.health = 15; // 0.15 < DUELIST floor 0.2
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBe('hp');
    ctx.health = 50; // above the floor → no hp cause
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });

  it('supply: fires when the active weapon is at/below critical uses', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.weapons = [
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      null,
      null,
      null,
    ];
    ctx.activeSlot = 1;
    ctx.weapons[1] = { weaponType: WeaponType.DAGGER, tier: 1, durability: 1, ammo: 1 };
    // DUELIST supplyCriticalHits = 1 → 1 remaining use is critical.
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBe('supply');
  });

  it('supply: does not fire on a healthy weapon', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.weapons = [
      { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 },
      { weaponType: WeaponType.DAGGER, tier: 1, durability: 20, ammo: 20 },
      null,
      null,
    ];
    ctx.activeSlot = 1;
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });

  it('thirdParty: fires on a fresh attack stimulus near me from a non-target', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    const scan = scanWithAttack(200, 0, ctx.tick - 5, 'stranger');
    expect(evaluateDisengage(ctx, scan, profileFor(PersonalityArchetype.DUELIST))).toBe(
      'thirdParty',
    );
  });

  it('thirdParty: suppressed when the stimulus is my own target firing', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    const scan = scanWithAttack(200, 0, ctx.tick - 5, 'e1'); // the target's gunfire
    expect(evaluateDisengage(ctx, scan, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });

  it('thirdParty: suppressed when the stimulus is stale or far', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    const stale = scanWithAttack(200, 0, ctx.tick - 500, 'stranger');
    expect(evaluateDisengage(ctx, stale, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
    const far = scanWithAttack(5000, 0, ctx.tick - 5, 'stranger');
    expect(evaluateDisengage(ctx, far, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });

  it('outnumbered: fires at 2 threats (2v1) for the DUELIST row', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', engagedTargetId: ctx.playerId }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
    );
    ctx.nearestEnemy = ctx.enemies[0]!;
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBe(
      'outnumbered',
    );
  });

  it('kill-secure suppression: no cause while the target is finishable', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', engagedTargetId: ctx.playerId, health: 10 }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
    );
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.health = 5; // would be 'hp' — but the target is kill-secureable
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });

  it('no fight, no discretion (a target-less bot never "disengages")', () => {
    const ctx = makeCtx();
    ctx.health = 5;
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
  });
});

describe('evaluateDisengage — archetype scaling (the dissent guard)', () => {
  it('SURVIVOR bails far earlier than AGGRESSOR on HP', () => {
    const ctx = makeCtx();
    ctx.enemies.push(enemy());
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.health = 30; // 0.30
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.SURVIVOR))).toBe('hp');
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.AGGRESSOR))).toBeNull();
  });

  it('AGGRESSOR needs 3 threats (outnumberedAt 3), not 2', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', engagedTargetId: ctx.playerId }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
    );
    ctx.nearestEnemy = ctx.enemies[0]!;
    const p = profileFor(PersonalityArchetype.AGGRESSOR);
    expect(evaluateDisengage(ctx, SCAN, p)).toBeNull();
    ctx.enemies.push(enemy({ id: 'c', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }));
    expect(evaluateDisengage(ctx, SCAN, p)).toBe('outnumbered');
  });

  it('the table scales every archetype (distinct rows, plausible bands)', () => {
    const rows = Object.values(ARCHETYPE_DISCRETION);
    expect(new Set(rows.map((r) => r.hpFloor)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.hpFloor).toBeGreaterThan(0);
      expect(r.hpFloor).toBeLessThan(0.5);
      expect(r.outnumberedAt).toBeGreaterThanOrEqual(2);
    }
    // AGGRESSOR is the most obstinate row on every axis.
    const agg = ARCHETYPE_DISCRETION[PersonalityArchetype.AGGRESSOR];
    for (const r of rows) {
      expect(agg.hpFloor).toBeLessThanOrEqual(r.hpFloor);
      expect(agg.thirdPartyRadiusPx).toBeLessThanOrEqual(r.thirdPartyRadiusPx);
    }
  });
});

describe('evaluateDisengage — cooldown gating (stamped by the intent layer)', () => {
  it('returns null within the cooldown of the last stamped trigger', () => {
    const ctx = makeCtx();
    ctx.enemies.push(
      enemy({ id: 'a', engagedTargetId: ctx.playerId }),
      enemy({ id: 'b', lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
    );
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.combat.lastDisengageTick = ctx.tick - 10; // stamped 10 ticks ago
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBeNull();
    ctx.combat.lastDisengageTick = ctx.tick - DISENGAGE_COOLDOWN_TICKS - 1; // aged out
    expect(evaluateDisengage(ctx, SCAN, profileFor(PersonalityArchetype.DUELIST))).toBe(
      'outnumbered',
    );
  });
});
