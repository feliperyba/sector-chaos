import { TileType, type SpawnPoint, type EnrichedMapData } from '@sector-battle/shared';

/**
 * Build the spawn-point list from an EnrichedMapData: starts with authored TMX
 * spawns, filters by connectivity, and farthest-point-samples additional spawns
 * to reach the target count.
 *
 * Pure mechanical extraction from the original GameRoomLifecycle.ts — body
 * verbatim, no logic changes.
 */
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

  // Connectivity filter: flood-fill from first walkable authored spawn,
  // keep only spawns/candidates in the main connected region.
  // Prevents bots from spawning in isolated map pockets.
  const walkableGrid: boolean[][] = grid.map((row) =>
    row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
  );
  const connectedSet = new Set<string>();
  const seedSp = data.entities.spawnPoints.find(
    (sp) => walkableGrid[sp.gridY]?.[sp.gridX] === true,
  );
  if (seedSp) {
    const bfsQueue: Array<[number, number]> = [[seedSp.gridX, seedSp.gridY]];
    connectedSet.add(`${seedSp.gridX},${seedSp.gridY}`);
    while (bfsQueue.length > 0) {
      const [bx, by] = bfsQueue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = bx + dx,
          ny = by + dy;
        if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
        const key = `${nx},${ny}`;
        if (connectedSet.has(key)) continue;
        if (!walkableGrid[ny]![nx]) continue;
        connectedSet.add(key);
        bfsQueue.push([nx, ny]);
      }
    }
  }

  // Filter authored spawns to connected region
  for (let i = spawns.length - 1; i >= 0; i--) {
    const gx = Math.floor(spawns[i]!.x / ts);
    const gy = Math.floor(spawns[i]!.y / ts);
    if (!connectedSet.has(`${gx},${gy}`)) {
      spawns.splice(i, 1);
    }
  }

  // Filter candidates to connected region
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!connectedSet.has(`${candidates[i]!.gx},${candidates[i]!.gy}`)) {
      candidates.splice(i, 1);
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
    return db - da;
  });
  for (let i = 0; i < spawns.length; i++) {
    spawns[i]!.priority = spawns.length - i;
  }

  return spawns;
}
