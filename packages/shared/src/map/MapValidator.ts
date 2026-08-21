import { TileType } from '../enums/TileType.js';
import type {
  MapData,
  ValidationResult,
  SectorData,
  ExitData,
  SpawnPoint,
  LootPlacement,
} from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  MIN_SPAWN_DIST,
  MIN_OPEN_RATIO,
  MIN_SPAWNS_PER_SECTOR,
  TARGET_TOTAL_SPAWNS,
  MAX_LONE_WALLS,
} from './constants.js';
import {
  isEmptyTile,
  isTraversable,
  buildCompositeGrid,
  gridBfs,
  findFirstPassable,
} from './gridUtils.js';
import {
  computeOpenRatio,
  countSpawnEligible,
  lootBudget,
  countLootEligible,
  countIsolatedStubWalls,
} from './validatorGates.js';
import { LANDMARK_REGISTRY } from './landmarkRegistry.js';
import { auditSpawnEquity, SPAWN_EQUITY_MAX_DEVIATION } from './spawnFairness.js';

const SECTOR_PIXEL_SIZE = SECTOR_TILE_SIZE * TILE_PIXEL_SIZE;
const COMPOSITE_SIZE = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;

function sectorCoordFromPosition(x: number, y: number): { row: number; col: number } {
  return {
    col: Math.min(Math.floor(x / SECTOR_PIXEL_SIZE), SECTOR_GRID_SIZE - 1),
    row: Math.min(Math.floor(y / SECTOR_PIXEL_SIZE), SECTOR_GRID_SIZE - 1),
  };
}

export class MapValidator {
  validate(mapData: MapData): ValidationResult {
    const errors: string[] = [];

    this.checkFloodFillConnectivity(mapData.sectors, errors);
    this.checkSpawnReachability(mapData.spawnPoints, mapData.sectors, errors);
    this.checkMinimumSpawnCount(mapData.spawnPoints, errors);
    this.checkExitAccessibility(mapData.exits, mapData.sectors, errors);
    this.checkLootDensity(mapData.lootPlacements, errors);
    this.checkSpawnSpacing(mapData.spawnPoints, errors);
    this.checkBorderWalls(mapData.sectors, errors);

    // Quality gates (T1): retried via the existing 10-retry loop.
    this.checkMinimumOpenSpace(mapData.sectors, errors);
    this.checkPerSectorSpawnFeasibility(mapData.sectors, errors);
    this.checkPerSectorLootFeasibility(mapData.sectors, mapData.corridorTiles, errors);
    this.checkNoIsolatedStubWalls(mapData.sectors, errors);
    // Map-redesign ticket 04: hero/minor landmark structural gate.
    this.checkLandmarks(mapData, errors);
    // Map-redesign ticket 10 (DEC-009): per-spawn value-vector equity gate —
    // validates the POST-repair state (MapGenerator repairs before validate).
    this.checkSpawnEquity(mapData, errors);

    return { valid: errors.length === 0, errors };
  }

  private checkFloodFillConnectivity(sectors: SectorData[][], errors: string[]): void {
    const grid = buildCompositeGrid(sectors);
    const start = findFirstPassable(grid, isEmptyTile);
    if (!start) {
      errors.push('No EMPTY tiles found in map — flood-fill has no start point');
      return;
    }

    const { count: reachedCount } = gridBfs({
      grid,
      startR: start.r,
      startC: start.c,
      passable: isEmptyTile,
    });

    let totalEmpty = 0;
    for (let r = 0; r < COMPOSITE_SIZE; r++) {
      for (let c = 0; c < COMPOSITE_SIZE; c++) {
        if (isEmptyTile(grid[r]![c]!)) totalEmpty++;
      }
    }

    const ratio = reachedCount / totalEmpty;
    if (ratio < 0.8) {
      errors.push(
        `Flood fill connectivity failed: ${reachedCount}/${totalEmpty} EMPTY tiles reachable (${(ratio * 100).toFixed(1)}%)`,
      );
    }
  }

  private checkSpawnReachability(
    spawns: SpawnPoint[],
    sectors: SectorData[][],
    errors: string[],
  ): void {
    const grid = buildCompositeGrid(sectors);
    const start = findFirstPassable(grid, isEmptyTile);
    if (!start) {
      errors.push('Cannot check spawn reachability: no passable tiles');
      return;
    }

    const { visited: reached } = gridBfs({
      grid,
      startR: start.r,
      startC: start.c,
      passable: isTraversable,
    });

    for (let i = 0; i < spawns.length; i++) {
      const sp = spawns[i]!;
      const compositeCol = Math.floor(sp.x / TILE_PIXEL_SIZE);
      const compositeRow = Math.floor(sp.y / TILE_PIXEL_SIZE);

      if (
        compositeRow < 0 ||
        compositeRow >= COMPOSITE_SIZE ||
        compositeCol < 0 ||
        compositeCol >= COMPOSITE_SIZE
      ) {
        errors.push(`Spawn ${i} at (${sp.x},${sp.y}) is out of bounds`);
        continue;
      }

      if (!isEmptyTile(grid[compositeRow]![compositeCol]!)) {
        errors.push(`Spawn ${i} at (${sp.x},${sp.y}) is on non-passable tile`);
        continue;
      }

      const idx = compositeRow * COMPOSITE_SIZE + compositeCol;
      if (!reached[idx]) {
        errors.push(`Spawn ${i} at (${sp.x},${sp.y}) is not reachable`);
      }
    }
  }

