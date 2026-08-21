import { describe, it, expect } from 'vitest';
import { TileType, SeededRNG, type GameConfig, type SpawnPoint } from '@sector-battle/shared';
import { GameMatch } from '../aggregates/GameMatch.ts';
import { createMatchServices, createMatchPools } from '../aggregates/createMatchServices.ts';

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

const defaultSpawnPoints: SpawnPoint[] = [
  { x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 0 },
  { x: 128, y: 128, sectorCoord: { row: 0, col: 0 }, priority: 1 },
  { x: 192, y: 192, sectorCoord: { row: 0, col: 0 }, priority: 2 },
  { x: 256, y: 256, sectorCoord: { row: 0, col: 0 }, priority: 3 },
];

function createMatch(): GameMatch {
  const grid = makeGrid(10, 10, TileType.EMPTY);
  const spawnPoints = defaultSpawnPoints;
  const config = createTestConfig();
  const services = createMatchServices(config);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', config, grid, spawnPoints, services, pools, lootRng);
}

describe('GameMatch.alivePlayerCount', () => {
  it('returns 0 on empty match', () => {
    const match = createMatch();
    expect(match.alivePlayerCount).toBe(0);
  });

  it('increments on addPlayer', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    expect(match.alivePlayerCount).toBe(1);
    match.addPlayer('p2', 'Bob');
    expect(match.alivePlayerCount).toBe(2);
  });

  it('decrements on dieWithTick', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    expect(match.alivePlayerCount).toBe(2);
    const p1 = match.getPlayer('p1')!;
    p1.dieWithTick(10);
    expect(match.alivePlayerCount).toBe(1);
  });

  it('decrements on die', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    expect(match.alivePlayerCount).toBe(2);
    const p1 = match.getPlayer('p1')!;
    p1.die();
    expect(match.alivePlayerCount).toBe(1);
  });

  it('decrements on removePlayer', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.removePlayer('p1');
    expect(match.alivePlayerCount).toBe(1);
  });

  it('increments on revive', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    const p1 = match.getPlayer('p1')!;
    p1.die();
    expect(match.alivePlayerCount).toBe(1);
    p1.revive(20);
    expect(match.alivePlayerCount).toBe(2);
  });

  it('handles full spawn → death → revive sequence', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.addPlayer('p3', 'Charlie');
    expect(match.alivePlayerCount).toBe(3);

    match.getPlayer('p1')!.dieWithTick(5);
    expect(match.alivePlayerCount).toBe(2);

    match.getPlayer('p2')!.die();
    expect(match.alivePlayerCount).toBe(1);

    match.getPlayer('p1')!.revive(20);
    expect(match.alivePlayerCount).toBe(2);

    match.getPlayer('p2')!.revive(30);
    expect(match.alivePlayerCount).toBe(3);
  });
});

describe('GameMatch.forEachAlivePlayer', () => {
  it('visits no players on empty match', () => {
    const match = createMatch();
    let count = 0;
    match.forEachAlivePlayer(() => {
      count++;
    });
    expect(count).toBe(0);
  });

  it('visits exactly alive players', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.addPlayer('p3', 'Charlie');
    const visited: string[] = [];
    match.forEachAlivePlayer((p) => {
      visited.push(p.id);
    });
    expect(visited).toHaveLength(3);
    expect(visited.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips dead players', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.addPlayer('p3', 'Charlie');
    match.getPlayer('p2')!.dieWithTick(5);
    const visited: string[] = [];
    match.forEachAlivePlayer((p) => {
      visited.push(p.id);
    });
    expect(visited).toHaveLength(2);
    expect(visited.sort()).toEqual(['p1', 'p3']);
  });

  it('skips spectating players', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.getPlayer('p1')!.die();
    const visited: string[] = [];
    match.forEachAlivePlayer((p) => {
      visited.push(p.id);
    });
    expect(visited).toEqual(['p2']);
  });

  it('includes revived players after death', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.getPlayer('p1')!.die();
    match.getPlayer('p1')!.revive(10);
    const visited: string[] = [];
    match.forEachAlivePlayer((p) => {
      visited.push(p.id);
    });
    expect(visited).toHaveLength(2);
    expect(visited.sort()).toEqual(['p1', 'p2']);
  });

  it('skips players removed via removePlayer', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    match.addPlayer('p2', 'Bob');
    match.removePlayer('p1');
    const visited: string[] = [];
    match.forEachAlivePlayer((p) => {
      visited.push(p.id);
    });
    expect(visited).toEqual(['p2']);
  });
});
