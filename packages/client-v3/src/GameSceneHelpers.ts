import type { StateSync } from './network/StateSync.js';
import type { MapRenderer } from './rendering/MapRenderer.js';
import type { InputBuffer } from './prediction/InputBuffer.js';
import type { PlayerRenderer } from './rendering/PlayerRenderer.js';
import type { ReconciliationLog } from './debug/ReconciliationLog.js';
import type { Connection } from './network/Connection.js';
import type { CameraService } from './rendering/CameraService.js';
import type { SpectatorController } from './controllers/SpectatorController.js';
import type { InputCollector } from './input/InputCollector.js';
import type { GameState } from './controllers/GameState.js';
import { TelemetrySampler } from './telemetry/TelemetrySampler.js';
import { DebugBridge } from './debug/DebugBridge.js';
import type { DebugBridge as DebugBridgeType } from './debug/DebugBridge.js';
import Phaser from 'phaser';
import { logger } from '@sector-battle/shared';
import { SECTOR_TILE_SIZE } from '@sector-battle/shared';
import { LightingPipeline } from './rendering/lighting/LightingPipeline.js';
import { LightPropRenderer } from './rendering/lighting/LightPropRenderer.js';
import type { LightPlacementTiled } from '@sector-battle/shared';
import type { EntityInterpolator } from './prediction/EntityInterpolator.js';
import type { PredictionService } from './prediction/PredictionService.js';
import { populateDynamicLights } from './rendering/lighting/DynamicLightPopulator.js';
import { populateBarrelFuseLights } from './rendering/lighting/BarrelFuseLightPopulator.js';
import { computeFlickerMul } from './rendering/lighting/TorchFlicker.js';
import { registerLightingDiag } from './rendering/lighting/LightingDevFlags.js';
import { wireLightPlacementRemoval } from './rendering/lighting/LightPlacementReconcile.js';

/**
 * Ticket 14 — one-shot flag so the Canvas-fallback info log fires exactly once
 * per page load (not every frame GameScene.update calls bootLightingPipeline
 * while on Canvas). Module-scoped: a single page load = a single renderer, so
 * the flag correctly tracks "have we logged this fallback yet".
 */
let canvasFallbackLogged = false;

export function buildTelemetrySampler(
  state: GameState,
  stateSync: StateSync,
  inputBuffer: InputBuffer,
  reconciliationLog: ReconciliationLog,
  playerRenderer: PlayerRenderer,
): TelemetrySampler {
  return new TelemetrySampler({
    localPos: state.localPos,
    localVelocity: state.localVelocity,
    renderOffset: state.correctionOffset,
    rtt: state.rtt,
    getServerPos: (out) => {
      const p = stateSync.getPlayer(state.myId);
      out.x = p?.x ?? 0;
      out.y = p?.y ?? 0;
    },
    getServerVelocity: (out) => {
      const p = stateSync.getPlayer(state.myId);
      out.x = p?.velocityX ?? 0;
      out.y = p?.velocityY ?? 0;
    },
    getPredictionBufferSize: () => inputBuffer.getCount(),
    getReconciliationCount: () => reconciliationLog.size,
    // Perf H-4: these two deps run every frame (TelemetrySampler.sampleFrame
    // via GameScene.update) — peekLast() is allocation-free, whereas the old
    // getEntries(1) allocated a result array per call. Same entry, same empty
    // case (0). peekLast returns the stored ring reference — READ-ONLY (the
    // entry is shared with getEntries/DebugBridge readers).
    getLastReconciliationError: () => {
      const last = reconciliationLog.peekLast();
      if (!last) return 0;
      return Math.hypot(last.correctionX, last.correctionY);
    },
    getLastReconciliationSeq: () => {
      const last = reconciliationLog.peekLast();
      if (!last) return 0;
      return last.seq;
    },
    // Perf ticket 21: the peeks read the SAME primitives the former
    // getSpriteState(...)?.field ?? fallback read, without the fresh 8-field
    // SpriteState per call (2 allocs/frame — see PlayerRenderer.peek*).
    getIsMoving: () => playerRenderer.peekIsMoving(state.myId),
    getAnimationState: () => playerRenderer.peekAnimState(state.myId),
  });
}

