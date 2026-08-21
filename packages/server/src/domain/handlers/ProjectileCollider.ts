/**
 * ProjectileCollider — the single projectile-vs-world hit-test surface.
 *
 * server-projectile-collider-unify (ticket 20). The ranged (arrow) and thrown
 * flight models previously EACH implemented the same entity-hit geometry:
 * collect candidates around the projectile → skip dead/owner candidates →
 * circle-distance test → first hit wins. That scan existed in four places —
 * `RangedHandler.updateArrow` (arrow vs destructibles S1, arrow vs players
 * S2) and `ThrowHandlerCollision` (thrown vs destructibles S3, thrown vs
 * players S4) — plus a fifth duplication: the "which destructible occupies
 * this tile" AABB scan, once in each handler's tile-collision resolution.
 *
 * This collider owns all of that ONCE:
 *
 * - The entity-hit broadphase, routed through the domain spatial index via
 *   `collectPlayersInMapOrder` / `collectDestructiblesInMapOrder`
 *   (`CombatSpatialQueries.ts`, ticket 18) — candidates arrive in source-Map
 *   iteration order, preserving the first-hit-wins tie-break order of the
 *   pre-index linear scans (see the ticket-17 regression harness,
 *   `tests/domain/aggregates/DomainSpatialIndex.test.ts`, whose ACTUAL side
 *   exercises the same collectors this class routes through).
 * - The per-flight-model hit RADII and player filters (S2 deliberately does
 *   NOT filter `isActive` — corpses absorb arrows; S4 applies the owner
 *   throw-immunity window + `isActive`).
 * - The tile-grid bundle (grid + tileSize + tile collider data) behind
 *   `tileBlocked`, so flight models stop threading it through every call.
 * - The tile-occupancy destructible lookup (`findDestructibleOnTile`), the
 *   AABB-vs-tile scan both tile-collision paths duplicated.
 *
 * What deliberately STAYS in the handlers (guardrail: don't force-unify what
 * genuinely differs): the flight models themselves — straight swept-substep
 * arrow motion vs thrown bounce/boomerang physics — and each site's hit
 * OUTCOME code (damage, durability, reflection, pickup conversion). The
 * collider answers "what did the projectile hit"; the handler decides what
 * that means.
 *
 * ## Snapshot contract
 *
 * Entity queries are a BROADPHASE over the step2-rebuilt index; per candidate
 * this class re-reads live state (`isDestroyed`, `isActive`, owner immunity,
 * live positions — the exact distance test runs on the LIVE entity position
 * via `Position.distanceTo`), exactly like the scans it replaced. See
 * `DomainSpatialIndex` for the full staleness contract. Production wires the
 * index (and the tile-collider data) through live getters on the collider
 * world — `() => match.spatialIndex` / `() => match.colliderData`, captured
 * once when `updateProjectilesAction` builds the per-match collider — so
 * every query reads current match state with no refresh calls; when no
 * supplier is configured (unit tests driving handlers directly) the collect*
 * helpers fall back to the pre-index full-map scan — same members, same Map
 * order.
 *
 * ## Allocation discipline
 *
 * Zero steady-state allocation: the two query scratches are caller-owned
 * fields reused every tick, and the first-hit walks inline their predicates
 * (no per-call closures). The single scratch pair is shared by both flight
 * models — safe because each `first*Hit` call fully consumes its candidate
 * array (and returns only a direct entity reference) before the next query
 * can overwrite the scratch; the two flight models never query concurrently.
 */
import {
  COMBAT,
  COLLISION,
  NETWORK,
  AABBCollision,
  ProjectileTileCollision,
  type TileType,
  type TileColliderData,
} from '@sector-battle/shared';

import type { Position } from '../value-objects/index.ts';
import type { Player, Destructible } from '../entities/index.ts';
import type {
  DomainSpatialIndex,
  DomainSpatialQueryResult,
} from '../aggregates/DomainSpatialIndex.ts';
import { createSpatialQueryResult } from '../aggregates/DomainSpatialIndex.ts';
import {
  collectPlayersInMapOrder,
  collectDestructiblesInMapOrder,
} from './CombatSpatialQueries.ts';

/**
 * Arrow (ranged) entity-hit radius: player/destructible hurtbox half +
 * arrow hitbox half. Formerly `RangedHandler`'s private `HITBOX_RADIUS` (S1/S2).
 */
export const ARROW_HIT_RADIUS = COMBAT.HURTBOX_SIZE / 2 + COLLISION.ARROW_HITBOX_WIDTH / 2;

