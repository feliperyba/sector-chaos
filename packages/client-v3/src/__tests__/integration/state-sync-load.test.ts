import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  toPlayerState,
  toDestructible,
  toProjectile,
  onlyPositionChangedPlayer,
} from '../../network/SchemaConverters.js';
import { EntityInterpolator } from '../../prediction/EntityInterpolator.js';
import type {
  PlayerSchemaData,
  DestructibleSchemaData,
  ProjectileSchemaData,
  WeaponSchemaData,
} from '@sector-battle/shared';

/**
 * Integration load test (CROSS-014): stress the client state-sync hot path at
 * realistic scale — 64 players, ~200 destructibles, ~50 projectiles — fed
 * through the real SchemaConverters + EntityInterpolator at a 20Hz snapshot
 * cadence, and assert the per-snapshot processing budget holds under 16ms
 * (one render frame at 60fps).
 *
 * This is a pure-CPU pipeline test (no network, no Colyseus SDK): it exercises
 * the exact allocation + normalization + interpolation work `StateSync` does
 * each patch. Regressions in SchemaConverters (e.g. dropping the shallow-copy
 * fast path) or EntityInterpolator (e.g. per-push allocation) surface here as
 * budget overruns.
 */

const PLAYER_COUNT = 64;
const DESTRUCTIBLE_COUNT = 200;
const PROJECTILE_COUNT = 50;
const INVENTORY_SIZE = 4;
/** 20Hz server snapshot cadence → 50ms wall between patches. */
const SNAPSHOT_INTERVAL_MS = 50;
/** One 60fps render frame. The whole sync cycle must fit inside this. */
const FRAME_BUDGET_MS = 16;
const CYCLES = 120;

/**
 * Capture the REAL `performance.now` (bound) at module load, before any test
 * mocks it, so we can measure actual CPU elapsed time independently of the
 * controlled clock that EntityInterpolator reads via `performance.now()`.
 */
const realPerformanceNow = performance.now.bind(performance);

function makeWeapons(seed: number): WeaponSchemaData[] {
  const out: WeaponSchemaData[] = [];
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    const filled = (seed + i) % 3 !== 0;
    out.push(
      filled
        ? {
            id: `w-${seed}-${i}`,
            weaponType: ((seed + i) % 12) + 1,
            tier: (seed + i) % 4,
            ammo: 50,
            maxAmmo: 100,
          }
        : { id: '', weaponType: 0, tier: 0, ammo: 0, maxAmmo: 0 },
    );
  }
  return out;
}

function makePlayer(seed: number, tick: number): PlayerSchemaData {
  const moving = seed % 4 !== 0;
  const speed = 430;
  const angle = (seed * 0.7) % (Math.PI * 2);
  return {
    id: `p-${seed}`,
    name: `Player${seed}`,
    color: seed * 2654435761,
    x: 500 + Math.sin(seed + tick * 0.05) * 300,
    y: 500 + Math.cos(seed + tick * 0.05) * 300,
    direction: moving ? (seed % 8) + 1 : 0,
    facingAngle: angle,
    speed: moving ? speed : 0,
    velocityX: moving ? Math.cos(angle) * speed : 0,
    velocityY: moving ? Math.sin(angle) * speed : 0,
    health: 100 - (seed % 40),
    maxHealth: 100,
    status: seed % 5,
    kills: seed % 8,
    activeSlot: seed % INVENTORY_SIZE,
    lastDamageTick: tick - (seed % 60),
    dashCooldown: seed % 3 === 0 ? 30 : 0,
    barrierActive: seed % 7 === 0,
    isBlocking: seed % 11 === 0,
    speedBoostActive: seed % 13 === 0,
    connected: seed % 17 !== 0,
    isBot: seed >= 1,
    isWindupActive: seed % 5 === 0,
    windupWeaponType: seed % 5 === 0 ? (seed % 12) + 1 : 0,
    windupAttackType: seed % 5 === 0 ? 'ARC' : '',
    animPhase: seed % 9,
    animPhaseStartTick: tick - (seed % 20),
    comboIndex: seed % 256,
    barrierExpiryTick: seed % 7 === 0 ? tick + 120 : 0,
    speedBoostExpiryTick: seed % 13 === 0 ? tick + 420 : 0,
    freshSpawnExpiryTick: tick < 180 ? tick + (180 - (tick % 60)) : 0,
    lastProcessedInput: tick * 1 + seed,
    weapons: makeWeapons(seed),
    items: seed % 3 === 0 ? ['item_a', 'item_b'] : ['item_a'],
  };
}

function makeDestructible(seed: number): DestructibleSchemaData {
  const types = [0, 0, 1, 2, 3] as const;
  const t = types[seed % types.length]!;
  const destroyed = seed % 9 === 0;
  return {
    id: `d-${seed}`,
    type: t,
    hp: destroyed ? 0 : t === 2 ? 255 : Math.max(0, 10 - (seed % 10)),
    maxHp: t === 2 ? 255 : 10,
    x: (seed % 40) * 64,
    y: Math.floor(seed / 40) * 64,
    isDestroyed: destroyed,
    primed: false,
    fuseExpiresAtTick: 0,
    textureKey: `tex-${t}`,
    rotation: (seed % 4) * 90,
    flipH: seed % 2 === 0,
    flipV: seed % 5 === 0,
  };
}

