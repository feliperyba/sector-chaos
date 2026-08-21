import { describe, it, expect } from 'vitest';
import {
  TileType,
  SeededRNG,
  COMBAT,
  type GameConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../aggregates/GameMatch.ts';
import { createMatchServices, createMatchPools } from '../aggregates/createMatchServices.ts';
import { DeathResolutionService } from '../services/DeathResolutionService.ts';
import type { GameEvent } from '../events/index.ts';

/**
 * server-alive-counter drift tests.
 *
 * GameMatch.getAlivePlayerCount() returns a MAINTAINED counter updated at the
 * audited aliveness transitions (GameMatchPlayers add/remove/hardRemove +
 * PlayerLifecycle ALIVE-bit flips via Player.onAlivenessTransition). These
 * tests force every audited path — including the idempotent re-calls the
 * production callers rely on — and assert the counter never drifts from the
 * full-scan truth (scanAlivePlayerCount).
 */

function createTestConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 2.0,
      dashDuration: 0.5,
      dashCooldown: 3.0,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 96,
      hitboxHeight: 96,
    },
    zone: {
      totalDuration: 36000,
      transitionDuration: 1800,
      tickInterval: 30,
      warningTime: 1800,
      phases: [],
    },
    match: {
      targetDuration: 36000,
      maxPlayers: 16,
      minPlayers: 2,
      countdownDuration: 300,
      overtimeStart: 36000,
    },
    map: {
      tileWidth: 64,
      tileHeight: 64,
      arenaWidth: 640,
      arenaHeight: 640,
      sectorSize: 320,
      corridorWidth: 2,
      destructibleDensity: 0.3,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 300,
      bounceFactor: 0.5,
      maxBounces: 3,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 50,
      maxLatency: 200,
      inputBufferSize: 120,
      snapshotInterval: 0,
    },
    ...overrides,
  };
}

function makeGrid(rows: number, cols: number, fill: TileType): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  return grid;
}

function createMatch(): GameMatch {
  const grid = makeGrid(10, 10, TileType.EMPTY);
  const config = createTestConfig();
  const services = createMatchServices(config);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('drift-test-match', config, grid, spawnPointsFull(), services, pools, lootRng);
}

function spawnPointsFull(): SpawnPoint[] {
  // Enough distinct points for the 8 players used below (round-robin wraps).
  const pts: SpawnPoint[] = [];
  for (let i = 0; i < 8; i++) {
    pts.push({ x: 64 + i * 64, y: 64 + i * 64, sectorCoord: { row: 0, col: 0 }, priority: i });
  }
  return pts;
}

/** Assert BOTH the expected count and counter == full scan. */
function expectAlive(match: GameMatch, expected: number): void {
  expect(match.getAlivePlayerCount()).toBe(expected);
  expect(match.scanAlivePlayerCount()).toBe(expected);
  expect(match.aliveCountMatchesScan()).toBe(true);
}

