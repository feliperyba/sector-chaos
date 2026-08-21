import { SectorType } from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  CORRIDOR_WIDTH,
} from '../constants/grid.js';

export { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE, TILE_PIXEL_SIZE, CORRIDOR_WIDTH };

/**
 * Map generation pipeline version. Bumped once per planned determinism-contract
 * change (ADR 0035) — golden fixtures regenerate and re-pin on every bump.
 *
 * - v3 (map-redesign ticket 01): ground-weapon tiers authored per ring from
 *   `RING_TIER_WEIGHTS` (outer Common-only / center 60/25/12/3) instead of the
 *   uniform 50/30/15/5 table; entity hydration now consumes generator-authored
 *   chest tiers (re-roll removed). RNG draw order is unchanged — only the
 *   authored tier values in `lootPlacements` differ.
 * - v3 re-pin (map-redesign ticket 02, still one planned bump per DEC/ADR
 *   0035): per-sector loot-tier pyramid + per-match hot sector added to
 *   MapData (`sectorTiers`/`hotSector`); chest + ground-weapon tiers now
 *   authored from the per-tier tables (`SECTOR_TIER_CHEST_WEIGHTS` /
 *   `SECTOR_TIER_WEAPON_WEIGHTS`) instead of the ring tables; map-wide
 *   legendary cap (~10) shared across all legendary sources. RNG draw COUNT
 *   per placement is unchanged — only authored tier values + new fields
 *   differ, so fixtures re-pin tier-lines + the two new fields only.
 * - v4 (map-polish ticket 01 — beacon moody retune): beacon light constants
 *   retuned in place — hero radius 576→512, Citadel radius 640→576, tier
 *   intensity band [2.6,2.8]→[2.45,2.6] (HOT 2.6 / RARE 2.55 / WARM 2.5 /
 *   COLD 2.45). ZERO RNG draws added/moved (ADR 0035): the LNDM stream is
 *   untouched — placements are identical, only the beacon `intensity`/
 *   `radius` VALUES riding `MapData.landmarks`/`MapData.fortress` (and the
 *   enriched `lightPlacements`) differ, so fixtures re-pin those fields only
 *   (strip-diff discipline).
 * - v4 re-pin (map-polish ticket 03 — theme-keyed beacon colors, still one
 *   planned bump per DEC/ADR 0035): beacon HUE re-keyed from loot tier to
 *   sector TYPE via `BEACON_THEME_LIGHT` (GRID steel-blue / OPEN emerald
 *   green / MAZE violet / RICH gold); the RARE violet hue override on hero
 *   beacons is dropped (rarity keeps only the intensity bump) and the
 *   standard compound beacon switches to its anchor sector's theme color
 *   (Citadel stays RARE violet). ZERO RNG draws added/moved (ADR 0035):
 *   color+intensity remain pure lookups of `(sectorType, tier, rarity)`, so
 *   the LNDM stream layout is unchanged — only `landmarks.heroes[*][*]
 *   .beacon.color` + `fortress.beacon.color` (and the passthrough colors in
 *   the enriched `lightPlacements`) differ; fixtures re-pin those fields
 *   only (strip-diff discipline).
 * - v5 (map-polish ticket 05 — beacon plaza real composition): every hero
 *   landmark's region becomes REAL authored geometry stamped into
 *   `sector.tiles` AFTER `assignLandmarks` and BEFORE `EntityPlacer.place` —
 *   indestructible wall segments framing the anchor (Chebyshev-2 ring, ≥2
 *   openings, each segment ≥2 tiles) + 2–4 `DESTRUCTIBLE_CRATE` tiles
 *   flanking the approaches (hydrated to live destructible entities via the
 *   existing grid path). The stamp is a PURE zero-RNG projection of the
 *   landmark assignment (`landmarkPlaza.ts`) — ZERO draws on the main or
 *   LNDM streams, so the landmark assignment itself (anchors,
 *   compositionIds, beacon specs) is byte-identical. Because the entity pool
 *   now sees the plaza tiles (mandated: real geometry the placers must
 *   respect), entity/loot/trap/spawn/identity rows legitimately cascade in
 *   the whole-MapData fixtures alongside the tile rows; downstream
 *   `lightPlacements` shift through the same cascade (entity pools → POI
 *   glow clusters / doorway ladder eligibility / hearth candidacy) — the
 *   `lights-seed-*.json` goldens were re-pinned content-only under the
 *   orchestrator ruling (bfcb99b3), with the beacon sub-lists byte-pinned
 *   via `beacons-pinned-seed-*.json`. The client composite bake is reduced
 *   to EMPTY/decor floor dressing (object-visual frames removed from the
 *   hero registry).
 * - v6 (map-polish ticket 07 — light-prop destructible entities): every
 *   NON-EXEMPT light placement (route-mid sconces, dark-gap fill, POI glow
 *   pools, biome crystals) hydrates as a `'light'` destructible entity; the
 *   exemption set (beacons, corridor-passage doorway sconces, campfires)
 *   stays baked / already-backed. The discriminator is a NEW OPTIONAL
 *   per-placement provenance field `anchor` on `LightPlacementTiled`
 *   (`'doorway' | 'route' | 'fill' | 'poi-pool' | 'crystal' | 'campfire'`).
 *   ZERO RNG draws added/moved (ADR 0035): the label is emitted inline by the
 *   existing zero-RNG geometry passes / isolated salted streams, so placement
 *   POSITIONS/kinds are byte-identical per seed — the lights goldens re-pin
 *   the `anchor` field ONLY (strip-diff discipline). Existing
 *   crate/barrel/wall/iron destructibles are untouched; `'light'` entities
 *   append wire index 4 to `DESTRUCTIBLE_TYPE_ORDER`.
 * - v7 (map-polish ticket 14 — wall composition gate): the generation-side
 *   `WallCompositionPass` (final tile-mutating step, zero RNG) clears
 *   UNSANCTIONED orphan indestructible stubs (1-tile notched gate-jamb
 *   remnants; MAZE separator pillars are sanctioned cover-object placements
 *   and stay) and converts orphaned destructible walls to
 *   `DESTRUCTIBLE_CRATE` so standing breakable WALL cover is always ≥2-tile
 *   clusters. Sector tiles change ONLY on seeds that carried unsanctioned
 *   orphans (~2 unsanctioned indestructible + ~11 shards per seed,
 *   108 + 599 across the 53-seed sweep); compliant seeds are byte-identical.
 *   Sanctioned cascade in the whole-MapData goldens: the changed tile rows
 *   plus entity/loot/spawn/identity rows reading those tiles; lights goldens
 *   re-pin through the same tile-driven cascade (ticket-05 precedent). No
 *   serialized-shape change; the bump records the tile-stream change.
 * - v7 re-pin (map-polish round-2 ticket 15 — beacon color tones re-derived
 *   from the MAIN-MENU light registry, still one planned bump per DEC/ADR
 *   0035): `BEACON_THEME_LIGHT` colors rebuilt from the menu's `TONE_BIOME`
 *   accents (GRID ← forest-glade steel-blue, OPEN ← forest-bonfire emerald,
 *   MAZE ← crypt violet, RICH ← temple ivory-gold) via the uniform scale
 *   `c ÷ max(tone)` — hue + HSV saturation preserved exactly, only the peak
 *   channel normalized to the beacon 1.0 convention (the menu's dim-accent ×
 *   intensity-3.0 crystal convention cannot cross into the tier-coded
 *   [2.45,2.6] static band). Citadel keeps RARE violet. ZERO RNG draws
 *   added/moved (ADR 0035): color stays a pure lookup of `sectorType`, so
 *   the LNDM stream layout is unchanged — only the serialized
 *   `landmarks.heroes[*][*].beacon.color` + `fortress.beacon.color` values
 *   (and the passthrough colors in the enriched `lightPlacements` /
 *   beacons-pinned pins) differ; fixtures re-pin those fields only
 *   (strip-diff discipline — the round-1 ticket-03 v4-re-pin precedent:
 *   round-1's color re-key also rode the then-current version).
 * - v10 (map-polish round-3 ticket 25 — prefab library + smart reuse): the
 *   refinement stage's three per-cell scatter passes (dead-zone random
 *   3-crate shapes, sightline midpoint crates, density-balance shuffled
 *   top-ups) are REPLACED by the deterministic prefab placement pass
 *   (`prefabs/PrefabPlacementPass.ts`) — authored compositions from a
 *   10-prefab library (`prefabs/PrefabLibrary.ts`, four biome families +
 *   the universal gate-piers vocabulary, art-aware run/corner encoding per
 *   the ticket-24 beacon-keep discipline: straight ≥2-tile runs, corners
 *   owned by exactly one run, no 2×2 wall-like clumps, no sealed regions)
 *   stamped into featureless all-EMPTY 5×5 pockets (the replaced dead-zone
 *   pass's own trigger) with seeded selection + rotation/mirror variation on
 *   an isolated XOR-salted stream ('PREF' — zero main-stream draws, ADR
 *   0035). The stage's zero-RNG orphan cleanup is preserved inside the pass.
 *   Guards reused: paint-gate (EMPTY interior, non-corridor/macro/lootSpot,
 *   landmark-anchor core kept clear), conflict-clip (longest ≥2-tile stretch
 *   per run), per-write 2×2 wall-clump refusal, full-composite
 *   EMPTY-component never-seal revert (a stamp may not split ANY open
 *   region — the validator flood gate's own semantics), and a
 *   stamp-created 1-wide-slot refusal (the late-closer class: no prefab gap
 *   may be single-tile-pluggable by the later keep/entity passes; reverted
 *   stamps restore exact EMPTY). Sanctioned cascade (the ticket-05/24
 *   class): stamped-prefab `sector.tiles` rows + the entity/loot/spawn/
 *   trap/identity rows reading them, `weather` (the main-stream draw count
 *   shifts through pool-size-dependent consumer loops), `landmarks.heroes`
 *   FALLBACK-PATH anchors (sectors whose authored anchor site was already
 *   blocked keep resolving via the grid-dependent fallback search, which
 *   sees different EMPTY availability; authored-site anchors are unchanged
 *   by construction), and the lights goldens through the entity pools. The
 *   REFI refinement stream is no longer consumed by the production pipeline
 *   (the class stays for its unit tests); sector-skeleton scatter passes
 *   (lattice/edge/staggered cover fill) are untouched — a read-only annex
 *   in the ticket-25 report for coordination.
 * - v9 (map-polish round-3 ticket 24 — the beacon keep): the round-2
 *   4-archetype plaza grammar (DAIS_COURT/PROCESSION/GARDEN/BASTION + the
 *   MOUTH/GUARD/GATE crate-pair vocabulary) is replaced by ONE authored
 *   structure every hero landmark shares — a small ruined keep: beacon at
 *   the anchor, three straight wall runs on the Chebyshev-2 ring forming a
 *   ∩-shaped partial enclosure (W/E vertical 5-tile runs + a 3-tile N bar
 *   behind the beacon, L-corner joins at (±2,-2), gate piers at (±2,2)),
 *   fully open to the south, with at most 2 symmetric DESTRUCTIBLE_CRATE
 *   props at (±1,3) flanking the approach — NO crates inside the enclosure,
 *   no archetype menu, no per-seed variant draw (the ≤3-variant allowance is
 *   deliberately untaken: sixteen identical keeps read as one map-wide
 *   structure). Owner verdict on the round-2 grammar (verbatim): "The beacon
 *   plaza composition is a fucking mess… just do a nice structure with the
 *   beacon light and some walls protecting it." ZERO RNG draws added/moved
 *   (ADR 0035): the stamp stays a pure zero-RNG projection of the unchanged
 *   landmark assignment, so anchors/compositionIds/beacon specs are
 *   byte-identical — only plaza-region `sector.tiles` rows differ, with the
 *   ticket-05 sanctioned cascade (entity/loot/spawn/trap/weather/identity
 *   rows + lights goldens through the entity pools). Beacons
 *   (positions/colors/intensities) ride the beacons-pinned fixtures
 *   byte-identical — the keep forms AROUND the anchor, which never moves.
 *   `landmarkPlaza.ts` + `landmarkPlazaArchetypes.ts` merge into one file
 *   (the grammar half is gone; the stamping mechanics are unchanged).
 * - v8 (map-polish round-2 ticket 16 — plaza archetype grammar): the 16
 *   freely-varying ticket-05 plaza layouts are re-grammared into FOUR
 *   archetypes (DAIS_COURT / PROCESSION / GARDEN / BASTION — every plaza
 *   shares one centered N focal screen and one guaranteed unstamped S
 *   approach axis; RARE compositions always resolve to the enclosed
 *   BASTION court) with one shared axis-mirror crate-pair vocabulary
 *   (MOUTH universal + one sector-palette accent: GRID GUARD / OPEN GATE /
 *   MAZE stripped / RICH full pairs). Per-sector variation is accent swaps
 *   inside the grammar, never new shapes. ZERO RNG draws added/moved (ADR
 *   0035): the stamp stays a pure zero-RNG projection of the unchanged
 *   landmark assignment, so anchors/compositionIds/beacon specs are
 *   byte-identical — only plaza-authored `sector.tiles` rows differ, with
 *   the ticket-05 sanctioned cascade (entity/loot/spawn/trap/weather/
 *   identity rows + lights goldens through the entity pools). Beacons
 *   (positions/colors/intensities) ride the beacons-pinned fixtures
 *   byte-identical — layouts form AROUND the anchor, which never moves.
 * - v8 re-pin (map-polish round-2 ticket 18 — corridor sconces: one prop,
 *   one tone, still one planned bump per DEC/ADR 0035): the doorway-sconce
 *   KIND draw is REMOVED from the isolated light stream and replaced with
 *   the fixed pair `DOORWAY_SCONCE_KIND` ('torch') + `DOORWAY_SCONCE_COLOR`
 *   (TONE_WARM [1.0,0.55,0.22], the main-menu registry tone) — ONE prop +
 *   ONE tone for both members of every pair and all 24 corridors (the
 *   pre-ticket draw mixed 14–18 of the 24 pairs per seed as two different
 *   props with two palette tones). NET RNG DRAWS REMOVED (~48 per seed —
 *   zero added, ADR 0035), so every LATER kind pick on the stream shifts
 *   (route-mid + dark-gap fill kinds + the fill-pass candidate shuffle) —
 *   the sanctioned cascade. Doorway positions/anchors are byte-identical
 *   (pair counts exactly as pinned: 23/1 seed 1, 24/0 seeds 42/999/
 *   0xdeadbeef + bench 12345); only doorway `kind`/`color` values + the
 *   cascaded sconce kinds differ. `color` is an EXISTING optional
 *   `LightPlacementTiled` field (no serialized-shape change) ⇒ the version
 *   rides v8 — the ticket-03 v4-re-pin / ticket-15 v7-re-pin precedent.
 * - v11 (map-polish round-3 ticket 26 — sector floor cohesion): every sprite
 *   that can appear inside a sector's floor is now confined to ONE value/hue
 *   family per sector type (atlas pixel audit: gray-tan stone
 *   `tiles`/`tiles_center`/`tiles_cracked`/`tiles_decorative` ~135–148 mean
 *   RGB; brown `tile`/`wood` ~104–118; green `grass`/`water` ~80–95).
 *   Fixes the owner-visible mismatches: (a) MAZE's scattered `water` accent
 *   (~89%-opaque GREEN full tile) read as random grass tiles on gray stone —
 *   dropped; (b) RESOURCE_RICH's gray-stone accents
 *   (`tiles_decorative`/`tiles_corner`/`tiles_cracked`) clashed hue+value with
 *   its brown `tile` base — replaced with sparse transparent `plants`; (c) the
 *   ~94%-opaque patterned stone full-tiles no longer scatter via the
 *   decoration overlay at all — GRID gets a deterministic in-family
 *   `tiles_cracked` wear band at 6% and MAZE at 8% (new
 *   `FLOOR_VARIANT_SPECS` in `biomeConfig.ts`, painted by a PURE
 *   (seed,row,col) position hash in FloorSpriteSelector — ZERO RNG stream
 *   draws, ADR 0035), with GRID's overlay reduced to occasional `puddle`;
 *   (d) the central 4×4 plaza accents are re-keyed in-family (GRID
 *   `tiles`→`tiles_decorative` medallion, OPEN `tiles_center`→`water`
 *   clearing pond, MAZE brown `tile`→`tiles_decorative`, RICH gray
 *   `tiles_center`→`wood` plank dais). The decoration overlay now draws ONLY
 *   genuinely-transparent sprites (`plants` ~19% opaque, `puddle` ~56%).
 *   Per-type accent streams keep their isolated salts — only each stream's
 *   internal draw count changes (density re-tuning); the floor base pick
 *   keeps its exact one-draw-per-sector layout, and MapGenerator / entity
 *   placement are untouched ⇒ the whole-MapData goldens, lights goldens, and
 *   beacons pins are byte-identical (decoration/floor layers never enter the
 *   occupied-tile set that drives lights).
 * - v12 (map-polish round-3 ticket 28 — interior structure organization): the
 *   sector skeletons' per-cell RNG scatter FILL passes are REMOVED — every
 *   `latticeFill` / `edgeTrace` / `staggeredRows` / `diagonalPairs` invocation
 *   inside the skeleton builders (gridArenaSkeletons / openArenaSkeletons /
 *   resourceRichSkeletons / mazeSkeletons / sewerGrid / airstrip / bankRow /
 *   plazaCrossroads), plus the maze `edgeTrace` destructible dressing and the
 *   already-dead `concentricArcs`. Those passes rolled independent per-cell
 *   skip/density dice and sprinkled singles/dominoes between the authored
 *   structures (the owner's "completely random, no real POI or structure
 *   organization, just random positions"). The four functions + their helpers
 *   are deleted from `patterns/CoverPatterns.ts` (the surviving primitives,
 *   `radialSpokes` + `cacheFrame`, are deterministic authored geometry); the
 *   production-dead refinement classes (`RefinementPipeline`,
 *   `DeadZoneFillPass`, `SightlineBreakPass`, `DensityBalancePass` — dead
 *   since the ticket-25 prefab pass replaced the stage) are deleted with it.
 *   The PREFAB PLACEMENT PASS is promoted to the PRIMARY interior composer:
 *   its window criterion relaxed from all-EMPTY 5×5 to a mostly-open window
 *   (≥18 of 25 cells EMPTY; footprint cells still per-cell paint-gated so
 *   authored geometry is never overwritten) and the per-sector stamp caps
 *   raised 3/3/2/3 → 5/5/3/5. All guards stay (paint-gate, keep-zone,
 *   conflict-clip ≥2, 2×2 refusal, full-composite never-seal, slot-pinch).
 *   RNG CASCADE (ADR 0035, sanctioned): the removed fill rolls shrink the
 *   per-sector phase-1 BASE skeleton draw inside the forked subSeed stream —
 *   the appended sub-block/mirror phases then read from shifted stream
 *   positions (same phase STRUCTURE, exactly blocks.length + 1 appended
 *   draws), so sub-block presence masks + mirror bits legitimately flip. The
 *   isolated PREF stream keeps its salt; only its internal draw count grows
 *   (more qualifying windows × higher caps). Sanctioned whole-MapData golden
 *   cascade: sector tile rows, the entity/loot/spawn/trap/identity rows
 *   reading them, `weather` (main-stream consumer loops shift through the
 *   pool-size-dependent cascade), `landmarks.heroes` FALLBACK-PATH anchors
 *   (anchor resolution reads the post-placement grid; authored-site anchors
 *   are unchanged by construction), and the lights goldens through the entity
 *   pools (beacons re-pin position-only where fallback anchors moved). Census
 *   (seeds 1..20 + 1/42/999/0xdeadbeef): all 23 seeds valid at first attempt,
 *   min per-sector open ratio 0.651→0.664, loot-eligible margins ≥40 per
 *   sector, lone walls ≤15 (gate 60), prefab stamps 11.3→20.4/map with all
 *   10 library ids in circulation.
 * - v13 (map-polish round-4 ticket 29 — beacon plaza over the grid layers):
 *   the client composite dressing bake is REMOVED (the owner's ruling:
 *   "baking random tiles on top of the floor grid … create real map
 *   composition over the grid layers") — `bakeLandmarkComposites` drew loose
 *   `game`-atlas decor frames (`tiles_decorative`, `tiles_cracked`, `grass`,
 *   `puddle`, `wood`, `track`, `path`, `water`, `plants`) at FRACTIONAL tile
 *   offsets around each hero anchor plus one decor tile per junction minor;
 *   the module is deleted client-side and the shared registry loses
 *   `parts`/`scale`/`tint` (compositions keep id/family/rarity/
 *   exclusionRadius/nounHints — POI naming + server exclusion zones stay).
 *   `MINOR_LANDMARK_PROPS` + the `MinorLandmark.propId` field are deleted
 *   with the minor prop tile. The composition is now SERVER-side over the
 *   grid layers: the beacon keep (ticket 24, unchanged) + a beacon-anchored
 *   COURT floor patch (`FloorSpriteSelector` — the in-family
 *   `PLAZA_ACCENT_PATHS` sprite over the keep's interior court, keyed off
 *   `mapData.landmarks.heroes`; the fixed 4×4 sector-center medallion that
 *   ignored the anchor is removed). RNG (ADR 0035): the LNDM-stream TAIL
 *   draw — the per-minor prop pick, one `rng.nextInt` per chosen minor — is
 *   removed with `propId`; every earlier draw (hero picks, adjacency
 *   re-draws, minor count + node shuffle) is byte-identical, so the
 *   whole-MapData goldens differ ONLY in `landmarks.minors[*]` losing
 *   `propId` (heroes/tiles/entities byte-identical) and the lights/beacons
 *   fixtures are untouched (light placements never read `propId`; the court
 *   patch is a derived visual layer that never enters the occupied-tile set
 *   driving lights — the v11 precedent).
 * - v14 (map-polish round-5e — wall autotiling: keep mirror + border-buffer
 *   re-clean): TWO fixes. (1) The shared `MapGenerator` re-runs
 *   `MapBorder.cleanBuffer` AFTER the prefab pass + plaza keeps (before
 *   `WallCompositionPass`) — the early clean at skeleton time no longer holds
 *   once those stampers paint wall tiles at sector-local 1/18, and any such
 *   tile buries border-ring tiles into cross/inner_corner roles mid-run and
 *   dirties gate-jamb flanks (the owner-visible "border walls not following
 *   the logical wall progression"). Idempotent, zero-RNG; clipped keep runs
 *   read as ruin breaches. (2) Server-side wall-visual selection (NOT
 *   serialized MapData): thin 2-opposite-open indestructible straights follow
 *   the ARM side of the corner their run terminates into (mirrored keep
 *   walls) and endcaps capping thin runs adopt their run's facing — a pure
 *   selector function, MapData-irrelevant. RNG (ADR 0035): ZERO draws added/
 *   moved — the re-clean is a pure grid function. Sanctioned whole-MapData
 *   golden cascade: sector tile rows at the cleared buffer cells + the
 *   entity/loot/spawn/trap/identity rows reading them; lights goldens through
 *   the entity pools (beacons byte-identical — anchors unchanged); the
 *   ring-audit seam-fill exception bound re-pins 5 → 22 (corridor-junction
 *   jambs that now render unfilled + band-connected instead of buried +
 *   filled; seamViolations === 0 holds).
 * - v15 (map-polish round 6 — wall material & interior density): (1) NEW
 *   `BreachPanelPass` (shared refinement, pure zero-RNG geometry) converts
 *   INDESTRUCTIBLE_WALL → DESTRUCTIBLE_WALL on INTERNAL composition only
 *   (owner correction: sector border double walls are NEVER breachable) —
 *   straight-run middles and exactly-2-thick interior band faces in a 2-on/
 *   2-off panel cadence (spans 2–4 whole), keeping rigid anchors: sector
 *   border rings/seams, map-edge ring, run endpoints, corners/tees/thick
 *   cores, and the preserved compound/Citadel footprint (its yard is authored
 *   breakable; its vault shell stays rigid). Owner directive: destructibles IN
 *   the structure geometry ("users can create paths and open ways to reach
 *   their enemies or escape"), not scattered. Material-only flips
 *   (wall-likeness, masks, roles, connectivity unchanged). (2) Prefab
 *   density: GATE_PIERS/COVER_BRACE/RUIN_FRAGMENT prop sets enriched + two
 *   compositions added (STOCKYARD, SUPPLY_DEPOT — 12 ids; a third,
 *   BREACH_GATE, was authored and DROPPED in-iteration: its
 *   D-middle-hugging-rigid-flanks shape created unrepresentable D-cluster
 *   deadlocks in the visual repair) + OPEN/RICH stamp caps 5 → 6 (owner:
 *   "sectors became open areas"; GRID stays 5, MAZE 3). RNG CASCADE
 *   (ADR 0035, sanctioned): the PREF stream keeps its salt but its internal
 *   draw count/layout shifts (new pool ids × raised caps), and the entity/
 *   loot/spawn/trap/identity streams read the changed grid; the breach pass
 *   itself adds ZERO draws. Sanctioned whole-MapData golden cascade (map +
 *   lights fixtures, census re-pins).
 * - v16 (map-polish round 7 — cohesion over clutter): owner verdict — the
 *   round-6 substance was right ("destructible walls, chests, crates
 *   distribution… is good") but the ARRANGEMENT read as clutter, not cohesive
 *   design. Measured audit: wall material speckle was NOT the offender (1.2%
 *   of thin runs >2 material transitions); the offenders were FREE-ENTITY
 *   scatter and floating stamps. (1) `pickPlacement` preferred branch now
 *   picks a UNIFORM RANDOM member of preferred∩valid (the former
 *   first-match-row-major return swept every preferred placement to the
 *   sector's NW corner — arbitrary clustering). (2) Chests prefer
 *   structure-backed cells (cardinal DESTRUCTIBLE_WALL neighbour — NEW
 *   `buildStructureBackedPreferred`): a chest nests into the smashable
 *   composition (vault in a breach bay/camp/pen) instead of floating
 *   mid-field. (3) Prefab scan is two-phase: structure-FRAMING windows (≥2
 *   authored cells in the 5×5 box) stamp first, virgin open-field pockets
 *   fill last; stamp reservation ring ±1 → ±2 (compositions keep two tiles of
 *   breathing room — one tile read as a crowded bazaar blob). RNG CASCADE
 *   (ADR 0035, sanctioned): chest preferred hits now consume a draw (one per
 *   placement, same as the fallback), the PREF stream's two-phase draw order
 *   shifts, and every downstream stream reads the changed grid. Sanctioned
 *   whole-MapData golden cascade (map + lights fixtures, census re-pins).
 * - v17 (map-polish round 8 — the run-join guard): wall runs may only join
 *   within a single authored composition. The round-7 framing-first prefab
 *   scan and the beacon-keep plaza stamp could land a wall flush against a
 *   pre-existing run's SIDE, creating thin T/plus junctions the wall-art kit
 *   cannot render continuously (the destructible material has no junction
 *   frame; the run-consistency repair provably cannot settle the cell — the
 *   two arms demand one strip side, the stem the opposite). Seed 1 hit the
 *   class twice (a barricade bar over a skeleton lone-D; keep walls flush
 *   against a skeleton D-run) and the WallContinuityGate went red — a facing
 *   rule regression by the gate's own contract. New shared predicate
 *   `createsUnrenderableJunction` (own-aware, shape-scoped: 2 wall
 *   cardinals is always representable — straight or corner; 3+ is a T/plus):
 *   prefab wall cells that would sit at 3+ wall cardinals and keep segment
 *   cells that would push a foreign destructible neighbour to 3+ conflict-
 *   clip away (ruin-breach semantics, same as every other paint conflict).
 *   Zero RNG
 *   (pure paint-gate) but the grid shifts, so the downstream entity/loot/
 *   spawn/identity streams read the changed grid. Sanctioned whole-MapData
 *   golden cascade (map + lights fixtures, census re-pins); beacon pins ride
 *   unchanged (anchors never move).
 */
