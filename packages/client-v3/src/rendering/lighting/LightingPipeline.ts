/**
 * LightingPipeline — the deferred composite lighting controller.
 *
 * Owns the multi-RT pipeline + the camera-internal Final filter and drives
 * them per frame. Ticket 08 completes the AAA stack (half-res bloom chain +
 * Final bloom/grade/vignette ON at tier 5 — the validated "WOW / PERFECT"
 * look). Tickets 06/07 landed Sobel + HdrLit AAA + ACES; ticket 11 adds the
 * dynamic-light budget pass (auras/explosions/projectiles/barrel-fire, ≤80).
 *
 * Ambient floor `vec3(0.18,0.15,0.12)` (ticket 23 warm ember; verbatim cool-navy). Flip ACTIVE_TIER to 1 to A/B-regress against the tier-1 baseline.
 *
 * WebGL-only (ticket 14): bootLightingPipeline returns null on Canvas so this
 * never constructs there; ctor throws defense-in-depth if bypassed.
 *
 * Pipeline stages (spec has the full diagram + Phaser-4.1 gotchas): world →
 * __albedoRT → Sobel → __normalsRT; HdrLit → __litRT (HDR); bloom chain
 * (Bright→H→V, half-res) → __bloomVRT; Final (camera INTERNAL) samples
 * __litRT + __bloomVRT → ACES + bloom + vignette + grade, alpha-composites HUD.
 *
 * Resolution-resize (hard constraint #4): RTs + shaders destroyed + recreated
 * on resize (NOT in-place setSize — the glTexture-null race) via the scale
 * 'resize' event → `rebuild()`. World-pos Y-flip in hdrLit.frag.
 */
import Phaser from 'phaser';
import { logger } from '@sector-battle/shared';
import type { SectorType } from '@sector-battle/shared';
import { DesignTokens } from '../../ui/DesignTokens.js';
import {
  createLightBuffers,
  type LightPlacementTiled,
  type DynamicLight,
  type PackedLightBuffers,
} from './LightPacker.js';
import { LightingFinalController, FinalFilterNode } from './LightingFinalFilter.js';
import { destroyRtStages, bindResize } from './LightingResizeHandler.js';
import {
  buildSobelShader,
  buildHdrLitShader,
  buildBloomBrightShader,
  buildBloomBlurShader,
  type HdrUniformStash,
} from './LightingRtShaderBuilder.js';
import { buildDiagnosticSnapshot, type LightingDiagnosticSnapshot } from './LightingDiagnostic.js';
import { LightingBudgetStage } from './LightingBudgetStage.js';
import { LightingAtmosphere } from './LightingAtmosphere.js';
import { driveAtmosphere } from './LightingPipelineAtmosphere.js';
import { packLightsAndHandoff } from './LightingPipelineUpdate.js';
import { setAtmosphereDevFlag, getLightingDevFlags } from './LightingDevFlags.js';
import { LIGHT_PRIORITY, type BudgetConfig } from './LightBudget.js';
import {
  buildAlbedoRT,
  applyOptionBCameraSetup,
  captureWorldIntoAlbedo,
} from './LightingAlbedoRtBuilder.js';
import {
  LightingWorldCaptureRegistry,
  type WorldCaptureFilterInputs,
} from './LightingWorldCaptureRegistry.js';
import type { LightingPipelineOptions } from './LightingPipelineTypes.js';

// The options interface + the RT texture keys moved to LightingPipelineTypes.ts
// (max-lines cap; PlayerRendererTypes precedent). Re-exported so existing
// import sites keep working unchanged.
export * from './LightingPipelineTypes.js';

/**
 * The pipeline controller. Construct after the scene's world is built; call
 * `update()` once per frame (after camera follow, before HUD). Destroys
 * cleanly on `shutdown()` (scene tear-down + resize rebuild).
 */
export class LightingPipeline {
  private scene: Phaser.Scene;
  private tileSize: number;
  private readonly worldDepthCutoff: number;
  /** Per-instance sobel strength override (undefined → global SOBEL_STRENGTH). */
  private readonly sobelStrength?: number;
  /** Per-instance specular scale override (undefined → 1.0). */
  private readonly specularScale?: number;
  /**
   * Ticket 51 — the world-capture list, maintained INCREMENTALLY on the
   * scene's display-list add/remove events (replaces the per-frame full
   * display-list scan). See `LightingWorldCaptureRegistry` for the
   * order-equivalence proof + the `__LIGHTING_CAPTURE_COMPARE__` harness. */
  private readonly captureRegistry: LightingWorldCaptureRegistry;

