import type { SeededRNG } from './rng/SeededRNG.js';
import { SectorType } from './types.js';
import { SECTOR_GRID_SIZE, CENTER_SECTOR_WEIGHTS, OUTER_SECTOR_WEIGHTS } from './constants.js';
import { getSectorRing } from './gridUtils.js';

/** The four sector types, in stable iteration order. */
const SECTOR_TYPES: SectorType[] = [
  SectorType.GRID_ARENA,
  SectorType.OPEN_ARENA,
  SectorType.MAZE,
  SectorType.RESOURCE_RICH,
];

/**
 * Builds the SECTOR_GRID_SIZE × SECTOR_GRID_SIZE per-sector {@link SectorType}
 * grid using center-hot weighted placement (ADR 0027 / T3) plus deterministic
 * fix-up passes. Stateless: every call draws from the supplied RNG and returns
 * a fresh grid.
 *
 * ⚠️ RNG CONTRACT — READ BEFORE MODIFYING:
 * {@link distribute} draws from the SHARED `rng` stream passed in by
 * {@link MapGenerator.runPipeline}. The NUMBER and ORDER of draws is
 * load-bearing: every downstream consumer (`generateSectorLayouts`,
 * `SectorConnector.connect`, `EntityPlacer.place`, `LootSpawner.spawn`,
 * `ExitPlacer.place`, `SpawnPointFinder.find`, `generateWeather`) draws from
 * the SAME stream AFTER this method returns. Adding, removing, or reordering a
 * draw here shifts every downstream subSeed and breaks byte-identity of the
 * generated map.
 *
 * DO NOT fork an isolated RNG (e.g. `new SeededRNG(seed ^ SALT)`). This class
 * mirrors {@link RefinementPipeline}'s STRUCTURAL shape only (stateless class,
 * single entry method, returns plain data) — it explicitly does NOT inherit
 * RefinementPipeline's RNG-isolation pattern (which forks its own seed-derived
 * stream precisely so it does NOT perturb `rng`). The contradiction is
 * intentional: type-grid output must be a function of the shared stream so
 * downstream draws stay aligned.
 *
 * The golden refactor-stability test
 * (`src/map/__tests__/MapGeneratorGolden.test.ts`) pins whole-`MapData` output
 * for 4 seeds and catches any divergence introduced here.
 */
