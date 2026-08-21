/**
 * Pure composition data + **variant registry spine** for the menu diorama.
 * Each variant is a Bomberman-style map: border wall ring + lattice pillars +
 * connected cover clusters + tactical loot placement, parameterized by a biome
 * (floor texture, wall type, cover type, head-wall feature, silhouettes).
 *
 * This file is the SINGLE source of truth for "which dioramas exist + how to
 * pick one per menu open." It imports ZERO Phaser runtime symbols — only data
 * + types + pure functions — so the registry contract is unit-testable WITHOUT
 * booting WebGL (the `LightingPipeline` ctor throws on non-WebGL, and Phaser's
 * import-time WebGL probe trips under jsdom).
 *
 * Consumed by:
 *   - `MenuBackground.ts` (calls `pickMenuDioramaVariant` once at boot, then
 *     resolves composition via `getMenuDioramaComposition(id)` + placements via
 *     `getMenuDioramaPlacements(id)` + the aura anchor via
 *     `getMenuDioramaAuraAnchor(id)`).
 *   - `MenuDioramaLighting.ts` receives the resolved placements + aura anchor
 *     as `boot()` args (dependency-injected by `MenuBackground` — keeps this
 *     file free of any import back from composition, so there is no module
 *     cycle: composition → constants only ← lighting).
 *   - Tests under `__tests__/` (verify the registry + map-grammar contract).
 *
 * ── Composition philosophy (flavour scenes — 2-tone chiaroscuro) ──
 *
 * Each variant is a DISTINCT, evocative PLACE — "Elven Glade", "Siege Aftermath",
 * "Barrow Tomb", "Dwarven Forge-hall", … (LOTR / tavern / battlefield energy) —
 * not 8 reshuffles of one skeleton. Four structural elements are shared so the
 * space always reads as an enclosed ARENA (a room, not a flat grid):
 *
 *   Floor underlay — complete 16×9 opaque fill (every cell painted, including
 *                     under walls). The #1 rule from `docs/glossary.md ("Layer Compositing")`.
 *   Border ring     — full perimeter wall ring + 4 corners (blankBordered).
 *   Central hearth  — 2×2 tiles_center/tile directly under the fire anchor.
 *   Path aisle      — a worn 2-tile run (cols 7–8) from the hearth down through
 *                     the stage = the room's directional spine (the lit sightline
 *                     to the fire). A BG floorDecoration, parallax-locked.
 *
 * Everything else — cover, loot, rubble, doors, water, weapons — lives in the
 * variant's own `scatter` array, placed in MOTIVATED clusters hugging the walls
 * / corners (a supply cache, a weapon rack, a coffin row) so props relate to the
 * architecture instead of floating mid-floor. Each variant also overlays ONE
 * aperture on the ring (a doorway / breach / sealed door) so it reads as a
 * different space, and carries a per-variant bake-haze tint ("same light,
 * different air"). The fire focal zone (cols 7–8, rows 1–2) + the button UI
 * stage (cols 6–9, rows 4–6) stay clear of tall props.
 *
 * ── Lighting (per-variant UNIQUE rigs — campfire hero + retuned supports) ──
 *
 * Each variant ships its OWN light geometry + fixture combination (NO shared
 * structural spine — see `Placement builders` below). The constant budget: 1
 * central campfire hero (7.5, 1.5) + 4 warm supports + 2 biome-glow crystals.
 * The geometry, the fixture kind-mix + the crystal locale are ALL unique per
 * variant (the mood-distinctness decision — every ambient IS UNIQUE).
 *
 * The campfire is the sole hero (its own disk; the additive aura was REMOVED —
 * it was the single biggest clutter source). The 6 secondary lights are dimmed
 * + tightened menu-locally (`LightPlacementTiled.radius` / `.intensity` cosmetic
 * overrides) so the fire dominates (~2:1) + the scene reads as chiaroscuro. A
 * distance-falloff bakes a natural decay into the supports so the rig never
 * reads as a placed ring. Crystals are static `biome-glow` placements carrying
 * the variant's hue via the per-placement `color` override + `pulse: true` (a
 * slow ~0.4Hz breath in the packer) — grounded in corner voids, off the UI zone.
 *
 * Cohesion across variants = the SAME budget + the SAME hero fire + the SAME two
 * tone families (warm key + desaturated biome accent); distinction = the unique
 * geometry + kind-mix + hue + scatter + floor + haze.
 *
 * The central fire anchor stays at (7.5, 1.5) in EVERY variant — the logo
 * silhouette + camera framing depend on it (do NOT move the fire).
 *
 * ── Adding a variant ──
 *
 * A new variant is **append-only** — exactly THREE edits, all in this file:
 *   1. Add the id to the `MenuDioramaVariantId` union.
 *   2. Add the id to `MENU_DIORAMA_VARIANT_IDS` (the selector's sample space).
 *   3. Add one entry to the `VARIANTS` registry:
 *      `{composition, placements, auraAnchor}`.
 * No other file needs to change for the registry to rotate the new variant.
 */