  private albedoRT!: Phaser.GameObjects.RenderTexture;
  private sobelShader!: Phaser.GameObjects.Shader;
  private hdrShader!: Phaser.GameObjects.Shader;
  // Bloom chain (ticket 08) — half-res RT shaders: bright → H-blur → V-blur.
  private bloomBrightShader!: Phaser.GameObjects.Shader;
  private bloomHShader!: Phaser.GameObjects.Shader;
  private bloomVShader!: Phaser.GameObjects.Shader;

  private finalController!: LightingFinalController;
  private registeredNodeConstructor = false;

  /** Ticket 12 — GPU-particle atmosphere (embers + dust motes); world-depth so
   * `buildWorldCaptureList` captures it into the albedo RT (additive). Built
   * once; torn down on `shutdown()`. */
  private atmosphere: LightingAtmosphere | null = null;

  private gbufW = 0;
  private gbufH = 0;
  /**
   * Half-res bloom dimensions (ticket 08). Bloom is a wide blur so half-res is
   * visually identical and ~4× cheaper (spec §"Performance budget"). The
   * bright/blur RTs run at `bloomW × bloomH`; the full-res __litRT is sampled
   * with [0,1] UVs (resolution-independent), so only the RT dimensions differ.
   */
  private bloomW = 0;
  private bloomH = 0;

  private readonly buffers: PackedLightBuffers = createLightBuffers();

  /** Static placements (map-gen) — set by the scene once the map loads. */
  private placements: ReadonlyArray<LightPlacementTiled> = [];
  /**
   * Ticket 11 — per-frame budget stage. Owns the dynamic candidate list
   * (populated by DynamicLightPopulator) + the budget cull vs the camera rect.
   * Kept slices go straight to packLights. Extracted to LightingBudgetStage.ts.
   */
  private readonly budgetStage = new LightingBudgetStage();

  /**
   * Test lights default OFF (ticket 10) so map-gen placements drive the scene.
   * DEV-only `window.__LIGHTING_TEST_LIGHTS__ = true` re-enables them for A/B
   * regression against the ticket-06/07 hardcoded-light look.
   */
  private testLightEnabled = false;
  private testLightBaseX = 0;
  private testLightBaseY = 0;
  /**
   * Scratch for the test-light fixture (`injectTestLights` writes raw
   * `DynamicLight`s; we wrap them as STATIC-priority candidates). Reused each
   * frame (zero alloc). DEV-only path.
   */
  private readonly testLightScratch: DynamicLight[] = [];

  /**
   * World-depth GameObjects already ignored on the main camera (so they don't
   * double-render — they're captured into the albedo RT instead). Owned by
   * the capture registry (ticket 51): entries are cleaned on destroy (the
   * old scan's set only grew — unbounded + pinned dead objects).
   */

  constructor(scene: Phaser.Scene, options: LightingPipelineOptions) {
    this.scene = scene;
    this.tileSize = options.tileSize;
    this.worldDepthCutoff = options.worldDepthCutoff ?? DesignTokens.depth.hudBg;
    this.sobelStrength = options.sobelStrength;
    this.specularScale = options.specularScale;
    if (scene.game.renderer?.type !== Phaser.WEBGL)
      throw new Error('LightingPipeline requires WebGL (ticket 14 Canvas fallback).');
    this.build();
    // Resolution-resize (ticket 08): destroy + recreate RTs + shaders + bloom
    // (NOT in-place setSize — the glTexture-null race). Final/cam survive.
    this.unbindResize = bindResize(this.scene, () => this.rebuild());
    // Ticket 51: the incremental world-capture registry — constructed after
    // build() (the seed sees the pipeline's own RTs/shaders; they're filtered
    // at the first synchronize) + survives resize rebuilds via live filter
    // inputs. See LightingWorldCaptureRegistry for the equivalence proof.
    this.captureRegistry = new LightingWorldCaptureRegistry(
      this.scene,
      () => this.captureFilterInputs,
    );
  }

  /** Ticket 51: live filter inputs for the capture registry (zero per-frame
   * allocation — `build()` refreshes the RT ref; `rtShaders` IS `rtShaderRefs`). */
  private readonly captureFilterInputs: WorldCaptureFilterInputs = {
    albedoRT: undefined as unknown as Phaser.GameObjects.RenderTexture,
    rtShaders: [],
    worldDepthCutoff: 0,
  };

  /** Ticket 51: the RT-shader exclusion set (was a per-frame array literal). */
  private readonly rtShaderRefs: Phaser.GameObjects.Shader[] = [];

