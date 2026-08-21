import { ZONE, TileType } from '@sector-battle/shared';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';
import { SiegeWallManager } from '../aggregates/SiegeWallManager.ts';
import {
  continueCascade as continueCascadeFn,
  dropCascadeTile as dropCascadeTileFn,
} from './MapSiegeCascade.ts';
import {
  computeRings as computeRingsFn,
  maybeRecomputeRings as maybeRecomputeRingsFn,
  isSectorComplete as isSectorCompleteFn,
} from './MapSiegeRings.ts';

export interface SiegeEntityContext {
  getDestructibleAtTile(gridX: number, gridY: number): string | null;
  getChestAtTile(gridX: number, gridY: number): string | null;
  getWeaponPickupAtTile(gridX: number, gridY: number): string | null;
  getPowerUpAtTile(gridX: number, gridY: number): string | null;
  getTrapAtTile(gridX: number, gridY: number): string | null;
  destroyDestructible(id: string): void;
  removeChest(id: string): void;
  removeWeaponPickup(id: string): void;
  removePowerUp(id: string): void;
  removeTrap(id: string): void;
  crushPlayersOnTile(gridX: number, gridY: number): void;
  setSiegeWallCollider(gridX: number, gridY: number): void;
}

export interface CascadeState {
  coords: Array<{ gridX: number; gridY: number }>;
  tileIndex: number;
  lastTileTime: number;
}

export interface RingBatch {
  tiles: Array<{ gridX: number; gridY: number }>;
}

/**
 * One sector's independent siege. Per GDD §8.1.3 each sector closes on its own
 * once its CENTER leaves the safe circle. Walls drop in a radial flood-fill
 * pattern: tiles furthest from the zone center wall first, then progressively
 * closer tiles — creating a wave players can flee toward the safe zone.
 *
 * Each phase transition that shifts the zone center triggers a ring re-snapshot:
 * remaining unwalled tiles are re-sorted by distance to the NEW center, so the
 * wave always chases the current safe zone.
 */
export interface SectorSiege {
  row: number;
  col: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  rings: RingBatch[];
  currentRing: number;
  lastDropTime: number;
  warningIssued: boolean;
  cascade: CascadeState | null;
  lastCascadeEndTime: number;
  ringCenter: { x: number; y: number };
}

export class MapSiegeService {
  wallManager: SiegeWallManager;
  eventCollector = new EventCollector<GameEvent>();
  entityContext: SiegeEntityContext | null = null;
  private matchEnded = false;
  private initialized = false;
  private siegeStartTime = 0;
  private readonly sectorTileSize: number;
  private readonly sectorCols: number;
  private readonly sectorRows: number;
  private readonly sectors = new Map<string, SectorSiege>();
  /** Ever-activated sectors in row-major order — the per-tick iteration list
   * (the old sweep re-derived the key string and re-probed the Map for every
   * dead sector every tick). Row-major order is preserved on insert so the
   * per-tick updateSector/event order stays identical to the old sweep's. */
  private readonly activeSectors: SectorSiege[] = [];
  /** Row-major "sector ever created" flags (`row * sectorCols + col`) — O(1)
   * activation-sweep membership check without the `${row},${col}` key alloc. */
  private readonly sectorActive: Uint8Array;
  /** Zone params seen by the previous update() call. Activation
   * (`isOvertime || isSectorCenterOutside`) is a pure function of exactly
   * these, so while unchanged no sector can cross the activation boundary and
   * the full-grid activation sweep is skipped. NaN-init: first compare is
   * always "changed". */
  private lastZoneX = Number.NaN;
  private lastZoneY = Number.NaN;
  private lastZoneRadius = Number.NaN;
  private lastIsOvertime = false;
  /** Reusable ring-droppable scratch (compaction target of
   * `collectRingDroppableTiles`). Valid only until the next call; the cascade
   * start copies out of it. */
  private readonly droppableScratch: Array<{ gridX: number; gridY: number }> = [];

  constructor(
    wallManager: SiegeWallManager,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
    /** Public so the MapSiegeRings.ts helpers can read it (MapSiegeCascade precedent). */
    readonly tilePixelSize: number,
    sectorTileSize?: number,
  ) {
    this.wallManager = wallManager;
    this.sectorTileSize =
      sectorTileSize && sectorTileSize > 0 ? sectorTileSize : Math.max(mapWidth, mapHeight);
    this.sectorCols = Math.max(1, Math.ceil(mapWidth / this.sectorTileSize));
    this.sectorRows = Math.max(1, Math.ceil(mapHeight / this.sectorTileSize));
    this.sectorActive = new Uint8Array(this.sectorRows * this.sectorCols);
  }

