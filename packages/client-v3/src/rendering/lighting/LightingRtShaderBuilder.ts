/**
 * RT shader stage builder for the lighting pipeline.
 *
 * Builds the standalone RT Shader GameObjects (Sobel, HdrLit, Bright, H-blur,
 * V-blur) that sit on the display list + render to their own framebuffers.
 * Extracted from `LightingPipeline.ts` to respect the 450-line file-length
 * lint cap.
 *
 * Phaser-4.1 gotcha #1 (pinned here): the returned shaders stay `visible` —
 * we never call `setVisible(false)` on them. `setRenderToTexture` diverts
 * their output off-screen on its own; their display-list presence is what
 * drives the render-to-texture step. Calling `setVisible(false)` starves it
 * and leaves the framebuffer flat (the exact bug the prototype's diag harness
 * caught).
 */
import type Phaser from 'phaser';
import { AMBIENT_FLOOR, TIERS, ACTIVE_TIER, SOBEL_STRENGTH, BLOOM } from './LightingTiers.js';
import {
  SOBEL_FRAG_SOURCE,
  HDR_LIT_FRAG_SOURCE,
  BRIGHT_FRAG_SOURCE,
  BLUR_FRAG_SOURCE,
} from './LightingShaders.js';
import {
  ALBEDO_RT_KEY,
  NORMALS_RT_KEY,
  LIT_RT_KEY,
  BLOOM_BRIGHT_RT_KEY,
  BLOOM_H_RT_KEY,
  BLOOM_V_RT_KEY,
} from './LightingPipeline.js';

/**
 * Cookie texture keys bound at HdrLit slots 2/3/4 (ticket 07). Per the validated
 * palette: light_01 = warm (torch/fire/candle), light_02 = cool (aura),
 * light_03 = poison. The HdrLit shader selects which to sample per light via
 * `uLightParams[i].w` (1/2/3 → slot 2/3/4). Loaded as standalone textures in
 * MainMenuScene.preload (the `vfx` atlas also has light_0* frames, but the
 * pipeline's `add.shader(inputKeys)` binds by standalone key).
 */
const COOKIE_KEY_LIGHT_01 = 'light_01';
const COOKIE_KEY_LIGHT_02 = 'light_02';
const COOKIE_KEY_LIGHT_03 = 'light_03';

/** Uniform stash the HdrLit setupUniforms closure reads each frame. */
export interface HdrUniformStash {
  uLights: Float32Array;
  uLightColors: Float32Array;
  uLightParams: Float32Array;
  /**
   * D2 — the per-light accumulation blend mode is PACKED into
   * `uLightParams[i].w` (alongside the cookie index: `cookieIdx + (max ? 10 :
   * 0)`), NOT a separate uniform array. A 256-element `uLightBlend[MAX_LIGHTS]`
   * would overflow `MAX_FRAGMENT_UNIFORM_VECTORS` on many GPUs → shader link
   * failure → black screen. The HdrLit loop reads it back via `lp.w > 9.5`
   * (true when packed ≥ 10, i.e. max-blend) and extracts the cookie via
   * `mod(lp.w, 10.0)`.
   */
  worldView: number[] | null;
  lightCount: number;
  useNormals: boolean;
  showMode: number;
  /**
   * Ticket 19 — accumulation-model A/B toggle (the Diablo III white-blob fix).
   * 0.0 = alpha-composite (blend-add) accumulation (the NEW path; default —
   * keeps overlapping lights discrete/readable per Love GDC 2013). 1.0 = pure
   * additive (the OLD regression-baseline path). Read each frame from the
   * `window.__LIGHTING_PURE_ADDITIVE__` debug global in LightingPipelineUpdate.
   */
  pureAdditive: number;
}

/**
 * Build the Sobel normal-generation RT shader: __albedoRT → __normalsRT.
 */
