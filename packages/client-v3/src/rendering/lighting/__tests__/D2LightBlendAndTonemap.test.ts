import { describe, it, expect } from 'vitest';
import {
  createLightBuffers,
  packLights,
  BLEND_OFFSET_MAX,
  PARAM_STRIDE,
  cookieKeyToIndex,
  type LightPlacementTiled,
  type DynamicLight,
} from '../LightPacker.js';
import { LIGHT_PALETTE, resolveLightKind } from '../LightPalette.js';
import { HDR_LIT_FRAG_SOURCE, FINAL_FRAG_SOURCE } from '../LightingShaders.js';

/**
 * Read back the packed `.w` slot of `uLightParams[i]` (the cookie index +
 * blend mode, packed as `cookieIdx + (max ? BLEND_OFFSET_MAX : 0)`).
 */
function packedW(buffers: ReturnType<typeof createLightBuffers>, i: number): number {
  return buffers.uLightParams[i * PARAM_STRIDE + 3]!;
}

/**
 * D2 (lighting-system-4) — Layer 2b (packer blend packing) + Layer 3
 * (luminance-tonemap hue preservation) focused regression guards.
 *
 * These tests cover the two layers NOT exercised by `HdrLitEmissiveAlbedo.
 * test.ts` (which covers Layer 1 + Layer 2c accumulation math + Layer 2 palette
 * values). Each section is the LOAD-BEARING test for its layer — reverting the
 * layer makes the corresponding assertion fail.
 *
 * Layer 2b: the packer folds the palette's `blend` field into the
 *           `uLightParams[i].w` slot ALONGSIDE the cookie index
 *           (`cookieIdx + (blend === 'max' ? BLEND_OFFSET_MAX : 0)`).
 *           A separate `uLightBlend[MAX_LIGHTS]` array was REMOVED — it
 *           overflowed `MAX_FRAGMENT_UNIFORM_VECTORS` on many GPUs → shader
 *           link failure → black screen (the D2 regression this packing
 *           fixes). If the packing breaks (blend dropped, or a separate array
 *           re-introduced), auras silently fall through to the additive path
 *           and the whiteout returns (or the screen goes black).
 *
 * Layer 3:  luminance-tonemap preserves hue ratios under bright clusters
 *           (theagentd method). Reverting to per-channel ACES desaturates
 *           bright clusters toward white — caught by the hue-ratio assertion.
 */