export const PIPELINE_VERSION = 17;
export const MIN_SPAWN_DIST = 384;

/**
 * Map-wide cap on total LEGENDARY-tier placements (chest-rarity LEGENDARY +
 * weapon-tier LEGENDARY combined) — ~10 per map (map-redesign ticket 02 /
 * DEC-003). Enforced via the shared `LegendaryBudget` across EntityPlacer
 * and LootSpawner; a denied legendary deterministically downgrades one step.
 */
export const MAX_MAP_LEGENDARY = 10;

export const BARREL_COUNT_RANGE = { min: 3, max: 5 } as const;

export const TRAP_COUNT_RANGE = { min: 2, max: 4 } as const;

export const CHEST_COUNT: Record<SectorType, number> = {
  [SectorType.GRID_ARENA]: 3,
  [SectorType.OPEN_ARENA]: 2,
  [SectorType.MAZE]: 2,
  [SectorType.RESOURCE_RICH]: 4,
};

// --- Center-hot type placement weights (T3) ---
// `generateSectorGrid` draws each sector's TYPE from one of these two tables
// depending on its ring (see `getSectorRing`). The center 2x2 (the loot brawl /
// siege endgame) trends ResourceRich + GridArena; the outer 12 sectors (landing,
// skirmish, rotation) trend OpenArena + Maze. This encodes the intentional risk
// geography from ADR 0027 — reward matches where fights happen. Tunable in T8.

