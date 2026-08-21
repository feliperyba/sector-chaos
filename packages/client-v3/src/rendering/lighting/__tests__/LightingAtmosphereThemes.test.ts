/**
 * LightingAtmosphereThemes — per-sector dust RECIPE regression guard
 * (map-polish round-5 ticket 31, Seam A; reworked round 5c; bands retuned 5d).
 *
 * Pure-logic asserts (no Phaser): the four districts carry four DISTINCT
 * particle identities (shape + saturated hue — the owner verdict "not the
 * same circle with the same tone"), every recipe stays inside the mood
 * discipline bands (shimmer peaks ≤ 0.85, settle ≤ 12 px/s, worst-case
 * mote Ø ≤ 11px vs the 96px hitbox, far-band canvas Ø ≥ 3px — the round-5d
 * sub-visibility lesson), and the NEUTRAL recipe is the exact pre-ticket
 * global behavior (demo map / boot / menu diorama — no cliff).
 */
import { describe, it, expect } from 'vitest';
import { SectorType } from '@sector-battle/shared';
import { NEUTRAL_ATMOSPHERE_THEME, SECTOR_ATMOSPHERE_THEMES } from '../LightingAtmosphereThemes.js';
import {
  DUST_COLOR,
  DUST_PARALLAX_BANDS,
  DUST_SHIMMER_AMP,
  DUST_SHIMMER_BASE,
  DUST_SHIMMER_FREQ,
  DUST_SIZE_MAX,
  DUST_SIZE_MIN,
} from '../LightingAtmosphereConfig.js';

// SectorType is a STRING enum ('GRID_ARENA' | ...) — filter non-members out.
const ALL_SECTOR_TYPES = Object.values(SectorType).filter(
  (v): v is SectorType => typeof v === 'string',
) as SectorType[];

