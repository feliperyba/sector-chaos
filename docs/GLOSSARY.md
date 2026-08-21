# Glossary

> Moved from `CONTEXT.md`. Domain language for Sector Chaos Neo.

## Netcode

**Prediction**: Client-side forward simulation of player movement at fixed 60Hz. Runs ahead of server, stores predicted positions in the input buffer for later comparison. _Avoid_: client simulation, local physics

**Reconciliation**: Process of correcting the client's predicted position against the server's authoritative state. Starts from server position + velocity, replays unacked inputs forward. _Avoid_: resimulation, correction

**renderOffset**: Vector separating visual sprite position from simulation position. Absorbs reconciliation errors and decays exponentially, keeping visuals smooth while simulation snaps to truth. _Avoid_: visual offset, smooth offset

**Adaptive Snap**: renderOffset behavior where large errors (≥8px vector magnitude) teleport immediately and small errors decay smoothly. Uses `Math.hypot(offsetX, offsetY)` — magnitude-based, not per-axis. Industry standard (Overwatch, Valorant). **IMPLEMENTED** (ADR-0014 complete) — errors <1px are ignored, 1-8px are smoothed via correctionOffset with exponential decay at rate 60, ≥8px snap immediately (correctionOffset cleared). _Avoid_: two-tier decay, snap threshold

**Deduplication**: Server InputQueue behavior where only the latest MOVE input per (playerId, action) pair survives per tick. Causes ~1px prediction drift per burst — acceptable with 60Hz patches. _Avoid_: input merging, input coalescing

**4-Corner Check**: Client collision that tests all four corners of the 96×96 hitbox AABB instead of a single center point. Reduces wall-slide drift from ~10px to ~2-3px. _Avoid_: corner collision, box check

**PATCH_RATE**: Frequency (Hz) at which the server sends state deltas to clients. Currently 30Hz, increasing to 60Hz. Separate from TICK*RATE (simulation frequency). \_Avoid*: sync rate, update rate

**RTT Observability**: Exposing server-computed round-trip time to the client as a schema field. No behavior change — enables future prediction tuning. _Avoid_: ping display, latency awareness

**TelemetrySampler**: Zero-allocation per-frame scalar collector for netcode metrics. Writes into a fixed-size Float64Array ring (TelemetryRing). Receives direct references (localPos, renderOffset, rtt) and an out-param getServerPos() — never calls getState(). Read by the in-game overlay and DebugBridge snapshot queries. _Avoid_: GameProbe, metrics collector, monitor

**TelemetryRing**: Float64Array ring buffer storing per-frame telemetry scalars (prediction error, render offset magnitude, velocity, reconciliation counts). 600 frames, stride 13. Range reads for snapshot without allocation. _Avoid_: sample buffer, metrics ring

**ReconciliationLog**: Fixed-size ring buffer (100 entries) recording every reconciliation event with tick, sequence, server/local positions, correction vector, and wasCorrected flag. Pushed from ClientStateBridge.onPlayerChange(). Queried by DebugBridge for Playwright assertions. _Avoid_: recon history, correction log

**DebugBridge**: Lazy Playwright-facing API for full state snapshots, prediction buffer inspection, reconciliation log, sprite state query, and screenshots. Owns TelemetrySampler, ReconciliationLog, RuntimeGameController. Only allocates when tests poll, not every frame. _Avoid_: debug controller, game inspector

**InputCollector Injection**: Methods (injectFrame, injectContinuous, clearInjection) on InputCollector that queue/override keyboard input for deterministic test control. Injected frames run through the full prediction pipeline. _Avoid_: test input, fake input

## Combat Collision

**Hurtbox**: Axis-aligned 80×80 px square centered on the player position. Sub-visual (player hitbox is 96×96 for movement, hurtbox is 80×80 for damage). Configurable via `COMBAT.HURTBOX_SIZE`. Does NOT rotate with facing — symmetric in all directions, no directional inconsistency during strafing. Used for all SAT collision tests (melee hitbox vs player, projectile hitbox vs player). _Avoid_: damage hitbox, player damage box, core hitbox

