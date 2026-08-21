import {
  ColliderCollision,
  createSiegeWallSpriteDef,
  resolveSimpleTileCollision,
  resolveTileCollisionEnriched,
  type CollisionGridProvider,
  type AABB,
  type MTV,
  TileType,
} from '@sector-battle/shared';
import type {
  ICollisionService,
  ResolvedPosition,
  EnrichedCollisionGrid,
} from './ICollisionService.ts';
import { logger } from '@sector-battle/shared';

export class CollisionService implements ICollisionService {
  private tileSize: number;
  private enrichedGrid: EnrichedCollisionGrid | null = null;
  private siegeWallSpriteIndex: number | null = null;
  private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  /** Out receptacle for the shared resolveSimpleTileCollision (ticket 43). */
  private readonly simpleOut: { x: number; y: number } = { x: 0, y: 0 };
  /** Out receptacle for the shared resolveTileCollisionEnriched (ticket 11). */
  private readonly enrichedOut: { x: number; y: number } = { x: 0, y: 0 };

  // ── Pooled CollisionGridProvider (perf ticket 11) ──────────────────────────
  // Mirrors the client's ticket-#36 pool: the provider object + its three
  // closures are allocated once, here, instead of per resolveEnriched call
  // (the production path — one resolve per MOVE input + per momentum-coast
  // player, ~15-20k allocs/sec at 64 players). The closures read
  // this.enrichedGrid at CALL time, so setEnrichedGrid needs no provider
  // refresh: resolveEnriched only runs while enrichedGrid is set, and nothing
  // in the shared resolver's call chain mutates it (setEnrichedGrid is an
  // init-time-only API, single-threaded). NOT re-entrant — matches the
  // single-threaded sim usage.
  private readonly gridProvider: CollisionGridProvider = {
    getVisual: (gx, gy) => {
      const data = this.enrichedGrid;
      return data ? data.visuals[gy]?.[gx] : undefined;
    },
    getSprite: (spriteId) => {
      const data = this.enrichedGrid;
      return data ? data.atlas.sprites[spriteId] : undefined;
    },
    getTileSize: () => this.tileSize,
  };

  constructor(tileSize: number) {
    this.tileSize = tileSize;
  }

  setEnrichedGrid(data: EnrichedCollisionGrid): void {
    this.enrichedGrid = data;
  }

  clearEnrichedVisual(gridX: number, gridY: number): void {
    if (!this.enrichedGrid) return;
    const row = this.enrichedGrid.visuals[gridY];
    if (row && row[gridX]) {
      row[gridX] = { spriteId: -1, rotation: 0, flipH: false, flipV: false };
    }
  }

  registerSiegeWallCollider(): void {
    if (this.siegeWallSpriteIndex !== null || !this.enrichedGrid) return;
    this.siegeWallSpriteIndex = this.enrichedGrid.atlas.sprites.length;
    this.enrichedGrid.atlas.sprites.push(createSiegeWallSpriteDef(this.tileSize));
  }

