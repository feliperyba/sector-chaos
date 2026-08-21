# ADR 0016: Client-Side Collision Resolution for Prediction

Accepted

Client prediction and reconciliation use a binary `isWalkable()` check (4-corner point-in-tile, pass/fail) while the server uses `resolveTileCollision()` (AABB overlap with MTV push-out). This asymmetry causes two problems: (1) Mode A — client predicts through wall edges (4 corners miss the overlap), server pushes back, 2-5px oscillation at 60Hz triggers walk animation flicker; (2) Mode B — client stops entirely at wall corners (binary reject), server slides along the wall (resolving push-out), player perceives "sticky walls" and can't wall-slide diagonally. The fix is a new `ClientCollisionService` on the client that uses the same shared collision math (`AABBCollision.getMTV`, `ColliderCollision.resolveEntityTileColliders`) as the server, with the same AABB push-out behavior. Both `runPredictionStep` and `Reconciler.reconcile` switch from `isWalkable()` to `resolveCollision()`. `isWalkable()` remains on `MapRenderer` for non-prediction consumers (projectile checks, etc.).

**Considered options:**
- Raise `MOVE_ENTER_THRESHOLD` (rejected: band-aid, doesn't fix sticky walls or position oscillation)
- Error-aware animation gating (rejected: hides visual symptom, doesn't fix sticky walls or prediction error)
- RenderOffset smoothing layer (deferred: useful for residual corrections but doesn't address root cause. Revisit after collision fix if needed)
- Extract server `CollisionService` into shared (rejected: server version has server-specific dependencies, enriched grid state, try/catch fallbacks. New client-specific class using shared math libs is cleaner)
- Client-side AABB resolution matching server behavior (accepted)

**Consequences:**
- Client prediction matches server collision behavior — eliminates wall-proximity jitter and enables wall-sliding
- `Reconciler` type changes from `CollisionFn = (x, y, radius) => boolean` to `CollisionResolveFn = (x, y, halfW, halfH) => {x, y}`
- New `ClientCollisionService` wraps `MapRenderer`'s grid/atlas/visualLayers data (same objects, no copies, no sync issues)
- ClientCollisionService handles both simple tiles (AABB) and enriched atlas colliders (SAT), matching the server's dual-path resolution
- MapRenderer gains two new getters: `getAtlas()`, `getVisualLayers()`
- No changes to server collision code, thresholds, or walk animation logic