import type { LightPlacementTiled } from '@sector-battle/shared';
import {
  MENU_DIORAMA_TILE_SIZE,
  MENU_DIORAMA_STAGE_W,
  MENU_DIORAMA_STAGE_H,
  CENTRAL_FIRE_COL,
  CENTRAL_FIRE_ROW,
} from './MenuDioramaLighting.js';

// F8 extraction: the map-grammar helpers + the 5-layer scroll/haze constants
// moved to menuDioramaGrammar.ts, the per-variant composition builders to
// menuDioramaCompositions.ts, and the light-rig tone tables + placement
// builders to menuDioramaPlacements.ts — all re-exported here so every existing
// `from './menuDioramaComposition.js'` import site compiles unchanged
// (LightingPipelineTypes.ts `export *` precedent).
export * from './menuDioramaGrammar.js';
import {
  buildForestBonfireComposition,
  buildForestGladeComposition,
  buildForestRuinsComposition,
  buildForestCreekComposition,
  buildCryptAntechamberComposition,
  buildArmoryCacheComposition,
  buildTempleThresholdComposition,
} from './menuDioramaCompositions.js';
import {
  buildForestBonfirePlacements,
  buildForestGladePlacements,
  buildForestRuinsPlacements,
  buildForestCreekPlacements,
  buildCryptAntechamberPlacements,
  buildArmoryCachePlacements,
  buildTempleThresholdPlacements,
  TONE_WARM,
  TONE_BIOME,
} from './menuDioramaPlacements.js';

/** Tile size for the diorama (`packages/shared/src/constants/grid.ts:3`). */
export const TILE_SIZE = MENU_DIORAMA_TILE_SIZE; // 128
/** Oversized stage (02 §3: 16 cols × 9 rows × 128px). */
export const STAGE_W = MENU_DIORAMA_STAGE_W; // 2048
export const STAGE_H = MENU_DIORAMA_STAGE_H; // 1152

// ─── 04 Scheme B camera neutral ───

/**
 * Stage-centered scroll neutral (04 §2). `(2048-1920)/2 = 64`,
 * `(1152-1080)/2 = 36` — the natural centering offset that puts the stage
 * center (1024, 576) at the viewport center (960, 540), and the fire (world
 * 1024, 256) at screen (960, 220) behind the logo (960, 194).
 */
export const MENU_CAMERA_NEUTRAL_X = 64;
export const MENU_CAMERA_NEUTRAL_Y = 36;

// ─── Composition layer types (02's locked scene, pure data) ───

/**
 * One placed atlas frame in the curated diorama. Coordinates are tile-grid
 * (col, row); pixel center = `col*TILE_SIZE + TILE_SIZE/2`.
 */
export interface MenuDioramaTileEntry {
  /** Atlas frame name in the `game` atlas (verified against `game.json`). */
  frame: string;
  /** Tile column (may be fractional for sprites that span tiles). */
  col: number;
  /** Tile row (may be fractional for sprites that span tiles). */
  row: number;
  /**
   * Optional display scale multiplier (1 = tile-filling 128×128). The central
   * campfire is doubled across 2 tiles via scale 2 (02 §9.3 — the prototype's
   * "big hearth" read; new art is a 03 gap).
   */
  scale?: number;
  /**
   * Optional rotation in degrees clockwise (ticket 26). Applied at bake time
   * via `setRotation((rotation * Math.PI) / 180)` — Phaser's `setRotation`
   * takes radians, so the degrees→radians conversion mirrors
   * `MapRenderer.renderStaticVisualLayers` (`MapRenderer.ts:369`) +
   * `LightPropRenderer` (`LightPropRenderer.ts:309`), which consume the sibling
   * `LightPlacementTiled.rotation` the same way. Omitted/0 = no rotation
   * (byte-identical to pre-ticket-26). **Ticket 27 uses this for the G2
   * focal-medallion's rotated rug corners** (NE/NW/SW/SE orientations).
   */
  rotation?: number;
  /**
   * Optional horizontal flip (ticket 26). Applied at bake time via
   * `setFlipX(true)` — decoupled from `scale` (Phaser's `flipX` composes with
   * `setScale`/`setDisplaySize` at render time, unlike the scale-sign flip
   * MapRenderer uses). Mirrors the `flipH` vocabulary on `LightPlacementTiled`.
   * Omitted/false = no flip (byte-identical to pre-ticket-26).
   */
  flipH?: boolean;
}

