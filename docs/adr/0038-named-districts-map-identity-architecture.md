# ADR 0038: Named Districts — Seed Map Identity Architecture

## Status

Accepted — 2026-08-16. Implements the "Named Districts" map redesign:
[spec](../design/map-redesign/SPEC.md), [decision log](../design/map-redesign/decision_log.md)
(DEC-001..012 + DEC-009-ADDENDUM), tickets 01–10 (commits `7e857cb`, `3bf2831`,
`d3ed814`+`a0ee6c8`, `a27650b`, `de3e411`, `d958606`, `fd9a1f2`, `39f5411`,
`ab3391f`, `0dd537a`; ledger in
[ORCHESTRATOR.md](../design/map-redesign/ORCHESTRATOR.md)). Extends
[ADR-0027](./0027-sector-sub-variant-architecture.md) (sector sub-variants) and
[ADR-0028](./0028-macro-features-cover-patterns-refinement-pipeline.md) (macro
features / cover patterns / refinement); rides the
[ADR-0035](./0035-determinism-contract.md) determinism contract (one planned
`PIPELINE_VERSION` 2→3 bump, golden fixtures re-pinned).

## Context

The generator was *correct* — every validator gate passed, maps were
seed-deterministic — but produced places nobody remembered. The
[current-state audit](../design/map-redesign/current-state-audit.md) found:

- **No POI system.** Sectors were anonymous type instances: no names, no
  callouts, one designed landmark (the 10×10 compound ≈ 1.5% of map area) per map.
- **Visual monotony.** 4 floor sprites map-wide, one deterministic frame per
  20×20 sector, a single global wall tint `0xbbbbcc`, weather rolled
  independently of terrain.
- **Flat lighting.** The budget was spent on evenness (doorway sconces +
  dark-gap fill eliminate darkness); nothing pulled the eye.
- **Loot felt arbitrary.** `MapEntityHydrator` re-rolled chest tiers,
  discarding generator-authored tiers (the double-roll bug); ground-weapon
  tiers drifted from GDD §5.6.
- **GDD↔code drift.** Zone seeding violated the GDD's same-seed guarantee;
  the GDD described a 5-tile highway the code never shipped.

Three research digests ground the responses:
[br-map-design-principles](../research/map-redesign/br-map-design-principles.md)
(POIs are rooms; loot placement IS player distribution; hot zones; the zone as
director),
[topdown-visual-identity](../research/map-redesign/topdown-visual-identity.md)
(tint is identity; light means something; landmarks are the orientation system;
author every border), and
[competitive-procgen-maps](../research/map-redesign/competitive-procgen-maps.md)
(Spelunky's 4×4 template library; reserved slots; fairness gates; test
distributions, not fixtures).

## Decision