**Hitbox**: Temporary convex polygon spawned during attack active frames. Positioned relative to attacker, oriented by `facingAngle`. Shape varies by attack type (ARC sector polygon, LINE thin rectangle, projectile geometry). Lives for N ticks, hits each hurtbox once max. Tested against hurtboxes via SAT. _Avoid_: attack shape, swing hitbox, weapon hitbox

**Active Frames**: The tick window during which a hitbox polygon exists and can register hits. Currently 1 tick (instantaneous): hitbox is spawned at `completeWindup()`, tested once against all hurtboxes, then destroyed. No per-entity hit tracking needed. Multi-tick active frames can be layered on later per-weapon-type as a balance tuning knob. _Avoid_: hitbox lifetime, hitbox duration, attack frames

**Sector Polygon**: 7-vertex convex polygon representing an ARC melee hitbox. Two vertices at inner arc (facing ± arcAngle/2 at radius HURTBOX*SIZE/2), five vertices along outer arc (facing ± arcAngle/2, ±arcAngle/4, and facing at radius range + HURTBOX_SIZE/2). Inner radius = 40px (hurtbox edge, prevents self-hit). Outer radius = weapon range + 40px (range measured from hurtbox edge per GDD intent). Arc angle from weapon config `arcAngle` property. Built by `buildSectorPolygon()` in `shared/src/math/`. \_Avoid*: arc shape, arc polygon, pie slice

**LINE Rectangle**: 4-vertex rotated rectangle representing a LINE melee hitbox. Width = 20px (LINE*ATTACK_WIDTH), length = weapon range, rotated by `facingAngle`. Start offset configurable per weapon via `lineStartOffset` in `WeaponConfig.specialProperties` (default 40px = hurtbox edge). Creates a close-range dead zone that differentiates thrust weapons from arc weapons. Built by `buildRotatedRect()` in `shared/src/math/`. \_Avoid*: thrust hitbox, spear rectangle

**Two-Stage Occlusion**: Wall blocking check for SAT melee hitboxes. Stage 1: DDA center-to-center fast reject (cheap, catches most blocked hits). Stage 2: if DDA reports a wall, SAT test the wall tile's AABB against the hitbox polygon. If wall IS in the hitbox polygon, it genuinely blocks. If wall is NOT in the hitbox polygon, it was a false center-line occlusion — hit lands. Fixes corner-clipping where hitbox extends around a wall but center-to-center ray clips it. _Avoid_: smart occlusion, polygon occlusion, SAT occlusion

**Broad Phase Range**: Distance used for candidate entity filtering before SAT narrow phase. Must be `weapon range + HURTBOX_SIZE/2` to account for hurtbox size — entities at range + 40px from center can still have their hurtbox corner overlap the hitbox polygon. Current code has a bug where broad phase queries at `range` but narrow phase tests at `range + 48`, making the extension useless. Fixed in SAT rewrite. _Avoid_: query range, filter range

**LINE Start Offset**: Distance from attacker center where the LINE hitbox rectangle begins. Configurable per weapon via `lineStartOffset` in `WeaponConfig.specialProperties`. Default 40px (hurtbox edge). Creates a close-range dead zone: targets within 40px cannot be hit by thrusts, encouraging weapon switching (arc for close, thrust for mid). _Avoid_: thrust start, line inner radius

**Three-Path Collision**: Projectile tile collision approach: (1) skip EMPTY/EXIT tiles, (2) collider SAT when tile has collider shapes, (3) fallback full-tile AABB when no collider metadata. Matches `CollisionService.resolveEnriched()`. Replaces enum-based `solidTileTypes` gating. _Avoid_: collider fallback, hybrid collision

**isBlockingTile**: Shared allowlist function determining which tiles block DDA raycasts and projectile collision. Returns `true` for any tile that is not EMPTY and not EXIT. New tile types block by default. Single source of truth — replaces duplicated `isWallTile` blocklists in melee handlers. _Avoid_: solid tile check, wall tile check