/** Chroma proxy: channel spread / max channel (0 = grey, 1 = pure hue). */
function chroma(tint: number): number {
  const r = (tint >> 16) & 0xff;
  const g = (tint >> 8) & 0xff;
  const b = tint & 0xff;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

describe('SECTOR_ATMOSPHERE_THEMES — four distinct particle identities (round 5c)', () => {
  it('covers every SectorType (no district silently falls to neutral on a real map)', () => {
    for (const type of ALL_SECTOR_TYPES) {
      expect(SECTOR_ATMOSPHERE_THEMES[type]).toBeDefined();
    }
  });

  it('the four SHAPES are distinct — not "the same circle" (owner verdict)', () => {
    const shapes = ALL_SECTOR_TYPES.map((t) => SECTOR_ATMOSPHERE_THEMES[t]!.shape);
    expect(new Set(shapes).size).toBe(ALL_SECTOR_TYPES.length);
    expect([...shapes].sort()).toEqual(['glint', 'grain', 'haze', 'spark']);
  });

  it('the four HUES are distinct — not "the same tone" (owner verdict)', () => {
    const tints = ALL_SECTOR_TYPES.map((t) => SECTOR_ATMOSPHERE_THEMES[t]!.dustTint);
    expect(new Set(tints).size).toBe(ALL_SECTOR_TYPES.length);
  });

  it('hues are SATURATED (chroma >= 0.3) — the 5b pastel lesson: chroma, not luminance, differentiates at particle size', () => {
    for (const type of ALL_SECTOR_TYPES) {
      expect(chroma(SECTOR_ATMOSPHERE_THEMES[type]!.dustTint)).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('pins the authored hue values (saturated steel / sage / violet / gold families)', () => {
    expect(SECTOR_ATMOSPHERE_THEMES[SectorType.GRID_ARENA]!.dustTint).toBe(0x8fc7ff);
    expect(SECTOR_ATMOSPHERE_THEMES[SectorType.OPEN_ARENA]!.dustTint).toBe(0xcfe08a);
    expect(SECTOR_ATMOSPHERE_THEMES[SectorType.MAZE]!.dustTint).toBe(0xb79ce8);
    expect(SECTOR_ATMOSPHERE_THEMES[SectorType.RESOURCE_RICH]!.dustTint).toBe(0xffd77a);
  });

  it('shimmer discipline: base >= 0.2, amp > 0, peaks (base+amp) <= 0.85', () => {
    // +ε: 0.55+0.3 / 0.5+0.35 land on the 0.85 boundary — IEEE representation
    // puts the sum a 1e-16 over. The pin is the authored band, not the ulp.
    const epsilon = 1e-9;
    for (const type of ALL_SECTOR_TYPES) {
      const theme = SECTOR_ATMOSPHERE_THEMES[type]!;
      expect(theme.shimmerBase).toBeGreaterThanOrEqual(0.2);
      expect(theme.shimmerAmp).toBeGreaterThan(0);
      expect(theme.shimmerBase + theme.shimmerAmp).toBeLessThanOrEqual(0.85 + epsilon);
    }
  });

  it('settle drift is gentle (|driftYBias| <= 12 px/s)', () => {
    for (const type of ALL_SECTOR_TYPES) {
      expect(Math.abs(SECTOR_ATMOSPHERE_THEMES[type]!.driftYBias)).toBeLessThanOrEqual(12);
    }
  });

  it('size bands are sane (0 < sizeMin < sizeMax)', () => {
    for (const type of ALL_SECTOR_TYPES) {
      const theme = SECTOR_ATMOSPHERE_THEMES[type]!;
      expect(theme.sizeMin).toBeGreaterThan(0);
      expect(theme.sizeMax).toBeGreaterThan(theme.sizeMin);
    }
  });

  it('readability ceiling: the worst-case mote stays <= 11px diameter (vs the 96px hitbox)', () => {
    // Worst case = the largest recipe sizeMax × the largest parallax band
    // sizeMul, × 2 for the radius→diameter conversion (particleScaleForSize).
    const maxBandSize = Math.max(...DUST_PARALLAX_BANDS.map((b) => b.sizeMul));
    const maxThemeSize = Math.max(
      ...ALL_SECTOR_TYPES.map((t) => SECTOR_ATMOSPHERE_THEMES[t]!.sizeMax),
    );
    expect(maxThemeSize * maxBandSize * 2).toBeLessThanOrEqual(11); // haze: 4.4 × 1.15 × 2 = 10.12
  });

  it('visibility floor (round 5d): every district\'s FAR-band canvas Ø >= 3px — sub-3px motes read as "nothing at all"', () => {
    // The seeded-map verdict: 5c's smallest bands (spark 0.9, glint 0.8)
    // rendered 1.5–2.4px canvas Ø at the far band (0.85×) — invisible at
    // gameplay attention, i.e. wasted cycles. The floor: 2 × sizeMin × min
    // parallax sizeMul >= 3px of canvas at the SMALLEST a district's air ever
    // renders. (Shape fill fractions shrink the INK further — spark's dot is
    // 62.5% of canvas — so the canvas floor is the conservative guard.)
    const minBandSize = Math.min(...DUST_PARALLAX_BANDS.map((b) => b.sizeMul));
    for (const type of ALL_SECTOR_TYPES) {
      const farBandCanvasDiameter = 2 * SECTOR_ATMOSPHERE_THEMES[type]!.sizeMin * minBandSize;
      expect(farBandCanvasDiameter).toBeGreaterThanOrEqual(3);
    }
    // The neutral band obeys the same floor (demo map parity).
    expect(2 * NEUTRAL_ATMOSPHERE_THEME.sizeMin * minBandSize).toBeGreaterThanOrEqual(3);
  });

  it('district fictions encode: MAZE slowest+dimmest haze, GRID fastest air+flicker, OPEN the strong settler, RESOURCE the glintiest', () => {
    const grid = SECTOR_ATMOSPHERE_THEMES[SectorType.GRID_ARENA]!;
    const open = SECTOR_ATMOSPHERE_THEMES[SectorType.OPEN_ARENA]!;
    const maze = SECTOR_ATMOSPHERE_THEMES[SectorType.MAZE]!;
    const rich = SECTOR_ATMOSPHERE_THEMES[SectorType.RESOURCE_RICH]!;
    expect(maze.speedMul).toBeLessThan(grid.speedMul); // dead-still air vs vent drafts
    expect(maze.sizeMax).toBeGreaterThan(grid.sizeMax); // big soft blobs vs small sparks
    for (const t of ALL_SECTOR_TYPES) {
      if (t !== SectorType.MAZE) {
        expect(maze.shimmerBase).toBeLessThan(SECTOR_ATMOSPHERE_THEMES[t]!.shimmerBase);
      }
      if (t !== SectorType.GRID_ARENA) {
        expect(grid.shimmerFreq).toBeGreaterThan(SECTOR_ATMOSPHERE_THEMES[t]!.shimmerFreq);
      }
      if (t !== SectorType.RESOURCE_RICH) {
        expect(rich.shimmerAmp).toBeGreaterThan(SECTOR_ATMOSPHERE_THEMES[t]!.shimmerAmp);
      }
    }
    expect(open.driftYBias).toBeGreaterThan(rich.driftYBias); // pollen settles hardest
    expect(grid.driftYBias).toBe(0);
    expect(maze.driftYBias).toBe(0); // haze hangs
  });
});

describe('NEUTRAL_ATMOSPHERE_THEME — the pre-ticket global behavior (no visual cliff)', () => {
  it('is the canonical global dust recipe exactly (DUST_COLOR circle, unit behavior)', () => {
    expect(NEUTRAL_ATMOSPHERE_THEME).toEqual({
      dustTint: DUST_COLOR,
      shape: 'spark', // circle-textured in the emitter wiring
      sizeMin: DUST_SIZE_MIN,
      sizeMax: DUST_SIZE_MAX,
      speedMul: 1,
      driftYBias: 0,
      shimmerBase: DUST_SHIMMER_BASE,
      shimmerAmp: DUST_SHIMMER_AMP,
      shimmerFreq: DUST_SHIMMER_FREQ,
    });
  });
});