Every generated map is a set of **named districts** with authored identity on
deterministic layers. All identity data is generated in the **shared** map
package and rides `MapData` — the server is authoritative; the client renders
and never decides (per AGENTS.md / the audit's constraints).

### 1. Identity data lives on MapData (server-authoritative)

`MapData` gained: `poiNames[4][4]` + `macroPoiNames` (ticket 03), `sectorTiers` +
`hotSector` (02), `landmarks: LandmarkAssignment` (04), `fortress.variant` +
Citadel geometry (06), `identity: VisualIdentityAssignment` (07), `designation`
(03), and tier-keyed weather (07). Shared files: `poiNames.ts`, `lootTiers.ts`,
`landmarks.ts` + `landmarkRegistry{,Data}.ts`, `identitySheets.ts` +
`visualIdentity.ts`, `spawnFairness{,Model}.ts`, `zoneSeed.ts`,
`macro/MegaStructureCitadel.ts`. Server consumption: `LandmarkBeaconPlacer`,
`LightPlacerHierarchy`, `LightingDiscipline`, `lightHierarchyConfig`,
`SeedMapAdapter`. Client surfaces (render-only): `MinimapSectorLabels`,
`MinimapDataAdapter`, `MapBannerController` (enter-banner + map designation),
kill-feed location tags via `poiNameAt`.

### 2. RNG discipline (ADR-0035 contract)

Every new random stream is isolated, XOR-salted, and avalanche-mixed from the
map seed, with the salt documented at the stream: `TIER`/`HOTS` (lootTiers),
`NAME`/`DESG` (poiNames), `LNDM` (landmarks), `IDTY` (visualIdentity), `CITD`
(Citadel roll), `ZSEC` (zone). Identity passes cannot perturb tile/entity
streams; strip-diffs proved byte-identity of pre-existing fields at each
ticket. One planned `PIPELINE_VERSION` 2→3 bump; golden fixtures re-pinned
once.

### 3. POI naming + map designation (DEC-001, DEC-010)

Per-type prefix pools × per-sub-variant noun pools compose unique-per-map
display names that hint gameplay (Vault/Bazaar/Depot = loot; Warren/Labyrinth =
maze). Macro features get fixed-vocabulary names (The Ringroad / The
Thoroughfare / The Longcut). The designation (`RINGROAD • SPIRE • 63`) derives
from macro rolls (highway orientation × flavor feature × fortress family) plus
an arithmetic seed tag — no RNG. Client surfacing obeys the transient-line
discipline: one line, corner, combat-suppressed, fast fade.

### 4. Landmark registry + beacons (DEC-002)

Every sector reserves exactly ONE hero landmark on its skeleton's signature
structure (anchor sites exposed by the skeleton builders — Ring Fortress
sanctum, Central Monument plaza, Treasure Vault core). Compositions are
6–10-frame composites of existing atlas frames + per-type tint + scale —
baked client-side into the static layer, zero per-frame cost. The registry
holds 3–5 entries per type; exactly one per type is RARE and deliberately
under-rolled so its appearance is an event; the "signature" variant rotates by
seed band. Adjacent sectors never share a composition; landmark nounHints feed
back into the naming pass. Each hero carries a beacon (tier-colored, radius
≥512, slow pulse); junction nodes get 2–3 minor landmarks per map.

### 5. Loot-tier pyramid + hot sector (DEC-003, DEC-011)

The generator authors per-sector tiers on an isolated stream: 2–3 HOT (center
cluster guaranteed), ~8 WARM, ~5 COLD (outer ring). Tier selects per-tier
chest/weapon weight tables (`SECTOR_TIER_CHEST_WEIGHTS` /
`SECTOR_TIER_WEAPON_WEIGHTS`) — the single source of truth: the hydrator's
re-roll path was deleted (ticket 01), restoring GDD §5.6.1 intent (outer
Common-only band, center 60/25/12/3) as explicit per-tier tables (ticket 02).
One non-central WARM sector upgrades to HOT per match (visible on the
minimap). A map-wide `LegendaryBudget` (~10, chests + weapons combined)
downgrades deterministically when exhausted. The compound's loot is capped;
"bait clumps" are realized as ground-weapon clustering near cover (the shipped
interpretation recorded in ticket 10).

### 6. Fortress: Citadel variant + compound refresh (DEC-004)

Compound templates gained a fourth family (Loot Arm — chests along a corridor
spine) plus per-template beacons and names. A rare 14×14 **Citadel**
(~10–15% of seeds, isolated salt, measured 46/300) replaces the compound on
the same center seams: breakable yard ring → indestructible shell with four
3-wide gaps → vault chamber with a guaranteed epic-or-better chest + guardian
traps + a power-position pillar cluster; second breach path enforced (no
lockable sanctum; no-seal counterplay is brute-force tested). Ring Fortress
loot spots derive from the actual gap phase — never sealed. If the highway
carves the seam's vault-critical block, the highway wins (`citadelSeamBlockedByHighway`).

### 7. Lighting hierarchy (DEC-005)

Light placement is an explicit hierarchy instead of evenness: **beacons**
(tier-colored destinations) > **POI glow** (one warm pool per chest cluster) >
**route-biased sconces** (gateway → landmark travel lines) > **deliberate dark
pockets** (dark-gap fill removed in COLD sectors, threshold raised elsewhere;
player auras keep combat readable). Placement-time discipline: ≤3 active light
hues per sector viewport (violations counted into the manifest; measured 0),
value bands enforced so no static light out-brights the combat band. Server
files: `lightHierarchyConfig.ts` (data), `LightPlacerHierarchy.ts`,
`LightingDiscipline.ts`, `LandmarkBeaconPlacer.ts`.

### 8. Sector identity sheets (DEC-006)

Authored data per sector type (`identitySheets.ts`): material fiction line,
per-type wall tint (replacing global `0xbbbbcc`, mid value band), floor
tint-field families, gateway dressing spec, and weather bias (mild, fiction +
tier keyed, ±15 weight points). The generated half (`visualIdentity.ts`,
`IDTY` stream) paints 2–3 macro tint blobs per sector with ±1-tile jittered
non-axis borders, and composes gateway dressings at all 24 corridor openings
as pure geometry (zero RNG). Everything is bake-time-only on the client.
Grayscale/desaturation double-coding is an asserted acceptance gate.

### 9. Skeleton variety (DEC-007)

Each of the 16 base skeletons gained 3–6 probabilistic sub-blocks at
{25, 33, 50}% presence dice (appended after the base draw — golden-fixture
regeneration is a single planned bump); asymmetric skeletons gain seeded
horizontal mirroring with 4-gate post-transform re-validation (revert on
failure); one new purpose-typed skeleton per type (Plaza Crossroads, Airstrip,
Sewer Grid, Bank Row) grows the library to 5/type with landmark anchors.
Sub-variant selection's salt had an avalanche bug (one index unreachable)
— fixed in ticket 08.

### 10. Zone determinism + landmark-biased finale (DEC-008)

`deriveZoneSeed(mapSeed)` (ZSEC salt, avalanche-mixed) replaced
`Date.now()` in `GameOrchestratorInit` — the GDD's "Zone center randomization
uses the same seed" contract (the sentence lives in **§5.3 → Seed
Generation**; see the drift audit below) is now true in code, proven by a
Date.now-frozen replay test. Phase 6 (the last center selection; phase 7/OT
freezes at its target) scores 12 valid candidates by proximity to landmark
anchors and picks weighted-random — a decisive but non-forced pull. Phases
2–5 kept the legacy draw mechanics verbatim.

