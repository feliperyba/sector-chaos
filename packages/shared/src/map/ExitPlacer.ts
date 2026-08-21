import { TileType } from '../enums/TileType.js';
import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData, ExitData } from './types.js';
import { TILE_PIXEL_SIZE } from './constants.js';
import { gridBfs, findFirstPassable, isEmptyTile } from './gridUtils.js';

const MAX_EXITS = 8;
const MIN_DISTANCE = 400;

interface ExitCandidate {
  sectorRow: number;
  sectorCol: number;
  direction: 'N' | 'S' | 'E' | 'W';
  tileRow: number;
  tileCol: number;
  position: { x: number; y: number };
}

export class ExitPlacer {
  place(sectors: SectorData[][], rng: SeededRNG): ExitData[] {
    const candidates = this.collectCandidates(sectors);
    const shuffled = rng.shuffle(candidates);
    const exits: ExitData[] = [];

    for (const candidate of shuffled) {
      if (exits.length >= MAX_EXITS) break;

      const tooClose = exits.some((e) => {
        const dx = e.position.x - candidate.position.x;
        const dy = e.position.y - candidate.position.y;
        return Math.sqrt(dx * dx + dy * dy) < MIN_DISTANCE;
      });

      if (tooClose) continue;

      const candidateSector = sectors[candidate.sectorRow]?.[candidate.sectorCol];
      if (
        !candidateSector ||
        !this.isReachableFromInterior(candidateSector, candidate.tileRow, candidate.tileCol)
      ) {
        continue;
      }

      exits.push({
        id: `exit_${candidate.sectorRow}_${candidate.sectorCol}_${candidate.direction}`,
        position: candidate.position,
        direction: candidate.direction,
        targetSectorCoord: null,
        cooldown: 5000,
        isExtraction: true,
      });
    }

    return exits;
  }

  private collectCandidates(sectors: SectorData[][]): ExitCandidate[] {
    const candidates: ExitCandidate[] = [];
    const rows = sectors.length;
    const cols = sectors[0]!.length;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const isEdge = row === 0 || row === rows - 1 || col === 0 || col === cols - 1;
        if (!isEdge) continue;

        const sector = sectors[row]![col]!;

        if (row > 0) {
          this.addEdgeCandidates(
            candidates,
            sector,
            row,
            col,
            'N',
            row - 1,
            col,
            0,
            1,
            sector.tiles[0]!.length - 2,
          );
        }
        if (row < rows - 1) {
          this.addEdgeCandidates(
            candidates,
            sector,
            row,
            col,
            'S',
            row + 1,
            col,
            sector.tiles.length - 1,
            1,
            sector.tiles[0]!.length - 2,
          );
        }
        if (col > 0) {
          this.addEdgeCandidates(candidates, sector, row, col, 'W', row, col - 1, 1, 0, 0, true);
        }
        if (col < cols - 1) {
          this.addEdgeCandidates(
            candidates,
            sector,
            row,
            col,
            'E',
            row,
            col + 1,
            1,
            sector.tiles[0]!.length - 1,
            0,
            true,
          );
        }
      }
    }

    return candidates;
  }

  private addEdgeCandidates(
    candidates: ExitCandidate[],
    sector: SectorData,
    sectorRow: number,
    sectorCol: number,
    direction: 'N' | 'S' | 'E' | 'W',
    _targetRow: number,
    _targetCol: number,
    edgeRowStart: number,
    edgeColStart: number,
    edgeLimit: number,
    isVertical?: boolean,
  ): void {
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;

    if (isVertical) {
      const col = edgeColStart;
      for (let row = 1; row < height - 1; row++) {
        if (tiles[row]![col] === TileType.EMPTY) {
          candidates.push({
            sectorRow,
            sectorCol,
            direction,
            tileRow: row,
            tileCol: col,
            position: {
              x: sector.bounds.x + col * TILE_PIXEL_SIZE,
              y: sector.bounds.y + row * TILE_PIXEL_SIZE,
            },
          });
        }
      }
    } else {
      const row = edgeRowStart;
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] === TileType.EMPTY) {
          candidates.push({
            sectorRow,
            sectorCol,
            direction,
            tileRow: row,
            tileCol: col,
            position: {
              x: sector.bounds.x + col * TILE_PIXEL_SIZE,
              y: sector.bounds.y + row * TILE_PIXEL_SIZE,
            },
          });
        }
      }
    }
  }

  private isReachableFromInterior(sector: SectorData, tileRow: number, tileCol: number): boolean {
    const start = findFirstPassable(sector.tiles, isEmptyTile);
    if (!start) return false;

    const result = gridBfs({
      grid: sector.tiles,
      startR: start.r,
      startC: start.c,
      passable: isEmptyTile,
      earlyStop: (r, c) => r === tileRow && c === tileCol,
    });
    return result.stopped;
  }
}