  private checkExitAccessibility(
    exits: ExitData[],
    sectors: SectorData[][],
    errors: string[],
  ): void {
    for (const exit of exits) {
      const coord = sectorCoordFromPosition(exit.position.x, exit.position.y);
      const sector = sectors[coord.row]?.[coord.col];
      if (!sector) {
        errors.push(`Exit ${exit.id} references invalid sector`);
        continue;
      }

      const tileCol = Math.floor(exit.position.x / TILE_PIXEL_SIZE) % SECTOR_TILE_SIZE;
      const tileRow = Math.floor(exit.position.y / TILE_PIXEL_SIZE) % SECTOR_TILE_SIZE;

      if (
        tileRow < 0 ||
        tileRow >= SECTOR_TILE_SIZE ||
        tileCol < 0 ||
        tileCol >= SECTOR_TILE_SIZE
      ) {
        errors.push(`Exit ${exit.id} at out-of-bounds tile position`);
        continue;
      }

      if (!isEmptyTile(sector.tiles[tileRow]![tileCol]!)) {
        errors.push(`Exit ${exit.id} is on non-passable tile`);
        continue;
      }

      const interior = findFirstPassable(sector.tiles, isEmptyTile);

      if (!interior) {
        errors.push(`Exit ${exit.id}: sector has no passable interior`);
        continue;
      }

      const { visited: sectorReached } = gridBfs({
        grid: sector.tiles,
        startR: interior.r,
        startC: interior.c,
        passable: isTraversable,
      });
      const targetIdx = tileRow * SECTOR_TILE_SIZE + tileCol;
      if (!sectorReached[targetIdx]) {
        errors.push(`Exit ${exit.id} is not reachable from sector interior`);
      }
    }
  }

