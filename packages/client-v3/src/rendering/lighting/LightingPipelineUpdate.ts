/**
 * LightingPipelineUpdate — the per-frame light-pack + uniform-handoff step
 * extracted from LightingPipeline.update() (ticket 12 made room by moving this
 * out, keeping the pipeline file under the 450-line lint cap). The atmosphere
 * drive (ticket 12) consumed the line budget the cap allowed; this is the
 * cleanest self-contained extraction — the test-light injection + budget select
 * + packLights + HdrLit uniform stash + Final handoff are one cohesive step.
 *
 * Pure pipeline-driver logic — no allocation in steady state (reuses the
 * pipeline's scratch + uniform stash). Cosmetic-only (GDD forbids fog of war).
 */
import type Phaser from 'phaser';
import { packLights, type PackedLightBuffers, type DynamicLight } from './LightPacker.js';
import { injectTestLights } from './LightingTestLights.js';
import { TIERS, ACTIVE_TIER } from './LightingTiers.js';
import { LIGHT_PRIORITY } from './LightBudget.js';
import type { LightingBudgetStage } from './LightingBudgetStage.js';
import type { LightingFinalController } from './LightingFinalFilter.js';
import type { HdrUniformStash } from './LightingRtShaderBuilder.js';
import type { LightPlacementTiled } from './LightPacker.js';
import { getLightingDevFlags } from './LightingDevFlags.js';

/** Inputs the pack + handoff step needs from the pipeline (live state). */
export interface PipelineUpdateInputs {
  /** The static placements (map-gen) — packed alongside the dynamic lights. */
  placements: ReadonlyArray<LightPlacementTiled>;
  /** Grid→world px conversion factor. */
  tileSize: number;
  /** The reused packed-light buffers (uLights/uLightColors/uLightParams). */
  buffers: PackedLightBuffers;
  /** The per-frame budget stage (owns the dynamic candidate list). */
  budgetStage: LightingBudgetStage;
  /** Uniform stash read by the HdrLit setupUniforms closure each frame. */
  uniformStash: HdrUniformStash;
  /** Scratch for the DEV test-light fixture. */
  testLightScratch: DynamicLight[];
  /** The albedo RT (its camera's worldView is handed to the HdrLit shader). */
  albedoRT: Phaser.GameObjects.RenderTexture;
  /** The main camera (drives the budget cull rect). */
  cam: Phaser.Cameras.Scene2D.Camera;
  /** The lit HDR shader's glTexture (handed to the Final controller). */
  hdrShader: Phaser.GameObjects.Shader;
  /** The bloom-V shader's glTexture (handed to the Final controller). */
  bloomVShader: Phaser.GameObjects.Shader;
  /** The Final controller (receives lit + bloom textures). */
  finalController: LightingFinalController;
  /** Test-light base world px (DEV A/B path). */
  testLightBaseX: number;
  testLightBaseY: number;
  /** Test-light enabled flag (DEV A/B; default OFF — placements drive the scene). */
  testLightEnabled: boolean;
}

/**
 * Run the budget pass + pack lights + hand uniforms + Final textures for one
 * frame. Called from LightingPipeline.update() after the albedo RT capture.
 * Returns the kept dynamic slice (so the pipeline can stash it for the next
 * frame's atmosphere ember-anchor resolution — ticket 12).
 */
export function packLightsAndHandoff(
  inputs: PipelineUpdateInputs,
  timeSeconds: number,
): ReadonlyArray<DynamicLight> {
  const {
    placements,
    tileSize,
    buffers,
    budgetStage,
    uniformStash,
    testLightScratch,
    albedoRT,
    cam,
    hdrShader,
    bloomVShader,
    finalController,
    testLightBaseX,
    testLightBaseY,
    testLightEnabled,
  } = inputs;

  // ── Pack lights into the HdrLit uniforms ──
  // Ticket 10: test lights default OFF (placements drive the scene). The
  // DEV-only `window.__LIGHTING_TEST_LIGHTS__` flag re-enables them for A/B.
  const flags = getLightingDevFlags();
  if (flags.testLights ?? testLightEnabled) {
    testLightScratch.length = 0;
    injectTestLights(testLightBaseX, testLightBaseY, timeSeconds, testLightScratch);
    for (let i = 0; i < testLightScratch.length; i++) {
      budgetStage.addDynamic(testLightScratch[i]!, LIGHT_PRIORITY.STATIC);
    }
  }

  // ── Ticket 11: budget pass — trim (placements + dynamic) to ≤80 on-screen ──
  const kept = budgetStage.select(placements, tileSize, cam);

  packLights(buffers, kept.placements, kept.dynamic, {
    enabled: true,
    tileSize,
    // Ticket 10: static map lights flicker (torch/campfire/candle/barrel-fire
    // ON, biome-glow OFF), gated by the active tier's flicker flag.
    timeSeconds,
    flickerEnabled: TIERS[ACTIVE_TIER]?.flicker ?? true,
  });

  // ── Hand uniforms + world-view to the HdrLit shader (read by setupUniforms) ──
  const wv = albedoRT.camera.worldView;
  uniformStash.worldView = [wv.x, wv.y, wv.width, wv.height];
  uniformStash.lightCount = buffers.uLightCount;
  uniformStash.useNormals = true;
  // Debug show-mode override (DEV/A-B): 0=lit (default), 1=albedo, 2=normals,
  // 3=lit-pre-tonemap. Lets the harness isolate which RT stage has content.
  uniformStash.showMode = flags.show ?? 0;
  // Ticket 19 — accumulation-model A/B toggle (the Diablo III white-blob fix).
  // DEV-only runtime flip: `window.__LIGHTING_PURE_ADDITIVE__ = true` switches
  // to the OLD pure-additive path (the regression baseline); unset/false keeps
  // the NEW alpha-composite (blend-add) path. Default = new path (0.0), so the
  // shipped look is the fix; the flag exists only for the live A/B proof +
  // regression guard. Read each frame so the flip is live (no recompile).
  uniformStash.pureAdditive = flags.pureAdditive ? 1.0 : 0.0;

  // ── Hand the lit RT + bloom outputs to the Final controller ──
  finalController.hdrLitTexture = hdrShader.glTexture;
  finalController.bloomTexture = bloomVShader.glTexture;

  return kept.dynamic;
}
