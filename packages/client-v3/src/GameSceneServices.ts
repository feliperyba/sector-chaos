/**
 * GameSceneServices — post-setup controller wiring extracted from
 * GameScene.create() (max-lines cap). Mechanical extraction: constructor
 * calls verbatim, `this.X` → `deps.X` (every field is assigned
 * `this.X = deps.X` immediately before this block in create(), so the
 * references are identical), `this` → the `scene` parameter, `this.state` →
 * the `state` parameter.
 */
import type Phaser from 'phaser';
import type { GameSceneDeps } from './GameSceneSetup.js';
import type { GameState } from './controllers/GameState.js';
import { PredictionService } from './prediction/PredictionService.js';
import { InputOrchestrator } from './input/InputOrchestrator.js';
import { InterpolationService } from './prediction/InterpolationService.js';
import { PlayerLifecycleController } from './controllers/PlayerLifecycleController.js';
import { AudioTriggerService } from './audio/AudioTriggerService.js';
import { HUDUpdateService } from './controllers/HUDUpdateService.js';
import { MinimapDataAdapter } from './controllers/MinimapDataAdapter.js';
import type { MapBannerController } from './controllers/MapBannerController.js';

export interface SceneServices {
  predictionService: PredictionService;
  inputOrch: InputOrchestrator;
  interpolationService: InterpolationService;
  lifecycle: PlayerLifecycleController;
  audioTriggers: AudioTriggerService;
  hudUpdater: HUDUpdateService;
  minimapAdapter: MinimapDataAdapter;
  /** Map-redesign ticket 03 — created early in setupGameSystems (the event
   *  bridge takes its callbacks); reused here so GameScene.update owns the
   *  per-frame crossing detection. Undefined in partial test harnesses. */
  mapBanners?: MapBannerController;
}

export function wireSceneServices(
  scene: Phaser.Scene,
  deps: GameSceneDeps,
  state: GameState,
  worldToScreen: (wx: number, wy: number) => { x: number; y: number },
  returnToMenu: () => void,
): SceneServices {
  return {
    predictionService: new PredictionService(deps.collisionService, deps.inputBuffer, state),
    inputOrch: new InputOrchestrator(
      deps.inputCollector,
      deps.interactionDetector,
      scene,
      state,
      worldToScreen,
      deps.stateSync,
    ),
    interpolationService: new InterpolationService(
      deps.interpolator,
      deps.projectileInterpolator,
      deps.stateSync,
      deps.playerRenderer,
      deps.entityRenderer,
      state,
      deps.audio,
    ),
    lifecycle: new PlayerLifecycleController(
      state,
      deps.resultsScreen,
      deps.deathScreen,
      deps.spectator,
      deps.inputBuffer,
      deps.cameraService,
      deps.playerRenderer,
      deps.hud,
      deps.stateSync,
      deps.stateBridge,
      returnToMenu,
    ),
    audioTriggers: new AudioTriggerService(deps.audio, state),
    hudUpdater: new HUDUpdateService(
      deps.hud,
      deps.interactionDetector,
      state,
      deps.stateSync,
      deps.spectator,
    ),
    minimapAdapter: new MinimapDataAdapter(state, deps.stateSync, deps.mapRenderer),
    mapBanners: deps.mapBanners,
  };
}
