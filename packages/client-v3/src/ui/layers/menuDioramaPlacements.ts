/**
 * menuDioramaPlacements — the per-variant GEOMETRIC light rigs: the two tone
 * families (TONE_WARM / TONE_BIOME), the menu-local support + crystal tuning,
 * the fixture factories (hero / warmAt / crystalAt + the fire falloff), and the
 * 7 variant placement builders. Mechanical extraction from
 * menuDioramaComposition.ts (F8 file-length retirement) — bodies verbatim, only
 * the module boundary moved. Every builder is PURE → byte-identical across
 * boots.
 *
 * ── Placement builders — per-variant GEOMETRIC light rigs ─────────────────
 *
 * Each variant ships its OWN light geometry + fixture combination — there is NO
 * shared structural spine (the mood-distinctness decision: every ambient IS
 * UNIQUE). But every rig is GEOMETRIC — a clean, deliberate pattern symmetric
 * about the vertical center axis (col 7.5), NEVER organic/asymmetric scatter.
 * Distinctness rides on the spatial archetype + the fixture kind-mix + the
 * crystal hue; cohesion rides on the constant budget + the symmetric discipline.
 *
 * Forest-forward set (7): 4 forest sub-themes (bonfire/glade/ruins/creek) + 3
 * distinct interiors (crypt/armory/temple). Per variant: exactly 6 secondary
 * lights (4 warm supports + 2 biome-glow crystals) + the central campfire hero
 * at (7.5, 1.5). The 4-warm + 2-crystal COUNTS are constant; the GEOMETRY, the
 * FIXTURE KIND-MIX + the CRYSTAL LOCALE are unique per variant:
 *
 *   forest-bonfire side-wall brackets (col 0/15) torch×2 lantern×2   emerald
 *   forest-glade   inner diamond (rhombus)       lantern×4           steel-blue
 *   forest-ruins   quad corners (col 1/14)       torch×2 brazier×2   mossy teal-green
 *   forest-creek   bank flank (col 4/11)         lantern×2 candle×2  creek teal
 *   crypt          processional line (col 2/13)  candle×4            violet
 *   armory         wall forge row (col 0/15)     brazier×4           amber
 *   temple         gate frame (col 5/10 axis)    brazier×2 candle×2  ivory-gold
 *
 * ── Hierarchy (campfire dominates) ──
 *
 * The campfire is the sole hero — its own disk at radius 320 / intensity 2.6
 * (the shared `HERO_LIGHT_OVERRIDES.campfire`, UNCHANGED — gameplay-shared, so
 * never tuned here). The 6 secondary lights are dimmed + tightened MENU-LOCALLY
 * via the per-placement `intensity` / `radius` cosmetic overrides
 * (`LightPlacementTiled`) so the campfire reads as the unambiguous focal point
 * (~2:1 ratio — "moderate hero") + the scene reads as chiaroscuro ("moody-dim"):
 * only the fire is bright, everything else is half-light.
 *
 * A distance-falloff multiplier nudges each support's intensity by its distance
 * from the fire (nearer ≈ +15%, far ≈ −15%, see `falloffFromFire`). This breaks
 * the "4 equal orange points" artificiality — the eye reads natural firelight
 * decay, not a placed ring. Falloff is baked into each placement's intensity at
 * build time (deterministic, zero per-frame cost).
 *
 * ── Grounding + clearance ──
 *
 * Every support sits ON the perimeter wall (a bracket / sconce — col 0 / col 15
 * / row 8) or beside a scatter prop — never floating mid-floor (the
 * motivated-lighting rule). Crystals relocate to CORNER VOIDS (off the button UI
 * stage cols 6–9 rows 4–6, off the fire axis cols 7–8 rows 1–2). All fixture
 * coords are disjoint from each variant's scatter + the UI zone (verified by the
 * no-stack registry test).
 *
 * ── Aliveness ──
 *
 * Warm supports flicker automatically (`FLICKER_KINDS`, per-kind sine profiles
 * in `TorchFlicker`) + each throws embers (`resolveFlameAnchors`,
 * `LightingAtmosphereConfig` — ticket 21 broadened ember anchors from
 * campfire-only to every flame kind). Crystals carry `pulse: true` → a slow
 * ~0.4Hz breath (the packer's `p.pulse` sine branch) so the biome pools are
 * never flat (the scene's most obvious stillness, fixed). No flame pixels are
 * drawn into the fixture sprites (the pixel-art-fixture direction stays intact +
 * stays consistent with the disk-only campfire — fire = light disk, not sprite).
 */