  /** Unbind callback for the scale 'resize' listener (set by bindResize). */
  private unbindResize: (() => void) | null = null;
  /** Destroy + recreate RTs + shaders + bloom on resize (ticket 08 — race-free). */
  private rebuild(): void {
    destroyRtStages(this.scene, this.rtStagesForResize());
    this.build();
  }

  /** Snapshot of the RT/shader fields for the resize handler to tear down. */
  private rtStagesForResize() {
    return {
      sobelShader: this.sobelShader,
      hdrShader: this.hdrShader,
      bloomBrightShader: this.bloomBrightShader,
      bloomHShader: this.bloomHShader,
      bloomVShader: this.bloomVShader,
      albedoRT: this.albedoRT,
    };
  }

  /**
   * Build the RT + shader stages + Final filter. Called once at construction
   * and again on resize (destroy + recreate — avoids the generateMipmap race).
   *
   * The Final controller + camera setup are created/added ONCE (first build
   * only); rebuilds reuse them (they're scene-scoped, not viewport-sized). The
   * RTs + pipeline shaders + bloom chain are viewport-sized → rebuilt every
   * time.
   */
  private build(): void {
    const renderer = this.scene.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    const reg = renderer.renderNodes;
    // Register the FilterFinal node constructor exactly once per renderer.
    if (!reg.getNode('FilterFinal')) {
      reg.addNodeConstructor('FilterFinal', FinalFilterNode);
      this.registeredNodeConstructor = true;
    }
    this.recalcInternalRes();
    // ── Albedo RT (viewport-sized; redrawn each frame from the visible world) ──
    this.albedoRT = buildAlbedoRT(this.scene, this.gbufW, this.gbufH);
    // Ticket 51: keep the capture registry's live filter inputs tracking the
    // (possibly rebuilt) RT + shader refs.
    this.captureFilterInputs.albedoRT = this.albedoRT;
    this.captureFilterInputs.worldDepthCutoff = this.worldDepthCutoff;
    this.captureFilterInputs.rtShaders = this.rtShaderRefs;
    // ── Pipeline shaders (built once; rebuilt on resize) ──
    this.buildPipelineShaders();

    // ── Camera + Final filter: created ONCE (first build). Reused on rebuild
    // (Option B composition — see LightingAlbedoRtBuilder.applyOptionBCameraSetup
    // for the full rationale + Phaser-4.1 constraint citation). Visual proof of
    // HUD legibility is in the Seam C verification report for this ticket.
    if (!this.finalController) {
      applyOptionBCameraSetup(this.scene);
      this.finalController = new LightingFinalController(this.scene.cameras.main);
      this.scene.cameras.main.filters.internal.add(this.finalController);
    }

    // ── Ticket 12: atmosphere (embers + dust motes). Built ONCE; world-depth → albedo RT.
    if (!this.atmosphere) {
      this.atmosphere = new LightingAtmosphere(this.scene);
    }
  }

  /**
   * Build the Sobel + HdrLit + bloom RT shader stages (called by build + resize).
   * The bloom chain runs at HALF the g-buffer resolution (ticket 08 — spec
   * §"Performance budget": half-res bloom is visually identical + ~4× cheaper).
   */
  private buildPipelineShaders(): void {
    // The shaders read the live uniform stash each frame via their setupUniforms
    // closures (built once here, polled per frame by the renderer). GOTCHA #1:
    // the builders keep the shaders visible — never setVisible(false).
    this.sobelShader = buildSobelShader(this.scene, this.gbufW, this.gbufH, this.sobelStrength);
    this.hdrShader = buildHdrLitShader(
      this.scene,
      this.gbufW,
      this.gbufH,
      this.uniformStash,
      this.specularScale,
    );
    // Bloom chain: __litRT → Bright → __bloomBright → H-blur → __bloomH →
    // V-blur → __bloomVRT. Half-res from the start (no throwaway full-res pass
    // — hard constraint #3). The Final filter samples __bloomVRT at slot 2.
    this.bloomBrightShader = buildBloomBrightShader(this.scene, this.bloomW, this.bloomH);
    this.bloomHShader = buildBloomBlurShader(this.scene, this.bloomW, this.bloomH, 'h');
    this.bloomVShader = buildBloomBlurShader(this.scene, this.bloomW, this.bloomH, 'v');
    // Ticket 51: refresh the shared exclusion array in place (the capture
    // registry + the comparator read it live).
    this.rtShaderRefs.length = 0;
    this.rtShaderRefs.push(
      this.sobelShader,
      this.hdrShader,
      this.bloomBrightShader,
      this.bloomHShader,
      this.bloomVShader,
    );
  }

