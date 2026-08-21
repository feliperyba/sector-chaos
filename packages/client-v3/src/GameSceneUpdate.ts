/**
 * GameSceneUpdate — per-frame steering sections extracted from
 * GameScene.update() (max-lines cap). Mechanical extraction: bodies verbatim,
 * `this.X` → parameter references (the GameScenePositionHelpers pattern).
 */
import { PlayerStatus } from '@sector-battle/shared';
import type { PlayerState } from './types.js';
import type { GameState } from './controllers/GameState.js';
import type { StateSync } from './network/StateSync.js';
import type { MapRenderer } from './rendering/MapRenderer.js';
import type { PlayerRenderer } from './rendering/PlayerRenderer.js';
import type { PredictionService } from './prediction/PredictionService.js';
import type { InputOrchestrator } from './input/InputOrchestrator.js';
import type { AudioTriggerService } from './audio/AudioTriggerService.js';
import type { Connection } from './network/Connection.js';
import type { TelemetrySampler } from './telemetry/TelemetrySampler.js';
import type { SpectatorController } from './controllers/SpectatorController.js';
import type { CameraService } from './rendering/CameraService.js';

export interface LocalInputDeps {
  inputOrch: InputOrchestrator;
  pointer: Phaser.Input.Pointer;
  myPlayer: PlayerState | undefined;
  mySpeed: number;
  dt: number;
  deltaMs: number;
  isDead: boolean;
  paused: boolean;
  state: GameState;
  stateSync: StateSync;
  mapRenderer: MapRenderer;
  predictionService: PredictionService;
  playerRenderer: PlayerRenderer;
  audioTriggers: AudioTriggerService;
  connection: Connection;
  telemetrySampler: TelemetrySampler;
  spectator: SpectatorController;
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  startWindup: (id: string, wt: number, thrown?: boolean) => void;
}

/**
 * The local-player input/spectator steering branch pair from
 * GameScene.update(). Returns the frame's intended direction (post
 * dash-override) so the walk-debug logger can read it on dead/paused frames
 * where this block is skipped — (0,0) in that case, matching the original
 * hoisted `let frameDirX = 0; let frameDirY = 0;` declarations.
 */
export function stepLocalPlayerInput(deps: LocalInputDeps): {
  frameDirX: number;
  frameDirY: number;
} {
  const {
    inputOrch,
    pointer,
    myPlayer,
    mySpeed,
    dt,
    deltaMs,
    isDead,
    paused,
    state,
    stateSync,
    mapRenderer,
    predictionService,
    playerRenderer,
    audioTriggers,
    connection,
    telemetrySampler,
    spectator,
    worldToScreen,
    startWindup,
  } = deps;
  let frameDirX = 0;
  let frameDirY = 0;
  if (!isDead && !paused) {
    // NET-03 — input seam split: the orchestrator samples the live
    // movement direction + runs edge detection EVERY render frame, and
    // builds the network InputFrame at the 16ms send boundary. The
    // prediction consumes (dirX, dirY, edges) every frame (no more
    // step(null) stale-coasting ghost); a record is pushed only when
    // sendFrame is non-null (server-acked seq identity unchanged).
    const perFrame = inputOrch.collect(myPlayer?.activeSlot ?? 0);

    const hasDash = perFrame.edges.includes('DASH');
    const isStaggered = myPlayer ? (myPlayer.status & PlayerStatus.STAGGERED) !== 0 : false;

    // Dash direction override: when the DASH edge fires while the player is
    // stationary, derive the dash direction from the pointer. The override
    // applies to BOTH the per-frame direction (fed to the prediction so the
    // dash starts on the detection frame with the right heading) AND the
    // built sendFrame (so the server receives the pointer-derived heading
    // — preserves the legacy wire shape). The dash starts on the detection
    // frame even when that frame is a throttle frame (no send).
    let dirX = perFrame.dirX;
    let dirY = perFrame.dirY;
    if (hasDash) {
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len === 0) {
        const dashVisual = predictionService.getVisualPosition();
        const dashScreen = worldToScreen(dashVisual.x, dashVisual.y);
        const dashAngle = Math.atan2(pointer.y - dashScreen.y, pointer.x - dashScreen.x);
        dirX = Math.cos(dashAngle);
        dirY = Math.sin(dashAngle);
        if (perFrame.sendFrame) {
          perFrame.sendFrame.movementX = dirX;
          perFrame.sendFrame.movementY = dirY;
        }
      }
      playerRenderer.triggerDash(state.myId);
      audioTriggers.triggerDash();
    }

    // Capture the final intended direction (post dash-override) for the
    // walk-debug logger.
    frameDirX = dirX;
    frameDirY = dirY;

    predictionService.step(
      dirX,
      dirY,
      dt,
      mySpeed,
      isStaggered,
      perFrame.edges,
      perFrame.sendFrame,
    );

    // Footsteps driven by the LIVE per-frame direction (NET-03): more
    // responsive than the legacy throttled-frame check.
    audioTriggers.updateFootsteps(dirX, dirY, deltaMs);

    if (perFrame.sendFrame && myPlayer) {
      const wp = myPlayer.weapons?.[myPlayer.activeSlot ?? 0];
      audioTriggers.checkWindup(perFrame.sendFrame, wp?.weaponType ?? 0, state.myId, startWindup);
    }

    if (perFrame.sendFrame) {
      connection.sendInput(perFrame.sendFrame);
      telemetrySampler.recordInput();
    }
  } else if (spectator.isSpectating && !paused) {
    const result = spectator.update(dt, state.localPos.x, state.localPos.y, stateSync, mapRenderer);
    state.applySpectatorPosition(result.x, result.y);
  }
  return { frameDirX, frameDirY };
}