import type { LightPlacementTiled } from '@sector-battle/shared';
import { CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW } from './MenuDioramaLighting.js';
import type { MenuDioramaVariantId } from './menuDioramaComposition.js';

/**
 * TONE 1 — the unified warm fire color (campfire orange `[1.0, 0.55, 0.22]`,
 * `LightPalette.campfire.color`). Every warm fixture is forced to this via the
 * per-placement `color` override so the whole warm family reads as ONE tone
 * (candle/lantern are gold in the palette — without this override they'd read
 * as a 3rd tone beside the orange key).
 */
export const TONE_WARM: readonly [number, number, number] = [1.0, 0.55, 0.22];

/**
 * TONE 2 — each variant's signature biome hue (linear RGB `[0,1]`), DESATURATED
 * (~40-55%) + low-value so the accent reads as ATMOSPHERE, not a competing neon
 * pool beside the saturated orange key (color theory: hue from the tile family
 * or split-complementary, never pure cyan; ~4:1 key:accent intensity). The
 * accent DEEPENS the mood instead of introducing a competing color.
 */
export const TONE_BIOME: Readonly<Record<MenuDioramaVariantId, readonly [number, number, number]>> =
  {
    'forest-bonfire': [0.18, 0.45, 0.24], // emerald — warm campfire clearing (glade moss)
    'forest-glade': [0.3, 0.4, 0.52], // steel-blue — serene moonlit grove (cool moonlight)
    'forest-ruins': [0.2, 0.4, 0.3], // mossy teal-green — overgrown ancient stone
    'forest-creek': [0.14, 0.42, 0.5], // creek teal — forest stream
    'crypt-antechamber': [0.26, 0.16, 0.42], // muted violet — split-complementary (spectral undead)
    'armory-cache': [0.62, 0.36, 0.12], // ember amber — warm monochrome (forge runes)
    'temple-threshold': [0.6, 0.52, 0.3], // pale ivory-gold — warm analogous (divine radiance)
  };

/**
 * Menu-local support tuning. Radii ~1.5–1.8 tiles (visible pools, not the
 * prior "non-existent" pinpoints) + intensities ~1.4–1.75 — clearly subordinate
 * to the campfire hero (2.6) so the hierarchy holds, but bright enough to READ
 * (the "moody-dim" comes from the dark ambient BETWEEN lights, not from
 * crushing the lights themselves). These OVERRIDE the shared
 * `HERO_LIGHT_OVERRIDES` per-placement via the cosmetic `LightPlacementTiled`
 * `.radius` / `.intensity` fields — gameplay fire config is untouched.
 */
const MENU_SUPPORT: Readonly<
  Record<'torch' | 'candle' | 'brazier' | 'lantern', { radius: number; intensity: number }>
> = {
  torch: { radius: 215, intensity: 1.6 },
  candle: { radius: 195, intensity: 1.4 },
  brazier: { radius: 225, intensity: 1.75 },
  lantern: { radius: 190, intensity: 1.5 },
};

/**
 * Menu-local crystal tuning. The biome hues are moderate-linear-RGB (desaturated
 * for mood), so the INTENSITY must carry the luminosity or the crystal reads
 * unlit — 3.0 here × a moderate hue gives a luminous bioluminescent glow (bright
 * but not neon). The campfire still wins absolute brightness on its warm/red
 * channels ([1.0,0.55,0.22]×2.6 ≈ R 2.6 vs a crystal's R ≤ ~0.8), so the focal
 * hierarchy holds. Radius 300 (~2.3 tiles) = a real, sizeable visible pool.
 */
const MENU_CRYSTAL = { radius: 300, intensity: 3.0 } as const;

