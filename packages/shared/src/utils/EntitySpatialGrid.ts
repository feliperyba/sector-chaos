/**
 * EntitySpatialGrid — flat uniform spatial hash (typed-array backed) for fast
 * range queries over transient entities.
 *
 * Moved from `packages/server/src/ai/` to shared so both server (bot
 * perception) and client (interaction detection) can share one implementation.
 * The cell size is configurable at construction (default 512px to preserve the
 * original bot-perception sizing).
 *
 * Design: a singly-linked-list-in-arrays (head[cell] → next[slot]) over a fixed
 * grid of `cellSize`-pixel cells. `clear()` is O(cells) via `head.fill(-1)` and
 * `insert`/`query` are O(1)/O(neighbors) with zero allocation after construction.
 */
export class EntitySpatialGrid {
  private cols: number;
  private rows: number;
  private head: Int32Array;
  private next: Int32Array;
  private maxEntities: number;
  private readonly _cellSize: number;
  private readonly cellSizeInv: number;

  constructor(mapWidth: number, mapHeight: number, maxEntities: number, cellSize = 512) {
    this._cellSize = cellSize;
    this.cellSizeInv = 1 / cellSize;
    this.cols = Math.max(1, Math.ceil(mapWidth * this.cellSizeInv));
    this.rows = Math.max(1, Math.ceil(mapHeight * this.cellSizeInv));
    this.maxEntities = maxEntities;
    const totalCells = this.cols * this.rows;
    this.head = new Int32Array(totalCells).fill(-1);
    this.next = new Int32Array(maxEntities).fill(-1);
  }

  clear(): void {
    this.head.fill(-1);
  }

  insert(slot: number, x: number, y: number): void {
    const inv = this.cellSizeInv;
    let cx = (x * inv) | 0;
    let cy = (y * inv) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    const cell = cy * this.cols + cx;
    this.next[slot] = this.head[cell]!;
    this.head[cell] = slot;
  }

  query(centerX: number, centerY: number, range: number, callback: (slot: number) => void): void {
    const inv = this.cellSizeInv;
    let minCx = ((centerX - range) * inv) | 0;
    let maxCx = ((centerX + range) * inv) | 0;
    let minCy = ((centerY - range) * inv) | 0;
    let maxCy = ((centerY + range) * inv) | 0;
    if (minCx < 0) minCx = 0;
    if (minCy < 0) minCy = 0;
    if (maxCx >= this.cols) maxCx = this.cols - 1;
    if (maxCy >= this.rows) maxCy = this.rows - 1;

    const cols = this.cols;
    const head = this.head;
    const next = this.next;

    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowBase = cy * cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        let slot = head[rowBase + cx]!;
        while (slot >= 0) {
          callback(slot);
          slot = next[slot]!;
        }
      }
    }
  }

  getMaxEntities(): number {
    return this.maxEntities;
  }

  /** Configured cell size in pixels. */
  get cellSize(): number {
    return this._cellSize;
  }
}
