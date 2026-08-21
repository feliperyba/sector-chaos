import Phaser from 'phaser';
import type { Room } from '@colyseus/sdk';
import { Connection, type ConnectionOptions } from './network/Connection.js';
import { StateSync } from './network/StateSync.js';
import { EventRouter } from './network/EventRouter.js';
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
import { loadAtlases } from './assets/AssetManifest.js';
import type { LightPlacementTiled } from './rendering/lighting/LightPacker.js';
import type { MapData } from './types.js';
import { createStateBridge, type StateBridgeResult } from './bridges/ClientStateBridge.js';
import { createEventBridge } from './bridges/event-handlers/index.js';
import { Reconciler } from './prediction/Reconciler.js';
import { ClientCollisionService } from './collision/ClientCollisionService.js';
import { SpectatorController, type SpecKeys } from './controllers/SpectatorController.js';
import { InteractionDetector } from './controllers/InteractionDetector.js';
import type { GameState } from './controllers/GameState.js';
import { MapBannerController, poiNameAt } from './controllers/MapBannerController.js';
import { setSectorWallTintLookup } from './rendering/EntityRendererWorld.js';
import { cullDestroyedLightPlacements } from './rendering/lighting/LightPlacementReconcile.js';
import { BeaconMotesVFX } from './rendering/vfx/BeaconMotesVFX.js';
import {
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  wallTintAt,
  logger,
  NetworkChannel,
} from '@sector-battle/shared';
import type {
  MatchCancelledMessage,
  PlayerResyncMessage,
  ReconnectAsSpectatorMessage,
} from '@sector-battle/shared';
import type { ReconciliationLog } from './debug/ReconciliationLog.js';

export interface GameSceneDeps {
  connection: Connection;
  stateSync: StateSync;
  inputCollector: InputCollector;
  inputBuffer: import('./prediction/InputBuffer.js').InputBuffer;
  interpolator: EntityInterpolator;
  projectileInterpolator: EntityInterpolator;
  mapRenderer: MapRenderer;
  collisionService: ClientCollisionService;
  playerRenderer: PlayerRenderer;
  entityRenderer: EntityRenderer;
  cameraService: CameraService;
  damageNumbers: DamageNumberRenderer;
  zoneRenderer: ZoneRenderer;
  statusEffects: StatusEffectRenderer;
  hud: HUDManager;
  audio: AudioService;
  resultsScreen: ResultsScreen;
  deathScreen: DeathScreen;
  stateBridge: StateBridgeResult;
  spectator: SpectatorController;
  interactionDetector: InteractionDetector;
  myId: string;
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  rtt: { value: number };
  freezeUntil: { value: number };
  correctionOffset: { x: number; y: number };
  returnToMenu: () => void;
  onLocalKill?: () => void;
  gameState: GameState;
  /**
   * Map-redesign ticket 03 — the transient naming lines (sector enter-banner
   * + map designation). Created early in `setupGameSystems` (before the
   * event bridge, which receives its `showDesignation` callback) and reused
   * by GameScene.update for crossing detection. Optional so test harnesses
   * that build a partial deps bag don't need to supply it.
   */
  mapBanners?: MapBannerController;
  /**
   * Ticket 17 — the visible prop-sprite spawner. Fed placements in onMapData
   * (so the fixtures appear with the lit world on first render). Owned by
   * GameScene (constructed in create(), torn down on SHUTDOWN). Optional so
   * test harnesses that build a partial deps bag don't need to supply it.
   */
  lightPropRenderer?: { spawn: (p: ReadonlyArray<LightPlacementTiled>, tileSize: number) => void };
  /**
   * Map-polish ticket 02 — the beacon orbiting motes (decorative halo around
   * every hero + fortress beacon crystal). Constructed in setupGameSystems,
   * fed anchors in the onMapData handler (next to the light-prop wiring, from
   * the same synced MapData), self-driven from the scene UPDATE loop, and
   * destroyed on scene shutdown. Optional so test harnesses that build a
   * partial deps bag don't need to supply it.
   */
  beaconMotes?: BeaconMotesVFX;
  /** Optional debug bridge — destroyed on shutdown to avoid leaking its
   * scene-event listeners across scene transitions. Set after creation. */
  debugBridge?: { destroy: () => void };
}

export function preloadAssets(
  scene: Phaser.Scene,
  localPos: { x: number; y: number },
): AudioService {
  scene.load.on('loaderror', (file: Phaser.Loader.File) => {
    logger.warn(`Asset load failed: ${file?.key ?? 'unknown'}`);
  });
  loadAtlases(scene);
  const audio = new AudioService(scene, localPos);
  audio.loadAll();
  return audio;
}

