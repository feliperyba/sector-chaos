/**
 * menuDioramaGrammar — the map-grammar layer of the menu diorama: the 5-layer
 * scroll-factor band (ticket 28 / doc 19), the bake-haze tint, and the G1–G5
 * tile-array + structural helpers (rect/hLine/vLine, fieldFill, borderRing,
 * centralHearth, aisle, cornerDetail, the far/fore silhouette builders) that
 * compose every variant's 5 parallax layers via `buildMapLayers`. Mechanical
 * extraction from menuDioramaComposition.ts (F8 file-length retirement) —
 * bodies verbatim, only the module boundary moved. Every helper is PURE (no
 * RNG, no Date.now) → the composition is byte-identical across boots.
 */
import type { MenuDioramaLayer, MenuDioramaTileEntry } from './menuDioramaComposition.js';

// ─── Ticket 28 — 5-layer parallax band (far < bg < mid=1.0 < near < fore) ───
//
// Per doc 19 (`findings/19-cooler-parallax.md` §3): widens the Scheme-B parallax
// band from 0.6 (0.7↔1.3) to 1.15 (0.45↔1.60) — roughly doubling the peak
// BG↔FG drift separation to ~±20px. MID stays at 1.0 MANDATORY (every light
// anchor is world-locked there — the HdrLit world-pos reconstruction assumes
// sf=1.0, `LightingPipelineUpdate.ts:106-107`). far/bg < 1.0 (slow); near/fore
// > 1.0 (fast). APPEND-ONLY: the ticket-27 `bg`/`mid`/`fg` constants + their
// byte-pinned data are UNCHANGED — `MENU_FG_SCROLL_FACTOR` stays 1.3 (the
// `fg` layer IS the `near` layer; `MENU_NEAR_SCROLL_FACTOR` is the doc-19
// vocabulary alias, same value, for the 5-layer discussion).

/** FAR scrollFactor — the distant plane (slowest drift, strongest haze). */
export const MENU_FAR_SCROLL_FACTOR = 0.45;
/** BG scrollFactor — far grass field + tree grove perimeter drifts slow. */
export const MENU_BG_SCROLL_FACTOR = 0.7;
/** MID scrollFactor = 1.0 MANDATORY (all light anchors are world-locked here). */
export const MENU_MID_SCROLL_FACTOR = 1.0;
/** FG scrollFactor — nearest scatter drifts fastest (the legacy "near" layer). */
export const MENU_FG_SCROLL_FACTOR = 1.3;
/** NEAR scrollFactor — doc-19 vocabulary alias of FG (the near scatter plane). */
export const MENU_NEAR_SCROLL_FACTOR = MENU_FG_SCROLL_FACTOR; // 1.3
/** FORE scrollFactor — the foreground silhouette frame (fastest drift). */
export const MENU_FORE_SCROLL_FACTOR = 1.6;

/**
 * Bake-time haze tint — the C5 ambient floor (`LightingTiers.ts:109`,
 * `AMBIENT_FLOOR[5] = [0.28, 0.24, 0.18]` → 0x473D2E). NOT the stale ticket-23
 * `vec3(0.18,0.15,0.12)` literal. Applied INSIDE `bakeLayer` as a translucent
 * `rt.fill(color, alpha)` wash stamped once at boot (NOT a shader pass). The
 * fill uses `source-over` at partial alpha (`DynamicTexture.js:397-401`) → it
 * BLENDS the baked albedo toward the haze color, producing atmospheric
 * perspective (far = desaturated + lifted toward the warm-dark floor) with zero
 * per-frame cost. The pipeline sees the hazed pixels as ordinary albedo.
 */
export const MENU_HAZE_COLOR = 0x473d2e;

// ─── Tile-array helpers (private — used by all variant builders) ───
//
// `rect`/`hLine`/`vLine` are the col-outer/row-inner primitives (deterministic
// stamp order). The grammar helpers below (`fieldGrass`/`treeGroveRing`/
// `medallion`/`corridor`/...) compose these to express the G1–G5 rules shared
// by all 8 variants (ticket 27) — so the per-variant builders stay auditable
// + the cohesion contract is enforced structurally (you can't build a variant
// that skips the medallion or the border ring).