describe('D2 Layer 2b — packer folds blend mode into uLightParams[i].w (packed with cookieIdx)', () => {
  // ── SOURCE-SHAPE GUARD — the uLightBlend uniform array is GONE. ──
  // A regression that re-introduces `uniform float uLightBlend[MAX_LIGHTS]`
  // overflows MAX_FRAGMENT_UNIFORM_VECTORS on many GPUs → the shader fails to
  // link → black screen (the D2 regression this packing fixes).
  describe('source-shape — the uLightBlend uniform array is GONE from the shader', () => {
    it('HDR_LIT_FRAG_SOURCE does NOT declare `uniform float uLightBlend[MAX_LIGHTS]`', () => {
      // Live GLSL only (filter comment lines — the header comment DOCUMENTS the
      // removed array in prose, so a naive not.toMatch would false-fail).
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).not.toMatch(/uniform\s+float\s+uLightBlend\s*\[/);
    });

    it('HDR_LIT_FRAG_SOURCE extracts the cookie via `mod(lp.w, 10.0)`', () => {
      // The +10 offset for max-blend must not break cookie selection. The
      // shader extracts the low digit via mod.
      expect(HDR_LIT_FRAG_SOURCE).toMatch(/float\s+cookieIdx\s*=\s*mod\(lp\.w,[ \t]*10\.0\)/);
    });

    it('HDR_LIT_FRAG_SOURCE gates the max-blend branch on `lp.w > 9.5`', () => {
      // The blend mode is read from the packed `.w` (≥10 means max-blend).
      // Filter comment lines (the header comment documents `lp.w > 9.5` in
      // prose).
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).toMatch(/if\s*\(\s*lp\.w\s*>\s*9\.5\s*\)/);
    });
  });

  describe('static placements — palette blend folds into uLightParams[i].w', () => {
    it('a biome-glow placement packs w = cookieIdx + BLEND_OFFSET_MAX (max)', () => {
      // The max-blend family. A regression that drops the blend fold (or
      // defaults everything to 'add') makes this assertion fail — the
      // biome-glow would silently sum with adjacent crystals → whiteout.
      const b = createLightBuffers();
      const placement: LightPlacementTiled = {
        gridX: 0,
        gridY: 0,
        kind: 'biome-glow',
        rotation: 0,
        flipH: false,
        flipV: false,
      };
      const palette = resolveLightKind('biome-glow');
      const expectedCookie = cookieKeyToIndex(palette.cookieKey);
      const out = packLights(b, [placement], [], { enabled: true, tileSize: 128 });
      expect(out.uLightCount).toBe(1);
      // w = cookieIdx + 10 (max-blend).
      expect(packedW(b, 0)).toBe(expectedCookie + BLEND_OFFSET_MAX);
    });

    it('a torch placement packs w = cookieIdx + 0 (add)', () => {
      // The additive family. A regression that flips the default to 'max'
      // makes this assertion fail — torches would stop accumulating.
      const b = createLightBuffers();
      const placement: LightPlacementTiled = {
        gridX: 0,
        gridY: 0,
        kind: 'torch',
        rotation: 0,
        flipH: false,
        flipV: false,
      };
      const palette = resolveLightKind('torch');
      const expectedCookie = cookieKeyToIndex(palette.cookieKey);
      const out = packLights(b, [placement], [], { enabled: true, tileSize: 128 });
      // w = cookieIdx + 0 (additive).
      expect(packedW(b, 0)).toBe(expectedCookie);
    });

    it('every map-gen kind packs the blend offset into uLightParams[i].w', () => {
      // Regression guard: the kind→palette→blend chain must match the palette
      // for every shared LightKind. A typo in the palette, or a packer that
      // drops the field, makes this assertion fail for the affected kind.
      const kinds: LightPlacementTiled['kind'][] = [
        'torch',
        'campfire',
        'candle',
        'biome-glow',
        'barrel-fire',
        'fireplace',
        'brazier',
        'lantern',
      ];
      for (const kind of kinds) {
        const b = createLightBuffers();
        const out = packLights(
          b,
          [{ gridX: 0, gridY: 0, kind, rotation: 0, flipH: false, flipV: false }],
          [],
          { enabled: true, tileSize: 128 },
        );
        const palette = resolveLightKind(kind);
        const expectedCookie = cookieKeyToIndex(palette.cookieKey);
        const expectedOffset = palette.blend === 'max' ? BLEND_OFFSET_MAX : 0;
        expect(packedW(b, 0)).toBe(expectedCookie + expectedOffset);
      }
    });

    it('the packed buffers NO LONGER carry a uLightBlend Float32Array', () => {
      // The buffer field was REMOVED (the 256-element array overflowed
      // MAX_FRAGMENT_UNIFORM_VECTORS → black screen). A regression that
      // re-adds it makes this assertion fail.
      const b = createLightBuffers();
      expect(b).not.toHaveProperty('uLightBlend');
    });
  });

  describe('dynamic lights — the blend field folds into uLightParams[i].w', () => {
    it('a dynamic aura (blend="max") packs w = cookieOn + BLEND_OFFSET_MAX', () => {
      // The populator sets `blend` from the palette for auras. This test
      // verifies the packer honors it. A regression that ignores `d.blend`
      // (defaults everything to 'add') makes this assertion fail.
      const b = createLightBuffers();
      const aura: DynamicLight = {
        x: 0,
        y: 0,
        radius: 512,
        intensity: 1.2,
        color: [1.0, 0.95, 0.88],
        corePower: 2.5,
        haloFrac: 0.85,
        specPower: 32.0,
        cookieOn: 1,
        blend: 'max',
      };
      const out = packLights(b, [], [aura], { enabled: true, tileSize: 128 });
      expect(packedW(b, 0)).toBe(1 + BLEND_OFFSET_MAX);
    });

    it('a dynamic light with no blend field defaults to "add" (cookieOn + 0)', () => {
      // Ad-hoc dynamic submitters (chest glint, fire trap, explosion) don't
      // set `blend` — they inherit 'add' (the historical behavior). A
      // regression that defaults to 'max' would break explosion accumulation.
      const b = createLightBuffers();
      const explosion: DynamicLight = {
        x: 0,
        y: 0,
        radius: 200,
        intensity: 3.0,
        color: [1.0, 0.3, 0.12],
        corePower: 3.8,
        haloFrac: 0.65,
        specPower: 22.0,
        cookieOn: 1,
        // blend omitted → defaults to 'add'
      };
      const out = packLights(b, [], [explosion], { enabled: true, tileSize: 128 });
      expect(packedW(b, 0)).toBe(1); // cookieOn + 0
    });

    it('multiple dynamic lights pack the blend offset at successive .w slots', () => {
      // Two auras (max) + one explosion (add). The packed `.w` must land at
      // the right offset per light (PARAM_STRIDE=4, .w = slot index 3).
      const b = createLightBuffers();
      const lights: DynamicLight[] = [
        {
          x: 0,
          y: 0,
          radius: 512,
          intensity: 1.2,
          color: [1.0, 0.95, 0.88],
          corePower: 2.5,
          haloFrac: 0.85,
          specPower: 32.0,
          cookieOn: 1,
          blend: 'max',
        },
        {
          x: 100,
          y: 100,
          radius: 512,
          intensity: 1.2,
          color: [1.0, 0.95, 0.88],
          corePower: 2.5,
          haloFrac: 0.85,
          specPower: 32.0,
          cookieOn: 1,
          blend: 'max',
        },
        {
          x: 200,
          y: 200,
          radius: 200,
          intensity: 3.0,
          color: [1.0, 0.3, 0.12],
          corePower: 3.8,
          haloFrac: 0.65,
          specPower: 22.0,
          cookieOn: 1,
          blend: 'add',
        },
      ];
      const out = packLights(b, [], lights, { enabled: true, tileSize: 128 });
      expect(out.uLightCount).toBe(3);
      expect(packedW(b, 0)).toBe(1 + BLEND_OFFSET_MAX); // aura 1 (max)
      expect(packedW(b, 1)).toBe(1 + BLEND_OFFSET_MAX); // aura 2 (max)
      expect(packedW(b, 2)).toBe(1); // explosion (add)
    });

    it('a max-blend aura with cookieOn=2 packs w=12 (light_02 + max offset)', () => {
      // The packing composes: cookie 2 (light_02) + 10 (max) = 12. The shader
      // extracts cookieIdx=2 via mod(12, 10) and reads max-blend via 12 > 9.5.
      const b = createLightBuffers();
      const aura: DynamicLight = {
        x: 0,
        y: 0,
        radius: 512,
        intensity: 1.2,
        color: [1.0, 0.95, 0.88],
        corePower: 2.5,
        haloFrac: 0.85,
        specPower: 32.0,
        cookieOn: 2,
        blend: 'max',
      };
      packLights(b, [], [aura], { enabled: true, tileSize: 128 });
      expect(packedW(b, 0)).toBe(12);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// D2 Layer 3 — luminance-tonemap hue preservation.
// ════════════════════════════════════════════════════════════════════════
describe('D2 Layer 3 — luminance-tonemap preserves hue ratios', () => {
  // The ACES operator (Narkowicz) — verbatim from final.frag. Each channel is
  // independent (the function is per-channel-identical), so applying it to a
  // scalar `L` via `acesTonemap(vec3(L,0,0)).x` is mathematically equivalent
  // to applying the rational function to `L` directly.
  function acesTonemap(x: number): number {
    const a = 2.51,
      b = 0.03,
      c = 2.43,
      d = 0.59,
      e = 0.14;
    return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
  }

  /** Per-channel ACES (the pre-D2 form — applies the operator to R, G, B independently). */
  function acesPerChannel(rgb: number[]): number[] {
    return rgb.map(acesTonemap);
  }

  /** Luminance-tonemap ACES (the D2 form — applies the operator to luminance, rescales RGB). */
  function acesLuminance(rgb: number[]): number[] {
    const L = Math.max(
      rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722,
      1e-4,
    );
    const nL = acesTonemap(L);
    return rgb.map((c) => c * (nL / L));
  }

  /** Rec BT.709 luma weights — used for the hue-ratio check. */
  const LUMA_W = [0.2126, 0.7152, 0.0722];

  // ── Source-shape guard — assert against the runtime-compiled final.frag. ──
  describe('source-shape (FINAL_FRAG_SOURCE — the runtime-compiled string)', () => {
    it('Layer 3: the ACES branch tonemaps luminance, not per-channel', () => {
      // The D2 form computes L = dot(lit, luma weights), nL = acesTonemap(L),
      // then `lit * (nL / L)`. Reverting to per-channel `acesTonemap(lit)`
      // makes BOTH assertions fail (the luminance path is gone + the
      // per-channel form returns).
      expect(FINAL_FRAG_SOURCE).toMatch(
        /float L = max\(dot\(lit,[ \t]*vec3\(0\.2126,[ \t]*0\.7152,[ \t]*0\.0722\)\),[ \t]*1e-4\)/,
      );
      expect(FINAL_FRAG_SOURCE).toMatch(/mapped\s*=\s*lit\s*\*\s*\(nL\s*\/\s*L\)/);
    });

    it('Layer 3: the ACES operator itself is UNCHANGED (Narkowicz fit)', () => {
      // D2 does NOT swap operators (research Q5 recommendation: keep ACES,
      // only change the application point). The constants stay.
      expect(FINAL_FRAG_SOURCE).toMatch(/const float a = 2\.51, b = 0\.03, c = 2\.43, d = 0\.59, e = 0\.14/);
    });

    it('Layer 3: the Reinhard branch stays per-channel (mild enough)', () => {
      // Reinhard is mild enough (slow asymptote) to keep per-channel. D2 only
      // changes the ACES branch. A regression that also luminance-tonemaps
      // Reinhard makes this assertion fail.
      expect(FINAL_FRAG_SOURCE).toMatch(/mapped\s*=\s*reinhard\(lit\)/);
    });
  });

  // ── Behavioral math — hue preservation under bright clusters. ──
  describe('behavioral math — hue ratios preserved (theagentd method)', () => {
    /**
     * The hue ratio: for an RGB triple, the per-channel proportion of the
     * total. Theagentd's proof: per-channel tonemapping shifts these ratios
     * (a `(5,0,10)` purple becomes `(5/6,0,10/11)` ≈ magenta under `x/(x+1)`,
     * because each channel is compressed by a different factor). Luminance-
     * tonemap preserves them EXACTLY (the RGB vector is rescaled uniformly by
     * `nL/L` — every channel multiplied by the same scalar → ratios unchanged).
     */
    function hueRatios(rgb: number[]): number[] {
      const sum = rgb[0]! + rgb[1]! + rgb[2]!;
      return [rgb[0]! / sum, rgb[1]! / sum, rgb[2]! / sum];
    }

    it('Layer 3 LOAD-BEARING: luminance-tonemap preserves hue ratios EXACTLY', () => {
      // THE LOAD-BEARING PROPERTY. A bright additive cluster (e.g. 3
      // overlapping explosions): the RGB is (5, 1.5, 0.6) — a saturated hot-
      // red. Luminance-tonemap rescales the whole vector by `nL/L`, so the
      // hue ratios of the OUTPUT match the INPUT exactly (every channel
      // multiplied by the same scalar). Reverting to per-channel ACES makes
      // this assertion FAIL — the per-channel operator compresses each channel
      // by a different factor (the R channel, being largest, is compressed
      // most aggressively), shifting the hue toward white/magenta.
      const input = [5.0, 1.5, 0.6]; // bright hot-red cluster
      const inRatios = hueRatios(input);
      const out = acesLuminance(input);
      const outRatios = hueRatios(out);
      for (let i = 0; i < 3; i++) {
        expect(outRatios[i]).toBeCloseTo(inRatios[i]!, 6); // EXACT preservation
      }
    });

    it('Layer 3 LOAD-BEARING: per-channel ACES does NOT preserve hue ratios (the bug)', () => {
      // THE CONTRAST. The same bright cluster under per-channel ACES (the
      // pre-D2 form) shifts the hue ratios — this is the bug D2 Layer 3
      // fixes. If this assertion ever passes (per-channel ACES preserves hue
      // ratios), the input is not bright enough to exhibit the desaturation
      // (the effect only manifests in the shoulder). Use a clearly-HDR input.
      const input = [5.0, 1.5, 0.6]; // bright hot-red cluster
      const inRatios = hueRatios(input);
      const out = acesPerChannel(input);
      const outRatios = hueRatios(out);
      // At least one channel's ratio must shift by a perceptible amount
      // (per-channel ACES desaturates toward white → the dominant R channel's
      // share drops, the recessive B channel's share rises).
      let maxShift = 0;
      for (let i = 0; i < 3; i++) {
        maxShift = Math.max(maxShift, Math.abs(outRatios[i]! - inRatios[i]!));
      }
      expect(maxShift).toBeGreaterThan(0.01); // perceptible hue shift
    });

    it('Layer 3: the cluster stays RED under luminance-tonemap (not desaturated to white)', () => {
      // The user-facing property: 3 overlapping explosions retain their hot-
      // red hue, instead of desaturating to a near-white flash. The R channel
      // stays dominant in the output.
      const input = [5.0, 1.5, 0.6]; // R-dominant
      const out = acesLuminance(input);
      expect(out[0]).toBeGreaterThan(out[1]!); // R > G
      expect(out[1]).toBeGreaterThan(out[2]!); // G > B
      // And the R:G ratio is preserved (the hue).
      const inRatio = input[0]! / input[1]!;
      const outRatio = out[0]! / out[1]!;
      expect(outRatio).toBeCloseTo(inRatio, 6);
    });

    it('Layer 3: per-channel ACES desaturates the cluster toward white (the regression)', () => {
      // The contrast: per-channel ACES compresses the dominant R channel more
      // than the recessive B channel, narrowing the R:B ratio → desaturation
      // toward white. This is the symptom D2 Layer 3 fixes.
      const input = [5.0, 1.5, 0.6];
      const out = acesPerChannel(input);
      const inRB = input[0]! / input[2]!;
      const outRB = out[0]! / out[2]!;
      // The R:B ratio NARROWS (R compressed more than B → ratio drops).
      expect(outRB).toBeLessThan(inRB);
    });

    it('Layer 3: the luminance-tonemap preserves RGB RATIOS (not absolute bounds)', () => {
      // Sanity + clarification: luminance-tonemap rescales the RGB vector by
      // `nL/L`, which preserves RATIOS but does NOT clamp each channel to
      // [0,1]. A channel brighter than the luminance (R > L for a red-
      // dominant input) stays brighter than nL after rescale — so an
      // individual channel CAN exceed 1.0 if the input was very HDR + channel-
      // dominant. This is correct behavior (the GPU framebuffer clamps at
      // write time; the tonemap's job is to compress, not to clamp per-
      // channel). The LOAD-BEARING property is ratio preservation (the test
      // above), not per-channel bounding. Verified: input [20,15,10] → R
      // channel > 1 (R was 27% above L; it stays 27% above nL≈1.0).
      const input = [20.0, 15.0, 10.0]; // very bright, red-dominant
      const out = acesLuminance(input);
      // The RATIOS are preserved (the load-bearing property).
      const inRatio01 = input[0]! / input[1]!;
      const outRatio01 = out[0]! / out[1]!;
      expect(outRatio01).toBeCloseTo(inRatio01, 6);
      // And the output is genuinely compressed (the max channel dropped from
      // 20.0 to single-digit).
      expect(Math.max(...out)).toBeLessThan(input[0]!);
    });

    it('Layer 3: luminance-tonemap is monotone (brighter in → brighter out)', () => {
      // Sanity: the tonemap is monotone — a brighter luminance produces a
      // brighter (or equal) tonemapped luminance. Guards against an inversion
      // bug in the rescale math.
      const dim = acesLuminance([0.5, 0.4, 0.3]);
      const bright = acesLuminance([5.0, 4.0, 3.0]);
      const dimL = dim[0]! * 0.2126 + dim[1]! * 0.7152 + dim[2]! * 0.0722;
      const brightL = bright[0]! * 0.2126 + bright[1]! * 0.7152 + bright[2]! * 0.0722;
      expect(brightL).toBeGreaterThan(dimL);
    });
  });
});
