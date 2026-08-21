import { describe, it, expect } from 'vitest';
import { TileType } from '@sector-battle/shared';
import {
  createDefaultGameConfig,
  createSpawnPoints,
  createEmptyGrid,
} from '../../helpers/createTestMatch.ts';
import { createGameOrchestrator } from '../../../src/application/services/GameOrchestratorInit.ts';
import { InMatchReconnectionManager } from '../../../src/domain/services/index.ts';
import type { MapResult } from '../../../src/domain/services/MapGenerator.ts';

/**
 * Characterization test for the {@link createGameOrchestrator} factory. Proves
 * the factory builds the REAL match (not the historical `[[]]` placeholder
 * the 2-phase constructor used to leave behind before `initialize()` ran).
 *
 * See docs/issues/13-refactor-game-orchestrator-atomic-construction.md.
 */
describe('createGameOrchestrator (construction characterization)', () => {
  it('builds an orchestrator wired to the provided map (not the placeholder)', () => {
    const config = createDefaultGameConfig();
    // Tiny deterministic map: 3x3 empty grid + 1 spawn.
    const grid: TileType[][] = createEmptyGrid(3, 3);
    const spawnPoints = createSpawnPoints(1);
    const mapResult: MapResult = {
      grid,
      seed: 12345,
      spawnPoints,
      chestPlacements: [],
      trapPlacements: [],
      weaponSpawnPlacements: [],
    };

    const orchestrator = createGameOrchestrator('match-factory-test', config, mapResult);

    // Real grid width flows through (placeholder was `[[]]` -> width 0).
    expect(orchestrator.getMatch().mapWidth).toBe(3);
    // Real spawn points flow through (placeholder had a single dummy {0,0}).
    expect(orchestrator.getMatch().spawnPoints.length).toBe(1);
    // Reconnection manager is a real instance (not null).
    expect(orchestrator.getReconnectionManager()).toBeInstanceOf(InMatchReconnectionManager);
    // Freshly built, not started.
    expect(orchestrator.getSimulation().isRunning).toBe(false);
    // The factory hydrates entity maps; traps is a real Map. The placeholder
    // match created a fresh Map too, so this asserts the type rather than the
    // placeholder-vs-real distinction; it documents the post-construction shape.
    expect(orchestrator.getMatch().getState().traps).toBeInstanceOf(Map);
  });
});