  setSiegeWallEnriched(gridX: number, gridY: number): void {
    if (this.siegeWallSpriteIndex === null || !this.enrichedGrid) return;
    const row = this.enrichedGrid.visuals[gridY];
    if (!row) return;
    row[gridX] = {
      spriteId: this.siegeWallSpriteIndex,
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  }

  resolveTileCollision(entity: AABB, grid: TileType[][]): ResolvedPosition {
    if (this.enrichedGrid) {
      return this.resolveEnriched(entity, grid);
    }
    return this.resolveSimple(entity, grid);
  }

  isTileBlocked(gridX: number, gridY: number, grid: TileType[][]): boolean {
    if (gridY < 0 || gridY >= grid.length) return true;
    if (gridX < 0 || gridX >= grid[0]!.length) return true;
    const tile = grid[gridY]![gridX]!;
    return tile !== TileType.EMPTY && tile !== TileType.EXIT;
  }

  isPointBlocked(x: number, y: number, grid: TileType[][]): boolean {
    const gx = Math.floor(x / this.tileSize);
    const gy = Math.floor(y / this.tileSize);
    if (!this.isTileBlocked(gx, gy, grid)) return false;

    // Enriched metadata first — mirror resolveEnriched semantics exactly so
    // the hands/blade obey the same shapes the body does.
    const data = this.enrichedGrid;
    if (data) {
      const visual = data.visuals[gy]?.[gx];
      if (visual && visual.spriteId >= 0) {
        const sprite = data.atlas.sprites[visual.spriteId];
        if (!sprite || sprite.colliders.length === 0) return false;
        if (sprite.tileType === TileType.EMPTY) return false;
        for (const collider of sprite.colliders) {
          const polygon = ColliderCollision.transformCollider(
            collider,
            gx,
            gy,
            this.tileSize,
            visual.rotation,
            visual.flipH,
            visual.flipV,
          );
          if (ColliderCollision.testPoint(x, y, polygon)) return true;
        }
        return false;
      }
    }

    return false;
  }

  segmentIntersectsTileCollider(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    expand: number,
    gridX: number,
    gridY: number,
  ): boolean {
    const data = this.enrichedGrid;
    if (!data) return false;
    const visual = data.visuals[gridY]?.[gridX];
    if (!visual || visual.spriteId < 0) return false;
    const sprite = data.atlas.sprites[visual.spriteId];
    if (!sprite || sprite.colliders.length === 0) return false;

    const minX = Math.min(x1, x2) - expand;
    const minY = Math.min(y1, y2) - expand;
    const maxX = Math.max(x1, x2) + expand;
    const maxY = Math.max(y1, y2) + expand;
    const segAABB: AABB = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

    for (const collider of sprite.colliders) {
      const polygon = ColliderCollision.transformCollider(
        collider,
        gridX,
        gridY,
        this.tileSize,
        visual.rotation,
        visual.flipH,
        visual.flipV,
      );
      if (ColliderCollision.testAABB(segAABB, polygon)) return true;
    }
    return false;
  }

  getColliderCentroid(gridX: number, gridY: number): { x: number; y: number } | null {
    const data = this.enrichedGrid;
    if (!data) return null;
    const visual = data.visuals[gridY]?.[gridX];
    if (!visual || visual.spriteId < 0) return null;
    const sprite = data.atlas.sprites[visual.spriteId];
    if (!sprite || sprite.colliders.length === 0) return null;

    // Average every transformed vertex across all collider polygons on the
    // tile. The SAT hit test (`segmentIntersectsTileCollider`) tests each of
    // these same polygons, so the centroid of their union is the aim point
    // most likely to land a swing on the real shape — critical for the
    // artist-authored off-center colliders the bot otherwise misses.
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const collider of sprite.colliders) {
      const polygon = ColliderCollision.transformCollider(
        collider,
        gridX,
        gridY,
        this.tileSize,
        visual.rotation,
        visual.flipH,
        visual.flipV,
      );
      for (let i = 0; i < polygon.length; i++) {
        sumX += polygon[i]!.x;
        sumY += polygon[i]!.y;
        count++;
      }
    }
    if (count === 0) return null;
    return { x: sumX / count, y: sumY / count };
  }

  private resolveSimple(entity: AABB, grid: TileType[][]): ResolvedPosition {
    try {
      // Ticket 43 (re-triage, option b): the per-tile two-axis MTV loop now
      // lives in the SHARED pure helper (the same body the client's non-atlas
      // fallback delegates to), keeping the OOB=solid semantics of
      // isSimpleTileBlocked bit-exact on both sides. The try/catch + logged
      // fallback and this dispatcher (ADR-0035 divergent surface) are
      // unchanged. Bit-identity vs the former inline loop — identical float
      // expressions in identical order; the helper's pooled scratches hold
      // exactly the values the per-iteration literals held — is pinned by
      // CollisionServiceSimpleParity.test.ts (verbatim-replica oracle).
      resolveSimpleTileCollision(entity, grid, this.tileSize, this.mtvScratch, this.simpleOut);
      return { x: this.simpleOut.x, y: this.simpleOut.y };
    } catch (err) {
      logger.error('resolveSimple failed', err);
      return { x: entity.x, y: entity.y };
    }
  }

  private resolveEnriched(entity: AABB, liveGrid: TileType[][]): ResolvedPosition {
    try {
      // Delegate to the shared enriched resolver so server and client run one
      // algorithm. The pooled provider adapts the server's
      // EnrichedCollisionGrid shape by reading this.enrichedGrid at call time
      // (see gridProvider docs) — resolveTileCollision only dispatches here
      // while an enriched grid is installed.
      resolveTileCollisionEnriched(
        entity,
        liveGrid,
        this.gridProvider,
        this.mtvScratch,
        this.enrichedOut,
      );
      // SCRATCH RETURN (perf ticket 11): the same object is returned from
      // every call and is rewritten by the next resolve. Retention audit —
      // every production caller reads .x/.y synchronously before any next
      // resolveTileCollision call:
      //   - MovementService.validateAndMove:202-218 (read → clamp → compare,
      //     no interleaved resolve);
      //   - MovementService.resolveDashEndOverlap:337-349 (read inside the
      //     same pos.set() call; the loop returns immediately after);
      //   - PlayerMovement.updateKnockback:108-131 (BOTH reads of the X
      //     result — :109 and :114 — happen before the Y resolve at :125);
      //   - TriggerTrapCommand knockback:126-130 (read into a fresh Position
      //     on the next line);
      //   - tests read result.x/result.y immediately after each call.
      return this.enrichedOut;
    } catch (err) {
      logger.error('resolveEnriched failed', err);
      this.enrichedOut.x = entity.x;
      this.enrichedOut.y = entity.y;
      return this.enrichedOut;
    }
  }
}