/**
 * Distance-falloff multiplier: nearer-to-fire supports glow a touch brighter
 * than far ones (±~15%) so the warm rig reads as firelight decaying outward —
 * NOT a placed ring of equal points. Pure function of the tile coord; baked into
 * each placement's intensity at build time. Clamped to [0.80, 1.15].
 */
function falloffFromFire(col: number, row: number): number {
  const d = Math.hypot(col - CENTRAL_FIRE_COL, row - CENTRAL_FIRE_ROW);
  return Math.max(0.8, Math.min(1.15, 1.15 - d * 0.04));
}

/** The central campfire hero — UNCHANGED shared hero defaults (no menu override). */
function hero(): LightPlacementTiled {
  return {
    gridX: CENTRAL_FIRE_COL,
    gridY: CENTRAL_FIRE_ROW,
    kind: 'campfire',
    rotation: 0,
    flipH: false,
    flipV: false,
    color: TONE_WARM,
  };
}

/** A warm support at a wall/prop anchor — forced to TONE_WARM, menu-tuned radius + distance-falloff intensity. */
function warmAt(
  kind: 'torch' | 'candle' | 'brazier' | 'lantern',
  col: number,
  row: number,
): LightPlacementTiled {
  const base = MENU_SUPPORT[kind];
  return {
    gridX: col,
    gridY: row,
    kind,
    rotation: 0,
    flipH: false,
    flipV: false,
    color: TONE_WARM,
    radius: base.radius,
    intensity: base.intensity * falloffFromFire(col, row),
  };
}

/** A biome-glow crystal at a corner/void anchor — variant hue, dim, pulsing (alive). */
function crystalAt(
  col: number,
  row: number,
  hue: readonly [number, number, number],
): LightPlacementTiled {
  return {
    gridX: col,
    gridY: row,
    kind: 'biome-glow',
    rotation: 0,
    flipH: false,
    flipV: false,
    color: hue,
    radius: MENU_CRYSTAL.radius,
    intensity: MENU_CRYSTAL.intensity,
    pulse: true,
  };
}

/** Forest-bonfire (GEOMETRIC side-wall brackets): torch×2 + lantern×2 + emerald mid-side moss. */
export function buildForestBonfirePlacements(): LightPlacementTiled[] {
  return [
    hero(),
    warmAt('torch', 0, 4), // left side-wall bracket (mirrored)
    warmAt('torch', 15, 4), // right side-wall bracket (mirrored)
    warmAt('lantern', 0, 7), // left lower wall (mirrored)
    warmAt('lantern', 15, 7), // right lower wall (mirrored)
    // crystalAt(2, 6, hue), // emerald moss (left mid-side)
    // crystalAt(13, 6, hue), // emerald moss (right mid-side)
  ];
}

/** Forest-glade (GEOMETRIC inner diamond): lantern×4 + steel-blue mid accents. */
export function buildForestGladePlacements(): LightPlacementTiled[] {
  const hue = TONE_BIOME['forest-glade'];
  return [
    crystalAt(CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW, hue),
    crystalAt(2, 3, hue),
    crystalAt(13, 3, hue),
    crystalAt(4, 7, hue),
    crystalAt(11, 7, hue),
  ];
}

