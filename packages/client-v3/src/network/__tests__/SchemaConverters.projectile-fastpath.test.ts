/**
 * Ticket 20 — projectile position-mutate fast path (StateSync patch churn).
 *
 * WHY THIS SEAM:
 * `StateSync.subscribeCollection` runs a zero-allocation fast path for
 * players (mutate x/y/vx/vy in place when only those differ). Ticket 20
 * extends the SAME pattern to projectiles: in-flight projectile patches carry
 * new x/y/vx/vy every tick, and previously every patch allocated a fresh
 * `ProjectileState` per projectile via `toProjectile` (~1,800 objects/sec at
 * 30 concurrent projectiles) plus the `entityMap.set` churn. The gate is the
 * pure predicate `onlyPositionChangedProjectile`; the mutation lives in
 * StateSync's fastPath callback (same shape as the player one).
 *
 * WHAT THIS PROVES:
 *  1. The predicate accepts position-only diffs and rejects EVERY structural
 *     diff (id/ownerId/damage/bounces/weaponType/tier) — exhaustive on
 *     purpose, same contract as `onlyPositionChangedPlayer`.
 *  2. The StateSync-loop contract (mirrored from the integration load test's
 *     player loop): a steady patch MUTATES the cached view object (identity
 *     preserved — zero allocation) and a structural patch (e.g. the bounce
 *     decrement on a wall hit) REPLACES it with a fresh `toProjectile` build.
 */
import { describe, it, expect } from 'vitest';
import { toProjectile, onlyPositionChangedProjectile } from '../SchemaConverters.js';
import type { ProjectileSchemaData } from '@sector-battle/shared';
import type { ProjectileState } from '../../types.js';

function makeProjectile(overrides: Partial<ProjectileSchemaData> = {}): ProjectileSchemaData {
  return {
    id: 'pr-1',
    ownerId: 'p-7',
    x: 100,
    y: 200,
    velocityX: 600,
    velocityY: -200,
    damage: 25,
    bounces: 2,
    weaponType: 3,
    tier: 1,
    ...overrides,
  };
}

describe('ticket 20 — onlyPositionChangedProjectile predicate', () => {
  it('accepts a position/velocity-only diff (the every-tick steady case)', () => {
    const cached = toProjectile(makeProjectile());
    expect(
      onlyPositionChangedProjectile(
        makeProjectile({ x: 140, y: 260, velocityX: 580, velocityY: -180 }),
        cached,
      ),
    ).toBe(true);
  });

  it('accepts identical fields (no diff at all)', () => {
    const cached = toProjectile(makeProjectile());
    expect(onlyPositionChangedProjectile(makeProjectile(), cached)).toBe(true);
  });

  it('rejects a bounce decrement (wall hit — structural change)', () => {
    const cached = toProjectile(makeProjectile({ bounces: 2 }));
    expect(onlyPositionChangedProjectile(makeProjectile({ bounces: 1 }), cached)).toBe(false);
  });

  it('rejects a damage change', () => {
    const cached = toProjectile(makeProjectile({ damage: 25 }));
    expect(onlyPositionChangedProjectile(makeProjectile({ damage: 40 }), cached)).toBe(false);
  });

  it('rejects a weaponType change (different projectile visual)', () => {
    const cached = toProjectile(makeProjectile({ weaponType: 3 }));
    expect(onlyPositionChangedProjectile(makeProjectile({ weaponType: 5 }), cached)).toBe(false);
  });

  it('rejects a tier change (tint color)', () => {
    const cached = toProjectile(makeProjectile({ tier: 1 }));
    expect(onlyPositionChangedProjectile(makeProjectile({ tier: 2 }), cached)).toBe(false);
  });

  it('rejects an ownerId change and an id change', () => {
    const cached = toProjectile(makeProjectile());
    expect(onlyPositionChangedProjectile(makeProjectile({ ownerId: 'p-9' }), cached)).toBe(false);
    expect(onlyPositionChangedProjectile(makeProjectile({ id: 'pr-2' }), cached)).toBe(false);
  });
});

describe('ticket 20 — projectile fast-path loop contract (StateSync pattern)', () => {
  it('steady patches mutate the cached view in place — zero new ProjectileState objects', () => {
    // Mirrors StateSync.subscribeCollection's fastPath decision order:
    // check the predicate → mutate the four kinematic fields → keep the SAME
    // object in the entities map (no toProjectile call, no Map.set churn).
    let cached: ProjectileState = toProjectile(makeProjectile());
    const initial = cached;

    const wire1 = makeProjectile({ x: 140, y: 260, velocityX: 580, velocityY: -180 });
    if (onlyPositionChangedProjectile(wire1, cached)) {
      cached.x = wire1.x;
      cached.y = wire1.y;
      cached.velocityX = wire1.velocityX;
      cached.velocityY = wire1.velocityY;
    } else {
      cached = toProjectile(wire1);
    }

    expect(cached).toBe(initial); // identity preserved — nothing was allocated
    expect(cached.x).toBe(140);
    expect(cached.y).toBe(260);
    expect(cached.velocityX).toBe(580);
    expect(cached.velocityY).toBe(-180);
    // Structural fields untouched by the mutation:
    expect(cached.bounces).toBe(2);
    expect(cached.damage).toBe(25);
  });

  it('a structural patch (bounce decrement) replaces the view with a fresh build', () => {
    let cached: ProjectileState = toProjectile(makeProjectile({ bounces: 2 }));
    const initial = cached;

    const wire = makeProjectile({ x: 999, bounces: 1 });
    if (onlyPositionChangedProjectile(wire, cached)) {
      cached.x = wire.x;
    } else {
      cached = toProjectile(wire);
    }

    expect(cached).not.toBe(initial); // full rebuild — the bounce count is load-bearing
    expect(cached.bounces).toBe(1);
    expect(cached.x).toBe(999);
  });
});