export class SectorDistributor {
  /**
   * Build the 4×4 type grid with center-hot placement (ADR 0027 / T3): the
   * inner 2×2 draws from {@link CENTER_SECTOR_WEIGHTS} (ResourceRich +
   * GridArena favored), the outer 12 sectors from {@link OUTER_SECTOR_WEIGHTS}
   * (OpenArena + Maze favored). A deterministic fix-up pass then guarantees the
   * center holds ≥1 ResourceRich and ≥1 GridArena and that all four types
   * appear at least once, followed by a light anti-clustering pass.
   *
   * ⚠️ This method advances the SHARED `rng` stream — see the class-level RNG
   * CONTRACT block. The draw count is exactly SECTOR_GRID_SIZE ×
   * SECTOR_GRID_SIZE calls to `rng.weightedPick` (one per cell), in row-major
   * order. Do not add or remove draws.
   *
   * @param rng - the seed-derived SHARED RNG (its draw order is load-bearing)
   * @returns the per-sector {@link SectorType} grid
   */
  distribute(rng: SeededRNG): SectorType[][] {
    const grid: SectorType[][] = [];

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      grid[row] = [];
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const ring = getSectorRing(row, col, SECTOR_GRID_SIZE);
        const weights = ring === 'center' ? CENTER_SECTOR_WEIGHTS : OUTER_SECTOR_WEIGHTS;
        grid[row]![col] = rng.weightedPick(weights);
      }
    }

    this.enforceCenterTypes(grid);
    this.enforceAllTypes(grid);
    this.spreadClusters(grid);

    return grid;
  }

  /** Coordinates of the inner 2×2 center zone (row in {1,2} AND col in {1,2}). */
  private centerCoords(): { row: number; col: number }[] {
    const coords: { row: number; col: number }[] = [];
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        if (getSectorRing(row, col, SECTOR_GRID_SIZE) === 'center') coords.push({ row, col });
      }
    }
    return coords;
  }

  /**
   * Guarantee the center 2×2 contains ≥1 ResourceRich AND ≥1 GridArena. If a
   * required type is missing, the deterministically-chosen center cell whose
   * type is over-represented there is overwritten. Pure function of the grid.
   *
   * @param grid - the type grid (mutated in place)
   */
  private enforceCenterTypes(grid: SectorType[][]): void {
    const center = this.centerCoords();
    for (const required of [SectorType.RESOURCE_RICH, SectorType.GRID_ARENA]) {
      const present = center.filter(({ row, col }) => grid[row]![col] === required).length;
      if (present > 0) continue;

      // Overwrite the center cell holding the most-duplicated type so we never
      // destroy the OTHER required type if it is already a singleton.
      const counts = new Map<SectorType, number>();
      for (const { row, col } of center) {
        const t = grid[row]![col]!;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      let best = center[0]!;
      let bestCount = -1;
      for (const cell of center) {
        const t = grid[cell.row]![cell.col]!;
        if (t === SectorType.RESOURCE_RICH || t === SectorType.GRID_ARENA) continue;
        const count = counts.get(t)!;
        if (count > bestCount) {
          bestCount = count;
          best = cell;
        }
      }
      grid[best.row]![best.col] = required;
    }
  }

  /**
   * Guarantee every {@link SectorType} appears at least once on the map. Any
   * missing type replaces an over-represented OUTER-ring cell (chosen
   * deterministically) so the center guarantees from {@link enforceCenterTypes}
   * are preserved.
   *
   * @param grid - the type grid (mutated in place)
   */
  private enforceAllTypes(grid: SectorType[][]): void {
    for (const required of SECTOR_TYPES) {
      if (grid.flat().some((t) => t === required)) continue;

      const counts = new Map<SectorType, number>();
      for (const row of grid) for (const t of row) counts.set(t, (counts.get(t) ?? 0) + 1);

      let best: { row: number; col: number } | null = null;
      let bestCount = -1;
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          if (getSectorRing(row, col, SECTOR_GRID_SIZE) !== 'outer') continue;
          const count = counts.get(grid[row]![col]!)!;
          // Only steal from a type with a duplicate, so we never erase the only
          // instance of some OTHER type while satisfying this one.
          if (count > 1 && count > bestCount) {
            bestCount = count;
            best = { row, col };
          }
        }
      }
      if (best) grid[best.row]![best.col] = required;
    }
  }

  /**
   * Light anti-clustering pass replacing the old `capConsecutive`: break any run
   * of three identical types in a row or column by retyping the third cell to a
   * deterministically-chosen alternative. Skips the center cells so it never
   * undoes the center guarantees. Pure function of the grid.
   *
   * @param grid - the type grid (mutated in place)
   */
  private spreadClusters(grid: SectorType[][]): void {
    const retype = (row: number, col: number): void => {
      if (getSectorRing(row, col, SECTOR_GRID_SIZE) === 'center') return;
      const current = grid[row]![col]!;
      const alternatives = SECTOR_TYPES.filter((t) => t !== current);
      grid[row]![col] = alternatives[(row + col) % alternatives.length]!;
    };

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 2; col < SECTOR_GRID_SIZE; col++) {
        if (grid[row]![col] === grid[row]![col - 1] && grid[row]![col] === grid[row]![col - 2]) {
          retype(row, col);
        }
      }
    }

    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      for (let row = 2; row < SECTOR_GRID_SIZE; row++) {
        if (grid[row]![col] === grid[row - 1]![col] && grid[row]![col] === grid[row - 2]![col]) {
          retype(row, col);
        }
      }
    }
  }
}
