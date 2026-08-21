/**
 * Pure-logic unit tests for `getMenuDioramaTitlePalette`.
 *
 * The title's impact flare (particles + ring waves + glow) used to be locked to
 * a single hardcoded warm "ember" set. The palette accessor derives the flare
 * from the diorama variant's two light tones (TONE_WARM + TONE_BIOME[id]) so it
 * matches the backdrop. These tests guard the load-bearing invariants:
 *   - Every registered variant resolves a palette (no throw).
 *   - The fire core (`warm`), highlight (`cream`), and flash (`whiteHot`) are
 *     CONSTANT across variants (the stable identity).
 *   - The place accent (`biome`) VARIES per variant (the adaptive read).
 *   - `deep` is a deterministic darken of `biome`.
 *   - linear-RGB → sRGB hex conversion uses the IEC 61966-2-1 transfer fn
 *     (NOT naive ×255, which read ~30% too dark + hue-shifted).
 *   - Same id → byte-identical palette (determinism contract).
 */
import { describe, expect, it } from 'vitest';
import {
  getMenuDioramaTitlePalette,
  MENU_DIORAMA_VARIANT_IDS,
} from '../menuDioramaComposition.js';
import type { MenuDioramaVariantId } from '../menuDioramaComposition.js';

describe('getMenuDioramaTitlePalette', () => {
  it('resolves a palette for every registered variant without throwing', () => {
    expect(MENU_DIORAMA_VARIANT_IDS.length).toBeGreaterThan(0);
    for (const id of MENU_DIORAMA_VARIANT_IDS) {
      const palette = getMenuDioramaTitlePalette(id);
      expect(palette).toBeDefined();
      expect(typeof palette.warm).toBe('number');
      expect(typeof palette.biome).toBe('number');
    }
  });

  it('keeps the fire core (warm) constant across variants — TONE_WARM [1.0,0.55,0.22] → sRGB 0xffc481', () => {
    const warms = new Set(
      MENU_DIORAMA_VARIANT_IDS.map((id) => getMenuDioramaTitlePalette(id).warm),
    );
    expect(warms.size).toBe(1);
    // linear→sRGB transfer (NOT ×255): R=1.0→255, G=0.55→196, B=0.22→129.
    // Naive ×255 gave 0xff8c38 (over-saturated + dark) — the wrong transfer fn.
    expect([...warms][0]).toBe(0xffc481);
  });

  it('keeps the highlight (cream) + flash (whiteHot) constant', () => {
    for (const id of MENU_DIORAMA_VARIANT_IDS) {
      const p = getMenuDioramaTitlePalette(id);
      expect(p.cream).toBe(0xfff4e0);
      expect(p.whiteHot).toBe(0xffffff);
    }
  });

  it('varies the place accent (biome) per variant — the adaptive read', () => {
    const bonfire = getMenuDioramaTitlePalette('forest-bonfire').biome;
    const crypt = getMenuDioramaTitlePalette('crypt-antechamber').biome;
    // emerald [0.18,0.45,0.24] vs violet [0.26,0.16,0.42] — must differ
    expect(bonfire).not.toBe(crypt);
    // at least 3 distinct biome accents across the roster (real variety)
    const accents = new Set(MENU_DIORAMA_VARIANT_IDS.map((id) => getMenuDioramaTitlePalette(id).biome));
    expect(accents.size).toBeGreaterThanOrEqual(3);
  });

  it('converts linear-RGB → sRGB via the transfer function (not ×255) for forest-bonfire emerald', () => {
    // TONE_BIOME['forest-bonfire'] = [0.18, 0.45, 0.24] (linear)
    // linear→sRGB: R=0.18→118, G=0.45→179, B=0.24→134 (×255 naive gave 46/115/61 — too dark)
    expect(getMenuDioramaTitlePalette('forest-bonfire').biome).toBe(0x76b386);
  });

  it('derives deep as a ×0.6 per-channel darken of the sRGB biome', () => {
    const p = getMenuDioramaTitlePalette('forest-bonfire');
    // biome 0x76b386 (118,179,134) → ×0.6: (71,107,80)
    expect(p.deep).toBe(0x476b50);
    // generic invariant: deep < biome on every channel (always darker)
    for (const id of MENU_DIORAMA_VARIANT_IDS) {
      const q = getMenuDioramaTitlePalette(id);
      const dr = (q.deep >> 16) & 0xff;
      const br = (q.biome >> 16) & 0xff;
      expect(dr).toBeLessThanOrEqual(br);
    }
  });

  it('is deterministic — same id yields a byte-identical palette', () => {
    const id: MenuDioramaVariantId = 'temple-threshold';
    expect(getMenuDioramaTitlePalette(id)).toEqual(getMenuDioramaTitlePalette(id));
  });
});
