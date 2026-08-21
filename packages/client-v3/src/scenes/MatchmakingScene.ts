import Phaser from 'phaser';
import { AssetManifest, loadAtlases } from '../assets/AssetManifest.js';
import { getSharedAudioService, SharedAudioService } from '../audio/SharedAudioService.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';
import { SceneNavigator } from '../ui/transitions/SceneNavigator.js';
import { SCENE_KEYS } from '../ui/transitions/TransitionConfig.js';
import { netLogger as logger } from '@sector-battle/shared';
import { LobbyConnection } from './LobbyConnection.js';
import type { LobbyPlayerInfo, LobbySnapshot, MatchStartingPayload } from './LobbyConnection.js';
import { MatchmakingUI } from './MatchmakingUI.js';
import type { MatchmakingUIRefs } from './MatchmakingUI.js';
import { ErrorOverlay } from './ErrorOverlay.js';
import { MessageBuffer } from '../network/MessageBuffer.js';

// Shape of the data passed to GameScene via the transition.
export interface GameSceneTransitionData {
  mapType: 'demo' | 'seeded';
  gameRoom?: import('@colyseus/sdk').Room;
  messageBuffer?: MessageBuffer;
  botFillTo?: number;
  roomName?: string;
}

// ---------------------------------------------------------------------------
// MatchmakingScene — thin coordinator wiring LobbyConnection + UI widgets
// ---------------------------------------------------------------------------

export class MatchmakingScene extends Phaser.Scene {
  private audio!: SharedAudioService;
  private transitioning = false;
  private tweenTracker!: TweenTracker;
  private navigator!: SceneNavigator;

  private lobby!: LobbyConnection;
  private ui!: MatchmakingUIRefs;
  private errorOverlay!: ErrorOverlay;

  /**
   * MessageBuffer created when joinById resolves, adopted by GameSceneSetup
   * when it calls Connection.connectWithRoom(). Tracked here so shutdown() can
   * clean it up if the scene is destroyed before GameSceneSetup runs (user
   * leaves during the transition fade, or GameScene.create() throws).
   */
  private pendingMessageBuffer: MessageBuffer | null = null;

  constructor() {
    super('MatchmakingScene');
  }

  preload(): void {
    loadAtlases(this);
    // The single audio sprite sheet covers SFX, music, and voiceover.
    // Loaded in preload so it is in cache before create() calls playMusic.
    this.audio = getSharedAudioService(this.game);
    this.audio.loadAll(this);

    // Light cookie textures — required by MenuBackground.boot() (ticket 06),
    // which constructs the LightingPipeline + spawns MenuDioramaLighting props
    // that sample these cookies. Registered as standalone texture keys (the vfx
    // atlas also has 'light_01/02/03' frames, but the pipeline's
    // `add.shader(inputKeys)` binds by standalone key, not atlas frame). The
    // global TextureManager cache is shared across scenes, so these are usually
    // already loaded by MainMenuScene.preload — but this guard ensures the
    // MenuBackground can boot regardless of entry path (hot-reload, direct
    // scene start, tests). Mirrors `MainMenuScene.preload:59-71` exactly.
    for (const key of ['light_01', 'light_02', 'light_03']) {
      if (!this.textures.exists(key)) {
        this.load.image(key, `assets/${key}.png`);
      }
    }
  }

  create(): void {
    // Phaser 4 does NOT auto-invoke the Scene's `shutdown` method (only
    // `update` is auto-bound). Without this binding the `shutdown()` below is
    // dead code → the lobby/MenuBackground/UI never tear down on stop, leaking
    // across the stop→launch reboot (see MainMenuScene.create for the full
    // rationale; GameScene.ts:358 uses the same pattern).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);

    // Reset the transitioning guard on every scene start. Phaser REUSES the
    // scene instance across stop/launch cycles (TransitionScene does
    // scene.stop() + scene.launch()), so instance fields survive between
    // matches. `transitioning` is flipped to true when a match starts
    // (handleMatchStarting) or when returning to menu (returnToMenu), and was
    // previously never reset on the success path — so on the SECOND matchmaking
    // attempt the stale `true` caused handleMatchStarting to silently bail at
    // its guard, dropping the server's matchStarting signal and leaving the
    // player stuck on the matchmaking screen forever ("cannot join a new game").
    this.transitioning = false;

    this.tweenTracker = new TweenTracker(this);

    this.input.setDefaultCursor(`url('${AssetManifest.ui.cursor.pointer_toon_a}'), pointer`);

    this.audio.setFadeScene(this);
    this.audio.playMusic('lobby');

    this.navigator = new SceneNavigator(this);

    // Build UI
    const uiBuilder = new MatchmakingUI(this, this.tweenTracker);
    this.ui = uiBuilder.create();

    // Wire leave button
    this.ui.leaveButton.on('button.click', () => {
      this.returnToMenu();
    });

    // Create error overlay
    this.errorOverlay = new ErrorOverlay(this);

    // Setup lobby connection
    this.lobby = new LobbyConnection();
    this.lobby.onStateChange((snapshot) => this.handleStateChange(snapshot));
    this.lobby.onMatchStart((client, data) => this.handleMatchStarting(client, data));
    this.lobby.onError((message) => this.errorOverlay.show(message, () => this.returnToMenu()));
    this.lobby.onLeave(() => {
      if (!this.transitioning) {
        this.errorOverlay.show('Disconnected from lobby', () => this.returnToMenu());
      }
    });

    this.lobby.connect();

    SceneNavigator.requestReveal(this);
  }

