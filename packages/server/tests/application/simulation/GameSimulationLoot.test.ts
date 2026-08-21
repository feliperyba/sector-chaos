import { describe, it, expect } from 'vitest';
import { IdGenerator, SeededRNG, TileType } from '@sector-battle/shared';
import {
  processDestroyedDestructibles,
  type LootHandlerContext,
} from '../../../src/application/simulation/GameSimulationLoot.ts';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { Destructible } from '../../../src/domain/entities/index.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { LootService } from '../../../src/domain/services/LootService.ts';
import { createTestMatch } from '../../helpers/createTestMatch.ts';

/**
 * perf-arc-neo ticket 10 — orphan-sweep dirty-gate tests.
 *
 * `processDestroyedDestructibles` runs only when `GameMatch.orphanSweepVersion`
 * moved since the last run (a tile was cleared to EMPTY or a destructible was
 * added — full raise-site audit on the sweep's doc in GameSimulationLoot.ts).
 * These tests pin the gate's contract:
 *
 * - tick-exactness: a wall whose tile clears is destroyed by the VERY NEXT
 *   sweep call (the ungated sweep's observation point), not later;
 * - every enumerated raise site re-arms the gate (setTileAt funnel,
 *   barrel-ray direct grid writes, destructible adds);
 * - skipped runs are no-ops and the sweep's own destroy bumps are absorbed;
 * - the nonSolid (light-prop) and wall/crate/barrel guards are unchanged.
 */

const TILE = 32; // createTestMatch tileWidth/tileHeight

function createLootCtx(match: GameMatch): LootHandlerContext {
  return {
    match,
    lootService: new LootService(),
    lootRng: new SeededRNG(12345),
    lootIdGen: new IdGenerator('loot'),
    powerUpIdGen: new IdGenerator('pu-sim'),
    processedDestructibles: new Set<string>(),
    lastOrphanSweepVersion: -1,
  };
}

function gridPos(gx: number, gy: number): Position {
  return new Position(gx * TILE + TILE / 2, gy * TILE + TILE / 2);
}

function addWall(match: GameMatch, id: string, gx: number, gy: number): Destructible {
  const wall = Destructible.create(id, 'wall', gridPos(gx, gy));
  match.addDestructible(wall);
  return wall;
}

describe('processDestroyedDestructibles (ticket 10 dirty gate)', () => {
  it('first run processes nothing while tiles are non-EMPTY and absorbs the version', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    addWall(match, 'w1', 2, 2);
    match.setTileAt(2, 2, TileType.DESTRUCTIBLE_WALL);

    processDestroyedDestructibles(ctx);

    expect(match.getState().destructibles.has('w1')).toBe(true);
    expect(ctx.lastOrphanSweepVersion).toBe(match.orphanSweepVersion);
  });

  it('destroys a wall on the same run its tile clears via the setTileAt funnel (tick-exact)', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    addWall(match, 'w1', 2, 2);
    match.setTileAt(2, 2, TileType.DESTRUCTIBLE_WALL);
    processDestroyedDestructibles(ctx); // baseline run: nothing eligible

    // Any destruction path funnels through match.setTileAt(EMPTY) — exactly
    // what destroyDestructibleAction (melee/arrow/thrown/fuse/siege) executes.
    match.setTileAt(2, 2, TileType.EMPTY);
    processDestroyedDestructibles(ctx); // must run NOW, not on a later tick

    expect(match.getState().destructibles.has('w1')).toBe(false);
    expect(match.getTileAt(2, 2)).toBe(TileType.EMPTY);
    const events = match.drainEvents();
    expect(events.some((e) => e.type === 'DestructibleDestroyed' && e.id === 'w1')).toBe(true);
    expect(ctx.lastOrphanSweepVersion).toBe(match.orphanSweepVersion);
  });

  it('re-arms on destructible adds — a wall added onto an EMPTY tile is swept on the next run', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    processDestroyedDestructibles(ctx); // baseline run (grid empty, no entities)

    // No tile write at all — only the add itself can make this wall eligible.
    addWall(match, 'w1', 5, 5); // tile stays EMPTY
    processDestroyedDestructibles(ctx);

    expect(match.getState().destructibles.has('w1')).toBe(false);
  });

  it('skipped runs are no-ops (gate closed, nothing destroyed, bookkeeping stable)', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    addWall(match, 'w1', 2, 2);
    match.setTileAt(2, 2, TileType.DESTRUCTIBLE_WALL);
    processDestroyedDestructibles(ctx);
    const versionAfterRun = match.orphanSweepVersion;

    processDestroyedDestructibles(ctx); // no raise since — must skip

    expect(match.getState().destructibles.has('w1')).toBe(true);
    expect(ctx.lastOrphanSweepVersion).toBe(versionAfterRun);
  });

  it('barrel-ray tile clear (direct grid write, no destructible on the tile) raises the gate', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    processDestroyedDestructibles(ctx); // baseline run
    match.setTileAt(3, 1, TileType.DESTRUCTIBLE_WALL); // tile only — no entity
    const versionBefore = match.orphanSweepVersion;

    match.triggerBarrelExplosion(1, 1, 256, 50, 'test-owner', 0);

    expect(match.getTileAt(3, 1)).toBe(TileType.EMPTY); // ray cleared it
    expect(match.orphanSweepVersion).toBeGreaterThan(versionBefore); // wiring raised
  });

  it('barrel-chain orphan is swept on the next run (ray destroyed the sibling under it)', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    // Two walls share tile (2,1): the ray destroys the last-indexed occupant
    // and clears the tile; the survivor is a live wall on an EMPTY tile.
    addWall(match, 'w-survivor', 2, 1);
    addWall(match, 'w-ray-victim', 2, 1);
    match.setTileAt(2, 1, TileType.DESTRUCTIBLE_WALL);
    processDestroyedDestructibles(ctx); // baseline run

    match.triggerBarrelExplosion(1, 1, 256, 50, 'test-owner', 0);
    expect(match.getTileAt(2, 1)).toBe(TileType.EMPTY);
    expect(match.getState().destructibles.has('w-ray-victim')).toBe(false);

    processDestroyedDestructibles(ctx); // must process the survivor NOW

    expect(match.getState().destructibles.has('w-survivor')).toBe(false);
  });

  it('nonSolid light-props on EMPTY tiles survive the sweep (guard unchanged)', () => {
    const match = createTestMatch();
    const ctx = createLootCtx(match);
    match.addDestructible(Destructible.create('light-1', 'light', gridPos(6, 6)));

    processDestroyedDestructibles(ctx);

    expect(match.getState().destructibles.has('light-1')).toBe(true);
  });
});