### 11. Fairness gates + audit manifest (DEC-009 + DEC-009-ADDENDUM)

`MapValidator` gained a per-spawn value-vector equity gate (chamfer distance
fields to nearest weapon/chest/clump + BFS path-to-HOT; per-sector median
bound ≤1.3× — the map-wide reading was measured unsatisfiable by design
geography; see the addendum) with RNG-free local repair from the sector's
eligible pool. A 50-seed distribution suite (5-seed CI form) asserts tier
ratios, landmark bands, adjacency uniqueness, hot-sector rotation, spawn
equity, and Citadel frequency. Every generation logs a compact manifest
(tiers, landmarks, hot sector, macro shape, repairs) into the benchmark JSON —
the evaluation dashboard is the bench report.

## Consequences

**Positive:**

- Maps are describable: 16 named districts, hero landmarks with tier-colored
  beacons, a per-match hot sector, and a designation line — the "fanfic test"
  from research is now designable and regression-tested.
- Identity is **data**: name pools, landmark registry, tier tables, identity
  sheets, and light hierarchy params are constants — tuning never touches
  algorithms (spec user story 44).
- Character is **regression-tested**, not eyeballed: seed-sweep distribution
  assertions + the benchmark manifest catch drift toward blandness or
  monopoly the way golden fixtures catch RNG drift.
