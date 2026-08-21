import { describe, it, expect } from 'vitest';
import { BotContext } from '../../src/ai/BotContext.ts';
import { acquireDanger, acquireProjectile, releaseAll } from '../../src/ai/BotPerception.ts';
import { rescanHazards } from '../../src/ai/BotSelfState.ts';
import type { BotSystem } from '../../src/ai/BotSystem.ts';
import type { EnemyInfo, ItemInfo } from '../../src/ai/BotContext.ts';
import type {
  TrapDTO,
  DestructibleDTO,
  ProjectileDTO,
} from '../../src/ai/WorldSnapshotTypes.ts';
import type { PlayerDTO } from '../../src/ai/WorldSnapshot.ts';

/**
 * Ticket 24 — bot-rescan-hazards-pool.
 *
 * Locks the pool discipline shared by the full perception scan
 * (BotPerception.scanWorld) and the per-tick hazard rescan
 * (BotSelfState.rescanHazards):
 *   1. acquireDanger/acquireProjectile populate EVERY DTO field and append
 *      (identical field population to the pre-refactor literals).
 *   2. releaseAll returns live entries to the pool and clears — the rescan
 *      NEVER appends onto a non-empty array (no double-counted hazards).
 *   3. release-then-pop reuses the SAME object (steady-state zero alloc).
 *   4. Pooled objects carry no stale fields between cycles.
 *   5. Repeated rescans keep pool+live counts bounded (no leak).
 */

function trap(id: string, x: number, y: number, type = '1'): TrapDTO {
  return { id, x, y, type };
}

function barrel(id: string, x: number, y: number): DestructibleDTO {
  return { id, x, y, type: 'barrel', hp: 1, maxHp: 1, isDestroyed: false };
}

function crate(id: string, x: number, y: number): DestructibleDTO {
  return { id, x, y, type: 'crate', hp: 1, maxHp: 1, isDestroyed: false };
}

function projectile(id: string, x: number, y: number, vx = 10, vy = -5): ProjectileDTO {
  return { id, x, y, velocityX: vx, velocityY: vy };
}

/** Minimal BotSystem stand-in — rescanHazards only reads system.worldSnapshot's
 *  three hazard query methods (they invoke the callback in array order, which
 *  is what the spatial-grid queries guarantee for a single cell). */
function makeSystem(
  traps: TrapDTO[],
  destructibles: DestructibleDTO[],
  projectiles: ProjectileDTO[],
): BotSystem {
  return {
    worldSnapshot: {
      queryTraps: (_cx: number, _cy: number, _r: number, cb: (d: TrapDTO) => void) => {
        for (const t of traps) cb(t);
      },
      queryDestructibles: (
        _cx: number,
        _cy: number,
        _r: number,
        cb: (d: DestructibleDTO) => void,
      ) => {
        for (const d of destructibles) cb(d);
      },
      queryProjectiles: (_cx: number, _cy: number, _r: number, cb: (d: ProjectileDTO) => void) => {
        for (const p of projectiles) cb(p);
      },
    },
  } as unknown as BotSystem;
}

const DTO_STUB = {} as PlayerDTO;

describe('acquireDanger / acquireProjectile (shared pool acquire)', () => {
  it('populates every DangerInfo field and appends to ctx.dangers', () => {
    const ctx = new BotContext('bot-pool-1');
    const d = acquireDanger(ctx, 100, 200, 'barrel', 42.5);
    expect(ctx.dangers).toHaveLength(1);
    expect(ctx.dangers[0]).toBe(d);
    expect(d).toEqual({ x: 100, y: 200, type: 'barrel', distance: 42.5 });
  });

  it('populates every ProjectileInfo field and appends to ctx.projectiles', () => {
    const ctx = new BotContext('bot-pool-2');
    const p = acquireProjectile(ctx, 'p1', 5, 6, 7, 8, 9.5);
    expect(ctx.projectiles).toHaveLength(1);
    expect(ctx.projectiles[0]).toBe(p);
    expect(p).toEqual({ id: 'p1', x: 5, y: 6, vx: 7, vy: 8, distance: 9.5 });
  });

  it('release-then-pop reuses the SAME object (steady-state zero allocation)', () => {
    const ctx = new BotContext('bot-pool-3');
    const first = acquireDanger(ctx, 1, 2, '1', 3);
    const firstProj = acquireProjectile(ctx, 'p', 1, 2, 3, 4, 5);
    releaseAll(ctx.dangers, ctx.dangerPool);
    releaseAll(ctx.projectiles, ctx.projectilePool);
    expect(ctx.dangers).toHaveLength(0);
    expect(ctx.dangerPool).toHaveLength(1);
    expect(ctx.projectilePool).toHaveLength(1);
    const second = acquireDanger(ctx, 9, 9, 'barrel', 9);
    const secondProj = acquireProjectile(ctx, 'q', 9, 9, 9, 9, 9);
    expect(second).toBe(first); // popped, not allocated
    expect(secondProj).toBe(firstProj);
    expect(ctx.dangerPool).toHaveLength(0);
    expect(ctx.projectilePool).toHaveLength(0);
  });

  it('leaves no stale fields on reused DTOs (every field overwritten)', () => {
    const ctx = new BotContext('bot-pool-4');
    acquireProjectile(ctx, 'old-id', 1, 1, 1, 1, 1);
    acquireDanger(ctx, 1, 1, '1', 1);
    releaseAll(ctx.projectiles, ctx.projectilePool);
    releaseAll(ctx.dangers, ctx.dangerPool);
    const p = acquireProjectile(ctx, 'new-id', 2, 3, 4, 5, 6);
    const d = acquireDanger(ctx, 7, 8, 'barrel', 9);
    expect(p.id).toBe('new-id');
    expect(p).toEqual({ id: 'new-id', x: 2, y: 3, vx: 4, vy: 5, distance: 6 });
    expect(d).toEqual({ x: 7, y: 8, type: 'barrel', distance: 9 });
  });
});

