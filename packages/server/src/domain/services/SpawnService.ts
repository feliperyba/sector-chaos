import type { SpawnPoint } from '@sector-battle/shared';
import {
  Interpolation,
  TileType,
  logger,
  SPAWN_DESTRUCTIBLE_CLEARANCE,
} from '@sector-battle/shared';
import { simRandom } from '../shared/SimRandom.ts';

const MIN_SPAWN_SPACING = 256;
/**
 * Destructible clearance around a spawn tile (Manhattan, tiles). Single
 * source of truth: the shared constant the map-redesign ticket-10 fairness
 * repair uses to exclude server-rejected tiles from its eligible pool (same
 * value as the historical local literal — pure import, no behavior change).
 */
const SPAWN_VALIDATION_CLEARANCE = SPAWN_DESTRUCTIBLE_CLEARANCE;

export interface SpawnValidationContext {
  grid: TileType[][];
  tileWidth: number;
  tileHeight: number;
  hasSiegeWall(gridX: number, gridY: number): boolean;
  destructiblePositions(): Array<{ gridX: number; gridY: number }>;
}

interface PickedSpawn {
  pos: { x: number; y: number };
  spawnKey: string;
}

export class SpawnService {
  private spawnPoints: SpawnPoint[] = [];
  private assignments: Map<string, { x: number; y: number }> = new Map();
  private playerSpawnKeys: Map<string, string> = new Map();
  private spawnKeyRefCount: Map<string, number> = new Map();
  private validationCtx: SpawnValidationContext | null = null;

  initialize(spawnPoints: SpawnPoint[]): void {
    this.spawnPoints = [...spawnPoints].sort((a, b) => a.priority - b.priority);
    this.assignments.clear();
    this.playerSpawnKeys.clear();
    this.spawnKeyRefCount.clear();
    logger.info(
      `[SpawnService] Initialized with ${this.spawnPoints.length} spawn points` +
        (this.spawnPoints.length > 0
          ? ` | first=(${this.spawnPoints[0]!.x.toFixed(0)},${this.spawnPoints[0]!.y.toFixed(0)}) last=(${this.spawnPoints[this.spawnPoints.length - 1]!.x.toFixed(0)},${this.spawnPoints[this.spawnPoints.length - 1]!.y.toFixed(0)})`
          : ''),
    );
  }

  setValidationContext(ctx: SpawnValidationContext): void {
    this.validationCtx = ctx;
  }

  assignSpawnPoints(playerIds: string[]): Map<string, { x: number; y: number }> {
    if (this.spawnPoints.length === 0) {
      logger.warn('[SpawnService] No spawn points available!');
      return new Map();
    }

    const unassigned = playerIds.filter((id) => !this.assignments.has(id));
    if (unassigned.length === 0) return new Map(this.assignments);

    const validSpawns = this.getValidSpawnPoints();

    if (validSpawns.length < this.spawnPoints.length) {
      logger.info(
        `[SpawnService] Validation filtered ${this.spawnPoints.length - validSpawns.length}/${this.spawnPoints.length} spawn points (${validSpawns.length} valid, ${this.assignments.size} already assigned, ${unassigned.length} to assign)`,
      );
    }

    for (const playerId of unassigned) {
      const { pos, spawnKey } = this.pickFarthestPoint(validSpawns);
      this.assignments.set(playerId, pos);
      this.playerSpawnKeys.set(playerId, spawnKey);
      this.spawnKeyRefCount.set(spawnKey, (this.spawnKeyRefCount.get(spawnKey) ?? 0) + 1);
      logger.info(
        `[SpawnService] Assigned ${playerId} → (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}) [${spawnKey}] | total assignments: ${this.assignments.size}`,
      );
    }

    return new Map(this.assignments);
  }

  releaseAssignment(playerId: string): void {
    const spawnKey = this.playerSpawnKeys.get(playerId);
    if (spawnKey) {
      const count = this.spawnKeyRefCount.get(spawnKey) ?? 0;
      if (count <= 1) {
        this.spawnKeyRefCount.delete(spawnKey);
      } else {
        this.spawnKeyRefCount.set(spawnKey, count - 1);
      }
      this.playerSpawnKeys.delete(playerId);
    }
    this.assignments.delete(playerId);
  }

  /**
   * Get all spawn points. Validation filtering was removed because it
   * over-filtered spawn points near destructibles, reducing the pool below
   * the player count and causing multiple players to stack on the same spawn.
   * The SpawnPointFinder already ensures spawns are on EMPTY tiles.
   */
  private getValidSpawnPoints(): SpawnPoint[] {
    return [...this.spawnPoints];
  }

  /**
   * Pick the spawn point that maximizes minimum distance to all existing
   * assignments. Prefers spawn points with no active references. When all
   * unique spawn points are exhausted, allows reuse with jitter to prevent
   * perfect overlap.
   */
  private pickFarthestPoint(validSpawns: SpawnPoint[]): PickedSpawn {
    const existingPositions = Array.from(this.assignments.values());

    const unusedSpawns = validSpawns.filter((sp) => !this.spawnKeyRefCount.has(`${sp.x},${sp.y}`));
    const pool = unusedSpawns.length > 0 ? unusedSpawns : validSpawns;

    if (existingPositions.length === 0) {
      const sp = pool[0] ?? validSpawns[0] ?? this.spawnPoints[0]!;
      return { pos: { x: sp.x, y: sp.y }, spawnKey: `${sp.x},${sp.y}` };
    }

    let bestSpawn = pool[0] ?? validSpawns[0] ?? this.spawnPoints[0]!;
    let bestMinDist = -1;

    for (const sp of pool) {
      let minDist = Infinity;
      for (const pos of existingPositions) {
        const d = Interpolation.distance(sp.x, sp.y, pos.x, pos.y);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestSpawn = sp;
      }
    }

    const spawnKey = `${bestSpawn.x},${bestSpawn.y}`;

    if (bestMinDist < MIN_SPAWN_SPACING) {
      const jitterRange = 64;
      const jx = (simRandom('spawn-jitter') - 0.5) * 2 * jitterRange;
      const jy = (simRandom('spawn-jitter') - 0.5) * 2 * jitterRange;
      return { pos: { x: bestSpawn.x + jx, y: bestSpawn.y + jy }, spawnKey };
    }

    return { pos: { x: bestSpawn.x, y: bestSpawn.y }, spawnKey };
  }

  private isSpawnPointValid(sp: SpawnPoint): boolean {
    if (!this.validationCtx) return true;

    const { grid, tileWidth, tileHeight } = this.validationCtx;
    const gx = Math.floor(sp.x / tileWidth);
    const gy = Math.floor(sp.y / tileHeight);

    if (gy < 0 || gy >= grid.length || gx < 0 || gx >= (grid[0]?.length ?? 0)) return false;
    if (grid[gy]![gx] !== TileType.EMPTY) return false;
    if (this.validationCtx.hasSiegeWall(gx, gy)) return false;

    for (const d of this.validationCtx.destructiblePositions()) {
      if (Math.abs(d.gridX - gx) + Math.abs(d.gridY - gy) <= SPAWN_VALIDATION_CLEARANCE)
        return false;
    }

    return true;
  }
}
