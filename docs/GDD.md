# Sector Chaos Neo — Game Design Document

**Version:** 1.1
**Status:** Single Source of Truth
**Last Updated:** 2026-07-27

---

## §0 Implementation Reality (authoritative — supersedes stale values below)

> A 2026-07-27 audit found that several numeric values and one core behavior in
> the body of this GDD no longer match the shipped code. **The code is the source
> of truth.** The list below is the authoritative correction; where any section
> below disagrees with this list, this list wins. The stale inline values are
> retained for history but are NOT accurate.

### Behavior corrections

1. **Shield blocking is PASSIVE, not ATTACK-activated.** A shield blocks 100% of
   melee/thrown/arrow damage **automatically** whenever it is the active weapon,
   the attack arrives within the shield's frontal arc, and the holder is not
   fresh-spawn / staggered / dashing. **No input is required** — the GDD's
   "hold ATTACK to block" / "block IS the attack function" model is WRONG.
   ATTACK with a shield performs an offensive **bash** (damage + knockback in a
   120° arc); it does not control blocking. The raised-shield visual is derived
   from "shield equipped + blockable state" for state sync. (ShieldHandler.ts,
   StateMapper.ts.)

2. **Weapon pickup is gated by `canPickup()`**, not by the `PICKUP_BLOCKED_DURING_ATTACK`
   constant (which is **dead code** — declared but never read). `canPickup()`
   blocks pickup during dash, stagger, windup, AND attack cooldown. **Power-up
   walk-over collection bypasses `canPickup()` entirely** — powerups auto-collect
   on walk-over regardless of combat state.

3. **Weapon durability scales UP with tier** (Common 8 → Legendary 20 base),
   inverted from the old table in §6.2.2. Bows and shields apply a multiplier
   (bows 1.5×, small shield 1.5×, large shield 2.0×). See ADR-0029. The §6.1
   roster's flat "Durability" column and §6.2.2's decreasing table are stale.

### Numeric corrections (code value wins)

| Constant / value | GDD says (stale) | Code (actual) | Code location |
|---|---|---|---|
| `PICKUP_RADIUS` | 32 px | **72 px** | player.ts:22 |
| `CHEST.INTERACTION_RANGE` | 32 (= PICKUP_RADIUS) | **192 px** | chest.ts:49 |
| Large Shield block arc | 90° | **180°** (small stays 90°) | definitions.ts:546 |
| `BASE_SPEED` | 200 px/s | **430 px/s** | player.ts:2 |
| Dash speed | 400 px/s | **860 px/s** (430 × 2.0) | player.ts:5 |
| `KNOCKBACK_FORCE` | 300 | **2000** | combat.ts:17 |
| `KNOCKBACK_DECAY` | 5/s | **2000** (linear/tick) | combat.ts:18 |
| `MAX_BOUNCES` | 3 | **6** (Throwing Axe caps at 3 via its own def) | combat.ts:22 |
| `BOUNCE_FACTOR` | 0.7 | **0.75** | combat.ts:21 |
| `THROW_RANGE` | 1500 px | **2000 px** | combat.ts:20 |
| `THROW_SOURCE_IMMUNITY` | 100 ms (prose) | **170 ms** (§16.3 already correct) | combat.ts:25 |
| `WEAPON_BREAK_STAGGER` | 0.2 s | **0.33 s** | combat.ts:29 |
| `SHIELD_BREAK_STAGGER` | 0.3 s | **0.5 s** (per-weapon `staggerOnBreakMs` overrides: 300 ms) | combat.ts:30 |
| Short Bow range | 1200 | **1800** (tier-scaled) | definitions.ts:430 |
| Bow projectile speed | 600 px/s | **2000 px/s** (per-weapon, no global constant) | definitions.ts:438 |
| Throw speed formula | `400 − tier×25` | **per-weapon `throwSpeed`** (Dagger 2000, Short Sword 1500, …) | definitions.ts |
| `MIN_PLAYERS` | 48 | **32** | match.ts:5 |
| `HAND_SCALE` | 0.33 | **1.0** | player.ts:17 |

### Dead / fictitious constants (declared but unused, or never existed)

- `PICKUP_BLOCKED_DURING_ATTACK` (player.ts:21) — declared, never read. Real
  gate is `canPickup()`.
- `MELEE_WALL_HIT_DURABILITY_COST` (combat.ts:48 = 1) — declared + unit-tested,
  but **never consumed**. Walls effectively cost 0 durability (the GDD's "0" is
  accidentally correct).
- `ATTACK_WINDUP_FISTS/MEDIUM/SLOW`, `BOW_PROJECTILE_SPEED`,
  `PROJECTILE_SPEED_LIGHT/MEDIUM/HEAVY/VERY_HEAVY`, `KNOCKBACK_MAX_VELOCITY`,
  `KNOCKBACK_DURATION`, `HAND_OFFSET`, `PROJECTILE_SPIN_SPEED`,
  `PROJECTILE_BOUNCE_PULSE` — listed in §16 but **do not exist** as named shared
  constants. Windup is per-weapon `windupMs`; projectile/throw speeds are
  per-weapon fields.
- `TIER_STAT_MULTIPLIER` is `(1.0, 1.25, 1.75, 2.0)` in code, NOT the
  `(1.0, 1.5, 2.0, 3.0)` claimed in ADR-0029 (which is itself stale).

---

## Table of Contents