export function buildDebugBridge(
  connection: Connection,
  stateSync: StateSync,
  inputBuffer: InputBuffer,
  scene: Phaser.Scene,
  state: GameState,
  reconciliationLog: ReconciliationLog,
  telemetrySampler: TelemetrySampler,
  playerRenderer: PlayerRenderer,
  inputCollector: InputCollector,
  spectator: SpectatorController,
  cameraService: CameraService,
  returnToMenu: () => void,
): DebugBridgeType {
  return new DebugBridge({
    connection,
    stateSync,
    inputBuffer,
    scene,
    myId: state.myId,
    localPos: state.localPos,
    localVelocity: state.localVelocity,
    reconciliationLog,
    telemetrySampler,
    playerRenderer,
    inputCollector,
    spectator,
    cameraService,
    returnToMenu,
  });
}

/**
 * Lazily boot the deferred lighting pipeline once the map is loaded — it needs
 * the map's tileSize. Cosmetic-only (ambient floor keeps the world fully
 * visible; GDD forbids fog of war).
 *
 * Ticket 10: `placements` (the deterministic map-gen light props stashed on
 * GameState at map load) are handed to the pipeline via `setPlacements` so the
 * STATIC map lights drive the scene. The shared `LightPlacementTiled` is
 * structurally identical to the client-local type the packer consumes.
 *
 * Also exposes the `window.__LIGHTING_DIAG__` hook for the headless Playwright
 * harness (Seam B) + browser verification (Seam C): returns the RT
 * glTexture-existence snapshot. NOT readPixels/snapshot (Phaser-4.1 gotcha #4).
 * Always available (not DEV-gated) so the harness works against the docker
 * build; exposes only pipeline-internal state, no game logic.
 *
 * Ticket 14 — Canvas fallback (no-WebGL path): the deferred pipeline is
 * WebGL-only — `LightingPipeline.build()` immediately reaches for
 * `renderer.renderNodes`, `scene.add.shader(...).setRenderToTexture(...)`, and
 * the `BaseFilterShader`-based Final camera filter, none of which exist on the
 * Canvas renderer (Phaser would throw on construction). So BEFORE we touch any
 * RT/shader/filter, we detect the renderer type via the documented Phaser API
 * (`renderer.type === Phaser.WEBGL`, where `Phaser.WEBGL = 2`). On Canvas we
 * bail out returning the existing (null on first boot) value — the pipeline
 * never constructs, no RTs/shaders/filters are created, and GameScene's
 * null-guards on `this.lighting` (`driveSceneLighting` + `shutdownLighting`
 * both early-return on null) make the whole lighting subsystem cleanly no-op.
 *
 * DECISION (Ticket 14): full-disable on Canvas (option a in the ticket), NOT a
 * degraded-ambient tint (option b). Rationale: (1) full-disable is the ticket's
 * explicitly-acceptable simpler + more robust path; (2) it keeps the Canvas
 * path zero-risk (no extra Canvas-2D draws to mis-tune, no perf cost on the
 * low-end devices that hit this path); (3) the baseline dark-navy background
 * `#000814` (main.ts `backgroundColor`) still renders on Canvas — that is the
 * documented baseline mood the lighting builds on (spec §"Further Notes"), so
 * the game reads as "flat-but-playable" exactly as the ticket requires.
 * Cosmetic-only — dropping the mood layer is NOT a gameplay change (GDD
 * `docs/GDD.md:210` forbids fog of war, so visibility is never gated on
 * lighting). The one-time info log records the fallback for operators.
 *
 * Returns the booted pipeline (or null if the map isn't ready yet / Canvas).
 */
