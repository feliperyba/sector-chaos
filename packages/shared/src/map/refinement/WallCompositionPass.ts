import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import { SectorType } from '../types.js';
import { SECTOR_TILE_SIZE } from '../constants.js';
import { isWallLikeTile } from '../gridUtils.js';
import { getTile, setTile, GRID_SIZE } from './GridAccess.js';

/** Outer perimeter index — tiles at 0 or GRID_SIZE-1 are never touched. */
const PERIMETER_LAST = GRID_SIZE - 1;

/**
 * Wall Composition Pass (map-polish ticket 14) — the generation-side
 * enforcement of the wall composition rules, so wall-shape defects can never
 * ship green again:
 *
 * 1. **No orphan indestructible stubs outside sanctioned placements.** An
 *    interior `INDESTRUCTIBLE_WALL` tile whose 8-neighbourhood contains zero
 *    wall-like tiles is a 1-tile shard the strip-art kit renders as a floating
 *    half-strip (D7). The recurring source is the "1-tile notched remnant at
 *    a gate jamb": a 2-wide gate/die-roll gap carved into an authored wall run
 *    can strand the run's last tile (Plaza Crossroads corner-room gaps, Lane
 *    Corridor doorways, Supply Depot shelf gaps, Bank Row entrances, Treasure
 *    Vault rings). SANCTIONED and untouched: the 1×1 separator residue inside
 *    MAZE sectors — that is the authored maze pillar topology (see
 *    `validatorGates.collectSanctionedStubCells`). Unsanctioned stubs are
 *    cleared to EMPTY (matches the `MacroHealPass` stub strategy — opening a
 *    tile can never seal or disconnect anything).
 *
 * 2. **Breakable WALL cover stays in ≥2-tile clusters.** An orphaned
 *    `DESTRUCTIBLE_WALL` (no wall-like neighbour) is a shard by the same D7
 *    geometry, but deleting cover would thin the map — so the shard becomes a
 *    `DESTRUCTIBLE_CRATE`: the sanctioned single-tile cover-object read
 *    (crate-yard object, not a standing wall), keeping the cover count
 *    byte-for-byte while every remaining standing wall tile is clustered
 *    (≥2 tiles or attached to structure).
 *
 * Determinism contract (ADR 0035): a PURE function of the sector tiles — no
 * RNG, no wall-clock, no global state. Two-phase (collect decisions against
 * the ORIGINAL state, then apply) mirrors `MacroHealPass`; the decisions never
 * interact (an orphan by definition has no wall-like neighbour, so clearing or
 * converting one cannot orphan another). Seeds whose grids hold no unsanctioned
 * orphans pass through byte-identical.
 */
export class WallCompositionPass {
  /**
   * Run the composition pass against the sector grid (mutated in place).
   *
   * @param sectors The 2D sector grid, AFTER every wall-writing pass
   *   (skeletons, connector, macro features + heal, refinement, plaza
   *   stamps) and BEFORE entity/loot/spawn placement.
   * @returns Telemetry: how many stubs were cleared / shards converted.
   */
  run(sectors: SectorData[][]): { clearedStubs: number; convertedShards: number } {
    const toClear: Array<[number, number]> = [];
    const toCrate: Array<[number, number]> = [];

    for (let r = 1; r < PERIMETER_LAST; r++) {
      for (let c = 1; c < PERIMETER_LAST; c++) {
        const tile = getTile(sectors, r, c);
        if (tile !== TileType.INDESTRUCTIBLE_WALL && tile !== TileType.DESTRUCTIBLE_WALL) {
          continue;
        }
        if (this.countWallLikeNeighbours8(sectors, r, c) !== 0) continue;

        if (tile === TileType.DESTRUCTIBLE_WALL) {
          toCrate.push([r, c]);
          continue;
        }
        // Indestructible stub: sanctioned maze separator residue stays.
        const sectorRow = Math.floor(r / SECTOR_TILE_SIZE);
        const sectorCol = Math.floor(c / SECTOR_TILE_SIZE);
        if (sectors[sectorRow]?.[sectorCol]?.type === SectorType.MAZE) continue;
        toClear.push([r, c]);
      }
    }

    for (const [r, c] of toClear) setTile(sectors, r, c, TileType.EMPTY);
    for (const [r, c] of toCrate) setTile(sectors, r, c, TileType.DESTRUCTIBLE_CRATE);

    return { clearedStubs: toClear.length, convertedShards: toCrate.length };
  }

  /** Wall-like 8-neighbour count across sector boundaries (render semantics). */
  private countWallLikeNeighbours8(
    sectors: SectorData[][],
    globalR: number,
    globalC: number,
  ): number {
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        // getTile returns -1 out-of-bounds (GridAccess convention) — never
        // wall-like, so the map edge reads as "no neighbour".
        if (isWallLikeTile(getTile(sectors, globalR + dr, globalC + dc))) count++;
      }
    }
    return count;
  }
}