/**
 * Weighted type table for the inner 2x2 center zone. ResourceRich and GridArena
 * dominate; OpenArena and Maze are rare. Drawn with `rng.weightedPick`.
 */
export const CENTER_SECTOR_WEIGHTS = [
  { item: SectorType.RESOURCE_RICH, weight: 40 },
  { item: SectorType.GRID_ARENA, weight: 40 },
  { item: SectorType.OPEN_ARENA, weight: 10 },
  { item: SectorType.MAZE, weight: 10 },
];

/**
 * Weighted type table for the outer 12-sector ring. OpenArena and Maze dominate;
 * ResourceRich and GridArena are rare. Drawn with `rng.weightedPick`.
 *
 * T8 tuning: the equal 38:38 base weights produced a ~2:1 OpenArena:Maze split
 * in the realized outer ring because the deterministic fix-up passes
 * (`enforceAllTypes`, `spreadClusters`) preferentially steal from / retype the
 * most-common outer type, which is OpenArena. Nudging the base toward Maze
 * cancels that bias. Dialed to 30:42: trims Maze frequency slightly from the
 * earlier 30:46 to lower the first-attempt MapValidator retry rate (the extra
 * Maze frequency at 46 pushed first-attempt retries up) while keeping the outer
 * ring trending OpenArena+Maze with a reasonable realized split and
 * GridArena/ResourceRich rare there. The center table and all type-presence
 * invariants are unchanged (center still trends ResourceRich+GridArena; all
 * four types appear every map; center keeps >=1 ResourceRich and >=1 GridArena).
 */
