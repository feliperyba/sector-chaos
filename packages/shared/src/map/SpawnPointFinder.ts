import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData, SpawnPoint } from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  MIN_SPAWN_DIST,
} from './constants.js';
import { isEmptyTile } from './gridUtils.js';

const TARGET_SPAWNS_PER_SECTOR = 4;
const TARGET_TOTAL_SPAWNS = SECTOR_GRID_SIZE * SECTOR_GRID_SIZE * TARGET_SPAWNS_PER_SECTOR;
const MIN_MANHATTAN_TILES = 3;
const MIN_GLOBAL_DIST_PX = MIN_SPAWN_DIST;

export { MIN_SPAWN_DIST };

interface SpawnCandidate {
  row: number;
  col: number;
  distToCenter: number;
}

export class SpawnPointFinder {
  find(sectors: SectorData[][], _rng: SeededRNG): SpawnPoint[] {
    const sectorSpawns: SpawnPoint[][] = [];
    const spawnCounts: number[] = [];
    const usedPositions: Set<string>[] = [];
    const candidateCounts: number[] = [];

    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const idx = sRow * SECTOR_GRID_SIZE + sCol;
        const sector = sectors[sRow]![sCol]!;
        const candidates = this.collectCandidates(sector);
        candidateCounts[idx] = candidates.length;
        const selected = this.selectSpawnsForSector(
          candidates,
          TARGET_SPAWNS_PER_SECTOR,
          MIN_MANHATTAN_TILES,
        );
        const used = new Set<string>();
        for (const c of selected) {
          used.add(`${c.row},${c.col}`);
        }
        usedPositions[idx] = used;
        sectorSpawns[idx] = this.toSpawnPoints(selected, sRow, sCol, sector);
        spawnCounts[idx] = selected.length;
      }
    }

    const totalCandidates = candidateCounts.reduce((a, b) => a + b, 0);
    if (totalCandidates < TARGET_TOTAL_SPAWNS) {
      const details = candidateCounts
        .map((count, idx) => {
          const r = Math.floor(idx / SECTOR_GRID_SIZE);
          const c = idx % SECTOR_GRID_SIZE;
          return `  [${r},${c}]: ${count} valid tiles`;
        })
        .join('\n');
      throw new Error(
        `Not enough valid EMPTY tiles for ${TARGET_TOTAL_SPAWNS} spawns (found ${totalCandidates} candidates)\n${details}`,
      );
    }

    this.handleOverflow(sectors, sectorSpawns, spawnCounts, usedPositions);

    let allSpawns = sectorSpawns.flat();

    // Global pass: remove spawns that are too close to spawns in OTHER sectors.
    // The per-sector selection only guarantees spacing within each sector;
    // spawns near sector borders can be very close to spawns in adjacent sectors.
    allSpawns = this.enforceGlobalSpacing(allSpawns, sectors);

    this.assignPriorities(allSpawns);

    return allSpawns;
  }

  private collectCandidates(sector: SectorData): SpawnCandidate[] {
    const tiles = sector.tiles;
    const centerRow = Math.floor(SECTOR_TILE_SIZE / 2);
    const centerCol = Math.floor(SECTOR_TILE_SIZE / 2);
    const candidates: SpawnCandidate[] = [];

    for (let r = 1; r < SECTOR_TILE_SIZE - 1; r++) {
      for (let c = 1; c < SECTOR_TILE_SIZE - 1; c++) {
        if (!isEmptyTile(tiles[r]![c]!)) continue;
        const dx = c - centerCol;
        const dy = r - centerRow;
        candidates.push({ row: r, col: c, distToCenter: Math.sqrt(dx * dx + dy * dy) });
      }
    }

    return candidates;
  }

  private selectSpawnsForSector(
    candidates: SpawnCandidate[],
    maxSpawns: number,
    minManhattan: number,
  ): SpawnCandidate[] {
    if (candidates.length === 0) return [];

    const sorted = [...candidates].sort((a, b) => a.distToCenter - b.distToCenter);
    const selected: SpawnCandidate[] = [sorted[0]!];

    while (selected.length < maxSpawns && selected.length < candidates.length) {
      let bestCandidate: SpawnCandidate | null = null;
      let bestMinDist = -1;

      for (const candidate of candidates) {
        if (selected.some((s) => s.row === candidate.row && s.col === candidate.col)) continue;

        let minDist = Infinity;
        let valid = true;
        for (const s of selected) {
          const manhattan = Math.abs(candidate.row - s.row) + Math.abs(candidate.col - s.col);
          if (manhattan < minManhattan) {
            valid = false;
            break;
          }
          minDist = Math.min(minDist, manhattan);
        }
        if (!valid) continue;

        if (
          minDist > bestMinDist ||
          (minDist === bestMinDist &&
            candidate.distToCenter < (bestCandidate?.distToCenter ?? Infinity))
        ) {
          bestMinDist = minDist;
          bestCandidate = candidate;
        }
      }

      if (!bestCandidate) break;
      selected.push(bestCandidate);
    }

    return selected;
  }

  private handleOverflow(
    sectors: SectorData[][],
    sectorSpawns: SpawnPoint[][],
    spawnCounts: number[],
    usedPositions: Set<string>[],
  ): void {
    const total = spawnCounts.reduce((a, b) => a + b, 0);
    if (total >= TARGET_TOTAL_SPAWNS) return;

    const deficits: { idx: number; deficit: number }[] = [];
    for (let idx = 0; idx < SECTOR_GRID_SIZE * SECTOR_GRID_SIZE; idx++) {
      const deficit = TARGET_SPAWNS_PER_SECTOR - spawnCounts[idx]!;
      if (deficit > 0) deficits.push({ idx, deficit });
    }

    deficits.sort((a, b) => b.deficit - a.deficit);

    for (const { idx, deficit } of deficits) {
      const sRow = Math.floor(idx / SECTOR_GRID_SIZE);
      const sCol = idx % SECTOR_GRID_SIZE;
      const neighbors = this.getNeighborIndices(sRow, sCol);

      for (let i = 0; i < deficit; i++) {
        const sorted = [...neighbors].sort((a, b) => spawnCounts[a]! - spawnCounts[b]!);
        for (const nIdx of sorted) {
          const nRow = Math.floor(nIdx / SECTOR_GRID_SIZE);
          const nCol = nIdx % SECTOR_GRID_SIZE;
          const sector = sectors[nRow]![nCol]!;
          const candidates = this.collectCandidates(sector);
          const available = candidates.filter(
            (c) => !usedPositions[nIdx]!.has(`${c.row},${c.col}`),
          );
          const existingCoords = this.getSpawnTileCoords(sectorSpawns[nIdx]!, sector);
          const valid = this.filterByMinManhattan(available, existingCoords, MIN_MANHATTAN_TILES);

          if (valid.length === 0) continue;

          const pick = this.pickMaxMinDist(valid, existingCoords);
          usedPositions[nIdx]!.add(`${pick.row},${pick.col}`);
          sectorSpawns[nIdx]!.push({
            x: sector.bounds.x + pick.col * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
            y: sector.bounds.y + pick.row * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
            sectorCoord: { row: nRow, col: nCol },
            priority: 0,
          });
          spawnCounts[nIdx]!++;
          break;
        }
      }
    }
  }

  private getNeighborIndices(sRow: number, sCol: number): number[] {
    const neighbors: number[] = [];
    const dirs: readonly (readonly [number, number])[] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    for (const [dr, dc] of dirs) {
      const r = sRow + dr;
      const c = sCol + dc;
      if (r >= 0 && r < SECTOR_GRID_SIZE && c >= 0 && c < SECTOR_GRID_SIZE) {
        neighbors.push(r * SECTOR_GRID_SIZE + c);
      }
    }
    return neighbors;
  }

  private getSpawnTileCoords(
    spawns: SpawnPoint[],
    sector: SectorData,
  ): { row: number; col: number }[] {
    return spawns.map((sp) => ({
      col: Math.round((sp.x - sector.bounds.x) / TILE_PIXEL_SIZE),
      row: Math.round((sp.y - sector.bounds.y) / TILE_PIXEL_SIZE),
    }));
  }

  private filterByMinManhattan(
    candidates: SpawnCandidate[],
    existing: { row: number; col: number }[],
    minManhattan: number,
  ): SpawnCandidate[] {
    return candidates.filter((c) => {
      for (const e of existing) {
        if (Math.abs(c.row - e.row) + Math.abs(c.col - e.col) < minManhattan) return false;
      }
      return true;
    });
  }

  private pickMaxMinDist(
    candidates: SpawnCandidate[],
    existing: { row: number; col: number }[],
  ): SpawnCandidate {
    let best = candidates[0]!;
    let bestMinDist = -1;

    for (const c of candidates) {
      let minDist = Infinity;
      for (const e of existing) {
        minDist = Math.min(minDist, Math.abs(c.row - e.row) + Math.abs(c.col - e.col));
      }
      if (
        minDist > bestMinDist ||
        (minDist === bestMinDist && c.distToCenter < best.distToCenter)
      ) {
        bestMinDist = minDist;
        best = c;
      }
    }

    return best;
  }

  private toSpawnPoints(
    candidates: SpawnCandidate[],
    sRow: number,
    sCol: number,
    sector: SectorData,
  ): SpawnPoint[] {
    return candidates.map((c) => ({
      x: sector.bounds.x + c.col * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      y: sector.bounds.y + c.row * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      sectorCoord: { row: sRow, col: sCol },
      priority: 0,
    }));
  }

  /**
   * Remove or relocate spawn points that are closer than MIN_GLOBAL_DIST_PX to
   * a spawn in a different sector. The per-sector selection only checks
   * intra-sector spacing; spawns near sector borders can end up very close to
   * spawns in adjacent sectors.
   *
   * Algorithm: iterate spawns sorted by distance-to-map-center (keep central
   * spawns, relocate peripheral ones). For each spawn, if it's too close to an
   * already-kept spawn, try to find a replacement candidate in the same sector
   * that IS far enough. If no replacement exists, drop the spawn.
   */
  private enforceGlobalSpacing(spawns: SpawnPoint[], sectors: SectorData[][]): SpawnPoint[] {
    if (spawns.length <= 1) return spawns;

    const mapSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE;
    const cx = mapSize / 2;
    const cy = mapSize / 2;

    // Sort by distance to center (closest first — prefer keeping central spawns)
    const sorted = [...spawns].sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
      const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
      return da - db;
    });

    const kept: SpawnPoint[] = [];

    for (const sp of sorted) {
      const tooClose = kept.some((k) => {
        const dx = sp.x - k.x;
        const dy = sp.y - k.y;
        return Math.sqrt(dx * dx + dy * dy) < MIN_GLOBAL_DIST_PX;
      });

      if (!tooClose) {
        kept.push(sp);
        continue;
      }

      // Try to find a replacement in the same sector
      const replacement = this.findReplacementSpawn(sp, sectors, kept);
      if (replacement) {
        kept.push(replacement);
      }
      // If no replacement found, this spawn is dropped (total may be < 64)
    }

    return kept;
  }

  /**
   * Find an alternative spawn point in the same sector that is far enough from
   * all kept spawns. Returns null if no valid candidate exists.
   */
  private findReplacementSpawn(
    original: SpawnPoint,
    sectors: SectorData[][],
    kept: SpawnPoint[],
  ): SpawnPoint | null {
    const { row: sRow, col: sCol } = original.sectorCoord;
    if (sRow === undefined || sCol === undefined) return null;

    const sector = sectors[sRow]?.[sCol];
    if (!sector) return null;

    // Collect all EMPTY candidates in this sector
    const candidates = this.collectCandidates(sector);

    // Sort by distance from the original spawn (prefer nearby replacements)
    const origCol = Math.round((original.x - sector.bounds.x) / TILE_PIXEL_SIZE);
    const origRow = Math.round((original.y - sector.bounds.y) / TILE_PIXEL_SIZE);

    const ranked = candidates
      .map((c) => ({
        ...c,
        globalX: sector.bounds.x + c.col * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
        globalY: sector.bounds.y + c.row * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      }))
      .sort((a, b) => {
        const da = (a.col - origCol) ** 2 + (a.row - origRow) ** 2;
        const db = (b.col - origCol) ** 2 + (b.row - origRow) ** 2;
        return da - db;
      });

    for (const c of ranked) {
      const tooCloseToKept = kept.some((k) => {
        const dx = c.globalX - k.x;
        const dy = c.globalY - k.y;
        return Math.sqrt(dx * dx + dy * dy) < MIN_GLOBAL_DIST_PX;
      });
      if (!tooCloseToKept) {
        // Also ensure it's far enough from other candidates we might pick
        const tooCloseToSectorSpawns = kept.some((k) => {
          const dx = c.globalX - k.x;
          const dy = c.globalY - k.y;
          return (
            Math.abs(c.col - Math.round((k.x - sector.bounds.x) / TILE_PIXEL_SIZE)) +
              Math.abs(c.row - Math.round((k.y - sector.bounds.y) / TILE_PIXEL_SIZE)) <
            MIN_MANHATTAN_TILES
          );
        });
        if (!tooCloseToSectorSpawns) {
          return {
            x: c.globalX,
            y: c.globalY,
            sectorCoord: { row: sRow, col: sCol },
            priority: 0,
          };
        }
      }
    }

    return null;
  }

  private assignPriorities(spawns: SpawnPoint[]): void {
    const mapSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE;
    const centerX = mapSize / 2;
    const centerY = mapSize / 2;

    const sorted = [...spawns].sort((a, b) => {
      const da = (a.x - centerX) ** 2 + (a.y - centerY) ** 2;
      const db = (b.x - centerX) ** 2 + (b.y - centerY) ** 2;
      return da - db;
    });

    for (let i = 0; i < sorted.length; i++) {
      sorted[i]!.priority = sorted.length - i;
    }
  }
}
