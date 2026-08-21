import Phaser from 'phaser';
import type { Room } from '@colyseus/sdk';
import { Connection } from './network/Connection.js';
import { StateSync } from './network/StateSync.js';
import { InputCollector } from './input/InputCollector.js';
import { EntityInterpolator } from './prediction/EntityInterpolator.js';
import { MapRenderer } from './rendering/MapRenderer.js';
import { PlayerRenderer } from './rendering/PlayerRenderer.js';
import { EntityRenderer } from './rendering/EntityRenderer.js';
import { CameraService } from './rendering/CameraService.js';
import { DamageNumberRenderer } from './rendering/DamageNumberRenderer.js';
import { ZoneRenderer } from './rendering/ZoneRenderer.js';
import { StatusEffectRenderer } from './rendering/StatusEffectRenderer.js';
import { HUDManager } from './hud/HUDManager.js';
import { AudioService } from './audio/AudioService.js';
import { ResultsScreen } from './hud/ResultsScreen.js';
import { DeathScreen } from './hud/DeathScreen.js';
import { LeaveGameMenu } from './hud/LeaveGameMenu.js';
import { PlayerStatus, PLAYER } from '@sector-battle/shared';
import { InputBuffer } from './prediction/InputBuffer.js';
import { ClientCollisionService } from './collision/ClientCollisionService.js';
import { SpectatorController } from './controllers/SpectatorController.js';
import { InteractionDetector } from './controllers/InteractionDetector.js';
import { preloadAssets, setupGameSystems, type GameSceneDeps } from './GameSceneSetup.js';
import { getAllPlayerPositions } from './GameScenePositionHelpers.js';
import { DebugBridge } from './debug/DebugBridge.js';
import { AssetManifest } from './assets/AssetManifest.js';
import { SCENE_KEYS } from './ui/transitions/TransitionConfig.js';
import { SceneNavigator } from './ui/transitions/SceneNavigator.js';
import { TelemetrySampler } from './telemetry/TelemetrySampler.js';
import { ReconciliationLog } from './debug/ReconciliationLog.js';
import { WalkDebugLog } from './debug/WalkDebugLog.js';
import type { StateBridgeResult } from './bridges/ClientStateBridge.js';
import { GameState } from './controllers/GameState.js';
import { PredictionService } from './prediction/PredictionService.js';
import { InputOrchestrator } from './input/InputOrchestrator.js';
import { InterpolationService } from './prediction/InterpolationService.js';
import { PlayerLifecycleController } from './controllers/PlayerLifecycleController.js';
import { AudioTriggerService } from './audio/AudioTriggerService.js';
import { HUDUpdateService } from './controllers/HUDUpdateService.js';
import { MinimapDataAdapter } from './controllers/MinimapDataAdapter.js';
import type { MapBannerController } from './controllers/MapBannerController.js';
import {
  installArmsDump,
  installWalkDebugLog,
  createPredictionOverlay,
  updatePredictionOverlayText,
  recordWalkDebugFrame,
} from './GameSceneDevHooks.js';
import { stepLocalPlayerInput, updateCameraFollow } from './GameSceneUpdate.js';
import { wireSceneServices } from './GameSceneServices.js';
import { updateZoneRenderer } from './rendering/ZoneTelegraph.js';
import {
  buildTelemetrySampler,
  buildDebugBridge,
  bootLightingPipeline,
  bootLightPropRenderer,
  driveSceneLighting,
  shutdownLighting,
  shutdownLightPropRenderer,
} from './GameSceneHelpers.js';

interface GameSceneData {
  mapType: 'demo' | 'seeded';
  gameRoom?: Room;
  roomName?: string;
  botFillTo?: number;
}