**isRayBlocked**: Shared utility wrapping `DDARaycast.cast()` with `isBlockingTile`. Tests whether any blocking tile lies on the ray between origin and target. Optional `excludeGridPos` parameter excludes a specific grid cell (used for destructible self-occlusion). Used by melee ARC occlusion and destructible hit resolution. _Avoid_: line of sight check, visibility check, occlusion test

**DDA Early-Exit**: `DDARaycast.cast()` returns first solid tile hit (`RaycastHit | null`) instead of collecting all hits. All consumers (melee handlers, destructible occlusion) only need the first blocking tile. _Avoid_: raycast first hit, single-hit raycast

**Melee Destructible Occlusion**: Per-destructible DDA raycast from player origin to destructible position. Each destructible's own grid cell excluded from the solid check so it does not self-occlude. A destructible between the player and another destructible occludes the farther one. _Avoid_: destructible wall check, destructible LOS

**LINE Effective Range**: Wall-clipped maximum range for LINE melee attacks. DDA raycast along facing direction finds first blocking tile, clips `effectiveRange`. Both player hits (segment geometry) and destructible hits (distance cap) use this clipped range. The entire LINE attack stops at the first wall — center and edges. _Avoid_: attack range, clipped range

## Weapon Stats

**destructibleDamage**: Per-weapon integer stat (range 2–10) governing HP removed from destructibles (walls, crates, barrels) per hit. Independent of the PvP `damage` stat and NOT scaled by weapon tier — it encodes weapon-class identity (Hammer = wall-breaker, Spear = anti-personnel specialist), not progression. Read uniformly by melee, thrown, and arrow damage paths. Barrels are the exception (juice-pass-1, ticket 01): any weapon deals exactly 1 HP per hit to a barrel — see **Primed Barrel**; the stat governs walls and crates. _Avoid_: structure damage, wall damage, PvE damage, material damage

**durabilityMultiplier**: Per-weapon-category multiplier on `DURABILITY_BY_TIER` that adjusts baseline durability for defensive/projectile categories (shields 1.5–2.0×, bows 1.5×, standard melee 1.0× default). Always multiplied by the tier base — never a flat override. Replaces the former `durabilityOverride` which was a flat number that ignored tier entirely, causing rare weapons to have LESS durability than common ones. _Avoid_: durability override, durability bonus, durability scale

**Anti-Material Axis**: The design dimension along which weapons differ in effectiveness vs destructibles. Heavy ARC weapons (Hammer, Double Axe, Crossbow, Large Shield) sit at the top (10 dmg, one-shot walls at 10 HP); medium ARC weapons in the middle (4–7 dmg, 2–3 wall hits); piercing LINE, light ARC, ranged, and shields sit at the bottom (2–4 dmg, 3–5 wall hits). Fists define the floor at 2 dmg (5 wall hits) — no picked-up weapon may tie or fall below this. _Avoid_: weapon weight class, structure effectiveness

## Barrels

**Primed Barrel**: A barrel that survived its first hit. Every melee swing, thrown-weapon collision, and arrow deals exactly 1 HP to a barrel regardless of weapon — so any first hit primes, and any second hit detonates immediately; explosions destroy barrels outright in one hit. A primed barrel runs the Fuse. Only barrels prime — never crates, walls, iron, or light props — and any barrel spawned later in a match spawns unprimed. _Avoid_: damaged barrel, lit barrel, burning barrel (that is the visual, not the state)

**Fuse**: The 5-second window after a barrel primes, ending in an auto-explosion identical to any other barrel explosion (50 damage, 8 rays, 256px, chain-capable). Server-authoritative and tick-based. _Avoid_: timer, detonation delay, burn duration

## Map Generation Visuals

**Demo Path**: `TmxParser` loading the hand-authored `demo_map.tmx`. Has NO autotiler — a human placed every tile + flip in Tiled. The visual/collision reference target for the seed path. _Avoid_: test map, hand map

