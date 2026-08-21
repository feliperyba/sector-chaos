import {
  TileType,
  EntityType,
  IdGenerator,
  DamageType,
  BARREL,
  type GameConfig,
} from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import {
  Explosion,
  Destructible,
  type Player,
  type DestructibleDamageContext,
} from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import type { DamagePipeline } from '../services/DamagePipeline.ts';
import {
  createSpatialQueryResult,
  type DomainSpatialIndex,
  type DomainSpatialQueryResult,
} from './DomainSpatialIndex.ts';
import {
  collectPlayersInMapOrder,
  collectDestructiblesInMapOrder,
} from '../handlers/CombatSpatialQueries.ts';

interface BarrelExplosionContext {
  players: Map<string, Player>;
  explosions: Map<string, Explosion>;
  destructibles: Map<string, Destructible>;
  grid: TileType[][];
  config: GameConfig;
  idGenerator: IdGenerator;
  damagePipeline: DamagePipeline;
  siegeWallManager: { hasSiegeWall(gridX: number, gridY: number): boolean };
  getAlivePlayerCount(): number;
  /**
   * server-barrel-spatial-query (ticket 19): the match's step2-rebuilt domain
   * broadphase. Optional and read PER QUERY — the index only exists after the
   * first step2; until then (and in unit tests driving the manager directly)
   * the shared collect* helpers fall back to the exact pre-index linear scans
   * (same members, same Map order — see CombatSpatialQueries.ts).
   */
  getSpatialIndex?: () => DomainSpatialIndex | null;
  clearTileColliderVisual?: (gridX: number, gridY: number) => void;
  markGridDirty?: () => void;
  /**
   * perf-arc-neo ticket 08 — static-row sync gate: called after every
   * destructible `takeDamage` in a chain (which also covers the direct
   * `destructibles.delete` below — deletion only follows a destroying
   * takeDamage). Wired by buildMatchHandlerDeps to bump
   * `GameMatch.destructibleVersion`; a no-op in unit-test ctx literals.
   */
  onDestructiblesMutated?: () => void;
  /**
   * siege-tile-index (ticket 09) — eager tile-bucket removal for the direct
   * `destructibles.delete` below (the barrel-chain delete site; the other is
   * `destroyDestructibleAction`'s dep). Called with the entity's tile right
   * before the map delete. A no-op in unit-test ctx literals.
   */
  onDestructibleMapDelete?: (id: string, gridX: number, gridY: number) => void;
  onDestructibleDestroyedByExplosion?: (
    position: { x: number; y: number },
    type: string,
  ) => unknown;
}

const RAY_DIRECTIONS = [
  { stepX: 1, stepY: 0 },
  { stepX: -1, stepY: 0 },
  { stepX: 0, stepY: 1 },
  { stepX: 0, stepY: -1 },
  { stepX: 1, stepY: 1 },
  { stepX: -1, stepY: 1 },
  { stepX: 1, stepY: -1 },
  { stepX: -1, stepY: -1 },
];

/**
 * Barrel chain resolution (ticket 19, server-barrel-spatial-query).
 *
 * POOLING: all per-explosion scratch lives on the manager. The old code
 * allocated, for EVERY `processBarrel` call (i.e. every explosion in a chain):
 * a destructible grid `Map` (rebuilt from the live map), a `Set`, an array,
 * and per-victim `targetIds`/`sourcePosition` literals. All of those are now
 * pooled and cleared per use; the destructible `Map` is gone entirely — per
 * ray cell the manager queries the once-per-tick domain spatial index
 * (`DomainSpatialIndex`, ticket 17) via the shared `collect*InMapOrder`
 * helpers (ticket 18), with the live `isDestroyed` re-check preserving the
 * chain semantics (see `findCellDestructible`).
 *
 * RECURSION CONSISTENCY (the audit trail, old mechanism → new mechanism):
 *
 * 1. A barrel destroyed mid-chain is DELETED from `ctx.destructibles`
 *    immediately (delete below) and `isDestroyed` is set by `takeDamage`.
 *    OLD: later explosions in the chain never saw it again because each
 *    `processBarrel` call REBUILT its grid map from the live map (and the
 *    in-walk `map.delete`). NEW: the once-per-tick index is a snapshot and
 *    STILL returns the destroyed entity as a candidate — the `!isDestroyed`
 *    re-check at the hit site (same check the old code ran on map lookups)
 *    skips it, so it can neither absorb a ray nor re-explode. Deletion from
 *    `ctx.destructibles` is likewise re-visible: a deleted-but-indexed
 *    entity is always `isDestroyed === true` (every destroy site sets the
 *    flag before/with the delete), so the flag re-check subsumes membership.
 * 2. The chain-source barrel (destroyed by melee/projectile/siege; its
 *    `destroyDestructibleAction` caller deletes it only AFTER
 *    `resolveExplosion` returns) sits in the live map with
 *    `isDestroyed === true` for the whole chain. OLD: it WAS in the rebuilt
 *    map but the `!destructible.isDestroyed` guard skipped it. NEW: it is a
 *    candidate (indexed alive at step2, destroyed later in the tick) and the
 *    same guard skips it. Identical.
 * 3. A barrel can therefore be pushed to a `destroyedBarrels` list at most
 *    once per walk (each cell is visited at most once — the 8 normalized ray
 *    directions produce disjoint cell sets) and never again after destruction
 *    (point 1), preserving the old explosion-count semantics of the
 *    `MAX_EXPLOSIONS_PER_RESOLUTION` cap.
 * 4. Destructibles never move and are only added at match hydration (before
 *    the first tick), so the snapshot cannot miss a live map member during a
 *    chain: every live member was alive at the last step2 rebuild.
 * 5. Player positions are frozen within a tick after step2 except step7 trap
 *    teleports and step8 dash-end overlap pushes — the same accepted
 *    snapshot staleness contract as the ticket-18 combat sites (see
 *    DomainSpatialIndex.ts "Snapshot contract"); the tile-containment
 *    predicate re-reads live positions per candidate.
 */