/** Fill a col×row rectangle with one frame (col-outer, row-inner). */
function rect(
  c0: number,
  c1: number,
  r0: number,
  r1: number,
  frame: string,
): MenuDioramaTileEntry[] {
  const out: MenuDioramaTileEntry[] = [];
  for (let col = c0; col <= c1; col++)
    for (let row = r0; row <= r1; row++) out.push({ frame, col, row });
  return out;
}

/** Horizontal line of tiles along one row (col ascending). */
function hLine(c0: number, c1: number, row: number, frame: string): MenuDioramaTileEntry[] {
  const out: MenuDioramaTileEntry[] = [];
  for (let col = c0; col <= c1; col++) out.push({ frame, col, row });
  return out;
}

/** Vertical line of tiles along one column (row ascending). */
function vLine(col: number, r0: number, r1: number, frame: string): MenuDioramaTileEntry[] {
  const out: MenuDioramaTileEntry[] = [];
  for (let row = r0; row <= r1; row++) out.push({ frame, col, row });
  return out;
}

// ─── G1–G5 grammar helpers (ticket 27 — shared by all 8 variants) ───
//
// Source: doc 18 (`findings/18-2d-hd-pattern-grammar.md`) §2 + the worked
// forest-bonfire example (§5). Every helper is PURE (no RNG, no Date.now) →
// the composition is byte-identical across boots and survives the RT bake.

/**
 * G3 — deterministic variation predicate. Pure function of (col,row) → the
 * rendered floor is byte-identical across boots (no `Math.random` in
 * composition). `(col*7 + row*13) % modulus < threshold` swaps ~threshold/modulus
 * of base tiles for a variation frame. The `7`/`13` strides are coprime → the
 * swapped tiles don't form axis-aligned stripes (doc 18 §2 G3).
 */
function isVariation(col: number, row: number, modulus = 10, threshold = 1): boolean {
  return (col * 7 + row * 13) % modulus < threshold;
}

// ─── Structural helpers (shared ring + hearth — the arena frame) ───
//
// Only the FLOOR FILL + BORDER RING + CENTRAL HEARTH are shared structural
// elements. The cover/loot/rubble/doors that used to live in shared
// `coverClusters`/`lootSpots` helpers are now per-variant `scatter` arrays —
// each variant composes its own sparse, atmospheric prop layout so they read
// as distinct vignettes rather than the same busy map 8× over.
//
// Every helper is PURE (no RNG, no Date.now) → byte-identical across boots.

/**
 * M1 — unified floor fill. Complete 16×9 underlay with ~10% deterministic
 * variation (base↔alt swap via `isVariation`).
 *
 * **CRITICAL: `base` and `alt` MUST be opaque full-tile floor frames** (grass /
 * tiles / tiles_cracked / tiles_decorative / wood / tile). NEVER pass
 * transparent decoration sprites (plants / planks / puddle / path) — they would
 * punch see-through holes in the floor underlay, creating a messy visual.
 * Decorations go in the optional `decorations` array: they are APPENDED after
 * the fill so they render ON TOP of the opaque floor (both the floor tile and
 * the decoration occupy the same cell, the later one draws over the former).
 */
function fieldFill(
  base: string,
  alt: string,
  decorations?: MenuDioramaTileEntry[],
): MenuDioramaTileEntry[] {
  const out: MenuDioramaTileEntry[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 16; col++) {
      out.push({ frame: isVariation(col, row, 10, 1) ? alt : base, col, row });
    }
  }
  // Append decorations AFTER the fill so they render on top of the opaque floor.
  if (decorations) out.push(...decorations);
  return out;
}