export function bootLightingPipeline(
  scene: Phaser.Scene,
  mapRenderer: MapRenderer,
  existing: LightingPipeline | null,
  placements: ReadonlyArray<LightPlacementTiled> | undefined,
  gameState: GameState,
  lightPropRenderer: LightPropRenderer | null,
): LightingPipeline | null {
  if (existing) return existing;
  // ── Ticket 14: Canvas fallback — detect WebGL BEFORE any RT/shader/filter
  // is constructed (LightingPipeline.build() is WebGL-only). `Phaser.WEBGL`
  // (= 2) is the documented renderer-type constant; `Phaser.AUTO` in main.ts
  // falls back to Canvas (= 1) on devices without WebGL. The info log is gated
  // by a module flag so it fires EXACTLY ONCE per page load (GameScene.update
  // calls this every frame while `existing` is null + Canvas, so an un-gated
  // log would be a per-frame call — wasteful on the low-end Canvas path + a
  // "console spam" risk if the logger level is raised to INFO).
  const renderer = scene.game.renderer;
  if (!renderer || renderer.type !== Phaser.WEBGL) {
    if (!canvasFallbackLogged) {
      canvasFallbackLogged = true;
      logger.info(
        '[lighting] WebGL unavailable (Canvas renderer) — ticket 14 Canvas fallback: lighting mood layer disabled, game runs flat-but-playable on the #000814 baseline.',
      );
    }
    return null;
  }
  const tileSize = mapRenderer.getTileSize();
  if (tileSize <= 0) return null;
  const lighting = new LightingPipeline(scene, { tileSize, specularScale: 0.9 });
  // Ticket 10: feed the static map-gen placements in at boot so the first lit
  // frame is driven by real data. Ticket 24: the cast is gone — the client
  // + server now share one canonical `LightPlacementTiled` (shared package).
  lighting.setPlacements(placements ?? []);
  // Wire the destructible-removal → static-light-cleanup hook ONCE at boot.
  // `ClientStateBridge.onDestructibleRemove` invokes this with the destroyed
  // tile's coords; it tears down BOTH the light disk (pipeline.removePlacementAt)
  // AND the visible fixture sprite (propRenderer.removeAt) so a destroyed
  // campfire/sconce drops its whole motivated-light footprint, not just its
  // entity sprite. Cosmetic-only (no visibility mechanic). Ticket 08: the
  // closure lives in LightPlacementReconcile.wireLightPlacementRemoval (pure,
  // unit-tested with stubs — the pipeline can't be constructed headlessly).
  // The prop renderer may be null early (defensive — it's booted before the
  // pipeline, but guard anyway).
  wireLightPlacementRemoval(gameState, lighting, lightPropRenderer);
  // Ticket 31 (round 5c): feed the sector-type grid so the dust layer runs
  // per-district recipes (shape/hue/behavior — LightingAtmosphereThemes).
  // MapRenderer holds the grid from map load; null before load / on the demo
  // map → the single NEUTRAL emitter (the pre-ticket global behavior).
  lighting.setSectorTypes(mapRenderer.getSectorTypes(), SECTOR_TILE_SIZE);
  registerLightingDiag(() => lighting.getDiagnosticSnapshot());
  return lighting;
}

/**
 * Drive the deferred lighting pipeline for one frame. The tier-1 test light
 * follows the local player's visual position so it stays world-locked under
 * camera pan/zoom (the highest-risk item from wayfinder ticket 05). No-op when
 * the pipeline hasn't booted yet (map not loaded).
 */
export function driveLightingPipeline(
  lighting: LightingPipeline | null,
  baseX: number,
  baseY: number,
  timeSeconds: number,
): void {
  if (!lighting) return;
  lighting.setTestLightBase(baseX, baseY);
  lighting.update(timeSeconds);
}

/**
 * Drive the FULL scene lighting for one frame (ticket 11): populate the
 * dynamic-light list from LIVE match state (player auras + projectiles +
 * barrel-fire + the explosion-light registry), advance the explosion-light
 * lifecycle, then drive the pipeline's pack + render. The pipeline's own
 * budget pass trims (static placements + dynamic) to the ≤80 on-screen target.
 *
 * Replaces the ticket-10 `driveLightingPipeline` call in GameScene.update so
 * GameScene.ts stays at its line cap (no inline dynamic-light wiring). No-op
 * when the pipeline hasn't booted yet (map not loaded). Cosmetic-only — lights
 * are mood, not visibility (GDD forbids fog of war).
 *
 * Positional args (not a deps object) so the GameScene call site stays compact
 * (one statement) — the file is at its 450-line lint cap. The args are the
 * same singletons GameScene already owns (no new state, no network traffic).
 *
 * @param lighting       the booted pipeline (or null if not yet booted).
 * @param state          client-side mutable state (owns the explosion registry).
 * @param stateSync      live entity maps (players/projectiles/destructibles).
 * @param interpolator   remote-player interpolated positions.
 * @param projInterpolator projectile interpolated positions (matches renderer).
 * @param predictionService local-player visual position source.
 * @param localX/localY  the local player's visual position (test-light base).
 * @param nowMs          wall-clock ms (shared frame timestamp; drives the
 *                       explosion-light fade via the registry's `update` +
 *                       `collect`, and the flicker via `computeFlickerMul`).
 */
