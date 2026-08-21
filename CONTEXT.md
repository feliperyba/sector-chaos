# Project Context

## Documents

- [Docs index](docs/README.md) — the full documentation suite
- [GDD](docs/GDD.md) — Game design document (business-rules source of truth)
- [Architecture](docs/architecture.md) — codemap: packages, relationships, invariants (+ per-system pages in [docs/architecture/](docs/architecture/netcode.md))
- [Navigation](docs/navigation.md) — codebase tour by architectural role
- [Gotchas](docs/gotchas.md) — known traps
- [Glossary](docs/glossary.md) — domain language (incl. bot-ai-v2 + Named Districts vocab)
- [Performance](docs/performance.md) — enforced budgets + measurement
- [File Constraints](docs/file-constraints.md) — file rules
- [Anti-Patterns](docs/anti-patterns.md) — forbidden patterns
- [Bot AI v2 design docs](docs/design/bot-ai-v2/SPEC.md) — SPEC, orchestrator ledger, decision log (DEC-001..014), open questions
- [Bot AI v2 research](docs/research/bot-ai-v2/game-ai-architecture.md) — design-patterns / current-state-audit / game-AI-architecture digests
- [Map Redesign design docs](docs/design/map-redesign/SPEC.md) — Named Districts spec, decision log (DEC-001..012), current-state audit, orchestrator ledger
- [Map Redesign research](docs/research/map-redesign/br-map-design-principles.md) — BR map design / top-down visual identity / competitive procgen digests
- ADRs: `docs/adr/` — 38 records (0001, 0003–0039; includes ADR-0039 bot-ai-v2)

## Stack

- Server: Colyseus 0.17, TypeScript, 60 tick/s
- Client: Phaser 4, TypeScript, Vite
- Shared: Constants, types, configs, animation, collision, map generation

## Balance Canon (owner-tuned 2026-08-20)

The tuned `packages/shared/src/constants/*.ts` values are canon — GDD + code mirror them, never the reverse. Zone pacing is single-sourced: `ZONE_PHASE_x_DURATION/_RADIUS` scalars are the only tuning surface; the `PHASES[]` table and the `MatchPhaseStateMachine` band thresholds derive from them (a tuning pass edits scalars only). Zone damage 8/15 per tick, warning 10s, phases 60/45/45/45/30/30 (= 255s shrink timeline, sudden death ~255s); dash cooldown 2.5s; pickup radius 72; speed boost ×1.75/20s; spike 25/0.5s; fire trap has 15 instant damage.

## Map Identity — Named Districts (ADR 0038)

Every generated map is a set of named districts. All identity data is authored by shared generation, rides `MapData`, and is consumed server-side + baked client-side (server-authoritative; zero per-frame client cost). See ADR 0038 for the full architecture and cross-document drift audit.

- **POI naming + designation** — `packages/shared/src/map/poiNames.ts`: per-type prefix × per-sub-variant noun pools compose unique per-map sector names; macro features get fixed-vocabulary names; the designation (`RINGROAD • SPIRE • 63`) derives from macro rolls. Client surfaces: minimap labels (current + adjacent), transient enter-banner, kill-feed location tags, results line.
- **Landmark registry** — `landmarkRegistry{,Data}.ts` + `landmarks.ts`: exactly one hero landmark per sector on its skeleton's anchor site (6–10-frame baked composites, one RARE variant under-rolled per type, signature rotates by seed band, adjacent sectors never share a composition); 2–3 minor landmarks at junction nodes; each hero carries a tier-colored beacon.
- **Tier pyramid** — `lootTiers.ts` + `constants/loot-weights.ts`: seed-authored HOT (2–3, center cluster) / WARM (~8) / COLD (~5 outer) per-sector tiers drive chest + ground-weapon tables (single source of truth — the hydrator re-roll is deleted); per-match hot sector (one WARM → HOT, minimap-marked); map-wide LegendaryBudget (~10). GDD §5.6.1 is the table of record.
- **Identity sheets** — `identitySheets.ts` (authored data: material fiction, per-type wall tints, floor-field families, gateway spec, weather bias) + `visualIdentity.ts` (generated: 2–3 seeded macro tint fields/sector with jittered borders, 24 pure-geometry gateway dressings). Bake-time only; grayscale double-coding is an asserted gate.
- **Lighting hierarchy** — server `infrastructure/map/lightHierarchyConfig.ts` / `LightPlacerHierarchy.ts` / `LightingDiscipline.ts` / `LandmarkBeaconPlacer.ts`: beacons > POI glow > route-biased sconces > deliberate dark pockets (COLD gap-fill removed; player auras keep combat readable); ≤3 light hues per sector viewport; combat band stays supreme.
- **Fairness gates + manifest** — `spawnFairness{,Model}.ts` (MapValidator gate): per-spawn value vector (weapon/chest/clump proximity + path-to-HOT) bounded against the per-sector median (≤1.3×, DEC-009-ADDENDUM) with RNG-free repair; 50-seed distribution sweep + 5-seed CI form; generation manifest (tiers, landmarks, hot sector, repairs) rides the benchmark JSON.
- Related: rare 14×14 Citadel fortress variant (`macro/MegaStructureCitadel.ts`, ~10–15% of seeds), skeleton variety (probabilistic blocks + mirroring + 5 skeletons/type, `sectors/`), zone determinism + landmark-biased finale (`zoneSeed.ts`, phase 6 only). All new streams are isolated XOR-salted (ADR 0035; salts documented at each stream).

## Quick Links

- ADRs: `docs/adr/`
- AGENTS.md: Agent instructions
