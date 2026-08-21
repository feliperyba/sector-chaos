/**
 * Per-frame light-array packer — pure logic (no Phaser, no GPU).
 *
 * Converts `LightPlacementTiled[]` (deterministic map-gen placements) + a list
 * of dynamic lights (player auras, explosions, projectiles) into the four
 * parallel `Float32Array`s the HdrLit shader consumes:
 *
 *   uLights[i]      = vec4(x, y, radius, intensity*flickerMul)   — stride 4
 *   uLightColors[i] = vec3(r, g, b)                              — stride 3
 *   uLightParams[i] = vec4(corePower, haloFrac, specPower, packedW) — stride 4
 *                     (packedW: cookieIdx + blendOffset; cookieIdx 0=none,
 *                      1=light_01, 2=light_02, 3=light_03; blendOffset
 *                      0=additive, 10=max-blend — D2 per-light accumulation
 *                      blend mode PACKED into .w alongside the cookie index)
 *
 * The GLSL loop is `for (int i = 0; i < MAX_LIGHTS; i++) { if (i >= uLightCount) break; ... }`,
 * so `uLightCount` is the active prefix length and the arrays are sized to
 * `MAX_LIGHTS` (compile-time `#define`, 256).
 *
 * Grid→world px conversion: `world = grid * tileSize + tileSize/2` (tile center).
 *
 * This module is the Seam-A unit-test surface: every byte offset, the
 * intensity-zero-when-disabled rule, and `uLightCount` correctness are
 * asserted in `LightPacker.test.ts`. Keep it pure so the tests stay GPU-free.
 */
import {
  resolveLightKind,
  HERO_LIGHT_OVERRIDES,
  DEFAULT_HERO_LIGHT,
  type LightKind,
  type LightPaletteEntry,
  type LightBlendMode,
} from './LightPalette.js';
import {
  computeFlickerMul,
  computeFlickerMulForKind,
  type FlickerFlameKind,
} from './TorchFlicker.js';
import { hash2, finalizeHash, flickerSeedFromHash } from './LightingHash.js';
import type { LightPlacementTiled } from '@sector-battle/shared';

// Re-export so existing imports from this module (LightingPipeline,
// LightingBudgetStage, GameSceneHelpers, the tests) keep resolving. The
// canonical type lives in @sector-battle/shared — ticket 24 dedupe.
export type { LightPlacementTiled };

/** Compile-time GLSL `#define`; sized once, reused per frame (zero alloc in steady state). */
export const MAX_LIGHTS = 256;

/** Stride constants — exported so tests can assert byte offsets without magic numbers. */
export const LIGHT_STRIDE = 4;
export const COLOR_STRIDE = 3;
export const PARAM_STRIDE = 4;

/**
 * D2 — the per-light accumulation blend mode is PACKED into the cookie-index
 * slot of `uLightParams[i].w` (alongside the cookie index), NOT carried in a
 * separate `uLightBlend[MAX_LIGHTS]` array. A 256-element float array would
 * push the fragment shader's total uniform-vector count over
 * `MAX_FRAGMENT_UNIFORM_VECTORS` on many GPUs → the shader fails to link →
 * black screen (the D2 regression this packing fixes). This constant is the
 * offset added to the cookie index for the max-blend family:
 *   `uLightParams[i].w = cookieIdx + (palette.blend === 'max' ? BLEND_OFFSET_MAX : 0)`
 * The HdrLit shader reads it back via `lp.w > 9.5` (true when packed ≥ 10) and
 * extracts the cookie index via `mod(lp.w, 10.0)`. Pure + unit-tested (Seam A
 * — the single translation site between the palette string and the shader
 * numeric, now folded into the cookie-index slot).
 */
export const BLEND_OFFSET_MAX = 10;

/**
 * A dynamic light submitted each frame by the entity/player/projectile
 * renderers (player auras, explosions, projectiles). Positions are in world px.
 */
