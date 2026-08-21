# Procedural Map Autotiling in Code with Faithful Enriched Collision

The seed map's "random mess" stems from per-tile random sprite selection for both floor and walls. We decided the autotiling logic (which wall sprite + rotation/flip for a given neighbourhood) lives **in code** (`WallOrientationDetector` / `SeedMapAdapter`), not as Tiled Wang sets in `env.tsx`, and is validated tile-for-tile against the hand-authored `demo_map.tmx`. Floors pick **one uniform sprite per sector instance** (seeded); walls choose a sprite + variant deterministically by an 8-neighbour mask oriented toward the open side (rounded inner corners included). Wall **collision derives purely from the chosen sprite's `env.tsx` colliders** transformed by the tile's rotation/flip — there is **no full-tile fallback** — so fixing the autotiler fixes both render and collision at once. (Originally walls used **one material map-wide**; the Map Cohesion Revamp — see the Update at the end — replaced this with collider-compatible variety pools plus full-tile object art for free-standing walls, without changing the collision mechanism.)

## Considered Options

- **Author Wang/terrain sets in `env.tsx` and consume them** — rejected: `env.tsx` has no Wang data, and we did not want a Tiled-editor round-trip as the source of truth for fitting rules.
- **Full-tile solid collision fallback for thin/opposite-exposed walls** (e.g. connected 1-tile Maze runs/fences) — rejected: the Demo Path never does this; it accepts face-only collision on thin connected walls, and matching the demo's feel is the explicit goal.

## Consequences

- A 1-tile-thick Maze wall **that is part of a connected run/fence** with floor on both sides blocks only its ~46px collider face — **intended**, matching the demo, not a bug. (Scoped: see the Map Cohesion Revamp update below — this no longer applies to free-standing isolated/stub walls.)
- The autotiler must handle maze-interior neighbourhoods the demo never demonstrates by extrapolating the same orientation rules from the TMX/TSX metadata.
- `WallOrientationBuilder.ts` is dead duplicate of `SeedMapAdapter`'s inline wall logic and should be consolidated during the fix.

## Update — Superseded in part (2026, Map Cohesion Revamp)

The "thin-wall face-only collision is intended, do not fix it" consequence above is now **scoped to connected thin runs/fences only**. Free-standing obstacles — a wall cell with ≤1 wall-like *cardinal* neighbour (an isolated pillar or a 1-connection stub) — no longer render as a lone autotiled bar with a collision gap. They now resolve to **full-tile OBJECT art** (`coffin`/`crate_small` for indestructible, `crate`/`tree`/`planks` for destructible) and therefore carry **full-tile colliders**. The old "lone bar with a collision gap" is deliberately fixed for these cells.

The collision *mechanism* is unchanged — collision still derives solely from the chosen per-cell sprite's `env.tsx` colliders transformed by the cell's rotation/flip, with no full-tile AABB fallback. What changed is the *sprite chosen* for free-standing cells (a full-tile object whose own collider spans the tile), so full-tile collision is an emergent effect of faithful enriched collision, not a new fallback path. The pick logic lives in `packages/server/src/infrastructure/map/wallSpriteResolver.ts` (called from `SeedMapAdapter.buildWallLayer`); `WallMaskClassifier`/`WallOrientationDetector` were not changed. Connected thin runs/fences keep their ~46px face-only collider exactly as described above.
