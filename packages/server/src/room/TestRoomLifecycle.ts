import type { GameConfig, SpawnPoint, EnrichedMapData } from '@sector-battle/shared';
import { TileType, PLAYER, COMBAT, ZONE, MATCH, GRID, NETWORK } from '@sector-battle/shared';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';

export interface TestRoomOptions {
  botCount?: number;
  difficulty?: 'easy' | 'normal' | 'hard';
  mapPath?: string;
  debug?: boolean;
}

export interface JoinOptions {
  name?: string;
}

const TPS = NETWORK.TICK_RATE;

export const TEST_CONFIG: GameConfig = {
  player: {
    baseSpeed: PLAYER.BASE_SPEED,
    dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
    dashDuration: Math.round(PLAYER.DASH_DURATION * TPS),
    dashCooldown: Math.round(PLAYER.DASH_COOLDOWN * TPS),
    baseHealth: PLAYER.BASE_HEALTH,
    maxHealth: PLAYER.MAX_HEALTH,
    inventorySize: PLAYER.INVENTORY_SIZE,
    hitboxWidth: PLAYER.HITBOX_WIDTH,
    hitboxHeight: PLAYER.HITBOX_HEIGHT,
  },
  zone: {
    phases: ZONE.PHASES.map((p) => ({
      index: p.index,
      radiusRatio: p.radiusRatio,
      duration: p.duration,
      name: p.name,
    })),
    totalDuration: ZONE.TOTAL_DURATION,
    transitionDuration: ZONE.ZONE_TRANSITION_DURATION,
    tickInterval: ZONE.ZONE_TICK_INTERVAL,
    warningTime: ZONE.ZONE_WARNING_TIME,
  },
  match: {
    targetDuration: Math.round(MATCH.TARGET_DURATION * TPS),
    maxPlayers: MATCH.MAX_PLAYERS,
    minPlayers: 1,
    countdownDuration: Math.round(MATCH.COUNTDOWN_DURATION * TPS),
    overtimeStart: MATCH.OVERTIME_START,
    lastStandingThreshold: 0,
  },
  map: {
    tileWidth: GRID.TILE_SIZE,
    tileHeight: GRID.TILE_SIZE,
    arenaWidth: 22,
    arenaHeight: 22,
    sectorSize: 4,
    corridorWidth: 3,
    destructibleDensity: 0.3,
    chestDensity: 0.05,
    exitCount: 3,
  },
  combat: {
    knockbackForce: COMBAT.KNOCKBACK_FORCE,
    knockbackDecay: COMBAT.KNOCKBACK_DECAY,
    throwRange: COMBAT.THROW_RANGE,
    bounceFactor: COMBAT.BOUNCE_FACTOR,
    maxBounces: COMBAT.MAX_BOUNCES,
    friendlyFire: COMBAT.FRIENDLY_FIRE,
  },
  network: {
    tickRate: NETWORK.TICK_RATE,
    patchRate: NETWORK.PATCH_RATE,
    maxLatency: NETWORK.MAX_LATENCY,
    inputBufferSize: NETWORK.INPUT_BUFFER_SIZE,
    snapshotInterval: NETWORK.SNAPSHOT_INTERVAL,
  },
};

export function buildSpawnPoints(data: EnrichedMapData): SpawnPoint[] {
  const ts = data.tileSize;
  const grid = data.grid;
  const mapH = grid.length;
  const mapW = grid[0]?.length ?? 0;
  const WALL_PADDING = 2;

  // Start with all TMX-defined spawn points (tile centers)
  const spawns: SpawnPoint[] = [];
  const usedTiles = new Set<string>();

  for (const sp of data.entities.spawnPoints) {
    const key = `${sp.gridX},${sp.gridY}`;
    if (usedTiles.has(key)) continue;
    usedTiles.add(key);
    spawns.push({
      x: sp.gridX * ts + ts / 2,
      y: sp.gridY * ts + ts / 2,
      sectorCoord: {
        row: Math.floor(sp.gridY / Math.max(1, Math.floor(mapH / 4))),
        col: Math.floor(sp.gridX / Math.max(1, Math.floor(mapW / 4))),
      },
      priority: 0,
    });
  }

  // Collect all candidate tiles: EMPTY with wall padding
  const candidates: Array<{ gx: number; gy: number }> = [];
  for (let y = WALL_PADDING; y < mapH - WALL_PADDING; y++) {
    for (let x = WALL_PADDING; x < mapW - WALL_PADDING; x++) {
      if (grid[y]![x] !== TileType.EMPTY) continue;
      let safe = true;
      for (let dy = -WALL_PADDING; dy <= WALL_PADDING && safe; dy++) {
        for (let dx = -WALL_PADDING; dx <= WALL_PADDING && safe; dx++) {
          const cell = grid[y + dy]![x + dx]!;
          if (cell !== TileType.EMPTY && cell !== TileType.EXIT) safe = false;
        }
      }
      if (safe) candidates.push({ gx: x, gy: y });
    }
  }

  // Farthest-point sampling to fill up to 40 spawn points
  const TARGET_SPAWNS = 40;
  const existingPositions = spawns.map((s) => ({ x: s.x, y: s.y }));

  while (spawns.length < TARGET_SPAWNS && candidates.length > 0) {
    let bestIdx = -1;
    let bestMinDist = -1;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const cx = c.gx * ts + ts / 2;
      const cy = c.gy * ts + ts / 2;

      let minDist = Infinity;
      for (const ep of existingPositions) {
        const dx = cx - ep.x;
        const dy = cy - ep.y;
        const d = dx * dx + dy * dy;
        if (d < minDist) minDist = d;
      }

      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;

    const c = candidates[bestIdx]!;
    const cx = c.gx * ts + ts / 2;
    const cy = c.gy * ts + ts / 2;
    spawns.push({
      x: cx,
      y: cy,
      sectorCoord: {
        row: Math.floor(c.gy / Math.max(1, Math.floor(mapH / 4))),
        col: Math.floor(c.gx / Math.max(1, Math.floor(mapW / 4))),
      },
      priority: 0,
    });
    existingPositions.push({ x: cx, y: cy });
    candidates.splice(bestIdx, 1);
  }

  // Assign priorities: closer to center = higher priority
  const centerX = (mapW * ts) / 2;
  const centerY = (mapH * ts) / 2;
  spawns.sort((a, b) => {
    const da = (a.x - centerX) ** 2 + (a.y - centerY) ** 2;
    const db = (b.x - centerX) ** 2 + (b.y - centerY) ** 2;
    return db - da; // farthest from center = lowest priority
  });
  for (let i = 0; i < spawns.length; i++) {
    spawns[i]!.priority = spawns.length - i;
  }

  return spawns;
}

export function findTilesOfType(
  grid: TileType[][],
  type: TileType,
): Array<{ gridX: number; gridY: number }> {
  const result: Array<{ gridX: number; gridY: number }> = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y]!.length; x++) {
      if (grid[y]![x] === type) {
        result.push({ gridX: x, gridY: y });
      }
    }
  }
  return result;
}

export function createPathfinder(mapGrid: TileType[][], tileWidth: number): Pathfinder {
  const grid: boolean[][] = [];
  for (let y = 0; y < mapGrid.length; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < mapGrid[y]!.length; x++) {
      row.push(mapGrid[y]![x] === TileType.EMPTY || mapGrid[y]![x] === TileType.EXIT);
    }
    grid.push(row);
  }
  return new Pathfinder(grid, tileWidth, mapGrid);
}