function makeProjectile(seed: number, tick: number): ProjectileSchemaData {
  return {
    id: `pr-${seed}`,
    ownerId: `p-${seed % PLAYER_COUNT}`,
    x: 100 + ((tick * 14 + seed * 37) % 2000),
    y: 100 + ((tick * 9 + seed * 53) % 2000),
    velocityX: 600,
    velocityY: -200,
    damage: 25 + (seed % 50),
    bounces: seed % 3,
    weaponType: (seed % 12) + 1,
    tier: seed % 4,
  };
}

describe('State-sync load — 64 players / 200 destructibles / 50 projectiles @20Hz', () => {
  let now: number;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes a full snapshot cycle (convert + interpolate) under one frame budget', () => {
    const players: PlayerSchemaData[] = [];
    for (let i = 0; i < PLAYER_COUNT; i++) players.push(makePlayer(i, 0));
    const destructibles: DestructibleSchemaData[] = [];
    for (let i = 0; i < DESTRUCTIBLE_COUNT; i++) destructibles.push(makeDestructible(i));
    const projectiles: ProjectileSchemaData[] = [];
    for (let i = 0; i < PROJECTILE_COUNT; i++) projectiles.push(makeProjectile(i, 0));

    const interp = new EntityInterpolator();
    // Cached PlayerState views (mirrors StateSync's per-entity cache).
    const cached = players.map((p) => toPlayerState(p));

    let worstMs = 0;
    let sumMs = 0;

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const tick = cycle + 1;
      now = cycle * SNAPSHOT_INTERVAL_MS;

      const t0 = realPerformanceNow();

      // SchemaConverters: full re-convert all entities each cycle (worst case —
      // a non-position field changed for every player).
      for (let i = 0; i < players.length; i++) {
        const wire = makePlayer(i, tick);
        if (!onlyPositionChangedPlayer(wire, cached[i]!)) {
          cached[i] = toPlayerState(wire);
        } else {
          cached[i]!.x = wire.x;
          cached[i]!.y = wire.y;
          cached[i]!.velocityX = wire.velocityX;
          cached[i]!.velocityY = wire.velocityY;
        }
      }
      for (let i = 0; i < destructibles.length; i++) {
        toDestructible(destructibles[i]);
      }
      for (let i = 0; i < projectiles.length; i++) {
        toProjectile(makeProjectile(i, tick));
      }

      // EntityInterpolator: push all moving entities (players + projectiles).
      for (let i = 0; i < players.length; i++) {
        const p = cached[i]!;
        if (p.velocityX !== 0 || p.velocityY !== 0) {
          interp.push(p.id, p.x, p.y, p.velocityX, p.velocityY);
        }
      }
      for (let i = 0; i < PROJECTILE_COUNT; i++) {
        const pr = makeProjectile(i, tick);
        interp.push(pr.id, pr.x, pr.y, pr.velocityX, pr.velocityY);
      }

      const elapsed = realPerformanceNow() - t0;
      if (elapsed > worstMs) worstMs = elapsed;
      sumMs += elapsed;
    }

    const avgMs = sumMs / CYCLES;
    // Diagnostic — surfaced on failure so regressions are attributable.
    if (avgMs > FRAME_BUDGET_MS || worstMs > FRAME_BUDGET_MS) {
      // eslint-disable-next-line no-console
      console.log(`[state-sync-load] avg=${avgMs.toFixed(3)}ms worst=${worstMs.toFixed(3)}ms`);
    }

    expect(avgMs).toBeLessThan(FRAME_BUDGET_MS);
    expect(worstMs).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('sustains interpolation sampling for all entities under budget', () => {
    const interp = new EntityInterpolator();
    const ids: string[] = [];
    for (let i = 0; i < PLAYER_COUNT + PROJECTILE_COUNT; i++) {
      const id = `e-${i}`;
      ids.push(id);
      interp.push(id, i * 10, i * 5, 430, 0);
    }
    // Warm the buffer with a second snapshot so interpolation (not just
    // extrapolation) is exercised.
    now = SNAPSHOT_INTERVAL_MS;
    for (let i = 0; i < ids.length; i++) {
      interp.push(ids[i]!, i * 10 + 50, i * 5, 430, 0);
    }

    const out = { x: 0, y: 0 };
    const t0 = realPerformanceNow();
    let sampled = 0;
    for (let i = 0; i < ids.length; i++) {
      if (interp.getInterpolatedPosition(ids[i]!, out)) sampled++;
    }
    const elapsed = realPerformanceNow() - t0;

    expect(sampled).toBe(ids.length);
    expect(elapsed).toBeLessThan(FRAME_BUDGET_MS);
  });
});