export function buildSobelShader(
  scene: Phaser.Scene,
  gbufW: number,
  gbufH: number,
  strength: number = SOBEL_STRENGTH,
): Phaser.GameObjects.Shader {
  return makeRtShader(
    scene,
    'SobelNormals',
    gbufW,
    gbufH,
    SOBEL_FRAG_SOURCE,
    (setUniform) => {
      setUniform('uAlbedo', 0);
      setUniform('uTexel', [1.0 / gbufW, 1.0 / gbufH]);
      // Per-instance override (menu passes a stronger value for more relief).
      setUniform('uStrength', strength);
    },
    [ALBEDO_RT_KEY],
    NORMALS_RT_KEY,
  );
}

/**
 * Build the HdrLit composite RT shader: __albedoRT + __normalsRT + 3 cookies → __litRT.
 * The setupUniforms closure reads the live uniform stash each frame. Sampler
 * slots: 0=albedo, 1=normals, 2=light_01, 3=light_02, 4=light_03. The shader
 * selects the per-light cookie via `uLightParams[i].w`.
 */
export function buildHdrLitShader(
  scene: Phaser.Scene,
  gbufW: number,
  gbufH: number,
  stash: HdrUniformStash,
  specularScale: number = 1.0,
): Phaser.GameObjects.Shader {
  const ambient = AMBIENT_FLOOR[ACTIVE_TIER] ?? AMBIENT_FLOOR[1]!;
  const tier = TIERS[ACTIVE_TIER] ?? TIERS[1]!;
  return makeRtShader(
    scene,
    'HdrLit',
    gbufW,
    gbufH,
    HDR_LIT_FRAG_SOURCE,
    (setUniform) => {
      setUniform('uAlbedoSampler', 0);
      setUniform('uNormalsSampler', 1);
      setUniform('uCookieSampler1', 2); // light_01 (warm)
      setUniform('uCookieSampler2', 3); // light_02 (cool aura)
      setUniform('uCookieSampler3', 4); // light_03 (poison)
      setUniform('uWorldView', stash.worldView ?? [0, 0, 1, 1]);
      setUniform('uLightCount', stash.lightCount);
      setUniform('uLights[0]', stash.uLights);
      setUniform('uLightColors[0]', stash.uLightColors);
      setUniform('uLightParams[0]', stash.uLightParams);
      // D2 — the per-light blend mode is packed into `uLightParams[i].w`
      // (cookieIdx + 10 for max-blend); the HdrLit loop reads it via
      // `lp.w > 9.5`. No separate `uLightBlend` uniform (the 256-element array
      // overflowed `MAX_FRAGMENT_UNIFORM_VECTORS` → black screen).
      setUniform('uAmbient', [ambient[0], ambient[1], ambient[2]]);
      setUniform('uUseNormals', stash.useNormals ? 1.0 : 0.0);
      setUniform('uShowMode', stash.showMode);
      setUniform('uTwoTerm', tier.twoTerm ? 1.0 : 0.0);
      setUniform('uSpecular', tier.specular ? 1.0 : 0.0);
      // Per-instance specular-term scale (menu passes >1 for a stronger sheen;
      // gameplay default 1.0).
      setUniform('uSpecularScale', specularScale);
      setUniform('uCookie', tier.cookie ? 1.0 : 0.0);
      // Ticket 19 — accumulation A/B toggle (default 0 = new alpha-composite).
      setUniform('uPureAdditive', stash.pureAdditive);
    },
    [ALBEDO_RT_KEY, NORMALS_RT_KEY, COOKIE_KEY_LIGHT_01, COOKIE_KEY_LIGHT_02, COOKIE_KEY_LIGHT_03],
    LIT_RT_KEY,
  );
}

// ─── Bloom chain (ticket 08) ──────────────────────────────────────────────
//
// Three half-res RT stages: __litRT → Bright → __bloomBright → H-blur →
// __bloomH → V-blur → __bloomVRT. The Final camera filter samples
// __bloomVRT at slot 2 and adds it (×1.4) in HDR before tonemap. Verbatim
// port of the validated 06 prototype's bloom wiring
// (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:428-443`).
//
// Half-resolution: bloom is a wide blur, so half-res is visually identical and
// ~4× cheaper (spec §"Performance budget"). The bright/blur RTs run at
// `bloomW × bloomH` = half the g-buffer dimensions; the input texture
// (__litRT, full-res) is sampled with UVs in [0,1] which are resolution-
// independent, so no UV rescaling is needed — only the RT dimensions differ.
// The blur's `uDir` texel step uses the HALF-res dimension
// (`1/bloomW`, `1/bloomH`), not the g-buffer's; wiring the full-res texel size
// here would shrink the blur to half its intended radius.

