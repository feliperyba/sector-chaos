export interface SiegeWallWarning {
  gridX: number;
  gridY: number;
  solidifyAt: number;
}

/**
 * Per-match siege wall storage.
 *
 * Walls live in a flat row-major `Uint8Array` bitmap (one byte per map tile,
 * index `gridY * gridCols + gridX`) instead of the previous
 * `Set<string>` of `` `${gridX},${gridY}` `` keys. `hasSiegeWall` runs inside
 * tight per-tick loops (siege ring computation, ring-droppable filtering,
 * barrel-explosion ray cells, spawn validation) and the string key was
 * allocated on every single call. The array is allocated once per match at
 * construction — there is no per-tick allocation.
 *
 * Behavior is identical to the legacy `Set<string>`:
 * - Walls are add-only and permanent for the manager's lifetime (GDD §8.1.3
 *   "Walls are permanent"); the manager is created once per match and never
 *   reset, so no removal path exists or is needed.
 * - Coordinates outside the map grid can never have been added, so
 *   `hasSiegeWall` returns `false` for them and `addWall` ignores them — the
 *   same result the old out-of-grid string keys produced (they never matched
 *   because they were never inserted).
 */
export class SiegeWallManager {
  private readonly gridCols: number;
  private readonly gridRows: number;
  private readonly walls: Uint8Array;
  private warnings: SiegeWallWarning[] = [];

  constructor(gridCols: number, gridRows: number) {
    this.gridCols = Math.max(0, Math.floor(gridCols));
    this.gridRows = Math.max(0, Math.floor(gridRows));
    this.walls = new Uint8Array(this.gridCols * this.gridRows);
  }

  hasSiegeWall(gridX: number, gridY: number): boolean {
    if (gridX < 0 || gridY < 0 || gridX >= this.gridCols || gridY >= this.gridRows) return false;
    return this.walls[gridY * this.gridCols + gridX] === 1;
  }

  addWall(gridX: number, gridY: number): void {
    if (gridX < 0 || gridY < 0 || gridX >= this.gridCols || gridY >= this.gridRows) return;
    this.walls[gridY * this.gridCols + gridX] = 1;
  }

  addWarning(gridX: number, gridY: number, solidifyAt: number): void {
    this.warnings.push({ gridX, gridY, solidifyAt });
  }

  getWarnings(): SiegeWallWarning[] {
    return this.warnings;
  }

  clearExpiredWarnings(currentTime: number): void {
    // In-place write-index compaction — retains the same elements in the same
    // order as the previous `Array.prototype.filter` without allocating a new
    // array on every call.
    const list = this.warnings;
    let write = 0;
    for (let read = 0; read < list.length; read++) {
      const warning = list[read]!;
      if (currentTime < warning.solidifyAt) {
        list[write] = warning;
        write++;
      }
    }
    list.length = write;
  }
}