export class GameScene extends Phaser.Scene {
  private sceneData: GameSceneData = { mapType: 'demo' };
  private connection!: Connection;
  private stateSync!: StateSync;
  private inputCollector!: InputCollector;
  private inputBuffer!: InputBuffer;
  private interpolator!: EntityInterpolator;
  private projectileInterpolator!: EntityInterpolator;
  private mapRenderer!: MapRenderer;
  private collisionService!: ClientCollisionService;
  private playerRenderer!: PlayerRenderer;
  private entityRenderer!: EntityRenderer;
  private cameraService!: CameraService;
  private damageNumbers!: DamageNumberRenderer;
  private zoneRenderer!: ZoneRenderer;
  private statusEffects!: StatusEffectRenderer;
  private hud!: HUDManager;
  private audio!: AudioService;
  private resultsScreen!: ResultsScreen;
  private deathScreen!: DeathScreen;
  private leaveMenu!: LeaveGameMenu;
  private stateBridge!: StateBridgeResult;
  private spectator!: SpectatorController;
  private interactionDetector!: InteractionDetector;
  private debugBridge?: DebugBridge;
  /**
   * WalkStutter instrumentation (C5 diagnosis). DEV-only console logger that
   * emits one structured line per moving frame so a human can walk around at
   * their real refresh rate and save the browser logs. Auto-gated to alive +
   * moving frames; toggle with `window.__SECTO_WALK_DEBUG`.
   */
  private walkDebugLog?: WalkDebugLog;
  private telemetrySampler!: TelemetrySampler;
  private reconciliationLog!: ReconciliationLog;
  private predictionErrorText?: Phaser.GameObjects.Text;
  lighting: ReturnType<typeof bootLightingPipeline> = null;
  lightPropRenderer: ReturnType<typeof bootLightPropRenderer> | null = null; // t17
  private state!: GameState;
  private predictionService!: PredictionService;
  private inputOrch!: InputOrchestrator;
  private interpolationService!: InterpolationService;
  /**
   * Reusable scratch for the spectator camera target query (zero per-frame
   * alloc — see spectator-jitter fix, GameScene.update spectator branch).
   */
  private _specCamOut: { x: number; y: number } = { x: 0, y: 0 };
  private lifecycle!: PlayerLifecycleController;
  private audioTriggers!: AudioTriggerService;
  private hudUpdater!: HUDUpdateService;
  private minimapAdapter!: MinimapDataAdapter;
  private mapBanners?: MapBannerController;

  private readonly playerPositionsMap: Map<string, { x: number; y: number }> = new Map();
  private readonly playerPositionsPool: { x: number; y: number }[] = [];
  private readonly interpolatorOut: { x: number; y: number } = { x: 0, y: 0 };
  /**
   * NET-29: pre-allocated pool + scratch for the C5 nearby-players array fed to
   * `setNearbyPlayers`. The pool grows to the high-water mark of nearby remote
   * players; entries are reused frame-to-frame (no per-frame allocation in
   * steady state). The scratch is a single {x,y} reused across iterations of
   * the per-frame loop (each iteration consumes it synchronously before the
   * next). Ticket #37: the pool is published BY REFERENCE with an explicit
   * live count — the service iterates only [0, count), so the stale tail left
   * by earlier frames is never read and no per-frame copy is needed.
   * Ticket #42: the pool is FILLED inside getAllPlayerPositions (fused into
   * the positions-map construction pass — see GameScenePositionHelpers.ts);
   * `nearbyPlayersCount` is that helper's out-param for the live count.
   */
  private readonly nearbyPlayersPool: { x: number; y: number }[] = [];
  private readonly nearbyPlayersScratch: { x: number; y: number } = { x: 0, y: 0 };
  private readonly nearbyPlayersCount: { count: number } = { count: 0 };
  private readonly worldToScreenOut: { x: number; y: number } = { x: 0, y: 0 };
  private _startWindupCb!: (id: string, wt: number, thrown?: boolean) => void;

  constructor() {
    super('GameScene');
  }

  init(data: GameSceneData): void {
    this.sceneData = data;
    if (!this.state) {
      this.state = new GameState();
    }
    this.state.reset();
  }

  preload(): void {
    this.audio = preloadAssets(this, this.state.localPos);
  }