/**
 * The camera-follow branch from GameScene.update().
 *
 * When spectating, the camera follows the spectated target's INTERPOLATED
 * render position — the SAME smooth stream the sprite renders at (written by
 * interpolationService.update above into playerRenderer.targetX/Y). Feeding
 * the raw patch position (stateSync.getPlayer().x/y, which only changes at
 * PATCH_RATE) made the camera stair-step every patch while the sprite glided
 * on the 67 ms interpolator → heavy spectator jitter (see
 * spectator-camera-target.diag.test.ts). Free-cam mode (Space) drives its
 * own position via WASD; a freshly-switched target with no visual yet falls
 * back to the raw position for one frame.
 *
 * `specCamOut` is the scene's reusable scratch ({x,y} — zero per-frame alloc).
 */
export function updateCameraFollow(
  isDead: boolean,
  spectator: SpectatorController,
  playerRenderer: PlayerRenderer,
  cameraService: CameraService,
  state: GameState,
  visual: { x: number; y: number },
  specCamOut: { x: number; y: number },
): void {
  if (isDead && spectator.isSpectating) {
    const specTarget = spectator.spectateTarget;
    if (
      !spectator.freeCamera &&
      specTarget &&
      playerRenderer.getRenderPosition(specTarget, specCamOut)
    ) {
      cameraService.follow(specCamOut.x, specCamOut.y);
    } else {
      cameraService.follow(state.localPos.x, state.localPos.y);
    }
  } else {
    playerRenderer.snapPosition(state.myId, visual.x, visual.y);
    // C5: rigid center-on-visual for the local player. Live capture (steady
    // ~44fps after the logger fix) confirmed the walk stutter is the deadzone
    // + lerp LIMIT CYCLE — the player rides the deadzone edge and screen-X
    // oscillates backward (ΔscrX −4..−10px) every few frames at a STEADY dt
    // (not framerate spikes, not PvP, not destructibles). Rigid follow (no
    // deadzone, lerp=1) pins the player dead-center and eliminates the cycle.
    // It was briefly reverted when the per-frame console.log was halving the
    // framerate (variable → rigid looked sharp); with the logger fixed the
    // framerate is steady and rigid is smooth. Sprite stays hard-snapped to
    // `visual` (ADR-0005).
    cameraService.followRigid(visual.x, visual.y);
  }
}