export const OUTER_SECTOR_WEIGHTS = [
  { item: SectorType.OPEN_ARENA, weight: 30 },
  { item: SectorType.MAZE, weight: 42 },
  { item: SectorType.GRID_ARENA, weight: 12 },
  { item: SectorType.RESOURCE_RICH, weight: 12 },
];

// --- MapValidator quality-gate thresholds (T1) ---
// All tunable from the seed gallery. Calibrated against current generator
// output (measured over 500 seeds) so they reject degenerate skeletons without
// causing spurious retries on today's maps. See ADR 0027 / T1.

/**
 * Minimum fraction of the composite interior (excluding the outer border ring)
 * that must be EMPTY (walkable) at validation time. Guards against over-dense
 * skeletons that would seal the map into corridors. Current maps measure
 * ~0.62-0.66 open, so 0.35 leaves a wide safety margin.
 */
export const MIN_OPEN_RATIO = 0.35;

/**
 * Minimum spawn-eligible EMPTY tiles each sector must yield. Mirrors
 * SpawnPointFinder's per-sector target so a sector that cannot host its 4
 * spawns is retried before SpawnPointFinder runs. Counted over the sector
 * interior (rows/cols 1..SECTOR_TILE_SIZE-2), matching collectCandidates.
 */
export const MIN_SPAWNS_PER_SECTOR = 4;