  setEntityContext(ctx: SiegeEntityContext): void {
    this.entityContext = ctx;
  }

  update(
    currentTime: number,
    interval: number,
    grid: TileType[][],
    zoneCenter: { x: number; y: number },
    zoneRadius: number,
    isOvertime: boolean,
  ): GameEvent[] {
    if (this.matchEnded) return this.drainEvents();

    if (!this.initialized) {
      this.initialized = true;
      this.siegeStartTime = currentTime;
      for (let row = 0; row < this.sectorRows; row++) {
        for (let col = 0; col < this.sectorCols; col++) {
          if (isOvertime || this.isSectorCenterOutside(row, col, zoneCenter, zoneRadius)) {
            this.getOrCreateSector(row, col, currentTime, zoneCenter, grid);
          }
        }
      }
      this.rememberZoneParams(zoneCenter, zoneRadius, isOvertime);
      return this.drainEvents();
    }

    // Activation is a pure function of (zoneCenter, zoneRadius, isOvertime):
    // when none changed since the previous call, the outside-the-circle set
    // is exactly what it was then and every one of those sectors is already
    // in `activeSectors` (the init sweep or the last param-change sweep
    // materialized them under these very params) — so the full-grid
    // activation sweep can be skipped without missing any activation tick.
    const zoneChanged =
      zoneCenter.x !== this.lastZoneX ||
      zoneCenter.y !== this.lastZoneY ||
      zoneRadius !== this.lastZoneRadius ||
      isOvertime !== this.lastIsOvertime;

    if (zoneChanged) {
      this.rememberZoneParams(zoneCenter, zoneRadius, isOvertime);
      this.sweepNewActivations(currentTime, zoneCenter, zoneRadius, isOvertime, grid);
    } else if (this.activeSectors.length === 0) {
      // Short-circuit: no sector has EVER activated + params unchanged. The
      // old sweep here found every center inside (proven by the sweep that
      // first saw these params) and performed no writes — no sector creation,
      // no updateSector, no wallManager/grid/event mutations. Equivalent no-op.
      return this.drainEvents();
    }

    for (let i = 0; i < this.activeSectors.length; i++) {
      const sector = this.activeSectors[i]!;
      // Liveness filter — the same gate the old per-tick sweep applied: a
      // sector is only sieged while its center is currently outside the
      // circle (or overtime). The list is row-major, so the survivors iterate
      // in exactly the old sweep's order.
      if (
        !isOvertime &&
        !this.isSectorCenterOutside(sector.row, sector.col, zoneCenter, zoneRadius)
      ) {
        continue;
      }
      this.updateSector(sector, currentTime, interval, grid, zoneCenter);
    }

    return this.drainEvents();
  }

  stop(): void {
    this.matchEnded = true;
  }