export interface DynamicLight {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  color: readonly [number, number, number];
  corePower: number;
  haloFrac: number;
  specPower: number;
  /**
   * Per-light cookie index (ticket 07): 0 = no cookie, 1 = light_01 (warm),
   * 2 = light_02 (cool aura), 3 = light_03 (poison). Packed into
   * `uLightParams[i].w`; the HdrLit shader selects the sampler slot from it.
   */
  cookieOn: number;
  /**
   * D2 — per-light accumulation blend mode. Defaults to `'add'` (energy
   * accumulates; the historical behavior). Set `'max'` only for same-color
   * cluster families where summation produces an unplayable whiteout (player
   * auras, biome-glow). The populator resolves this from the palette's `blend`
   * field; direct `DynamicLight` submitters (chest glint, fire trap) inherit
   * `'add'` unless they explicitly set otherwise (none do today — see
   * DynamicLightPopulator). Packed into `uLightParams[i].w` as an additive
   * offset of `BLEND_OFFSET_MAX` (10) on top of the cookie index (so
   * `uLightParams[i].w = cookieOn + (blend === 'max' ? 10 : 0)`).
   */
  blend?: LightBlendMode;
  /** Per-light flicker multiplier (already CPU-computed by the caller). */
  flickerMul?: number;
}

/** Result of a pack — the arrays + the active count. Arrays are reused. */
export interface PackedLightBuffers {
  uLights: Float32Array;
  uLightColors: Float32Array;
  uLightParams: Float32Array;
  uLightCount: number;
}

/**
 * Allocate fresh backing buffers sized to MAX_LIGHTS. Call once per pipeline
 * lifetime; `packLights` reuses them per frame (zero alloc in steady state).
 */
export function createLightBuffers(): PackedLightBuffers {
  return {
    uLights: new Float32Array(LIGHT_STRIDE * MAX_LIGHTS),
    uLightColors: new Float32Array(COLOR_STRIDE * MAX_LIGHTS),
    uLightParams: new Float32Array(PARAM_STRIDE * MAX_LIGHTS),
    uLightCount: 0,
  };
}

/** Convert a grid tile coordinate to world px (tile center). */
export function gridToWorldPx(grid: number, tileSize: number): number {
  return grid * tileSize + tileSize / 2;
}

/**
 * Map a palette `cookieKey` to the per-light cookie index the HdrLit shader
 * reads from `uLightParams[i].w` (1→light_01/slot2, 2→light_02/slot3,
 * 3→light_03/slot4; 0 = no cookie). Pure + unit-tested (Seam A). D2 packs the
 * blend mode into the same slot (`cookieIdx + (max ? 10 : 0)`); the shader
 * extracts the cookie via `mod(lp.w, 10.0)` and gates on `cookieIdx > 0.5`, so
 * 0 cleanly disables cookie modulation per light.
 */
export function cookieKeyToIndex(cookieKey: string | null): number {
  switch (cookieKey) {
    case 'light_01':
      return 1;
    case 'light_02':
      return 2;
    case 'light_03':
      return 3;
    default:
      return 0;
  }
}

/**
 * Kinds whose packed intensity is modulated by torch flicker each frame
 * (ticket 10). torch/campfire/candle/fireplace/brazier/lantern/barrel-fire
 * flicker ON; biome-glow flickers OFF (a steady ambient tint — the prototype's
 * `isTorch` gate, prototype.js:718, applied to the static map placements).
 * 'aura' is dynamic (player auras, ticket 11) and is flicker-OFF regardless;
 * 'fire'/'poison' are dynamic-only kinds not emitted by the map placer.
 *
 * Ticket 08 (A4): added `fireplace`, `brazier`, `lantern` — each is a real
 * flame prop with its own flicker profile (see `TorchFlicker.FLICKER_PROFILES`).
 * `barrel-fire` stays in the set defensively (it's a flame kind) though the
 * placer never emits it (barrels are inert until they explode; the explosion is
 * a single pulse handled by `ExplosionLightRegistry`, not this flicker path).
 */
const FLICKER_KINDS: ReadonlySet<LightKind> = new Set<LightKind>([
  'torch',
  'campfire',
  'candle',
  'barrel-fire',
  'fireplace',
  'brazier',
  'lantern',
]);

/**
 * Slow-breath pulse frequency (Hz) for the cosmetic per-placement `pulse` flag
 * (menu biome-glow crystals + the in-game hero-landmark beacons of map-redesign
 * ticket 04). ~0.4Hz = a ~2.5s inhale/exhale — slow enough to read as ambient
 * breathing / a beacon's distant glow, never a strobe.
 */
const MENU_PULSE_HZ = 0.4;

/**
 * Derive a deterministic per-placement flicker seed from its grid coords.
 * The map RNG stream already made every placement deterministic; this seed
 * only drives the *visual* flicker phase so co-located flames don't pulse in
 * unison. Stable across clients (same gridX/gridY → same seed → same phase),
 * deterministic (no Math.random). Spread via a cheap integer hash so adjacent
 * tiles don't share a phase.
 */