/**
 * M2 — Bomberman border wall ring + 4 corners. Mirrors `blankBordered()`
 * (`gridArenaSkeletons.ts:48-61`): every real sector starts with this.
 * The `pillar` frame parameter sets the wall type (wall / wall_damaged /
 * wall_secret) so the border tracks the biome's pillar style.
 *
 * The `wall` sprite is designed HORIZONTAL (its long axis runs left↔right).
 * Top + bottom borders use it at 0° (correct). The LEFT + RIGHT borders must
 * rotate it 90° CW / 270° CW so the wall texture runs vertically and connects
 * to the horizontal top/bottom walls at the corners. The 4 `wall_corner`
 * pieces also rotate (NW=0°, NE=90°, SE=180°, SW=270°) to orient each corner's
 * wall-faces toward its neighbors (mirrors `MapRenderer.ts:369` rotation).
 */
function borderRing(pillar: string): MenuDioramaTileEntry[] {
  return [
    ...hLine(0, 15, 0, pillar), // top — horizontal, 0°
    ...hLine(0, 15, 8, pillar), // bottom — horizontal, 0°
    // Left border — rotate 90° CW so the horizontal wall sprite runs vertically.
    ...vLine(0, 1, 7, pillar).map((t) => ({ ...t, rotation: 90 })),
    // Right border — rotate 270° CW (mirror of left) for L/R symmetry.
    ...vLine(15, 1, 7, pillar).map((t) => ({ ...t, rotation: 270 })),
    // 4 corners — each rotated to connect its two wall neighbors.
    { frame: 'wall_corner', col: 0, row: 0, rotation: 0 }, // NW
    { frame: 'wall_corner', col: 15, row: 0, rotation: 90 }, // NE
    { frame: 'wall_corner', col: 15, row: 8, rotation: 180 }, // SE
    { frame: 'wall_corner', col: 0, row: 8, rotation: 270 }, // SW
  ];
}

/**
 * M6 — central hearth: 2×2 `center` tiles directly under the fire anchor
 * (7.5, 1.5). The centroid of cols 7–8 × rows 1–2 is exactly (7.5, 1.5).
 */
function centralHearth(center: string): MenuDioramaTileEntry[] {
  return rect(7, 8, 1, 2, center);
}

/**
 * The worn path/aisle spine — a 2-tile-wide run down cols 7–8 (rows `r0`→`r1`)
 * that carries the eye from the hearth down through the stage to the entrance.
 * This is the room's DIRECTIONAL AXIS (the lit sightline to the fire); without
 * it the floor is a flat field and props read as floating. A BG floorDecoration
 * (parallax-locked to the floor) so it never consumes the MID scatter budget.
 * The frame is biome-parametric: `path` (earth), `track` (road/forge),
 * `tiles_decorative` (sacred aisle), `tile` (dry walkway over flood).
 */
export function aisle(frame: string, r0: number, r1: number): MenuDioramaTileEntry[] {
  const out: MenuDioramaTileEntry[] = [];
  for (let row = r0; row <= r1; row++) {
    out.push({ frame, col: 7, row }, { frame, col: 8, row });
  }
  return out;
}

/**
 * FG foreground detail — sparse lower-corner props at scrollFactor 1.3 for
 * parallax depth. Frames the bottom edge without competing with the map.
 */
function cornerDetail(): MenuDioramaTileEntry[] {
  return [
    { frame: 'crate_small', col: 4, row: 7 },
    { frame: 'crate_small', col: 11, row: 7 },
    { frame: 'plants', col: 1, row: 7 },
    { frame: 'plants', col: 14, row: 7 },
  ];
}

/**
 * The biome parameter set for the unified map builder. Only the WALL RING +
 * HEARTH are shared structural elements — every variant hand-composes its own
 * `scatter` (3–6 props placed for atmosphere, not map-balance) so each reads
 * as a distinct vignette instead of the same busy map with a vocabulary swap.
 */