describe('rescanHazards pool routing (ticket 24)', () => {
  it('produces identical content/order to the pre-refactor literals', () => {
    const ctx = new BotContext('bot-rescan-1');
    ctx.x = 0;
    ctx.y = 0;
    const system = makeSystem(
      [trap('t1', 30, 40), trap('t2', -60, 80, '2')],
      [crate('c1', 50, 50), barrel('b1', 120, 50), barrel('b2', 50, -120)],
      [projectile('p1', 100, 100, 3, 4)],
    );

    rescanHazards(system, ctx, DTO_STUB);

    // Traps first, then barrels (query order); crates filtered out. Distances
    // are the exact Math.sqrt values the inline literals used to compute.
    expect(ctx.dangers.map((d) => ({ ...d }))).toEqual([
      { x: 30, y: 40, type: '1', distance: Math.sqrt(30 * 30 + 40 * 40) },
      { x: -60, y: 80, type: '2', distance: Math.sqrt(60 * 60 + 80 * 80) },
      { x: 120, y: 50, type: 'barrel', distance: Math.sqrt(120 * 120 + 50 * 50) },
      { x: 50, y: -120, type: 'barrel', distance: Math.sqrt(50 * 50 + 120 * 120) },
    ]);
    expect(ctx.projectiles.map((p) => ({ ...p }))).toEqual([
      { id: 'p1', x: 100, y: 100, vx: 3, vy: 4, distance: Math.sqrt(100 * 100 + 100 * 100) },
    ]);
  });

  it('clears before filling — repeated rescans never double-count hazards', () => {
    const ctx = new BotContext('bot-rescan-2');
    const system = makeSystem(
      [trap('t1', 10, 10)],
      [barrel('b1', 20, 20)],
      [projectile('p1', 30, 30)],
    );
    for (let i = 0; i < 5; i++) {
      rescanHazards(system, ctx, DTO_STUB);
      expect(ctx.dangers).toHaveLength(2); // trap + barrel, never 4/6/8...
      expect(ctx.projectiles).toHaveLength(1);
    }
  });

  it('releases the previous cycle back to the pools (no leak, bounded totals)', () => {
    const ctx = new BotContext('bot-rescan-3');
    const system = makeSystem(
      [trap('t1', 10, 10)],
      [barrel('b1', 20, 20)],
      [projectile('p1', 30, 30)],
    );
    rescanHazards(system, ctx, DTO_STUB);
    // After the first cycle the pools hold the previous cycle's objects only
    // transiently — release happens at the START of each rescan. Totals
    // (live + pooled) must stay constant across arbitrarily many cycles.
    const dangerTotal = ctx.dangers.length + ctx.dangerPool.length;
    const projTotal = ctx.projectiles.length + ctx.projectilePool.length;
    expect(dangerTotal).toBe(2);
    expect(projTotal).toBe(1);
    for (let i = 0; i < 50; i++) {
      rescanHazards(system, ctx, DTO_STUB);
      expect(ctx.dangers.length + ctx.dangerPool.length).toBe(dangerTotal);
      expect(ctx.projectiles.length + ctx.projectilePool.length).toBe(projTotal);
    }
  });

  it('reuses the same DTO objects across rescan cycles', () => {
    const ctx = new BotContext('bot-rescan-4');
    const system = makeSystem([], [barrel('b1', 100, 0)], []);
    rescanHazards(system, ctx, DTO_STUB);
    const first = ctx.dangers[0];
    rescanHazards(system, ctx, DTO_STUB);
    const second = ctx.dangers[0];
    expect(second).toBe(first); // released → pooled → popped again
  });

  it('preserves enemy/item views from the last full scan (rescan touches hazards only)', () => {
    const ctx = new BotContext('bot-rescan-5');
    // Simulate a prior full scan's enemy/item views.
    const enemy = { id: 'e1', x: 1, y: 2 } as unknown as EnemyInfo;
    const item = { id: 'i1', x: 3, y: 4 } as unknown as ItemInfo;
    ctx.enemies.push(enemy);
    ctx.items.push(item);
    ctx.nearestEnemy = enemy;
    const system = makeSystem([trap('t1', 10, 10)], [], []);
    rescanHazards(system, ctx, DTO_STUB);
    expect(ctx.enemies).toHaveLength(1);
    expect(ctx.enemies[0]).toBe(enemy);
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0]).toBe(item);
    expect(ctx.nearestEnemy).toBe(enemy);
  });
});