export function flickerSeedForPlacement(gridX: number, gridY: number): number {
  // Knuth-style integer hash on the packed grid coord (ticket 24: centralized
  // in LightingHash — DynamicLightPopulator + ExplosionEventHandler share it).
  // Result is a stable, well-spread positive seed (mod 1e6 keeps it in a
  // comfortable float range for the flicker sines without losing phase
  // diversity).
  return flickerSeedFromHash(finalizeHash(hash2(gridX, gridY)));
}

/**
 * Deterministic hash → [0,1) float for per-placement tuning (ticket 17
 * ambient-scatter radius/intensity). Same grid coord → same value on every
 * client (no Math.random). Independent of {@link flickerSeedForPlacement}'s
 * hash so scatter tuning + flicker phase don't correlate.
 */
function placementHash01(gridX: number, gridY: number, salt: number): number {
  let h = (gridX * 374761393) ^ (gridY * 668265263) ^ (salt * 2147483647);
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h % 1_000_000) / 1_000_000;
}

/**
 * Resolve the ambient-scatter radius for a placement, deterministically from
 * its grid coords (ticket 17, retuned ticket 07). Origin: the prototype's
 * `120 + ((i*37)%160)` (`prototype.js:611`) → spec range 120–280 (line 117).
 *
 * Ticket 07 (A2 findings §5): raise the band floor so even the smallest
 * scatter light reads as a full-tile soft glow (the prior 120px = 0.94 tile
 * floor was sub-tile). New range 190–320 (1.5–2.5 tiles), midpoint 255. The
 * per-kind palette diffuseness (lowered corePower / raised haloFrac, see
 * LightPalette.ts) makes the wider scatter band read as soft wash, not hot
 * dots. A/B baseline: was 120–280 (span 160, midpoint 200). Stable across
 * clients; spread so adjacent scatter lights don't share a radius. Pure,
 * unit-tested (Seam A).
 */
export function scatterRadiusForPlacement(gridX: number, gridY: number): number {
  // Range 190–320 (span 130), midpoint 255 (ticket 07). Was 120–280 (span 160).
  // Two independent hashes (different salts) mixed so the radius distribution
  // is well-spread across the band.
  return 190 + placementHash01(gridX, gridY, 0x9e3779b9) * 130;
}

/**
 * Resolve the ambient-scatter intensity for a placement, deterministically from
 * its grid coords (ticket 17, retuned ticket 07). Origin: the prototype's
 * `2.0 + Math.random()*1.3` (`prototype.js:612`) → spec range 2.0–3.3.
 *
 * Ticket 07 (A2 findings): dimmer so the wider scatter band doesn't blow out
 * (same principle as the aura/campfire intensity cuts). New range 1.5–2.6
 * (was 2.0–3.3). The wider radius + softer palette carry the diffuse read;
 * raw brightness is no longer the lever. A/B baseline: was 2.0–3.3. Stable
 * across clients. Pure, unit-tested (Seam A).
 */
export function scatterIntensityForPlacement(gridX: number, gridY: number): number {
  return 1.5 + placementHash01(gridX, gridY, 0x85ebca6b) * 1.1;
}

export interface PackOptions {
  /** Master on/off. When false, all intensities become 0 and count becomes 0. */
  enabled: boolean;
  /** Tile size in world px (used for grid→world conversion of placements). */
  tileSize: number;
  /**
   * Wall-clock seconds (drives per-placement flicker for FLICKER_KINDS).
   * When omitted, static placements pack at their base intensity (no flicker)
   * — used by the Seam-A packer tests that assert the base values directly.
   * The pipeline always passes the live time.
   */
  timeSeconds?: number;
  /**
   * Tier flicker gate (the prototype's per-tier flag). When false, no flicker
   * is applied to static placements even for FLICKER_KINDS (matches tier-1
   * baseline A/B). Defaults to true; the pipeline passes `tier.flicker`.
   */
  flickerEnabled?: boolean;
}

/**
 * Pack `placements` + `dynamic` into the three buffers IN PLACE.
 *
 * Order: placements first (deterministic), then dynamic. The active count is
 * the written prefix; the rest of each buffer is left as whatever was there
 * (the GLSL loop breaks at `uLightCount`, so stale tail data is never read).
 *
 * Hero overrides (campfire/aura radius/intensity/flicker) are applied from
 * `HERO_LIGHT_OVERRIDES`; explicit per-placement intensity can override further.
 *
 * Returns the same `buffers` instance with `uLightCount` updated (mutated for
 * zero-alloc steady-state — the caller hands the buffers straight to the GPU).
 */