/**
 * Total spawns the overflow rule still needs to reach across the whole map.
 * A sector below MIN_SPAWNS_PER_SECTOR is tolerated only if the map-wide
 * eligible-tile total still meets this floor (mirrors SpawnPointFinder).
 */
export const TARGET_TOTAL_SPAWNS = SECTOR_GRID_SIZE * SECTOR_GRID_SIZE * MIN_SPAWNS_PER_SECTOR;

/**
 * Minimum loot placements every sector must be able to host (matches the
 * existing loot-density gate floor and LootSpawner's per-sector guarantee).
 */
export const MIN_LOOT_PER_SECTOR = 2;

/**
 * Manhattan spacing (in tiles) enforced between placed loot/entities by
 * EntityPlacer. Used by the loot-feasibility gate to size the required pool.
 */
export const LOOT_MIN_SPACING_TILES = 2;

/**
 * Maximum tolerated count of isolated stub walls across the whole map. A stub
 * is an INDESTRUCTIBLE_WALL interior tile whose 8 neighbours contain zero other
 * wall tiles (matches `countIsolatedStubWalls` in validatorGates). With all four
 * types now stub-free (T4–T7), a 500-seed sweep measured a max of 32 (mean ~9),
 * so this is tightened from the pre-T7 stub-era 120 to 60 (~1.9x the observed
 * max). That keeps a comfortable margin above today's output — no spurious
 * retries — while still rejecting degenerate stub-heavy skeletons.
 */
export const MAX_LONE_WALLS = 60;