interface MapBiome {
  /** Floor base frame — MUST be opaque (grass / tiles / wood / tiles_decorative). */
  floor: string;
  /** Floor variation frame — MUST be opaque (tiles_cracked). Same as `floor` for uniform. */
  floorAlt: string;
  /** Optional decorations overlaid ON the floor (plants, puddles). Transparent sprites OK here. */
  floorDecorations?: MenuDioramaTileEntry[];
  /** Pillar + border wall frame (wall / wall_damaged / wall_secret). */
  pillar: string;
  /** Central hearth frame (tiles_center / tile). */
  hearth: string;
  /**
   * The variant's hand-composed MID-layer props (cover, loot, doors, water,
   * rubble, …). SPARSE by design (3–6 tiles): atmosphere over density. Every
   * tile must sit OFF the border ring + hearth (the focal zone cols 7–8 ×
   * rows 1–2 stays clear so the fire dominates). Disjointness from the light
   * placements is guarded by the no-stack registry test.
   */
  scatter: MenuDioramaTileEntry[];
  /** Far silhouette tiles (distant plane). */
  far: MenuDioramaTileEntry[];
  /** Fore silhouette frame (tree / wall / wall_damaged). */
  fore: string;
  /**
   * Per-variant bake-haze tint (Phase 4 spec v2 P7/A1 — "same light, different
   * air"). Applied to the far (α 0.28) + bg (α 0.12) layers in `buildMapLayers`
   * (the haze fields are consumed per-layer in `bakeLayer`,
   * `MenuBackground.ts:406`). Varying this per variant differentiates biomes —
   * warm forest, cold blue-grey crypt, blue flooded, golden temple, desaturated
   * dusk graveyard — while the lighting spine (one warm fire key + split-tone
   * grade + ambient floor) stays identical across all 8. Defaults to
   * `MENU_HAZE_COLOR` (the warm ambient floor) when omitted.
   */
  hazeColor?: number;
}

/**
 * Build all 5 parallax layers from a biome spec. The MID layer carries ONLY
 * the shared wall ring + central hearth + the variant's `scatter`; BG is the
 * complete floor underlay with optional decoration overlays; far/fg/fore
 * carry the parallax depth planes. Keeping the MID skeleton minimal (ring +
 * hearth) lets each variant's scatter define its own spatial character.
 */
export function buildMapLayers(biome: MapBiome): MenuDioramaLayer[] {
  const haze = biome.hazeColor ?? MENU_HAZE_COLOR;
  const bgTiles = fieldFill(biome.floor, biome.floorAlt, biome.floorDecorations);
  // Phase 4 spec v2 D5 — Y-sort the scatter by (row, col) so lower-screen props
  // stamp LAST (draw on top of higher-screen ones). This is the cheap
  // "things sit in front of other things" depth cue within the single baked MID
  // plane — a stable sort preserves each variant's intended stamp order within a
  // row. The border ring + hearth stay first (they never overlap interior props).
  const sortedScatter = [...biome.scatter].sort((a, b) => a.row - b.row || a.col - b.col);
  const midTiles: MenuDioramaTileEntry[] = [
    ...borderRing(biome.pillar),
    ...centralHearth(biome.hearth),
    ...sortedScatter,
  ];
  return [
    {
      id: 'far',
      scrollFactor: MENU_FAR_SCROLL_FACTOR,
      tiles: biome.far,
      hazeColor: haze,
      hazeAlpha: 0.28,
    },
    {
      id: 'bg',
      scrollFactor: MENU_BG_SCROLL_FACTOR,
      tiles: bgTiles,
      hazeColor: haze,
      hazeAlpha: 0.12,
    },
    { id: 'mid', scrollFactor: MENU_MID_SCROLL_FACTOR, tiles: midTiles },
    { id: 'fg', scrollFactor: MENU_FG_SCROLL_FACTOR, tiles: cornerDetail() },
    { id: 'fore', scrollFactor: MENU_FORE_SCROLL_FACTOR, tiles: foreSilhouette(biome.fore) },
  ];
}

// ─── Ticket 28 — 5-layer parallax additions (far + fore; doc 19) ───
//
// APPEND-ONLY per doc 19 §3: the byte-pinned ticket-27 bg/mid/fg arrays stay
// byte-identical; these helpers produce the two NEW sparse layers. `far` is the
// distant silhouette plane (sf 0.45, haze-washed toward the ambient floor);
// `fore` is the foreground silhouette frame (sf 1.60, the "looking through"
// read). Both are SPARSE — the extra bake cost is negligible, and the wider sf
// band (0.45↔1.60) doubles the peak parallax separation vs the legacy 0.7↔1.3.
//
// Every helper is PURE (no RNG, no Date.now) → byte-identical across boots.