**Seed Path**: `SeedMapAdapter` procedurally generating a map from a seed. Shares the exact render + collision pipeline as the Demo Path (both emit `EnrichedMapData` of `{spriteId, rotation, flip}` + atlas colliders). Only the tile+transform _decision_ differs (autotiler vs human). _Avoid_: random map, generated map

**Seed Gallery**: The seed-map preview harness — the primary quality instrument for human variety/coherence judgement (see ADR 0027). There are **two galleries**: a **structural** gallery (shared `map-gallery`, colours cells by `TileType`) for layout inspection, and a **sprite-faithful** gallery (server `sprite-gallery`, runs the full `SeedMapAdapter` pipeline and colours cells by resolved sprite `imagePath`, 49+ distinct colours) for art-fidelity inspection. The sprite-faithful gallery was added in Revamp 2 (R0) to expose the art variety the structural TileType gallery hid. _Avoid_: map preview, seed viewer

**Sector Floor Theme**: The floor sprite painted across a sector, now determined by the sector's **type-coded Biome** (one fixed signature sprite per type, `biomeConfig.ts`), not a per-instance random/seeded pick. The floor layer is a COMPLETE underlay — every grid cell gets a floor sprite, including cells that also hold a wall or entity — so transparent wall/entity pixels reveal floor, not void. (The demo paints floor in all 484 cells; the seed path currently leaves a hole under every non-EMPTY tile, which is the layering bug, tracked separately.) The floor layer itself stays sterile-clean (no per-tile speckle) — visual variety comes from Decorative Accents, a separate overlay. _Avoid_: floor variant, floor noise

**Biome**: The type-coded visual identity of a sector — a signature floor sprite plus a curated decorative-accent set — that signals the sector's Gameplay Purpose at a glance (GridArena=industrial crate-yard, OpenArena=open plaza, Maze=overgrown ruins, ResourceRich=treasure depot). As shipped (`biomeConfig.ts`) the floor assignment is strict 1:1: exactly one distinct solid floor sprite per type — GridArena=`tiles_center`, OpenArena=`grass`, Maze=`tiles`, ResourceRich=`tile` — with `wood` reserved for edge framing only, plus a per-type collider-free EMPTY-type Decorative Accent set on its own RNG salt. One biome per sector type; it drives the (formerly type-independent) Sector Floor Theme. _Avoid_: theme, skin, tileset.

**Decorative Accent**: Sparse, non-colliding overlay tiles (plants, puddles, cracks, scatter, plus Revamp 2 atmospheric tiles `stairs_down` / `water` / `stairs_down_detail`) placed per sector instance for visual freshness. Purely cosmetic — never affects collision, movement, or gameplay, and distinct from the clean floor underlay. Since Revamp 2 (R4) accents **cluster near structures** rather than scatter uniformly — see Structure-Adjacent Decoration. _Avoid_: prop, speckle, detail tile.

**Structure-Adjacent Decoration**: Revamp 2 (R4) placement rule by which decorative accents land preferentially (~70%, `CLUSTER_PREFERRED_RATIO = 7`) on EMPTY cells with ≥1 non-EMPTY cardinal neighbour, leaving ~30% as free scatter — so set dressing reads as natural hugging of walls/pillars/cover rather than uniform random noise (`FloorSpriteSelector.paintAccentPass`). _Avoid_: clustered prop, wall-hugging deco

**Layer Compositing**: The map renders as three stacked tile layers — `floor` (dense underlay) → `map_border_walls` → `interactive_layer` (entities rendered dynamically by EntityRenderer) — matching the demo TMX. A cell can carry content in multiple layers simultaneously; lower layers must be painted even when an upper layer also fills that cell. _Avoid_: single-layer render, flatten layers

**Edge Floor**: A distinct floor sprite (`wood`) painted under the outer map ring and sector-border walls, framing each room the way the demo's hand-placed `wood` border does. Distinct from the per-sector interior theme floor (`tiles`). _Avoid_: border tile, wall floor

**Corridor Theme**: The `path` (horizontal runs) / `track` (vertical runs) floor tiles applied to 3-wide corridor cells (Revamp 2 R1), distinguishing connecting corridors from sector interiors and the `wood` edge border. A pure positional rule — no RNG (`FloorSpriteSelector`). _Avoid_: corridor floor, path tile

