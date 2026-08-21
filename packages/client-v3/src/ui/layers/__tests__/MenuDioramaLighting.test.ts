/**
 * Pure-logic unit tests for `MenuDioramaLighting` (ticket 05).
 *
 * These validate the fire / aura / atmosphere WIRING CONTRACT that ticket 06
 * (`MenuBackground`) consumes — WITHOUT booting WebGL (the `LightingPipeline`
 * ctor throws on non-WebGL, and jsdom has no WebGL context). The full visual
 * verification (fire renders, max-blend no-whiteout, embers rise, crystals glow
 * in each variant hue) lives in the browser harness; these tests guard the
 * load-bearing invariants:
 *   - The central campfire is at 02's locked coord (7.5/1.5).
 *   - Forest-bonfire ships the redesign's warm-only rig: 5 warm fixtures (1
 *     campfire hero + 4 supports, ALL forced to the unified campfire-orange so
 *     the warm family never splits into a gold 3rd tone). The 2 emerald
 *     `biome-glow` crystals the ticket-15 rig carried were REMOVED by the
 *     menu redesign (67f3626) — the campfire is the sole hero (other variants
 *     carry their own crystal rigs; see menuDioramaRegistry.test.ts).
 *   - The WebGL aura dynamic light was REMOVED by the menu redesign
 *     (`c83ecd8` — see `MenuDioramaLighting.update`'s docstring: the campfire's
 *     own disk is the sole hero, the 5-tile additive aura was the biggest
 *     clutter source). No `buildMenuAuraLight` export exists anymore; only the
 *     palette-level max-blend invariants it relied on are still pinned below
 *     (the `aura` palette entry still ships — it drives in-game player auras).
 *   - The 5 warm fixtures are flame kinds → `resolveFlameAnchors` picks them up
 *     as ember anchors. The biome-glow crystals are NOT flame anchors.
 */
import { describe, it, expect } from 'vitest';
import {
  MENU_DIORAMA_TILE_SIZE,
  MENU_DIORAMA_STAGE_W,
  MENU_DIORAMA_STAGE_H,
  CENTRAL_FIRE_COL,
  CENTRAL_FIRE_ROW,
} from '../MenuDioramaLighting.js';
import { getMenuDioramaPlacements } from '../menuDioramaComposition.js';
import {
  resolveFlameAnchors,
  FLAME_ANCHOR_KINDS,
} from '../../../rendering/lighting/LightingAtmosphereConfig.js';
import { LIGHT_PALETTE } from '../../../rendering/lighting/LightPalette.js';
import { gridToWorldPx } from '../../../rendering/lighting/LightPacker.js';
import { resolveLightPropTexture } from '../../../rendering/lighting/LightPropResolver.js';

// Placements live in the variant registry (`menuDioramaComposition`), keyed by
// `MenuDioramaVariantId`. `'forest-bonfire'` is the reference set: the redesign's
// warm-only rig — 1 campfire key + 2 torch + 2 lantern (all campfire-orange),
// all in EMPTY tiles disjoint from the scatter.
const buildMenuDioramaPlacements = () => getMenuDioramaPlacements('forest-bonfire');

// The unified warm tone (campfire-orange).
const TONE_WARM: readonly [number, number, number] = [1.0, 0.55, 0.22];

describe('MenuDioramaLighting — placement contract (warm-only rig: 5 warm fixtures)', () => {
  const placements = buildMenuDioramaPlacements();

  it('emits exactly 5 fixtures — 1 campfire hero + 4 warm supports (crystals removed by the redesign)', () => {
    // 67f3626 removed forest-bonfire's 2 emerald biome-glow crystals — the
    // campfire is the sole hero of this variant (crystal-dominant variants like
    // forest-ruins are pinned in menuDioramaRegistry.test.ts).
    expect(placements).toHaveLength(5);
    const warm = placements.filter((p) => p.kind !== 'biome-glow');
    const crystals = placements.filter((p) => p.kind === 'biome-glow');
    expect(warm).toHaveLength(5);
    expect(crystals).toHaveLength(0);
  });

  it('places the central campfire at col 7.5 / row 1.5 (02 §4 — behind the logo)', () => {
    const campfire = placements.find((p) => p.kind === 'campfire');
    expect(campfire).toBeDefined();
    expect(campfire!.gridX).toBe(7.5);
    expect(campfire!.gridY).toBe(1.5);
  });

  it('every warm fixture is forced to the unified campfire-orange (tone 1 — no gold 3rd tone)', () => {
    // candle/lantern are gold in the palette; the per-placement `color` override
    // forces every warm fixture to campfire-orange so the whole rig reads as ONE
    // tone. Pin this so a future edit can't regress to the gold-vs-orange split.
    for (const p of placements.filter((x) => x.kind !== 'biome-glow')) {
      expect(p.color).toEqual(TONE_WARM);
    }
  });

  it('ships NO biome-glow crystals (removed by the redesign — the campfire is the sole hero)', () => {
    // 67f3626 commented out the 2 emerald crystalAt calls in
    // buildForestBonfirePlacements. Pin the removal so an accidental
    // resurrection updates this test explicitly.
    const crystals = placements.filter((p) => p.kind === 'biome-glow');
    expect(crystals).toEqual([]);
  });

  it('uses only shared LightKind placements (no client-only kinds leaked)', () => {
    // The aura is NOT in placements (it's a dynamic light — see buildMenuAuraLight).
    const SHARED_KINDS = [
      'torch',
      'campfire',
      'candle',
      'biome-glow',
      'barrel-fire',
      'fireplace',
      'brazier',
      'lantern',
    ] as const;
    for (const p of placements) {
      expect(SHARED_KINDS).toContain(p.kind);
    }
  });

  it('resolves the campfire to the static game/campfire sprite (no anim frames)', () => {
    const tex = resolveLightPropTexture('campfire');
    expect(tex).not.toBeNull();
    expect(tex!.atlas).toBe('game');
    expect(tex!.frame).toBe('campfire');
  });

  it('resolves biome-glow + torch/lantern to the lightProps atlas', () => {
    // The menu's per-variant crystals are `biome-glow` placements; the renderer
    // swaps to the NEUTRAL `biome-crystal_01` frame when a `color` override is
    // present (verified in LightPropRenderer tests). The resolver's default
    // biome-glow frame stays `biome-glow_01` (untinted in-game path).
    expect(resolveLightPropTexture('biome-glow')).toEqual({
      atlas: 'lightProps',
      frame: 'biome-glow_01',
    });
    expect(resolveLightPropTexture('torch')).toEqual({ atlas: 'lightProps', frame: 'torch_01' });
    expect(resolveLightPropTexture('lantern')).toEqual({ atlas: 'lightProps', frame: 'lantern_01' });
  });
});