- The three sanctioned GDD↔code drifts are closed: weapon/chest tiers
  (§5.6.1, tickets 01–02), zone seeding (§5.3 Seed Generation, ticket 09),
  highway width (§5.3.2, this ticket's amendment).

**Negative / honest:**

- Cost: the map payload grew (names, tier grids, landmark descriptors,
  identity fields) — small, one-shot `mapData` fields, but no longer free.
- Determinism coupling: every identity stream must stay isolated and
  salt-documented; an unsalted draw anywhere breaks fixture pinning silently
  until the next regeneration diff. The manifest records stream usage for
  audit.
- Residual drift remains in GDD §5.6's entity-count tables (chest/trap counts,
  crate power-up split) — pre-existing balance-book drift, enumerated in the
  audit below and deliberately **not** fixed here (they are balance values, not
  this effort's sanctioned edits).
- `Highway.ts`'s header comment still says "Carve a 5-tile-wide highway strip"
  while the constant is `HIGHWAY_WIDTH = 3` — a stale code comment (behavior
  is correct and matches the amended GDD); left untouched by this docs-only
  reconciliation.

## Alternatives Considered

1. **Static fixed names / client-generated identity** — rejected: kills
   per-seed variety and violates server-authoritative (DEC-001; audit
   constraint 2).
2. **Keep even lighting, add beacons on top** — rejected: beacons need
   darkness to read against; evenness was the diagnosed disease (DEC-005).
3. **Fog-of-war / LOS shadows** (SAR-style) — deferred as an engine-scale
   feature (DEC-012; open question 4); the lighting hierarchy is the v1 mood
   substitute.
4. **WFC / constraint-solver layouts** — rejected as out of proportion;
   probabilistic tiles + mirroring multiply the existing library cheaply
   (DEC-007).
5. **Always-Citadel** — rejected: rarity is the emotional budget (DEC-004).
6. **Re-enable `isSpawnPointValid` filtering for fairness** — rejected
   (over-filtering history); the equity gate achieves the goal at the
   generation seam instead (DEC-011, DEC-009).

## Cross-Document Drift Audit (GDD §5 map systems — 2026-08-16)

The effort's final gate: grep/read-level verification that GDD §5.3/§5.4/§5.6
statements match code behavior. Findings are **listed**, not silently fixed;
the only reconciliation shipped with this ADR is the sanctioned §5.3.2 highway
amendment (+ the same statement in the glossary), per DEC-011.

| # | GDD statement | Code evidence | Verdict |
|---|---|---|---|
| 1 | §5.3.2 Highway "5-tile-wide… center 3 tiles pure EMPTY" | `Highway.ts`: `HIGHWAY_WIDTH = 3` (1 fast-lane tile + 2 shoulders), `SHOULDER_CRATE_CHANCE = 0.3`, jog step `nextInt(-2, 2)` (inclusive), spans all 4 sectors on its axis (H/V only) | **Was drift — AMENDED this ticket** (3-tile + shoulder crates ≈ 5-tile footprint; DEC-011). GLOSSARY "Highway" entry reconciled identically. ADR-0028's historical "5-tile" description left as a historical record, superseded here |
| 2 | §5.3 "Seed Generation": "Zone center randomization uses the same seed" | `zoneSeed.ts` `deriveZoneSeed` (ZSEC salt) wired in `GameOrchestratorInit`; Date.now-frozen replay test (ticket 09) | **Matches code** (since ticket 09). Note: SPEC #14 / DEC-008 / the audit cite this sentence as "§5.4"; it actually lives in §5.3 → Seed Generation (§5.4 is Tile Types). Design docs left as-is (historical); this row is the corrected anchor |
| 3 | §5.4 Tile Types table (IDs 0–8) | `enums/TileType.ts` — IDs identical | **Matches.** Minor: enum also defines `DOOR_CLOSED = 5` — never emitted by the seed generator (TMX/demo-map parse path only, treated as solid by `GameMatchGrid`); absent from the GDD table. Listed, cosmetic |
| 4 | §5.6 Chest Count: 2/1/1/3 per type, "~16-24 total" | `map/constants.ts` `CHEST_COUNT` = GRID 3 / OPEN 2 / MAZE 2 / RR 4, **plus** `LootSpawner.CHEST_COUNT = 32` distributed loot entities (~45% chests, RR +1) | **Pre-existing drift** (constants predate the redesign). Realized chest totals ≈ 46–78, far above "~16-24". Listed — reconciling is a balance decision, not a docs patch |
| 5 | §5.6 Trap Count: "1-3 per sector" | `map/constants.ts` `TRAP_COUNT_RANGE = {min: 2, max: 4}` | **Pre-existing drift.** Listed |
| 6 | §5.6 Barrel Count: "3-5 per sector" | `map/constants.ts` `BARREL_COUNT_RANGE = {min: 3, max: 5}` | **Matches** |
| 7 | §5.6 Crate drop table (60% drop; 70/30 split; tiers 80/15/4/1; power-up 50/25/25) | `constants/loot-weights.ts`: `WEAPON_DROP_CHANCE 0.6` ✓, `WEAPON_LOOT_CHANCE 0.7` ✓, `CRATE_TIER_WEIGHTS 80/15/4/1` ✓; `CRATE_LOOT.POWERUP_WEIGHTS` = equal thirds (50/50/50) | **Partial drift**: power-up split in code is uniform thirds, GDD says 50/25/25. Listed |
| 8 | §5.6 "Crate Density (per sector type)" table (25/10/5/15%) | No `EntityPlacer` crate scatter exists (removed per §5.3.3); those percentages survive as the per-type skeleton-owned breakable-cover budgets (§5.2 sub-variant descriptions use the same 25/10/5/15) | **Interpretation note**: the table reads as cover budget, not scatter; counts approximate. No code change implied |
| 9 | §5.6.1 per-tier weapon/chest tables; RR +2 spawns; "~48-70 total"; legendary cap ~10 | `constants/loot-weights.ts` `SECTOR_TIER_*` tables match the GDD table values exactly; `EntityPlacer` `nextInt(3,4)` (+2 RR); `MAX_MAP_LEGENDARY = 10` via `LegendaryBudget` | **Matches** (amended by ticket 02 — the reconciliation of record) |
| 10 | §5.3 corridors: exactly 1 centered 3-tile opening per shared interior edge | `SectorConnector.ts`: offsets `[9,10,11]`, `width: 3`, one per shared interior edge, edge sectors excluded | **Matches §5.3.** Adjacent note: §5.2's Revamp-2 text claims "1–3 varied 3-wide openings per edge" — that variability never shipped; the connector was explicitly frozen (recorded in ADR-0028). §5.2's claim remains aspirational wording; listed |
| 11 | §5.3 spawns: 64 total, 4/sector, ≥3-tile spacing, overflow rule | `SpawnPointFinder`: `TARGET_SPAWNS_PER_SECTOR = 4`, `MIN_SPAWN_DIST = 384` (3×128px), overflow to fewest-spawn neighbors | **Matches.** Ticket 10's equity gate is an addition (DEC-009), not drift |
| 12 | §5.3 validity: 80% flood-fill, ≥64 spawns, 10 retries, skeleton gates (≥35% open, ≥4 spawn tiles/sector, loot feasibility, ≤60 stubs) | `MapValidator.ts` (`ratio < 0.8` fails), `map/constants.ts` (`MIN_OPEN_RATIO 0.35`, `MIN_SPAWNS_PER_SECTOR 4`, `MIN_LOOT_PER_SECTOR 2`, `MAX_LONE_WALLS 60`) | **Matches** |

**Net:** within the effort's sanctioned scope (tiers, zone seeding, highway)
no GDD↔code drift remains. The residual findings (rows 3–5, 7, 10) are
pre-existing entity-count/balance-book drift inside §5.6 (and one §5.2 wording
claim), enumerated here for a future reconciliation ticket; none were silently
changed.

## References

- [SPEC — Named Districts](../design/map-redesign/SPEC.md) — problem, user
  stories, implementation + testing decisions.
- [Decision log](../design/map-redesign/decision_log.md) — DEC-001..012 +
  DEC-009-ADDENDUM (rationale + dissent resolutions).
- [Current-state audit](../design/map-redesign/current-state-audit.md) — the
  pre-redesign factual baseline (every drift this ADR closes was found there).
- Research digests:
  [br-map-design-principles](../research/map-redesign/br-map-design-principles.md),
  [topdown-visual-identity](../research/map-redesign/topdown-visual-identity.md),
  [competitive-procgen-maps](../research/map-redesign/competitive-procgen-maps.md).
- [ORCHESTRATOR.md](../design/map-redesign/ORCHESTRATOR.md) — ticket ledger
  (01–10 evidence notes).
- [ADR-0027](./0027-sector-sub-variant-architecture.md),
  [ADR-0028](./0028-macro-features-cover-patterns-refinement-pipeline.md),
  [ADR-0035](./0035-determinism-contract.md).
