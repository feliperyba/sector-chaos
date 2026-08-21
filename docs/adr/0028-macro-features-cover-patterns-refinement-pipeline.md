# Macro Features, Cover Patterns, and Refinement Pipeline

The seed map's 16 sector skeletons produce individually interesting rooms, but the assembled 80×80 map reads as "16 disconnected puzzle pieces" — uniform window-pane seams, no cross-sector landmarks, and cover placed by random scatter (`rng < density` per tile) rather than deliberate geometric patterns. We keep the 4×4 sector grid, the 16 skeletons, the SectorConnector (untouched), and the existing validation gates — and add three new pipeline stages.

**(1) Macro Feature pass** — places 2-3 cross-sector structures after sector generation and corridor connection: always a **Highway** (5-tile-wide strip carving through 3-4 sectors, the map's spine) and a **Mega-structure** (10×10 compound spanning a center-2×2 seam, the landmark); plus one seed-selected flavor feature (Barrier Ridge — diagonal wall with gaps, or Open Commons — merged sector pair, or nothing). The pass runs AFTER SectorConnector and may overwrite any tile except the outer map perimeter.

**(2) Skeleton-Owned Cover** — each skeleton builder places its own cover using shared **Pattern Utilities** (geometric primitives: Lattice Fill, Concentric Arcs, Edge Trace, Radial Spokes, Cache Framing, Staggered Rows, Diagonal Pairs) replacing EntityPlacer's random crate scatter. Same cover density, designed placement. EntityPlacer retains barrel/trap/chest/weapon placement only.

**(3) Refinement Pipeline** — 6 post-generation passes run in order, each pure and testable: Macro Heal (repair macro feature damage) → Dead Zone Fill (cover sparse EMPTY regions with geometric clusters) → Sightline Break (place cover mid-ray on unobstructed >8-tile sightlines) → Orphan Cleanup (remove cover not adjacent to any structure) → Density Balance (even out quadrant cover counts) → Validate (existing gates).

## Considered Options

- **Full pipeline replacement** (holistic generator for the entire 80×80) — rejected: throws away the 16 skeletons, validation gates, biome system, and connectivity repair; 2-week rewrite for uncertain gain.
- **Sector model overhaul** (break sector independence, organic seams, super-sectors) — rejected: seam complexity not worth it when macro features achieve similar cohesion without destabilizing the connector.
- **Keep EntityPlacer scatter, just reduce density** — rejected: the problem is placement algorithm (random noise), not quantity. Reducing density makes sectors feel empty without fixing the visual quality.
- **Separate pattern-based cover pass** (algorithm reads completed grid, places cover geometrically) — rejected in favor of skeleton-owned cover: skeletons already know their structure and can place cover in patterns specifically tailored to their layout; a separate pass would have to reverse-engineer the skeleton's geometry.
- **All 5 macro features on every map** — rejected: 5 features on 16 sectors means ~30% of the map is macro-overridden, erasing sector skeletons. 2-3 features per map gives identity without overwhelming.

## Consequences

- GDD §5 is amended; this ADR is the recorded *why* for the macro features, cover pattern migration, and refinement pipeline.
- The generation pipeline gains two new stages between entity placement and validation: `MacroFeaturePass.apply()` and `RefinementPipeline.run()`.
- **SectorConnector.ts is explicitly frozen** — the macro pass runs after it and does not modify its code. Macro features may overwrite corridor/border tiles as a post-pass, but the connector logic is untouched.
- Each of the 16 skeleton builders gains cover placement code using shared Pattern Utilities. `EntityPlacer` loses its crate-scatter pass (`CRATE_DENSITY` constants become target densities for skeleton patterns, not scatter probabilities). Barrels, traps, chests, and weapon spawns remain in EntityPlacer.
- New directories: `packages/shared/src/map/macro/` (Highway, MegaStructure, BarrierRidge, OpenCommons, MacroFeaturePass), `packages/shared/src/map/patterns/` (CoverPatterns — the Pattern Utility library), `packages/shared/src/map/refinement/` (6 passes + RefinementPipeline).
- The **seed gallery** (`packages/shared/scripts/map-gallery.ts`) remains the primary quality instrument. Each implementation wave is verified via gallery check before proceeding.
- Feature interaction priority: outer map perimeter (untouchable) → Highway (carves through everything) → Mega-structure (overwrites center seam) → Barrier Ridge / Open Commons (outer sectors, avoid mega-structure zone).
- All new features are **deterministic** (seed-driven) with **isolated RNG streams** so they don't perturb existing generation output.
- The refinement pipeline is **forward-only** (no loop-back). Passes are ordered to avoid cascading fixes: heal before fill, fill before sightline, cleanup last.
- ADR 0027 R2 documents "1-3 varied openings per edge" but `SectorConnector.ts` still implements the original single-centered 3-wide gap. This ADR does not revisit that discrepancy — the user explicitly froze connector changes. The macro pass achieves cross-sector flow variation through highways and mega-structures without modifying corridor logic.