export class BarrelExplosionManager {
  private ctx: BarrelExplosionContext;
  private readonly maxRayDistance: number;
  /**
   * Half the tile diagonal: a circle of this radius centered on a cell's
   * center covers the cell's full AABB (the farthest point of the cell from
   * its center is a corner at exactly half the diagonal), so the broadphase
   * query returns every indexed entity whose cell overlaps that circle — a
   * superset of every entity whose CENTER lies in the tile. The exact
   * tile-containment predicate (`Math.floor(pos / tileSize)`) is applied per
   * candidate afterwards, so no victim/occupant can be missed.
   */
  private readonly cellQueryRadius: number;

  // ── Pooled per-explosion scratch (ticket 19) ──────────────────────────────
  private readonly playerQueryScratch: DomainSpatialQueryResult<Player> =
    createSpatialQueryResult();
  private readonly destructibleQueryScratch: DomainSpatialQueryResult<Destructible> =
    createSpatialQueryResult();
  /**
   * Player-damage dedup, EXPLOSION-scoped: cleared at every `processBarrel`
   * entry. The old code allocated a fresh Set per explosion keyed
   * `${playerId},${explosionId}` — the per-explosion fresh Set made the
   * explosionId component redundant (entries never outlived one explosion),
   * so a cleared-per-explosion Set keyed by plain `playerId` is observably
   * identical.
   */
  private readonly damagedPlayers = new Set<string>();
  /**
   * Pending chain triggers, pooled per RECURSION DEPTH. The old code
   * allocated one array per `processBarrel` call; a single shared array would
   * be cleared by the recursive call while the parent frame is still
   * iterating it, so the pool is indexed by call depth. Depth is bounded by
   * the `MAX_EXPLOSIONS_PER_RESOLUTION` cap (every frame consumes one
   * explosion), and at most one frame per depth is ever active (the call
   * stack is linear), so each frame's clear touches a list only itself reads.
   */
  private readonly destroyedBarrelsByDepth: { gridX: number; gridY: number }[][] = [];
  /**
   * Per-victim damage-context scratch. `DamagePipeline.processDamage` consumes
   * both strictly synchronously (targetIds iterated, sourcePosition read for
   * shield angle/knockback; events copy out primitives) — nothing retains
   * them — so reuse across victims is safe.
   */
  private readonly damageTargetIds: string[] = [''];
  private readonly damageSourcePosition = { x: 0, y: 0 };

  constructor(ctx: BarrelExplosionContext) {
    this.ctx = ctx;
    this.maxRayDistance = Math.ceil(BARREL.EXPLOSION_RADIUS / ctx.config.map.tileWidth);
    const tw = ctx.config.map.tileWidth;
    const th = ctx.config.map.tileHeight;
    this.cellQueryRadius = Math.sqrt(tw * tw + th * th) / 2;
  }