  /**
   * Compute the viewport-sized internal resolution for the g-buffer RTs + the
   * half-res bloom dimensions (ticket 08). Bloom dims clamped to >=2.
   */
  private recalcInternalRes(): void {
    const w = Math.max(2, this.scene.scale.width);
    const h = Math.max(2, this.scene.scale.height);
    this.gbufW = w;
    this.gbufH = h;
    // Half-res bloom (floor of 2 — a 1px bloom RT would degenerate the blur).
    this.bloomW = Math.max(2, Math.floor(w / 2));
    this.bloomH = Math.max(2, Math.floor(h / 2));
  }

  /** Set the static map-gen placements (call once when the map loads). */
  setPlacements(placements: ReadonlyArray<LightPlacementTiled>): void {
    this.placements = placements;
  }

  /**
   * Remove any static placement sitting on the given tile. Called when a
   * destructible (e.g. a campfire) is destroyed — its motivating light disk
   * must disappear alongside the fixture sprite (`LightPropRenderer.removeAt`
   * handles the sprite in parallel). O(n) over the placement list, but only
   * fires on destruction events (rare), never per-frame. No-op when no
   * placement exists at that tile.
   */
  removePlacementAt(gridX: number, gridY: number): void {
    if (this.placements.length === 0) return;
    const filtered = this.placements.filter((p) => !(p.gridX === gridX && p.gridY === gridY));
    // Only reassign when something actually changed — avoids churning the
    // reference (and the per-frame budget-stage re-pack) for tiles that never
    // carried a placement.
    if (filtered.length !== this.placements.length) {
      this.placements = filtered;
    }
  }
  /** Ticket 31 — sector-type grid for per-sector dust theming (null = NEUTRAL). */
  setSectorTypes(
    sectorTypes: readonly (readonly SectorType[])[] | null,
    sectorTileSize: number,
  ): void {
    this.atmosphere?.setSectorTypes(sectorTypes, this.tileSize, sectorTileSize);
  }

  /** Begin a dynamic-light frame: clears the dynamic list (ticket 11 budget stage). */
  beginDynamicLights(): void {
    this.budgetStage.beginFrame();
  }

  /** Add one dynamic light for this frame (player aura, explosion, projectile,
   * barrel-fire). `priority` tags it for the budget pass (lower = kept first). */
  addDynamicLight(light: DynamicLight, priority: number = LIGHT_PRIORITY.STATIC): void {
    this.budgetStage.addDynamic(light, priority);
  }

  /** Override the budget config (ticket 11). Default = spec ≤80 + 256px margin. */
  setBudgetConfig(config: BudgetConfig): void {
    this.budgetStage.budgetConfig = config;
  }

  /** Toggle the tier-1 hardcoded test light (dev/A-B). */
  setTestLightEnabled(enabled: boolean): void {
    this.testLightEnabled = enabled;
  }

  /** Ticket 12 — toggle the atmosphere layer for the Seam B A/B screenshot. */
  setAtmosphereEnabled(enabled: boolean): void {
    setAtmosphereDevFlag(enabled);
    this.atmosphere?.setVisible(enabled);
  }

  /** Ticket 12 — true when the atmosphere layer is active (diagnostics). */
  isAtmosphereEnabled(): boolean {
    return this.atmosphere?.isEnabled() ?? false;
  }

  /** Position the test light's base (world px) — typically the local player. */
  setTestLightBase(x: number, y: number): void {
    this.testLightBaseX = x;
    this.testLightBaseY = y;
  }