export function driveSceneLighting(
  lighting: LightingPipeline | null,
  state: GameState,
  stateSync: StateSync,
  interpolator: EntityInterpolator,
  projInterpolator: EntityInterpolator,
  predictionService: PredictionService,
  localX: number,
  localY: number,
  nowMs: number,
): void {
  if (!lighting) return;
  // Advance the explosion-light lifecycle (expire past-lifetime flashes) before
  // collecting, so the fade + prune happen on the same timestamp the populator
  // reads. Pure bookkeeping; no allocation.
  state.explosionLights.update(nowMs);
  // Ticket 09 / A3 — advance the impact-light lifecycle too (same pattern:
  // expire past-lifetime flashes before the populator collects, on the same
  // timestamp). Pure bookkeeping; no allocation.
  state.impactLights.update(nowMs);
  // Flame flicker for this frame (explosions + barrel-fire). Deterministic per
  // frame via a fixed seed (0.0) so the flicker cadence is stable across
  // clients viewing the same scene; the per-light phase diversity comes from
  // the static-placement seeds + the explosion registry's per-blast seeds.
  const flickerMul = computeFlickerMul({ t: nowMs / 1000, seed: 0.0 });
  // Populate the dynamic-light list (clears + refills the pipeline's `dynamic`
  // array via beginDynamicLights/addDynamicLight). The pipeline's update() then
  // runs the budget pass + packs static + dynamic.
  populateDynamicLights(
    lighting,
    {
      state,
      stateSync,
      interpolator,
      projectileInterpolator: projInterpolator,
      predictionService,
      explosionLights: state.explosionLights,
      impactLights: state.impactLights,
    },
    nowMs,
    flickerMul,
  );
  // Juice-pass-1 ticket 06 — the primed-barrel warm lights. MUST run after
  // populateDynamicLights (it continues the same frame's clone pool — see
  // BarrelFuseLightPopulator's pool-discipline header note).
  populateBarrelFuseLights(lighting, stateSync, nowMs);
  // Drive the pipeline (test-light base for the DEV A/B path, then pack+render).
  lighting.setTestLightBase(localX, localY);
  lighting.update(nowMs / 1000);
}

/**
 * Tear down the lighting pipeline (scene shutdown). Returns null so the caller
 * can clear its field in the same expression. Best-effort — shutdown errors
 * are logged inside the pipeline, not thrown.
 */
export function shutdownLighting(lighting: LightingPipeline | null): LightingPipeline | null {
  lighting?.shutdown();
  return null;
}

/**
 * Ticket 17 — construct the visible prop-sprite spawner for the scene. Mirrors
 * {@link bootLightingPipeline}'s shape (construct once; the caller stores the
 * result). Call after `preloadAssets` so the `lightProps` atlas is available.
 * Cosmetic-only (GDD forbids fog of war): the fixtures are mood, never vision.
 */
export function bootLightPropRenderer(scene: Phaser.Scene): LightPropRenderer {
  return new LightPropRenderer(scene);
}

/**
 * Ticket 17 — tear down the visible prop-sprite spawner (best-effort,
 * idempotent). Mirrors {@link shutdownLighting}: the scene tear-down destroys
 * display-list children anyway, but an explicit shutdown clears the renderer's
 * tracked-sprite set + is robust against a future second onMapData. Returns
 * null so the caller can clear its field in the same expression.
 */
export function shutdownLightPropRenderer(
  renderer: LightPropRenderer | null,
): LightPropRenderer | null {
  renderer?.shutdown();
  return null;
}