  resolveExplosion(
    gridX: number,
    gridY: number,
    sourceOwnerId: string,
    currentTick: number,
  ): GameEvent[] {
    const allEvents: GameEvent[] = [];
    let explosionCount = 0;

    const processBarrel = (bx: number, by: number, owner: string, depth: number) => {
      explosionCount++;
      if (explosionCount > BARREL.MAX_EXPLOSIONS_PER_RESOLUTION) return;

      const tw = this.ctx.config.map.tileWidth;
      const th = this.ctx.config.map.tileHeight;
      const sourcePos = new Position(bx * tw + tw / 2, by * th + th / 2);
      const maxRows = this.ctx.grid.length;
      const maxCols = maxRows > 0 ? (this.ctx.grid[0]?.length ?? 0) : 0;

      allEvents.push({
        type: 'BarrelExploded',
        tick: currentTick,
        timestamp: Date.now(),
        id: this.ctx.idGenerator.next(),
        position: { x: sourcePos.x, y: sourcePos.y },
        radius: BARREL.EXPLOSION_RADIUS,
        damage: BARREL.EXPLOSION_DAMAGE,
      });

      const explosionId = this.ctx.idGenerator.next();
      const explosion = new Explosion(explosionId, owner, sourcePos, BARREL.EXPLOSION_DAMAGE, 30);
      this.ctx.explosions.set(explosionId, explosion);

      // Pooled per-explosion state (was: fresh Map + Set + array per explosion).
      // Cleared here, at the only scope boundary the old fresh allocations had.
      this.damagedPlayers.clear();
      const destroyedBarrels = this.acquireDestroyedBarrels(depth);

      for (const { stepX, stepY } of RAY_DIRECTIONS) {
        for (let step = 1; step <= this.maxRayDistance; step++) {
          const nextGX = bx + stepX * step;
          const nextGY = by + stepY * step;

          if (nextGY < 0 || nextGY >= maxRows || nextGX < 0 || nextGX >= maxCols) break;

          const tile = this.ctx.grid[nextGY]![nextGX]!;

          if (tile === TileType.INDESTRUCTIBLE_WALL || tile === TileType.INDESTRUCTIBLE_CRATE)
            break;

          if (this.ctx.siegeWallManager.hasSiegeWall(nextGX, nextGY)) break;

          // Indexed per-cell occupant lookup (was: `${gx},${gy}` key into a
          // Map rebuilt from the live destructibles per explosion). Returns
          // the LAST occupant in destructibles-Map iteration order — the
          // same entry the old `map.set` overwrite semantics produced.
          const destructible = this.findCellDestructible(nextGX, nextGY, tw, th);

          if (destructible && !destructible.isDestroyed) {
            const dmgCtx: DestructibleDamageContext = {
              source: 'explosion',
              rawDamage: BARREL.EXPLOSION_DAMAGE,
              currentTick,
            };
            const result = destructible.takeDamage(dmgCtx);
            // ticket 08 — the surviving-damage case needs the version bump
            // (destroyed ones also delete below, but this single call covers
            // both — see the ctx member's doc).
            this.ctx.onDestructiblesMutated?.();

            if (result.destroyed) {
              this.ctx.grid[nextGY]![nextGX] = TileType.EMPTY;
              this.ctx.clearTileColliderVisual?.(nextGX, nextGY);
              this.ctx.onDestructibleMapDelete?.(destructible.id, nextGX, nextGY);
              this.ctx.destructibles.delete(destructible.id);

              let droppedLoot: unknown = null;
              if (destructible.type !== 'barrel' && this.ctx.onDestructibleDestroyedByExplosion) {
                droppedLoot = this.ctx.onDestructibleDestroyedByExplosion(
                  { x: destructible.position.x, y: destructible.position.y },
                  destructible.type,
                );
              }

              allEvents.push({
                type: 'DestructibleDestroyed',
                tick: currentTick,
                timestamp: Date.now(),
                id: destructible.id,
                destructibleType: destructible.type,
                position: { x: destructible.position.x, y: destructible.position.y },
                droppedLoot,
                gridX: nextGX,
                gridY: nextGY,
              });

              if (result.shouldExplode) {
                destroyedBarrels.push({ gridX: nextGX, gridY: nextGY });
              }
            }
            break;
          }

          if (tile === TileType.DESTRUCTIBLE_WALL || tile === TileType.DESTRUCTIBLE_BARREL) {
            this.ctx.grid[nextGY]![nextGX] = TileType.EMPTY;
            this.ctx.clearTileColliderVisual?.(nextGX, nextGY);
            break;
          }

          // Indexed per-cell victim candidates (was: full scan of ALL players
          // per ray cell). Map order preserved via the seq column, so the
          // per-victim sequencing (alivePlayerCount read per victim) is
          // unchanged; predicate re-reads live position/isActive per candidate.
          const candidates = this.collectCellPlayers(nextGX, nextGY, tw, th);
          for (const player of candidates) {
            if (!player.isActive) continue;
            const playerId = player.id;
            if (this.damagedPlayers.has(playerId)) continue;
            const playerGX = Math.floor(player.movement.position.x / tw);
            const playerGY = Math.floor(player.movement.position.y / th);
            if (playerGX === nextGX && playerGY === nextGY) {
              this.damagedPlayers.add(playerId);
              this.damageTargetIds[0] = playerId;
              this.damageSourcePosition.x = sourcePos.x;
              this.damageSourcePosition.y = sourcePos.y;
              const dmgResult = this.ctx.damagePipeline.processDamage(
                {
                  sourceId: owner,
                  damage: BARREL.EXPLOSION_DAMAGE,
                  damageType: DamageType.BARREL_EXPLOSION,
                  targetIds: this.damageTargetIds,
                  sourcePosition: this.damageSourcePosition,
                  currentTick,
                  alivePlayerCount: this.ctx.getAlivePlayerCount(),
                  sourceType: EntityType.EXPLOSION,
                },
                (id) => this.ctx.players.get(id),
              );
              allEvents.push(...dmgResult.events);
            }
          }
        }
      }

      for (const barrel of destroyedBarrels) {
        processBarrel(barrel.gridX, barrel.gridY, owner, depth + 1);
      }
    };

    processBarrel(gridX, gridY, sourceOwnerId, 0);
    this.ctx.markGridDirty?.();
    return allEvents;
  }

