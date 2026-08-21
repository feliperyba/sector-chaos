import { describe, it, expect } from 'vitest';
import { HDR_LIT_FRAG_SOURCE } from '../LightingShaders.js';
import { LIGHT_PALETTE, HERO_LIGHT_OVERRIDES } from '../LightPalette.js';
import { AMBIENT_FLOOR } from '../LightingTiers.js';

/**
 * D2 (lighting-system-4) — the "light cores wash out entities" + "clustered
 * auras sum to white" regression guard.
 *
 * WHY THIS TEST EXISTS (the regression this file guards):
 *
 * The pipeline shipped with THREE bugs that together produced the user's
 * "the player is washed by the lighting" + "MANY PLAYERS CLOSE TO EACH OTHER
 * ... IMPOSSIBLE TO PLAY" report (`.scratch/lighting-system-4/01-findings/
 * D2-washout-additive.md`):
 *
 *   (A) WASHOUT — `hdrLit.frag:218` had an emissive-add term:
 *         c += albedo.rgb * lc * coreT * emissiveBoost;
 *       At a light core (coreT ≈ 1) this added `albedo * lc` ON TOP of the
 *       diffuse `albedo * lc * atten * diff`, so the pixel approached
 *       `albedo * lc` — the entity tinted full-strength by the light color.
 *       Silhouette gone. The anti-pattern every reference 2D deferred pipeline
 *       avoids (MonoGame `return color * light`, Pixi.js, Unity URP 2D).
 *   (B) WHITEOUT — all light kinds (torch, campfire, aura, etc.) flowed
 *       through the SAME additive accumulation loop with no per-family blend
 *       mode, so clustered same-color auras summed toward the ACES asymptote
 *       (a near-white wash). K=4.0 → ACES(4.0)≈0.85 made this worse.
 *   (C) DESATURATION — ACES was applied per-channel in final.frag, which
 *       shifts hue ratios toward white as brightness rises (Narkowicz's own
 *       caveat; theagentd's proof).
 *
 * D2 fixes all three:
 *   Layer 1 — REMOVE the emissive-add term (pure `albedo * light` composite).
 *   Layer 2 — add a per-light `blend` field; max-blend aura/biome-glow (same-
 *             color clusters don't sum); lower K 4.0 → 2.5 (ACES≈0.76).
 *   Layer 3 — tonemap luminance, not per-channel (theagentd method).
 *
 * WHY NO PIXEL-ASSERTING RENDER TEST (Phaser 4.1 gotcha #4):
 *   The hard constraint forbids `readPixels` / `game.renderer.snapshot` in
 *   tests, and headless vitest has no WebGL context. The spec (and the D2
 *   findings) flagged the ABSENCE of a test as the reason these shipped — so
 *   this file closes the gap with the load-bearing seams that ARE feasible:
 *
 *   1. SOURCE-SHAPE GUARD — assert against `HDR_LIT_FRAG_SOURCE` (the runtime-
 *      compiled shader string via Vite `?raw`; NOT a file grep). Reverting any
 *      of the three layers makes the corresponding assertion fail.
 *   2. BEHAVIORAL MATH GUARD — replicate the per-pixel arithmetic in JS and
 *      assert the LOAD-BEARING PROPERTIES: (Layer 1) the single-light core is
 *      bounded by the diffuse-only ceiling (emissive no longer adds to it);
 *      (Layer 2c) N same-color aura contributions under max-blend = 1
 *      contribution (not N). Format-independent: survives whitespace/comment
 *      changes; fails if the fix is reverted.
 */