describe('MenuDioramaLighting — atmosphere anchor wiring', () => {
  const placements = buildMenuDioramaPlacements();

  it('every warm fixture is a flame anchor; no biome-glow crystals exist to anchor', () => {
    // The 5 warm fixtures (campfire + 2 torch + 2 lantern) are flame kinds →
    // ember anchors. (The biome-glow crystals were removed by the redesign;
    // biome-glow is still NOT a flame kind — pinned for the crystal-bearing
    // variants that share this anchor wiring.)
    const warm = placements.filter((p) => p.kind !== 'biome-glow');
    const flameAnchored = placements.filter((p) => FLAME_ANCHOR_KINDS.has(p.kind));
    expect(flameAnchored.length).toBe(warm.length);
    expect(
      placements.filter((p) => p.kind === 'biome-glow' && FLAME_ANCHOR_KINDS.has(p.kind)),
    ).toHaveLength(0);
    expect(FLAME_ANCHOR_KINDS.has('biome-glow')).toBe(false);
  });

  it('resolveFlameAnchors returns one anchor per warm fixture (the campfire + 4 supports)', () => {
    const anchors = resolveFlameAnchors(placements, MENU_DIORAMA_TILE_SIZE);
    const warm = placements.filter((p) => p.kind !== 'biome-glow');
    expect(anchors).toHaveLength(warm.length);
    const campfireAnchor = anchors.find(
      (a) => a.x === gridToWorldPx(CENTRAL_FIRE_COL, MENU_DIORAMA_TILE_SIZE),
    );
    expect(campfireAnchor).toBeDefined();
    expect(campfireAnchor!.y).toBe(gridToWorldPx(CENTRAL_FIRE_ROW, MENU_DIORAMA_TILE_SIZE));
  });

  it('world bounds feed the world-wide dust-mote field (stage covers diorama)', () => {
    // Documented invariant: 06 calls lighting.setWorldBounds(stageW, stageH).
    // The stage values are the 02 §3 oversized dimensions (2048×1152), larger
    // than the 1920×1080 viewport so the dust field covers the full diorama
    // (not just the camera-follow rect).
    expect(MENU_DIORAMA_STAGE_W).toBe(2048);
    expect(MENU_DIORAMA_STAGE_H).toBe(1152);
    expect(MENU_DIORAMA_STAGE_W).toBeGreaterThan(1920);
    expect(MENU_DIORAMA_STAGE_H).toBeGreaterThan(1080);
  });
});

describe('MenuDioramaLighting — max-blend no-whiteout invariant (D2)', () => {
  // The D2 fix is encoded in the palette. This test pins it so a future palette
  // change can't silently regress the whiteout fix: every aura (the in-game
  // player aura — the menu's own aura dynamic light was removed by the menu
  // redesign) uses blend 'max', so lights composite via `lit = max(lit, c)` in
  // the HdrLit loop (hdrLit.frag:285-290) instead of summing. N overlapping
  // warm-white auras = the brightness of 1.
  it('the aura palette entry uses blend "max"', () => {
    expect(LIGHT_PALETTE.aura.blend).toBe('max');
  });

  it('the campfire palette entry uses blend "add" (energy accumulates with the aura correctly via the screen-blend asymptote)', () => {
    // The campfire is 'add' (it SHOULD accumulate energy — it's the hot fire
    // core). The HdrLit shader's screen-blend with K=2.5 asymptote
    // (hdrLit.frag:297-303) caps the additive sum so the campfire + aura don't
    // blow out: the max-blend aura contributes max(lit, c_aura), then the
    // additive campfire folds in via lit + c_fire - lit*c_fire/K. The two blend
    // modes compose without whiteout (D2 design).
    expect(LIGHT_PALETTE.campfire.blend).toBe('add');
  });
});
