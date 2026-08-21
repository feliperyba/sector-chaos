# ADR 0022: SAT-Based Melee Hitbox System

## Status

Accepted

## Context

Melee hit detection previously treated players as points, not shapes. The historical `isPointInArc` center-point-vs-cone check (now deleted) was replaced by `buildSectorPolygon`-driven SAT in `MeleeArcHandler`, and `segmentCircleIntersection` was replaced by `buildRotatedRect`-driven SAT in `MeleeLineHandler`. The legacy center-point path is no longer present; this ADR captures the now-live SAT design.

Additionally, wall occlusion uses center-to-center DDA raycasting, which produces false occlusions at wall corners where the hitbox extends around the corner but the center-to-center ray clips through the wall tile.

The existing SAT infrastructure (`ColliderCollision.testAABB`) already handles AABB-vs-polygon collision for tile collision. The strategy pattern (`IAttackHandler`) and `DamagePipeline` are stable and don't need changes.

## Decision

### 1. Player Hurtbox

Introduce an 80×80 axis-aligned AABB centered on each player's position as the damage hurtbox. Sub-visual (movement hitbox remains 96×96). Configurable via `COMBAT.HURTBOX_SIZE`. Does NOT rotate with facing — symmetric in all directions.

### 2. ARC Hitbox = Sector Polygon

Replace `isPointInArc` center-point check with a 7-vertex sector polygon. Vertices: 2 at inner arc (facing ± arcAngle/2 at radius 40px), 5 along outer arc (at radius range + 40px). Inner radius = HURTBOX_SIZE/2 (40px), outer radius = weapon range + 40px. Arc angle from weapon `arcAngle` property. Built by `buildSectorPolygon()` in `shared/src/math/`.

### 3. LINE Hitbox = Rotated Rectangle

Replace `segmentCircleIntersection` with a 4-vertex rotated rectangle. Width = LINE_ATTACK_WIDTH (20px), length = weapon range, rotated by facingAngle. Start offset configurable per weapon via `lineStartOffset` in `WeaponConfig.specialProperties` (default 40px). Built by `buildRotatedRect()` in `shared/src/math/`.

### 4. 1-Tick Instantaneous Hitboxes

Hitboxes live for 1 tick only: spawned at `completeWindup()`, tested once against all hurtboxes, destroyed. No per-entity hit tracking needed. Multi-tick active frames can be added later per-weapon-type.

### 5. Two-Stage Wall Occlusion

Stage 1: DDA center-to-center fast reject (existing). Stage 2: if DDA finds a wall, SAT test the wall tile's AABB against the hitbox polygon. Wall only blocks if it's actually inside the hitbox zone. Fixes corner-clipping.

### 6. Architecture: Rewrite Handler Internals

`MeleeArcHandler` and `MeleeLineHandler` files are kept, their `execute()` internals are rewritten to use polygon builders + SAT. Same `MeleeHitResult`/`LineHitResult` interfaces. Strategy layer and `DamagePipeline` untouched. Destructible detection remains a separate pass.

### 7. Scope: Melee Only

Projectiles keep existing radius-based player collision. Change `PLAYER_HIT_RADIUS` to 40px (half of 80px hurtbox) as approximation. Projectile SAT is a follow-up PR.

### 8. Polygon Builders in Shared

`buildSectorPolygon()` and `buildRotatedRect()` live in `shared/src/math/`. Pure math, zero dependencies. Client debug visualization deferred but can import these when needed.

### 9. Broad Phase Fix

Broad phase range corrected to `weapon range + HURTBOX_SIZE/2` to properly account for hurtbox size. Current code queries at `range` but tests at `range + 48`, making the extension useless.

## Considered Options

**Hurtbox size:**
- 96×96 (full visual): No near-miss skill play, first pixel of overlap = instant hit. Eliminates "dancing at the edge" gameplay. Rejected.
- 96×64 (rectangular, rotating): Directional inconsistency during strafing as hurtbox orientation changes with facing. Rejected.
- 80×80 square (sub-visual, axis-aligned): Symmetric in all directions, allows near-misses, tunable. Accepted.
- 64×64 (small core): Too many whiffs on a 96px visual body, players feel cheated. Rejected.

**ARC hitbox shape:**
- Rotated rectangle: Doesn't match GDD's 90-degree arc geometry. Either under-covers at arc edges or over-covers at close range. Rejected.
- Sector polygon (7 vertices): Matches GDD arc geometry exactly, cheap for SAT. Accepted.

**Active frames:**
- Multi-tick (2-4 ticks): Gameplay change not specified in GDD, expensive for 64 players. Rejected for v1.
- 1 tick (instantaneous): Pure accuracy fix, no behavior change beyond geometry. Accepted. Multi-tick can be layered on later.

**Wall occlusion:**
- Center-to-center DDA only: Current behavior, corner-clipping problem persists. Rejected.
- Multi-ray (5 points on hurtbox): Over-corrects, would allow hitting targets mostly behind walls. Rejected.
- Two-stage (DDA + SAT confirm): Fixes corner-clipping, cheap (extra SAT only when DDA reports wall). Accepted.

**Architecture:**
- HitboxManager as persistent service: Over-engineered for 1-tick hitboxes. Rejected.
- Stateless SAT test function replacing handler internals: Same interface, minimal surface area change. Accepted.

**Scope:**
- Include projectiles: Touches 365+242 lines of complex state logic for marginal accuracy gain. Rejected for v1.
- Melee-only with PLAYER_HIT_RADIUS approximation: Focused scope, lower risk. Accepted.

## Consequences

- **New shared code**: `buildSectorPolygon()`, `buildRotatedRect()` in `shared/src/math/`. ~80 LOC.
- **Modified shared constants**: `COMBAT.HURTBOX_SIZE = 80`, `PLAYER_HIT_RADIUS = 40`.
- **Modified weapon config**: `lineStartOffset` field in `WeaponConfig.specialProperties` (default 40).
- **Rewritten handlers**: `MeleeArcHandler.execute()` and `MeleeLineHandler.execute()` internals replaced with polygon builders + SAT. Same result interfaces.
- **Rewritten tests**: In-place update of 1,364 lines of melee handler tests. 5 new edge-case tests added.
- **Behavioral delta**: ARC gains 8px close-range coverage (inner radius 40 vs 48). LINE gains close-range dead zone (start offset 40 vs 10). All weapons gain accuracy from shape-based collision (more edge hits land). Projectiles unchanged except `PLAYER_HIT_RADIUS` value.
- **No client changes**: Combat is server-authoritative. Debug visualization deferred.
- **No DamagePipeline changes**: Same hit results flow through same pipeline.
- **No strategy layer changes**: `ArcAttackHandler` and `LineAttackHandler` call same handler interface.
