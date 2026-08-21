import { describe, it, expect } from 'vitest';
import { LIGHT_PALETTE, HERO_LIGHT_OVERRIDES, resolveLightKind } from '../LightPalette.js';

/**
 * C2 (lighting-system-3) — player aura tone + radius regression guard.
 *
 * WHY THIS TEST EXISTS:
 * The aura was the only non-biome-glow cool-blue light source in an otherwise
 * warm scene (color `[0.4, 0.68, 1.0]`, byte-identical to `biome-glow`, OPPOSITE
 * hue to every warm flame `[1.0, 0.55, 0.22]`), and its radius (256px) was too
 * small per the user ruling ("2x bigger"). Per the user ruling 2026-08-07
 * (`.scratch/lighting-system-3/02-decisions/decisions.md` §C2): change tone to
 * SOFT WARM-WHITE NEUTRAL `[~1.0, 0.95, 0.88]` (matching the RANGED projectile
 * tone `[1.0, 0.96, 0.85]` — "clean light," distinct from flames but not a hue
 * clash), flip the cookie `light_02` (cool) → `light_01` (warm) so the cookie
 * doesn't tint the warm color back toward cool, and widen radius 256 → 512
 * (2×). KEEP intensity 1.2 — the user said the OLD aura was "too bright"; the
 * wider radius at the same intensity reads as a softer larger wash, NOT brighter.
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` — no fog of war; the aura is a mood halo,
 * NOT a vision mechanic). Widening it does NOT reveal hidden enemies. Client-
 * palette-only — no server change.
 *
 * This file is the focused Seam-A regression guard for the C2 retune. The
 * older per-kind assertions in `LightPacker.test.ts` and
 * `DynamicLightPopulator.test.ts` were updated in the same change to lock the
 * new values (with their prior A/B baselines carried forward in comments).
 */
describe('C2 (lighting-system-3) — player aura: warm-white tone + 2x radius', () => {
  describe('resolveLightKind("aura") — palette entry', () => {
    it('color is the soft warm-white [1.0, 0.95, 0.88] (was cool [0.4, 0.68, 1.0])', () => {
      const aura = resolveLightKind('aura');
      // Within epsilon (component-wise, 5 decimal places — the values are exact
      // in the palette, but epsilon guards against future float shuffling).
      expect(aura.color[0]).toBeCloseTo(1.0, 5);
      expect(aura.color[1]).toBeCloseTo(0.95, 5);
      expect(aura.color[2]).toBeCloseTo(0.88, 5);
    });

    it('cookieKey is light_01 (was light_02 — flip to warm to match the new tone)', () => {
      // The cool cookie light_02 would tint the warm color back toward cool;
      // the warm cookie light_01 (the one all flame sources use) keeps the
      // warm-white reading.
      expect(resolveLightKind('aura').cookieKey).toBe('light_01');
    });

    it('corePower + haloFrac (the diffuseness character)', () => {
      // D2fix: corePower 2.5 → 2.0 (flatter core — user: aura center "too
      // bright"). haloFrac 0.85 UNCHANGED (most energy to the diffuse rim).
      expect(resolveLightKind('aura').corePower).toBe(2.0);
      expect(resolveLightKind('aura').haloFrac).toBe(0.85);
    });
  });

  describe('HERO_LIGHT_OVERRIDES.aura — radius/intensity', () => {
    it('radius is 640 (user ruling +25% on the prior 512)', () => {
      // 640px = 5.0 tiles (was 512 = 4.0 tiles, was 256 = 2.0 tiles, was 160 =
      // 1.25 verbatim). The halo extends (640-48)=592px = 4.6 tiles past each
      // edge of the 96px hitbox — a wide, soft presence wash.
      expect(HERO_LIGHT_OVERRIDES.aura?.radius).toBe(640);
    });

    it('intensity is 0.6 (D2fix 1.2→0.7; lighting-mood 0.7→0.6 — tone-down a bit)', () => {
      // Lowered to soften the searing center (paired with corePower 2.5→2.0),
      // then nudged 0.7→0.6 so the wide aura reads as a quieter mood halo.
      // Do NOT raise without a user ruling — the center must stay a soft wash.
      expect(HERO_LIGHT_OVERRIDES.aura?.intensity).toBe(0.6);
    });

    it('flicker is false (steady identity glow — no flicker)', () => {
      // Unchanged by C2, but pinned so a future "juice" pass doesn't silently
      // turn on flicker without intent (the aura's steadiness is part of its
      // identity-halo character).
      expect(HERO_LIGHT_OVERRIDES.aura?.flicker).toBe(false);
    });
  });

  describe('LIGHT_PALETTE.aura — direct table access (consistency)', () => {
    it('the table entry matches resolveLightKind("aura")', () => {
      // Guards against a future drift where the table and the resolver
      // disagree (resolveLightKind falls back to torch on missing keys — a
      // typo in the aura key would silently resolve to torch).
      const byResolver = resolveLightKind('aura');
      const byTable = LIGHT_PALETTE.aura;
      expect(byTable.color).toEqual([...byResolver.color]);
      expect(byTable.cookieKey).toBe(byResolver.cookieKey);
      expect(byTable.corePower).toBe(byResolver.corePower);
      expect(byTable.haloFrac).toBe(byResolver.haloFrac);
    });
  });
});