/**
 * Thrown entity-hit radius: player/destructible hurtbox half + thrown hitbox
 * half (S3/S4). Re-exported as `PLAYER_HIT_RADIUS` from `ThrowHandlerTypes.ts`
 * (its canonical home moved here with the S3/S4 scans in ticket 20).
 */
export const THROWN_HIT_RADIUS = COMBAT.HURTBOX_SIZE / 2 + COLLISION.THROWN_HITBOX_SIZE / 2;

/**
 * Ticks after creation before a thrown projectile can hit its own thrower
 * (S4 owner filter). Re-exported as `THROW_IMMUNITY_TICKS` from
 * `ThrowHandlerTypes.ts`.
 */
export const THROWN_OWNER_IMMUNITY_TICKS = Math.ceil(
  COMBAT.THROW_SOURCE_IMMUNITY / NETWORK.TICK_INTERVAL,
);

/**
 * Match-lifetime stable world refs the collider scans, plus two LIVE-state
 * suppliers. The maps/grid are mutated in place, never reassigned; the
 * spatial index and tile-collider data are read through getters so the
 * collider always sees current match state with no refresh calls (production
 * passes `() => match.spatialIndex` / `() => match.colliderData`; tests may
 * omit them — null index = the collect* full-map fallback, null tile data =
 * the AABB-only tile path).
 */
export interface ProjectileColliderWorld {
  players: Map<string, Player>;
  destructibles: Map<string, Destructible>;
  grid: TileType[][];
  tileSize: number;
  getSpatialIndex?: () => DomainSpatialIndex | null;
  getTileColliderData?: () => TileColliderData | null;
}

/** Structural alias — same shape shared's collision math takes. */
type AabbLike = { x: number; y: number; width: number; height: number };

export class ProjectileCollider {
  private readonly players: Map<string, Player>;
  private readonly destructibles: Map<string, Destructible>;
  private readonly grid: TileType[][];
  private readonly tileSize: number;
  private readonly getSpatialIndex: (() => DomainSpatialIndex | null) | null;
  private readonly getTileColliderData: (() => TileColliderData | null) | null;

  /**
   * Per-call-site query scratch (reused every tick — see
   * `DomainSpatialQueryResult`'s caller-owned buffer idiom).
   */
  private readonly playerQueryScratch: DomainSpatialQueryResult<Player> =
    createSpatialQueryResult();
  private readonly destructibleQueryScratch: DomainSpatialQueryResult<Destructible> =
    createSpatialQueryResult();

  constructor(world: ProjectileColliderWorld) {
    this.players = world.players;
    this.destructibles = world.destructibles;
    this.grid = world.grid;
    this.tileSize = world.tileSize;
    this.getSpatialIndex = world.getSpatialIndex ?? null;
    this.getTileColliderData = world.getTileColliderData ?? null;
  }

  /**
   * Live broadphase read (per query — the step2-rebuilt index during any
   * simulation step). Null when no supplier was configured; the collect*
   * helpers then fall back to the pre-index full-map scan.
   */
  private queryIndex(): DomainSpatialIndex | null {
    return this.getSpatialIndex ? this.getSpatialIndex() : null;
  }

  /** Live tile-collider data read (set on the match via `setRangedColliderDataAction`). */
  private tileData(): TileColliderData | null {
    return this.getTileColliderData ? this.getTileColliderData() : null;
  }

  // ── Entity-hit tests (the four former scan sites) ─────────────────────────

  /**
   * S1 — first non-destroyed destructible within the ARROW hit radius of
   * `origin`, in destructibles-Map order (first-hit-wins tie-break). The
   * `isDestroyed` re-check covers mid-tick destruction AND map deletion
   * (destructibles are only deleted after the flag is set).
   */
  firstArrowDestructibleHit(origin: Position): Destructible | null {
    const candidates = collectDestructiblesInMapOrder(
      this.queryIndex(),
      this.destructibles,
      origin.x,
      origin.y,
      ARROW_HIT_RADIUS,
      this.destructibleQueryScratch,
    );
    for (const destructible of candidates) {
      if (destructible.isDestroyed) continue;
      if (origin.distanceTo(destructible.position) < ARROW_HIT_RADIUS) return destructible;
    }
    return null;
  }