  /**
   * Per-frame update: capture the world into the albedo RT, pack lights, hand
   * the lit + bloom RT glTextures to the Final controller. Sobel/HdrLit/bloom
   * shaders auto-render to their RTs (visible display-list shaders — Phaser
   * flushes them in draw order). Call AFTER camera follow.
   */
  update(timeSeconds: number): void {
    const cam = this.scene.cameras.main;

    // ── Ticket 12: advance the atmosphere BEFORE the albedo capture → albedo RT (additive).
    // Ticket 31: the camera center drives nearest-anchor ember selection.
    driveAtmosphere(
      this.atmosphere,
      {
        placements: this.placements,
        tileSize: this.tileSize,
        keptDynamic: this.lastKeptDynamic,
        cameraX: cam.worldView.x + cam.worldView.width / 2,
        cameraY: cam.worldView.y + cam.worldView.height / 2,
      },
      timeSeconds,
      cam,
    );

    // ── Pass 1: ALBEDO RT — capture the visible world (ticket 51: the
    // capture list is maintained incrementally by the registry; the camera
    // mirror + draw + glTexture refresh mechanics live in
    // `captureWorldIntoAlbedo`, extracted to respect the file-length cap). ──
    if (
      !captureWorldIntoAlbedo(
        this.scene,
        this.albedoRT,
        this.captureRegistry,
        this.gbufW,
        this.gbufH,
      )
    )
      return;

    // ── Pack lights + hand uniforms + Final textures (ticket 12: extracted to
    // LightingPipelineUpdate to keep this file under the lint cap). Returns the
    // kept dynamic slice so we can stash it for next frame's atmosphere anchors.
    this.lastKeptDynamic = packLightsAndHandoff(
      {
        placements: this.placements,
        tileSize: this.tileSize,
        buffers: this.buffers,
        budgetStage: this.budgetStage,
        uniformStash: this.uniformStash,
        testLightScratch: this.testLightScratch,
        albedoRT: this.albedoRT,
        cam,
        hdrShader: this.hdrShader,
        bloomVShader: this.bloomVShader,
        finalController: this.finalController,
        testLightBaseX: this.testLightBaseX,
        testLightBaseY: this.testLightBaseY,
        testLightEnabled: this.testLightEnabled,
      },
      timeSeconds,
    );
  }

  /** Uniform stash read by the HdrLit setupUniforms closure each frame
   * (built once in buildPipelineShaders; mutated in update, polled by renderer). */
  private readonly uniformStash: HdrUniformStash = {
    uLights: this.buffers.uLights,
    uLightColors: this.buffers.uLightColors,
    uLightParams: this.buffers.uLightParams,
    worldView: null,
    lightCount: 0,
    useNormals: true,
    showMode: 0,
    // Ticket 19 — 0 = alpha-composite (default); 1 = pure-additive A/B (flipped in LightingPipelineUpdate via `window.__LIGHTING_PURE_ADDITIVE__`).
    pureAdditive: 0,
  };

  /** Kept dynamic slice from the last budget `select()` — stashed for the atmosphere drive. */
  private lastKeptDynamic: ReadonlyArray<DynamicLight> = [];

  /**
   * Diagnostic snapshot for the headless Playwright harness (Seam B + Seam C).
   * Mirrors the prototype's `diag.js` glTexture-existence probing — no
   * `readPixels`/`snapshot` (gotcha #4). The harness asserts the shader/RT
   * fields to catch the `setVisible(false)`-starvation regression (starved RTs
   * have null glTextures). Implementation in LightingDiagnostic.ts.
   */
  getDiagnosticSnapshot(): LightingDiagnosticSnapshot {
    return buildDiagnosticSnapshot({
      sobelShader: this.sobelShader,
      hdrShader: this.hdrShader,
      bloomBrightShader: this.bloomBrightShader,
      bloomHShader: this.bloomHShader,
      bloomVShader: this.bloomVShader,
      scene: this.scene,
      finalController: this.finalController,
      worldCaptureList: this.captureRegistry.list,
      albedoRT: this.albedoRT,
      gbufW: this.gbufW,
      gbufH: this.gbufH,
      bloomW: this.bloomW,
      bloomH: this.bloomH,
      captureCompare: getLightingDevFlags().captureCompare
        ? { ...this.captureRegistry.compareStats }
        : undefined,
    });
  }

  /**
   * Tear down everything (scene shutdown). Destroys the RT shaders + RT keys +
   * Final controller; the FilterFinal node constructor stays registered (it's
   * renderer-global, not scene-scoped). Also unbinds the resize listener.
   */
  shutdown(): void {
    try {
      this.unbindResize?.();
      destroyRtStages(this.scene, this.rtStagesForResize());
      // Ticket 51: tear down the incremental capture registry (unsubscribes
      // the scene display-list events + releases the ignore set).
      this.captureRegistry.destroy();
      // Ticket 12: tear down the atmosphere (best-effort — never throws).
      this.atmosphere?.shutdown();
      this.atmosphere = null;
      // The Final controller is owned by the camera's filter list; removing it
      // there destroys it. Guard for already-torn-down cameras.
      const list = this.scene.cameras.main?.filters?.internal;
      if (list && this.finalController) {
        try {
          list.remove(this.finalController);
        } catch {
          // best-effort
        }
      }
    } catch (e) {
      logger.warn(`LightingPipeline shutdown error: ${(e as Error).message}`);
    }
  }
}