**Plaza Accent**: A distinct solid floor sprite applied to each sector's central 4×4 region (local rows/cols 8–11) in Revamp 2 (R1), creating a visual focal point different from the biome floor (`FloorSpriteSelector.resolvePlazaAccents`). _Avoid_: centre tile, sector centre floor

**Wall Autotiling**: Code-side choice of a wall sprite + rotation/flip from an 8-neighbour wall/open mask, oriented toward the open (floor) side, using rounded inner-corner pieces (`inner_round`/`inner_diagonal`/`wall_corner`) — reproducing what a Tiled author places by hand. Validated against the Demo Path. The classifier/orientation are deterministic, not random. The chosen sprite then comes from a **collider-compatible variety pool** per wall role (see Wall Variety Pool), no longer a single map-wide material. _Avoid_: wall orientation, wall fitting, wall variant

**Wall Variety Pool**: The set of collider-compatible sprites a classified wall cell can draw, picked deterministically per cell (`cellHash(row,col,seed) % pool.length`, `wallSpriteResolver.ts`). All sprites in a role's pool share the same collider shape so the rendered sprite IS its collider — variety never breaks faithful-enriched collision. Replaces the old "ONE material map-wide" rule. _Avoid_: wall material, single tileset

**Wall Object Art**: A **free-standing** wall cell — ≤1 wall-like _cardinal_ neighbour (isolated pillar or 1-connection stub) — resolves to a full-tile OBJECT sprite (`coffin`/`crate_small` indestructible, `crate`/`tree`/`planks` destructible) instead of a lone autotiled bar, so it reads as a self-contained prop and carries a full-tile collider. Connected runs/corners/borders keep bar/corner art. The grid TileType is unchanged; only the rendered+collided sprite differs (`wallSpriteResolver.ts`). _Avoid_: pillar sprite, lone wall, stub wall

