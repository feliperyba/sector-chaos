import { TileType } from '../enums/TileType.js';
import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData, SectorConnection } from './types.js';
import { TILE_PIXEL_SIZE, SECTOR_TILE_SIZE, SECTOR_GRID_SIZE } from './constants.js';
import { isTraversable, buildCompositeGrid, gridBfs, findFirstPassable } from './gridUtils.js';

export class SectorConnector {
  connect(
    sectors: SectorData[][],
    _rng: SeededRNG,
  ): { connections: SectorConnection[]; corridorTiles: Set<string> } {
    const connections: SectorConnection[] = [];
    const corridorTiles = new Set<string>();
    const half = Math.floor(SECTOR_TILE_SIZE / 2);
    const offsets = [half - 1, half, half + 1];
    const lastTile = SECTOR_TILE_SIZE - 1;

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        if (col < SECTOR_GRID_SIZE - 1) {
          const sectorA = sectors[row]![col]!;
          const sectorB = sectors[row]![col + 1]!;
          if (!sectorA.tiles || !sectorB.tiles) continue;

          for (const r of offsets) {
            sectorA.tiles[r]![lastTile] = TileType.EMPTY;
            sectorB.tiles[r]![0] = TileType.EMPTY;
            corridorTiles.add(`${row},${col},${r},${lastTile}`);
            corridorTiles.add(`${row},${col + 1},${r},0`);
          }

          connections.push({
            sectorA: { row, col },
            sectorB: { row, col: col + 1 },
            width: 3,
            positionA: {
              x: sectorA.bounds.x + lastTile * TILE_PIXEL_SIZE,
              y: sectorA.bounds.y + offsets[0]! * TILE_PIXEL_SIZE,
            },
            positionB: {
              x: sectorB.bounds.x,
              y: sectorB.bounds.y + offsets[0]! * TILE_PIXEL_SIZE,
            },
          });
        }

        if (row < SECTOR_GRID_SIZE - 1) {
          const sectorA = sectors[row]![col]!;
          const sectorB = sectors[row + 1]![col]!;
          if (!sectorA.tiles || !sectorB.tiles) continue;

          for (const c of offsets) {
            sectorA.tiles[lastTile]![c] = TileType.EMPTY;
            sectorB.tiles[0]![c] = TileType.EMPTY;
            corridorTiles.add(`${row},${col},${lastTile},${c}`);
            corridorTiles.add(`${row + 1},${col},0,${c}`);
          }

          connections.push({
            sectorA: { row, col },
            sectorB: { row: row + 1, col },
            width: 3,
            positionA: {
              x: sectorA.bounds.x + offsets[0]! * TILE_PIXEL_SIZE,
              y: sectorA.bounds.y + lastTile * TILE_PIXEL_SIZE,
            },
            positionB: {
              x: sectorB.bounds.x + offsets[0]! * TILE_PIXEL_SIZE,
              y: sectorB.bounds.y,
            },
          });
        }
      }
    }

    this.ensureInteriorConnectivity(sectors);

    return { connections, corridorTiles };
  }

  private ensureInteriorConnectivity(sectors: SectorData[][]): void {
    const gridSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
    const maxIterations = 50;

    for (let iter = 0; iter < maxIterations; iter++) {
      const grid = buildCompositeGrid(sectors);
      const start = findFirstPassable(grid, isTraversable);
      if (!start) return;

      const { visited: reached, count: reachedCount } = gridBfs({
        grid,
        startR: start.r,
        startC: start.c,
        passable: isTraversable,
      });

      let totalPassable = 0;
      for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
          if (isTraversable(grid[r]![c]!)) totalPassable++;
        }
      }

      if (reachedCount >= totalPassable * 0.99) return;

      let unreachedR = -1;
      let unreachedC = -1;
      for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
          if (!isTraversable(grid[r]![c]!)) continue;
          if (!reached[r * gridSize + c]) {
            unreachedR = r;
            unreachedC = c;
            break;
          }
        }
        if (unreachedR !== -1) break;
      }

      if (unreachedR === -1) return;

      const path = this.findNearestWallBetween(grid, gridSize, reached, unreachedR, unreachedC);
      if (path.length === 0) return;

      // Carve the WHOLE contiguous wall run on the path between the pocket and the
      // reached region in one shot, producing a clean corridor-like cut instead of
      // scattered single tiles. Traversable cells on the path are left untouched.
      let carved = false;
      for (const cellIdx of path) {
        const cellR = (cellIdx / gridSize) | 0;
        const cellC = cellIdx % gridSize;
        if (isTraversable(grid[cellR]![cellC]!)) continue;

        const sRow = (cellR / SECTOR_TILE_SIZE) | 0;
        const sCol = (cellC / SECTOR_TILE_SIZE) | 0;
        const localR = cellR % SECTOR_TILE_SIZE;
        const localC = cellC % SECTOR_TILE_SIZE;

        const sector = sectors[sRow]?.[sCol];
        if (!sector) continue;

        sector.tiles[localR]![localC] = TileType.EMPTY;
        carved = true;
      }

      // No wall was actually opened this iteration — further iterations would loop
      // on the same pocket, so bail out.
      if (!carved) return;
    }
  }

  /**
   * BFS out from an unreached pocket through wall and traversable cells until the
   * reached region is met, then return the full path (array of grid indices, from
   * the reached meeting cell back to the pocket) so the caller can convert the
   * whole contiguous wall run between them to EMPTY. Returns an empty array if no
   * connection can be found.
   */
  private findNearestWallBetween(
    grid: Uint8Array[],
    gridSize: number,
    reached: Uint8Array,
    targetR: number,
    targetC: number,
  ): number[] {
    const dirs = [-1, 0, 1, 0, 0, -1, 0, 1];
    const dist = new Int32Array(gridSize * gridSize).fill(-1);
    const prev = new Int32Array(gridSize * gridSize).fill(-1);
    const startIdx = targetR * gridSize + targetC;
    dist[startIdx] = 0;
    const queue: number[] = [startIdx];
    let head = 0;

    while (head < queue.length) {
      const idx = queue[head++]!;
      const r = (idx / gridSize) | 0;
      const c = idx % gridSize;

      if (idx !== startIdx && reached[idx] && isTraversable(grid[r]![c]!)) {
        const path: number[] = [];
        let walkIdx = idx;
        while (walkIdx !== -1) {
          path.push(walkIdx);
          walkIdx = prev[walkIdx]!;
        }
        return path;
      }

      for (let d = 0; d < 8; d += 2) {
        const nr = r + dirs[d]!;
        const nc = c + dirs[d + 1]!;
        if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;
        const nIdx = nr * gridSize + nc;
        if (dist[nIdx] !== -1) continue;
        dist[nIdx] = dist[idx]! + 1;
        prev[nIdx] = idx;
        if (grid[nr]![nc]! === TileType.INDESTRUCTIBLE_WALL) {
          queue.push(nIdx);
        } else if (isTraversable(grid[nr]![nc]!)) {
          queue.push(nIdx);
        }
      }
    }

    return [];
  }
}