/**
 * A composition layer — a slice of 02's layout baked into one RT.
 *
 * **Ticket 28** extends the layer-id union from `{bg,mid,fg}` to
 * `{far,bg,mid,fg,fore}` (doc 19 — 5-layer parallax). The `fg` layer IS the
 * `near` layer (sf 1.3) — kept under its legacy id so ticket-27's byte-pinned
 * bg/mid/fg arrays stay UNCHANGED (append-only: `far` + `fore` are ADDED per
 * variant, nothing is renamed). The `hazeColor`/`hazeAlpha` fields carry the
 * bake-time atmospheric haze (far + bg only; mid/near/fore stay clean).
 */
export interface MenuDioramaLayer {
  /** Stable id for diagnostics + tests (far < bg < mid < fg=near < fore). */
  id: 'far' | 'bg' | 'mid' | 'fg' | 'fore';
  /** The scrollFactor for this layer's RT (04 Scheme B / doc 19 5-layer). */
  scrollFactor: number;
  /** The atlas frames stamped into the RT, in stamp order. */
  tiles: MenuDioramaTileEntry[];
  /**
   * Optional bake-time haze wash color (ticket 28 / doc 19 §2c). Applied INSIDE
   * `bakeLayer` as a translucent `rt.fill(hazeColor, hazeAlpha)` overlay AFTER
   * the tiles are stamped + BEFORE `rt.render()` — a bake-time blend toward the
   * haze color, NOT a shader pass. Set on `far` (α≈0.28) + `bg` (α≈0.12) to
   * produce atmospheric perspective toward the ambient floor (`MENU_HAZE_COLOR`
   * = 0x473D2E). Omitted on `mid`/`fg`/`fore` (light anchors live on mid; fore
   * is a dark silhouette whose open center must NOT be filled).
   */
  hazeColor?: number;
  /** Optional bake-time haze wash alpha (0..1; 0/undefined = no wash). */
  hazeAlpha?: number;
}

// ─── Variant registry spine (ticket 14) ───

/**
 * Registered diorama variant ids. **Ticket 15 appends here** (and to
 * `MENU_DIORAMA_VARIANT_IDS` + `VARIANTS`). `'forest-bonfire'` is the single
 * 02 scene; ticket 15 appends the 7 curated themed variants; ticket 27
 * rebuilds all 8 in the unified G1–G5 grammar.
 */
export type MenuDioramaVariantId =
  | 'forest-bonfire'
  | 'forest-glade'
  | 'forest-ruins'
  | 'forest-creek'
  | 'crypt-antechamber'
  | 'armory-cache'
  | 'temple-threshold';

/**
 * Ordered list of registered variant ids — the rotation selector's sample
 * space. The order is the display order. Forest-forward: 4 forest sub-themes
 * (bonfire / glade / ruins / creek) + 3 distinct interiors (crypt / armory /
 * temple). The 4 weakest/most-redundant themes (ruined-courtyard,
 * flooded-dungeon, secret-passage, graveyard-tomb) were RETIRED.
 */
export const MENU_DIORAMA_VARIANT_IDS: readonly MenuDioramaVariantId[] = [
  'forest-bonfire',
  'forest-glade',
  'forest-ruins',
  'forest-creek',
  'crypt-antechamber',
  'armory-cache',
  'temple-threshold',
];

/**
 * The central-fire anchor for a variant (where the campfire hero sits). The
 * WebGL additive aura that used to be co-located here was REMOVED (the clutter
 * fix); the anchor stays because the Canvas-fallback glow (`MenuBackground`
 * `buildCanvasFallbackSpec`) still consumes it on non-WebGL. Every variant's fire
 * sits at (7.5, 1.5) — the logo framing depends on it.
 */
export interface MenuDioramaVariantAuraAnchor {
  /** Tile-grid column of the central fire / aura (matches `placements`'s fire). */
  gridX: number;
  /** Tile-grid row of the central fire / aura (matches `placements`'s fire). */
  gridY: number;
}

/**
 * A full variant bundle — what 15 appends ONE of to `VARIANTS` per new theme.
 * Bundles the static scenery (composition) + the motivated fixtures (placements)
 * + the central-fire/aura anchor so a variant is fully described by one entry.
 */