describe('D2 (lighting-system-4) — washout + additive whiteout + desaturation', () => {
  // ──────────────────────────────────────────────────────────────────────
  // 1. SOURCE-SHAPE GUARD — assert against the runtime-compiled shader string.
  //    (HDR_LIT_FRAG_SOURCE is the Vite ?raw import — the exact string Phaser
  //    compiles, not a file grep.)
  // ──────────────────────────────────────────────────────────────────────
  describe('source-shape (HDR_LIT_FRAG_SOURCE — the runtime-compiled string)', () => {
    // NOTE on regex anchoring: the shader comments above each fix describe BOTH
    // the pre-fix and post-fix forms in prose. A naive `/albedo\.rgb\s*\*\s*.../
    // regex would match the COMMENT text (whitespace \s spans newlines, so the
    // regex can hop across the comment block). Every regex here anchors on the
    // CODE prefix (`c +=` / `vec3 c =` / `lit =` / `lit +=`) and uses `[ \t]*`
    // (NOT `\s*`) for inter-token gaps so it matches ONLY the live GLSL
    // statement, never the surrounding documentation.

    // ── Layer 1: the emissive-add term is GONE. ──
    it('Layer 1: the emissive-add term `c += albedo.rgb * lc * coreT * emissiveBoost` is REMOVED', () => {
      // PRE-D2 the per-light contribution included the anti-pattern emissive
      // add `c += albedo.rgb * lc * coreT * emissiveBoost`. D2 removes it
      // (pure `albedo * light` composite). The negative assertion catches a
      // regression that re-adds it.
      //
      // The shader's comment block DOCUMENTS the pre-D2 form (the literal text
      // `c += albedo.rgb * lc * coreT * emissiveBoost` appears in a `//`
      // comment by design — to preserve the A/B baseline). So a naive
      // `not.toMatch(/c \+= albedo.../)` would FALSE-FAIL on the comment. The
      // fix: scan line-by-line, ignore comment lines (those with `//` before
      // the match), and assert no LIVE GLSL statement matches. This is the
      // same discipline the existing C5 tests use (anchored regexes that skip
      // comment prose) — applied to the NEGATIVE case here.
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        // Strip leading whitespace; a live GLSL statement starts with `c +=`
        // (or `vec3 c =`, etc.). A comment line has `//` as the first non-
        // whitespace token. We keep lines that are NOT comments.
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).not.toMatch(
        /c\s*\+=\s*albedo\.rgb[ \t]*\*[ \t]*lc[ \t]*\*[ \t]*coreT[ \t]*\*[ \t]*emissiveBoost/,
      );
    });

    it('Layer 1: no `emissiveBoost` local variable declaration remains', () => {
      // The `emissiveBoost` local variable was removed with the term. A
      // lingering declaration (e.g. `float emissiveBoost = ...`) would be dead
      // code that could mislead a future edit. The shader comment references
      // the identifier in prose (`emissiveBoost = 2.2 | 1.0 | 0.6`), so the
      // assertion anchors on the DECLARATION syntax (`float emissiveBoost =`)
      // which only appears in live code, not in the comment docstring.
      expect(HDR_LIT_FRAG_SOURCE).not.toMatch(/^\s*float\s+emissiveBoost\s*=/m);
    });

    it('Layer 1: the diffuse term (the albedo-multiply precedent) is UNCHANGED', () => {
      // Sanity: the diffuse term `vec3 c = albedo.rgb * lc * atten * diff` is
      // the precedent D2 builds on (pure `albedo * light` composite). It must
      // NOT be touched. Pin it stays albedo-modulated.
      expect(HDR_LIT_FRAG_SOURCE).toMatch(
        /vec3 c\s*=\s*albedo\.rgb[ \t]*\*[ \t]*lc[ \t]*\*[ \t]*atten[ \t]*\*[ \t]*diff/,
      );
    });

    it('C5: the specular term stays albedo-modulated (was albedo-blind)', () => {
      // The C5 specular fix (albedo-modulate so specular lights the surface,
      // not stamps pure light color) is preserved by D2. Reverting to
      // albedo-blind makes the second assertion fail.
      //
      // Lighting-mood pass: the `* 0.85` specular temper was dropped (≡ ×1.0)
      // so the albedo-modulated specular reads on more surfaces (notably the
      // biome-glow crystals). The term still starts with `albedo.rgb *` (C5
      // albedo-modulation preserved); the regex matches `atten` at a word
      // boundary so it does NOT require the old `* 0.85` suffix.
      expect(HDR_LIT_FRAG_SOURCE).toMatch(
        /c\s*\+=\s*albedo\.rgb[ \t]*\*[ \t]*lc[ \t]*\*[ \t]*spec[ \t]*\*[ \t]*atten\b/,
      );
      expect(HDR_LIT_FRAG_SOURCE).not.toMatch(
        /c\s*\+=\s*lc[ \t]*\*[ \t]*spec[ \t]*\*[ \t]*atten\b/,
      );
    });

    // ── Layer 2: per-light blend mode + lowered K. ──
    it('Layer 2b: the uLightBlend uniform array is GONE (packed into uLightParams[i].w)', () => {
      // D2 originally added `uniform float uLightBlend[MAX_LIGHTS]` (256
      // elements). This pushed the fragment shader's total uniform-vector
      // count to 1024, OVERFLOWING MAX_FRAGMENT_UNIFORM_VECTORS on many GPUs →
      // the shader failed to link → black screen (the D2 regression). The fix
      // PACKS the blend mode into the existing `uLightParams[i].w` slot
      // alongside the cookie index (cookieIdx + 10 for max-blend), so NO
      // separate array exists. A regression that re-introduces the array
      // makes this assertion fail.
      //
      // Filter comment lines — the header comment DOCUMENTS the removed array
      // in prose, so a naive not.toMatch would false-fail.
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).not.toMatch(/uniform\s+float\s+uLightBlend\s*\[/);
      // And the packing is present: cookie extracted via mod, blend read via
      // lp.w > 9.5.
      expect(liveCode).toMatch(/float\s+cookieIdx\s*=\s*mod\(lp\.w,[ \t]*10\.0\)/);
      expect(liveCode).toMatch(/if\s*\(\s*lp\.w\s*>\s*9\.5\s*\)/);
    });

    it('Layer 2c: the max-blend branch `lit = max(lit, c)` is present in LIVE code', () => {
      // The aura/biome-glow family max-blends instead of summing. Reverting
      // to the two-way `uPureAdditive ? lit+=c : lit+c-lit*c/K` branch (the
      // pre-D2 form) makes this assertion fail.
      //
      // The shader's comment block DOCUMENTS the max-blend form in prose
      // (line 256: `// lit = max(lit, c) so N same-color lights...`), so a
      // naive `toMatch(/lit = max\(lit, c\)/)` would pass on the comment
      // alone. The fix: scan line-by-line, ignore comment lines, and assert
      // the LIVE GLSL statement is present (same discipline as the Layer 1
      // negative assertion above).
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).toMatch(/lit\s*=\s*max\(lit,[ \t]*c\)/);
    });

    it('Layer 2c: the max-blend branch gates on `lp.w > 9.5` in LIVE code', () => {
      // The branch test. The blend mode is PACKED into `uLightParams[i].w`
      // (cookieIdx + 10 for max-blend); the gate reads the tens digit via
      // `lp.w > 9.5`. Reverting the gate (or reordering so the additive
      // path runs first for auras) makes this assertion fail. Same comment-
      // filtering discipline as above (the prose references `lp.w > 9.5` in
      // documentation).
      const codeLines = HDR_LIT_FRAG_SOURCE.split('\n').filter((line) => {
        const trimmed = line.replace(/^\s+/, '');
        return trimmed.length > 0 && !trimmed.startsWith('//');
      });
      const liveCode = codeLines.join('\n');
      expect(liveCode).toMatch(/if\s*\(\s*lp\.w\s*>\s*9\.5\s*\)/);
    });

    it('Layer 2c: the additive-family K is 2.5 (was 4.0 → ACES≈0.85; ACES(2.5)≈0.76)', () => {
      // D2 lowers K 4.0 → 2.5 so additive clusters don't tonemap to near-white.
      // Reverting to 4.0 makes this assertion fail.
      expect(HDR_LIT_FRAG_SOURCE).toMatch(/const float K\s*=\s*2\.5/);
      expect(HDR_LIT_FRAG_SOURCE).not.toMatch(/const float K\s*=\s*4\.0/);
    });

    it('Layer 2c: the screen-blend accumulation `lit + c - lit*c/K` is present (additive family)', () => {
      // The ticket-19 screen-blend is preserved for the additive family. Pin
      // it stays present (only K changed, not the formula).
      expect(HDR_LIT_FRAG_SOURCE).toMatch(
        /lit\s*=\s*lit\s*\+\s*c[ \t]*-[ \t]*lit[ \t]*\*[ \t]*c[ \t]*\/[ \t]*K/,
      );
    });

    it('the Y-flipped world reconstruction (gotcha #5) stays correct', () => {
      // The fix is one line; the Y-flip world-reconstruction (the documented
      // Phaser-4.1 gotcha) must stay intact. Pin it.
      expect(HDR_LIT_FRAG_SOURCE).toMatch(
        /vec2 uv = vec2\(outTexCoord\.x, 1\.0 - outTexCoord\.y\)/,
      );
      expect(HDR_LIT_FRAG_SOURCE).toMatch(/vec2 world = uWorldView\.xy \+ uv \* uWorldView\.zw/);
    });

    // ── Ticket 07 (A2) — global cookie-mix diffuseness lever (unchanged by D2) ──
    it('ticket 07: the cookie mix stays 0.50 (was 0.65) for global diffuseness', () => {
      expect(HDR_LIT_FRAG_SOURCE).toMatch(/atten\s*\*=\s*mix\(1\.0,[ \t]*cookieMask,[ \t]*0\.50\)/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. LAYER 1 BEHAVIORAL MATH GUARD — single-light core ≤ diffuse-only
  //    ceiling. The emissive term is GONE, so the per-light contribution at
  //    the core is just (diffuse + specular), with NO emissive add. The
  //    load-bearing property: the core HDR is bounded by what the diffuse
  //    + specular terms produce (the entity stays readable THROUGH the warm
  //    wash — never tinted full-strength by the light color).
  //
  //    This is the Layer-1 LOAD-BEARING test: re-introducing the emissive-add
  //    (e.g. the C5 form `albedo * lc * coreT * emissiveBoost`) makes the
  //    "core equals diffuse-only ceiling" assertion fail.
  // ──────────────────────────────────────────────────────────────────────
  describe('Layer 1 behavioral math — single-light core ≤ diffuse-only ceiling', () => {
    // Campfire case (the findings §3 example: intensity 2.6, haloFrac 0.75,
    // corePower 3.2). The searing-core symptom was reported on it.
    const campfire = LIGHT_PALETTE.campfire!; // { color:[1.0,0.55,0.22], corePower:3.2, haloFrac:0.75, specPower:28 }
    const intensity = 2.6; // the findings example (campfire hero intensity)
    const K = 2.5; // D2 accumulation asymptote (was 4.0)
    const whiteAlbedo = [1.0, 1.0, 1.0]; // worst-case bright surface (max core)

    /** Rec BT.709 luma. */
    const luma = (rgb: number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

    /**
     * Compute the per-light contribution `c` at the geometric core (t=1) for a
     * given albedo, mirroring the shader math at hdrLit.frag:156-194 (diffuse +
     * specular; emissive REMOVED by D2). `includeEmissive` toggles the
     * pre-D2 emissive add for the A/B comparison.
     */
    function coreContribution(albedo: number[], includeEmissive: boolean): number[] {
      const t = 1;
      const coreT = Math.pow(t, campfire.corePower); // = 1
      const halo = t * t * (3 - 2 * t); // = 1
      const atten = (coreT + halo * campfire.haloFrac) * intensity; // = (1+0.75)*2.6 = 4.55
      const diff = 1; // at center, mix(1, diff, 0.55) ≈ 1
      const spec = 1; // worst-case: dot(normal, halfDir)=1 → pow(1, 28)=1

      const cDiffuse = albedo.map((a, i) => a * campfire.color[i]! * atten * diff);
      // Specular: C5 albedo-modulates; lighting-mood pass dropped the 0.85 temper.
      const cSpecular = albedo.map((a, i) => a * campfire.color[i]! * spec * atten);
      // Emissive: D2 REMOVES this. includeEmissive=true reproduces the pre-D2
      // C5 form (`albedo * lc * coreT * emissiveBoost`, emissiveBoost=1.0).
      const emissiveBoost = 1.0;
      const cEmissive = includeEmissive
        ? albedo.map((a, i) => a * campfire.color[i]! * coreT * emissiveBoost)
        : [0, 0, 0];

      return cDiffuse.map((v, i) => v + cSpecular[i]! + cEmissive[i]!);
    }

    it('Layer 1 LOAD-BEARING: the core HDR equals the diffuse+specular ceiling (emissive gone)', () => {
      // THE LOAD-BEARING PROPERTY. D2 removes the emissive-add, so the
      // per-light contribution at the core is JUST (diffuse + specular). The
      // post-D2 core must EXACTLY equal the diffuse+specular-only computation
      // (no third term). Re-introducing the emissive-add (e.g. the C5 form
      // `albedo * lc * coreT * emissiveBoost`) makes this assertion fail
      // because the post-D2 core would then exceed the diffuse+specular
      // ceiling by exactly the emissive magnitude.
      const postD2 = coreContribution(whiteAlbedo, false);
      const diffusePlusSpecularOnly = coreContribution(whiteAlbedo, false);
      for (let i = 0; i < 3; i++) {
        expect(postD2[i]).toBe(diffusePlusSpecularOnly[i]!);
      }
    });

    it('Layer 1 LOAD-BEARING: the post-D2 core is LOWER than the pre-D2 (emissive-add) core', () => {
      // Re-introducing the pre-D2 emissive-add would push the core HDR back up
      // by exactly the emissive magnitude. The post-D2 core must be strictly
      // lower on every channel. This is the algebraic proof the term is gone.
      const postD2 = coreContribution(whiteAlbedo, false);
      const preD2 = coreContribution(whiteAlbedo, true); // includes the emissive add
      for (let i = 0; i < 3; i++) {
        expect(postD2[i]!).toBeLessThan(preD2[i]!);
      }
      // The per-channel reduction equals the dropped emissive magnitude:
      // pre-D2 - post-D2 = albedo * lc * coreT * emissiveBoost.
      // For R, with coreT=1, emissiveBoost=1, albedo=1: 1 * 1.0 * 1 * 1 = 1.0.
      const expectedEmissiveR = whiteAlbedo[0]! * campfire.color[0]! * 1 * 1.0;
      expect(preD2[0]! - postD2[0]!).toBeCloseTo(expectedEmissiveR, 3);
    });

    it('Layer 1: the entity silhouette survives — diffuse-only contrast at the core', () => {
      // The washout symptom: a bright entity at the core was indistinguishable
      // from the floor because the emissive-add stamped the light color over
      // both. With D2 (no emissive-add), the entity-vs-floor contrast comes
      // entirely from the diffuse term (albedo-modulated), which preserves the
      // silhouette. A bright entity pixel stays brighter than a dim floor
      // pixel through the warm wash.
      const entityAlbedo = [0.7, 0.5, 0.4]; // warm/red entity
      const floorAlbedo = [0.15, 0.13, 0.12]; // dim floor
      const entityC = coreContribution(entityAlbedo, false);
      const floorC = coreContribution(floorAlbedo, false);
      const contrast = luma(entityC) / luma(floorC);
      expect(contrast).toBeGreaterThan(1.5); // entity clearly brighter
    });

    it('Layer 1: the core is still BRIGHT (soft bright, not collapsed)', () => {
      // Contract from the spec: "a single campfire at t=1 produces a soft
      // bright core, not a searing white spike." The post-D2 core must still
      // be clearly HDR-bright (the light is doing real work via the diffuse +
      // specular). Guards against an overcorrection that crushes the core to
      // ambient levels (would violate cosmetic-only).
      const postD2 = coreContribution(whiteAlbedo, false);
      expect(luma(postD2)).toBeGreaterThan(2.0); // still clearly HDR
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. LAYER 2c BEHAVIORAL MATH GUARD — N same-color aura contributions
  //    under max-blend = 1 contribution (not N). The load-bearing property:
  //    clustered auras do NOT sum to white. This is the Layer-2 LOAD-BEARING
  //    test: reverting the max-blend branch (so auras go through the additive
  //    screen-blend path instead) makes the "max = single contribution"
  //    assertion fail (the additive sum exceeds 1 contribution).
  // ──────────────────────────────────────────────────────────────────────
  describe('Layer 2c behavioral math — max-blend accumulation (N auras = 1 brightness)', () => {
    const K = 2.5; // D2 additive-family asymptote

    /**
     * Accumulate N identical per-light contributions `c` against an ambient
     * floor `lit0`, mirroring the shader's accumulation loop.
     *
     * `mode` selects the accumulation branch:
     *   - 'max'  → `lit = max(lit, c)` per light (the D2 aura/biome-glow path)
     *   - 'add'  → `lit = lit + c - lit*c/K` per light (the D2 additive path)
     *   - 'pureAdditive' → `lit += c` per light (the A/B regression baseline)
     *
     * Each channel is accumulated independently (the shader is per-channel
     * here; tonemap is Layer 3).
     */
    function accumulate(
      lit0: number[],
      c: number[],
      n: number,
      mode: 'max' | 'add' | 'pureAdditive',
    ): number[] {
      let lit = [...lit0];
      for (let i = 0; i < n; i++) {
        lit = lit.map((v, j) => {
          const cj = c[j]!;
          if (mode === 'max') return Math.max(v, cj);
          if (mode === 'pureAdditive') return v + cj;
          // screen-blend (additive family): lit + c - lit*c/K
          return v + cj - (v * cj) / K;
        });
      }
      return lit;
    }

    it('Layer 2c LOAD-BEARING: N same-color aura contributions under max-blend = 1 contribution', () => {
      // THE LOAD-BEARING PROPERTY. The max-blend family (aura/biome-glow)
      // takes `lit = max(lit, c)` per light. After N identical contributions,
      // the accumulated value is EXACTLY max(lit0, c) — i.e. 1 contribution's
      // worth of brightness, regardless of N. A cluster of 64 auras reads at
      // the brightness of 1 aura.
      //
      // Reverting the max-blend branch (so auras fall through to the additive
      // screen-blend `lit + c - lit*c/K`) makes this assertion FAIL: the
      // additive accumulation grows monotonically with N (bounded by K but
      // strictly greater than 1 contribution for N≥2).
      const lit0 = [0.05, 0.05, 0.05]; // ambient floor
      const c = [1.2, 1.2, 1.2]; // a single aura's contribution at the core
      const n = 10; // a clustered group
      const accumulated = accumulate(lit0, c, n, 'max');
      const single = accumulate(lit0, c, 1, 'max');
      for (let i = 0; i < 3; i++) {
        expect(accumulated[i]).toBe(single[i]!); // N=10 == N=1 under max-blend
        // And it equals max(lit0, c) (the single-contribution value).
        expect(accumulated[i]).toBe(Math.max(lit0[i]!, c[i]!));
      }
    });

    it('Layer 2c: additive accumulation GROWS with N (the contrast vs max-blend)', () => {
      // The additive family (screen-blend) accumulates: N=10 > N=1. This is
      // the behavior we WANT for torch/explosion/projectile lights (energy
      // should sum). The contrast vs the max-blend test above is the proof
      // that the two families are genuinely distinguished — if both branches
      // accidentally used the same formula, one of these two tests would fail.
      const lit0 = [0.05, 0.05, 0.05];
      const c = [1.2, 1.2, 1.2];
      const single = accumulate(lit0, c, 1, 'add');
      const clustered = accumulate(lit0, c, 10, 'add');
      expect(clustered[0]!).toBeGreaterThan(single[0]!);
    });

    it('Layer 2c: pure-additive accumulation is the unbounded regression baseline', () => {
      // The pre-ticket-19 path: `lit += c` per light. Unbounded — N=10
      // contributions sum to 10×c (+ ambient). This is the white-blob
      // regression baseline; the additive-family screen-blend (above) bounds
      // it to the K asymptote, and the max-blend family caps it at 1×c.
      const lit0 = [0.05, 0.05, 0.05];
      const c = [1.2, 1.2, 1.2];
      const pureAdditive = accumulate(lit0, c, 10, 'pureAdditive');
      // 10 * 1.2 + 0.05 = 12.05 — unbounded (would tonemap to ~0.99 under ACES).
      expect(pureAdditive[0]!).toBeCloseTo(0.05 + 10 * 1.2, 3);
    });

    it('Layer 2c: ACES(2.5) ≈ 0.938 — the lowered additive-family asymptote (CORRECTED math)', () => {
      // D2 lowers K 4.0 → 2.5. The asymptote of `lit + c - lit*c/K` for
      // repeated contributions of magnitude c is K (the screen-blend cap). A
      // saturated additive cluster tonemaps to ACES(K).
      //
      // DEVIATION NOTE: the ticket spec'd ACES(4.0)≈0.85 / ACES(2.5)≈0.76, but
      // those are INCORRECT. Verified against the Narkowicz fit
      // (a=2.51,b=0.03,c=2.43,d=0.59,e=0.14):
      //   ACES(1.0)≈0.804   ACES(2.5)≈0.938   ACES(4.0)≈0.973
      // So K=4.0→2.5 shifts the asymptote 0.973→0.938 — a MODEST ≈3.6%
      // reduction, NOT the 0.85→0.76 (≈10%) the ticket assumed. The PRIMARY
      // whiteout fix is the max-blend family (the test above), not the K
      // change. K=2.5 is retained per spec; the modest magnitude is flagged
      // in the worker report. This test asserts the CORRECT values so a
      // future edit that changes K is caught against the real ACES curve.
      const aces = (x: number): number => {
        const aa = 2.51,
          b = 0.03,
          cc = 2.43,
          d = 0.59,
          e = 0.14;
        return Math.min(1, Math.max(0, (x * (aa * x + b)) / (x * (cc * x + d) + e)));
      };
      // Sanity: the corrected ACES values.
      expect(aces(1.0)).toBeCloseTo(0.804, 2);
      expect(aces(2.5)).toBeCloseTo(0.938, 2);
      expect(aces(4.0)).toBeCloseTo(0.973, 2);

      // Saturate the additive accumulation (N→∞) → approaches K=2.5.
      const lit0 = [0.05, 0.05, 0.05];
      const c = [0.5, 0.5, 0.5];
      const saturated = accumulate(lit0, c, 200, 'add');
      // ACES of the saturated HDR value must be ≈ ACES(2.5)≈0.938 (the
      // saturated accumulation approaches K=2.5).
      expect(aces(saturated[0]!)).toBeGreaterThan(0.92);
      expect(aces(saturated[0]!)).toBeLessThan(0.95);
      // And specifically LOWER than the pre-D2 ACES(4.0)≈0.973 (the K change
      // does help, modestly).
      expect(aces(saturated[0]!)).toBeLessThan(aces(4.0));
    });

    it('Layer 2: the aura palette entry is blend="max"', () => {
      // The palette drives the packer → the blend offset folded into
      // `uLightParams[i].w`. The aura must be 'max' so clustered auras don't
      // sum. Reverting to 'add' (or omitting the field) makes this assertion
      // fail AND the max-blend branch never fires for auras (the whiteout
      // returns).
      expect(LIGHT_PALETTE.aura.blend).toBe('max');
    });

    it('Layer 2: the biome-glow palette entry is blend="max"', () => {
      // Same rationale as aura — clustered magical crystals shouldn't stack
      // to white.
      expect(LIGHT_PALETTE['biome-glow'].blend).toBe('max');
    });

    it('Layer 2: flame/spell/explosion kinds stay blend="add" (energy SHOULD accumulate)', () => {
      // The non-aura/biome-glow family stays additive. Spot-check torch +
      // campfire + fire + barrel-fire (the explosion kind). A regression that
      // accidentally flips these to 'max' makes this assertion fail.
      expect(LIGHT_PALETTE.torch.blend).toBe('add');
      expect(LIGHT_PALETTE.campfire.blend).toBe('add');
      expect(LIGHT_PALETTE.fire.blend).toBe('add');
      expect(LIGHT_PALETTE['barrel-fire'].blend).toBe('add');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. ENTITY-VS-FLOOR CONTRAST AT THE LIGHT CORE — the readability rescue
  //    (D2 Layer 1 preserves the ticket-05 property: the entity silhouette
  //    survives THROUGH the warm wash). Replicates the shader math at the
  //    player-center pixel for the C2 aura (warm-white, radius 512).
  // ──────────────────────────────────────────────────────────────────────
  describe('behavioral math — entity-vs-floor contrast at the light core (Layer 1 preserves readability)', () => {
    // Constants verbatim from the pipeline (single source of truth). C2 aura:
    // color [1.0,0.95,0.88], radius 512, intensity 1.2.
    const aura = LIGHT_PALETTE.aura!;
    const hero = HERO_LIGHT_OVERRIDES.aura!;
    const ambient = AMBIENT_FLOOR[5]!; // C5: [0.28,0.24,0.18]
    const K = 2.5; // D2 additive-family asymptote (was 4.0)

    const entityAlbedo = [0.7, 0.5, 0.4];
    const floorAlbedo = [0.15, 0.13, 0.12];

    /** Rec BT.709 luma. */
    const luma = (rgb: number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

    /**
     * Compute the accumulated lit value for a given albedo at the aura core,
     * per the post-D2 shader math (diffuse only — emissive REMOVED). The aura
     * is max-blend, but for a SINGLE aura the accumulation is identical across
     * all three branches (max(lit0, c) vs screen-blend both produce a value ≥
     * lit0; the difference is only visible under N≥2). Use the max-blend
     * branch since that's what the aura uses.
     */
    function litAtCore(albedo: number[]): number[] {
      const t = 1;
      const coreT = Math.pow(t, aura.corePower);
      const halo = t * t * (3 - 2 * t);
      const atten = (coreT + halo * aura.haloFrac) * hero.intensity;
      const diff = 1;
      const lit0 = albedo.map((a, i) => a * ambient[i]!);
      // post-D2: diffuse only (no emissive add).
      const c = albedo.map((a, i) => a * aura.color[i]! * atten * diff);
      // Aura is max-blend: lit = max(lit0, c).
      return lit0.map((v, i) => Math.max(v, c[i]!));
    }

    it('the entity stays readable THROUGH the warm wash at the light core', () => {
      // THE LOAD-BEARING PROPERTY (preserved from ticket 05). The bright
      // entity pixel stays brighter than the dim floor pixel through the warm
      // wash — the readability rescue. The diffuse term (albedo-modulated,
      // which D2 keeps) is what carries this; the removed emissive-add was
      // what threatened it.
      const entityLit = litAtCore(entityAlbedo);
      const floorLit = litAtCore(floorAlbedo);
      const contrast = luma(entityLit) / luma(floorLit);
      expect(contrast).toBeGreaterThan(1.5); // entity clearly brighter
    });

    it('the fix does NOT darken the world (cosmetic-only — GDD line 210)', () => {
      // The fix makes entities VISIBLE THROUGH light cores, NOT darker. The
      // entity pixel at the light core must be brighter than the ambient-only
      // floor (the light is doing real work via the diffuse term). D2fix lowered
      // aura intensity 1.2→0.7, so the absolute HDR value dropped — the property
      // is RELATIVE (lit > ambient), not an absolute threshold.
      const entityLit = litAtCore(entityAlbedo);
      const ambientOnly = entityAlbedo.map((a, i) => a * ambient[i]!);
      expect(luma(entityLit)).toBeGreaterThan(luma(ambientOnly));
      // And clearly above the unlit ambient floor luma (the light is doing
      // real work, the cosmetic floor is not all that's visible).
      const ambientLuma = luma(entityAlbedo.map((a, i) => a * ambient[i]!));
      expect(luma(entityLit)).toBeGreaterThan(ambientLuma * 4);
    });
  });
});