/**
 * Build the Bright-pass RT shader: __litRT → __bloomBright.
 *
 * Threshold 0.55, knee 1.2, ×1.3 boost (the ×1.3 is hardcoded in the .frag to
 * match the prototype verbatim; threshold/knee come from `LightingTiers.BLOOM`
 * so they're regression-guarded). Runs at half the g-buffer resolution.
 */
export function buildBloomBrightShader(
  scene: Phaser.Scene,
  bloomW: number,
  bloomH: number,
): Phaser.GameObjects.Shader {
  return makeRtShader(
    scene,
    'BloomBright',
    bloomW,
    bloomH,
    BRIGHT_FRAG_SOURCE,
    (setUniform) => {
      setUniform('uTex', 0);
      setUniform('uThreshold', BLOOM.threshold); // 0.55
      setUniform('uKnee', BLOOM.knee); // 1.2
    },
    [LIT_RT_KEY],
    BLOOM_BRIGHT_RT_KEY,
  );
}

/**
 * Build one separable Gaussian blur RT shader stage. Pass `axis = 'h'` for the
 * H-blur (__bloomBright → __bloomH) or `axis = 'v'` for the V-blur
 * (__bloomH → __bloomVRT). 9-tap, spread 4.0 (mirrors the prototype's
 * BLUR_FRAG + its H/V wiring at prototype.js:437-443).
 *
 * `uDir` is the texel step in one axis: `(1/bloomW, 0)` for H, `(0, 1/bloomH)`
 * for V — using the HALF-res dimension so the spread reaches its intended
 * radius.
 */
export function buildBloomBlurShader(
  scene: Phaser.Scene,
  bloomW: number,
  bloomH: number,
  axis: 'h' | 'v',
): Phaser.GameObjects.Shader {
  const isH = axis === 'h';
  const inputKey = isH ? BLOOM_BRIGHT_RT_KEY : BLOOM_H_RT_KEY;
  const rtKey = isH ? BLOOM_H_RT_KEY : BLOOM_V_RT_KEY;
  const name = isH ? 'BloomH' : 'BloomV';
  // uDir uses the half-res dimension (bloomW/bloomH), NOT the g-buffer size.
  const dir: [number, number] = isH ? [1.0 / bloomW, 0.0] : [0.0, 1.0 / bloomH];
  return makeRtShader(
    scene,
    name,
    bloomW,
    bloomH,
    BLUR_FRAG_SOURCE,
    (setUniform) => {
      setUniform('uTex', 0);
      setUniform('uDir', dir);
      setUniform('uSpread', BLOOM.spread); // 4.0
    },
    [inputKey],
    rtKey,
  );
}

/**
 * Build one RT shader stage. GOTCHA #1: the returned shader stays `visible`
 * (we never call setVisible(false)) — its display-list presence is what drives
 * the render-to-texture step.
 */
function makeRtShader(
  scene: Phaser.Scene,
  name: string,
  gbufW: number,
  gbufH: number,
  fragmentSource: string,
  setupUniforms: (setUniform: (name: string, value: unknown) => void) => void,
  inputKeys: string[],
  rtKey: string,
): Phaser.GameObjects.Shader {
  const s = scene.add.shader(
    { name, fragmentSource, setupUniforms },
    0,
    0,
    gbufW,
    gbufH,
    inputKeys,
  );
  s.setOrigin(0, 0);
  s.setRenderToTexture(rtKey);
  // GOTCHA #1 (pinned): do NOT call s.setVisible(false) — it starves the
  // render-to-texture step and leaves the framebuffer flat. The shader is on
  // the display list (visible) so Phaser flushes it in draw order;
  // setRenderToTexture diverts its output to its own framebuffer (not screen).
  return s;
}