  async create(): Promise<void> {
    const deps: GameSceneDeps = {
      connection: this.connection,
      stateSync: this.stateSync,
      inputCollector: this.inputCollector,
      inputBuffer: (this.inputBuffer = new InputBuffer()),
      interpolator: this.interpolator,
      projectileInterpolator: this.projectileInterpolator,
      mapRenderer: this.mapRenderer,
      collisionService: this.collisionService,
      playerRenderer: this.playerRenderer,
      entityRenderer: this.entityRenderer,
      cameraService: this.cameraService,
      damageNumbers: this.damageNumbers,
      zoneRenderer: this.zoneRenderer,
      statusEffects: this.statusEffects,
      hud: this.hud,
      audio: this.audio,
      resultsScreen: this.resultsScreen,
      deathScreen: this.deathScreen,
      stateBridge: this.stateBridge,
      spectator: this.spectator,
      interactionDetector: this.interactionDetector,
      myId: this.state.myId,
      localPos: this.state.localPos,
      localVelocity: this.state.localVelocity,
      rtt: this.state.rtt,
      freezeUntil: this.state.freezeUntil,
      correctionOffset: this.state.correctionOffset,
      returnToMenu: () => this.returnToMenu(),
      onLocalKill: () => {
        this.state.killCount++;
      },
      gameState: this.state,
      lightPropRenderer: (this.lightPropRenderer = bootLightPropRenderer(this)), // t17
    };
    await setupGameSystems(
      this,
      deps,
      () => {
        this.state.mapLoaded = true;
      },
      this.sceneData,
    );
    this.connection = deps.connection;
    this.stateSync = deps.stateSync;
    this.inputCollector = deps.inputCollector;
    this.interpolator = deps.interpolator;
    this.projectileInterpolator = deps.projectileInterpolator;
    this.mapRenderer = deps.mapRenderer;
    this.collisionService = deps.collisionService;
    this.playerRenderer = deps.playerRenderer;
    this._startWindupCb = (id, wt, thrown) => this.playerRenderer.startWindup(id, wt, thrown);
    this.entityRenderer = deps.entityRenderer;
    this.cameraService = deps.cameraService;
    this.damageNumbers = deps.damageNumbers;
    this.zoneRenderer = deps.zoneRenderer;
    this.statusEffects = deps.statusEffects;
    this.hud = deps.hud;
    this.audio = deps.audio;
    this.resultsScreen = deps.resultsScreen;
    this.deathScreen = deps.deathScreen;
    this.leaveMenu = new LeaveGameMenu(this, () => this.returnToMenu());
    this.stateBridge = deps.stateBridge;
    this.spectator = deps.spectator;
    this.interactionDetector = deps.interactionDetector;
    this.state.myId = deps.myId;
    this.playerRenderer.setLocalPlayerId(deps.myId);

    // Controller wiring (moved verbatim to GameSceneServices.wireSceneServices).
    const services = wireSceneServices(
      this,
      deps,
      this.state,
      (wx, wy) => this.worldToScreen(wx, wy),
      () => this.returnToMenu(),
    );
    this.predictionService = services.predictionService;
    this.inputOrch = services.inputOrch;
    this.interpolationService = services.interpolationService;
    this.lifecycle = services.lifecycle;
    this.audioTriggers = services.audioTriggers;
    this.hudUpdater = services.hudUpdater;
    this.minimapAdapter = services.minimapAdapter;
    this.mapBanners = services.mapBanners;

    this.reconciliationLog = new ReconciliationLog();
    this.stateBridge.reconciliationLogRef.value = this.reconciliationLog;

    this.telemetrySampler = buildTelemetrySampler(
      this.state,
      this.stateSync,
      this.inputBuffer,
      this.reconciliationLog,
      this.playerRenderer,
    );

    if (window.__SECTO_DEBUG__ || import.meta.env.DEV) {
      this.debugBridge = buildDebugBridge(
        this.connection,
        this.stateSync,
        this.inputBuffer,
        this,
        this.state,
        this.reconciliationLog,
        this.telemetrySampler,
        this.playerRenderer,
        this.inputCollector,
        this.spectator,
        this.cameraService,
        () => this.returnToMenu(),
      );
      window.__SECTO_DEBUG__ = this.debugBridge;
      deps.debugBridge = this.debugBridge;
    }
    // Bug 2 (lingering arms) + WalkStutter (C5) instrumentation installs —
    // bodies moved verbatim to GameSceneDevHooks.ts.
    installArmsDump(this.playerRenderer);
    this.walkDebugLog = installWalkDebugLog(this);
    this.predictionErrorText = createPredictionOverlay(this);

    this.input.setDefaultCursor(`url('${AssetManifest.ui.cursor.target_round_a}'), crosshair`);
    SceneNavigator.requestReveal(this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.lighting = shutdownLighting(this.lighting); // t17: + prop-sprite spawner
      this.lightPropRenderer = shutdownLightPropRenderer(this.lightPropRenderer);
      this.leaveMenu?.destroy();
      this.walkDebugLog?.destroy();
    });
  }

  update(_time: number, delta: number): void {
    // Single shared frame timestamp (temporal consistency across the frame).
    const now = performance.now();
    if (this.resultsScreen) this.resultsScreen.update(delta);
    if (this.deathScreen) this.deathScreen.update(delta);
    this.leaveMenu?.handleEsc(!!(this.resultsScreen?.isVisible || this.deathScreen?.isVisible)); // create() async: undefined early

    if (now < this.state.freezeUntil.value) return;
    if (!this.state.mapLoaded || !this.connection?.isConnected) return;
    // Boot the deferred lighting pipeline (cosmetic-only; t10 placements).
    this.lighting = bootLightingPipeline(
      this,
      this.mapRenderer,
      this.lighting,
      this.state.lightPlacements,
      this.state,
      this.lightPropRenderer,
    );
    const myPlayer = this.stateSync.getPlayer(this.state.myId);
    const mySpeed = myPlayer?.speed ?? PLAYER.BASE_SPEED;
    const isDead = myPlayer
      ? (myPlayer.status & (PlayerStatus.DEAD | PlayerStatus.DYING | PlayerStatus.SPECTATING)) !== 0
      : false;
    // Clamp delta to 50ms (3 frames @60Hz): a backgrounded tab restores a huge delta.
    const dt = Math.min(delta, 50) / 1000;
    this.telemetrySampler.sampleFrame(dt);
    this.lifecycle.update(isDead, myPlayer);
    // Spectator camera now consumes the SMOOTH interpolated target position
    // (see the spectator branch below), so the soft-follow lerp stays enabled
    // — the original `!(isDead && isSpectating)` override forced lerp=1 (instant
    // snap) on top of the raw patch target, compounding the stair-step jitter.
    // `lerpEnabled` only affects the soft-follow branch (CameraService.update
    // else-branch), which is the spectator path only; the local alive player
    // uses followRigid (lerp pinned to 1, no deadzone) and is unaffected.
    this.cameraService.lerpEnabled = true;
    this.audioTriggers.updateWeaponSwitch(myPlayer?.activeSlot ?? -1);
    const paused = !!this.leaveMenu?.isVisible; // open = pause local input
    // Hoisted so the walk-debug logger can read the intended direction even on
    // dead/paused frames (where the input block below is skipped). Stays (0,0)
    // when no movement is sampled this frame.
    let frameDirX = 0;
    let frameDirY = 0;
    // Input/spectator steering (moved verbatim to
    // GameSceneUpdate.stepLocalPlayerInput — the NET-03 input seam).
    const stepped = stepLocalPlayerInput({
      inputOrch: this.inputOrch,
      pointer: this.input.activePointer,
      myPlayer,
      mySpeed,
      dt,
      deltaMs: delta,
      isDead,
      paused,
      state: this.state,
      stateSync: this.stateSync,
      mapRenderer: this.mapRenderer,
      predictionService: this.predictionService,
      playerRenderer: this.playerRenderer,
      audioTriggers: this.audioTriggers,
      connection: this.connection,
      telemetrySampler: this.telemetrySampler,
      spectator: this.spectator,
      worldToScreen: (wx, wy) => this.worldToScreen(wx, wy),
      startWindup: this._startWindupCb,
    });
    frameDirX = stepped.frameDirX;
    frameDirY = stepped.frameDirY;

    this.interpolationService.update(now);

    const visual = this.predictionService.getVisualPosition();

    // Camera follow (moved verbatim to GameSceneUpdate.updateCameraFollow —
    // the full spectator-jitter rationale lives in its doc comment).
    updateCameraFollow(
      isDead,
      this.spectator,
      this.playerRenderer,
      this.cameraService,
      this.state,
      visual,
      this._specCamOut,
    );

    if (!isDead) {
      const pointer = this.input.activePointer;
      const visualScreen = this.worldToScreen(visual.x, visual.y);
      const mouseAngle = Math.atan2(pointer.y - visualScreen.y, pointer.x - visualScreen.x);
      this.playerRenderer.updateFacingAngle(this.state.myId, mouseAngle);
    }

    this.playerRenderer.update(delta);
    this.entityRenderer.update(delta);
    this.damageNumbers.update(delta);
    const allPlayerPositions = this.getAllPlayerPositions();
    this.statusEffects.updatePositions(allPlayerPositions);
    this.entityRenderer.updateFireDotPositions(allPlayerPositions);
    // C5: feed nearby remote-player centers to the collision prediction so it
    // resolves player-vs-player separation (matching the server's
    // resolvePlayerCollision). Without this the client predicts THROUGH other
    // players while the server shoves → reconciliation corrections fire every
    // patch → the visible walk stutter. Excludes the local player; limited to
    // within 320px (only nearby players can overlap the 96px hitbox).
    //
    // NET-29 (ADR-0020 addendum): the POSITION SOURCE for each remote is the
    // LATEST RECEIVED authoritative snapshot (pre-interpolation), NOT the
    // renderer's smoothed/extrapolated view from `allPlayerPositions`. The
    // display path (statusEffects / entityRenderer fire-dot positions above)
    // still consumes the interpolated `allPlayerPositions`; only the collision
    // prediction gets the less-lagged latest-received position. This decouples
    // COLLISION PREDICTION (use the most authoritative position the client has,
    // matching what the server consults) from VISUAL INTERPOLATION (stay smooth
    // for display). The renderer still interpolates for drawing. The prior
    // interpolated-remote lag (~BASE_SPEED/60 per patch of smoothing) was
    // driving 2–4 reconciliation corrections per transient oncoming overlap at
    // localhost thresholds — defense-in-depth closes that seam. See
    // `docs/wayfinder/findings/NET-FINDINGS-pvp-collision.md`.
    //
    // Ticket #42: the nearby set is now BUILT INSIDE getAllPlayerPositions —
    // fused into the same single pass that constructs the positions map. The
    // former third full iteration over the map (with its per-remote
    // `stateSync.getPlayer(pid)` dead-status lookups) is gone; the map-value IS
    // that lookup's result, so the status read is part of the iteration.
    // Membership, predicate, and entry order are unchanged — the fused loop
    // iterates the same players map in the same order (see
    // GameScenePositionHelpers.ts and its oracle battery test).
    //
    // Ticket #37: publish the POOL + live count (view semantics) — no
    // per-frame `.slice(0, count)` copy. The service reads only [0, count) and
    // the fused write pass + this publish are one synchronous update() block,
    // so prediction/reconciliation can never see a half-rewritten pool.
    this.collisionService.setNearbyPlayers(this.nearbyPlayersPool, this.nearbyPlayersCount.count);
    this.cameraService.update(delta);

    // WalkStutter instrumentation (C5) — the per-frame record (body moved
    // verbatim to GameSceneDevHooks.recordWalkDebugFrame; the logger emits the
    // PREVIOUS frame on the next call once cam.scrollX/Y reflects that frame's
    // render; one [WALK]/[STUTTER] line per alive+moving frame, auto-suppressed
    // when idle).
    recordWalkDebugFrame(
      this,
      this.walkDebugLog,
      this.cameraService,
      this.predictionService,
      this.state,
      myPlayer,
      allPlayerPositions,
      visual,
      frameDirX,
      frameDirY,
      isDead,
      delta,
    );

    this.hudUpdater.update(delta, isDead);

    updatePredictionOverlayText(this.predictionErrorText, this.telemetrySampler);

    this.hud.updateMinimap(this.minimapAdapter.assemble());
    // Ticket 03 — sector-crossing detection (enter-banner), after the pos write pass.
    this.mapBanners?.update(now, this.state.localPos.x, this.state.localPos.y);
    updateZoneRenderer(this.zoneRenderer, this.stateSync, this.mapRenderer, this.state.localPos);
    driveSceneLighting(
      this.lighting,
      this.state,
      this.stateSync,
      this.interpolator,
      this.projectileInterpolator,
      this.predictionService,
      visual.x,
      visual.y,
      now,
    );
  }

  private getAllPlayerPositions(): Map<string, { x: number; y: number }> {
    return getAllPlayerPositions({
      state: this.state,
      stateSync: this.stateSync,
      interpolator: this.interpolator,
      playerPositionsMap: this.playerPositionsMap,
      playerPositionsPool: this.playerPositionsPool,
      interpolatorOut: this.interpolatorOut,
      nearbyPool: this.nearbyPlayersPool,
      nearbyScratch: this.nearbyPlayersScratch,
      nearbyCountOut: this.nearbyPlayersCount,
    });
  }

  private worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const cam = this.cameras.main;
    this.worldToScreenOut.x = (worldX - cam.scrollX - cam.width / 2) * cam.zoom + cam.width / 2;
    this.worldToScreenOut.y = (worldY - cam.scrollY - cam.height / 2) * cam.zoom + cam.height / 2;
    return this.worldToScreenOut;
  }

  getVisualPosition(): { x: number; y: number } {
    return this.predictionService.getVisualPosition();
  }

  returnToMenu(): void {
    if (this.state._returningToMenu) return;
    this.state._returningToMenu = true;
    this.connection.disconnect();
    new SceneNavigator(this).transitionTo(SCENE_KEYS.MAIN_MENU, {}, [SCENE_KEYS.GAME]);
  }
}