  /**
   * S2 — first player other than the owner within the ARROW hit radius, in
   * players-Map order. Deliberately NO `isActive` filter — corpses absorb
   * arrows (DamagePipeline no-ops the dead target downstream).
   */
  firstArrowPlayerHit(origin: Position, ownerId: string): Player | null {
    const candidates = collectPlayersInMapOrder(
      this.queryIndex(),
      this.players,
      origin.x,
      origin.y,
      ARROW_HIT_RADIUS,
      this.playerQueryScratch,
    );
    for (const player of candidates) {
      if (player.id === ownerId) continue;
      if (origin.distanceTo(player.movement.position) < ARROW_HIT_RADIUS) return player;
    }
    return null;
  }

  /**
   * S3 — first non-destroyed destructible within the THROWN hit radius of
   * `origin`, in destructibles-Map order. Same liveness re-check as S1 at the
   * larger radius (two adjacent-tile destructibles can both be within 80px of
   * one point — order matters, hence Map order).
   */
  firstThrownDestructibleHit(origin: Position): Destructible | null {
    const candidates = collectDestructiblesInMapOrder(
      this.queryIndex(),
      this.destructibles,
      origin.x,
      origin.y,
      THROWN_HIT_RADIUS,
      this.destructibleQueryScratch,
    );
    for (const destructible of candidates) {
      if (destructible.isDestroyed) continue;
      if (origin.distanceTo(destructible.position) < THROWN_HIT_RADIUS) return destructible;
    }
    return null;
  }

  /**
   * S4 — first player passing the thrown player filters within the THROWN hit
   * radius, in players-Map order: owner is skipped until the throw-immunity
   * window expires AND is alive; everyone must be `isActive`. Post-hit tests
   * (barrier invulnerability etc.) stay with the caller's outcome code.
   */
  firstThrownPlayerHit(
    origin: Position,
    ownerId: string,
    currentTick: number,
    createdAtTick: number,
  ): Player | null {
    const candidates = collectPlayersInMapOrder(
      this.queryIndex(),
      this.players,
      origin.x,
      origin.y,
      THROWN_HIT_RADIUS,
      this.playerQueryScratch,
    );
    const age = currentTick - createdAtTick;
    for (const player of candidates) {
      const playerId = player.id;
      if (playerId === ownerId) {
        if (age < THROWN_OWNER_IMMUNITY_TICKS) continue;
        if (player.health.isDead) continue;
      }
      if (!player.isActive) continue;
      if (origin.distanceTo(player.movement.position) < THROWN_HIT_RADIUS) return player;
    }
    return null;
  }

  // ── Tile-world helpers (grid + tileSize + collider data bundle) ───────────

  /**
   * Tile-collision test for a projectile AABB. Thin wrapper over the shared
   * zero-allocation `ProjectileTileCollision.checkInto`; on true, the hit
   * details (tileType/gridX/gridY/mtv) are in `projectileTileCollisionScratch`
   * — consume immediately. Flight models (arrow swept substeps vs thrown
   * single-step) stay in their handlers; this only owns the grid bundle.
   */
  tileBlocked(aabb: AabbLike): boolean {
    return ProjectileTileCollision.checkInto(aabb, this.grid, this.tileSize, this.tileData());
  }

  /**
   * First non-destroyed destructible whose HURTBOX AABB intersects tile
   * (gridX, gridY), in destructibles-Map order — the occupant lookup BOTH
   * tile-collision paths previously duplicated inline (arrow swept-substep
   * path + thrown bounce path). Returns the entity; its `.id` is the
   * destructibles-Map key at every production insert site.
   */
  findDestructibleOnTile(gridX: number, gridY: number): Destructible | null {
    const tileAABB = {
      x: gridX * this.tileSize,
      y: gridY * this.tileSize,
      width: this.tileSize,
      height: this.tileSize,
    };
    for (const [, destructible] of this.destructibles) {
      if (destructible.isDestroyed) continue;
      const destHurtbox = {
        x: destructible.position.x - COMBAT.HURTBOX_SIZE / 2,
        y: destructible.position.y - COMBAT.HURTBOX_SIZE / 2,
        width: COMBAT.HURTBOX_SIZE,
        height: COMBAT.HURTBOX_SIZE,
      };
      if (AABBCollision.intersects(destHurtbox, tileAABB)) return destructible;
    }
    return null;
  }

  // ── Direct world lookup ────────────────────────────────────────────────────

  /** Players-map lookup (boomerang return phase needs its thrower). */
  getPlayer(id: string): Player | undefined {
    return this.players.get(id);
  }
}