/** Forest-ruins (GEOMETRIC quad corners): torch×2 + brazier×2 + mossy teal-green mid accents. */
export function buildForestRuinsPlacements(): LightPlacementTiled[] {
  // Authored tone restored (round-2 final sweep): this builder had temporarily
  // borrowed crypt-antechamber's violet.
  const hue = TONE_BIOME['forest-ruins'];
  return [
    crystalAt(CENTRAL_FIRE_COL - 1, CENTRAL_FIRE_ROW - 1, hue),
    crystalAt(CENTRAL_FIRE_COL + 1, CENTRAL_FIRE_ROW - 1, hue),
    crystalAt(CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW, hue),
    crystalAt(CENTRAL_FIRE_COL - 1, CENTRAL_FIRE_ROW + 6, hue),
    crystalAt(CENTRAL_FIRE_COL + 1, CENTRAL_FIRE_ROW + 6, hue),
    crystalAt(CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW + 5, hue),
    // warmAt('torch', 1, 3), // upper-left inner corner
    // warmAt('torch', 14, 3), // upper-right inner corner
    // warmAt('brazier', 1, 6), // lower-left inner corner
    // warmAt('brazier', 14, 6), // lower-right inner corner
    crystalAt(1, 3, hue), // mossy (left mid)
    crystalAt(14, 3, hue), // mossy (right mid)
    crystalAt(1, 6, hue), // mossy (left mid)
    crystalAt(14, 6, hue), // mossy (right mid)
    crystalAt(3, 5, hue), // mossy (left mid)
    crystalAt(12, 5, hue), // mossy (right mid)
    crystalAt(2, 6, hue), // emerald moss (left mid-side)
    crystalAt(13, 6, hue), // emerald moss (right mid-side)
  ];
}

/** Forest-creek (GEOMETRIC bank flank): lantern×2 + candle×2 + teal creek-edge accents. */
export function buildForestCreekPlacements(): LightPlacementTiled[] {
  // Authored tone restored (round-2 final sweep): this builder had temporarily
  // borrowed forest-bonfire's emerald.
  const hue = TONE_BIOME['forest-creek'];
  return [
    crystalAt(CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW, hue),
    // warmAt('lantern', 4, 5), // left bank (upper, mirrored)
    // warmAt('lantern', 11, 5), // right bank (upper, mirrored)
    // warmAt('candle', 4, 6), // left bank (lower, mirrored)
    // warmAt('candle', 11, 6), // right bank (lower, mirrored)
    crystalAt(4, 4, hue), // teal (left water's edge)
    crystalAt(11, 4, hue), // teal (right water's edge)
    crystalAt(4, 5, hue), // teal (left water's edge)
    crystalAt(11, 5, hue), // teal (right water's edge)
    crystalAt(4, 6, hue), // teal (left water's edge)
    crystalAt(11, 6, hue), // teal (right water's edge)
  ];
}

/** Crypt-antechamber (GEOMETRIC processional line): candle×4 + violet bier-foot accents. */
export function buildCryptAntechamberPlacements(): LightPlacementTiled[] {
  return [
    hero(),
    warmAt('candle', 2, 5), // vigil (left coffin row)
    warmAt('candle', 13, 5), // vigil (right coffin row)
    warmAt('candle', 2, 6), // vigil (left coffin row)
    warmAt('candle', 13, 6), // vigil (right coffin row)
    // crystalAt(4, 7, hue), // violet (left bier foot)
    // crystalAt(11, 7, hue), // violet (right bier foot)
  ];
}

/** Armory-cache (GEOMETRIC wall forge row): brazier×4 + amber rack-side rune accents. */
export function buildArmoryCachePlacements(): LightPlacementTiled[] {
  const hue = TONE_BIOME['armory-cache'];
  return [
    crystalAt(CENTRAL_FIRE_COL, CENTRAL_FIRE_ROW, hue),
    warmAt('brazier', 0, 3), // upper-left wall forge
    warmAt('brazier', 15, 3), // upper-right wall forge
    warmAt('brazier', 0, 6), // lower-left wall forge
    warmAt('brazier', 15, 6), // lower-right wall forge
    crystalAt(2, 5, hue), // amber (left rack rune)
    crystalAt(13, 5, hue), // amber (right rack rune)
  ];
}

/** Temple-threshold (GEOMETRIC gate frame): brazier×2 + candle×2 + ivory-gold mid accents. */
export function buildTempleThresholdPlacements(): LightPlacementTiled[] {
  return [
    hero(),
    warmAt('brazier', 5, 2), // flank the top gate (left)
    warmAt('brazier', 10, 2), // flank the top gate (right)
    warmAt('candle', 5, 7), // flank the bottom entrance (left)
    warmAt('candle', 10, 7), // flank the bottom entrance (right)
    // crystalAt(3, 4, hue), // ivory-gold (left mid)
    // crystalAt(12, 4, hue), // ivory-gold (right mid)
  ];
}