**Faithful Enriched Collision**: Wall collision derives _solely_ from the chosen sprite's `env.tsx` colliders transformed by the tile's rotation/flip — NO full-tile fallback. Thin-wall face-only collision (a 1-tile maze wall blocking only its top strip) is accepted by design for **connected** thin runs/fences, because the Demo Path does exactly this. **Free-standing isolated/stub walls** are the exception: they render as full-tile OBJECT art (see Wall Object Art) and so carry full-tile colliders — an emergent effect of the same mechanism (their object sprite's own collider spans the tile), not a new fallback path. ADR 0023's "intended, don't fix it" stance is scoped to connected runs accordingly. _Avoid_: full-tile fallback, solid-wall override

## Sector Layout Generation

**Sector Type**: One of the four fixed procedural archetypes a 20×20 sector is generated as — GridArena, OpenArena, Maze, ResourceRich (`SectorType` enum). Each type carries ONE fixed Gameplay Purpose, one shared balance budget (crate/barrel density, chest/loot/spawn counts), and one type-coded Biome; only its spatial layout varies between instances. Type **placement is center-hot** (`MapGenerator.generateSectorGrid` + `CENTER_SECTOR_WEIGHTS`/`OUTER_SECTOR_WEIGHTS`): the inner 2×2 trends ResourceRich + GridArena, the outer 12-sector ring trends OpenArena + Maze; all four types appear every map, and the center is guaranteed ≥1 ResourceRich and ≥1 GridArena. This replaced the old random pick + corner-pinned minimum-types + 2-consecutive cap. _Avoid_: sector family, sector kind.

**Sub-variant**: A distinct procedural layout skeleton within a sector type (exactly **4 per type, 16 total**). All sub-variants of a type deliver the same Gameplay Purpose and balance budget; they differ only in structural shape. Selected per sector instance from the map seed, with no two orthogonally-adjacent sectors sharing the same sub-variant id (`subVariantSelector.ts`). The shipped sets (`subVariants.ts`): GridArena = Classic Lattice / Ring Fortress / Broken Grid / Lane Corridors; OpenArena = Corner Bastions / Central Monument / Scatter Cover / Diagonal Spurs; Maze = Loose Labyrinth / Chambers & Halls / Breakable Warren / Concentric Spiral; ResourceRich = Treasure Vault / Loot Bazaar / Exposed Cache / Supply Depot. _Avoid_: family, template, preset, room layout.

**Skeleton**: The wall/floor structural shape a sub-variant lays down BEFORE entities, loot, and floor theming are applied — the layer that makes two same-type sectors look different. Per-type shipped rules (ADR 0027): GridArena uses a PERSISTENT INDESTRUCTIBLE*WALL pillar skeleton with breakable fill (never erodes to an open box); OpenArena is low-density and dash-friendly with cover kept off the border; Maze is ASYMMETRIC (no 4-fold mirror), MIXED-WIDTH (2-wide arteries + 1-wide branches), LOOPED, with breakable `wall_secret` shortcuts; ResourceRich frames loot in breakable cover (no lone indestructible stub walls) and reports cache cells via `SectorData.lootSpots` so EntityPlacer drops chests/weapons inside the structure. \_Avoid*: blueprint, layout.

**Gameplay Purpose**: The single combat experience a sector type is designed to produce (read through the melee-first lens, not gun-game terms). Fixed per type; every sub-variant of that type must serve it. Distinct from visual theme. _Avoid_: sector role, sector theme.

## Macro Features

**Macro Feature**: A cross-sector structure placed after sector generation and corridor connection, spanning sector seams to give the map identity and navigational landmarks. Overwrites skeleton tiles (except the outer map perimeter) in a post-generation pass. Two are always present (Highway + Mega-structure); one is seed-selected (Barrier Ridge, Open Commons, or none). _Avoid_: map structure, cross-sector element

**Highway**: The map's spine — a 3-tile-wide strip carved through the center band spanning all 4 sectors along its axis (H or V, seed-determined). Center 1 tile pure EMPTY (fast lane); each shoulder tile EMPTY with ~30% breakable-crate cover — ≈5-tile footprint in effect, 3 tiles guaranteed clear. Nuclear clearance — erases everything in its path. Dead-ends at the outer map perimeter. Always present (1 per map). *(Width amended by map-redesign ticket 11 / DEC-011 to match shipped code.)* _Avoid_: main road, cross-sector corridor

**Mega-structure**: The landmark — a 10×10 tile compound spanning a seam between two center 2×2 sectors. Indestructible outer shell (permanent), breakable interior partitions (dynamic), 2-3 entry gaps, central courtyard with chests. If the highway crosses through it, the highway wins and splits the compound. Always present (1 per map). _Avoid_: compound, fortress, landmark building

**Barrier Ridge**: A 1-tile-thick indestructible wall line running diagonally across 2-3 outer sectors, with 2-3 gaps that become chokepoints. Creates attacker/defender splits. Seed-selected (33%). _Avoid_: divider wall, split wall

**Open Commons**: One pair of adjacent outer sectors merged into a 40×20 super-sector by removing their shared border entirely. Very low cover density (~5%) with 2-3 indestructible pillars. Seed-selected (33%). _Avoid_: merged sector, super-sector, open field

## Cover Placement

**Cover Pattern**: A geometric algorithm that places cover tiles (crates, walls, barrels) in deliberate patterns — lattice intervals, concentric arcs, edge traces, radial spokes, cache framing — rather than random scatter. Each skeleton builder owns its own cover pattern. Same density, designed placement. Replaces EntityPlacer random scatter. _Avoid_: cover scatter, random cover, entity fill

**Pattern Utility**: A reusable geometric placement primitive shared across skeleton builders: Lattice Fill, Concentric Arcs, Edge Trace, Radial Spokes, Cache Framing, Staggered Rows, Diagonal Pairs. Each is a pure function of (grid, rng, params). _Avoid_: cover template, placement function

**Skeleton-Owned Cover**: Each skeleton builder places its own cover using Pattern Utilities, producing a complete tile layout including cover. EntityPlacer no longer scatters crates — it only places barrels, traps, chests, and weapon spawns. _Avoid_: entity-driven cover, scatter fill

## Refinement Pipeline

**Refinement Pass**: A post-generation quality check that scans the completed grid for issues and fixes them deterministically. Six passes run in order, each pure and testable: Macro Heal → Orphan Cleanup → Dead Zone Fill → Sightline Break → Density Balance → Validate. Orphan cleanup runs before dead zone fill so the fill pass sees the true structural layout (not entity-placed noise). The pipeline runs before entity/spawn placement so newly-placed cover doesn't conflict with spawns. _Avoid_: post-process, cleanup pass, polish step

**Macro Heal**: First refinement pass — repairs damage caused by macro features overwriting skeleton patterns: removes dangling stubs at highway edges, cleans orphaned half-rings from compound placement, carves gaps through ridges blocking corridors. _Avoid_: feature repair, damage fix

**Dead Zone**: A 5×5+ tile EMPTY region with zero cover, detected and fixed by placing a small geometric cluster (line, L, triangle) at its center — never random scatter. _Avoid_: empty pocket, blank area

## Zone System

**Safe Zone**: Circular area protecting from zone damage and siege wall drops. Shrinks over 6 phases across 255 seconds. _Avoid_: circle, zone, safe area

**Siege**: Closing the arena by dropping indestructible walls in radial flood-fill rings — furthest tiles from the zone center first, progressing inward. Active from Phase 2 onward. Per-sector scope: only sectors whose center falls outside the zone circle are sieged. _Avoid_: wall closure, arena shrink, killing coffins

**Siege Wall**: Indestructible wall placed by siege system. Replaces EMPTY, DESTRUCTIBLE*CRATE, DESTRUCTIBLE_BARREL, EXIT, CHEST tiles. Does NOT replace INDESTRUCTIBLE_WALL/CRATE or DESTRUCTIBLE_WALL. \_Avoid*: coffin wall, killing wall

**Siege Ring**: A concentric batch of tiles at a given distance from the zone center, dropped as a cascade (30ms per tile within the ring). Ring 0 = furthest tiles from center; rings progress inward. Zone center re-snapshots when it moves >1 tile-width. _Avoid_: siege layer, siege spiral, closure pattern

**Siege Crush**: 100 damage to any player on a tile when siege wall solidifies. Bypasses ALL invulnerability. _Avoid_: wall crush, coffin crush

**Siege Warning**: 0.5s visual/audio indicator before siege wall drops. Tiles remain walkable during warning.

**Sector**: Square map subdivision for UI announcements. NOT used for siege progression. 80×80 map → 4×4 sectors of 20×20. _Avoid_: zone segment, region

**Destructible Wall Gap**: Tile in siege line with DESTRUCTIBLE_WALL that siege skips. Potential escape route (5 HP, breakable).

## Server Performance

**Tick Budget**: The 16.67ms time limit for one simulation step at 60Hz (`TICK_RATE`). If exceeded, the server falls behind real-time. Monitored via per-system profiling (each of 11 simulation steps timed individually). _Avoid_: frame budget, step budget

**Time Dilation**: When the server cannot sustain 60Hz, the simulation runs slower (fewer ticks per real second) rather than spiraling. Controlled by `MAX_STEPS=1` — at most one simulation step per real frame, so accumulated time bleeds off gradually as slowed gameplay, not as a catch-up storm. Game timers (dash cooldowns, zone phases) are tick-based, so they slow proportionally without breaking correctness. _Avoid_: slow motion, frame skip, catch-up

**Spiral of Death**: When tick catch-up (`MAX_STEPS > 1`) causes increasingly slow frames — each slow frame triggers more catch-up ticks, each of which is also slow, cascading into a server freeze. The reason `MAX_STEPS` was reduced from 5 to 1. _Avoid_: death spiral, tick cascade, catch-up storm

**World Snapshot**: Per-tick, read-only, pooled view of all game entities shared across all bots. Built once at the start of `BotSystem.tick()` (mutating pre-allocated DTO fields in place, zero allocation), frozen during bot execution. Replaces the former per-bot `BotGameStateView` rebuild (63× redundant world scans per tick). Position fields are flattened (`dto.x`, `dto.y`) — no nested `{position:{x,y}}` objects. _Avoid_: game state view, entity cache, bot world view

**LOS Cache**: Global grid-cell-pair cache for line-of-sight raycast results, owned by `Pathfinder`. Key: normalized symmetric cell pair packed into a 32-bit int. Lazy population, event-driven invalidation (cleared only when the tile grid changes — siege wall solidification, destructible destroyed). Turns ~1,260 DDA marches/tick into O(1) Map lookups after warmup. _Avoid_: visibility cache, raycast cache, LOS table

**Perception Staggering**: Distributing bot perception scans across ticks so ~21 bots scan per tick instead of all 63. Each bot has `perceptionPhase = hash(botId) % BOT_PERCEPTION_INTERVAL_TICKS`. On tick T, only bots whose phase matches scan; others carry forward last results. Ensures even CPU load every tick (no spikes). _Avoid_: scan distribution, phase spreading, perception batching

**Perception Scan**: The process of a bot scanning the world for nearby threats, items, and obstacles via the shared World Snapshot. Throttled to 20Hz (`BOT_PERCEPTION_INTERVAL_TICKS = 3`, tunable) with staggered phases. Tracked target positions remain real-time (read from the snapshot updated every tick); only new-threat discovery is delayed ≤50ms. _Avoid_: bot sensing, AI scan, awareness update

## Match Phases

**Zone Phase**: One of 6 timed stages governing safe zone radius and siege behavior. Phase 1 = full map, no siege. Phase 2+ = shrinking zone + active siege.

**Overtime**: Sudden death (zone phase 7 — 255s+ at current pacing). Zone stops shrinking (8% radius). Siege interval 1.5s. Siege walls close into safe zone.

## Disconnect / AFK

- 0-30s: Grace period, frozen, `allowReconnection(client, 30)`
- 30-60s: Unfrozen, no inputs, vulnerable to damage/knockback
- 60s: Bot takeover (entity-preserving, `isBot = true`, inherits full state)
- AFK: no input 30s → warning, 60s → bot takeover (no grace period)

## Death Flow

HP=0 → DYING → 0.5s death animation (body retains collision) → drop weapons in grid around position → cancel effects → DEAD → SPECTATING → camera follows killer.

## Spectator Mode

Auto-follows killer. Q/E cycle alive players by ID. Space toggles free camera (WASD pan 500px/s). ESC returns to menu.

## Juice / Player-Feedback VFX

**Transition Wipe**: The full-screen diamond-grid shader wipe between scenes. Its near-black cells carry a tiled watermark doodle (inverted-luminance mix — the doodle reads as graphite on black, the wipe stays black). Single shader source: `src/shaders/transition.frag`. _Avoid_: fade, loading screen

**Pickup Pop**: The combined noticeability treatment on in-world power-ups: icon pulse + tinted ground decal + sonar ping expanding to `PICKUP_RADIUS` (teaches the walk-over distance) + tinted collection burst on pickup. _Avoid_: glow loot, loot beam

**Defensive Aura**: The shield read — blue shimmer orbiters + counter-breathing dome rings. Conveys STATE ("shield is up"), never motion. _Avoid_: bubble, force field

**Ghost Tail**: Progressive-transparency afterimages of the player's rendered pose (frame + rotation + dash-stretch scale), emitted along movement during dash and speed boost. Conveys MOTION; gated by the speed state but never restating it (the aura owns state). One shared system (`GhostTailRenderer`) serves both triggers. _Avoid_: motion blur, echo, clone trail

## Flagged Ambiguities

- "Killing coffin" = visual sprite. "Siege wall" = gameplay element. Use "siege wall."
- "Zone" ambiguous between safe zone and zone damage. Use specific term.
- "Solid tile" ambiguous between enum-based set membership and collider-data presence. Use "blocking tile" (isBlockingTile) for DDA/melee and "three-path collision" for projectile AABB.