1. [Game Overview](#1-game-overview)
2. [Core Game Loop](#2-core-game-loop)
3. [Game Mode](#3-game-mode)
4. [Controls](#4-controls)
5. [Map System](#5-map-system)
6. [Weapon System](#6-weapon-system)
7. [Combat System](#7-combat-system)
8. [Zone System](#8-zone-system)
9. [Power-Up System](#9-power-up-system)
10. [Trap System](#10-trap-system)
11. [Chest System](#11-chest-system)
12. [Match Flow](#12-match-flow)
13. [Player Rendering](#13-player-rendering)
14. [Bot AI System](#14-bot-ai-system)
15. [Technical Architecture](#15-technical-architecture)
16. [Constants Reference](#16-constants-reference)
17. [Anti-Patterns](#17-anti-patterns-27-forbidden)
18. [Performance Budgets](#18-performance-budgets)
19. [File Constraints](#19-file-constraints)
20. [Enums Reference](#20-enums-reference)
21. [Audio Design](#21-audio-design)
22. [Asset Pipeline](#22-asset-pipeline)

---

# 1. Game Overview

| Field | Value |
|-------|-------|
| **Title** | Sector Chaos Neo |
| **Genre** | 64-player battle royale, top-down 2D melee combat |
| **Inspiration** | Classic Bomberman (grid-based arena, destructible environment) with NO bombs. Melee combat is the differentiator. |
| **Platform** | Web (desktop + mobile) |
| **Tech Stack** | Phaser 4, Colyseus v0.17, TypeScript 5.x, pnpm monorepo |

---

# 2. Core Game Loop

```
Join Matchmaking --> MMR-Based Lobby (bots fill slots)
        |
        v
  5-Second Countdown
        |
        v
  Spawn Across 80x80 Arena (fists only)
        |
        v
  Loot Weapons from Chests / Destroyed Crates
        |
        v
  Fight Other Players (melee + thrown weapons)
        |
        v
  Zone Closes Over ~4¼ Minutes / 255s (6 phases)
        |
        v
  Last Player Standing Wins
        |
        v
  Dead Players Spectate Until Match Ends
```

---

# 3. Game Mode

**Solo Free-For-All (FFA)**

- 64 players max (real players + bots)
- Single life per match — no respawns
- Last player standing wins
- Zone forces encounters over ~4¼ minutes (255s)

---

# 4. Controls

## 4.1 Desktop

| Action | Input |
|--------|-------|
| Movement | WASD keys (8-directional) |
| Aim | Mouse cursor (character faces cursor direction) |
| Attack | Left-click (melee swing, ranged shot, or shield block depending on equipped weapon) |
| Throw | Right-click (throw current weapon in cursor direction) |
| Dash | Spacebar (burst of speed in movement direction) |
| Pickup / Open Chest / Interact | E key |
| Switch weapon slot | 1-4 number keys (select inventory slot) or scroll wheel |
| Drop weapon | **No Q-to-drop** — manual drop removed. Only swap when picking up another weapon. |

## 4.2 Mobile (Twin-Stick Layout)

| Action | Input |
|--------|-------|
| Movement | Left stick — virtual joystick, bottom-left |
| Aim + Attack | Right stick — virtual joystick, bottom-right. Push direction to aim, release to attack (melee swing or ranged shot). Hold steady = shield block when equipped with shield weapon (threshold: < 0.15 magnitude for > 100ms). Release right stick while holding shield = nothing (no attack from shield). |
| Dash | Dash button, bottom-center-left |
| Throw | Dedicated Throw button, bottom-center-right (next to dash button). Tap to throw current weapon. |
| Pickup | Pickup button, near character |
| Weapon slots | Weapon slot bar, bottom-center (4×48px slots) |

UI sprites (joysticks, buttons, icons) are located in `assets/ui/`.

---

# 5. Map System

## 5.1 Arena

| Property | Value |
|----------|-------|
| Grid | 80 x 80 tiles |
| Tile size | 128 x 128 pixels |
| World size | 10,240 x 10,240 pixels |
| Sector grid | 4 x 4 (16 sectors total) |
| Sector size | 20 x 20 tiles (2,560 x 2,560 pixels) |
| Generation | Procedural from seed (deterministic) |
| Max retries on invalid seed | 10 |

## 5.1.1 Viewport

- Desktop viewport: 1920×1080 pixels (16:9 aspect ratio)
- Mobile viewport: responsive (device-dependent)
- Camera follows player character
- Camera shows approximately 15×8 tiles at a time on desktop
- No fog of war — all entities in viewport are visible
- Minimap shows local area view (~3304×3304 world pixels, ~16.5 world-px per minimap-px) in corner

## 5.1.2 Minimap

- Position: top-right corner of screen
- Shows a LOCAL AREA view: ~3304×3304 world pixels rendered in a 200×200px minimap. Viewport diagonal radius ≈ 1101px (1920×1080), 1.5× ≈ 1652px radius, diameter ≈ 3304px. Minimap scale: approximately 16.5 world-px per minimap-px.
- NOT the full map — only the area around the player
- Shows player position (white dot)
- Shows zone boundary (red circle)
- Shows loot markers (chests, weapon pickups) within the minimap range
- Does NOT show other player positions
- Does NOT show the full map

## 5.2 Sector Types (4 types)

> **Revamp model (ADR 0027):** Each sector *type* below carries one fixed **Gameplay Purpose** and one shared balance budget. Each type is realized by **exactly 4 procedural sub-variants** (distinct layout skeletons — 4 per type, 16 total) selected per sector instance from the seed; the same sub-variant is never placed in two orthogonally-adjacent sectors. Type *placement* is **center-hot**: the inner 2×2 center sectors trend toward ResourceRich + GridArena (the loot brawl / siege endgame), the outer 12-sector ring toward OpenArena + Maze (landing, skirmish, rotation). This supersedes the random weighted pick, the corner-pinned minimum-types rule, and the 2-consecutive cap in §5.3. Each sector type also carries a **type-coded Biome** (a signature floor sprite + per-type decorative-accent overlay; see CONTEXT.md → Biome) that signals its purpose at a glance. **Map rendering** (Seed Path) stacks layers floor → decoration → walls → interactive: decorative accents are a dedicated overlay composited on top of the opaque floor underlay (never a floor replacement), and walls draw from collider-compatible sprite variety pools — with free-standing isolated/stub walls rendered as full-tile object art (crate/coffin/tree) rather than a single wall material (see CONTEXT.md → Wall Variety Pool / Wall Object Art). **Revamp 2 visual cohesion (see ADR 0027 → Revamp 2):** corridor floors are now themed — `path` for horizontal runs, `track` for vertical — instead of the `wood` edge floor, and each sector's central 4×4 carries a **plaza accent** floor distinct from its biome floor; internal sector seams are thinned to a single 1-thick wall line with **1–3 varied 3-wide openings** per edge (outer perimeter unchanged, corners preserved). The per-type balance budgets (crate density, chest/barrel/trap/ground-weapon counts in §5.6) are unchanged. ADR 0027 is the recorded rationale for all deviations from the original §5.2/§5.3 POC design below.

### 5.2.1 GridArena

20×20 tiles. **Purpose: close-quarters melee brawl** — dense breakable cover and tight lanes (the Bomberman core). The cover **skeleton is indestructible** (a persistent pillar grid that never disappears), with DESTRUCTIBLE_CRATE/WALL as the breakable *fill* in the gaps that players smash to open flanks — so the sector keeps its close-combat identity all match. (This is a deliberate change from the original destructible-pillar rule; see ADR 0027.) Breakable-fill density ~25%.

**Sub-variants:**
- **Classic Lattice** — regular indestructible pillar grid + breakable fill, near-symmetric; the canonical Bomberman screen.
- **Ring Fortress** — concentric square rings of cover with staggered gaps and an inner sanctum (chest / chokepoint) players fight inward toward.
- **Broken Grid** — jittered/clustered pillars, offset lanes, some diagonal cover, no mirror symmetry.
- **Lane Corridors** — 2–3 parallel indestructible cover walls forming lanes, with breakable cross-cuts to swap lanes.

### 5.2.2 OpenArena

20×20 tiles. **Purpose: spacing, dashing & the chase** — room to reposition, few hard blockers, good sightlines; rewards dash timing, punishes getting cornered. Low obstacle density (~10% breakable crates). Indestructible cover clusters never hug the border (fixes the prior placement bug where clusters touched the edge).

**Sub-variants:**
- **Corner Bastions** — a few indestructible cover clusters anchored off the corners/midfield (varied size/offset), wide clear center; the baseline open duel.
- **Central Monument** — one bold central landmark structure (plus/cross, small ring, or pillar cluster) to circle and juke around; rest wide open.
- **Scatter Cover** — sparse, irregular single/double blockers + a couple of barrels breaking pure sightlines; maximally dash-friendly.
- **Diagonal Spurs** — a couple of diagonal indestructible wall spurs cutting partial sightlines, creating flank angles in otherwise open space.

### 5.2.3 Maze

20×20 tiles. **Purpose: labyrinth ambush / cat-and-mouse** — line-of-sight denial, blind corners, flanks. The maze is now **asymmetric** (the 4-fold mirror is dropped), **mixed-width** (2-wide arteries + 1-wide branches, so melee and movement work and 63-bot LOS/pathfinding stays affordable), **looped** (few dead-ends), and sprinkled with seeded **breakable `wall_secret` (DESTRUCTIBLE_WALL) shortcuts** that players smash for escapes and flanks. (Deliberate change from the original mirrored width-1 maze; see ADR 0027.) Breakable-crate fill ~5%.

**Sub-variants:**
- **Loose Labyrinth** — asymmetric weave of arteries + branches, heavy loops, scattered breakable shortcuts; twisting but never a death-trap.
- **Chambers & Halls** — small multi-doorway chambers (ambush pockets) linked by 2-wide halls, with breakable shortcuts between adjacent chambers.
- **Breakable Warren** — denser weave where breakable shortcuts are the primary flanking mechanic; rewards learning the seed.
- **Concentric Spiral** — ring corridors + radial cross-cuts forming rotating chase loops.

### 5.2.4 ResourceRich

20×20 tiles. **Purpose: loot-rush hot zone** — highest reward, most exposed, most contested (the early magnet and siege-endgame prize). **Cover always frames loot** — the prior 5–8 lone indestructible "stub" walls are removed; any cover placed exists to shape the fight over a cache. Highest chest/barrel density (~15% breakable crates, 3 chests); 2–3 guaranteed ground-weapon spawns.

**Sub-variants:**
- **Treasure Vault** — a central high-value cache (chests + weapon spawns) behind a ring of breakable vault walls everyone converges to crack open.
- **Loot Bazaar** — loot distributed across many small cover pockets, spreading fights into simultaneous skirmishes.
- **Exposed Cache** — minimal cover, loot out in the open on marked spots; maximum risk during the grab.
- **Supply Depot** — loot along rows of crates/barrels (warehouse aisles) with cover lanes and barrel-chain hazards.

## 5.3 Constraints

- All four sector types appear on every map — **center-hot placement** (ADR 0027) guarantees ≥1 ResourceRich and ≥1 GridArena in the inner 2×2 center, with the center weighted toward ResourceRich + GridArena and the outer 12-sector ring weighted toward OpenArena + Maze
- Type spread is enforced so the 4×4 always shows a balanced mix; the same **sub-variant** is never placed in two orthogonally-adjacent sectors (this supersedes the old 2-consecutive cap and the corner-pinned minimum-types rule)
- **Corridor Openings Between Sectors:**
  Each shared wall between two ADJACENT interior sectors has exactly 1 corridor opening. Corridors are only carved between sectors that share an interior border — sectors on the map edge do NOT have corridors on their map-facing wall.
  - Width: 3 tiles (384px at 128px/tile)
  - Position: Centered on the shared wall
  - The corridor removes wall tiles from both sectors' border rows
  - Corridor openings connect the interior floor of both sectors
  - Corridor tiles are always EMPTY after generation — nothing can be placed on them
  - Sectors generate independently first, then corridors are carved to connect adjacent interior borders
- Flood-fill connectivity check: all empty tiles must be reachable
- **Sector Border Walls:** All sector types have INDESTRUCTIBLE_WALL on their border tiles (row 0, row 19, column 0, column 19) after initial generation. GridArena and Maze naturally have these from filling with walls; OpenArena and ResourceRich add them explicitly after the EMPTY fill. Corridor carving removes these wall tiles to create openings between sectors.
- 64 valid spawn positions, minimum 3-tile Manhattan distance between spawns
- Spawns only on EMPTY tiles, prioritized even distribution across sectors (4 spawns per sector, 16 sectors = 64 total)
- **Spawn Algorithm**: For each sector, collect all EMPTY tiles not on border/corridor tiles. Sort by distance from sector center. Select 4 positions with maximum spread (greedy: pick center-most first, then furthest from all selected). If a sector has fewer than 4 valid EMPTY tiles, overflow spawns are distributed to neighboring sectors with fewest spawns.
- **Map Validity Check**: After generation, flood-fill from a random EMPTY tile. If reachable tiles < 80% of total EMPTY tiles, map is invalid and seed is retried (max 10 retries). Validity also requires at least 64 spawn positions across all sectors combined.
- **Skeleton quality gates (ADR 0027):** The same 10-retry loop also rejects degenerate skeletons via `MapValidator`: minimum interior open-ratio (≥35% EMPTY), per-sector spawn feasibility (≥4 spawn-eligible tiles, with the map-wide overflow rule), per-sector loot feasibility (enough non-corridor/non-border tiles for the type's chest + barrel + loot budget), and an isolated-stub-wall cap (≤60 lone indestructible walls map-wide, which retires the old ResourceRich stub artifact). A seed failing any gate is retried, not shipped.
- **Seed Generation**: Server generates a random 32-bit integer seed at match start. All map generation is deterministic from this seed. Zone center randomization uses the same seed for reproducibility in testing.
- **Map border:** The outermost ring of tiles (row 0, row 79, column 0, column 79) are all INDESTRUCTIBLE_WALL. Players cannot reach the true map edge.
- **Decorative accents (Revamp 2):** accents now cluster preferentially (~70%) on **structure-adjacent** EMPTY cells (cells with ≥1 non-EMPTY cardinal neighbour), leaving ~30% as free scatter, so set dressing reads as hugging walls/pillars/cover rather than random noise. The per-type decoration palette expanded: `stairs_down` + `water` added for Maze, `stairs_down_detail` added for OpenArena. Accents remain collider-free EMPTY-type overlays (no gameplay effect).

## 5.3.1 Entity Placement Algorithm

**Entity Placement Within Sectors:**
All entities (chests, barrels, traps, crates) are placed on random empty floor tiles.
- Minimum 2-tile Manhattan distance between any two placed entities
- Entities cannot be placed on corridor openings, sector borders (shared walls), or adjacent to an indestructible wall
- Entities cannot be placed in the first/last row or column of a sector (1-tile buffer from border)
- Placement order: chests first (highest priority positions), then barrels, then traps. ~~Crates fill remaining space~~ (crate scatter removed — cover is now skeleton-owned, see §5.3.3).

## 5.3.2 Macro Features (ADR 0028)

After sector generation, corridor connection, and border cleanup — but before entity placement — a **Macro Feature pass** places 2-3 cross-sector structures that give the map identity and navigational landmarks. The pass runs AFTER `SectorConnector` (which remains untouched) and may overwrite any tile except the outer map perimeter (rows/cols 0 and 79). All features are deterministic (seed-driven, isolated RNG streams).

**Always present:**

- **Highway** — A 3-tile-wide strip carved through the center band of the map (horizontal or vertical, seed-determined; `HIGHWAY_WIDTH = 3`). The center 1 tile is pure EMPTY (the "fast lane"); each of the 2 shoulder tiles is EMPTY with sparse breakable cover (~30% chance of a DESTRUCTIBLE_CRATE per shoulder tile). With its shoulder crates the cut reads as a ≈5-tile-wide footprint in effect, but only 3 tiles are guaranteed clear. The highway clears EVERYTHING in its path — sector walls, border rings, crates, pillars, maze corridors. At each sector boundary, the centerline jogs by up to ±2 tiles (breaking sightlines). Dead-ends at the outer perimeter wall. Per-map: exactly 1. *(Amended by map-redesign ticket 11 / DEC-011: the shipped code — 3-tile highway + shoulder crates — is the behavior of record; the prior text described a 5-tile carve with a 3-tile fast lane that never shipped.)*
- **Mega-structure (Compound / rare Citadel)** — A 10×10 tile compound spanning a seam between two center 2×2 sectors. Indestructible outer shell (1-tile ring, permanent), breakable interior partitions (DESTRUCTIBLE_WALL, dynamic — rooms merge as walls are smashed), 2-3 entry gaps (3 tiles wide, on different sides), courtyard with 1-4 authored chests (one of four template families: Cross Partition, Pillared Hall, Courtyard Ring, Loot Arm — the loot-arm lays its chests along a corridor spine). Template-authored chests are real loot placements (tier-rolled; the map-wide legendary cap applies). If the highway crosses the compound, the highway wins and splits it. Each template carries a beacon at an authored anchor (tier-colored). Per-map: exactly 1.
- **Citadel (rare variant, ~10-15% of seeds)** — A 14×14 fortress replacing the standard compound on the same center seams (the roll lives on an isolated salted stream — rarity is the event). Tiered interior: breakable outer yard ring (smash-in anywhere) with four 3-wide yard gaps → indestructible shell with FOUR 3-wide entry gaps (one per side) → inner vault chamber holding a GUARANTEED epic-or-better chest (legendary only within the map-wide cap) plus 2-3 guardian traps, with a 3-wide doorway and a breakable breach segment (second path — no lockable sanctum). A 2×2 indestructible pillar cluster in the yard forms the power position, with a clear sightline column over the north vault approach. The vault carries the strongest beacon on the map (at the static value ceiling, radius beyond every hero beacon). Per-map: 0 or 1 (replaces the compound).

**Seed-selected (33% each / 33% nothing):**

- **Barrier Ridge** — A 1-tile-thick INDESTRUCTIBLE_WALL line running diagonally across 2-3 outer sectors (~25-35 tiles), with 2-3 gaps (3 tiles wide) that become contested chokepoints. Creates attacker/defender splits. Highway and compound punch through if they cross.
- **Open Commons** — One pair of adjacent outer sectors merged into a 40×20 (or 20×40) super-sector by removing their shared border wall entirely. The merged space retains existing skeleton structures but the missing border creates a wide-open battle space.

**Feature interaction priority:** outer map perimeter (untouchable) → Highway (carves through everything) → Mega-structure (overwrites center seam) → Barrier Ridge / Open Commons (outer sectors, yield to higher-priority features).

## 5.3.3 Cover Patterns (ADR 0028)

Cover placement is **skeleton-owned**: each of the 16 skeleton builders places its own cover using shared geometric **Pattern Utilities** (`packages/shared/src/map/patterns/CoverPatterns.ts`), replacing the former `EntityPlacer` random crate scatter. Same cover density, designed placement — cover forms deliberate geometric patterns (lattice grids, concentric arcs, edge traces, radial spokes, cache frames, staggered rows, diagonal pairs) rather than random noise.

**Pattern Utilities:**
- **Lattice Fill** — cover at regular N-tile intervals on a grid (GridArena lane gaps)
- **Edge Trace** — cover 1-tile offset from wall contours, following structure shapes (Maze corridors)
- **Concentric Arcs** — cover along rectangular ring paths at given insets
- **Radial Spokes** — cover radiating from a center point at fixed angles (Central Monument)
- **Cache Frame** — cover in U/L/crescent shapes around a point (ResourceRich loot pockets)
- **Staggered Rows** — brick-pattern offset lines (Supply Depot aisles, Lane Corridors)
- **Diagonal Pairs** — 2-tile cover clusters at anchor points (OpenArena sightline breaks)

`EntityPlacer` retains barrel, trap, chest, and weapon-spawn placement only. `CRATE_DENSITY` is zero for all sector types. Per-type cover budgets are unchanged in total cover count; only the placement algorithm changed (geometric vs random).

## 5.3.4 Refinement Pipeline (ADR 0028)

After macro features and before entity/spawn placement, a **6-pass refinement pipeline** scans the completed grid for quality issues and fixes them deterministically. Each pass is pure, testable, and ordered to avoid cascading fixes.

1. **Macro Heal** — repairs damage from macro features: removes dangling 1-tile wall stubs near highway edges, cleans orphaned half-rings from compound placement, preserves intentional compound walls.
2. **Orphan Cleanup** — removes cover tiles (crates, barrels, breakable walls) that have NO cardinal neighbor that is non-EMPTY. These read as random dots; removing them sharpens the remaining patterns. Two-phase (collect-then-apply) to prevent cascading.
3. **Dead Zone Fill** — detects 5×5+ EMPTY regions with zero cover and places a small geometric cluster (line, L-shape, or triangle of 2-3 crates) at the center. Never random scatter.
4. **Sightline Break** — casts rays from pocket-edge tiles; any unobstructed ray ≥8 tiles gets a single breakable crate at its midpoint. Max 30 placements per map.
5. **Density Balance** — divides map into 4 quadrants; any quadrant with <60% or >140% of average cover density gets topped up or thinned (max 5 tiles per quadrant).
6. **Validate** — existing `MapValidator` gates (connectivity, spawn feasibility, open ratio, loot feasibility, stub cap). Failed seeds retry (max 10).

## 5.4 Tile Types

| Type | ID | Description |
|------|-----|-------------|
| EMPTY | 0 | Walkable floor |
| INDESTRUCTIBLE_WALL | 1 | Permanent wall, never destroyed |
| DESTRUCTIBLE_WALL | 2 | Can be destroyed by melee/throw attacks. Drops loot. |
| CHEST | 3 | Interactable loot container (4 tiers) |
| EXIT | 4 | No gameplay function in current single-match BR mode. Reserved for future modes. |
| DESTRUCTIBLE_CRATE | 6 | 1 HP crate, destroyed by any single hit. Drops loot. |
| DESTRUCTIBLE_BARREL | 7 | 2 HP barrel, explodes on destruction. |
| INDESTRUCTIBLE_CRATE | 8 | Indestructible tactical cover. Blocks movement and projectiles. |

**DESTRUCTIBLE_WALL (ID 2):** Tactical obstacle. 5 HP to destroy. Does NOT drop loot. Distinct from DESTRUCTIBLE_CRATE (1HP, drops loot) and DESTRUCTIBLE_BARREL (2HP, explodes). Found in GridArena patterns as structural walls that take effort to break through.

## 5.5 Destructibles

### Crates
- **1 HP** — destroyed by any single hit from any weapon
- Drop loot (weapons, power-ups)

### Barrels
- **2 HP** — require 2 hits to destroy (any weapon)
- Explode on destruction
- Explosion uses DDA raycast propagation (triggered by barrel destruction only)
- Deals 50 damage in 256px radius (2 tiles — 5x5 area centered on barrel)
- Chain reactions up to depth 50 (Bomberman-style: barrel explodes -> damages next barrel -> chain, 0.2s delay)
- **Prime + fuse (juice-pass-1 ticket 05):** the flat two-hit model — every melee/thrown/arrow hit deals exactly 1 HP to barrels regardless of the weapon's damage (a Fists punch and a Hammer swing prime identically). ANY weapon's first hit primes; ANY weapon's second hit detonates on the spot; explosions destroy outright (one-shot at 2 HP). Barrels only — crates, walls, iron, and light props never prime.
- **5 s fuse** — tick-based, server-authoritative, set by the priming hit (`BARREL.FUSE_MS`). Fuse expiry auto-explodes the barrel identically to a normal destruction: 50 damage, 256px radius, 8 rays, chain-capable, cap 20 per resolution, environmental (damages the priming player too, no self-immunity).
- Any barrel spawned later in a match spawns **unprimed**.

### Iron Crates
- Indestructible — function as tactical cover
- Block movement and projectiles
- Visually distinct from walls

### Light Props
> **Amendment (map-polish ticket 09):** ticket 07 shipped these values GDD-silent and flagged them for ratification; this section is the ratification record — **ratified by review of the ticket-09 diff**.
>
> Owner ruling (verbatim): **"All light sources/props must be destructibles in the map, none should be baked directly, minus the beacons and corridor passages."**

- **Destructible type `'light'`** — sconces, braziers, biome crystals, POI glow pools converted from map-generation light placements into real, damageable, server-authoritative entities (wire type 4 after crate/barrel/iron/wall)
- **1 HP** — destroyed by any single hit from any weapon (§5.5.1's 1-HP-per-hit convention; a fixture is flimsier than a crate)
- **No loot drop** on destruction
- **Non-explosive** — never triggers a barrel-style explosion
- **NON-SOLID** — walk-through: blocks no movement and no projectile (the map tile stays EMPTY); hits arrive via the entity index — melee sweeps, thrown collisions, arrows, and explosions all damage it through the normal destructible pipelines
- **Placement provenance** — hydrated from map-generation light placements (anchor-provenance conversion set: route-mid sconces, dark-gap fill, POI glow pools, biome crystals); a generation-time audit gate enforces the rule (every non-exempt placement has exactly one backing entity, and vice versa)
- **Baked exemptions (static light data, never entities):** beacons (`kind:'beacon'`) + corridor/doorway passage sconces (`anchor:'doorway'`) — the owner's carve-out above, and nothing else. Campfires keep their pre-existing crate-entity backing (entity-backed, not baked).

## 5.5.1 Destructible Interaction Rules

**Melee vs Destructibles:** All melee attacks deal exactly 1 HP to destructibles regardless of weapon damage stat. A Fists punch (5 damage) and a Double Axe swing (30 damage) both deal 1 HP to a crate or barrel.
**Thrown vs Destructibles:** Thrown weapons deal 1 HP to destructibles per collision. Collision counts as a bounce.
**Arrow vs Destructibles:** Arrows deal 1 HP to destructibles and can trigger barrel explosions if they deliver the killing blow. Arrow disappears after hitting a destructible.
**Barrel Explosion:** Flat 50 damage via 8 directional rays (2 tiles each, 256px radius). Damage only applies to entities on ray paths. Rays are blocked by indestructible walls, iron crates, and siege walls. Rays stop at destructible entities (entity takes 50 damage, ray does not continue through). All explosions resolve instantly in a single simulation tick.

## 5.6 Map Entity Densities

**Crate Density (per sector type):**
| Sector Type | Crate Density | Approx Count |
|-------------|--------------|-------------|
| GridArena | 25% of empty tiles | ~60-80 |
| OpenArena | 10% of empty tiles | ~25-35 |
| Maze | 5% of empty tiles | ~10-18 |
| ResourceRich | 15% of empty tiles | ~35-45 |

**Chest Count (per sector type):**
| Sector Type | Chests |
|-------------|--------|
| GridArena | 2 |
| OpenArena | 1 |
| Maze | 1 |
| ResourceRich | 3 |
| **Total** | **~16-24** |

**Barrel Count:**
| Sector Type | Barrels |
|-------------|---------|
| All types | 3-5 per sector |
| **Total** | **~48-80** |

**Trap Count:**
| Sector Type | Traps |
|-------------|-------|
| All types | 1-3 per sector (random type: Spike/Fire/Teleport) |
| **Total** | **~16-48** |

**Crate Loot Drop Table:**
- 60% chance to drop loot when destroyed
- If drop occurs: 70% weapon / 30% power-up
- Weapon tier: Common 80%, Uncommon 15%, Rare 4%, Legendary 1%
- Power-up type: Health Pack 50%, Barrier 25%, Speed Boost 25%

## 5.6.1 Ground Weapon Spawns

Weapons spawn directly on the ground (not from crates or chests). Ground-weapon and chest tiers are **authored by map generation** from per-sector **loot-tier** data tables (`SECTOR_TIER_WEAPON_WEIGHTS` / `SECTOR_TIER_CHEST_WEIGHTS`, shared `constants/loot-weights.ts`) and consumed as-is by entity hydration — the tier placed by the generator is the tier that spawns (no re-roll). Every sector is assigned a seed-authored loot tier on an isolated RNG stream (map-redesign DEC-003): a pyramid of **2–3 HOT** sectors (center cluster guaranteed), **~8 WARM**, **~5 COLD** (outer ring). One **non-central WARM sector upgrades to HOT per match** (the "hot sector", rolled from the match seed, marked on the minimap). The tier drives the tables below; legendaries only spawn in HOT districts, and the total legendary count (chests + weapons combined) is capped at ~10/map.

**Ground-weapon tier tables (per sector loot tier):**

| Sector tier | Sectors (typ.) | Ground spawns each | Common | Uncommon | Rare | Legendary |
|-------------|----------------|--------------------|--------|----------|------|-----------|
| COLD | ~5 outer ring | 3-4 | 100% | — | — | — |
| WARM | ~8 | 3-4 | 85% | 12% | 3% | — |
| HOT | 2-3 center cluster + per-match hot sector | 3-4 | 60% | 25% | 12% | 3% |

**Chest-rarity tables (per sector loot tier):**

| Sector tier | Common | Rare | Epic | Legendary |
|-------------|--------|------|------|-----------|
| COLD | 85% | 12% | 3% | — |
| WARM | 70% | 20% | 8% | 2% |
| HOT | 45% | 30% | 18% | 7% |

RESOURCE_RICH sectors get +2 ground spawns (high-value loot zones). Total ground weapon spawns: ~48-70 across the map. HOT districts offer rarer weapons but are more contested; COLD edges are the cheap-landing band.

*(Amended by map-redesign ticket 02 / DEC-003: the ring split from ticket 01 (outer 100% Common / center 60/25/12/3) is generalized into the per-tier tables above — intent preserved (outer cheap, center rich), with WARM as the explicit middle band and legendaries concentrated in HOT districts. Generation pipeline v3.)*

## 5.7 Player Collision

Players are solid bodies and block each other's movement. Two players cannot occupy the same space. This enables body-blocking tactics, chokepoint contests, and protective positioning. Dash is the ONLY way to pass through other players.

## 5.7.1 Tile Movement Rules

All non-EMPTY tile types block player movement: INDESTRUCTIBLE_WALL, DESTRUCTIBLE_WALL, CHEST, DESTRUCTIBLE_CRATE, DESTRUCTIBLE_BARREL, INDESTRUCTIBLE_CRATE, and EXIT. Only EMPTY tiles are walkable. Destructible tiles must be destroyed before a player can walk through them.

## 5.8 Enriched Tile Collision

Tile collision uses **polygon collider data parsed from TMX map files** as the primary collision source. Each tile sprite can define one or more collider polygons (rectangles or arbitrary polygons) in tile-local coordinates. These are transformed to world space using the sprite's rotation and flip settings.

**Collision priority (enriched-first):**
1. If a tile has polygon collider data, SAT (Separating Axis Theorem) collision is tested against the actual polygon shapes. The MTV (Minimum Translation Vector) provides the collision normal and penetration depth.
2. If a tile has no polygon collider data (or no enriched data is available), the full tile AABB (tileSize × tileSize) is used as fallback.

**Where enriched collision applies:**
- Player movement resolution (`CollisionService`)
- Projectile tile collision for arrows (`RangedHandler`) — sub-step walk uses enriched check at each step
- Projectile tile collision for thrown weapons (`ThrowHandler`) — bounce reflection uses MTV normal from enriched collision
- Client prediction (`MapRenderer.isWalkable`)

**Where grid-only collision applies:**
- Player-to-player collision (AABB)
- Projectile-to-player collision (distance-based proximity)
- Projectile-to-destructible collision (distance-based proximity)

**Key rule:** When enriched data says "no collision" (SAT returns no overlap), the entity passes through — even if the grid tile type is solid. The enriched collider data is authoritative over the grid tile type. This allows entities and projectiles to navigate through visual gaps in partially-solid tiles.

---

# 6. Weapon System

## 6.1 Weapon Roster (16 weapons)

### 6.1.1 Melee — ARC Attack (90-degree arc, 45 degrees each side of facing direction)

| # | Weapon | Tier | Damage | Range (px) | Cooldown (ms) | Knockback | Durability | Sprite |
|---|--------|------|--------|------------|---------------|-----------|------------|--------|
| 1 | Fists | — | 5 | 128 | 400 | 0 | infinite | (none, default) |
| 2 | Dagger | Common | 8 | 160 | 300 | 5 | 20 | weapon_dagger |
| 3 | Short Sword | Common | 12 | 192 | 450 | 8 | 20 | weapon_sword |
| 4 | Long Sword | Uncommon | 18 | 224 | 600 | 15 | 15 | weapon_longsword |
| 5 | Hammer | Rare | 22 | 192 | 800 | 25 | 10 | weapon_hammer |
| 6 | Large Axe | Uncommon | 20 | 208 | 700 | 20 | 15 | weapon_axe_large |
| 7 | Bladed Axe | Rare | 25 | 224 | 750 | 22 | 10 | weapon_axe_blades |
| 8 | Double Axe | Legendary | 30 | 240 | 850 | 30 | 8 | weapon_axe_double |

### 6.1.2 Melee — LINE Attack (thrust in facing direction)

| # | Weapon | Tier | Damage | Range (px) | Cooldown (ms) | Knockback | Durability | Sprite |
|---|--------|------|--------|------------|---------------|-----------|------------|--------|
| 9 | Spear | Common | 15 | 320 | 500 | 10 | 20 | weapon_spear |
| 10 | Polearm | Uncommon | 22 | 384 | 700 | 20 | 15 | weapon_pole |
| 11 | Staff | Common | 10 | 288 | 400 | 5 | 20 | weapon_staff |

### 6.1.3 Thrown (travels in facing direction, bounces off walls)

| # | Weapon | Tier | Damage | Range (px) | Cooldown (ms) | Knockback | Max Bounces | Durability | Sprite |
|---|--------|------|--------|------------|---------------|-----------|-------------|------------|--------|
| 12 | Throwing Axe | Common | 15 | 800 | 500 | 8 | 3 | 20 | weapon_axe |

**Throwing Axe Melee Mode:** Throwing Axe also has a melee ARC attack: Damage=10, Range=160px, Cooldown=400ms, Knockback=5. This makes the Throwing Axe a dual-mode weapon — it can be used both as a thrown projectile and as a close-range melee weapon.

**Dual Attack Modes:** Left-click performs a melee ARC attack (10 dmg, 160px range, 400ms cooldown, 5 knockback). Right-click throws the weapon (15 dmg, 800px range, 500ms cooldown, 8 knockback, 3 bounces). Each mode has independent cooldowns.

### 6.1.4 Ranged (fires projectile in facing direction)

| # | Weapon | Tier | Damage | Range (px) | Cooldown (ms) | Knockback | Projectile Speed | Durability | Sprite |
|---|--------|------|--------|------------|---------------|-----------|------------------|------------|--------|
| 13 | Short Bow | Common | 10 | 1200 | 500 | 3 | 600 | 20 | weapon_bow |
| 14 | Crossbow | Rare | 25 | 1600 | 1000 | 12 | 600 | 10 | weapon_bow_arrow |

Bow durability functions as ammo. Each arrow fired costs 1 durability. At 0 durability, the bow breaks like any other weapon (0.2s stagger + auto-switch). No separate ammo pickup exists.

### 6.1.5 Shield (active blocking)

| # | Weapon | Tier | Block Effect | Block Arc | Stagger on Break | Durability | Thrown Range (px) | Thrown Knockback | Thrown Damage | Thrown Speed (px/s) | Sprite |
|---|--------|------|-------------|-----------|---------------|------------|-------------------|------------------|---------------|---------------------|--------|
| 15 | Small Shield | Common | 100% (full negation) | 90 deg front | 0.3s | 15 | 800 | 10 | 15 | 400 | shield_curved |
| 16 | Large Shield | Uncommon | 100% (full negation) | 90 deg front | 0.3s | 25 | 600 | 15 | 20 | 375 | shield_straight |

Shields block 100% of incoming damage from player attacks (melee, thrown, arrows). Shields do NOT block environmental damage (barrel explosions, trap damage, zone damage, siege crush). Blocked attacks deal 0 damage AND apply 0 knockback to the defender. Each blocked attack costs 1 durability.

## 6.2 Weapon Mechanics

### 6.2.1 Attack Types

- **ARC**: Swing in 90-degree arc centered on facing direction. Hits all entities in arc within range. ARC inner radius starts at the player's edge (48px from center). No gap between player and arc hitbox. Costs 1 durability per entity hit. **Walls block melee**: if an INDESTRUCTIBLE_WALL or DESTRUCTIBLE_WALL tile is between the attacker and a target within the arc, the hit is blocked by the wall. The wall does not take damage from the blocked hit.
- **LINE**: Thrust in facing direction. Hits ALL entities in path within its width (20px total, 10px each side of the ray center). Costs 1 durability per entity hit. Not limited to "first entity" — multiple entities at similar distances within width are all hit. **Walls block melee**: LINE stops at the first wall tile encountered, cannot hit targets behind walls.
- **THROWN**: Weapon flies in direction. Bounces off walls (0.7 bounce coefficient). Max 3 bounces. Source player immune for 100ms after throw. Weapon becomes a pickup where it stops. Wall bounces cost 1 durability per bounce. Entity hits cost 1 durability per entity. After 100ms immunity expires, bounced thrown weapons CAN damage the thrower (self-damage).
- **RANGED**: Fires projectile (arrow) at 600 px/s. Travels until hitting entity or wall. Arrows disappear on wall hit — no ground pickup, no visual. Arrows disappear on player hit — no ground pickup. Each arrow fired costs 1 durability regardless of whether it hits anything. Arrows collide with all solid tile types: INDESTRUCTIBLE_WALL, DESTRUCTIBLE_WALL, DESTRUCTIBLE_BARREL, INDESTRUCTIBLE_CRATE, DESTRUCTIBLE_CRATE, and DOOR_CLOSED.
- **SHIELD**: Hold to block. Negates 100% of damage from player attacks within 90-degree front arc. 0 knockback on blocked attacks. 50% movement speed while blocking. Breaks at 0 durability -> 0.3s stagger. No max block duration — can turtle until durability runs out.

**Throw Speed Per Weight Tier:** `throw_speed = 400 - (weight_tier × 25)` px/s
- Light (Dagger, Staff, Throwing Axe, Small Shield): 400 px/s
- Medium (Short Sword, Spear, Large Shield): 375 px/s
- Heavy (Long Sword, Large Axe, Bladed Axe, Polearm): 350 px/s
- Very Heavy (Hammer, Double Axe, Short Bow, Crossbow): 325 px/s
- All weapons are throwable (including bows). Bows thrown use Very Heavy speed (325 px/s), their Range stat as throw range, and their Damage stat as throw damage.

**Projectile Hitboxes:** Projectile hitboxes use simple geometry matching the weapon/arrow sprite dimensions. Arrows use a narrow rectangle: 16px wide × 64px long along travel direction. Thrown weapons use a square matching the weapon render size (64×64px). **Wall occlusion**: INDESTRUCTIBLE_WALL and DESTRUCTIBLE_WALL block both ARC and LINE melee hitboxes. Projectiles (arrows, thrown weapons) are blocked by all solid tiles. **Tile collision uses enriched polygon data** (see §5.8): projectiles check against the actual collider polygons parsed from TMX data via SAT, not the full tile AABB. If a tile has no polygon colliders, the full tile AABB is used as fallback. This allows projectiles to pass through gaps in partially-solid tiles (e.g., diagonal wall edges) that the coarse grid marks as solid.

### 6.2.2 Tiers

> **CORRECTED 2026-07-27** — see §0 + ADR-0029. Durability now SCALES UP with tier
> (the old decreasing table was inverted). The "Durability" column below is the
> BASE (`DURABILITY_BY_TIER`); bows and shields apply a multiplier (bows 1.5×,
> small shield 1.5×, large shield 2.0×). `TIER_STAT_MULTIPLIER` scales damage /
> range / knockback and is (1.0, 1.25, 1.75, 2.0) in code.

| Tier | Color Tint | Base Durability | TIER_STAT_MULTIPLIER | Map Spawn Weight (%) |
|------|-----------|-----------------|----------------------|-------------------|
| Common | White (no tint) | 8 | 1.0 | 70% |
| Uncommon | Green (#37D98C) | 10 | 1.25 | 20% |
| Rare | Blue (#5B7FFF) | 15 | 1.75 | 8% |
| Legendary | Gold (#FFD700) | 20 | 2.0 | 2% |

These weights apply to weapons that spawn directly on the ground (not from crates or chests). Used across all sector types as the base distribution for map-placed weapon spawns.

### 6.2.3 Durability

- **Melee attacks**: Durability is consumed ONLY when hitting an entity (player, destructible crate, barrel, chest). Hitting a wall or empty space costs 0 durability. (`MELEE_WALL_HIT_DURABILITY_COST` is declared as 1 but is dead code — never consumed — so walls effectively cost 0.)
- **ARC multi-hit**: Costs 1 durability per entity hit. Hitting 3 players with one ARC swing costs 3 durability.
- **Thrown weapons**: Lose 1 durability per wall bounce AND 1 durability per entity hit. Every throw guarantees at least 1 durability loss (the weapon always contacts something — wall, entity, or floor).
- **Thrown self-damage rule**: After the 170ms source immunity expires, a bounced thrown weapon CAN hit and damage the thrower.
- Shield blocking: loses 1 durability per blocked attack
- Fists have infinite durability (no durability tracking)
- Weapon breaks at 0 durability — removed from inventory, visual break effect
- When a non-shield weapon breaks (durability reaches 0), the player is staggered for 0.2 seconds (cannot act). After the stagger expires, the player automatically switches to the lowest-numbered occupied slot (slot 2 first, then 3, then 4). If all empty, revert to Fists. Switching is blocked during stagger — auto-switch is queued and executes when stagger ends.
- Dead players drop all inventory weapons as ground pickups (weapons persist indefinitely, never despawn)
- Players CAN carry duplicate weapon types (two daggers, two shields, etc.) in different slots

### 6.2.3b Durability Resolution

Durability is deducted per-hit, sequentially. When a weapon with 1 durability hits multiple entities in one tick (e.g., ARC hitting 3 entities), each hit deducts 1 durability immediately. If durability reaches 0 mid-sequence, the weapon breaks and the remaining hits deal 0 damage. The break triggers stagger immediately at the point of durability exhaustion.

### 6.2.4 Inventory

- 4 slots per player
- Start with Fists in slot 1 (cannot be removed or swapped)
- Slots 2-4 can hold any weapon picked up from ground
- Pick up weapons by pressing E near ground pickup
- When inventory full, pressing E swaps with currently held weapon (drops old weapon)
- Switch slots with 1-4 keys or scroll wheel
- No manual drop (no Q-to-drop). Only swap when picking up another weapon.
- Duplicate weapon types allowed (two daggers in two separate slots, each with independent durability)

### 6.2.5 Weapon Pickups

- Dropped weapons persist on ground indefinitely (never despawn)
- Show weapon sprite on ground with tier color tint
- Pickup radius: `PICKUP_RADIUS` = **72px**
- When multiple weapons are within pickup range, the closest weapon is picked up first regardless of tier. Among same-distance weapons, highest tier wins (Legendary > Rare > Uncommon > Common).

### 6.2.6 Throwing Rules

- Any weapon can be thrown EXCEPT Fists. Melee weapons, ranged weapons (bows), and shields are all throwable. Fists are permanently bound to slot 1 and cannot be thrown.
- Shields CAN be thrown like any other weapon. When thrown, a shield becomes a projectile that bounces and deals damage like a thrown weapon.
- Throwing removes the weapon from your inventory; you revert to fists if it was your last weapon
- Thrown weapon becomes a projectile that bounces off walls (0.7 bounce factor, max 3 bounces)
- Thrown weapon damages players on contact, then bounces off (counts as a bounce), and continues traveling. Can hit multiple players across bounces.
- **Thrown Damage Rule**: Any weapon deals its listed Damage stat when thrown, regardless of weapon type. A thrown Short Sword deals 12 damage, a thrown Hammer deals 22 damage, etc. There is no separate "thrown damage" stat.
- **Durability per wall bounce**: 1 durability lost per wall bounce. Entity hits also cost 1 durability per entity. Minimum 1 durability lost per throw.
- After the weapon stops (bounces exhausted or hits ground), it becomes a ground pickup that ANY player can pick up with E — including the original thrower
- Thrown weapons in flight CANNOT be picked up by any player — only ground-state weapons are interactable
- Thrown weapons have rotation animation and trail VFX during flight
- Throwing physics is server-authoritative with client prediction and server reconciliation
- Source player is immune to their own thrown weapon for 100ms after release. After 100ms, bounced weapons CAN hit and damage the thrower (self-damage possible).
- **Throw Restrictions**: Throwing is blocked during: attack windup, attack cooldown, stagger, dash, and fresh spawn (invincibility) status.
- If a thrown weapon's durability reaches 0 during flight (from wall bounces or entity hits), the weapon shatters and is permanently destroyed. It does NOT become a ground pickup.

**Per-Weapon Throw Range:** Each weapon uses its own Range stat as the maximum flight distance when thrown. THROW_RANGE (1500px) is a global maximum cap. If a weapon's Range stat exceeds 1500px, it is capped. Example: Throwing Axe has Range=800px, so it travels at most 800px before landing. Long Sword has Range=224px when thrown.

**Per-Weapon Throw Speed:** See Section 6.2.1 — throw speed varies by weight tier (325-400 px/s).

### 6.2.7 Attack Rate Limit

- Maximum 10 attacks per second (minimum 100ms between attacks)

### 6.2.8 Weapon Switching

- Switch time: 0.15 seconds (animation plays during switch)
- Can switch during: movement, dashing, blocking
- Cannot switch during: attack windup, attack cooldown, stagger, throw in flight
- When current weapon breaks: 0.2s stagger. Switching is BLOCKED during stagger. After stagger expires, auto-switch to lowest-numbered occupied slot (slot 2 first, then 3, then 4). If all empty, revert to Fists (slot 1).

### 6.2.9 Shield Active Use

Shield weapons follow the same input system as all weapons. ATTACK (left-click / right stick hold on mobile) activates blocking. THROW (right-click / throw button on mobile) throws the shield. Shield has no separate input — block IS the attack function.

### 6.2.10 Inventory Pickup Rules

**Inventory Full + Holding Fists:** If the player is holding Fists (slot 1) and inventory is full (slots 2-4 occupied), pressing E near a weapon auto-drops the lowest-tier weapon in slots 2-4 and replaces it with the pickup. If tied in tier, drops the one in the highest slot number.
**Pickup Priority:** When multiple interactables (chest, weapon, power-up) are in range, the closest one takes priority regardless of type.
**Pickup During Attack:** Weapon/power-up pickup is blocked during attack windup and cooldown. Must wait for current attack to complete.
**Simultaneous Pickup:** If two players attempt to pick up the same weapon in the same server tick, the player with the lowest ID wins.

### 6.2.11 Shield Boomerang Throw

When a shield is thrown, it follows boomerang physics:
- Shield travels outward in facing direction up to its max range at its throw speed (Small: 400 px/s, Large: 375 px/s)
- **Throw durability cost**: The throw itself costs 1 durability, deducted when the shield returns or lands
- If it hits NO entities and NO walls: shield tracks back to the thrower's current position (curved return path). On arrival, 1 durability is deducted. Shield returns to inventory. If this deduction brings durability to 0, the shield shatters and is lost (does not return to inventory).
- If it hits a wall: normal bounce mechanics apply (0.7 factor, max 3 bounces, 1 durability per bounce). Boomerang logic is cancelled. Shield becomes a regular thrown projectile.
- If it hits a player/destructible: deals thrown damage, bounces off, 1 durability lost. Drops as ground pickup. Boomerang logic is cancelled.
- If thrower dies mid-flight: shield drops at its current position as a ground pickup.
- Small Shield boomerang speed: 400 px/s. Large Shield boomerang speed: 375 px/s.
- **Boomerang Return to Inventory**: On successful return, the shield attempts to return to its original inventory slot. If that slot is occupied by another weapon, the occupying weapon is dropped as a ground pickup and the shield takes the slot. If the thrower has no free slots and is holding Fists, the lowest-tier weapon is dropped per standard inventory rules (Section 6.2.10).
- **Shield Throw Cooldown**: 500ms cooldown after throwing a shield before another throw can be initiated.

---

# 7. Combat System

## 7.1 Damage Flow

```
1. Attacker initiates attack (melee swing, throw, or ranged shot)
2. Attack validator checks: cooldown ready? durability > 0? correct input?
3. Hit detection: ARC -> AABB sweep, LINE -> raycast, THROWN/RANGED -> projectile collision
4. Damage calculation: base weapon damage x modifiers
5. Shield check: if target is blocking AND attack comes from front 90-degree arc -> reduce damage by block %
6. Barrier/Fresh Spawn check: if target has invincibility from Barrier or Fresh Spawn -> skip damage
7. Apply damage to target health
8. Apply knockback (force x direction)
9. Track damage source for kill credit
10. Emit domain event (PlayerDamaged, PlayerKilled, etc.)
```

## 7.2 Player Stats

> **CORRECTED 2026-07-27** — see §0 Implementation Reality for the authoritative values.

| Stat | Value |
|------|-------|
| Base Health | 100 |
| Max Health | 100 |
| Base Speed | 430 px/s (`BASE_SPEED`) |
| Dash Speed | 860 px/s (430 × `DASH_SPEED_MULTIPLIER` 2.0) |
| Dash Duration | 0.5s |
| Dash Cooldown | 2.5s |
| Hitbox | 96 x 96 px |
| Spawn Invincibility | 3s |
| Knockback Force | 2000 (`KNOCKBACK_FORCE`, passed for trap/siege contexts; weapon knockback is per-weapon × VELOCITY_SCALE 20, NOT clamped) |
| Knockback Decay | 2000 linear/tick (`KNOCKBACK_DECAY`) |

## 7.3 Shield Mechanics

> **CORRECTED 2026-07-27** — see §0 Implementation Reality. The original text
> described a "hold ATTACK to block" model that does not match the shipped code.
> Blocking is PASSIVE.

- **Passive auto-block**: a shield blocks automatically whenever it is the active
  weapon, the attack arrives within the shield's frontal arc, and the holder is
  not fresh-spawn / staggered / dashing. **No input is required.**
- **ATTACK performs a bash**: with a shield equipped, ATTACK executes an offensive
  bash (damage + knockback in a 120° arc, costs 1 durability on hit). The bash
  does NOT control blocking — the player can bash and still auto-block.
- Block arc: **Small Shield 90°**, **Large Shield 180°** (frontal, centered on
  facing direction).
- **100% damage negation**: Blocked attacks deal 0 damage. No damage leaks through.
- **0 knockback on block**: Blocked attacks apply no knockback to the defender.
  Shield absorbs all force (the defender holds position so repeated blocks don't
  shove them out of melee range).
- Shields can block both melee attacks AND projectiles (arrows, thrown weapons)
- Blocked arrows disappear on impact
- Blocked thrown weapons bounce off the shield in the reflection direction (angle
  of incidence = angle of reflection). The bounce counts toward the thrown
  weapon's max bounce count (6). After the 170ms source immunity, the bounced
  thrown weapon CAN hit the thrower (self-damage).
- Each blocked attack costs 1 shield durability
- Movement speed reduced to 50% while the shield is raised (auto-applies while a
  shield is the active weapon and the holder is blockable)
- No max block duration — the shield blocks indefinitely until durability runs out
- Shield breaks at 0 durability -> stagger (per-weapon `staggerOnBreakMs`, 300ms
  for shields; default `SHIELD_BREAK_STAGGER` 0.5s)
- Shields can only block player-caused attacks (melee swings, thrown weapons,
  arrows). Environmental damage sources (zone damage, barrel explosions, trap
  damage, siege crush) bypass shield blocking entirely.

## 7.4 Throwing Physics

- Weapon thrown in cursor/aim direction
- Throw speed is per-weapon (`throwSpeed` in definitions.ts): Dagger 2000, Short
  Sword 1500, Long Sword 1200, Hammer/Large Axe/Bladed Axe/Double Axe 1000, Spear
  1600, Polearm/Staff 1300, Throwing Axe 1800, Small/Large Shield 1200. (The old
  "400 − tier×25" formula is stale.)
- Bounces off walls and indestructible tiles with 0.75 coefficient. **Bounce reflection uses the actual collider surface normal** (from SAT collision MTV), not axis-aligned grid sampling. This produces physically correct bounces against diagonal and curved collider edges.
- Max 6 bounces (`MAX_BOUNCES`), then stops and becomes ground pickup. Individual weapons may cap lower (Throwing Axe: 3).
- Wall bounces cost 1 durability per bounce
- Entity hits cost 1 durability per entity
- Source player immune to their own thrown weapon for 170ms
- After 170ms immunity, bounced thrown weapons CAN damage the thrower (self-damage possible)
- Thrown weapons in flight cannot be picked up by any player

**Thrown Weapon Bounce on Player Hit:** When a thrown weapon hits a player (unblocked), it bounces using reflection physics (angle of incidence = angle of reflection) based on the collision normal between the weapon's trajectory and the player's hitbox center.

**Thrown vs Invulnerable Players:** Thrown weapons bounce off invulnerable players (Barrier, Fresh Spawn) normally, consuming a bounce and 1 durability. The invulnerable player takes 0 damage.
- Bounces off walls and indestructible tiles with 0.7 coefficient. **Bounce reflection uses the actual collider surface normal** (from SAT collision MTV), not axis-aligned grid sampling. This produces physically correct bounces against diagonal and curved collider edges.
- Max 3 bounces, then stops and becomes ground pickup
- Wall bounces cost 1 durability per bounce
- Entity hits cost 1 durability per entity
- Source player immune to their own thrown weapon for 100ms
- After 100ms immunity, bounced thrown weapons CAN damage the thrower (self-damage possible)
- Thrown weapons in flight cannot be picked up by any player

**Thrown Weapon Bounce on Player Hit:** When a thrown weapon hits a player (unblocked), it bounces using reflection physics (angle of incidence = angle of reflection) based on the collision normal between the weapon's trajectory and the player's hitbox center.

**Thrown vs Invulnerable Players:** Thrown weapons bounce off invulnerable players (Barrier, Fresh Spawn) normally, consuming a bounce and 1 durability. The invulnerable player takes 0 damage.

## 7.5 Knockback

- Applied on hit in direction from attacker to target
- Each weapon has a fixed knockback value defined in WeaponRegistry (see §6.1 roster tables for per-weapon values)
- Knockback is applied as velocity (px/s), not distance. Velocity decays linearly by KNOCKBACK_DECAY (5/s) each tick
- Capped at KNOCKBACK_FORCE (300 px/s maximum velocity)
- Clamped to wall boundaries (no knockback through walls)
- Knockback stops at walls and other players with no additional effect. The knocked player is pushed to the wall/player surface and stops. No impact damage from wall collision.
- Knockback does not transfer between players. If Player A is knocked into Player B, Player A stops at Player B's position. Player B is unaffected.
- **Knockback into traps**: Knockback can push players into traps. The trap activates normally in addition to any knockback damage already received. The simulation is compounding — knockback and trap effects are not mutually exclusive.
- **Knockback on blocked attacks**: Shield blocks negate knockback entirely (0 knockback applied to defender).
- **Knockback Replacement**: New knockback overwrites existing knockback velocity (replacement, not additive). A new hit applies its full knockback, replacing any remaining velocity from a previous hit. This prevents infinite velocity exploits from rapid hits.

## 7.6 Friendly Fire

- Disabled for direct attacks. Players cannot damage themselves with their own melee swings, arrows, or initial thrown weapon impact.
- **Exception — Thrown weapon self-damage:** After the 100ms source immunity expires, a bounced thrown weapon CAN hit and damage the thrower. This is the only form of self-damage in the game.
- Since this is solo FFA, "friendly fire" equals self-damage. All other player-to-player attacks deal full damage (there are no teams).

## 7.7 Dash Behavior

- Dash ignores player collision — player can dash through other players
- Players being dashed through are unaffected (no push, no damage)
- Dash does NOT ignore wall/tile collision — still blocked by walls
- All actions (attack, throw, block, dash) can be performed while moving — full movement freedom
- No movement lock during attacks
- **Dash direction**: If movement input is active (WASD), dash goes in movement direction. If no movement input (standing still), dash goes in facing direction (cursor direction on desktop, right stick on mobile). Dash always succeeds when pressed.

**Dash Restrictions:**
- Cannot attack during dash
- Cannot throw during dash
- Cannot block during dash
- Cannot pick up items during dash
- Can switch weapons during dash
- Dash is disabled during stagger (cannot dash to escape stagger)

## 7.8 Projectile Lifetime

- All projectiles (arrows, thrown weapons) travel until they hit an entity, hit a wall, or reach their max range
- No time-based expiration

## 7.8.1 Dead Body vs Own Projectile

A dead player's projectiles (thrown weapons, arrows) pass through their own dead body without collision. No self-damage post-mortem.

## 7.9 Fresh Spawn Status

- When a player spawns at match start, they have a "Fresh Spawn" status for 3 seconds
- During Fresh Spawn: player CAN move, pick up weapons/power-ups (E key and walk-over), open chests, and switch weapon slots.
- During Fresh Spawn: player CANNOT attack, throw weapons, block (with shield), or dash.
- During Fresh Spawn: player is invulnerable to all damage (player attacks, zone, traps, barrel explosions). Siege crush still kills.
- After 3 seconds: normal gameplay begins

**Fresh Spawn Visual Indicator:** Protected players flicker/flash at 5Hz (5 flashes per second) for the 3s duration. The player model alternates between full opacity and 30% opacity. This makes it visually clear to other players that the target is invulnerable.

## 7.10 Direction System

- Players face a continuous 360-degree angle based on mouse cursor position (desktop) or right stick direction (mobile). There is no directional snapping. The Direction enum (UP/DOWN/LEFT/RIGHT) is used for movement input only, not for facing direction. Facing direction is a float angle in radians.

## 7.11 Zone Death Credit

- When a player dies to zone damage, no player receives kill credit. The kill feed shows "[PlayerName] was eliminated by the zone". The leaderboard shows zone deaths as "environmental" kills.

## 7.12 Dash Speed

- Dash speed is always 2× BASE speed (860 px/s), regardless of speed boosts or other modifiers. Speed boost does NOT affect dash speed.

## 7.13 Damage Stacking

- All damage-over-time effects stack. If a player is standing in a fire trap area (5 HP/s area DOT) AND is outside the zone (8 HP per 0.5s tick), they take both damage sources concurrently. No damage source cancels another.
- **Fire Trap Area Re-application**: If a player triggers another fire trap while already standing in a fire area, the new trap ignites its own 3×3 area — areas are independent. Re-triggering the SAME fire trap while its area is active resets the duration timer to 5 seconds (does not stack — same source).

## 7.14 Visual Feedback

- **Damage Numbers**: Floating numbers appear on hit. White text for damage dealt. Green text for healing. Numbers float upward and fade over 1 second.
- **Player Labels**: Player name displayed above each player character. No health bars above other players — health is only shown in the player's own HUD.
- **Zone Rendering**: Safe zone appears normal. Area outside zone has a red-tinted overlay with animated border line at the zone edge.
- **Kill Feed**: Top-right corner below minimap. Shows "[PlayerName] eliminated [PlayerName] with [Weapon]". Shows last 5 events. Fades after 5 seconds.
- **Throw VFX**: Thrown weapons rotate during flight with trail particle effect.
- **Hit Flash**: Player flashes white on taking damage (~100ms duration). Brief freeze frame (50ms) on kill — client-side visual only (rendering pause on the witnessing player's client, not a server tick pause).

## 7.15 Barrel Explosions

- When a barrel is destroyed (by any attack), it explodes
- **Destruction triggers (juice-pass-1 ticket 05):** destroyed by any attack, OR fuse expiry — a barrel whose 5 s primed fuse (see §5.5 Barrels) expires auto-explodes identically to a normal destruction (same damage, rays, chain, cap; no special-casing)
- Explosion: 8 directional rays from barrel center, each traveling exactly 2 tiles (grid distance — diagonal rays also reach 2 tiles for consistent 5x5 coverage). This creates a 5x5 blast area centered on the barrel.
- Explosion damage: 50 to all entities on ray paths (no distance falloff)
- Rays blocked by: INDESTRUCTIBLE_WALL, INDESTRUCTIBLE_CRATE, map borders, active siege walls
- Rays hit destructible entities: entity takes 50 damage, ray stops at that tile (does not continue through). Destructible walls absorb the blast even though the wall is destroyed — tiles behind the wall are safe.
- Off-axis tiles (between ray paths) are NOT damaged. Players and destructibles are only affected if on a ray path.
- Destructibles in ray path are instantly destroyed (crates 1 HP, barrels 2 HP, destructible walls 5 HP)
- Destroyed barrels trigger their own explosion recursively (natural propagation, bounded by geography — a barrel outside any blast's 5x5 area is never affected)
- All explosions resolve instantly in a single simulation tick (no progressive propagation, no deferred chains)
- Safety cap: maximum 20 barrel explosions per resolution (sanity guard against pathological maps)
- Barrel explosions damage all players in ray path, including the player who triggered the explosion. Barrel damage is environmental and not subject to self-immunity rules.
- Crates destroyed by barrel explosions generate loot drops (60% chance, same drop table as player-destroyed crates)
- Overlapping explosions stack damage: a player in two blasts takes 50 + 50 = 100 total
- Client VFX: staged particle spread over ~0.2s is cosmetic only — all damage resolves instantly

## 7.16 Attack Timing

All attacks have a brief windup phase before damage is delivered:
- Fast weapons (Dagger, Throwing Axe, Small Shield): 0.1s windup
- Medium weapons (Short Sword, Spear, Staff, Large Shield, Short Bow): 0.15s windup
- Slow weapons (Long Sword, Hammer, Polearm, Crossbow, all axes except Throwing Axe): 0.2s windup
- Fists: 0.05s windup (nearly instant)

Damage is applied at the END of the windup phase. The visual animation (hand thrust, arc swing) plays during windup. Movement is NOT locked during windup (player can move while attacking). Cooldown begins AFTER damage is delivered.

Attack windup cannot be cancelled by any player action. Once an attack begins, it must complete. Only death interrupts the windup.

## 7.17 Knockback Physics

**Per-Weapon Knockback Values:** Each weapon has a fixed knockback value pre-calculated in WeaponRegistry. The GDD formula `BASE_KNOCKBACK × (1 + weight_tier × 0.25)` was used during design to derive these values, but the runtime uses the baked-in per-weapon values directly.

- Direction = normalized(hitPos - attackerPos)
- Velocity = weapon's knockback value (px/s) in the direction from attacker to target
- Velocity is capped at KNOCKBACK_FORCE (300 px/s)
- Velocity decays linearly: velocity -= KNOCKBACK_DECAY × deltaTime each frame
- New knockback OVERWRITES existing velocity (not additive)
- Knockback cancels dash immediately (cooldown starts, full knockback applied)
- Knockback direction = from attacker to target (normalized vector)
- Knockback is resolved along X and Y axes independently (wall collision checked per axis)
- Players cannot be knocked through walls or indestructible tiles
- Knockback velocity is NOT reduced by the blocking 50% speed penalty. Knockback is involuntary displacement, not voluntary movement.
- **Knockback cancels dash:** When a dashing player receives knockback, the dash ends immediately. Dash cooldown begins. Knockback velocity is applied in full. This ensures knockback always takes priority over voluntary movement.

## 7.18 Thrown Weapon vs Destructibles

When a thrown weapon hits a destructible crate (1 HP), the crate is destroyed and the thrown weapon continues traveling (the collision counts as a bounce). The thrown weapon continues in the same direction through the destroyed crate. The bounce COUNT is incremented (toward max 3) and 1 durability is consumed, but no direction change occurs. When a thrown weapon hits a barrel (2 HP), it deals 1 damage to the barrel. The barrel only explodes when its HP reaches 0.

Thrown weapons deal 1 HP to DESTRUCTIBLE_WALL (5 HP) per hit and bounce off, continuing their flight. It takes 5 thrown weapon hits to destroy a DESTRUCTIBLE_WALL.

## 7.19 Arrows vs Destructibles

Arrows from bows interact with destructibles. An arrow destroys a crate (1 HP) on contact and then disappears — it does NOT pass through the crate to hit entities behind it. An arrow hitting a barrel deals 1 damage (the barrel requires 2 hits to explode). An arrow CAN trigger barrel explosions if it delivers the killing blow. Bow durability is consumed per arrow fired (1 durability per shot), regardless of whether the arrow hits anything.

## 7.20 Stagger Behavior

- If already staggered, new stagger effects are ignored. Current stagger must expire before another can be applied.
- Stagger prevents: attacking, throwing, blocking, dashing, weapon switching, and pickup.
- Stagger allows: movement (reduced to 50% speed).
- Weapon break auto-switch is queued during stagger and executes when stagger ends (switching is blocked during stagger).
- **Stagger sources:** Stagger is ONLY triggered by weapon break (0.2s) and shield break (0.3s). Being hit by attacks does NOT cause stagger. The hit/stagger animation in §13.3 is a visual-only feedback effect (flash + freeze frame), not a gameplay stagger.

## 7.21 Invulnerability Source Interaction

Multiple invulnerability sources are tracked independently with separate timers:
- Barrier Power-Up: 10s invulnerability from any damage
- Fresh Spawn: 3s invulnerability + cannot attack/throw
- NO on-hit invincibility — being hit NEVER grants invulnerability frames
These do NOT interact or stack. Each source runs its own timer. Barrier ending does not trigger any post-hit invincibility (no damage was taken).

Barrier invulnerability blocks all player attacks, zone damage, and trap damage. It does NOT prevent siege wall crush damage (physical wall impact is unblockable).
- Timer expiry (barrier, fresh spawn) is processed after zone damage in the tick order (see §15.4). On the tick a barrier expires, the player still blocks zone damage. Zone damage first applies on the tick after barrier expiry.
- **Stagger and invulnerability are independent:** A staggered player with active barrier cannot act but remains immune to damage. Stagger does NOT cancel barrier or vice versa.

## 7.22 Zone Damage Tick

Zone damage applies 8 HP per tick at 0.5s intervals (= 16 HP/s). In sudden death (overtime, zone phase 6+), applies 15 HP per tick at 0.5s intervals (= 30 HP/s). Damage is discrete, not fractional.

## 7.23 Fire Trap DOT

Fire trap ignites a 3×3 tile area centered on the trap. When a player steps on a hidden fire trap: trap is revealed → 15 instant damage → 3×3 area ignites → area DOT begins (5 HP/s to ALL players standing in the area, ticking every 1 second = 5 HP per tick). Area duration: 5 seconds (300 ticks). Re-triggering while the area is active resets the duration timer to 5 seconds. Environmental damage — bypasses shield blocks. After the area expires: trap returns to idle, can be triggered again. Persistent — see **Section 10.2.2** for the authoritative spec.

## 7.24 Death Flow

See **Section 12.9 Death Flow** for the complete death flow sequence.

## 7.25 Kill Feed Event Templates

**Kill Feed Event Types:**
1. Melee Kill: '[PlayerA] eliminated [PlayerB] with [WeaponName]'
2. Thrown Kill: '[PlayerA] eliminated [PlayerB] with thrown [WeaponName]'
3. Arrow Kill: '[PlayerA] eliminated [PlayerB] with [WeaponName]'
4. Zone Death: '[PlayerB] was eliminated by the zone'
5. Trap Death: '[PlayerB] was eliminated by a [TrapType] trap'
6. Barrel Death: '[PlayerB] was eliminated by a barrel explosion'
7. Siege Crush: '[PlayerB] was crushed by the siege'
8. Disconnect: '[PlayerB] disconnected'
9. Self-Elimination (Thrown): '[PlayerName] was eliminated by their own thrown [WeaponName]'

## 7.26 Screen Shake Parameters

- Intensity: 4px offset in random direction
- Duration: 200ms
- Decay: linear from full intensity to zero
- Applied to: camera only (does not affect game coordinates)
- Triggers on: siege wall crush (always), barrel explosion (if <300px from player), player death nearby (if <256px from player)

## 7.27 Projectile-vs-Projectile Collision

If two thrown weapons (or a thrown weapon and an arrow) collide mid-air, both projectiles immediately drop as ground pickups at the collision point.

**Note**: This is an explicit exception to the general arrow rule (arrows disappear on hit, Section 6.2.1). Arrows that collide mid-air with another projectile become a ground pickup instead of disappearing.

## 7.28 Teleport Trap

Teleports player to a random walkable tile anywhere on the map. No restrictions — can teleport into siege zones, zone damage areas, or near other traps. The destination must be a floor tile not occupied by a wall or player. If the destination becomes occupied mid-teleport, the nearest unoccupied floor tile is used instead. Teleport traps bypass DamageService entirely — they are position displacement, not damage. Invulnerability does NOT prevent teleport displacement.

## 7.29 Barrel Explosion Raycast

- 8 directional rays (N, NE, E, SE, S, SW, W, NW) from barrel center
- Each ray steps up to 2 tiles instantaneously (all damage resolves in a single tick)
- Ray stops at: INDESTRUCTIBLE_WALL, INDESTRUCTIBLE_CRATE, map borders, active siege walls
- Siege walls block rays identically to INDESTRUCTIBLE_WALL. A tile with an active siege wall is impassable.
- Ray stops at destructible entities: entity takes 50 damage, ray stops at that tile. Does not continue through destroyed entities.
- Ray stops at DESTRUCTIBLE_WALL grid tiles: wall destroyed, grid cleared, tiles behind are safe.
- Each ray travels exactly 2 tiles (grid distance — diagonal rays also reach 2 tiles for consistent 5x5 coverage)
- Players on ray path take 50 damage (environmental — bypasses shield blocks, damages triggerer)
- Destroyed barrels trigger recursive explosion (bounded by geography, safety cap of 20 total explosions)
- Overlapping explosions stack damage (50 per explosion independently)
- Player damage deduplicated per explosion: same explosion cannot hit same player twice via different rays
- Crates destroyed by barrel explosions DO trigger loot drops (60% chance, standard table)
- Resolution is instant — all damage and destruction in a single simulation tick

## 7.30 Death During Attack Windup

If a player dies during attack windup (before damage is delivered), the attack is cancelled. Damage is NOT applied to targets. The weapon's cooldown is NOT triggered (the attack never completed). Durability is NOT consumed.

## 7.31 Simultaneous Projectiles

A player can have multiple thrown weapons in flight simultaneously (throw slot 2, switch to slot 3, throw slot 3). No limit on simultaneous projectiles per player. All projectiles retain kill credit for the thrower even if the thrower dies (posthumous kills).

## 7.32 Siege Wall Warning Tile Walkability

During the 0.5s siege wall warning animation, the tile remains walkable. Players can walk onto, dash onto, or be knocked back onto the warning tile. When the 0.5s expires and the wall solidifies, any player on the tile takes SIEGE_CRUSH_DAMAGE (100, instant kill).

## 7.33 PlayerStatus State Machine

The PlayerStatus bitmask (defined in §20) has strict invariant rules:

- **ALIVE and DEAD are mutually exclusive** — a player has exactly one at a time.
- **SPECTATING requires DEAD** — a player cannot spectate while alive.
- **STAGGERED requires ALIVE** — dead players cannot stagger.
- **INVINCIBLE requires ALIVE** — dead players have no invincibility.
- **FRESH_SPAWN requires ALIVE** — dead players lose fresh spawn status.
- **DYING (64) is a new flag:** When HP reaches 0, the player transitions ALIVE→DYING (immediate). After the 0.5s death animation, the player transitions DYING→SPECTATING. The DYING flag replaces the ALIVE flag — a dying player is NOT alive. During DYING state: body retains collision, weapons have already been dropped, active effects are cancelled, and NO new damage is applied to the dying player.

---

# 8. Zone System

## 8.1 Zone System: The Siege

The zone combines BR-style circle shrinking with Bomberman-style wall dropping. When the safe zone boundary crosses a sector, that sector enters **Siege Mode**: indestructible walls begin crashing down from the sector's edges, progressively walling it off from outside to inside.

### 8.1.1 Zone Phases (6 phases, 255s total)

| Phase | Name | Duration (s) | Safe Zone Radius | Damage Outside | Siege Behavior |
|-------|------|---------------|-----------------|----------------|----------------|
| 1 | Drop | 60 | 100% (full map) | None | No siege. All sectors safe. Phase 1 guard prevents siege checks entirely — the inscribed zone circle (radius = mapWidth/2) does not cover diagonal corners, so siege is disabled during this phase regardless of map geometry. |
| 2 | First Closure | 45 | 60% of initial radius | 16 HP/s (8 per 0.5s tick) | Outer sectors enter siege. Walls drop every 3s per row. |
| 3 | Edge Closure | 45 | 25% of initial radius | 16 HP/s (8 per 0.5s tick) | More sectors sieged. Walls continue dropping. |
| 4 | Final Ring | 45 | 15% of initial radius (768px) | 16 HP/s (8 per 0.5s tick) | Most sectors fully walled. Only center sectors partially open. |
| 5 | Last Sector | 30 | 10% of initial radius (512px) | 16 HP/s (8 per 0.5s tick) | Last open sectors under siege. Walls dropping inward. |
| 6 | Final Closure | 30 | 8% of initial radius (410px, ~5×5 tile area) | 30 HP/s (15 per 0.5s tick) | Minimal arena. Siege continues. |
| OT | Sudden Death | ∞ | 8% (static, no further shrink) | 30 HP/s (15 per 0.5s tick) | Accelerated siege walls (1.5s interval). |

**Zone Center:** The zone center shifts each phase. Phase 1 center is always at the map center (5120, 5120). For each subsequent phase, the new center is randomly selected within the current safe zone, subject to the reachability validation in §8.1.6. The random selection avoids edges (minimum 20% radius from boundary). During the 30-second transition, the center interpolates linearly from the old center to the new center simultaneously with the radius interpolation. Overtime does NOT shift the zone center — the center stays at the Phase 6 target position.

### 8.1.2 Zone Phase Timing

- Each phase has a stable period followed by a 30-second transition period where the zone circle shrinks (stable = duration − 30s; a 30s phase is pure transition).
- Phase 1: 60s total = 60s stable (full map, no shrink, no damage).
- Phases 2-5: Duration = (duration - 30s) stable + 30s shrink transition.
- Phase 6: 30s, zone damage 30 HP/s applies to all players outside the 8% safe zone radius. Players inside the 410px safe circle are safe from zone damage but face siege wall progression.
- Phase 6 follows the same stable+transition pattern: 0s stable + 30s shrink transition (from Phase 5 target to Phase 6 target).
- Zone boundary interpolates linearly from old radius to new radius over the 30-second transition. Zone damage for the new phase applies immediately when the phase begins (even during the transition period).
- The new phase's damage rate applies from the START of the 30-second transition period. For example, Phase 3 damage begins at the transition start, not the transition end.

### 8.1.3 Siege Mode Mechanics

- A sector enters Siege Mode when its CENTER POINT is outside the safe zone circle. This is the sole trigger condition — simple, deterministic, and creates clear visual boundaries.
- In Siege Mode, indestructible walls begin dropping from the sector's outermost row/column that contains at least one empty/floor tile. Siege walls only replace empty/walkable tiles — they do NOT override existing INDESTRUCTIBLE_WALL or INDESTRUCTIBLE_CRATE tiles.
- Wall drop rate: 1 row or column every 3 seconds, cycling through sides sequentially (North → South → East → West → repeat).
- Wall progression: from outer edges toward the sector center.
- Full sector walling time varies by sector layout. Siege continues dropping rows until the sector is fully walled. The "5 rows per side" example is illustrative: 5 rows × 4 sides × 3s/row = 60s. Actual time depends on how many droppable rows exist in the specific sector.
- DESTRUCTIBLE_WALL tiles (5 HP, ID 2) are NOT walkable and are NOT replaced by siege walls. They persist through siege mode and can still be destroyed by player attacks.
- Siege walls destroy all entities on affected tiles: destructible crates, barrels (which explode, triggering chain reactions), chests (unopened chests and their loot are permanently lost), weapon pickups, power-ups, and traps. Siege walls also close corridor openings — corridor tiles are replaced with siege walls, sealing the sector. Only INDESTRUCTIBLE_WALL and INDESTRUCTIBLE_CRATE tiles are not replaced by siege walls.
- Siege wall drop animation: 0.5 second visual warning (wall appears semi-transparent, falling from above). At the end of the animation, the wall becomes solid and crushes anything in the tile. Players in the tile when the wall solidifies take SIEGE_CRUSH_DAMAGE (100, instant kill).
- **Crushing damage**: If a wall drops directly on a player, it deals 100 damage (instant kill). Visual: impact VFX + screen shake.
- Walls are permanent — they permanently change the map topology.
- Players outside the safe circle take zone damage (16 HP/s) AND face wall dropping.
- Wall drop VFX: wall "falls from above" with dust/debris particles. Impact sound. Red flash.
- Dead player bodies on siege wall tiles are removed immediately when the wall solidifies. The death animation timer is cancelled, and the player transitions to SPECTATING early. Siege walls take priority over dead bodies.
- Zone warning: 10s before each phase transition, a warning sound plays and the minimap shows the incoming zone boundary.

**Sector Grid Configuration:** The siege sector layout is derived from the game configuration (`MapConfig.sectorSize` and arena dimensions) rather than hardcoded constants. For the production 80×80 map, the config specifies `sectorSize: 20` with 4 sectors per axis. For test rooms with smaller maps, the sector layout adapts: a 22×22 map with `sectorSize: 22` operates as a single siege sector. The siege system computes `sectorGridSize = ceil(arenaWidth / sectorSize)` and `sectorTileSize = sectorSize` at initialization.

**Siege Wall Network Sync:** Siege wall state is synchronized per-sector via SiegeProgress (currentSide, currentOffset). The client reconstructs wall positions deterministically from sector layout + progress data. No per-tile state is sent over the network.

### 8.1.4 Visual Design

- Safe zone: normal lighting, no overlay.
- Siege zone (outside circle but not yet walled): red-tinted overlay, animated red border at zone edge.
- Walled sectors: darkened overlay, visible wall structures.
- Zone boundary: glowing red siege line on the ground.
- Minimap: red circle showing current safe zone, dashed circle showing next zone size.
- Chat announcement: "Sector [X,Y] is under siege!" when a sector enters siege mode.

### 8.1.5 Zone Constants

| Constant | Value |
|----------|-------|
| ZONE_CENTER_X | 5120 (initial, Phase 1 only) |
| ZONE_CENTER_Y | 5120 (initial, Phase 1 only) |
| INITIAL_ZONE_RADIUS | 5120 (inscribed circle = mapWidth/2). Corner sectors may fall outside this radius. Phase 1 siege guard prevents premature siege activation. |
| ZONE_TICK_INTERVAL | 0.5s |
| ZONE_WARNING_TIME | 10s |
| ZONE_TRANSITION_DURATION | 30s |
| SIEGE_WALL_DROP_INTERVAL | 3s |
| SIEGE_CRUSH_DAMAGE | 100 |
| SIEGE_WALLS_PER_DROP | 1 row or column |

### 8.1.6 Zone Center Validation

Each phase transition that shifts the zone center must validate the new center is reachable:

1. Generate random candidate within the current safe zone, respecting the 20% boundary buffer
2. Check candidate tile is walkable (floor/empty tile, not wall, crate, or siege wall overlay)
3. Pathfind from candidate to the nearest non-sieged sector center using A* on the current tile map (including siege overlay)
4. If reachable: accept the candidate as the new zone center
5. If unreachable or non-walkable: re-randomize (up to `ZONE_CENTER_MAX_ATTEMPTS` attempts)
6. Fallback: use the centroid of the largest connected walkable area within the current zone radius

This ensures the safe zone is always reachable from at least one non-sieged sector. Unreachable safe zones (e.g., center lands on an indestructible wall or inside a fully siege-walled sector) are never generated.

If no walkable tiles exist within the current zone radius, all remaining players take 100 HP/s siege crush damage until the match ends. This guarantees match resolution even in degenerate cases.

| MatchPhase | Zone Phases | Description |
|------------|-------------|-------------|
| WAITING | None | Pre-game lobby |
| COUNTDOWN | None | 5s countdown |
| ACTIVE | 1, 2, 3 | Normal gameplay, zone starts shrinking in phase 2 (0-150s) |
| ZONE_SHRINKING | 4, 5 | Final rings, most sectors under siege (150-225s) |
| FINAL_CLOSURE | 6 | Phase 6 (225-255s) at 8% radius, 30 HP/s |
| OVERTIME | OT | Sudden Death (static 8% radius, 1.5s siege interval), 30 HP/s. Starts at 255s. |
| FINISHED | None | Match ended, results screen |

**Match-End Tiebreaker:** If all remaining players die simultaneously (e.g., siege crush, barrel chain), the player with the most kills is declared winner. If kills are tied, the tiebreaker is total damage dealt. If still tied, highest survival time.

## 8.3 Overtime Siege Escalation (after 255s)

- **Phase 6 (Final Closure, 225-255s):** Zone shrinks to 8% radius (~410px, ~5×5 tile area). 30 HP/s damage to all players outside safe zone. Siege walls continue at normal rate (3s interval).
- **Overtime (255s+):** The match enters Sudden Death. Safe zone radius stays at 8% (no further shrink — radius is static). All remaining sectors receive accelerated siege wall drops (1.5s interval). Zone damage remains 30 HP/s. This ensures the match resolves in a reasonable time as siege walls compress the playable area further.

---

# 9. Power-Up System

## 9.1 Power-Up Types (3)

| Type | Effect | Duration | Spawn Weight |
|------|--------|----------|-------------|
| Health Pack | Heals 30 HP (cannot exceed max health of 100 HP). If the player is already at full health (100 HP), the Health Pack is NOT consumed and remains on the ground. | Instant | 50% |
| Barrier | Invulnerability to all damage sources except siege wall crush. Blocks player attacks, zone damage, and trap damage. Siege wall crush (100 damage) bypasses barrier. | 10 seconds | 25% |
| Speed Boost | Movement speed x 1.75 | 20 seconds | 25% |

## 9.2 Power-Up Mechanics

- Spawn from destroyed crates and as map loot
- Power-ups are auto-collected when a player walks within `PICKUP_RADIUS` (72px) of them. No E key required. Effect is applied instantly on collection. Power-up walk-over bypasses `canPickup()` — powerups auto-collect even during windup/cooldown/dash/stagger (unlike weapons).
- Power-ups persist on the ground indefinitely until picked up. They do not despawn.
- Barrier and Speed Boost effects are visible on player (visual indicator)
- Different power-up effects can be active simultaneously (Barrier + Speed Boost at the same time). Picking up the SAME power-up type while already active refreshes the duration instead of stacking.
- This disambiguates from Shield weapons which provide damage reduction

---

# 10. Trap System

## 10.1 Trap Types (3)

| Type | Effect | Trigger | Sprite | Cooldown |
|------|--------|---------|--------|----------|
| Spike | Deals 25 damage + 0.5s stun + 128px knockback (away from trap center). Persistent — reactivates after cooldown. | Player steps on trap tile | trap (environment sprite) | 1 second |
| Fire | Ignites a 3x3 tile area centered on trap. 15 instant damage on trigger, then the area deals 5 HP/s DOT to all players standing in it for 5 seconds. Re-trigger while active resets duration. Persistent — reactivates from idle after area expires. | Player steps on trap tile | trapdoor_round / trapdoor_square + fire overlay VFX on 3x3 tiles | N/A (re-trigger resets timer) |
| Teleport | Teleports player to a random walkable tile anywhere on the map. Persistent — reactivates after cooldown. | Player steps on trap tile | trap_door / trapdoor_square | 1 second |

## 10.2 Trap Mechanics

- Traps are placed on a layer on top of the floor layer
- Players must physically collide/step on the trap to activate
- Traps are hidden until any player gets within 2 tiles. Once revealed, the trap becomes permanently visible to all players. Revealed traps do not re-hide.
- **Traps are persistent — they are NOT consumed after triggering.** Each trap type has its own cooldown/reactivation mechanic.
- Traps can be spawned during map generation
- Traps activate even when triggered by an invulnerable player (Barrier, Fresh Spawn). The invulnerable player takes 0 damage. Teleport traps still teleport invulnerable players. Spike knockback still applies to invulnerable players.
- Dashing does not prevent trap activation. Players trigger traps normally while dashing.
- **Knockback into traps**: If a player is knockbacked into a trap, the trap activates. The simulation is compounding — the player receives both knockback effects AND trap effects.

### 10.2.1 Spike Trap Details

- Damage: 25 HP
- Stun: 0.5 seconds
- Knockback: 128px (1 tile) instant displacement away from trap center. Player is immediately repositioned (no velocity propagation). Collision-resolved to nearest walkable tile.
- Knockback direction: `normalize(player.position - trap.position)`. If player is exactly on trap center, knock right.
- Landing stagger: 0.3 seconds after displacement completes
- Cooldown: 1 second (60 ticks) between activations
- Visual: White flash tint on trigger (200ms duration)

### 10.2.2 Fire Trap Details

- 15 instant damage on trigger (before the DOT starts)
- Ignites a 3x3 tile area centered on the trap's grid position
- Area DOT: 5 HP per second (ticks every 1 second / 60 ticks) to ALL players standing in the area
- Area duration: 5 seconds (300 ticks)
- Re-triggering while area is active: resets the duration timer to 5 seconds
- After area expires: trap returns to idle state, can be triggered again
- Fire area damage is environmental — bypasses shield blocks
- Visual: Orange/red pulsing overlay on 3x3 tiles

### 10.2.3 Teleport Trap Details

- Teleports triggering player to a random walkable floor tile (EMPTY, not occupied)
- No restrictions — destination can be in siege zone, zone damage area, or near other traps
- Cooldown: 1 second (60 ticks) between activations
- Teleport bypasses DamageService — position displacement only
- Invulnerability does NOT prevent teleport displacement

---

# 11. Chest System

## 11.1 Chest Tiers (4)

| Tier | Color | Spawn Weight |
|------|-------|-------------|
| Common | Brown/Wood | 70% |
| Rare | Blue | 20% |
| Epic | Purple | 8% |
| Legendary | Gold | 2% |

### Chest Loot Tables (Weighted Random)

**Common Chest:**
- Common: 80%, Uncommon: 15%, Rare: 4%, Legendary: 1%

**Rare Chest:**
- Common: 50%, Uncommon: 30%, Rare: 15%, Legendary: 5%

**Epic Chest:**
- Common: 25%, Uncommon: 30%, Rare: 30%, Legendary: 15%

**Legendary Chest:**
- Common: 10%, Uncommon: 20%, Rare: 35%, Legendary: 35%

## 11.2 Chest Mechanics

- Chests are placed during map generation (CHEST tile type)
- Player presses E near chest (interaction range: `CHEST.INTERACTION_RANGE` = **192px** — NOT PICKUP_RADIUS; chests have their own larger range)
- Opening takes 0.5s (animation). The player must remain within 8px of their start position (per-axis check) AND within `CHEST.INTERACTION_RANGE` (192px) of the chest during the opening. Moving more than 8px from the start position cancels the opening (chest is NOT consumed). Taking damage does NOT cancel the opening. Initiating an attack (windup start) DOES cancel the opening (chest is NOT consumed). If the player dies during the opening, the chest is NOT consumed.
- **No inventory-full precondition**: chest loot spawns as a GROUND PICKUP on an adjacent empty tile (see below), never directly into inventory. Inventory state is irrelevant to opening — a player with a full inventory can always open a chest.
- Reveals one item: 70% chance weapon, 30% chance power-up. Weapon tier is determined by the chest's loot table. Power-up type follows the standard distribution (Health Pack 50%, Barrier 25%, Speed Boost 25%).
- Loot (weapon or power-up) appears as ground pickup on an adjacent empty tile next to chest (falls back to chest's own tile if no adjacent tile is available)
- After opening, the chest tile becomes EMPTY (walkable floor)
- **Interaction Priority:** When multiple interactables are within range of the E key (chest, weapon pickup, power-up), the closest one takes priority regardless of type. Distance is measured from player center to entity center.
- If two players attempt to open the same chest in the same server tick, the player with the lowest Player ID opens it.

---

# 12. Match Flow

## 12.1 Matchmaking

**Matchmaking Flow:**
1. Players enter matchmaking queue
2. Lobby accumulates players for up to 90 seconds
3. At 90 seconds, all remaining slots are filled with bots to reach 64 players
4. Match begins with 5-second countdown
5. Minimum players: if fewer than 48 humans + bots combined at 90s, the lobby waits another cycle (rare edge case)
Seat reservation tokens expire after 30s. Chat: 1 message per 2s, max 200 chars.

MATCHMAKING_RETRY_DURATION=90s (same window), MATCHMAKING_MAX_RETRIES=3. After max retries, dissolve lobby and return players to queue.

## 12.2 Match Timeline

1. **Lobby**: Players join, see other players, chat
2. **Countdown**: 5 seconds, countdown beep sounds
3. **Match Start**: Players spawn at random spawn points, 3s spawn invincibility
4. **Active Phase**: Players loot, fight, zone closes
5. **Zone Shrinking**: Zone phases progress over 255 seconds (~4¼ minutes)
6. **Match End**: The match ends when only one player (or zero players) remains alive. There is no maximum match duration.
- Overtime (255s+): 30 HP/s zone damage + accelerated siege walls (1.5s interval)
- The zone will eventually kill all players through damage and siege walls
- **Simultaneous deaths:** If the last 2+ players die in the same tick, the player with the most kills wins. Tiebreaker: total damage dealt. Second tiebreaker: survival time. Third tiebreaker: lowest Player ID.

## 12.3 Disconnect Behavior

**Bot Takeover:**
- **Phase 1 (0-30s) — Grace Period:** Character frozen in place, retains all active effects. Reconnection possible via `allowReconnection(client, 30)`. If the player reconnects, gameplay resumes normally.
- **Phase 2 (30-60s) — Alive but Vulnerable:** Character becomes unfrozen but CANNOT act (no movement, attack, throw, block, dash, pickup, or switch). Character is vulnerable to all damage (player attacks, zone damage, trap damage, siege crush). If the character dies during this phase, normal death flow applies (weapons drop, player spectates). If the player reconnects during this phase, gameplay resumes with whatever health/effects remain.
**Phase 2 specifics:** The character is subject to physics (knockback, zone push) but has all inputs suppressed. The character stands in place unless pushed by external forces. Reconnection during Phase 2 resumes normal gameplay with whatever health and effects remain.
- **Phase 3 (60s) — Bot Takeover:** Bot takes over with FULL state inheritance — the player entity is preserved (not removed/recreated). Bot inherits current position, health, current weapon, active effects (fresh spawn timer, speed boost, barrier), and any in-progress action. Total elapsed: 60s from disconnect. This is entity-preserving takeover: the Player entity stays alive with `isBot = true` and is registered with the BotSystem. Same mechanism as AFK takeover.
- Bot inherits FRESH_SPAWN status if the player was still protected.
- Bot inherits mid-attack state (continues the attack animation).
- Kill credit for inherited mid-attacks is attributed to the original player session. The bot completes any in-progress attack (windup, damage, cooldown).
- AFK detection: no input for 30s → warning. No input for 60s → bot takes over immediately (no grace period).
- Any InputAction received by the server resets the AFK timer, including MOVE. Knockback does NOT reset the AFK timer — only player-initiated inputs.
- If the player reconnects after the bot has taken over, they spectate the match

## 12.4 Overtime

- If the zone reaches phase 7 (~255s at current pacing) and multiple players alive -> Sudden Death zone activates
- Zone radius stays at 8% (static, no further shrink), 30 HP/s damage to all, accelerated siege walls (1.5s interval)

## 12.5 Simultaneous Kills

- Handled by match end rules — see 12.2 Match Timeline, step 6.

## 12.6 AFK In-Match

- Covered by Bot Takeover AFK detection rules — see 12.3 Disconnect Behavior.

## 12.7 Spectator Mode

**Spectator Mode:**
Upon death, players enter spectator mode with the following capabilities:
- **Camera Follow:** Auto-follows the player's killer (or last damage source for environmental deaths). Instant lock (no lerp delay). If the followed player dies, camera auto-switches to the followed player's killer (follow chain). If no killer (environmental death), camera follows the player with the lowest alive Player ID.
- **Spectator Follow Fallback:** If the followed player's killer is already dead (SPECTATING) or is the spectating player themselves, fall back to the alive player with the lowest Player ID.
- **Zoom Level:** Same as gameplay (1× viewport). No zoom out.
- **Cycle Players:** Q/E keys cycle through alive players in order of player ID. On mobile: left/right arrow buttons below minimap.
- **Free Camera:** Space bar toggles free camera mode. Pan speed: 500 px/s using WASD. On mobile: two-finger drag to pan.
- **Visible Information:** Spectators can see the followed player's health, weapon inventory, and active effects. Cannot see other players' stats.
- **Chat:** Spectators cannot send chat messages. Can see match chat.
- **Leave:** ESC key returns to main menu at any time.
- **Camera Bounds:** Free camera is bounded within the world (0,0 to 10240,10240).

## 12.8 Results Screen

**Results Screen:**
When the match ends, a full results screen displays for 30 seconds:
- **Leaderboard:** All 64 players ranked by placement
- **Columns:** Placement, Player Name, Kills, Damage Dealt, Damage Taken, Survival Time, Weapons Used (count of unique weapon types equipped during the match)
- **Top 3 Highlighted:** 1st place = gold, 2nd = silver, 3rd = bronze
- **Auto-scroll:** Shows top 10 initially, scrolls to show more
- **Winner Announcement:** Top of screen shows '[PlayerName] WINS!' with animation
- **Player's Own Stats:** Highlighted row showing the viewer's personal performance
- **Navigation:** ESC returns to menu immediately, otherwise auto-returns after 30s

## 12.9 Death Flow

**Death Flow (when player HP reaches 0):**

**Immediate (at HP=0):** Steps 1, 4, 5, 9, 10 fire immediately.
**Deferred (after 0.5s death animation):** Steps 6, 7, 8 fire when animation completes.

1. HP reaches 0 → player status set to DYING (status |= DYING; status &= ~ALIVE)
2. Death animation plays for 0.5 seconds (player model collapses)
3. During the 0.5s death animation, the dying player's body retains collision. Other players and projectiles cannot pass through the dying player's body until the animation completes and the body is removed.
4. All weapons in inventory drop to the ground in a grid pattern around the death position (within 1 tile radius, each weapon at a unique tile position). If the death position is on a blocked tile (wall, occupied), weapons drop to the nearest available unblocked grid position. Fists are permanent and cannot drop.
5. All active effects cancelled (speed boost timer cleared, barrier removed)
6. Camera zooms out briefly (0.3s transition)
7. Player status transitions DYING → DEAD (2), then DEAD → SPECTATING (4)
8. Camera auto-follows the killer (or last damage source)
9. Kill feed entry appears with appropriate template
10. If the player had a weapon mid-flight (thrown) or an arrow in flight, the projectile continues its trajectory and can still deal damage. Kill credit goes to the dead player (posthumous kill).
11. Clear `player.queuedSlotSwitch = null` on death.

**Dead Body Projectile Interaction:** Thrown weapons that hit a dead body (not the thrower's own body) are destroyed and do NOT become ground pickups. Arrows that hit a dead body disappear normally.

---

# 13. Player Rendering

## 13.1 Character Composition

| Component | Source Size | Rendered Size | Scale | Description |
|-----------|-------------|---------------|-------|-------------|
| Body | 128 x 128 px | 96 x 96 px | 0.75 | One of 8 base color sprites |
| Left Hand | 128 x 128 px (trimmed) | 32 x 32 px | 0.25 | Positioned 45° in front-left of body |
| Right Hand | 128 x 128 px (trimmed) | 32 x 32 px | 0.25 | Positioned 45° in front-right of body |

Body is rendered at 96x96 (0.75 scale from 128x128 source). Hand sprites are rendered at 32x32 (visible content is ~32px of actual hand artwork within 128x128 source canvas). Hands are positioned 80px from body center at ±35° from facing direction (48px body radius + 32px gap). Weapon sprite is hidden when fists are equipped — no duplicate hands.

## 13.1.1 Sprite Scaling

| Sprite Type | Source Size | Rendered Size | Scale Factor |
|-------------|-------------|---------------|--------------|
| Character body | 128 x 128 | 96 x 96 | 0.75 |
| Character hands | 128 x 128 (trimmed) | 32 x 32 | 0.25 |
| Weapon sprites (in hand) | 128 x 128 | 96 x 96 | 0.75 |
| Weapon pickups (ground) | 128 x 128 | 96 x 96 | 0.75 |
| Thrown projectiles | 128 x 128 | 96 x 96 | 0.75 |
| Tile sprites | 128 x 128 | 128 x 128 | 1.0 (no scaling) |

- Body scaled by **0.75** from source to rendered size
- Hands rendered at 32x32 (trimmed from 128x128 source), positioned at 80px from body center at ±35° angles (48px body radius + 32px gap from body edge)
- Weapon sprites scaled by **0.75** (96x96 rendered, same as body) — held by right hand, tier-tinted, hidden when fists equipped
- Thrown projectiles rendered at 96x96: ARC and SHIELD types spin (12 rad/s), LINE and RANGED types fly straight (facing direction only)
- Tile sprites rendered at **1:1** (no scaling)

## 13.2 Base Colors (8)

| Color | Sprite | Hex Value |
|-------|--------|-----------|
| Red | red_character + red_hand | #FC5C65 |
| Green | green_character + green_hand | #37D98C |
| Yellow | yellow_character + yellow_hand | #FFB600 |
| Purple | purple_character + purple_hand | #9179FF |
| Blue | blue_character + blue_hand | #96F3FF |
| Pink | pink_character + pink_hand | #1E63FF |
| Orange | orange_character + orange_hand | #9800FF |
| Cyan | cyan_character + cyan_hand | #BCD4FF |

**NOTE**: The sprite names have color mismatches (pink sprite = blue hex, orange sprite = violet hex). Color assignment must use the HEX values, not the filenames.

## 13.3 Procedural Animation (IK-based, NO sprite sheet frames)

All animations are procedural using Phaser Tweens and/or tick-based interpolation. Inverse kinematics calculate hand positions relative to body center based on facing direction and animation state. Hands are positioned at ±32px from body center in idle.

### 13.3.1 Hand Pose Definitions (local-space offsets, rotated by facingAngle)

Hands positioned at 80px from body center at ±35° from facing direction (48px body radius + 32px gap). +X = forward direction in local space.

| Animation | Left Hand (lx, ly) | Right Hand (rx, ry) | Notes |
|-----------|-------------------|--------------------|----|
| **Idle** | (65, -46+bob) | (65, 46-bob) | bob = sin(t/800)*3 |
| **Walk** | (65+4*sin, -46-8*sin) | (65-4*sin, 46+8*sin) | Hands swing alternately |
| **Dash** | (50+trail, -50) | (50+trail, 50) | Hands trail behind, trail=sin(t*PI)*10 |
| **Stagger** | (40+shake, -52) | (40-shake, 52) | shake=sin(t/50)*8 |
| **Block** | (52, -16) | (52, 16) | Hands in front, shield raised |
| **Dying** | lerp to (24, -12) | lerp to (24, 12) | Hands collapse inward |

### 13.3.2 Attack Animations per Weapon Type

**WINDUP phase** (hands pull inward toward body):
| Type | Left Hand Target | Right Hand Target | Duration |
|------|-----------------|-------------------|----------|
| ARC | (-36, 8) | (16, -8) | weapon windup ms |
| LINE | (-36, 4) | (12, -4) | weapon windup ms |
| RANGED | (-24, 0) | (24, 0) | weapon windup ms |
| THROWN | (-28, 8) | (48, -8) | weapon windup ms |
| SHIELD | (-24, 0) | (24, 0) | weapon windup ms |

**IMPACT phase** (hands thrust outward):
| Type | Animation | Duration |
|------|-----------|----------|
| ARC | Right hand sweeps from +PI/4 to -PI/4 at 48px radius (90° arc) | 200ms |
| LINE | Right hand thrusts from (12,-4) to (56,-4) linear | 200ms |
| RANGED | Right hand from (24,0) to (48,0), both hands spread | 200ms |
| THROWN | Right hand from (48,-8) to (64,-16), follow-through | 200ms |
| SHIELD | Hands stay at block position | 200ms |

**COOLDOWN phase**: Lerps from impact pose back to idle over weapon cooldown duration.

### 13.3.3 Attack VFX per Type

| Type | Visual Effect |
|------|--------------|
| ARC | Sweeping arc (48→160px radius), sweeping highlight dot, orange trail particles |
| LINE | White thrust line (40→200px length), bright tip dot |
| RANGED | Orange projectile dot (0→200px travel), arrow trail, bowstring line for first 30% |
| THROWN | Orange projectile dot (0→150px travel), fading trail |
| SHIELD | Blue expanding ring (30→80px), outer glow ring |

### 13.3.4 Thrown Weapon Flight Animation

- Thrown weapons rendered at **64x64** with tier-based tint color
- Continuous spin at **12 rad/s** during flight
- On bounce: **scale pulse** (1.0 → 1.3 → 1.0 over 150ms)
- On stop: converts to ground pickup at same position with preserved weapon data (type, tier, durability)

## 13.4 Additional Colors

- 8 base colors are unique sprite assets
- Additional colors (up to 64) can be generated programmatically by tinting the white/solid variant sprites using Phaser's `setTint()` method with HSL hue rotation
- This ensures all 64 players can have unique colors

## 13.5 Weapon Display

- Current weapon sprite attached to right hand, rendered at **64 x 64** (0.5 scale from 128 x 128 source)
- Weapon color-tinted by tier (white/green/blue/gold)
- Shield displayed in front of body when blocking, rendered at **64 x 64**
- Weapon rotation follows facing angle (atan2 from body to right hand + PI/2)
- Thrown weapon projectiles preserve original tier (tint color) and display at **64 x 64** with spin animation
- Ground weapon pickups rendered at **64 x 64** with floating bob animation (sin(t/400)*4px) and tier tint

## 13.6 Tier Colors (source of truth)

| Tier | Color | Hex Value |
|------|-------|-----------|
| Common | White (no tint applied) | #FFFFFF |
| Uncommon | Green | #37D98C |
| Rare | Blue | #5B7FFF |
| Legendary | Gold | #FFD700 |

Client code MUST use these exact hex values. The code currently uses different values — update to match.

---

# 13.7 HUD Layout

## 13.7.1 Desktop HUD Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Players Alive: 47]  [Timer: 8:24]  [Zone Phase: 3]     │
│                                                          │
│                                    ┌─────────┐           │
│                                    │ MINIMAP │           │
│                                    │ 200×200 │           │
│                                    └─────────┘           │
│                                    [Kill Feed]           │
│                                                          │
│                                                          │
│           ┌─────────────────────┐                        │
│           │   GAME VIEWPORT     │                        │
│           │   (centered)        │                        │
│           └─────────────────────┘                        │
│                                                          │
│                                                          │
│ [Power-up]  ┌──────────────────────────┐  [Zone Info]   │
│ [Indicators]│  [1: Fists] [2: Sword]   │  [Next Phase]  │
│             │  [3: Empty] [4: Bow]      │                │
│ [HP Bar]    └──────────────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

| Element | Position | Size | Details |
|---------|----------|------|---------|
| Health Bar | Bottom-left | 200×20px | Green→Yellow→Red gradient. Number overlay (e.g., "75/100") |
| Weapon Slots | Bottom-center | 4×64px slots (256×64 total) | Current slot highlighted with bright border. Weapon icon + durability bar (thin line below icon). Empty slots show dashed border |
| Minimap | Top-right corner | 200×200px | See Section 5.1.2 |
| Kill Feed | Right side, below minimap | 200px wide | Last 5 events, fades after 5s |
| Players Alive | Top-center-left | Text | "Alive: 47/64" |
| Match Timer | Top-center | Text | "8:24" countdown |
| Zone Phase | Top-center-right | Text | "Phase 3 — Edge Closure" |
| Power-up Indicators | Left side, above health bar | 32×32 icons with timer | Barrier (shield icon, 10s countdown), Speed (boot icon, 7s countdown). Only shown when active |
| Zone Warning | Screen edge gradients | Overlay | 4 semi-transparent gradient rectangles at screen edges (~40px deep), NOT full-screen overlay. Red pulsing during 30s before phase transition. |
| Interaction Prompt | Above player character | Text | "E — Pick up [WeaponName]" or "E — Open Chest" when in range |

## 13.7.2 Mobile HUD Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Players: 47]  [Timer: 8:24]  [Phase: 3]                │
│                                    ┌───────┐             │
│                                    │Mini-  │             │
│                                    │map    │             │
│                                    └───────┘             │
│ [Power-ups]                                             │
│                                                          │
│                                                          │
│           ┌─────────────────────┐                        │
│           │   GAME VIEWPORT     │                        │
│           │   (centered)        │                        │
│           └─────────────────────┘                        │
│                                                          │
│ [HP Bar]                                                │
│ [1][2][3][4]   [DASH] [THROW]                           │
│  L-Stick                          R-Stick               │
└──────────────────────────────────────────────────────────┘
```

| Element | Position | Size | Details |
|---------|----------|------|---------|
| Left Stick | Bottom-left | 120px diameter | Virtual joystick for movement |
| Right Stick | Bottom-right | 120px diameter | Virtual joystick for aim/attack. Hold steady = shield block |
| Dash Button | Bottom-center-left | 64×64px | Between weapon bar and right stick |
| Throw Button | Bottom-center-right | 64×64px | Next to dash button, min 16px gap |
| Weapon Bar | Bottom-center | 4×48px slots | Tap to select slot. Active slot highlighted |
| Health Bar | Above weapon bar, left | 160×16px | Same style as desktop |
| Pickup Button | Near character center | 48×48px | Appears when interactable in range |

## 13.7.3 HUD Data Sources

| Element | Data Source | Update Frequency |
|---------|------------|-----------------|
| Health Bar | Server state → StateSync → HUDManager | Every network patch (60Hz) |
| Weapon Slots | Server state → StateSync → HUDManager | Every network patch |
| Minimap | Client-side (local tile data + server entities) | Every render frame (60fps) |
| Kill Feed | Server events → EventRouter → HUDManager | On event |
| Players Alive | Server state (count of ALIVE players) | Every network patch |
| Match Timer | Server clock (synced on connect) | Client countdown |
| Zone Phase | Server state → StateSync → HUDManager | On phase transition |
| Power-up Timers | Server state → local countdown | Every network patch |

---

# 14. Bot AI System

> **Bot AI v2 ("Lively Bots") is the design of record** (bot-ai-v2 effort, DEC-001..014; ADR-0039).
> Design intent, unchanged from the original section: bots must be **believable** (react visibly to the
> world, move with purpose, never read as scripts), **smart** (understand game rules, weapon types, zone
> timing — §14.5), and **MMR-scaled** (§14.6). This rewrite documents the shipped v2 architecture; every
> claim cites its implementing module under `packages/server/src/ai/`.

## 14.1 Architecture

The bot is a **layered agent** running server-side on the same tick as the simulation
(`GameSimulation.step10_BotAI` → `BotSystem.tick`, 60Hz). Layers, in per-tick order:

```
Stimulus (hearing)   →  Perception (scan)  →  Beliefs (believed state)
   →  Reactor (reflex interrupts)  →  Intent selection (deliberation)
   →  Executors (tactical execution)  →  Skill scoring / telemetry
```

- **Bots are players on the same input pipeline as humans** — every layer emits through the
  queued-input factories (`BotInput.ts`); bots never mutate game state directly, and their inputs are
  processed with one tick of built-in latency (`serverTick = tick + 1`).
- **A\* pathfinding** — 8-directional, typed-array buffers, cached paths/LOS, destructible-aware search
  (`findPathThroughDestructibles`), and a priority-ordered shared search cap whose exhaustion returns a
  RETRYABLE deferred sentinel (distinct from "unreachable") (`navigation/Pathfinder.ts`,
  `navigation/PathfinderSearch.ts`, `navigation/PathfinderLOS.ts`).
- **Pathfinder grid updated dynamically** when destructibles are destroyed — no stale pathing around
  cleared walls (both caches invalidated on grid mutation).
- **Stuck detection** is a layered mechanism: an 18-tick / <16px displacement window feeds a five-rung
  human-legible ladder (§14.3 Navigation) before goal-suspension ever fires; progress is defined as
  displacement toward a goal, completed pickups, or kills only (`navigation/StuckLadder.ts`,
  `BotTickStall.ts`).
- **All weapon parameters** (range, projectile speed, throw speed, damage, windup) are read from
  WeaponRegistry via `safeGetWeaponDef` — no hardcoded combat constants.
- **Enforced global AI budget**: the Bot-AI share of the tick (§15.3.1b, ≤4ms across ALL bots, shared
  not per-bot) is enforced by a wall-clock guard with AI LOD as the relief valve (`lod/AiBudgetGuard.ts`,
  `lod/LodTiers.ts`).
- **Determinism contract**: all stochastic draws route through per-bot RNG streams (mulberry32 seeded
  from `playerId`, `BotContextRng.ts`); stimulus fan-out is RNG-free and event-order-deterministic; the
  budget guard reads only the harness-virtualizable clock. Same-seed benchmark runs are byte-identical
  modulo masked wall-clock fields (ADR-0035, `tests/helpers/bot-benchmark-harness.ts`).

### 14.1.1 Personality System

Each bot receives a deterministic **PersonalityProfile** — one of five named **archetypes** expressed as
a CONTINUOUS weight vector (not a template table), so two Aggressors play differently
(`intent/PersonalityProfile.ts`):

| Archetype | aggression | greed | caution | opportunism | trapper | Roll % |
|-----------|-----------|-------|---------|-------------|---------|--------|
| **Aggressor** | 0.85 | 0.30 | 0.20 | 0.60 | 0.30 | 30% |
| **Duelist** | 0.75 | 0.25 | 0.40 | 0.55 | 0.25 | 25% |
| **Survivor** | 0.30 | 0.50 | 0.85 | 0.45 | 0.35 | 20% |
| **Scavenger** | 0.35 | 0.85 | 0.55 | 0.50 | 0.30 | 17% |
| **Trapper** | 0.50 | 0.50 | 0.50 | 0.65 | 0.90 | 8% |

- Every weight is jittered by a **signed ±0.12 draw** from the per-bot RNG; the RESULT is clamped to
  [0.05, 0.98] so no bot is degenerate (never fights / always flees). Intra-archetype variance is the
  point: real variety between two same-archetype bots.
- **Skill knobs per difficulty** (`SKILL_BY_DIFFICULTY`): `aimErrorMultiplier` / `reactionLatencyTicks` /
  `commitMultiplier` — easy 1.6/8/0.6, normal 1.2/5/0.85, medium 1.0/3/1.0, hard 0.7/1/1.15, elite
  0.45/0/1.3.
- **Signature movement per archetype** (visible, always-on — `skill/MovementProfileTables.ts` +
  `skill/BotMovementSignature.ts`): Aggressor = beeline + sinusoidal weave approach with snappy turns;
  Duelist = crisp direct lines, tight spacing-band hold, extended dash-punish reach; Survivor = arcing
  turns with zone-ring preference and wide berth around heard fights; Scavenger = loiter stops at loot
  anchors with dawdly speed; Trapper = curved approaches with hold-windows near chests/barrels. Implemented
  as movement-parameter profiles (speed variance, turn smoothing, stop frequency, approach-curve shape) —
  not new intents.
- **Fixed reaction mixes per archetype** (`reactor/ReactorConfig.ts` `ARCHETYPE_REACTION_MIXES`): a bot's
  reflex STYLE is fixed by its archetype (learnable — two same-archetype bots flinch the same WAY at
  different TIMES); only the timing is jittered (§14.2).

### 14.1.2 Layered Decision Architecture

> This replaces the former behavior-tree specification (Selector/Sequence/Inverter/Repeater/Timer nodes,
> Cooldown decorators, blackboard keys). The behavior tree was never the shipped architecture — the
> intent agent is (ADR-0036) — and v2 wrapped it in the reflex/belief layers below. The Cooldown
> decorator concept is replaced by per-intent **commit windows**. (bot-ai-v2 DEC-014.)

1. **Stimulus system — the hearing model** (`stimulus/`): the server's own domain events (the same
   stream the network mapper ships to clients) fan out to bots within per-type **hearing radii**:
   explosion 1400px, attack-fired 900px (the "distant fight" channel), thrown-landed 1000px, elimination
   1000px, chest-open 700px (punish-the-looter range), zone telegraph GLOBAL, damage 900px
   (`StimulusConfig.ts`). Event mapping: `BarrelExploded`→explosion, `WeaponFired`→attack,
   `WeaponShattered`→thrownLanded, `PlayerEliminated`→elimination, `ChestOpened`→chest,
   `ZoneWarning`→zoneTelegraph, `PlayerDamaged`→damage (`StimulusRouter.ts`). Each bot keeps a bounded
   queue (≤8 entries, 150-tick decay). Delivery is RNG-free, deterministic, one spatial-grid range query
   per event; an event's emitter never hears its own event. Bots gain a CAUSE for every visible effect —
   they turn toward, arc around, flee from, or converge on what happens around them.
2. **Believed-state world model** (`belief/`): bots act on **beliefs**, not ground truth — per-enemy
   `{lastKnownX/Y, velocity, confidence 0..1, source: seen|heard|damage}` with per-difficulty decay
   half-lives (easy 60 → elite 240 ticks) and convergence ramps on re-acquisition (skilled bots snap to
   truth faster). Being hit from an unseen source writes a **damage-direction belief** — an estimated
   position (knockback direction ± 0.5 rad spread, 220–700px distance guess, low confidence), NEVER the
   attacker's true coordinates; a bot you outplay can be wrong about where you went. **Search-failure
   memory**: ~90 ticks investigating a last-known position without re-acquisition drops the belief with a
   short intent-family cooldown (no infinite ghost chases). Beliefs converge to truth on LOS
   re-acquisition (`BeliefUpdate.ts`, `BeliefMath.ts`, `BeliefConfig.ts`).
3. **Reactor — the reflex layer** (`reactor/`): a prioritized interrupt set evaluated EVERY tick, AFTER
   perception, BEFORE all deliberation — it bypasses commit windows/hysteresis by construction (reactions
   are not intents), so a bot in ANY state flinches. Priority order (highest first):

   | Priority | Reaction | Response (per-archetype mix flavors the style) |
   |----------|----------|------------------------------------------------|
   | 1 | **Imminent death** (siege-crush tile / lethal-zone overlap) | Dash to zone-safe point — ZERO latency (§14.4 instant override) |
   | 2 | **Incoming projectile** on intercept course | Committed perpendicular evade, dash option for prudent archetypes |
   | 3 | **Took damage** (startle) | Face the damage-direction belief, then the archetype's answer (fight / sidestep-space / disengage / flee / hold); brief confusion window + decaying accuracy penalty |
   | 4 | **Explosion in hearing radius** (strength ≥ 0.3, age ≤ 30 ticks) | Arc/dash away; Trapper pushes TOWARD its own blasts |
   | 5 | **Enemy windup aimed at me** | Dodge un-gated for ALL archetypes — tank-and-punish (Aggressor) / sidestep-and-space (Duelist, Trapper) / early-dash (Scavenger, Survivor) |

   Rules: every fired reaction MUST emit at least one observable input (turn / velocity change / dash) —
   movement is the only dialogue channel; bounded duration (≤15 ticks) with a 10-tick refractory (no
   chaining); suppression masks during the bot's own attack windup (imminent death exempt). Timing is
   ex-Gaussian per §14.2 (`BotReactor.ts`, `ReactorConditions.ts`, `ReactorConfig.ts`).
4. **Intent layer — the deliberative brain** (`intent/`): utility-scored intents (score 0..1 +
   commitTicks + isValid + execute) behind a single decision point (`IntentSelector`) that honors commit
   windows (hysteresis), permits validity-gated preemption (margin 0.18), and supports **goal
   suspension** (family cooldowns so a stalled goal relocates instead of re-selecting). The GDD §14.3
   phase weights apply here as score multipliers (§14.3). The **macro-goal generator** (`goal/`) scores a
   small candidate set every ~2–3s — loot cluster, quiet-side rotation away from stimulus fight density,
   unexplored sector, next-zone pre-position, hotspot-edge stalk — commits the winner 3–6s, and the
   WANDER/LOOT/HUNT executors bind to the active goal (§14.3 Navigation).
5. **Executors** (`BotTickPhases.ts` dispatch): tactical execution per BotState — FLEE_ZONE,
   SEEK_WEAPON, ENGAGE, RETREAT, LOOT, HUNT, WANDER, DEMOLITION (`BotCombat*.ts`, `BotEconomyExecutors.ts`,
   `BotRoamExecutors.ts`).
6. **AI LOD + enforced budget** (`lod/`): fidelity is allocated per bot per tick — **T0** (in combat or
   within ~1.5 screens of a reference player): think every tick; **T1** (mid): think every 3rd tick;
   **T2** (far): think every 9th tick with coarse perception (9-tick full-scan stride). ALWAYS-ON at every
   tier: the Reactor, stimulus delivery, the per-tick hazard rescan, physics and input submission — bots
   are players. Combat entry upgrades a far bot to T0 the same tick. The §15.3.1b ≤4ms budget is enforced
   by a wall-clock guard with LOD as the relief valve (T2 at 3.2ms → T1 at 3.6ms → non-combat T0 at
   4.0ms; combat-tier T0 is never suspended); sustained overrun (60 consecutive ticks) is a benchmark
   FAIL, not a silent degradation (`LodTiers.ts`, `LodAssignment.ts`, `AiBudgetGuard.ts`).

## 14.2 Difficulty Levels

| Level | Detection Range | Reaction Time | Decision Quality | Tick Rate |
|-------|----------------|---------------|-----------------|-----------|
| Easy | 192px | 600ms | Basic chase + attack, 15% mistake chance | 4Hz (every 15 ticks) |
| Medium | 320px | 300ms | Strategic positioning, 5% mistake chance | 6Hz (every 10 ticks) |
| Hard | 512px | 100ms | Optimal play, combo attacks, 0% mistakes | 10Hz (every 6 ticks) |

All difficulties respond to immediate environmental threats (siege wall, zone-critical) instantly — no tick interval, reaction delay, or cooldown bypass for threat overrides.

**v2 consumption of this table** (bot-ai-v2 DEC-007/009 — the table values are preserved exactly; HOW each column is consumed changed to make difficulty human-readable):

- **Reaction Time = ex-Gaussian distribution MEANS**, not fixed delays (a fixed delay is itself a metronome tell). Every perception→action channel draws `latency = gauss(μ−τ, σ) + exp(τ)` with σ ≈ μ/4 (fast bulk) and τ ≈ μ/6 (slow tail), via the per-bot RNG — so 600/300/100ms are the distribution means, groups never react identically or simultaneously, and each draw is capped at 90 ticks so a reaction still lands while its cause is meaningful (`reactor/ReactorLatency.ts`, `REACTION_LATENCY_BY_DIFFICULTY` in `reactor/ReactorConfig.ts`; the extra enum tiers share rows — `normal` = Medium, `elite` = Hard). The bench reaction-latency histogram is therefore non-degenerate by construction.
- **Detection Range = belief-confidence modifier**, not a hard vision wall (cone-blind bots read as blind in a top-down game where humans see ~360°). A SEEN belief carries full confidence up to the range, then fades linearly to a 0.4 floor at the 1000px perception edge; the §14.3 LOS-halving rule became `confidence × 0.5` for wall-blocked sightings (`FOVEATION_DETECTION_RANGE` / `LOS_HALVING_FACTOR` in `belief/BeliefConfig.ts`, applied in `belief/BeliefMath.ts`). Foveation-lite position noise is also difficulty-scaled (multiplier 1.6 easy → 0.45 elite): skilled bots perceive more precisely.
- **Decision Quality = scoped incompetence**, not a random mistake roll: low tiers lock to 2–3 weapon classes, cannot switch slots mid-fight, cannot dash-cancel their own windups — NARROW, consistent, learnable habits (players can exploit them); high tiers unlock everything and are dangerous through speed and discipline, never superhuman perfection (`RESTRICTIONS_BY_DIFFICULTY` in `skill/RestrictionTables.ts`). The mid-fight restrictions bind at every emission site (engage, retreat, demolition); the one exemption is the forced weapon-break re-arm switch, which every tier performs — a broken weapon makes the swap survival, not incompetence.
- **Tick Rate column: superseded in v2.** All bots run the 60Hz driver; decision cadence is set by AI LOD tiers (think every tick / every 3rd / every 9th, assigned per tick from engagement + proximity — §14.1.2), not by difficulty. The column is retained verbatim above because the table is the source of the detection/reaction values.
- The instant-threat sentence above is implemented as the Reactor's priority-1 **imminent-death** reaction, which fires with ZERO latency and sits above every deliberative gate (`reactor/ReactorConditions.ts`, `ReactorConfig.ts`).

## 14.3 Bot Behaviors

| Behavior | Description |
|----------|-------------|
| Combat | Predictive aim from per-enemy movement history; aim starts wide on acquisition and CONVERGES over the opening of an engagement (tier-scaled 18–90 ticks — multi-adjustment aiming); sticky zigzag weave under projectile fire (direction committed 0.5–1s, per archetype); windup dodges for every archetype (§14.1.2 Reactor); engagement discretion — disengage from lost fights (HP floor, dry/broken weapon, third party arrived, outnumbered 2+v1) via a NAVIGATED break-line retreat that cuts line-of-sight, even through destructible walls; kill-secure pursuit; range-advantage spacing per weapon class (`BotCombatEngage.ts`, `combat/BotCombatWeave.ts`, `combat/DiscretionTables.ts`, `BotCombatRetreat.ts`). |
| Survival | Zone flee with HP-aware margins; imminent-death Reactor override (zero latency); rotation timing `timeUntilShrink < travelEstimate × personalityMargin` (Survivor margin large — leaves early; Aggressor tiny — sometimes eats storm damage, like people); **zone-as-cost**: pathing may accept a shallow zone-damage shortcut inside a small personality-gated HP budget that can NEVER be lethal (HP floor 30) when the safe alternative crosses a high-danger corridor (`intent/intentSurvival.ts`, `goal/ZoneTiming.ts`, `goal/GoalTables.ts`). |
| Looting | Proximity pickup within `PICKUP_RADIUS`; real loot CONTESTS — persistent cross-tick item claims, intercept pathing toward the contested item on the enemy's approach side, and a clean break-off (suspension window + item blacklist) when the race is lost — no ping-pong; safe-loot windows: a heard nearby elimination opens a short bias toward the fresh corpse seat (loot the aftermath of a fight); strict tier upgrades or role-gap fills only when an EMPTY slot exists (full-inventory "throw weakest to make room" is NOT implemented — THROW is tactical, in engage/retreat only); type-aware power-up scoring (health when low HP, barrier before combat, speed boost for escape) (`combat/ItemContests.ts`, `combat/BotKillFeedMemory.ts`, `BotEconomyExecutors.ts`). |
| Barrel Exploitation | Hot-barrel detection (a barrel within its 256px blast radius of an enemy) triggers a deliberate DEMOLITION attack aimed at the barrel's real SAT-collider centroid; the Reactor's explosion reaction and the Trapper archetype's toward-the-blast mix make barrel play readable (`intent/intentEngage.ts`, `BotCombatDemolition.ts`). |
| Navigation | A* pathfinding with caches; tiered planner (plain A* first, destructible-aware A* when a destructible is near and breaking through is cheaper than the detour); stateful wall-slide hysteresis; **final-angle wall validation** — the last step of the steering pipeline re-probes the blended angle against walls, so no emitted movement angle may point into a wall; a five-rung human-legible stuck ladder (§14.1); one arrival model for non-walkable targets (nearest-walkable approach point — replaces the old <120/<160px patches) (`BotNavigation.ts`, `BotNavigationBlend.ts`, `navigation/StuckLadder.ts`). |

**Weapon-Aware Combat:** All combat decisions use weapon-specific data from WeaponRegistry — `baseStats.range` for engagement distance, `projectileSpeed`/`throwSpeed` for lead-angle prediction, actual weapon damage for target scoring. No hardcoded combat constants (`safeGetWeaponDef`, `BotLoadout.ts`).

**Shield Combat:** Bots with shields switch to shield slot before blocking. Blocking is the game's PASSIVE shield rule (§0); the bot's visible shield play is the reactive BASH against a winding-up enemy it can punish, and dash-to-close at range (`BotCombatEngage.ts` SHIELD branch). Shield is included in weapon category selection.

**Combat Stances (2-branch):**
- **Ranged stance** (RANGED attackType): Maintain distance at a kite/approach band around ~0.75× of weapon range, flee-dash when collapsed on, strafe-approach at ±30°, lead-angle prediction (`BotCombatEngageRanged.ts`).
- **Melee stance** (ARC, LINE attackType): Close gap aggressively, commit at melee range. Disengage via the discretion triggers (HP/supply/third-party/outnumbered) instead of a single flee threshold (`BotCombatEngage.ts`, `combat/DiscretionTables.ts`).

**Line-of-Sight Checks:** Bots use Bresenham's line algorithm on the tile grid (`hasLineOfSightWorld()`), cached per pair and invalidated when the grid mutates (`navigation/PathfinderLOS.ts`). LOS gates combat routing (no-LOS targets are pathfound to, not shot at). Per §14.2, targets without LOS have their belief confidence halved — the remembered position is half-trusted, not invisible (`LOS_HALVING_FACTOR`).

**Fresh-Spawn Player Filtering (as shipped):** Fresh-spawn players are PERCEIVED — tagged `isFreshSpawn` + `spawnInvulnTicksLeft` — but excluded from `nearestEnemy` and combat targeting only while invulnerability has more than 6 ticks left; a dedicated spawn-prey vulnerability signal (high score at flag-clear) lets a bot TIME its attack to the invuln-clear instant instead of ignoring the most vulnerable moment of the match. Rationale: the instant spawn invuln clears (full HP, fists-only, no i-frames) was previously structurally un-seeable, which read as bots ignoring free kills — perceive-and-time-it is deliberate (`BotPerception.ts`, `IntentSignals.ts` `flagSpawnPrey`, `BotTargeting.ts`).

**Barrier-Aware Targeting:** Players with an active barrier are detected by perception (`barrierActive`) but excluded from combat targeting — bots do not waste attacks on invincible enemies, mirroring the fresh-spawn gate (`BotTargeting.ts`).

**Trap Type Awareness (as shipped):** Bots perceive traps with their subtype carried on the danger view, and trap subtype feeds death-cause attribution in telemetry — but avoidance URGENCY is currently UNIFORM across spike/fire/teleport (identical weight and radius for all trap kinds). The former spike=high/fire=medium/teleport=low urgency tiers are not implemented (`BotNavigationBlend.ts` `computeDangerAvoidance`, `BotTelemetry.ts`).

**Power-Up Type Awareness:** Bots distinguish power-up subtypes (health_pack, speed_boost, barrier) and score them contextually: health_pack prioritized when HP < 60% (85% in the endgame), barrier before combat / as a low-HP save, speed_boost for escape (`intent/intentLoot.ts`).

**Game Phase Awareness:** Bots adjust priorities based on alive-player ratio. The phase-weight table below is implemented VERBATIM as data (`arc/MatchArcTables.ts` `GDD_PHASE_WEIGHTS`) and applied for real as score multipliers on the corresponding intent families — combatMod → DUEL/HUNT_VULNERABLE/HUNT, lootingMod → LOOT/ARM_UP, positioningMod → SURVIVE_ZONE pre-positioning + macro-goal rotation margins — each bent by a per-archetype slope (Aggressor ramps early and resists early-combat suppression; Survivor never fully ramps; band edges: Early strictly >50% alive, Late strictly <25%) (`arc/MatchArc.ts`):

| Phase | Trigger | combatMod | lootingMod | positioningMod |
|-------|---------|-----------|------------|----------------|
| Early | >50% alive | 0.5 | 1.5 | 1.0 |
| Mid | 25-50% alive | 1.0 | 1.0 | 1.0 |
| Late | <25% alive | 1.5 | 0.5 | 1.5 |

**Human-Like Bot Names:** Bots use gamer-tag-style names from a pool of 60 names (e.g., `xXDarkSlayer99Xx`, `SniperWolf_`, `NoobMaster69`, `PixelStorm`, `GhostRider`). Names are shuffled once, popped without repeats, and reshuffled when exhausted. Fallback: `Player_XXXX` (random 4 digits). Names are released back for reuse when bots are removed.

## 14.4 Bot Behavior Priority

**Priority semantics as implemented (v2):** the fixed five-level order is expressed as two cooperating mechanisms rather than one static list:

1. **The Reactor owns the hard overrides** (§14.1.2): imminent death (siege wall / zone-critical / lethal overlap) outranks everything and fires with ZERO latency — no tick interval, no reaction-latency draw, no commit window. Only survival-tier reactions operate in this override mode, matching the original instant-override rule.
2. **The intent selector owns the deliberative ordering** (`intent/IntentSelector.ts`): survival hard-gates are preserved by construction — SURVIVE_ZONE scores a flat 1.0 on siege warning or lethal-outside-zone (the array's first member wins ties, and amplified late-game scores clamp at 1.0 so they can TIE but never dominate survival). Below survival, combat/loot/positioning/explore trade off through utility scores × personality weights × match-arc multipliers, held stable by commit windows (hysteresis) with validity-gated preemption.

**Decision Frequency:** Full intent re-scores run at the LOD think cadence (T0 every tick, T1 every 3rd tick, T2 every 9th tick, staggered per bot via hashed phases) — not at fixed per-difficulty intervals. The Reactor and the hazard rescan run EVERY tick at EVERY tier. All difficulty levels respond instantly to immediate threats (zero-latency imminent-death override).

## 14.7 Bot Threat Scoring (Environmental) — FORMULA RETIRED

> **Retirement note (bot-ai-v2 DEC-014, with the recorded dissent addressed):** the former
> `envThreatScore = distanceWeight × (1 / distance) × typeWeight` formula — the typeWeight table
> (siege 100 / zone 80 / barrel 70 / projectile 60 / enemy 40), the score ≥ 80 immediate-override
> threshold, and the three-band zone-safety model — is **retired**. It never existed in the shipped code,
> and v2 implements its SEMANTICS through the Reactor's prioritized reaction table (§14.1.2), which is
> this section's semantic successor: typed, distance-scaled threat responses with immediate overrides —
> siege/lethal-zone → priority-1 imminent-death with zero latency (the old typeWeight-100 row's
> "maximum urgency"); incoming projectile → priority 2; explosion → priority 4 (hearing-radius and
> strength-gated, which IS the distance scaling); enemy attack → priority 5 windup reaction. The
> deliberative half of the old model lives in the zone-timing margins and fight-density scoring of the
> macro-goal layer. A single scalar formula no longer exists (`reactor/` + `goal/ZoneTiming.ts`).

**Zone awareness as implemented** (the retired section's surviving intent, restated to match the code):

- **Rotation timing:** bots rotate when `timeUntilShrink < travelTimeEstimate × personalityMargin` — the temporal urgency the old section attributed to `ticksUntilDeath`-style gradients is expressed as per-archetype timing margins instead (`goal/ZoneTiming.ts`).
- **HP-aware flee margins:** outside-zone urgency scales with the bot's own HP (low HP widens the flee margin) rather than distance-from-edge alone (`intent/intentHelpers.ts`).
- **Zone-as-cost:** shallow zone-damage shortcuts are accepted inside a never-lethal HP budget (§14.3 Survival) — the "a bot with 100HP may take a short detour" behavior, implemented as a path-cost decision (`goal/ZoneTiming.ts` `evaluateZoneShortcut`).
- **Pre-positioning:** bots pre-position toward the next zone phase center/target ring, not just the current center — via the SURVIVE_ZONE safe-point pick and the macro-goal layer's pre-position candidate (`BotZoneSafety.ts`, `goal/GoalScoring.ts`).
- **Sudden death awareness:** lethal zone phases (sudden death) feed the imminent-death Reactor reaction and the endgame hold points, which blend every archetype toward center as the final phase closes so matches still finish naturally (`reactor/ReactorConditions.ts`, `goal/ZoneTiming.ts` `endgameHoldPoint`).

## 14.8 Bot Combat Target Evaluation (Player-Centric)

When choosing which enemy player to attack, bots evaluate each believed enemy
(`BotTargeting.ts` `selectTarget`):

`score = (distScore×3.0 + killSecure×2.0 + matchup×0.8 + threat×1.0 + recentDamage×2.0) × vulnerability × hunterSpread × dangerousEnemy`

| Term | Value | Description |
|------|-------|-------------|
| distScore | 0..1 | `1 / (distance + 1)` — closer is better |
| killSecure | 1.0–2.0 | `2.0` when the enemy is below 30% HP (kill-secure); otherwise `1 / (hpRatio + 0.5)` |
| matchup | 0.6 / 1.0 / 1.5 | Weapon-RANGE comparison vs the enemy's weapon (range advantage / parity / disadvantage) |
| threat | 1.0 / 2.0 | `2.0` when the enemy is on FISTS (free-hit opportunity) |
| recentDamage | 0..1 | **Restored GDD term**: damage TAKEN by this enemy in the last 5s (300 ticks), observed from per-scan health deltas (my damage AND third parties'), capped at 100 HP = 1.0 — the "weakened/invested combatant" signal that makes third-partying read as opportunistic skill. The GDD's original `W_DAMAGE = 0.3` weight is preserved proportionally: the implemented additive band is ×10 the GDD's, so the term enters at `0.3 × 10 = 2.0` (`combat/BotRecentDamage.ts`) |
| vulnerability | 1.0 / 1.5 | `1.5` while the enemy is in attack windup (punish window) |
| hunterSpread | `1/(1+0.3k)` | Down-weight per hunter already committed to this target (k) — fire spreads across the lobby instead of piling onto one victim |
| dangerousEnemy | 1.0 / 1.3 | `1.3` when the enemy's weapon damage > 20 (from WeaponRegistry) |

- **Target lock:** 45 ticks (0.75s) — long enough to avoid aim thrash, short enough to react to the world. The lock only short-circuits re-scoring while (a) fewer than 2 hunters are committed to the target and (b) the bot's BELIEF about the target is fresh (refreshed within 6 ticks — two perception scan cycles); stale-belief or over-contested locks fall through to re-scoring.
- **Lock breaks** when the target dies, exceeds 1100px, or is contested by 2+ hunters. The former flat `MAX_ENGAGEMENT_RANGE = 600px` cutoff is superseded by per-weapon-class engagement ranges plus the 1100px lock-drop.
- **Believed-world gate:** enemies whose belief has gone stale are not targeted at all — the bot re-scores toward enemies it still perceives (or investigates the stale one's last-known position via HUNT).
- **Barrier / fresh-spawn gating:** barriered enemies and fresh spawns with >6 ticks of invulnerability are skipped (§14.3) — the dedicated spawn-prey timing path handles the latter.
- Bots target the enemy with the highest score; if none qualifies, the non-combat intents (loot/position/explore) hold. Re-evaluation runs at the LOD think cadence (every tick at T0), not at fixed per-difficulty intervals.

## 14.5 Bot Requirements

- Must fill lobby slots when not enough real players
- Bot-only matches must complete successfully (64 bots)
- Bots must be "very smart": understand game rules, weapon types, zone timing
- Bots must be indistinguishable from real players in gameplay quality
- Bots are visually identical to human players in production — no `[BOT]` tags, name colors, or special indicators in kill feed, player labels, HUD, or scoreboard
- `isBot` flag is synced to client schema but only rendered in debug mode (debug overlay shows `[BOT]` tag on labels and kill feed)

## 14.6 Bot Difficulty Distribution

- Bot difficulty scales with lobby MMR. Higher MMR lobbies get harder bots, lower MMR lobbies get easier bots.
- Each bot receives individually-assigned difficulty from a weighted distribution (not a single global difficulty per room).
- Low MMR lobby: 70% Easy, 20% Medium, 10% Hard
- Mid MMR lobby: 20% Easy, 60% Medium, 20% Hard
- High MMR lobby: 10% Easy, 20% Medium, 70% Hard
- Lobby average MMR flows from Matchmaker → LobbyRoom → GameRoom → BotManager for per-bot weighted random difficulty assignment.
- Default fallback (no MMR data): all bots receive `normal` difficulty.

**Implementation (bot-ai-v2 ticket 08, DEC-009.1):** implemented VERBATIM as data — the three distribution rows above are pinned row-by-row in `skill/BotDifficultyTables.ts` (`MMR_DIFFICULTY_MIX`), with per-bot weighted-random assignment drawn from the room's seeded stream in registration order (benchmark-deterministic). The band edges (low < 1200 ≤ mid ≤ 1800 < high MMR) are AI-side tuning data — the GDD defines only the distributions. The no-data default resolves through the room-wide `normal` fallback without drawing from the stream. All-bot benchmark lobbies force a wide deliberate 20/20/20/20/20 mix across all five difficulty tiers so believability is measured across the full range. Difficulty is assigned at spawn and never changes within a match; it drives the skill knobs, the ex-Gaussian reaction means, the belief precision tables, the scoped-incompetence restrictions, and the fire-discipline/accuracy caps (§14.2).

---

# 15. Technical Architecture

## 15.1 Server Architecture (DDD)

- **Colyseus 0.17** with **@colyseus/schema 4.0** (`@type()` decorators, MapSchema/ArraySchema)
- **Simulation** runs at **60Hz via `setSimulationInterval(fn, 1000/60)`** with fixed-timestep accumulator (TickTimer)
- **State sync** uses imperative pull model: `StateMapper.mapDelta()` iterates domain entities each tick and mutates Colyseus schema instances in-place. Colyseus handles binary diffing/patching at the transport layer. No per-instance `onChange()` on the server.
- **Domain event pipeline**: Domain logic emits events into `GameMatch.events[]` → `drainEvents()` flushes each tick → `EventMapper.broadcastEvents()` maps to `NetworkChannel` strings → `GameRoom.broadcast(channel, message)` sends to clients
- **GameMatch** is the domain aggregate root holding all entity maps (players, projectiles, powerups, traps, chests, destructibles, weaponPickups, explosions) + the `events: DomainEvent[]` buffered array

```
Server
 |
 +-- Domain Layer (zero external dependencies)
 |    +-- Entities
 |    |    +-- Player, Projectile, Explosion, WeaponEntity,
 |    |    +-- WeaponPickup, Trap, Chest, Destructible, PowerUp
 |    |
 |    +-- Aggregates
 |    |    +-- GameMatch (root) — holds events: DomainEvent[] buffer
 |    |    +-- BarrelExplosionManager
 |    |    +-- SiegeWallManager (tracks siege walls as separate data layer, NOT as TileType enum)
 |    |
 |    +-- Services
 |    |    +-- MovementService, CollisionService, DamageService,
 |    |    +-- DamagePipeline (knockback calc + apply),
 |    |    +-- ExplosionService, ZoneService, MatchFlowService,
 |    |    +-- MatchEndService, EliminationService, LootService,
 |    |    +-- SpawnService, SuddenDeathService
 |    |
 |    +-- Handlers
 |    |    +-- MeleeArcHandler, MeleeLineHandler, RangedHandler,
 |    |    +-- ThrowHandler, ShieldHandler
 |    |
 |    +-- Events (23 domain event types, buffered in GameMatch.events[])
 |    +-- Validators
 |    |    +-- AttackValidator
 |    +-- Commands (AttackCommand with dual-mode stat resolution, etc.)
 |
 +-- Application Layer
 |    +-- GameOrchestrator (coordinates domain)
 |    +-- GameSimulation (11-step tick loop at 60Hz)
 |    +-- InputQueue (input buffer, 120 slots)
 |    +-- TickTimer (fixed timestep, DT=1/60, max 5 steps/frame)
 |    +-- RateLimiter (token-bucket, 10 tokens/1000ms)
 |
 +-- Infrastructure Layer
 |    +-- Colyseus Schemas (@colyseus/schema 4.0, @type() decorators)
 |    +-- StateMapper (imperative pull: domain → schema every tick)
 |    +-- StateMapperSync (collection add/remove/modify)
 |    +-- EventMapper + EventMapperHandlers (domain events → NetworkChannel messages)
 |    +-- Logger (structured logging)
 |    +-- Validation (14 Zod schemas)
 |
 +-- Room Layer
      +-- GameRoom (Colyseus 0.17 room, thin orchestration)
      +-- LobbyRoom (matchmaking lobby)
      +-- ReconnectionManager (30s grace)
      +-- Matchmaker (MMR-based, 3-phase)
```

## 15.2 Client Architecture

- **Single GameScene architecture** — one Phaser scene (`GameScene`) handles all gameplay state (connection, map loading, gameplay, spectating). No multi-scene pipeline.
- **StateSync** uses Colyseus Schema 4.0 callback pattern: `getStateCallbacks(room)` wraps state, then `$(collection).onAdd((instance, key) => { $(instance).onChange(() => { ... }) })` for per-instance change tracking on all 8 entity types.
- **EventRouter** subscribes to transient room messages (attack visuals, damage numbers, kill feed, explosions, pickups, match lifecycle, zone updates) via `connection.onMessage(channel, callback)`.
- **EntityInterpolator** for remote player positions: 50ms interpolation buffer, ring buffer of 10 snapshots per entity, linear interpolation between bracketing snapshots. Snap threshold: 64px.
- **Client prediction + server reconciliation** for local player: InputBuffer (120 slots) stores predicted positions, Reconciler re-simulates from server state using unacknowledged inputs, smooth snap at 64px threshold over 100ms with smoothstep easing.
- **AudioService** is non-spatial — all sounds play at flat 0.5 volume regardless of world position. No distance-based volume or panning. Max 8 simultaneous sounds.

```
Client
 |
 +-- Scene (single GameScene)
 |    +-- GameScene (main orchestrator: wires all systems, update loop)
 |
 +-- Rendering
 |    +-- MapRenderer (tilemap rendering with autotile, isWalkable, getAtlasVisual)
 |    +-- PlayerRenderer (player sprites, IK hands, attack visuals)
 |    +-- EntityRenderer (destructibles, chests, pickups, traps, projectiles)
 |    +-- DamageNumberRenderer (floating damage numbers)
 |    +-- ZoneRenderer (zone circle rendering)
 |    +-- StatusEffectRenderer (fresh spawn, barrier, speed boost auras)
 |    +-- CameraService (camera follow, shake, zoom)
 |
 +-- HUD
 |    +-- HUDManager (health, inventory, timer, phase, kill feed, interaction prompt)
 |
 +-- Input
 |    +-- InputCollector (keyboard/pointer → InputFrame)
 |
 +-- Network
 |    +-- Connection (Colyseus client, sendInput, room lifecycle)
 |    +-- StateSync (room state subscriptions via $(instance).onChange() inside onAdd)
 |    +-- EventRouter (room message subscriptions for transient events)
 |
 +-- Prediction
 |    +-- Reconciler (server reconciliation, smooth snap)
 |    +-- InputBuffer (input history, 120 slots, sequence numbers)
 |    +-- EntityInterpolator (remote entity smoothing, 50ms buffer)
 |
 +-- Audio
 |    +-- AudioService (non-spatial, flat volume, 8-channel concurrency limit)
 |
 +-- Assets
      +-- AssetManifest (asset path registry)
```

## 15.3 Network Communication

### 15.3.1 Tick Rates

| System | Rate |
|--------|------|
| Server physics | 60Hz (16.67ms per tick) |
| Network sync | 60Hz (16.67ms patch rate, matches physics tick) |
| Bot AI | 60Hz driver (shared with physics); per-bot think cadence set by AI LOD tiers (T0 every tick / T1 every 3rd / T2 every 9th) — see §14.1.2 |
| Client render | 60fps |

### 15.3.1b Tick Budget Allocations

Total tick budget: 16.67ms (60Hz). Each system must complete within its allocation:

| System | Budget | Notes |
|--------|--------|-------|
| Input processing | ≤0.5ms | Parse and queue player inputs |
| Movement / collision | ≤3ms | Velocity, tile/entity collision, knockback decay |
| Combat resolution | ≤2ms | Melee/ranged hit detection, damage application |
| Zone / siege | ≤1ms | Siege progression, zone damage ticks |
| Bot AI | ≤4ms | Across ALL bots (budget shared, not per-bot). ENFORCED by a wall-clock guard with AI LOD as the relief valve; sustained overrun is a bench FAIL (§14.1.2, `lod/AiBudgetGuard.ts`) |
| State serialization | ≤1ms | Domain → schema mapping for network sync |
| Overhead / reserve | ~5ms | Timer processing, event emission, GC headroom |

### 15.3.2 State Synchronization

- Server authoritative: client NEVER overrides server state
- Colyseus Schema with `@type()` decorators using bandwidth-efficient types: uint8, float32, int16
- StateMapper maps domain -> schema every tick
- Patch rate: 16.67ms (60Hz, matches physics tick)

### 15.3.3 Client Prediction and Reconciliation

- Client predicts movement immediately on input
- Input carries monotonically increasing sequence number
- On server state arrival: Reconciler re-simulates from server position using unacknowledged inputs from InputBuffer
- Smooth snap: if error exceeds 64px, smoothstep snap over 100ms
- Remote entity interpolation: EntityInterpolator with 50ms buffer, ring buffer of 10 snapshots, linear interpolation between bracketing snapshots. Snap at 64px.
- Input buffer: 120 slots

### 15.4 Simulation Tick Execution Order

Each physics tick (60Hz) executes systems in this fixed order:

1. **Process input buffer** — apply queued player actions (movement, attack, throw, block, dash, pickup, switch)
2. **Movement + collision resolution** — apply player velocity, resolve tile/entity collisions, decay knockback velocity
3. **Melee/ranged hit detection + damage** — resolve queued melee swings (ARC/LINE) and ranged attacks, apply damage and knockback
4. **Projectile movement + collision** — advance thrown weapons, arrows, boomerangs; resolve entity/tile collisions
5. **Explosion entity expiry** — tick down explosion entity lifetimes, remove expired entities from state sync. Barrel explosion damage resolves instantly in step 3/4 when barrel is destroyed (no deferred processing).
6. **Zone system** — siege wall warning/drop progression, zone damage ticks (at 0.5s interval)
7. **Trap activation ticks AND active fire DOT ticks** — process triggered traps, apply effects. Fire trap deals 15 instant damage on trigger, then ignites a 3×3 tile area dealing 5 HP/s area DOT for 5 seconds (300 ticks) to all players in the area. DOT ticks every 1 second (60 ticks). Area damage is environmental — bypasses shield blocks. Traps are persistent — not consumed on trigger.
8. **Power-up/status timer expiry** — barrier countdown, fresh spawn countdown, stagger duration
9. **Death resolution** — players who reached ≤0 HP this tick: set DYING (status |= DYING; status &= ~ALIVE), drop weapons, cancel effects, emit kill feed. After 0.5s death animation: DYING → DEAD → SPECTATING.
10. **Bot AI decisions** — every physics tick (60Hz shared driver): Reactor + hazard rescan every tick at every LOD tier; intent deliberation at the tier's think cadence (§14.1.2), under the enforced ≤4ms global budget
11. **State snapshot** — serialize domain state for network sync at 60Hz (every tick)

This order ensures:
- Players act before environmental damage is applied
- Barrel explosion damage resolves instantly when barrel is destroyed (steps 3/4), no deferred chain processing
- Timer expiry occurs AFTER zone damage (barrier protects through its final tick)
- Death is the final gameplay step, ensuring all damage sources resolve before kill credit assignment
- Snapshot buffer: 30 snapshots

### 15.4.1 Attack Prediction

Attack initiation is NOT predicted client-side. The client displays the attack windup animation only after server confirmation. This ensures hit detection accuracy at the cost of input responsiveness.

### 15.4.2 Prediction Error Smoothing

PREDICTION_MAX_SMOOTH_ERROR = 64px. Below this, smoothstep snap over 100ms. Above this, snap to server state instantly.

### 15.3.4 Anti-Cheat

- Server rejects inputs where speed > maxSpeed x 1.1
- Direction values clamped to [-1, 1]
- All damage calculated server-side
- Client-side prediction is visual only: never authoritative

### 15.3.5 Reconnection

- Server: `allowReconnection(client, 30)` -- 30s grace period
- Client: exponential backoff, initial 1s, max 5s delay, max 15 retries

### 15.3.6 Message Validation

- All client messages validated with Zod schemas
- Rate limiting: `maxMessagesPerSecond = 30`

**Per-Action Zod Schema Payloads:**
- MOVE: `{ dx: number [-1,1], dy: number [-1,1], aimDx: number [-1,1], aimDy: number [-1,1], sequence: int >= 0 }`
- ATTACK / THROW: `{ aimDx: number [-1,1], aimDy: number [-1,1], sequence: int >= 0 }`
- PICKUP / DASH: `{ sequence: int >= 0 }`
- SWITCH_SLOT: `{ slotIndex: int [0-3], sequence: int >= 0 }`

Aim direction (aimDx, aimDy) is independent of movement direction (dx, dy). Aim represents the continuous facing angle; movement represents WASD input.

### 15.3.7 Network Message Schemas (Zod-validated)

**PlayerInput** — unified input message sent from client to server:

```typescript
const PlayerInputSchema = z.object({
  direction: z.object({
    dx: z.number().min(-1).max(1),
    dy: z.number().min(-1).max(1),
  }),
  aimAngle: z.number().min(0).max(Math.PI * 2),
  attack: z.boolean(),
  block: z.boolean(),
  dash: z.boolean(),
  throw: z.boolean(),
  pickup: z.boolean(),
  weaponSwitch: z.number().int().min(0).max(3).nullable(),
  sequence: z.number().int().min(0),
});
```

| Field | Type | Validation | Description |
|-------|------|-----------|-------------|
| direction.dx | float | [-1, 1] | Horizontal movement input |
| direction.dy | float | [-1, 1] | Vertical movement input |
| aimAngle | float | [0, 2π] | Continuous facing angle in radians |
| attack | bool | — | Attack input (melee swing / ranged shot) |
| block | bool | — | Shield block hold |
| dash | bool | — | Dash activation |
| throw | bool | — | Throw current weapon |
| pickup | bool | — | Pickup / interact (E key) |
| weaponSwitch | int/null | [0-3] or null | Target inventory slot index |
| sequence | int | ≥ 0 | Monotonically increasing sequence number |

---

# 16. Constants Reference

## 16.1 Grid

| Constant | Value | Description |
|----------|-------|-------------|
| TILE_SIZE | 128 | Pixels per tile |
| ARENA_WIDTH | 80 | Tiles |
| ARENA_HEIGHT | 80 | Tiles |
| SECTOR_GRID_SIZE | 4 | 4x4 sectors |
| CORRIDOR_WIDTH | 3 | Tiles (384px at 128px/tile) |
| MAP_BORDER_WALLS | true | Outermost tile ring is INDESTRUCTIBLE_WALL |
| SECTOR_TILE_SIZE | 20 | Tiles per sector edge |
| VIEWPORT_WIDTH | 1920 | Pixels |
| VIEWPORT_HEIGHT | 1080 | Pixels |

## 16.2 Player

> **CORRECTED 2026-07-27** — see §0. Values marked † are dead (declared but
> never read) or fictitious (listed here but not in shared code).

| Constant | Value | Description |
|----------|-------|-------------|
| BASE_SPEED | 430 | px/s |
| DASH_SPEED_MULTIPLIER | 2.0 | multiplier (dash speed = 860 px/s) |
| DASH_DURATION | 0.5 | seconds |
| DASH_COOLDOWN | 2.5 | seconds |
| BASE_HEALTH | 100 | HP |
| MAX_HEALTH | 100 | HP |
| SPAWN_INVINCIBILITY | 3.0 | seconds |
| INVENTORY_SIZE | 4 | slots |
| HITBOX_WIDTH | 96 | px |
| HITBOX_HEIGHT | 96 | px |
| PLAYER_SCALE | 0.75 | body scale factor |
| WEAPON_SCALE | 0.5 | weapon sprite scale factor |
| HAND_SCALE | 1.0 | hand sprite scale factor (34×34 source) |
| HAND_OFFSET | 32 | † client-side only; not a shared constant |
| PROJECTILE_SPIN_SPEED | 12 | † client-side only; not a shared constant |
| PROJECTILE_BOUNCE_PULSE | 150 | † client-side only; not a shared constant |
| PLAYER_SOLID_COLLISION | true | Players block each other |
| DASH_ALLOWS_ACTIONS | false | Cannot attack/throw/block during dash |
| STAGGER_ALLOWS_DASH | false | Cannot dash while staggered |
| PICKUP_BLOCKED_DURING_ATTACK | true | † DEAD — declared but never read. Real gate is `canPickup()` (blocks during windup/cooldown/dash/stagger). Power-up walk-over bypasses `canPickup()` entirely. |
| FRESH_SPAWN_DURATION | 3 | seconds |
| PICKUP_RADIUS | 72 | px (weapon pickup + power-up auto-pickup). Chests use their own `CHEST.INTERACTION_RANGE` = 192px. |
| DASH_USES_BASE_SPEED | true | dash always uses base speed, ignoring boosts |
| BLOCKING_SPEED_PENALTY | 0.65 | 35% move speed penalty while a shield is raised |
| FRESH_SPAWN_ALLOW_MOVE | true | |
| FRESH_SPAWN_ALLOW_PICKUP | true | |
| FRESH_SPAWN_ALLOW_CHEST | true | |
| FRESH_SPAWN_ALLOW_SWITCH | true | |
| FRESH_SPAWN_BLOCK_ATTACK | true | |
| FRESH_SPAWN_BLOCK_THROW | true | |
| FRESH_SPAWN_BLOCK_BLOCK | true | |
| FRESH_SPAWN_BLOCK_DASH | true | |

## 16.3 Combat

> **CORRECTED 2026-07-27** — see §0. Values marked † are dead (declared but
> never read) or fictitious (listed here but not in shared code). Windup and
> projectile/throw speeds are PER-WEAPON fields in definitions.ts, not global
> constants.

| Constant | Value | Description |
|----------|-------|-------------|
| KNOCKBACK_FORCE | 2000 | passed as knockbackForce for trap/siege contexts. Weapon knockback = per-weapon × VELOCITY_SCALE(20), NOT clamped to this. |
| KNOCKBACK_DECAY | 2000 | linear decay per tick |
| KNOCKBACK_MAX_VELOCITY | — | † fictitious — does not exist in code |
| BASE_KNOCKBACK | 200 | design-time reference only — used to derive per-weapon values, not runtime |
| KNOCKBACK_WEIGHT_MULTIPLIER | 0.25 | design-time reference only — not runtime |
| KNOCKBACK_DURATION | — | † fictitious — does not exist in code; velocity decays via KNOCKBACK_DECAY |
| THROW_RANGE | 2000 | px (global max cap; per-weapon Range caps lower) |
| BOUNCE_FACTOR | 0.75 | wall reflection |
| MAX_BOUNCES | 6 | per throw (Throwing Axe def caps at 3) |
| PROJECTILE_SPEED | — | † fictitious — throw/projectile speeds are per-weapon `throwSpeed`/`projectileSpeed` in definitions.ts |
| PROJECTILE_SPEED_LIGHT/MEDIUM/HEAVY/VERY_HEAVY | — | † fictitious — see above |
| BOW_PROJECTILE_SPEED | — | † fictitious — Short Bow/Crossbow `projectileSpeed` = 2000 in definitions.ts |
| FRIENDLY_FIRE | false | self-immunity |
| ATTACK_RATE_LIMIT | 100 | ms minimum between attacks |
| THROW_SOURCE_IMMUNITY | 170 | ms (after immunity, self-damage possible) |
| THROWN_WALL_BOUNCE_DURABILITY | 1 | durability lost per wall bounce for thrown weapons |
| THROWN_SELF_DAMAGE_AFTER_IMMUNITY | true | Thrown weapons can damage thrower after 170ms |
| ATTACK_WINDUP_FISTS/MEDIUM/SLOW | — | † fictitious — windup is per-weapon `windupMs` (Fists 50, Dagger 100, Short Sword 150, etc.) |
| ATTACK_WINDUP_FAST | 0.1 | † declared but never read — use per-weapon `windupMs` |
| WEAPON_SWITCH_TIME | 0.15 | seconds to switch weapons |
| WEAPON_BREAK_STAGGER | 0.33 | seconds of stagger on weapon break |
| WEAPON_BREAK_SWITCH_AFTER_STAGGER | true | Auto-switch queued until stagger ends |
| SHIELD_BREAK_STAGGER | 0.5 | default; per-weapon `staggerOnBreakMs` overrides (shields: 300ms) |
| DEATH_ANIMATION_DURATION | 0.5 | seconds |
| DEATH_CAMERA_ZOOM | 0.3 | seconds |
| DEATH_CAMERA_ZOOM_FACTOR | 0.7 | Camera zooms out to 70% on death |
| FREEZE_FRAME_DURATION | 0.05 | seconds (50ms on kill) |
| DAMAGE_NUMBER_DURATION | 1.0 | seconds |
| KILL_FEED_MAX_ENTRIES | 5 | maximum visible entries |
| KILL_FEED_FADE_TIME | 5 | seconds before entry fades |
| STAGGER_MOVE_SPEED_PENALTY | 0.5 | 50% move speed during stagger |
| ARC_INNER_RADIUS | 48 | px (player edge) |
| LINE_ATTACK_WIDTH | 20 | px (10px each side) |
| WINDUP_UNCANCELLABLE | true | Attack windup cannot be cancelled |
| DEAD_BODY_COLLISION | true | Dead player body retains collision during 0.5s death anim |
| SHIELD_BLOCKS_ENVIRONMENTAL | false | Shields only block player attacks |
| SHIELD_DAMAGE_NEGATION | 1.0 | 100% damage negation on block |
| SHIELD_KNOCKBACK_ON_BLOCK | 0 | No knockback applied to defender on block |
| SHIELD_BLOCK_DURATION_MAX | Infinity | No duration limit — block persists until ATTACK input is released or durability reaches 0. |
| BARREL_SELF_DAMAGE | true | Barrel explosions damage the player who triggered them |
| BARREL_DESTRUCTIBLE_DAMAGE | 50 | HP damage to destructibles from barrel explosion |
| THROWN_DURABILITY_ZERO_SHATTER | true | Thrown weapon at 0 durability shatters, does not drop |
| LINE_HITS_ALL_IN_WIDTH | true | LINE attacks hit all entities within 20px width, not just first |
| MELEE_WALL_HIT_DURABILITY_COST | 1 | † DEAD — declared + unit-tested but never consumed. Walls effectively cost 0 durability. |
| THROWN_FLIGHT_NOT_PICKUPABLE | true | Thrown weapons in flight cannot be picked up |
| SHIELD_THROW_COOLDOWN | 500 | ms cooldown between shield throws |
| HIT_FLASH_DURATION | 0.1 | seconds (~100ms white flash on damage) |
| FREEZE_FRAME_CLIENT_SIDE_ONLY | true | Freeze frame is client-side visual only, not server tick pause |
| KNOCKBACK_REPLACEMENT | true | New knockback overwrites existing velocity (not additive) |

## 16.4 Network

| Constant | Value | Description |
|----------|-------|-------------|
| TICK_RATE | 60 | Hz (physics) |
| PATCH_RATE | 60 | Hz (network, matches physics tick) |
| MAX_LATENCY | 500 | ms |
| INPUT_BUFFER_SIZE | 120 | slots |
| SNAPSHOT_INTERVAL | 0 | 0 = snapshot every physics tick (60Hz). Patch rate matches physics (60Hz). |
| REMOTE_INTERP_DELAY | 50 | ms interpolation buffer for remote entities |
| PREDICTION_ERROR_THRESHOLD | 64 | px — smooth snap above this |
| PREDICTION_SNAP_DURATION | 100 | ms — smoothstep snap duration |

## 16.5 Match

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_PLAYERS | 64 | |
| MIN_PLAYERS | 32 | |
| COUNTDOWN_DURATION | 5 | seconds |
| MATCHMAKING_DURATION | 90 | seconds before bot fill |
| TARGET_DURATION | 500 | seconds — informational target (HUD timer); the live pacing is the zone phase table |
| OVERTIME_START | 500 | Fallback surface only — live Sudden Death starts when the zone reaches phase 7 (~255s at current pacing) |
| RESULTS_SCREEN_DURATION | 30 | seconds |
| AFK_TIMEOUT | 60 | seconds, bot takes over |
| AFK_WARNING | 30 | seconds, warning shown |
| AFK_WARNING_BROADCAST | false | AFK warning only shown to the AFK player, not broadcast |
| DISCONNECT_TOTAL_TO_BOT | 60 | Total seconds from disconnect to bot takeover. Phase 1: 0-30s frozen. Phase 2: 30-60s vulnerable. Bot takeover at T+60s. |
| DISCONNECT_PHASE1_DURATION | 30 | seconds frozen grace period |
| DISCONNECT_PHASE2_DURATION | 30 | seconds alive but cannot act |
| BOT_TAKEOVER_DIFFICULTY | medium | Default difficulty for takeover bots |
| TIEBREAKER_4 | player_id | Lowest Player ID wins if all other tiebreakers equal |

## 16.6 Zone

| Constant | Value | Description |
|----------|-------|-------------|
| ZONE_CENTER_X | 5120 | Initial center (Phase 1), shifts each phase |
| ZONE_CENTER_Y | 5120 | Initial center (Phase 1), shifts each phase |
| INITIAL_ZONE_RADIUS | 5120 | Full map at start |
| ZONE_TICK_INTERVAL | 0.5 | Seconds between damage ticks |
| ZONE_DAMAGE_PER_TICK | 8 | HP per tick (16 HP/s at 0.5s interval) |
| ZONE_DAMAGE_SUDDEN_DEATH | 15 | HP per tick in sudden death (30 HP/s) |
| ZONE_WARNING_TIME | 10 | Seconds before phase transition |
| ZONE_TRANSITION_DURATION | 30 | Seconds for zone circle to shrink |
| SIEGE_WALL_DROP_INTERVAL | 3 | Seconds between wall row drops |
| SIEGE_WALL_DROP_INTERVAL_OT | 1.5 | Accelerated in overtime |
| SIEGE_CRUSH_DAMAGE | 100 | Instant kill on wall crush |
| ZONE_PHASE_1_RADIUS | 1.0 | 100% of INITIAL_ZONE_RADIUS |
| ZONE_PHASE_2_RADIUS | 0.60 | 60% of INITIAL_ZONE_RADIUS |
| ZONE_PHASE_3_RADIUS | 0.25 | 25% of INITIAL_ZONE_RADIUS |
| ZONE_PHASE_4_RADIUS | 0.15 | 15% of INITIAL_ZONE_RADIUS (768px) |
| ZONE_PHASE_5_RADIUS | 0.10 | 10% of INITIAL_ZONE_RADIUS (512px) |
| ZONE_PHASE_6_RADIUS | 0.08 | 8% of INITIAL_ZONE_RADIUS (410px, ~5×5 tile area) |
| ZONE_PHASE_OT_RADIUS | 0.08 | Same as Phase 6, static — no further shrink |
| ZONE_PHASE_1_DURATION | 60 | seconds |
| ZONE_PHASE_2_DURATION | 45 | seconds |
| ZONE_PHASE_3_DURATION | 45 | seconds |
| ZONE_PHASE_4_DURATION | 45 | seconds |
| ZONE_PHASE_5_DURATION | 30 | seconds |
| ZONE_PHASE_6_DURATION | 30 | seconds |
| SIEGE_WALL_WARNING_DURATION | 0.5 | seconds (visual warning before wall solidifies) |
| ZONE_CENTER_MIN_BOUNDARY_RATIO | 0.2 | Candidate center must be at least 0.2 × CURRENT_ZONE_RADIUS from the current zone's edge. |
| ZONE_TRANSITION_TYPE | linear | Radius interpolation during transition |
| SIEGE_SIDE_CYCLE | N,S,E,W | Sequential siege wall progression |
| SIEGE_TRIGGER_RULE | sector_center | Sector enters siege when its CENTER is outside safe zone |
| SIEGE_SKIP_EXISTING_WALLS | true | Siege walls do not override existing INDESTRUCTIBLE walls/crates |
| ZONE_CENTER_MAX_ATTEMPTS | 50 | Max random attempts before fallback centroid |
| ZONE_CENTER_REACHABILITY | true | Center must be pathfindable to non-sieged sector |

## 16.7 Barrel

| Constant | Value | Description |
|----------|-------|-------------|
| EXPLOSION_RADIUS | 256 | px (2 tiles — 5x5 blast area) |
| EXPLOSION_DAMAGE | 50 | HP |
| MAX_EXPLOSIONS_PER_RESOLUTION | 20 | Safety cap for recursive barrel explosions |

## 16.8 Power-Ups

| Constant | Value | Description |
|----------|-------|-------------|
| HEALTH_PACK_HEAL | 30 | HP |
| BARRIER_DURATION | 10 | seconds |
| SPEED_BOOST_MULTIPLIER | 1.75 | multiplier |
| SPEED_BOOST_DURATION | 20 | seconds |
| POWERUP_AUTO_PICKUP | true | Walk-over auto-collect, no E key |
| POWERUP_DESPAWN | false | Power-ups persist indefinitely |
| HEALTH_PACK_SKIP_FULL_HP | true | Health Pack not consumed at full HP |
| BARRIER_BLOCKS_ZONE | true | Barrier blocks zone and trap damage |
| BARRIER_BLOCKS_SIEGE_CRUSH | false | Siege crush bypasses barrier |
| POWERUP_STACK_DIFFERENT | true | Different power-ups can be active simultaneously |

## 16.9 Destructibles

| Constant | Value | Description |
|----------|-------|-------------|
| CRATE_HP | 1 | hits to destroy |
| BARREL_HP | 2 | hits to destroy |
| DESTRUCTIBLE_WALL_HP | 5 | hits to destroy |
| CRATE_DENSITY_GRIDARENA | 0.25 | 25% of empty tiles |
| CRATE_DENSITY_OPENARENA | 0.10 | 10% of empty tiles |
| CRATE_DENSITY_MAZE | 0.05 | 5% of empty tiles |
| CRATE_DENSITY_RESOURCERICH | 0.15 | 15% of empty tiles |
| CHEST_COUNT_GRIDARENA | 2 | per sector |
| CHEST_COUNT_OPENARENA | 1 | per sector |
| CHEST_COUNT_MAZE | 1 | per sector |
| CHEST_COUNT_RESOURCERICH | 3 | per sector |

## 16.10 HUD

| Constant | Value | Description |
|----------|-------|-------------|
| MINIMAP_SIZE | 200 | 200×200 pixels |
| MINIMAP_POSITION | top-right | Corner of screen |
| MINIMAP_SCALE | 16.5 | World-px per minimap-px (~3304px shown in 200px minimap) |
| FRESH_SPAWN_FLASH_RATE | 5 | Hz (flashes per second) |
| FRESH_SPAWN_FLASH_OPACITY | 0.3 | Minimum opacity during flash |
| SCREEN_SHAKE_INTENSITY | 4 | Pixels offset |
| SCREEN_SHAKE_DURATION | 0.2 | Seconds |
| SCREEN_SHAKE_DECAY | linear | Full to zero over duration |
| SCREEN_SHAKE_BARREL_DISTANCE | 600 | px threshold for barrel explosion shake (distance-scaled) |
| SCREEN_FLASH_BARREL_DISTANCE | 300 | px threshold for barrel explosion screen flash (distance-scaled) |
| SCREEN_SHAKE_DEATH_DISTANCE | 256 | px threshold for nearby death shake |

## 16.11 Pickup

| Constant | Value | Description |
|----------|-------|-------------|
| PICKUP_PRIORITY | closest_first | Closest entity wins regardless of type or tier |
| PICKUP_TIEBREAKER | lowest_player_id | When two players pick up same tick |
| PICKUP_TIER_TIEBREAKER | highest_tier | Among same-distance weapons, highest tier wins |
| CRATE_LOOT_DROP_RATE | 0.6 | 60% chance |
| CRATE_LOOT_WEAPON_CHANCE | 0.7 | 70% of drops are weapons |
| CRATE_LOOT_TIER_COMMON | 0.80 | 80% of weapon drops |
| CRATE_LOOT_TIER_UNCOMMON | 0.15 | 15% of weapon drops |
| CRATE_LOOT_TIER_RARE | 0.04 | 4% of weapon drops |
| CRATE_LOOT_TIER_LEGENDARY | 0.01 | 1% of weapon drops |

**Note:** Three independent loot systems: (1) Crate drops (these weights), (2) Ground spawns (MAP_SPAWN_WEIGHT_*), (3) Chest loot (§11 per-tier tables).

| MAP_SPAWN_WEIGHT_COMMON | 0.70 | 70% |
| MAP_SPAWN_WEIGHT_UNCOMMON | 0.20 | 20% |
| MAP_SPAWN_WEIGHT_RARE | 0.08 | 8% |
| MAP_SPAWN_WEIGHT_LEGENDARY | 0.02 | 2% |
| WEAPON_DESPAWN_ENABLED | false | Weapons persist indefinitely |
| POWERUP_DESPAWN_ENABLED | false | Power-ups persist indefinitely |
| PICKUP_BLOCKED_DURING_STAGGER | true | |

## 16.12 Entity Placement

| Constant | Value | Description |
|----------|-------|-------------|
| ENTITY_MIN_SPACING | 2 | Manhattan distance between placed entities |
| ENTITY_BORDER_BUFFER | 1 | Tiles from sector border |
| CORRIDOR_COUNT | 1 | Openings per shared wall |
| CORRIDOR_POSITION | centered | On shared wall |

## 16.13 Traps

| Constant | Value | Description |
|----------|-------|-------------|
| TRAP_REVEAL_RANGE | 2 | Tiles — traps hidden until player within range |
| TRAP_REVEAL_PERMANENT | true | Revealed traps stay visible for all players |
| TRAP_PERSISTENT | true | All traps are persistent (not consumed on trigger) |
| TRAP_DASH_TRIGGER | true | Dashing triggers traps normally |
| SPIKE_TRAP_DAMAGE | 25 | HP |
| SPIKE_TRAP_STUN | 0.5 | Seconds |
| SPIKE_TRAP_KNOCKBACK | 128 | px (1 tile, away from trap center) |
| SPIKE_TRAP_COOLDOWN | 1.0 | Seconds |
| FIRE_TRAP_AREA_RADIUS | 1 | Tiles (3x3 area = ±1 from center) |
| FIRE_TRAP_INSTANT_DAMAGE | 15 | HP on trigger (before the DOT starts) |
| FIRE_TRAP_AREA_DOT_DPS | 5 | HP per second |
| FIRE_TRAP_AREA_DURATION | 5.0 | Seconds |
| FIRE_TRAP_AREA_DOT_TICK | 1.0 | Seconds between DOT ticks |
| FIRE_TRAP_AREA_ALL_PLAYERS | true | Area damages ALL players standing in it |
| FIRE_TRAP_RETRIGGER_RESETS | true | Stepping on active fire trap resets duration |
| TELEPORT_TRAP_COOLDOWN | 1.0 | Seconds |
| TRAP_KNOCKBACK_COMPOUNDS | true | Knockback into trap triggers trap additionally |

## 16.14 Chests

| Constant | Value | Description |
|----------|-------|-------------|
| CHEST.INTERACTION_RANGE | 192 | px — chest open range (NOT PICKUP_RADIUS; chests have their own larger range) |
| CHEST_OPEN_DURATION | 0.5 | Seconds |
| CHEST_REQUIRES_STATIONARY | true | Moving >8px from start position cancels chest opening (8px per-axis tolerance) |
| CHEST_DAMAGE_CANCELS | false | Taking damage does NOT cancel opening |
| CHEST_DEATH_CANCELS | true | Player dying cancels opening (chest not consumed) |
| CHEST_LOOT_WEAPON_CHANCE | 0.7 | 70% weapon |
| CHEST_LOOT_POWERUP_CHANCE | 0.3 | 30% power-up |
| CHEST_TIEBREAKER | lowest_player_id | Same as weapon pickup |
| (no inventory-full gate) | — | Chest loot spawns as a ground pickup on an adjacent tile; inventory state never gates opening |

## 16.15 Boomerang (Shield Throw)

| Constant | Value | Description |
|----------|-------|-------------|
| BOOMERANG_RETURN_ON_MISS | true | Shield returns to thrower if no entity/wall hit |
| BOOMERANG_TRACKING | true | Shield tracks thrower's current position on return |
| BOOMERANG_WALL_CANCELS | true | Wall hit cancels boomerang, normal bounce applies |
| BOOMERANG_ENTITY_HIT_CANCELS | true | Entity hit cancels boomerang, drops as pickup |
| BOOMERANG_THROWER_DEATH_DROP | true | Shield drops at current position if thrower dies |
| BOOMERANG_SMALL_SPEED | 400 | px/s (Small Shield flight speed) |
| BOOMERANG_LARGE_SPEED | 375 | px/s (Large Shield flight speed) |
| BOOMERANG_RETURN_DURABILITY_COST | 1 | Durability deducted on successful return |
| BOOMERANG_RETURN_SHATTER | true | Shield shatters if return deducts last durability |
| BOOMERANG_RETURN_ORIGINAL_SLOT | true | Shield returns to original slot, drops occupant if filled |
| BOOMERANG_RETURN_TIMEOUT | 3 | seconds before unreachable shield drops as pickup |

## 16.16 Ground Weapon Spawns

| Constant | Value | Description |
|----------|-------|-------------|
| GROUND_SPAWN_OUTER_MIN | 1 | Minimum spawns per outer ring sector |
| GROUND_SPAWN_OUTER_MAX | 2 | Maximum spawns per outer ring sector |
| GROUND_SPAWN_OUTER_CHANCE | 0.5 | 50% chance of 1, 50% chance of 2, determined by `mapSeed + sectorIndex` hash for deterministic results |
| GROUND_SPAWN_CENTER_MIN | 1 | Minimum spawns per center ring sector |
| GROUND_SPAWN_CENTER_MAX | 2 | Maximum spawns per center ring sector |
| GROUND_SPAWN_CENTER_CHANCE | 0.5 | 50% chance of 1, 50% chance of 2, determined by `mapSeed + sectorIndex` hash for deterministic results |
| GROUND_SPAWN_OUTER_TIER | COMMON | Common 100% |
| GROUND_SPAWN_CENTER_TIER_COMMON | 0.60 | 60% |
| GROUND_SPAWN_CENTER_TIER_UNCOMMON | 0.25 | 25% |
| GROUND_SPAWN_CENTER_TIER_RARE | 0.12 | 12% |
| GROUND_SPAWN_CENTER_TIER_LEGENDARY | 0.03 | 3% |

## 16.17 Combat Collision

| Constant | Value | Description |
|----------|-------|-------------|
| WALL_BLOCKS_MELEE | true | Walls block ARC and LINE melee hitboxes |
| ARROW_HITBOX_WIDTH | 16 | px |
| ARROW_HITBOX_LENGTH | 64 | px |
| THROWN_HITBOX_SIZE | 64 | px (64×64 square) |
| MELEE_WINDUP_CANCEL_ON_DEATH | true | Death during windup cancels attack, no damage applied |
| DASH_DIRECTION_NO_INPUT | facing | Uses facing direction when no movement input |
| DASH_THROUGH_PLAYERS_EFFECT | none | Players being dashed through are unaffected |
| BARREL_DDA_RAYS | 8 | Directional rays (N, NE, E, SE, S, SW, W, NW) |
| SIEGE_WARNING_TILE_WALKABLE | true | Tiles remain walkable during 0.5s siege warning |
| ZONE_CENTER_INTERPOLATION | linear | Center interpolates linearly during 30s transition |
| ZONE_DAMAGE_INSIDE_SAFE | false | Zone damage only applies outside safe zone radius |

## 16.18 Spawn System

| Constant | Value | Description |
|----------|-------|-------------|
| SPAWN_POSITIONS_TOTAL | 64 | One per player |
| SPAWN_POSITIONS_PER_SECTOR | 4 | Even distribution |
| SPAWN_MIN_MANHATTAN_DISTANCE | 3 | Tiles between spawns |
| SPAWN_ALGORITHM | greedy_spread | Pick center-most, then furthest from selected |
| MAP_VALIDITY_MIN_REACHABLE | 0.8 | 80% of EMPTY tiles must be reachable via flood-fill |
| MAP_SEED_SOURCE | server_random | Server generates 32-bit seed at match start |
| MAP_MAX_SEED_RETRIES | 10 | Regenerate if invalid |

---

# 17. Anti-Patterns (27 Forbidden)

1. No `requestAnimationFrame` -- use `scene.update(time, delta)`
2. No raw `addEventListener` for input -- use Phaser Input Plugin
3. No manual canvas drawing -- use Phaser GameObjects
4. No hand-rolled easing/lerp -- use Phaser Tweens
5. No custom particle engine -- use `this.add.particles()`
6. No manual camera tracking -- use `camera.startFollow()`
7. No raw `setTimeout`/`setInterval` for game timing -- use Phaser Timers
8. No custom audio system -- use Phaser Sound
9. No custom scene routing -- use Phaser Scene Manager
10. No raw `new Image()` -- use Phaser Loader (`this.load`)
11. No `JSON.stringify` for state sync -- use Colyseus Schema
12. No custom room management -- use `defineRoom()` + `matchMaker`
13. No custom reconnection logic -- use `allowReconnection()`
14. No manual message validation -- use `validate()` + Zod
15. No raw `setTimeout`/`setInterval` in rooms -- use `this.clock.setTimeout()`
16. No custom rate limiter -- use `maxMessagesPerSecond`
17. No manual state filtering per-client -- use `StateView`
18. No custom matchmaking queue -- use `matchMaker.joinOrCreate()`
19. No raw Redis for cross-room -- use `this.presence`
20. No mock WebSockets in tests -- use `@colyseus/testing`
21. No giant message handlers -- use `@colyseus/command` Dispatcher
22. No custom latency measurement -- use `client.getLatency()`
23. No `any` type anywhere
24. No `@ts-ignore` or `@ts-expect-error`
25. No unused imports or dead code
26. No `new` in hot-path (update/tick) -- use pre-allocated objects or object pools
27. No copying code from reference projects

---

# 18. Performance Budgets

| Metric | Target |
|--------|--------|
| Desktop FPS | 60 sustained |
| Mobile FPS | 30 minimum |
| Server physics step | < 0.3ms per tick (50 bodies) |
| State patch size | < 5KB per tick at 60Hz |
| Max draw calls | < 100 per frame |
| GC pauses | 0 during gameplay (object pools) |
| Network upstream | < 50KB/s per client |
| Network downstream | < 200KB/s per client |
| Initial bundle load | < 2MB |
| Memory (30 min session) | < 200MB, no leaks |

---

# 19. File Constraints

| Rule | Value |
|------|-------|
| Max file length | 450 lines |
| TypeScript strict mode | Enabled |
| No `any` types | Enforced |
| No `@ts-ignore` | Enforced |
| No `console.log` in production | Enforced |
| JSDoc on public APIs | Required |
| No external runtime deps in shared | Enforced |
| Deterministic map from seed | Required |

---

# 20. Enums Reference

## WeaponTier

```typescript
enum WeaponTier {
  COMMON = 'common',
  UNCOMMON = 'uncommon',
  RARE = 'rare',
  LEGENDARY = 'legendary',
}
```

**NOTE**: Fists are treated as tier NONE (below Common) for code consistency. Not a formal enum value — use a null/undefined check for 'no tier'.

**Tier Rank Ordering:** `TIER_RANK = { NONE: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, LEGENDARY: 4 }`. Ordering for all comparison purposes: Legendary > Rare > Uncommon > Common > None (Fists).

## AttackType

```typescript
enum AttackType {
  ARC = 'arc',
  LINE = 'line',
  THROWN = 'thrown',
  RANGED = 'ranged',
  SHIELD = 'shield',
}
```

## WeaponType

```typescript
enum WeaponType {
  FISTS = 0,
  DAGGER = 1,
  SHORT_SWORD = 2,
  LONG_SWORD = 3,
  HAMMER = 4,
  LARGE_AXE = 5,
  BLADED_AXE = 6,
  DOUBLE_AXE = 7,
  SPEAR = 8,
  POLEARM = 9,
  STAFF = 10,
  THROWING_AXE = 11,
  SHORT_BOW = 12,
  CROSSBOW = 13,
  SMALL_SHIELD = 14,
  LARGE_SHIELD = 15,
}
```

## PowerUpType

```typescript
enum PowerUpType {
  HEALTH_PACK = 0,
  BARRIER = 1,
  SPEED_BOOST = 2,
}
```

## TrapType

```typescript
enum TrapType {
  SPIKE = 0,
  FIRE = 1,
  TELEPORT = 2,
}
```

## MatchPhase

```typescript
enum MatchPhase {
  WAITING = 0,
  COUNTDOWN = 1,
  ACTIVE = 2,
  ZONE_SHRINKING = 3,
  OVERTIME = 6,
  FINAL_CLOSURE = 7,
  FINISHED = 5,
}
```

**NOTE**: ACTIVE covers zone phases 1-3 (0-150s). ZONE_SHRINKING covers zone phases 4-5 (150-225s). FINAL_CLOSURE covers zone phase 6 (225-255s). OVERTIME starts at 255s. The band thresholds DERIVE from the zone phase table (shared `MatchPhaseStateMachine`) — a zone pacing tuning moves them with it.

### MatchPhase Transition Table

| From | To | Trigger |
|------|----|---------|
| WAITING (0) | COUNTDOWN (1) | Host starts OR player threshold reached |
| COUNTDOWN (1) | ACTIVE (2) | Countdown timer expires (5s) |
| ACTIVE (2) | ZONE_SHRINKING (3) | Zone phase 4 starts at 150s (derived from the phase table) |
| ZONE_SHRINKING (3) | FINAL_CLOSURE (7) | Zone phase 6 starts at 225s (derived from the phase table) |
| FINAL_CLOSURE (7) | OVERTIME (6) | Zone phase 7 / match timer reaches 255s (derived from the phase table) |
| OVERTIME (6) | FINISHED (5) | Last player standing OR OT timer 300s |

## Direction

```typescript
enum Direction {
  NONE = 0,
  UP = 1,
  DOWN = 2,
  LEFT = 3,
  RIGHT = 4,
}
```

**NOTE**: Used for UI indicators and animation only. Movement input uses continuous (dx, dy) floats. NOT used in input processing.

## TileType

```typescript
enum TileType {
  EMPTY = 0,
  INDESTRUCTIBLE_WALL = 1,
  DESTRUCTIBLE_WALL = 2,
  CHEST = 3,
  EXIT = 4,
  DESTRUCTIBLE_CRATE = 6,
  DESTRUCTIBLE_BARREL = 7,
  INDESTRUCTIBLE_CRATE = 8,
}
```

## PlayerStatus

```typescript
const PlayerStatus = {
  ALIVE: 1,
  DEAD: 2,
  SPECTATING: 4,
  INVINCIBLE: 8,
  STAGGERED: 16,
  FRESH_SPAWN: 32,
  DYING: 64,
} as const;
```

**NOTE**: This is a bitmask. A player can have multiple flags: `ALIVE | INVINCIBLE`, `ALIVE | FRESH_SPAWN`, etc. Removed: DISCONNECTED (bot takes over), FROZEN (replaced by STAGGERED). The DYING flag replaces ALIVE — a dying player is NOT alive. See §7.33 for state machine invariants. DYING (64): Set at HP=0, replaces ALIVE flag. Duration 0.5s (death animation). After animation: clears DYING, sets SPECTATING. During DYING: body retains collision, weapons already dropped, effects cancelled, immune to new damage.

### PlayerStatus Invariants

- ALIVE and DEAD are mutually exclusive (only one set at a time)
- DYING replaces ALIVE (DYING implies NOT ALIVE, NOT DEAD)
- SPECTATING requires the DYING→SPECTATING transition has completed (player was DYING, now SPECTATING)
- STAGGERED requires ALIVE (dead/dying players can't stagger)
- INVINCIBLE requires ALIVE (dead/dying players have no invincibility)
- FRESH_SPAWN requires ALIVE (dead/dying players lose fresh spawn)
- Valid transition: ALIVE [+flags] → DYING → SPECTATING
- Valid substates during ALIVE: ALIVE|INVINCIBLE, ALIVE|FRESH_SPAWN|INVINCIBLE, ALIVE|STAGGERED
- Impossible states: DEAD|ALIVE, STAGGERED|DEAD, STAGGERED|DYING, SPECTATING|ALIVE

### PlayerStatus Transition Table

| Trigger | From | To | Notes |
|---------|------|----|-------|
| Spawn | 0 (none) | ALIVE \| INVINCIBLE \| FRESH_SPAWN (33) | 3s invincibility |
| Fresh spawn expire (3s) | ALIVE \| INVINCIBLE \| FRESH_SPAWN (33) | ALIVE (1) | Clears INVINCIBLE + FRESH_SPAWN bits |
| HP = 0 | ALIVE (1) [+ any flags] | DYING (64) | status \|= DYING; status &= ~ALIVE; clear STAGGERED/INVINCIBLE/FRESH_SPAWN |
| 0.5s death animation timer | DYING (64) | DEAD (2) | Intermediate state |
| Auto-follow (immediate) | DEAD (2) | SPECTATING (4) | Camera follows killer |
| Weapon break during ALIVE | ALIVE (1) | ALIVE \| STAGGERED (17) | 0.2s stagger |
| Shield break during ALIVE | ALIVE (1) | ALIVE \| STAGGERED (17) | 0.3s stagger |
| Stagger expire | ALIVE \| STAGGERED (17) | ALIVE (1) | Clears STAGGERED bit |
| Barrier pickup | ALIVE (1) | ALIVE \| INVINCIBLE (9) | 10s invincibility |
| Barrier expire (10s) | ALIVE \| INVINCIBLE (9) | ALIVE (1) | Clears INVINCIBLE bit |
| Disconnect during ALIVE | ALIVE (1) | ALIVE (1) | Entity frozen, bot takeover after 60s |

## ChestRarity

```typescript
enum ChestRarity {
  COMMON = 0,
  RARE = 1,
  EPIC = 2,
  LEGENDARY = 3,
}
```

**Disambiguation:** ChestRarity (COMMON, RARE, EPIC, LEGENDARY) and WeaponTier (COMMON, UNCOMMON, RARE, LEGENDARY) are independent systems. Chest rarity determines loot quality distribution. Weapon tier determines item stats and color. They use different naming (e.g., ChestRarity.EPIC ≠ WeaponTier.RARE).

## EntityType

```typescript
enum EntityType {
  PLAYER = 0,
  PROJECTILE = 1,
  POWERUP = 2,
  TRAP = 3,
  CHEST = 4,
  DESTRUCTIBLE = 5,
  EXIT_DOOR = 6,
  EXPLOSION = 7,
  WEAPON_PICKUP = 8,
}
```

## InputAction

```typescript
enum InputAction {
  MOVE = 0,
  ATTACK = 1,
  THROW = 2,
  PICKUP = 3,
  SWITCH_SLOT = 4,
  DASH = 5,
}
```

**NOTE**: Removed INTERACT (merged with PICKUP — pressing E near a chest picks up OR opens). Removed USE_ITEM (no use-item mechanic exists). Removed BOMB (no bomb system). Removed BLOCK — shield blocking uses ATTACK input instead; when a shield is equipped, ATTACK activates block (hold to block, release to stop). PICKUP handles both instant pickup (weapons, power-ups via auto-collection) and channeled chest opening (0.5s). Server determines behavior by checking nearest interactable type within PICKUP_RADIUS.

---

# 21. Audio Design

## 21.1 Sound Effects (32)

| Sound | Trigger |
|-------|---------|
| barrel-explode | Barrel explosion |
| chest-open | Common chest opened |
| chest-rare | Rare+ chest opened |
| countdown-beep | Countdown tick (5, 4, 3, 2, 1) |
| countdown-go | Match start |
| defeat | Player eliminated |
| footstep | Player movement (loop) |
| hit-arrow | Arrow impact |
| hit-melee | Melee weapon impact |
| hit-shield | Shield block |
| hit-thrown | Thrown weapon impact |
| pickup-powerup | Power-up collected |
| pickup-weapon | Weapon collected |
| player-death | Player eliminated (their death) |
| player-kill | Kill confirmation |
| trap-deactivate | Trap disabled |
| trap-trigger | Trap activated |
| victory-fanfare | Victory |
| wall-hit | Weapon hits wall |
| zone-damage | Zone damage tick |
| zone-shrink | Zone closing |
| zone-warning | Zone warning announcement |
| weapon-break | Metal crack/break sound. Plays when any non-shield weapon reaches 0 durability |
| dash | Whoosh sound. Plays when player activates dash |
| siege-wall-drop | Heavy impact/crash. Plays when a siege wall drops. Louder for nearby players |
| weapon-switch | Quick metallic clink. Plays when player switches weapon slots |
| player-stagger | Dazed bell/ring sound. Plays when player gets staggered |
| powerup-activate | Ascending chime. Plays when Barrier or Speed Boost activates |
| spawn-protection-end | Short chime. Plays when 3s fresh spawn protection expires |
| trap-reveal | Soft click/whisper. Plays when a hidden trap becomes visible to a player |
| siege-wall-warning | Rumble/creak. Plays at start of 0.5s siege wall warning animation |
| weapon-drop | Soft thud. Plays when a weapon drops to the ground (swap, death drop) |

## 21.2 Music (4 tracks)

| Track | Context |
|-------|---------|
| menu-theme | Main menu |
| lobby-theme | Pre-game lobby |
| gameplay-intense | During match |
| results-theme | Post-match results |

---

# 22. Asset Pipeline

- Source assets: `game-assets/` directory (PNG format)
- Assets used DIRECTLY as PNG — NO conversion to WebP
- Phaser loads assets from `game-assets/` directly
- Asset manifest maps logical names to file paths
- Sprite sizes match tile sizes exactly (128×128 for tiles/characters, 34×34 for hands, 48×48 for icons)
- Audio format: OGG (preferred for web — smaller file size, supports streaming, broad browser compatibility). All sound effects and music tracks use OGG format. No MP3/WAV.