  update(time: number, delta: number): void {
    // MenuBackground drives parallax + the fire/aura + the lighting pipeline
    // (ticket 06/08 — replaces the old `logoPatternLayer.updateDrift` call).
    this.ui.menuBackground.update(time, delta);
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  private handleStateChange(snapshot: LobbySnapshot): void {
    const playerCount = snapshot.players.length;
    const botCount = Math.max(0, 64 - playerCount);

    if (playerCount < 64) {
      this.ui.playerCountLabel.setText(`${playerCount} + ${botCount} bots joining`);
    } else {
      this.ui.playerCountLabel.setText(`${playerCount} / 64 players`);
    }

    this.ui.fillBar.setRatio(playerCount / 64, true);

    switch (snapshot.status) {
      case 'waiting':
        if (playerCount < 2) {
          this.ui.statusLabel.setText('Searching for players...');
        } else {
          this.ui.statusLabel.setText(`Waiting for match... ${playerCount}/64`);
        }
        break;
      case 'countdown':
        this.ui.statusLabel.setText('Match starting!');
        break;
      case 'starting':
        this.ui.statusLabel.setText('Starting match...');
        break;
    }

    if (snapshot.countdownSeconds > 0 && snapshot.status === 'countdown') {
      this.ui.countdownLabel.setText(`${snapshot.countdownSeconds}`);
      this.ui.countdownBar.setVisible(true);
      this.ui.countdownBar.setRatio(snapshot.countdownSeconds / 5, true);
      this.audio.playCountdownBeep();

      if (snapshot.countdownSeconds === 3) {
        this.audio.playVoiceover('countdown_3');
      } else if (snapshot.countdownSeconds === 2) {
        this.audio.playVoiceover('countdown_2');
      } else if (snapshot.countdownSeconds === 1) {
        this.audio.playVoiceover('countdown_1');
      }
    } else {
      this.ui.countdownLabel.setText('');
      this.ui.countdownBar.setVisible(false);
    }

    this.ui.playerListWidget.refresh(
      snapshot.players.map((p: LobbyPlayerInfo) => ({
        name: p.name,
        ready: p.ready,
        isHost: p.isHost,
      })),
    );
  }

  private handleMatchStarting(
    client: import('@colyseus/sdk').Client,
    data: MatchStartingPayload,
  ): void {
    if (this.transitioning) return;
    this.transitioning = true;

    this.ui.statusLabel.setText('Starting match...');
    this.ui.countdownLabel.setText('GO!');
    this.audio.stopMusic();
    this.audio.playCountdownGo();

    const joinPromise = client.joinById(data.roomId, { token: data.seatToken });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('joinById timed out after 15s')), 15000),
    );

    Promise.race([joinPromise, timeoutPromise])
      .then((gameRoom: import('@colyseus/sdk').Room) => {
        logger.info(`Joined game room: ${gameRoom.roomId}`);
        // Immediately start buffering messages on the game room. Between now
        // and GameSceneSetup (~1.6s transition fade), the server will emit
        // match_start / pickup / attack / explosion messages. Without
        // buffering these are silently dropped. GameSceneSetup adopts this
        // buffer via Connection.connectWithRoom(room, buffer) and drains it
        // into the real handlers when they register.
        this.pendingMessageBuffer = MessageBuffer.attach(gameRoom);
        this.lobby.disconnect();
        const transitionData: GameSceneTransitionData = {
          mapType: 'seeded',
          gameRoom,
          messageBuffer: this.pendingMessageBuffer,
        };
        this.navigator.transitionTo(SCENE_KEYS.GAME, transitionData);
      })
      .catch((err: unknown) => {
        logger.error('Failed to join game room:', err);
        // Clean up the buffer if join failed AFTER it was attached (unlikely
        // since attach happens in the .then, but defensive).
        if (this.pendingMessageBuffer) {
          this.pendingMessageBuffer.detach();
          this.pendingMessageBuffer = null;
        }
        this.transitioning = false;
        this.errorOverlay.show('Failed to join match', () => this.returnToMenu());
      });
  }

  private returnToMenu(): void {
    this.transitioning = true;
    this.lobby.disconnect();
    this.navigator.transitionTo(SCENE_KEYS.MAIN_MENU);
  }

  shutdown(): void {
    // Defensive: clear the transitioning guard whenever the scene tears down,
    // so a stale `true` can never survive into the next matchmaking cycle.
    // (The primary reset is in create(); this covers any teardown path.)
    this.transitioning = false;
    // Tear down the shared diorama (3 baked RTs + LightingPipeline + 05's
    // fire/aura/atmosphere props) — mirrors `MainMenuScene.shutdown` calling
    // `this.menuBackground?.destroy()`. Best-effort; never throws (the
    // pipeline's resize listener auto-unbinds on scene SHUTDOWN).
    this.ui.menuBackground?.destroy();
    this.tweenTracker.dispose();
    this.lobby.disconnect();
    // If the scene is destroyed before GameSceneSetup adopted the buffer
    // (user left during transition fade, or GameScene.create threw), detach
    // the wildcard subscription so we don't leak the room or hold message
    // payloads in memory. If GameSceneSetup already adopted it, this is a
    // no-op (the field was nulled on adoption).
    if (this.pendingMessageBuffer) {
      this.pendingMessageBuffer.detach();
      this.pendingMessageBuffer = null;
    }
    this.ui.playerListWidget.destroy();
    this.errorOverlay.destroy();
    logger.info('MatchmakingScene shutdown complete');
  }
}
