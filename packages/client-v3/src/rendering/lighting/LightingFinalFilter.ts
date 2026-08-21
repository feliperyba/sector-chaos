/**
 * The Final camera-internal filter — its output IS the on-screen image.
 *
 * A custom `BaseFilterShader` subclass registered via
 * `renderer.renderNodes.addNodeConstructor('FilterFinal', Class)`, added as
 * the main camera's last `filters.internal` entry (the spec's pipeline
 * diagram: "Final Shader (camera INTERNAL filter → screen)").
 *
 * Sampler slots:
 *   slot 0 = camera scene tex (HUD only — world is ignored on main cam + captured
 *            into the albedo RT; the lit RT comes in at slot 1).
 *   slot 1 = __litRT (HDR linear output of the HdrLit stage).
 *   slot 2 = __bloomVRT (reserved; null until ticket 08 — bloom chain).
 *
 * The Final shader tonemaps the lit RT + alpha-composites the HUD (slot 0)
 * over it. See `shaders/lighting/final.frag`.
 *
 * ── Why slot 0 IS read here (deviation from prototype, documented) ──
 *
 * The 06 prototype's FINAL_FRAG declares slot 0 (uLitSampler) but NEVER reads
 * it — its HUD is HTML/CSS (off-canvas), so the prototype outputs the lit RT
 * alone (prototype.js:285). This codebase's HUD is Phaser GameObjects on the
 * single main camera (Phaser-4.1 constraint: a camera-internal filter
 * processes the whole camera render; separate-UI-camera is out of scope), so
 * the Final filter MUST alpha-composite the HUD (slot 0) over the lit RT to
 * keep the HUD visible. See LightingPipeline.ts build() + final.frag header
 * for the full Option B rationale + Phaser-4 + prototype citations.
 *
 * Extracted from `LightingPipeline.ts` to respect the 450-line file-length
 * lint cap; the pipeline owns the RT shader stages, this module owns the
 * camera filter.
 */
import Phaser from 'phaser';
import { FINAL_FRAG_SOURCE } from './LightingShaders.js';
import { TIERS, ACTIVE_TIER } from './LightingTiers.js';

/**
 * The Final filter controller — carries the per-frame texture references +
 * tier flags from the pipeline into the FilterFinal render node.
 *
 * Tier flags are derived from `TIERS[ACTIVE_TIER]` so flipping the tier flips
 * the Final look too (A/B regression against tier 1). Ticket 08 raises
 * ACTIVE_TIER to 5 (all-on): ACES tonemap + bloom additive (HDR, pre-tonemap)
 * + warm/cool split-tone grade + vignette, A/B-comparable with the live 06
 * prototype. `BLOOM_READY` gates bloom/grade/vignette behind the bloom RT's
 * availability (kill-switch for a transiently-null bloom texture mid-resize).
 */
const SHIP_TIER = TIERS[ACTIVE_TIER] ?? TIERS[1]!;
/**
 * Ticket 08 landed the bloom chain (__litRT → Bright → __bloomBright → H-blur
 * → __bloomH → V-blur → __bloomVRT). The pipeline hands __bloomVRT's glTexture
 * to `bloomTexture` each frame, so bloom/grade/vignette now follow the tier
 * (ON at tier 5 — the validated "WOW / PERFECT" look). The flag stays as the
 * single kill-switch in case the bloom RT is ever transiently null (e.g. mid-
 * resize rebuild); the Final shader guards the null sample via `useBloom`.
 */
const BLOOM_READY = true;

export class LightingFinalController extends Phaser.Filters.Controller {
  /** __litRT output — bound at slot 1. */
  hdrLitTexture: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | null = null;
  /** __bloomVRT output — bound at slot 2 (the bloom chain's final blur stage). */
  bloomTexture: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | null = null;
  bloomStrength = 1.4;
  useBloom = SHIP_TIER.bloom && BLOOM_READY;
  // ACES replaces Reinhard at tier 2+ (Narkowicz). Reinhard kept behind the
  // toggle for A/B regression against the tier-1 baseline (spec §"Tier system").
  aces = SHIP_TIER.aces;
  grade = SHIP_TIER.grade && BLOOM_READY;
  vignette = SHIP_TIER.vignette && BLOOM_READY;
  reinhard = !SHIP_TIER.aces;

  constructor(camera: Phaser.Cameras.Scene2D.Camera) {
    super(camera, 'FilterFinal');
  }
}

/**
 * The Final render node. `setupTextures` binds the lit RT at slot 1 (and
 * bloom at slot 2 when present); slot 0 is the camera scene tex, bound by
 * default. `setupUniforms` pushes the tier flags through.
 */
export class FinalFilterNode extends Phaser.Renderer.WebGL.RenderNodes.BaseFilterShader {
  constructor(manager: Phaser.Renderer.WebGL.RenderNodes.RenderNodeManager) {
    super('FilterFinal', manager, undefined, FINAL_FRAG_SOURCE);
  }

  override setupTextures(
    controller: LightingFinalController,
    textures: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper[],
    _drawingContext: Phaser.Renderer.WebGL.DrawingContext,
  ): void {
    // slot 0 = camera scene tex (default). We bind our HDR lit + bloom at 1/2.
    if (controller.hdrLitTexture) {
      textures[1] = controller.hdrLitTexture;
    }
    if (controller.bloomTexture) {
      textures[2] = controller.bloomTexture;
    }
  }

  override setupUniforms(
    controller: LightingFinalController,
    _drawingContext: Phaser.Renderer.WebGL.DrawingContext,
  ): void {
    const pm = this.programManager;
    pm.setUniform('uSceneSampler', 0);
    pm.setUniform('uHdrLitSampler', 1);
    pm.setUniform('uBloomSampler', 2);
    pm.setUniform('uBloomStrength', controller.bloomStrength);
    pm.setUniform('uUseBloom', controller.useBloom && controller.bloomTexture ? 1.0 : 0.0);
    pm.setUniform('uACES', controller.aces ? 1.0 : 0.0);
    pm.setUniform('uGrade', controller.grade ? 1.0 : 0.0);
    pm.setUniform('uVignette', controller.vignette ? 1.0 : 0.0);
    pm.setUniform('uReinhard', controller.reinhard ? 1.0 : 0.0);
  }
}
