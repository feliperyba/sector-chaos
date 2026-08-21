import {
  resolvePlayerSeparation,
  resolveSimpleTileCollision,
  resolveTileCollisionEnriched,
  selectTileVisual,
  clampToMapExtent,
  type CollisionGridProvider,
  type AABB,
  type MTV,
  type TiledMapLayer,
  type TileVisual,
} from '@sector-battle/shared';
import type { MapRenderer } from '../rendering/MapRenderer.js';
import type { TileSpriteAtlas } from '../types.js';

export interface ResolvedPosition {
  x: number;
  y: number;
}

export class ClientCollisionService {
  private mapRenderer: MapRenderer;
  private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };

  // ── Zero-allocation scratch (perf ticket #36, INVESTIGATION §3.2 H-1) ──
  // resolveCollision is the hottest client inner loop (per prediction substep,
  // up to 4x/frame, and again per substep per replayed input on reconciliation).
  // The entityAabb scratch below replaces the per-call entity literal the old
  // code allocated (the per-tile AABB/test literals of the former fallback
  // branch moved into the shared resolver's own module pool in ticket 43, and
  // the per-nearby-player moving/other AABBs were replaced wholesale by the
  // shared resolver's own pooled scratch in ticket #44).
  //
  // NEVER-ESCAPE CONTRACT: these scratches are written at exactly the points
  // the old code built literals and are never stored anywhere that outlives
  // the resolveCollision call. Every callee is verified read-only/synchronous:
  //   - resolveTileCollisionEnriched reads entity.x/y/width/height, never
  //     retains the reference (resolveTileCollision.ts)
  //   - resolveSimpleTileCollision reads entity.x/y/width/height, never
  //     retains the reference (resolveSimpleTileCollision.ts)
  //   - resolvePlayerSeparation reads flat numbers + half-extents, writes the
  //     caller-owned mtv/out receptacles, and its own module-pooled AABB
  //     scratch never escapes it (resolvePlayerSeparation.ts)
  // The method pair below still returns a FRESH ResolvedPosition
  // (resolveCollision) so no scratch reference can leak to external callers.
  // Perf ticket 21 adds the POOLED variant `resolveCollisionInto` for the
  // per-substep hot path: its out-receptacle is written and read
  // synchronously by the shared simulatePhysicsStepInto (the sole consumer
  // via the CollisionFn seam — simulatePhysicsStep.ts reads .x/.y into
  // locals immediately and never stores the reference), so a caller-owned
  // scratch is retention-safe there by the same never-escape audit.

  private readonly entityAabb: AABB = { x: 0, y: 0, width: 0, height: 0 };

  /** Out receptacle for the shared resolveSimpleTileCollision (ticket 43). */
  private readonly simpleOut: { x: number; y: number } = { x: 0, y: 0 };
  /** Out receptacle for the shared resolveTileCollisionEnriched (ticket 11). */
  private readonly enrichedOut: { x: number; y: number } = { x: 0, y: 0 };

  // Pooled CollisionGridProvider (ticket #36): the object + its three closures
  // are allocated once, here. The closures read the three `provider*` fields
  // below, which resolveCollision publishes immediately before delegating to
  // the shared resolver — equivalent to the old per-call literal that closed
  // over the local atlas/visualLayers/tileSize. Not re-entrant (nothing in the
  // provider call chain calls back into resolveCollision), matching the
  // single-threaded per-frame usage.
  private providerAtlas: TileSpriteAtlas | null = null;
  private providerVisualLayers: TiledMapLayer[] = [];
  private providerTileSize = 0;
  private readonly gridProvider: CollisionGridProvider = {
    getVisual: (gx, gy) => this.findCellVisual(gx, gy, this.providerVisualLayers),
    getSprite: (spriteId) => this.providerAtlas!.sprites[spriteId],
    getTileSize: () => this.providerTileSize,
  };

  /**
   * Other players the local player should collide against (player-vs-player
   * separation), as a FLAT center buffer [x0, y0, x1, y1, ...] — the exact
   * shape the shared `resolvePlayerSeparation` (ticket #44) consumes. Mirrors
   * the server's MovementService.resolvePlayerCollision. Packed once per frame
   * in setNearbyPlayers from GameScene's pooled nearby array. Empty by default
   * (no other players in range). See C5.
   */
  private readonly nearbyFlat: number[] = [];
  /**
   * How many leading PAIRS of `nearbyFlat` are live (ticket #37 count
   * semantics, unchanged by the #44 flattening). The buffer is scratch reused
   * across frames — entries at pair index >= count are stale tail and are never
   * read (the shared resolver reads exactly the first `count` pairs).
   */
  private nearbyPlayerCount = 0;
  /** Out receptacle for the shared resolvePlayerSeparation (ticket #44). */
  private readonly nearbyOut: { x: number; y: number } = { x: 0, y: 0 };

  constructor(mapRenderer: MapRenderer) {
    this.mapRenderer = mapRenderer;
  }

  /**
   * Publish the other-player positions to resolve against this frame. C5: without
   * this, the client predicts THROUGH other players while the server shoves
   * (resolvePlayerCollision) → the client races ahead → reconciliation
   * corrections fire every patch → the visible walk stutter. Pass the current
   * latest-received remote-player centers (within collision range).
   *
   * Ticket #37 VIEW SEMANTICS — `positions` is BORROWED, never copied as
   * objects. The caller (GameScene) hands its pooled array plus the live entry
   * `count`; only `positions[0, count)` is read, synchronously, right here.
   * Ticket #44 flattens that prefix into `this.nearbyFlat` (two number writes
   * per entry — cheaper than the per-substep re-read the old inline loop did,
   * and numeric-identical under the view-stability contract below). NO
   * RETENTION: the service stores no entry references and does not hold the
   * array reference past this call — strictly safer than the pre-#44 field
   * aliasing. The caller guarantees the view is stable from publish to
   * republish: GameScene rewrites the pool (inside getAllPlayerPositions,
   * ticket #42) and republishes within one synchronous update() block, and JS
   * is single-threaded, so neither the prediction step nor a patch-driven
   * reconciliation replay can observe a half-rewritten pool — or a value newer
   * than the one packed here.
   */
  setNearbyPlayers(positions: ReadonlyArray<{ x: number; y: number }>, count: number): void {
    const flat = this.nearbyFlat;
    for (let i = 0; i < count; i++) {
      const o = positions[i]!;
      flat[i * 2] = o.x;
      flat[i * 2 + 1] = o.y;
    }
    this.nearbyPlayerCount = count;
  }

  /**
   * Fresh-object resolve (perf ticket 21 keeps this for external callers —
   * tests, dev harnesses, any future cold path). The hot per-substep path
   * goes through {@link resolveCollisionInto} instead.
   */
  resolveCollision(
    centerX: number,
    centerY: number,
    halfW: number,
    halfH: number,
  ): ResolvedPosition {
    return this.resolveCollisionInto(centerX, centerY, halfW, halfH, { x: 0, y: 0 });
  }

  /**
   * Pooled-out resolve (perf ticket 21) — the identical resolution body, but
   * the result is written into the caller-owned `out` receptacle instead of a
   * fresh literal. This kills the per-call allocation in the hottest client
   * loop (prediction substeps + reconciliation replay bursts ≈ 1-4 allocs
   * per frame, ~30 in a single 150ms-correction replay frame).
   *
   * NEVER-ESCAPE CONTRACT for `out`: the only production consumer is the
   * shared `simulatePhysicsStepInto` via the CollisionFn seam, which reads
   * `.x`/`.y` into locals synchronously and never retains the reference
   * (simulatePhysicsStep.ts, the `const resolved = collisionFn(...)`
   * statement). Callers must not store `out` past that synchronous read.
   * Returns `out` itself so the seam can stay expression-shaped.
   */
  resolveCollisionInto(
    centerX: number,
    centerY: number,
    halfW: number,
    halfH: number,
    out: ResolvedPosition,
  ): ResolvedPosition {
    const grid = this.mapRenderer.getGrid();
    const tileSize = this.mapRenderer.getTileSize();

    if (grid.length === 0) {
      out.x = centerX;
      out.y = centerY;
      return out;
    }

    // Ticket #36: scratch replaces the per-call entity literal. Fully
    // overwritten below before any use; nothing mutates it during the call
    // (both branches only read it — see the never-escape contract above), so
    // the numerics are identical to the old fresh literal.
    const entity = this.entityAabb;
    entity.x = centerX - halfW;
    entity.y = centerY - halfH;
    entity.width = halfW * 2;
    entity.height = halfH * 2;

    const atlas = this.mapRenderer.getAtlas();
    const visualLayers = this.mapRenderer.getVisualLayers();
    const hasEnriched = atlas !== null && visualLayers.length > 0;

    let resolvedX = entity.x;
    let resolvedY = entity.y;

    if (hasEnriched) {
      // Delegate the enriched (SAT + AABB-fallback) resolution to the shared
      // resolver so server and client run one algorithm. The provider adapts
      // the client's MapRenderer atlas + visual-layer shape. Behavior matches
      // the former inline loop (out-of-bounds tiles skipped via the undefined
      // gridTile guard; the bounds clamp still applies after).
      // Ticket #36: publish the per-call adapter state for the pooled
      // provider's closures instead of allocating a fresh provider object.
      this.providerAtlas = atlas;
      this.providerVisualLayers = visualLayers;
      this.providerTileSize = tileSize;
      // Ticket 11: the shared resolver now writes into this scratch instead of
      // returning a fresh object — read synchronously into the locals below
      // (the never-escape contract of this method's own return still holds).
      resolveTileCollisionEnriched(
        entity,
        grid,
        this.gridProvider,
        this.mtvScratch,
        this.enrichedOut,
      );
      resolvedX = this.enrichedOut.x;
      resolvedY = this.enrichedOut.y;
    } else {
      // Ticket 43 (re-triage, option b): delegate the non-atlas fallback to the
      // shared pure helper — the SAME per-tile two-axis MTV loop the server's
      // CollisionService.resolveSimple runs — instead of a duplicated client
      // copy. This deliberately preserves the OOB=SOLID semantics of the former
      // client branch (isSimpleTileBlocked): out-of-grid tiles resolve as solid
      // full-tile AABBs. It is NOT the shared enriched resolver's no-visual
      // fallback, which SKIPS out-of-grid tiles (grid[gy]?.[gx] === undefined)
      // — the two fallbacks diverge by design (31% of a 231k-position sweep);
      // do not route this branch through resolveTileCollisionEnriched.
      // Bit-identity vs the deleted branch is pinned by
      // simple-fallback-parity.test.ts (verbatim-replica oracle).
      resolveSimpleTileCollision(entity, grid, tileSize, this.mtvScratch, this.simpleOut);
      resolvedX = this.simpleOut.x;
      resolvedY = this.simpleOut.y;
    }

    // NET-22 (ADR-0014 addendum): clamp each axis against its OWN extent,
    // matching the server's per-axis clamp — X against maxCols*tileSize, Y
    // against maxRows*tileSize. The prior helper computed both mapWidth and
    // mapHeight and clamped `pos` against BOTH, contaminating X with mapHeight
    // and Y with mapWidth. A no-op on the square production map
    // (mapWidth===mapHeight=10240) but a 312px hard defect on non-square maps.
    // The 4-corner hitbox + clamp architecture is unchanged; only the per-axis
    // extent selection is corrected.
    //
    // Ticket 15: the clamp is the shared CENTER-based leaf
    // (`clampToMapExtent`) — the SAME function the server's MovementService
    // consumes. The former corner-based clampBounds is replaced by clamping
    // the CENTER (resolvedCorner + halfW) directly instead of clamping the
    // corner and converting afterwards — no corner round-trip, so the
    // composed call is bit-identical to the former corner-form + `+ halfW`
    // for every input on realizable maps (extent >= hitbox size): in-bounds
    // corners pass through the same `resolvedX + halfW` expression, and the
    // clamped branches yield exactly halfW / extent - halfW. Equivalence over
    // map-extent edges + adversarial doubles is pinned by the verbatim-oracle
    // battery in shared `simulation/__tests__/clampToMapExtent.test.ts`
    // (NET-22 precedent — corner/center conversion is proven, not assumed).
    const maxCols = grid[0]?.length ?? 0;
    const maxRows = grid.length;
    let outX = clampToMapExtent(resolvedX + halfW, halfW, maxCols * tileSize);
    let outY = clampToMapExtent(resolvedY + halfH, halfH, maxRows * tileSize);

    // C5: player-vs-player separation, mirroring the server's
    // MovementService.resolvePlayerCollision (applied AFTER tile+clamp in
    // MovePlayerCommand). Without this the client predicts through other
    // players while the server shoves → reconciliation corrections every patch
    // → the visible walk stutter.
    //
    // Ticket #44: the separation loop is the SHARED pure calculator
    // (`resolvePlayerSeparation`, ticket 03) — the SAME function the server's
    // resolvePlayerCollision calls, so both sides run identical MTV math by
    // construction (the walk-stutter drift class is closed). Caller-owned
    // FILTER stays upstream and unchanged (documented here per the ticket):
    // GameScenePositionHelpers.getAllPlayerPositions excludes the local player
    // (implicit self-skip), dead/dying/spectating players
    // (NEARBY_PLAYER_DEAD_MASK — mirrors the server's isActive gate so the
    // client doesn't shove against corpses), and players farther than 320px
    // (NEARBY_PLAYER_RANGE_PX — only nearby players can overlap the 96px
    // hitbox). Pool order = separation order, exactly the order the old inline
    // loop iterated.
    // outX/outY are the clamped CENTER positions (ticket 15 folded the former
    // corner→center conversion into the clamp above).
    const otherCount = this.nearbyPlayerCount;
    if (otherCount > 0) {
      resolvePlayerSeparation(
        outX,
        outY,
        halfW,
        halfH,
        this.nearbyFlat,
        otherCount,
        this.mtvScratch,
        this.nearbyOut,
      );
      outX = this.nearbyOut.x;
      outY = this.nearbyOut.y;
    }

    // Pooled write — the caller-owned receptacle is read synchronously by
    // simulatePhysicsStepInto and never retained (never-escape contract above).
    out.x = outX;
    out.y = outY;
    return out;
  }

  private findCellVisual(
    gridX: number,
    gridY: number,
    visualLayers: TiledMapLayer[],
  ): TileVisual | null {
    const siegeOverride = this.mapRenderer.getSiegeWallVisual(gridX, gridY);
    if (siegeOverride) return siegeOverride;

    // Delegate to the shared predicate — the server's buildMergedVisuals uses
    // the same selectTileVisual, so client and server always resolve a tile to
    // the same visual (last layer with spriteId>=0 wins). The floor layer
    // paints an EMPTY-type, zero-collider cell under every tile
    // (FloorSpriteSelector.select); a prior first-wins here returned that floor
    // cell for tiles that also had a wall cell, so the enriched resolver
    // short-circuited on the floor's empty colliders and the local player
    // predicted through grid-marked walls the server blocks — the netcode
    // stutter root cause. See collision-divergence.test.ts.
    return selectTileVisual(visualLayers, gridX, gridY);
  }
}