  private checkLootDensity(lootPlacements: LootPlacement[], errors: string[]): void {
    const sectorLoot = new Map<string, number>();
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        sectorLoot.set(`${row},${col}`, 0);
      }
    }
    for (const lp of lootPlacements) {
      const key = `${lp.sectorCoord.row},${lp.sectorCoord.col}`;
      sectorLoot.set(key, (sectorLoot.get(key) ?? 0) + 1);
    }
    for (const [key, count] of sectorLoot) {
      if (count < 2) {
        errors.push(`Sector [${key}] has only ${count} loot placements (minimum 2)`);
      }
    }
  }

  private checkSpawnSpacing(spawns: SpawnPoint[], errors: string[]): void {
    const minDist = MIN_SPAWN_DIST;
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        const dx = spawns[i]!.x - spawns[j]!.x;
        const dy = spawns[i]!.y - spawns[j]!.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
          errors.push(`Spawns ${i} and ${j} are ${dist.toFixed(0)}px apart (min ${minDist}px)`);
          return;
        }
      }
    }
  }

  private checkMinimumSpawnCount(spawns: SpawnPoint[], errors: string[]): void {
    const required = 64;
    if (spawns.length < required) {
      errors.push(
        `Only ${spawns.length} spawn points found (minimum ${required} for 64-player mode)`,
      );
    }
  }

  private checkBorderWalls(sectors: SectorData[][], errors: string[]): void {
    const grid = buildCompositeGrid(sectors);
    const last = COMPOSITE_SIZE - 1;

    for (let c = 0; c < COMPOSITE_SIZE; c++) {
      if (grid[0]![c]! !== TileType.INDESTRUCTIBLE_WALL) {
        errors.push(`Border tile (0,${c}) is not INDESTRUCTIBLE_WALL`);
      }
      if (grid[last]![c]! !== TileType.INDESTRUCTIBLE_WALL) {
        errors.push(`Border tile (${last},${c}) is not INDESTRUCTIBLE_WALL`);
      }
    }

    for (let r = 1; r < last; r++) {
      if (grid[r]![0]! !== TileType.INDESTRUCTIBLE_WALL) {
        errors.push(`Border tile (${r},0) is not INDESTRUCTIBLE_WALL`);
      }
      if (grid[r]![last]! !== TileType.INDESTRUCTIBLE_WALL) {
        errors.push(`Border tile (${r},${last}) is not INDESTRUCTIBLE_WALL`);
      }
    }
  }

  /**
   * Gate 1 — minimum open-space. Fails when the composite interior is too
   * dense (EMPTY fraction below MIN_OPEN_RATIO), which would seal the map into
   * narrow corridors.
   * @param sectors The 2D grid of sector layouts to inspect.
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes an error string when the gate fails.
   */
  private checkMinimumOpenSpace(sectors: SectorData[][], errors: string[]): void {
    const ratio = computeOpenRatio(sectors);
    if (ratio < MIN_OPEN_RATIO) {
      errors.push(
        `Open-space too low: ${(ratio * 100).toFixed(1)}% interior EMPTY (minimum ${(
          MIN_OPEN_RATIO * 100
        ).toFixed(0)}%)`,
      );
    }
  }

  /**
   * Gate 2 — per-sector spawn feasibility. Each sector should yield at least
   * MIN_SPAWNS_PER_SECTOR eligible tiles; a sector below that is tolerated only
   * if the map-wide eligible total still meets TARGET_TOTAL_SPAWNS (the overflow
   * rule). Mirrors SpawnPointFinder's candidate rule so degenerate sectors are
   * retried before SpawnPointFinder can throw.
   * @param sectors The 2D grid of sector layouts to inspect.
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes an error string per starved sector / total.
   */
  private checkPerSectorSpawnFeasibility(sectors: SectorData[][], errors: string[]): void {
    let totalEligible = 0;
    const starved: { row: number; col: number; count: number }[] = [];
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const eligible = countSpawnEligible(sectors[row]![col]!);
        totalEligible += eligible;
        if (eligible < MIN_SPAWNS_PER_SECTOR) starved.push({ row, col, count: eligible });
      }
    }

    if (totalEligible >= TARGET_TOTAL_SPAWNS) return;

    // The overflow rule cannot reach 64 — report the shortfall and each
    // starved sector so the failing geometry is clear.
    errors.push(
      `Spawn feasibility: only ${totalEligible} eligible tiles map-wide (need ${TARGET_TOTAL_SPAWNS} for 64 spawns)`,
    );
    for (const s of starved) {
      errors.push(
        `Sector [${s.row},${s.col}] has ${s.count} spawn-eligible tiles (minimum ${MIN_SPAWNS_PER_SECTOR})`,
      );
    }
  }

  /**
   * Gate 3 — per-sector loot feasibility. Each sector needs enough
   * non-corridor, non-border EMPTY tiles (not adjacent to an indestructible
   * wall, matching EntityPlacer) to host its CHEST_COUNT + barrels + minimum
   * loot. Counts the candidate pool surviving at validation time.
   * @param sectors The 2D grid of sector layouts to inspect.
   * @param corridorTiles The set of corridor tile keys to exclude.
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes a per-sector error string when the budget cannot fit.
   */
  private checkPerSectorLootFeasibility(
    sectors: SectorData[][],
    corridorTiles: Set<string>,
    errors: string[],
  ): void {
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const sector = sectors[row]![col]!;
        const required = lootBudget(sector.type);
        const available = countLootEligible(sector, row, col, corridorTiles);
        if (available < required) {
          errors.push(
            `Sector [${row},${col}] loot infeasible: ${available} eligible tiles for budget ${required}`,
          );
        }
      }
    }
  }

  /**
   * Gate 4 — no isolated stub walls. Fails when the count of INDESTRUCTIBLE_WALL
   * interior tiles whose 8 neighbours contain zero other wall tiles exceeds
   * MAX_LONE_WALLS. Targets the ResourceRich "stub" artifact.
   * @param sectors The 2D grid of sector layouts to inspect.
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes an error string when stub walls exceed the limit.
   */
  private checkNoIsolatedStubWalls(sectors: SectorData[][], errors: string[]): void {
    const lone = countIsolatedStubWalls(sectors);
    if (lone > MAX_LONE_WALLS) {
      errors.push(`Too many isolated stub walls: ${lone} (maximum ${MAX_LONE_WALLS})`);
    }
  }

  /**
   * Gate 5 — hero/minor landmark structure (map-redesign ticket 04 / DEC-002).
   *
   * - Every sector carries exactly one hero landmark whose compositionId is in
   *   the sector type's registry.
   * - Orthogonally-adjacent sectors NEVER share a composition.
   * - Every hero anchor tile is TRAVERSABLE in the final composite grid (never
   *   an indestructible wall — the landmark cannot block a corridor or seal a
   *   room because composites are visual-only, but a wall-anchored landmark
   *   would also fail the reachability intent). The anchor is chosen on the
   *   pre-entity EMPTY grid; a chest/barrel may afterwards claim the tile —
   *   "loot crowds the landmark", the DEC-002 structure-alignment intent, and
   *   the entity stream stays byte-identical (ADR 0035).
   * - 2–3 minor landmarks exist and stay clear of every hero anchor.
   *
   * @param mapData The generated map (sectors + landmarks).
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes an error string per violation.
   */
  private checkLandmarks(mapData: MapData, errors: string[]): void {
    const landmarks = mapData.landmarks;
    if (!landmarks) {
      errors.push('Landmark gate: MapData carries no landmark assignment');
      return;
    }
    const grid = buildCompositeGrid(mapData.sectors);
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const hero = landmarks.heroes[row]?.[col];
        if (!hero) {
          errors.push(`Landmark gate: sector [${row},${col}] has no hero landmark`);
          continue;
        }
        const validIds = LANDMARK_REGISTRY[mapData.sectors[row]![col]!.type].map((e) => e.id);
        if (!validIds.includes(hero.compositionId)) {
          errors.push(
            `Landmark gate: sector [${row},${col}] composition "${hero.compositionId}" is not in its type's registry`,
          );
        }
        if (col > 0) {
          const west = landmarks.heroes[row]?.[col - 1];
          if (west && west.compositionId === hero.compositionId) {
            errors.push(
              `Landmark gate: adjacent sectors [${row},${col - 1}]/[${row},${col}] share composition "${hero.compositionId}"`,
            );
          }
        }
        if (row > 0) {
          const north = landmarks.heroes[row - 1]?.[col];
          if (north && north.compositionId === hero.compositionId) {
            errors.push(
              `Landmark gate: adjacent sectors [${row - 1},${col}]/[${row},${col}] share composition "${hero.compositionId}"`,
            );
          }
        }
        const tile = grid[hero.tileY]?.[hero.tileX];
        if (tile !== undefined && !isTraversable(tile)) {
          errors.push(
            `Landmark gate: sector [${row},${col}] hero anchor (${hero.tileX},${hero.tileY}) is not traversable`,
          );
        }
      }
    }
    const minorCount = landmarks.minors.length;
    if (minorCount < 2 || minorCount > 3) {
      errors.push(`Landmark gate: expected 2–3 minor landmarks, found ${minorCount}`);
    }
    for (const minor of landmarks.minors) {
      const tile = grid[minor.tileY]?.[minor.tileX];
      if (tile !== undefined && !isTraversable(tile)) {
        errors.push(
          `Landmark gate: minor landmark (${minor.tileX},${minor.tileY}) is not traversable`,
        );
      }
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          const hero = landmarks.heroes[row]?.[col];
          if (!hero) continue;
          const cheb = Math.max(
            Math.abs(hero.tileX - minor.tileX),
            Math.abs(hero.tileY - minor.tileY),
          );
          if (cheb < 4) {
            errors.push(
              `Landmark gate: minor landmark (${minor.tileX},${minor.tileY}) is adjacent to sector [${row},${col}]'s hero`,
            );
          }
        }
      }
    }
  }

  /**
   * Gate 6 — per-spawn value-vector equity (map-redesign ticket 10 /
   * DEC-009). Every spawn's value vector (distance to nearest ground weapon /
   * chest / field-loot clump + BFS path distance to the nearest effective-HOT
   * sector) must sit within `SPAWN_EQUITY_MAX_DEVIATION` of its OWN sector's
   * eligible-pool median (the "sector offer" — see spawnFairness.ts for why
   * the reference is per-sector, not map-wide). `MapGenerator` runs the local
   * repair pass before validating, so a violation reaching this gate is a
   * spawn the bounded repair could not fix — reject the attempt and let the
   * generation retry loop re-roll the map.
   * @param mapData The generated map (post-repair) to audit.
   * @param errors Accumulator for validation error strings.
   * @returns Nothing; pushes a bounded list of violation strings.
   */
  private checkSpawnEquity(mapData: MapData, errors: string[]): void {
    if (!mapData.sectorTiers || !mapData.hotSector) return; // pre-pyramid data — skip
    const audit = auditSpawnEquity(mapData);
    const listed = Math.min(audit.violations.length, 8);
    for (let i = 0; i < listed; i++) {
      const v = audit.violations[i]!;
      errors.push(
        `Spawn equity: spawn ${v.spawnIndex} in sector [${v.sector.row},${v.sector.col}] ` +
          `${v.component}=${v.value.toFixed(0)} vs sector-offer median ${v.median.toFixed(0)} ` +
          `(${v.ratio.toFixed(2)}x > ${(1 + SPAWN_EQUITY_MAX_DEVIATION).toFixed(2)}x)`,
      );
    }
    if (audit.violations.length > listed) {
      errors.push(`Spawn equity: ${audit.violations.length - listed} more violations`);
    }
  }
}