export async function setupGameSystems(
  scene: Phaser.Scene,
  deps: GameSceneDeps,
  onMapLoaded: () => void,
  sceneData?: { mapType: string; gameRoom?: Room; botFillTo?: number; roomName?: string },
): Promise<void> {
  deps.inputCollector = new InputCollector();
  deps.inputCollector.init(scene.input.keyboard!, scene.input);
  const kb = scene.input.keyboard!;
  const specKeys: SpecKeys = {
    Q: kb.addKey('Q'),
    E: kb.addKey('E'),
    Space: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    Esc: kb.addKey('ESC'),
    W: kb.addKey('W'),
    A: kb.addKey('A'),
    S: kb.addKey('S'),
    D: kb.addKey('D'),
  };
  deps.spectator = new SpectatorController(specKeys);
  deps.interactionDetector = new InteractionDetector();
  deps.mapRenderer = new MapRenderer(scene);
  deps.collisionService = new ClientCollisionService(deps.mapRenderer);
  const collisionOut = { x: 0, y: 0 }; // ticket 21 pooled receptacle — see resolveCollisionInto
  deps.interpolator = new EntityInterpolator();
  deps.projectileInterpolator = new EntityInterpolator();
  deps.playerRenderer = new PlayerRenderer(scene);
  // Pose containment: the shared animation sim clamps hands/blade against
  // solid geometry. isWalkable consults the SAT collider metadata first
  // (same shapes movement uses) and falls back to the tile grid — mirrors
  // the server's CollisionService.isPointBlocked.
  deps.playerRenderer.setWorldBlockedQuery((x, y) => deps.mapRenderer.isPointBlocked(x, y));
  deps.entityRenderer = new EntityRenderer(scene);
  deps.cameraService = new CameraService(scene);
  deps.damageNumbers = new DamageNumberRenderer(scene);
  deps.playerRenderer.setHealCallback((key, amount) => {
    const p = deps.stateSync.getPlayer(key);
    if (p) deps.damageNumbers.spawn(p.x, p.y, amount, true);
  });
  deps.zoneRenderer = new ZoneRenderer(scene);
  deps.statusEffects = new StatusEffectRenderer(scene);
  deps.hud = new HUDManager(scene);
  deps.hud.setStatusText('Connecting...');

  const myIdRef = { value: deps.myId };
  const stateSyncRef = { value: null as StateSync | null };
  const reconciliationLogRef = { value: undefined as ReconciliationLog | undefined };

  deps.stateBridge = createStateBridge({
    myId: myIdRef,
    localPos: deps.localPos,
    localVelocity: deps.localVelocity,
    rtt: deps.rtt,
    playerRenderer: deps.playerRenderer,
    statusEffects: deps.statusEffects,
    interpolator: deps.interpolator,
    projectileInterpolator: deps.projectileInterpolator,
    entityRenderer: deps.entityRenderer,
    mapRenderer: deps.mapRenderer,
    hud: deps.hud,
    audio: deps.audio,
    cameraService: deps.cameraService,
    stateSync: stateSyncRef,
    inputBuffer: deps.inputBuffer,
    reconciler: new Reconciler(deps.inputBuffer, (x, y, halfW, halfH) =>
      deps.collisionService.resolveCollisionInto(x, y, halfW, halfH, collisionOut),
    ),
    reconciliationLog: reconciliationLogRef,
    correctionOffset: deps.correctionOffset,
    isSpectating: {
      get value() {
        return deps.spectator.isSpectating;
      },
    },
    gameState: deps.gameState,
  });

  deps.stateSync = new StateSync(deps.stateBridge.callbacks);
  stateSyncRef.value = deps.stateSync;

  const resultsScreenRef = { value: null as ResultsScreen | null };

  // Map-redesign ticket 03 — the transient naming lines. Created BEFORE the
  // event bridge so match-start can show the designation the moment the
  // countdown fires (and the kill-feed handler can resolve location tags).
  deps.mapBanners = new MapBannerController(scene, deps.gameState);

  // Map-polish ticket 02 — the beacon orbiting motes. Constructed empty (no
  // anchors until mapData lands); self-driven from the scene UPDATE loop and
  // destroyed on scene shutdown (see BeaconMotesVFX's lifecycle note).
  deps.beaconMotes = new BeaconMotesVFX(scene);

  const eventCallbacks = createEventBridge({
    myId: myIdRef,
    localPos: deps.localPos,
    playerRenderer: deps.playerRenderer,
    statusEffects: deps.statusEffects,
    entityRenderer: deps.entityRenderer,
    damageNumbers: deps.damageNumbers,
    mapRenderer: deps.mapRenderer,
    cameraService: deps.cameraService,
    audio: deps.audio,
    hud: deps.hud,
    stateSync: deps.stateSync,
    scene,
    playerNames: deps.stateBridge.playerNames,
    resultsScreen: resultsScreenRef,
    spectator: deps.spectator,
    freezeUntil: deps.freezeUntil,
    returnToMenu: deps.returnToMenu,
    onLocalKill: deps.onLocalKill,
    // Ticket 03: naming surfaces — designation line at match start, POI
    // location tag for kill-feed entries, and the local-damage timestamp
    // that suppresses the enter-banner during combat (banner discipline).
    showDesignation: (text: string | null | undefined) => deps.mapBanners?.showDesignation(text),
    locatePoi: (x: number, y: number) =>
      poiNameAt(deps.gameState.poiNames, deps.gameState.mapWorldW, x, y),
    mapDesignation: {
      get value(): string | null {
        return deps.gameState.designation;
      },
    },
    onLocalDamaged: () => {
      deps.gameState.lastLocalDamageAt = performance.now();
    },
    // Ticket 11 — explosion-light registry: the explosion handler registers a
    // brief hot flash on every blast; the populator collects the live lights.
    explosionLights: deps.gameState.explosionLights,
    // Ticket 09 / A3 — impact-light registry: the damage handler registers a
    // brief flash on PlayerDamaged (melee hit) / ShieldBlocked / WeaponBroken,
    // the attack handler registers on ProjectileDestroyed (arrow impact); the
    // populator collects the live lights each frame (mirroring explosion lights).
    impactLights: deps.gameState.impactLights,
  });

  const eventRouter = new EventRouter(eventCallbacks);

  try {
    deps.connection = new Connection();

    // Pre-register ALL message handlers BEFORE connecting so the server's
    // onJoin messages (mapData, early events) are never dropped by Colyseus.
    deps.connection.onMapData((data: MapData) => {
      logger.info(
        `Map data received: ${data.width}x${data.height} tiles=${data.tileSize} gridRows=${data.grid.length} atlas=${!!data.atlas} visualLayers=${data.visualLayers?.length ?? 0}`,
      );
      // Ticket 09: receive the deterministic light-prop placements and log
      // them (count + a small sample). Ticket 08: LATE-JOIN/SPECTATOR
      // RECONCILIATION — cull placements whose backing entity was destroyed
      // before we joined, against the LIVE destructibles schema state (safe:
      // the Colyseus join ordering delivers the full state snapshot before
      // this mapData reply). Pure + server-authoritative — never local
      // history. Ticket 10: stash the culled list on GameState so the
      // lazily-booted lighting pipeline (boots on the first update after
      // mapLoaded) can pick them up via bootLightingPipeline → setPlacements.
      const rawLights = data.lightPlacements ?? [];
      const lights = cullDestroyedLightPlacements(
        rawLights,
        deps.stateSync.getDestructibles(),
        data.tileSize,
      );
      deps.gameState.lightPlacements = lights;
      logger.info(
        `lightPlacements received: count=${lights.length}` +
          (rawLights.length !== lights.length
            ? ` (culled ${rawLights.length - lights.length} destroyed before join)`
            : '') +
          (lights.length > 0 ? ` sample=${JSON.stringify(lights.slice(0, 3))}` : ''),
      );
      // Map-redesign ticket 02: server-authored loot-tier pyramid + per-match
      // hot sector ride the same one-shot `mapData` message. Stashed on
      // GameState for the minimap (tier tint + hot-sector mark). Absent on
      // demo-TMX maps — null keeps the minimap tier-free there.
      deps.gameState.sectorTiers = data.sectorTiers ?? null;
      deps.gameState.hotSector = data.hotSector ?? null;
      logger.info(
        `sectorTiers received: ${data.sectorTiers ? `${data.sectorTiers.length}x${data.sectorTiers[0]?.length ?? 0}` : 'none'}` +
          `, hotSector=${data.hotSector ? `(${data.hotSector.row},${data.hotSector.col})` : 'none'}`,
      );
      // Map-redesign ticket 03: server-authored POI names + map designation
      // (DEC-001/010) ride the same one-shot message. Stashed on GameState
      // for the naming surfaces (minimap labels, enter-banner, kill-feed
      // location tags, match-start/results designation). `mapWorldW` (px)
      // maps world positions → sector indices for those lookups. Absent on
      // demo-TMX maps — the naming surfaces stay silent there.
      deps.gameState.poiNames = data.poiNames ?? null;
      deps.gameState.macroPoiNames = data.macroPoiNames ?? null;
      deps.gameState.designation = data.designation ?? null;
      deps.gameState.mapWorldW = data.width * data.tileSize;
      // Map-redesign ticket 04: server-authored landmarks (hero composites +
      // junction minors). Stashed on GameState for the minimap icons; the
      // composite bake happens inside mapRenderer.render(data) below (it
      // reads data.landmarks directly and draws into the decoration RT).
      // Absent on demo-TMX maps — null keeps the minimap icon-free there.
      deps.gameState.landmarks = data.landmarks ?? null;
      // Map-redesign ticket 07: server-authored sector type grid → stash for
      // live-entity district tints + inject the lookup used by the world
      // entity renderer (null on demo-TMX maps keeps the global-grey
      // fallback). The static bake reads data.sectorTypes directly inside
      // mapRenderer.render below.
      deps.gameState.sectorTypes = data.sectorTypes ?? null;
      setSectorWallTintLookup(
        data.sectorTypes
          ? (worldX: number, worldY: number) =>
              wallTintAt(
                data.sectorTypes!,
                Math.floor(worldX / TILE_PIXEL_SIZE),
                Math.floor(worldY / TILE_PIXEL_SIZE),
                SECTOR_TILE_SIZE,
              )
          : null,
      );
      logger.info(
        `landmarks received: ` +
          (data.landmarks
            ? `${data.landmarks.heroes.flat().length} heroes, ${data.landmarks.minors.length} minors`
            : 'none'),
      );
      // Ticket 03 — if match-start (countdown) fired before mapData arrived,
      // the designation line is pending; flush it now that the data landed.
      deps.mapBanners?.notifyMapData(deps.gameState.designation);
      logger.info(
        `poiNames received: ${data.poiNames ? `${data.poiNames.length}x${data.poiNames[0]?.length ?? 0}` : 'none'}` +
          `, designation=${data.designation ?? 'none'}`,
      );
      deps.mapRenderer.render(data);
      // Ticket 17 — spawn the visible prop sprites (torches/candles/campfires/
      // biome-glow) at every motivated placement so the deferred pipeline
      // lights real fixtures, not floating disks. The renderer is a no-op for
      // scatter placements (light-only) + barrel-fire (no fixture). The
      // fixtures render into the albedo RT (world-depth) so the deferred
      // pipeline lights them naturally (gotcha #5 — they're INCLUDED in the
      // albedo capture; the pipeline's RT shaders stay EXCLUDED).
      const tileSize = data.tileSize;
      deps.lightPropRenderer?.spawn(lights, tileSize);
      // Map-polish ticket 02 — feed the beacon motes: hero anchors from the
      // synced MapData.landmarks (the same data the composite bake consumes),
      // the fortress anchor from the synced beacon light placements (the
      // client mapData message carries the fortress only via its
      // kind:'beacon' placement). Per-mote parameters derive from pure
      // coordinate hashes of the anchor tiles, so every client draws the
      // identical halo. Minor landmark markers are excluded (junction
      // markers, not destinations).
      deps.beaconMotes?.setAnchors(data.landmarks, lights, tileSize);
      deps.entityRenderer.setMapRenderer(deps.mapRenderer);
      onMapLoaded();
      if (deps.localPos.x !== 0 || deps.localPos.y !== 0) {
        deps.cameraService.snapTo(deps.localPos.x, deps.localPos.y);
      }
      deps.hud.setStatusText('Waiting for match...', true);
      scene.time.delayedCall(2000, () => deps.hud.setStatusText('', false));
      scene.events.emit('game_started');
    });

    eventRouter.register(deps.connection);

    deps.connection.onMessage(NetworkChannel.AFK_WARNING, () => {
      deps.hud.setStatusText('AFK WARNING! Move or be replaced by bot!', true);
      scene.time.delayedCall(5000, () => deps.hud.setStatusText('', false));
    });

    deps.connection.onMessage(
      NetworkChannel.RECONNECT_AS_SPECTATOR,
      (data: ReconnectAsSpectatorMessage) => {
        deps.hud.setStatusText('Reconnected as spectator', true);
        deps.spectator.isSpectating = true;
        deps.gameState.wasDead = true;
        deps.spectator.buildSpectatedPlayers(deps.stateSync);
        // Same main-HUD hide as the death→spectate path (findings B2 §7.5): a
        // reconnecting spectator must not see the dead local player's stale
        // personal readout. HUDUpdateService will now drive the spectator HUD.
        deps.hud.setSpectating(true);
        if (data.reason) logger.info('Reconnect reason:', data.reason);
      },
    );

    deps.connection.onMessage(NetworkChannel.PLAYER_RESYNC, (data: PlayerResyncMessage) => {
      logger.info('playerResync received:', data);
      if (data.x != null && data.y != null) {
        deps.gameState.applyResyncPosition(data.x, data.y);
        deps.cameraService.snapTo(deps.localPos.x, deps.localPos.y);
        deps.playerRenderer.updatePosition(deps.myId, deps.localPos.x, deps.localPos.y);
      }
    });

    deps.connection.onMessage(NetworkChannel.MATCH_CANCELLED, (data: MatchCancelledMessage) => {
      deps.hud.setStatusText('MATCH CANCELLED: ' + (data.reason ?? 'unknown'), true);
      scene.time.delayedCall(5000, () => deps.hud.setStatusText('Returning to lobby...', true));
    });

    // Now connect — all buffered handlers are flushed inside registerRoomHandlers().
    if (sceneData?.gameRoom) {
      // Pass the message buffer created by MatchmakingScene so messages that
      // arrived during the transition fade are replayed to the handlers above.
      deps.connection.connectWithRoom(
        sceneData.gameRoom,
        (sceneData as { messageBuffer?: import('./network/MessageBuffer.js').MessageBuffer })
          .messageBuffer ?? null,
      );
    } else {
      const opts: ConnectionOptions = {
        mapType: (sceneData?.mapType as 'demo' | 'seeded') ?? 'demo',
        botFillTo: sceneData?.botFillTo,
        roomName: sceneData?.roomName,
      };
      await deps.connection.connect(opts);
    }

    // All message handlers (EventRouter + onMapData + scene-specific onMessage
    // calls above) are now registered and any buffered messages replayed. Stop
    // the transition-window buffer so genuinely unregistered messages warn
    // normally going forward — that's a real signal we'd want to see.
    deps.connection.detachMessageBuffer();
    deps.myId = deps.connection.sessionId;
    myIdRef.value = deps.myId;
    deps.resultsScreen = new ResultsScreen(scene, deps.myId);
    resultsScreenRef.value = deps.resultsScreen;
    deps.deathScreen = new DeathScreen(scene, deps.myId);

    // State-sync subscription touches many Colyseus schema callbacks and is the
    // most drift-prone step here. Isolate it so a failure logs but cannot abort
    // the rest of setup.
    try {
      deps.stateSync.subscribe(deps.connection.room);
    } catch (subErr) {
      logger.error(
        'StateSync.subscribe failed — continuing setup so the map and events still load:',
        subErr,
      );
    }

    // Request map data from server. The server no longer auto-pushes on join
    // to avoid the Colyseus "onMessage not registered" warning (the handler
    // can't be registered until after the room exists). By this point all
    // handlers are live, so the response is caught cleanly.
    deps.connection.room.send('requestMapData');

    const zoneState = deps.connection.room.state.zone;
    if (zoneState) {
      const syncZone = () => {
        deps.zoneRenderer.setWorldBounds(
          deps.mapRenderer.getMapWidth?.() ?? 6400,
          deps.mapRenderer.getMapHeight?.() ?? 6400,
        );
        deps.zoneRenderer.update(
          zoneState.centerX,
          zoneState.centerY,
          zoneState.currentRadius,
          zoneState.targetCenterX,
          zoneState.targetCenterY,
          zoneState.targetRadius,
        );
      };
      zoneState.onChange = () => syncZone();
      if (zoneState.currentRadius > 0) syncZone();
    }

    deps.hud.setStatusText('Connected! Loading map...');
    deps.audio.playMusic('lobby');
    logger.info(`Connected as ${deps.myId}`);
  } catch (e) {
    logger.error('Connection failed:', e);
    deps.hud.setStatusText('Connection failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  scene.events.on('shutdown', () => {
    deps.playerRenderer.destroy();
    deps.entityRenderer.destroy();
    deps.zoneRenderer.clear();
    deps.hud.destroy();
    deps.statusEffects.destroy();
    deps.resultsScreen.destroy();
    deps.deathScreen.destroy();
    deps.mapBanners?.destroy();
    deps.beaconMotes?.destroy();
    deps.connection?.disconnect();
    deps.audio.destroy();
    deps.debugBridge?.destroy();
  });
}