/**
 * Ticket 28 `far` — distant tree-line silhouette (outdoor variants: forest +
 * graveyard). A SPARSE row of distant `tree` frames at row 0 across the OPEN
 * part of the bg grove ring (cols 3–12 — the blaze clearing). These sit BEHIND
 * the bg grove (depth −1 < bg 0) + are washed toward `MENU_HAZE_COLOR` at α 0.28
 * → they read as the treeline fading into atmospheric haze. Under camera drift
 * the slower sf (0.45) reveals them at the top screen edge as a distant layer.
 */
export function farTreeLine(): MenuDioramaTileEntry[] {
  return [
    { frame: 'tree', col: 3, row: 0 },
    { frame: 'tree', col: 5, row: 0 },
    { frame: 'tree', col: 8, row: 0 },
    { frame: 'tree', col: 10, row: 0 },
    { frame: 'tree', col: 12, row: 0 },
  ];
}

/**
 * Ticket 28 `far` — distant dark-wall silhouette (interior variants: crypt +
 * flooded + secret). A SPARSE pair of distant `wall` frames at row 0 flanking
 * the anchor. Sits BEHIND the bg field + is haze-washed → reads as the far wall
 * fading into the ambient floor.
 */
export function farDarkWall(): MenuDioramaTileEntry[] {
  return [
    { frame: 'wall', col: 4, row: 0 },
    { frame: 'wall', col: 11, row: 0 },
  ];
}

/**
 * Ticket 28 `far` — distant ruined-wall silhouette (ruined/threshold variants:
 * ruined-courtyard + armory-cache + temple-threshold). A SPARSE pair of distant
 * `wall_damaged` frames at row 0. Haze-washed → reads as the breached far wall.
 */
export function farRuinedWall(): MenuDioramaTileEntry[] {
  return [
    { frame: 'wall_damaged', col: 4, row: 0 },
    { frame: 'wall_damaged', col: 11, row: 0 },
  ];
}

/**
 * Ticket 28 `fore` — the foreground silhouette frame. Dark shapes crossing the
 * top + upper side edges (the "looking through" read), center OPEN so the logo
 * + hearth stay unobstructed. The frame shape is variant-agnostic (every
 * variant gets the same top-edge + upper-corner silhouette); only the ATLAS
 * FRAME varies by biome:
 *   - outdoor (forest/graveyard) → `tree` (dangling canopy)
 *   - interior (crypt/flooded/secret) → `wall` (vault arch)
 *   - ruined/threshold (ruined/armory/temple) → `wall_damaged` (broken arch)
 *
 * The frame is sparse enough (12 tiles) that legibility is preserved — the
 * silhouette occludes only the corners, not the focal zone. At depth 5 it
 * renders in FRONT of the light-prop sprites (depth 4) + in front of MID (1),
 * so it correctly frames the hearth. NO haze wash (the open center must stay
 * transparent — `rt.fill` would fill it with dark).
 */
function foreSilhouette(frame: string): MenuDioramaTileEntry[] {
  return [
    // Top-left corner cluster (cols 0–3, row 0) — the lintel's left haunch.
    { frame, col: 0, row: 0 },
    { frame, col: 1, row: 0 },
    { frame, col: 2, row: 0 },
    { frame, col: 3, row: 0 },
    // Top-right corner cluster (cols 12–15, row 0) — the lintel's right haunch.
    { frame, col: 12, row: 0 },
    { frame, col: 13, row: 0 },
    { frame, col: 14, row: 0 },
    { frame, col: 15, row: 0 },
    // Upper-left side (cols 0–1, row 1) — the hanging branch / wall side.
    { frame, col: 0, row: 1 },
    { frame, col: 1, row: 1 },
    // Upper-right side (cols 14–15, row 1) — mirrored.
    { frame, col: 14, row: 1 },
    { frame, col: 15, row: 1 },
  ];
}