  getWallManager(): SiegeWallManager {
    return this.wallManager;
  }

  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }

  isComplete(): boolean {
    if (this.sectors.size === 0) return false;
    for (const sector of this.sectors.values()) {
      if (!isSectorCompleteFn(this, sector)) return false;
    }
    return true;
  }

  /**
   * Vestigial — populates the client-unused MapSiegeProgress schema.
   * The ring-based siege doesn't track compass-side offsets.
   */
  getSideProgress(): {
    northOffset: number;
    eastOffset: number;
    southOffset: number;
    westOffset: number;
  } {
    return { northOffset: 0, eastOffset: 0, southOffset: 0, westOffset: 0 };
  }

  // ─── Ring computation (bodies in MapSiegeRings.ts — F8 extraction) ────────

  private computeRings(
    startX: number,
    startY: number,
    width: number,
    height: number,
    zoneCenter: { x: number; y: number },
    grid: TileType[][],
  ): RingBatch[] {
    return computeRingsFn(this, startX, startY, width, height, zoneCenter, grid);
  }

  private maybeRecomputeRings(
    sector: SectorSiege,
    zoneCenter: { x: number; y: number },
    grid: TileType[][],
  ): void {
    maybeRecomputeRingsFn(this, sector, zoneCenter, grid);
  }

  // ─── Per-sector update ───────────────────────────────────────────

  private updateSector(
    sector: SectorSiege,
    currentTime: number,
    interval: number,
    grid: TileType[][],
    zoneCenter: { x: number; y: number },
  ): void {
    this.maybeRecomputeRings(sector, zoneCenter, grid);

    if (sector.cascade) {
      const finished = this.continueCascade(sector, grid, currentTime);
      if (!finished) return;
      sector.cascade = null;
      sector.lastDropTime = currentTime;
      sector.warningIssued = false;
      sector.lastCascadeEndTime = currentTime;
      return;
    }

    this.fastForwardEmptyRings(sector, grid);
    if (sector.currentRing >= sector.rings.length) return;

    const effectiveLastDrop = Math.max(sector.lastDropTime, sector.lastCascadeEndTime);
    const elapsed = currentTime - effectiveLastDrop;
    const dropMs = interval * 1000;
    const warningMs = ZONE.SIEGE_WALL_WARNING_DURATION * 1000;
    const warningStartMs = dropMs - warningMs;

    if (!sector.warningIssued && elapsed >= warningStartMs) {
      sector.warningIssued = true;
      this.issueRingWarnings(sector, currentTime, effectiveLastDrop + dropMs, grid);
    }

    if (elapsed >= dropMs) {
      const count = this.collectRingDroppableTiles(sector, grid, this.droppableScratch);
      if (count > 0) {
        // The cascade retains `coords` across ticks, so it must own a fresh
        // array — the shared scratch is invalidated by the next collection.
        // Same single per-cascade-start allocation the old `.filter()`
        // produced, identical elements in identical order.
        const coords = Array.from({ length: count }, (_, i) => this.droppableScratch[i]!);
        sector.cascade = { coords, tileIndex: 0, lastTileTime: currentTime };
        this.dropCascadeTile(sector, grid, currentTime);
      } else {
        sector.currentRing++;
        sector.warningIssued = false;
      }
    }
  }

  /**
   * Write the current ring's droppable tiles into `out` via in-place
   * read/write-index compaction — exactly the tiles the previous
   * `ring.tiles.filter(...)` selected, same order, no per-call allocation.
   * Returns the count (sets `out.length` to it). The `out` contents are only
   * valid until the next call.
   */
  private collectRingDroppableTiles(
    sector: SectorSiege,
    grid: TileType[][],
    out: Array<{ gridX: number; gridY: number }>,
  ): number {
    if (sector.currentRing >= sector.rings.length) {
      out.length = 0;
      return 0;
    }
    const tiles = sector.rings[sector.currentRing]!.tiles;
    const gridRows = grid.length;
    const gridCols = grid[0]?.length ?? 0;
    let write = 0;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i]!;
      if (
        t.gridY >= 0 &&
        t.gridY < gridRows &&
        t.gridX >= 0 &&
        t.gridX < gridCols &&
        !this.wallManager.hasSiegeWall(t.gridX, t.gridY)
      ) {
        out[write++] = t;
      }
    }
    out.length = write;
    return write;
  }

  private fastForwardEmptyRings(sector: SectorSiege, grid: TileType[][]): void {
    while (sector.currentRing < sector.rings.length) {
      // Reusable scratch — this loop used to allocate a fresh filtered array
      // per iteration while fast-forwarding through empty rings.
      if (this.collectRingDroppableTiles(sector, grid, this.droppableScratch) > 0) return;
      sector.currentRing++;
    }
  }

  // ─── Cascade ─────────────────────────────────────────────────────

  private continueCascade(sector: SectorSiege, grid: TileType[][], currentTime: number): boolean {
    return continueCascadeFn(this, sector, grid, currentTime);
  }

  private dropCascadeTile(sector: SectorSiege, grid: TileType[][], currentTime: number): void {
    dropCascadeTileFn(this, sector, grid, currentTime);
  }

  // ─── Warnings ────────────────────────────────────────────────────

  private issueRingWarnings(
    sector: SectorSiege,
    currentTime: number,
    solidifyAt: number,
    grid: TileType[][],
  ): void {
    const count = this.collectRingDroppableTiles(sector, grid, this.droppableScratch);
    for (let i = 0; i < count; i++) {
      const c = this.droppableScratch[i]!;
      this.wallManager.addWarning(c.gridX, c.gridY, solidifyAt);
      this.eventCollector.emit({
        type: 'SiegeWallWarning',
        tick: 0,
        timestamp: currentTime,
        gridX: c.gridX,
        gridY: c.gridY,
        solidifyAt,
      });
    }
  }

  // ─── Sector lifecycle ────────────────────────────────────────────

  /** Full-grid activation sweep, run ONLY when the zone params changed since
   * the previous update() call. Creates every not-yet-created sector whose
   * activation predicate now holds — on the exact tick the old per-tick
   * sweep first saw it — and registers it in the active-sector list. */
  private sweepNewActivations(
    currentTime: number,
    zoneCenter: { x: number; y: number },
    zoneRadius: number,
    isOvertime: boolean,
    grid: TileType[][],
  ): void {
    for (let row = 0; row < this.sectorRows; row++) {
      for (let col = 0; col < this.sectorCols; col++) {
        if (this.sectorActive[row * this.sectorCols + col] === 1) continue;
        if (!isOvertime && !this.isSectorCenterOutside(row, col, zoneCenter, zoneRadius)) continue;
        this.getOrCreateSector(row, col, currentTime, zoneCenter, grid);
      }
    }
  }

  private rememberZoneParams(
    zoneCenter: { x: number; y: number },
    zoneRadius: number,
    isOvertime: boolean,
  ): void {
    this.lastZoneX = zoneCenter.x;
    this.lastZoneY = zoneCenter.y;
    this.lastZoneRadius = zoneRadius;
    this.lastIsOvertime = isOvertime;
  }

  /** Insert keeping row-major order (once per sector lifetime, on its
   * activation tick) — preserves the old sweep's updateSector/event order. */
  private insertActiveSector(sector: SectorSiege): void {
    let i = this.activeSectors.length;
    while (i > 0) {
      const prev = this.activeSectors[i - 1]!;
      if (prev.row < sector.row || (prev.row === sector.row && prev.col < sector.col)) break;
      i--;
    }
    this.activeSectors.splice(i, 0, sector);
  }

  private getOrCreateSector(
    row: number,
    col: number,
    currentTime: number,
    zoneCenter: { x: number; y: number },
    grid: TileType[][],
  ): SectorSiege {
    const key = `${row},${col}`;
    let sector = this.sectors.get(key);
    if (sector) return sector;

    const startX = col * this.sectorTileSize;
    const startY = row * this.sectorTileSize;
    const width = Math.min(this.sectorTileSize, this.mapWidth - startX);
    const height = Math.min(this.sectorTileSize, this.mapHeight - startY);
    const startClock =
      this.initialized && this.siegeStartTime > 0 ? currentTime : this.siegeStartTime;

    const rings = this.computeRings(startX, startY, width, height, zoneCenter, grid);

    sector = {
      row,
      col,
      startX,
      startY,
      width,
      height,
      rings,
      currentRing: 0,
      lastDropTime: startClock,
      warningIssued: false,
      cascade: null,
      lastCascadeEndTime: 0,
      ringCenter: { x: zoneCenter.x, y: zoneCenter.y },
    };
    this.sectors.set(key, sector);
    this.sectorActive[row * this.sectorCols + col] = 1;
    this.insertActiveSector(sector);
    return sector;
  }

  private isSectorCenterOutside(
    row: number,
    col: number,
    zoneCenter: { x: number; y: number },
    zoneRadius: number,
  ): boolean {
    const sectorPixelSize = this.sectorTileSize * this.tilePixelSize;
    const centerX = (col + 0.5) * sectorPixelSize;
    const centerY = (row + 0.5) * sectorPixelSize;
    const dx = centerX - zoneCenter.x;
    const dy = centerY - zoneCenter.y;
    return Math.sqrt(dx * dx + dy * dy) > zoneRadius;
  }

  // ─── Entity / player handling ────────────────────────────────────

  handlePlayersOnTile(gridX: number, gridY: number): void {
    if (!this.entityContext) return;
    this.entityContext.crushPlayersOnTile(gridX, gridY);
  }

  destroyEntitiesOnTile(gridX: number, gridY: number): void {
    if (!this.entityContext) return;

    const destructibleId = this.entityContext.getDestructibleAtTile(gridX, gridY);
    if (destructibleId) this.entityContext.destroyDestructible(destructibleId);

    const chestId = this.entityContext.getChestAtTile(gridX, gridY);
    if (chestId) this.entityContext.removeChest(chestId);

    const weaponPickupId = this.entityContext.getWeaponPickupAtTile(gridX, gridY);
    if (weaponPickupId) this.entityContext.removeWeaponPickup(weaponPickupId);

    const powerUpId = this.entityContext.getPowerUpAtTile(gridX, gridY);
    if (powerUpId) this.entityContext.removePowerUp(powerUpId);

    const trapId = this.entityContext.getTrapAtTile(gridX, gridY);
    if (trapId) this.entityContext.removeTrap(trapId);
  }
}