  /**
   * Pooled `destroyedBarrels` list for a `processBarrel` frame at `depth`.
   * Clears the list (the old per-call fresh array) and returns it. Safe across
   * recursion: a frame only ever reads its own depth's list, at most one
   * frame per depth is active at a time, and depth is capped by the
   * explosion-count cap.
   */
  private acquireDestroyedBarrels(depth: number): { gridX: number; gridY: number }[] {
    let list = this.destroyedBarrelsByDepth[depth];
    if (!list) {
      list = [];
      this.destroyedBarrelsByDepth[depth] = list;
    }
    list.length = 0;
    return list;
  }

  /**
   * Routed per-ray-cell player candidates for a barrel explosion, in
   * players-Map iteration order — the production victim loop iterates this
   * list (the regression harness drives it as the ACTUAL side of the S6
   * comparison, ticket-18 pattern).
   *
   * @param gx tile column of the ray cell
   * @param gy tile row of the ray cell
   * @param tw tile width
   * @param th tile height
   * @returns shared scratch — candidates whose cell overlaps the query circle
   *   (superset of every player whose center lies in the tile); the caller
   *   applies the exact `isActive` + tile-containment predicate per candidate
   */
  collectCellPlayers(gx: number, gy: number, tw: number, th: number): Player[] {
    return collectPlayersInMapOrder(
      this.ctx.getSpatialIndex?.() ?? null,
      this.ctx.players,
      gx * tw + tw / 2,
      gy * th + th / 2,
      this.cellQueryRadius,
      this.playerQueryScratch,
    );
  }

  /**
   * Routed per-ray-cell destructible occupant lookup — the production ray
   * walk calls this where it used to probe the per-explosion rebuilt
   * `${gx},${gy}` Map. Returns the LAST occupant in destructibles-Map
   * iteration order (the entry the old `map.set` overwrite produced), with
   * liveness deliberately NOT applied: the caller checks `!isDestroyed`, so
   * a destroyed-but-indexed (mid-chain) or destroyed-but-not-yet-deleted
   * (chain-source) occupant yields "no hit" exactly like the old code, which
   * saw it in its rebuilt map and skipped it on the same flag check. The
   * harness drives this as the S6 destructible ACTUAL side.
   *
   * @param gx tile column of the ray cell
   * @param gy tile row of the ray cell
   * @param tw tile width
   * @param th tile height
   * @returns the cell's occupant in old map-lookup semantics, or undefined
   */
  findCellDestructible(gx: number, gy: number, tw: number, th: number): Destructible | undefined {
    const candidates = collectDestructiblesInMapOrder(
      this.ctx.getSpatialIndex?.() ?? null,
      this.ctx.destructibles,
      gx * tw + tw / 2,
      gy * th + th / 2,
      this.cellQueryRadius,
      this.destructibleQueryScratch,
    );
    let hit: Destructible | undefined;
    for (const d of candidates) {
      if (Math.floor(d.position.x / tw) === gx && Math.floor(d.position.y / th) === gy) {
        hit = d; // keep the LAST match — `map.set` overwrite semantics
      }
    }
    return hit;
  }
}
