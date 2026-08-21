# ADR 0021: Collision System Fix — Collider-Based Projectiles + Melee Occlusion

## Status

Proposed

## Context

Two collision bugs have been identified in the combat system:

1. **Projectile collision uses enum gates instead of collider metadata.** `ProjectileTileCollision.check()` gates on a `solidTileTypes` set containing 6 specific `TileType` values. Tiles not in this set (e.g., CHEST) are passable to projectiles regardless of whether they have physical collider shapes. This means thrown weapons and arrows pass through chests and any future tile type not manually registered in the set.

2. **Melee attacks leak through physical objects.** Both `MeleeArcHandler.isWallTile()` and `MeleeLineHandler.isWallTile()` only check `INDESTRUCTIBLE_WALL` and `DESTRUCTIBLE_WALL`, missing DESTRUCTIBLE_BARREL, INDESTRUCTIBLE_CRATE, DESTRUCTIBLE_CRATE, and DOOR_CLOSED. Additionally, `resolveMeleeDestructibleHits()` has no wall occlusion check at all — melee damage is applied to destructible entities through solid walls. DDA raycast collects all hits instead of early-exiting. LINE attack clips player range via wall detection but passes the full unclipped range to destructible resolution.

The root cause is the same: collision "what is solid" decisions use hardcoded enum lists that can diverge across systems, rather than querying tile properties or collider metadata.

## Decision

### Problem 1: Three-path projectile collision

Replace the `solidTileTypes` enum gate in `ProjectileTileCollision.check()` with a three-path approach matching the existing `CollisionService.resolveEnriched()`:

1. **Skip** tiles where `tileType === EMPTY || tileType === EXIT`
2. **Collider SAT** when tile has visual data with a sprite that has collider shapes
3. **Fallback AABB** when tile has no collider metadata (no visual, or empty spriteId)

Delete `SOLID_TILE_TYPES` from `ThrowHandlerTypes` and `RangedHandler`. Remove the `solidTileTypes` parameter from `ProjectileTileCollision.check()`.

### Problem 2: Centralized blocking + DDA occlusion

- Create `isBlockingTile(tile: TileType): boolean` in shared — allowlist: `tile !== EMPTY && tile !== EXIT`. New tile types block by default.
- Create `isRayBlocked(origin, target, grid, tileSize, excludeGridPos?): boolean` in shared — wraps DDA raycast with `isBlockingTile`.
- Delete duplicated private `isWallTile()` from both melee handlers.
- `DDARaycast.cast()` returns `RaycastHit | null` with early-exit on first solid.
- `resolveMeleeDestructibleHits()` gains per-destructible DDA occlusion via `isRayBlocked` with each destructible's own grid cell excluded from the solid check.
- `MeleeLineHandler` returns `effectiveRange`; destructible distance capped by `min(range, effectiveRange)`.

### CHEST behavior change

Both fixes make CHEST tiles block projectiles and melee. Previously projectiles and melee passed through chests. This is intentional — chests are physical objects.

**Considered options:**
- Expand the blocklist from 2 to 6+ tile types (rejected: still diverges, still requires manual updates for new tile types)
- Expand to 7+ tile types including CHEST (rejected: same fragility, just longer)
- Allowlist approach: block everything except EMPTY and EXIT (accepted: future-proof, matches `CollisionService.isTileBlocked` logic)
- Per-tile collider-based check for projectiles only (rejected: inconsistent — some tiles would block projectiles but not melee)
- Extract `isBlockingTile` but keep separate from `isRayBlocked` (rejected: `isRayBlocked` wraps the same concept, single source of truth)

**Consequences:**
- All non-EMPTY, non-EXIT tiles block both projectiles and melee by default
- CHEST tiles block thrown weapons, arrows, and melee attacks (new behavior)
- No more hardcoded tile type lists in handlers — single `isBlockingTile()` in shared
- `DDARaycast.cast()` API break: return type changes from `RaycastHit[]` to `RaycastHit | null`
- `ProjectileTileCollision.check()` API break: `solidTileTypes` parameter removed
- `LineHitResult` gains `effectiveRange` field
- `resolveMeleeDestructibleHits` gains `effectiveRange` parameter and requires grid/tileSize access
- No client-side changes needed — combat is server-authoritative