export interface MenuDioramaVariant {
  /**
   * Static scenery layers baked into the 5 parallax RTs (ticket 28 / doc 19:
   * far/bg/mid/fg/fore). Pre-ticket-28 this was 3 (bg/mid/fg); the far + fore
   * layers were APPENDED (byte-identical bg/mid/fg tile arrays preserved).
   */
  composition: MenuDioramaLayer[];
  /** Static light placements (campfire + perimeter torches/lanterns/crystals). */
  placements: LightPlacementTiled[];
  /** Central-fire / aura anchor (co-located with the fire). */
  auraAnchor: MenuDioramaVariantAuraAnchor;
}

// ─── The registry ───

/**
 * The variant registry. Ticket 27 rebuilt all 8 entries in the unified G1–G5
 * grammar. `Readonly` keeps entries immutable at the type level (defensive
 * against accidental in-place mutation of a shared entry).
 */
const VARIANTS: Readonly<Record<MenuDioramaVariantId, MenuDioramaVariant>> = {
  'forest-bonfire': {
    composition: buildForestBonfireComposition(),
    placements: buildForestBonfirePlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'forest-glade': {
    composition: buildForestGladeComposition(),
    placements: buildForestGladePlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'forest-ruins': {
    composition: buildForestRuinsComposition(),
    placements: buildForestRuinsPlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'forest-creek': {
    composition: buildForestCreekComposition(),
    placements: buildForestCreekPlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'crypt-antechamber': {
    composition: buildCryptAntechamberComposition(),
    placements: buildCryptAntechamberPlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'armory-cache': {
    composition: buildArmoryCacheComposition(),
    placements: buildArmoryCachePlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
  'temple-threshold': {
    composition: buildTempleThresholdComposition(),
    placements: buildTempleThresholdPlacements(),
    auraAnchor: { gridX: CENTRAL_FIRE_COL, gridY: CENTRAL_FIRE_ROW },
  },
};

/**
 * Resolve a variant bundle by id. Throws on an unknown id — the rotation
 * selector only ever returns registered ids, so a throw here means a programming
 * error (typo, or a `MenuDioramaVariantId` not added to `VARIANTS`). Fail-fast
 * beats a silent wrong diorama.
 */
export function getMenuDioramaVariant(id: MenuDioramaVariantId): MenuDioramaVariant {
  const variant = VARIANTS[id];
  if (!variant) {
    throw new Error(
      `MenuDiorama: unknown variant id "${id}" (not in VARIANTS registry; registered: ${MENU_DIORAMA_VARIANT_IDS.join(', ')})`,
    );
  }
  return variant;
}

/** Resolve the composition layers for a variant (5 parallax RTs: far/bg/mid/fg/fore). */
export function getMenuDioramaComposition(id: MenuDioramaVariantId): MenuDioramaLayer[] {
  return getMenuDioramaVariant(id).composition;
}

/** Resolve the static light placements for a variant (campfire + perimeter). */
export function getMenuDioramaPlacements(id: MenuDioramaVariantId): LightPlacementTiled[] {
  return getMenuDioramaVariant(id).placements;
}

/** Resolve the central-fire / aura anchor for a variant. */
export function getMenuDioramaAuraAnchor(id: MenuDioramaVariantId): MenuDioramaVariantAuraAnchor {
  return getMenuDioramaVariant(id).auraAnchor;
}

// ─── Title effect palette (theme-adaptive particle / ring / glow colors) ───
//
// The title's impact particles + ring waves + glow used to be locked to a
// single hardcoded warm "ember" set (forge/brass/cream), so every variant's
// title flare read orange regardless of whether the backdrop was an emerald
// glade, a violet crypt, or an ivory temple. This palette derives the title
// flare from the SAME two tones the diorama lights use — TONE_WARM (the
// campfire, constant) + TONE_BIOME[id] (the place accent) — so the flare reads
// as "this fire, in this place".
//
// Mapping (see ImpactEffect.ts):
//   glow + inner ring  → warm   (the campfire's own flare — constant identity)
//   mid ring + burst   → biome  (the place accent — the adaptive read)
//   burst deep slot    → deep   (darkened biome — place-colored deep embers)
//   outer ring + burst → cream  (luminous highlight — constant)
//
// HEX NOT LINEAR: TONE_* are linear-RGB [0,1] (fed to the HDR lighting shader).
// Phaser particle `tint` + `graphics.fillStyle` want sRGB hex. We convert via
// the standard linear→sRGB transfer function (IEC 61966-2-1), NOT a naive ×255:
// linear values map to BRIGHTER sRGB than their number suggests (linear 0.45 →
// sRGB 0.70, i.e. 179 not 115), so ×255 read ~30% too dark + hue-shifted, and
// the title flare did not match the tonemapped backdrop. The lights themselves
// stay linear; this conversion is ONLY for the UI tints on the title decal
// (depth ≥ pipeline cutoff, never lit by it). The backdrop ALSO passes through
// ACES + a warm grade (final.frag), so this is the closest analytic fit, not a
// byte-exact replica — retune by eye against the rendered menu if it drifts.

/** Title-flare highlight + core (constant across variants). */
const TITLE_CREAM = 0xfff4e0;
const TITLE_WHITE_HOT = 0xffffff;
/** Per-channel multiply for the "deep" burst slot (darkened biome accent).
 *  0.6 keeps it a readable dim spark; lower (0.45) collapsed to near-black mud
 *  that was invisible on the additive burst. */
const TITLE_DEEP_MULT = 0.6;

/** linear-RGB [0,1] → sRGB-encoded channel [0,1] (IEC 61966-2-1 transfer fn). */
function linearToSrgbChannel(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

/** linear-RGB [0,1]³ → sRGB hex (proper transfer — see linearToSrgbChannel). */
function linearToHex(rgb: readonly [number, number, number]): number {
  const r = Math.round(Math.min(1, Math.max(0, linearToSrgbChannel(rgb[0]!))) * 255);
  const g = Math.round(Math.min(1, Math.max(0, linearToSrgbChannel(rgb[1]!))) * 255);
  const b = Math.round(Math.min(1, Math.max(0, linearToSrgbChannel(rgb[2]!))) * 255);
  return (r << 16) | (g << 8) | b;
}

/** Per-channel darken of an sRGB hex by a multiply factor (for the deep slot). */
function darkenHex(hex: number, mult: number): number {
  const r = Math.round(((hex >> 16) & 0xff) * mult);
  const g = Math.round(((hex >> 8) & 0xff) * mult);
  const b = Math.round((hex & 0xff) * mult);
  return (r << 16) | (g << 8) | b;
}

/**
 * Theme-adaptive color palette for the menu title's impact flare (particle
 * burst + ring waves + glow). Derived from the variant's two light tones so the
 * flare matches the backdrop instead of always reading warm-orange. See the
 * block comment above for the slot → effect mapping.
 */
export interface MenuDioramaTitlePalette {
  /** Fire core — from TONE_WARM (constant). Glow + inner ring. */
  readonly warm: number;
  /** Place accent — from TONE_BIOME[id]. Mid ring + a burst slot. */
  readonly biome: number;
  /** Darkened biome (×0.6) — the deep burst slot (place-colored embers). */
  readonly deep: number;
  /** Luminous highlight — cream (constant). Outer ring + a burst slot. */
  readonly cream: number;
  /** White-hot core — constant (reserved for the impact glow core flash). */
  readonly whiteHot: number;
}

/**
 * Resolve the title-flare palette for a variant. Pure + deterministic: same id
 * → same palette (drives byte-stable title tints per variant, mirroring the
 * light-placement determinism contract).
 */
export function getMenuDioramaTitlePalette(id: MenuDioramaVariantId): MenuDioramaTitlePalette {
  const biomeHex = linearToHex(TONE_BIOME[id]);
  return {
    warm: linearToHex(TONE_WARM),
    biome: biomeHex,
    deep: darkenHex(biomeHex, TITLE_DEEP_MULT),
    cream: TITLE_CREAM,
    whiteHot: TITLE_WHITE_HOT,
  };
}

// ─── Rotation selector (ticket 14 — "rotate every time the player opens the menu") ───

/**
 * RNG type for the rotation selector — `() => number ∈ [0, 1)`. Injectable so
 * tests can drive a seeded RNG (deterministic); production wires `Math.random`
 * (non-deterministic per boot = faithful "rotates every open").
 */
export type MenuDioramaVariantRng = () => number;

/**
 * Pick a diorama variant for this menu open. **Random per open** — the simplest
 * faithful impl of "rotate every time the player opens the main menu" (no
 * persistence needed; ticket 14 spec). The default RNG is `Math.random`, so the
 * pick is non-deterministic across boots (NOT deterministic-by-bug — the RNG is
 * explicitly sourced, not an accidental constant).
 *
 * The `Math.min` clamp guards against the (extremely improbable) `rng() === 1`
 * edge that would make `idx === length` (out of bounds).
 */
export function pickMenuDioramaVariant(
  rng: MenuDioramaVariantRng = Math.random,
): MenuDioramaVariantId {
  const idx = Math.floor(rng() * MENU_DIORAMA_VARIANT_IDS.length);
  const clamped = Math.min(idx, MENU_DIORAMA_VARIANT_IDS.length - 1);
  return MENU_DIORAMA_VARIANT_IDS[clamped]!;
}