describe('GameMatch maintained alive counter (server-alive-counter)', () => {
  it('starts at 0 and matches the scan on an empty match', () => {
    const match = createMatch();
    expectAlive(match, 0);
  });

  it('addPlayer (GameMatchPlayers.addPlayerAction): +1 per player, never drifts', () => {
    const match = createMatch();
    for (let i = 0; i < 8; i++) {
      match.addPlayer(`p${i}`, `Player${i}`);
      expectAlive(match, i + 1);
    }
  });

  it('dieWithTick (beginDying — the death-pipeline flip): -1, idempotent on re-call', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    expectAlive(match, 2);
    const p1 = match.getPlayer('p1')!;
    p1.dieWithTick(10);
    expectAlive(match, 1);
    // Re-call while already DYING: beginDying early-returns, no double decrement.
    p1.dieWithTick(11);
    expectAlive(match, 1);
  });

  it('die (killPlayer — no production callers, same audited path): -1, idempotent', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.getPlayer('p1')!.die();
    expectAlive(match, 1);
    // Already SPECTATING: killPlayer early-returns.
    match.getPlayer('p1')!.die();
    expectAlive(match, 1);
  });

  it('completeDeath (DYING -> SPECTATING): no aliveness change, no drift', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    const p1 = match.getPlayer('p1')!;
    p1.dieWithTick(10);
    expectAlive(match, 1);
    p1.completeDeath();
    expectAlive(match, 1);
  });

  it('revive: +1 from dead, 0 from already-alive (late-join / match-start callers)', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    // Production case GameOrchestratorPhases.handleMatchStart + orchestrator
    // late-join: revive() on an ALIVE player must NOT increment.
    match.getPlayer('p1')!.revive(20);
    expectAlive(match, 2);
    const p2 = match.getPlayer('p2')!;
    p2.dieWithTick(20);
    p2.completeDeath();
    expectAlive(match, 1);
    p2.revive(30);
    expectAlive(match, 2);
  });

  it('removePlayer (soft DEAD write in removePlayerAction): -1 if alive, 0 if already dead', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.removePlayer('p1');
    expectAlive(match, 1);
    // Soft-removing an already-dead player must not decrement again.
    match.getPlayer('p2')!.die();
    match.removePlayer('p2');
    expectAlive(match, 0);
  });

  it('hardRemovePlayerForBenchmark: -1 if alive, 0 if dead; detached player can no longer affect the counter', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    const p1 = match.getPlayer('p1')!;
    match.hardRemovePlayerForBenchmark('p1');
    expectAlive(match, 1);
    // The purged object is out of the map — reviving it must NOT change the count.
    p1.revive(50);
    expectAlive(match, 1);
    // Hard-remove of a dead player: no decrement.
    match.getPlayer('p2')!.die();
    match.hardRemovePlayerForBenchmark('p2');
    expectAlive(match, 0);
  });

  it('same-id re-add (defensive double-add): old entry un-counted, replacement counted', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    expectAlive(match, 2);
    match.addPlayer('p1', 'AliceAgain');
    expectAlive(match, 2);
    expect(match.players.size).toBe(2);
  });

  it('DeathResolutionService.processDeaths end-to-end: damage -> DYING (-1) -> SPECTATING (0)', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.addPlayer('p3', 'Charlie');
    expectAlive(match, 3);

    const svc = new DeathResolutionService();
    const events: GameEvent[] = [];
    const ctx = {
      emitEvent: (e: GameEvent) => events.push(e),
      getPlayerName: (id: string) => match.getPlayer(id)?.name ?? '',
      getAliveCount: () => match.getAlivePlayerCount(),
      hasPlayer: (id: string) => match.getPlayer(id) !== undefined,
      markPlayerDead: () => {},
    };

    // Lethal damage (skip fresh-spawn invulnerability) — health.isDead, but the
    // ALIVE bit is still set until processDeaths flips it.
    const p1 = match.getPlayer('p1')!;
    const result0 = p1.takeDamage(999, 5, true);
    expect(result0.killed).toBe(true);
    expectAlive(match, 3); // health-dead is NOT aliveness-dead yet

    const res1 = svc.processDeaths(match.players, 6, new Set(), ctx);
    expect(res1.eliminatedPlayerIds).toEqual(['p1']);
    expectAlive(match, 2);
    // Same tick re-run: already DYING, no further decrement.
    const res1b = svc.processDeaths(match.players, 6, new Set(), ctx);
    expect(res1b.eliminatedPlayerIds).toEqual([]);
    expectAlive(match, 2);

    // Advance past the death animation: DYING -> SPECTATING, no count change.
    const deathAnimationTicks = Math.round(COMBAT.DEATH_ANIMATION_DURATION * 60);
    const res2 = svc.processDeaths(match.players, 6 + deathAnimationTicks + 1, new Set(), ctx);
    expect(res2.spectatingTransitions.map((t) => t.playerId)).toEqual(['p1']);
    expectAlive(match, 2);
  });

  it('chaos sequence across every audited path: counter equals the scan after every step', () => {
    const match = createMatch();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) match.addPlayer(id, id.toUpperCase());
    expectAlive(match, 5);

    const a = match.getPlayer('a')!;
    const b = match.getPlayer('b')!;
    const c = match.getPlayer('c')!;
    const d = match.getPlayer('d')!;

    a.dieWithTick(10); // death pipeline flip
    expectAlive(match, 4);
    b.die(); // killPlayer flip
    expectAlive(match, 3);
    a.completeDeath(); // DYING -> SPECTATING (no flip)
    expectAlive(match, 3);
    a.revive(20); // SPECTATING -> ALIVE
    expectAlive(match, 4);
    a.revive(21); // already alive — no flip
    expectAlive(match, 4);
    match.removePlayer('c'); // soft DEAD write
    expectAlive(match, 3);
    c.revive(22); // detached-from-alive but still in map: DEAD -> ALIVE re-counts
    expectAlive(match, 4);
    c.die(); // and dies again
    expectAlive(match, 3);
    match.hardRemovePlayerForBenchmark('d'); // alive hard-remove
    expectAlive(match, 2);
    d.revive(23); // detached object: no effect
    expectAlive(match, 2);
    match.addPlayer('f', 'F'); // fresh add
    expectAlive(match, 3);
    match.removePlayer('a'); // remove a revived player (alive -> DEAD)
    expectAlive(match, 2);

    // Final invariant: scan and counter agree on the exact survivors.
    const aliveIds = match.getPlayers().filter((p) => p.isActive).map((p) => p.id).sort();
    expect(aliveIds).toEqual(['e', 'f']);
    expectAlive(match, 2);
  });
});