export function packLights(
  buffers: PackedLightBuffers,
  placements: ReadonlyArray<LightPlacementTiled>,
  dynamic: ReadonlyArray<DynamicLight>,
  options: PackOptions,
  placementIntensityOverrides?: ReadonlyMap<number, number>,
): PackedLightBuffers {
  const { uLights, uLightColors, uLightParams } = buffers;
  const { tileSize } = options;

  if (!options.enabled) {
    buffers.uLightCount = 0;
    return buffers;
  }

  let i = 0;
  const maxLights = MAX_LIGHTS;
  // Static-placement flicker (ticket 10): torch/campfire/candle/barrel-fire
  // get a deterministic per-placement flicker multiplier folded into the
  // packed intensity (same `computeFlickerMul` the test-light fixture uses).
  // biome-glow stays steady (flicker OFF). Gated by the tier flicker flag so
  // tier-1 baseline stays flat. When timeSeconds is omitted (Seam-A tests
  // asserting base values), no flicker is applied.
  const applyStaticFlicker =
    options.flickerEnabled !== false && typeof options.timeSeconds === 'number';
  const t = options.timeSeconds ?? 0;

  // ── Static placements (map-gen) ──
  for (const p of placements) {
    if (i >= maxLights) break;
    const palette: LightPaletteEntry = resolveLightKind(p.kind);
    // Per-placement color override (the menu diorama's 2-tone system): a
    // placement may carry its own linear-RGB color, overriding the kind's
    // palette color so two placements of the same `kind` can differ in hue
    // (e.g. every warm fixture forced to campfire-orange + every biome-glow
    // crystal tinted its variant signature). In-game map-gen placements set
    // `color` only for the landmark beacons (map-polish ticket 03: the
    // district THEME hue — hue=theme, value=tier); every other live light
    // falls through to the palette — zero gameplay regression.
    const color = p.color ?? palette.color;
    // Ticket 17: ambient-scatter placements (`isScatter: true`) resolve their
    // radius/intensity from the prototype's scatter range (120–280 / 2.0–3.3,
    // `prototype.js:611-612`, spec line 117) deterministically from the grid
    // coord — NOT the kind's hero override (the torch hero r=200/i=2.5 would
    // collapse the scatter band to a single value). Motivated props keep the
    // hero override (campfire r=260/i=3.2, etc.). Scatter flicker is OFF (a
    // steady warm fill reads as ambient mood, not strobing flame).
    const isScatter = p.isScatter === true;
    const radius = isScatter
      ? scatterRadiusForPlacement(p.gridX, p.gridY)
      : (p.radius ?? HERO_LIGHT_OVERRIDES[p.kind]?.radius ?? DEFAULT_HERO_LIGHT.radius);
    const baseIntensity = isScatter
      ? scatterIntensityForPlacement(p.gridX, p.gridY)
      : (p.intensity ??
        placementIntensityOverrides?.get(i) ??
        HERO_LIGHT_OVERRIDES[p.kind]?.intensity ??
        DEFAULT_HERO_LIGHT.intensity);
    // Flicker only for motivated flame kinds (FLICKER_KINDS); biome-glow +
    // dynamic-only kinds + ambient-scatter stay at base intensity. The seed is
    // derived from the grid coord so every client computes the same phase.
    //
    // Ticket 08 (A4): per-kind dispatch — each flame kind gets its OWN flicker
    // profile (campfire ROARS, candle steady-flickers, torch modulates,
    // fireplace roars like campfire, brazier steady-medium, lantern very
    // steady). Replaces the pre-ticket-08 single `computeFlickerMul` (a torch-
    // shaped profile applied identically to every flame). `barrel-fire` falls
    // through `resolveFlickerProfile`'s torch fallback (it's never emitted by
    // the placer, so the fallback is defensive only).
    const flickerMul =
      !isScatter && applyStaticFlicker && FLICKER_KINDS.has(p.kind)
        ? // `p.kind` is narrowed to a flame kind by the FLICKER_KINDS gate above
          // (biome-glow is excluded; barrel-fire falls through to the torch
          // profile via resolveFlickerProfile's fallback). The cast is safe
          // because FLICKER_KINDS only contains FlickerFlameKind members.
          computeFlickerMulForKind(p.kind as FlickerFlameKind, {
            t,
            seed: flickerSeedForPlacement(p.gridX, p.gridY),
          })
        : 1.0;
    // Cosmetic per-placement slow-breath pulse (the menu biome-glow crystals —
    // otherwise excluded from FLICKER_KINDS → perfectly steady, the scene's
    // most obvious stillness). Range 0.80..1.00 (shallow — keeps the breath
    // readable without dipping the crystal into an "unlit" trough) at
    // MENU_PULSE_HZ, phase derived from the grid-coord seed so a crystal pair
    // doesn't sync. Map-redesign ticket 04: the in-game hero-landmark BEACONS
    // set `pulse` too (DEC-005 "slow pulse" — a beacon breathes, it does not
    // gutter), so this path is live for them as well.
    const pulseMul =
      !isScatter && p.pulse && applyStaticFlicker
        ? 0.9 +
          0.1 *
            Math.sin(t * 2 * Math.PI * MENU_PULSE_HZ + flickerSeedForPlacement(p.gridX, p.gridY))
        : 1.0;
    const intensity = baseIntensity * flickerMul * pulseMul;

    uLights[i * LIGHT_STRIDE + 0] = gridToWorldPx(p.gridX, tileSize);
    uLights[i * LIGHT_STRIDE + 1] = gridToWorldPx(p.gridY, tileSize);
    uLights[i * LIGHT_STRIDE + 2] = radius;
    uLights[i * LIGHT_STRIDE + 3] = intensity;

    uLightColors[i * COLOR_STRIDE + 0] = color[0];
    uLightColors[i * COLOR_STRIDE + 1] = color[1];
    uLightColors[i * COLOR_STRIDE + 2] = color[2];

    uLightParams[i * PARAM_STRIDE + 0] = palette.corePower;
    uLightParams[i * PARAM_STRIDE + 1] = palette.haloFrac;
    uLightParams[i * PARAM_STRIDE + 2] = palette.specPower;
    // D2 — the cookie index + per-light accumulation blend mode are PACKED into
    // `.w` together: `cookieIdx + (blend === 'max' ? 10 : 0)`. The HdrLit shader
    // extracts the cookie via `mod(lp.w, 10.0)` (gated by `cookieIdx > 0.5` +
    // the `uCookie` tier flag, so at tier 1 this is a no-op even when nonzero)
    // and reads the blend mode via `lp.w > 9.5`. Resolved here (not in the
    // populator) so static placements stay consistent with the dynamic path +
    // the test seam is one site.
    const cookieIdx = cookieKeyToIndex(palette.cookieKey);
    const blendOffset = palette.blend === 'max' ? BLEND_OFFSET_MAX : 0;
    uLightParams[i * PARAM_STRIDE + 3] = cookieIdx + blendOffset;
    i++;
  }

  // ── Dynamic lights (player auras, explosions, projectiles) ──
  for (const d of dynamic) {
    if (i >= maxLights) break;
    const flicker = d.flickerMul ?? 1.0;

    uLights[i * LIGHT_STRIDE + 0] = d.x;
    uLights[i * LIGHT_STRIDE + 1] = d.y;
    uLights[i * LIGHT_STRIDE + 2] = d.radius;
    uLights[i * LIGHT_STRIDE + 3] = d.intensity * flicker;

    uLightColors[i * COLOR_STRIDE + 0] = d.color[0];
    uLightColors[i * COLOR_STRIDE + 1] = d.color[1];
    uLightColors[i * COLOR_STRIDE + 2] = d.color[2];

    uLightParams[i * PARAM_STRIDE + 0] = d.corePower;
    uLightParams[i * PARAM_STRIDE + 1] = d.haloFrac;
    uLightParams[i * PARAM_STRIDE + 2] = d.specPower;
    // D2 — the cookie index + per-light blend mode are PACKED into `.w`
    // together: `cookieOn + (blend === 'max' ? 10 : 0)`. The HdrLit shader
    // extracts the cookie via `mod(lp.w, 10.0)` and reads the blend mode via
    // `lp.w > 9.5`. Dynamic submitters carry an optional `blend` field
    // (defaults to 'add' — the historical behavior). The populator sets it from
    // the palette's `blend` for kinds that need it (aura → 'max'); ad-hoc
    // submitters (chest glint, fire trap, explosion) inherit 'add'.
    const blendOffset = (d.blend ?? 'add') === 'max' ? BLEND_OFFSET_MAX : 0;
    uLightParams[i * PARAM_STRIDE + 3] = d.cookieOn + blendOffset;
    i++;
  }

  buffers.uLightCount = i;
  return buffers;
}
