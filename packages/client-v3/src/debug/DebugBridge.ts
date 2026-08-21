import type {
  DebugStateSnapshot,
  WaitForStatePredicate,
  ConnectRoomOptions,
  ZoneSnapshot,
  PredictionBufferSnapshot,
} from './types.js';
import {
  mapPlayer,
  mapProjectile,
  mapWeaponPickup,
  mapChest,
  mapDestructible,
  mapTrap,
  mapPowerUp,
  mapExplosion,
  collect,
} from './types.js';
import { SceneEvents } from '../scenes/SceneEvents.js';
import type { InputBuffer } from '../prediction/InputBuffer.js';
import { RuntimeGameController } from './RuntimeGameController.js';
import type { ReconciliationLog, ReconciliationEntry } from './ReconciliationLog.js';
import { TelemetrySampler } from '../telemetry/TelemetrySampler.js';
import type { InputCollector } from '../input/InputCollector.js';
import type { SpriteState } from '../rendering/PlayerRenderer.js';

export interface DebugBridgeOptions {
  connection: {
    sendInput: (frame: import('../types.js').InputFrame) => void;
    isConnected: boolean;
    disconnect: () => void;
    connect: (opts: {
      mapType: 'demo' | 'seeded';
      botFillTo?: number;
      roomName?: string;
    }) => Promise<void>;
    room: { state: { zone?: ZoneStateSchema }; send: (type: string, data: unknown) => void };
    sessionId: string;
  };
  stateSync: {
    getPlayer: (id: string) => import('../types.js').PlayerState | undefined;
    getTick: () => number;
    getLastProcessedInput: () => number;
    getEntities: () => import('../network/StateSync.js').EntityMaps;
    getPhase: () => number;
    getMatchTimer: () => number;
    getPlayersAlive: () => number;
  };
  inputBuffer: InputBuffer;
  scene: Phaser.Scene;
  myId: string;
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  reconciliationLog: ReconciliationLog;
  telemetrySampler: TelemetrySampler;
  playerRenderer: {
    getSpriteState: (key: string) => SpriteState | null;
  };
  inputCollector: InputCollector;
  spectator?: {
    isSpectating: boolean;
    spectateTarget: string;
    freeCamera: boolean;
    spectatedPlayers: string[];
    spectateIndex: number;
    handleDeath: (stateSync: import('../network/StateSync.js').StateSync) => void;
    handleRespawn: () => void;
    buildSpectatedPlayers: (stateSync: import('../network/StateSync.js').StateSync) => void;
  };
  cameraService?: {
    lerpEnabled: boolean;
    follow: (x: number, y: number) => void;
    snapTo: (x: number, y: number) => void;
    zoomDeath: () => void;
    zoomRespawn: () => void;
  };
  returnToMenu?: () => void;
}

interface ZoneStateSchema {
  centerX: number;
  centerY: number;
  currentRadius: number;
  phaseEndTime: number;
  targetCenterX?: number;
  targetCenterY?: number;
  targetRadius?: number;
}

export class DebugBridge {
  private connection: DebugBridgeOptions['connection'];
  private stateSync: DebugBridgeOptions['stateSync'];
  private inputBuffer: InputBuffer;
  private scene: Phaser.Scene;
  private myId: string;
  private localPos: { x: number; y: number };
  private localVelocity: { x: number; y: number };
  private reconciliationLog: ReconciliationLog;
  private playerRenderer: DebugBridgeOptions['playerRenderer'];
  private spectatorRef: DebugBridgeOptions['spectator'];
  private cameraServiceRef: DebugBridgeOptions['cameraService'];
  private returnToMenuFn: DebugBridgeOptions['returnToMenu'];
  private gameActive = false;
  private mapLoaded = false;
  private runtimeSeq = 0;
  /**
   * Stable bound handlers (arrow fields) so the exact reference registered with
   * `scene.events.on` can be passed to `scene.events.off` in {@link destroy} —
   * a fresh `.bind(this)` would create a new reference each call and never match.
   */
  private readonly onGameStarted = (): void => {
    this.gameActive = true;
  };
  private readonly onGameEnded = (): void => {
    this.gameActive = false;
  };

  public runtime: RuntimeGameController;
  public telemetry: TelemetrySampler;

  constructor(options: DebugBridgeOptions) {
    this.connection = options.connection;
    this.stateSync = options.stateSync;
    this.inputBuffer = options.inputBuffer;
    this.scene = options.scene;
    this.myId = options.myId;
    this.localPos = options.localPos;
    this.localVelocity = options.localVelocity;
    this.reconciliationLog = options.reconciliationLog;
    this.playerRenderer = options.playerRenderer;
    this.telemetry = options.telemetrySampler;
    this.spectatorRef = options.spectator;
    this.cameraServiceRef = options.cameraService;
    this.returnToMenuFn = options.returnToMenu;

    this.runtime = new RuntimeGameController({
      sendInput: (frame) => this.connection.sendInput(frame),
      getPlayerState: () => this.stateSync.getPlayer(this.myId),
      getNextSeq: () => ++this.runtimeSeq,
      isConnected: () => this.connection.isConnected,
      inputCollector: options.inputCollector,
      getPhase: () => this.stateSync.getPhase(),
    });

    this.scene.events.on(SceneEvents.GAME_STARTED, this.onGameStarted);
    this.scene.events.on(SceneEvents.GAME_ENDED, this.onGameEnded);
  }

  /**
   * Remove scene-event listeners registered in the constructor. MUST be called
   * from the scene shutdown handler so the listeners (and this bridge) don't
   * leak across scene transitions.
   */
  destroy(): void {
    this.scene.events.off(SceneEvents.GAME_STARTED, this.onGameStarted);
    this.scene.events.off(SceneEvents.GAME_ENDED, this.onGameEnded);
  }

  get scene_(): Phaser.Scene {
    return this.scene;
  }

  // Dev-entry console helper (called from the browser console via the
  // DebugBridge, NOT from the TEST SCENE button, NOT from the live
  // matchmaking path). Default to 'demo' to match the TEST SCENE literal;
  // pass 'seeded' explicitly for mood/A/B regression. Ticket 15 (d7e9867)
  // flipped this default to 'seeded'; reverted per B3 findings (dev-entry
  // only — the live path bypasses Connection.connect entirely via the
  // seat-reserved connectWithRoom branch, so this default has zero live
  // effect).
  goToGame(mapType: 'demo' | 'seeded' = 'demo', roomName?: string): void {
    this.scene.scene.start('GameScene', { mapType, roomName });
  }

  getPredictionError(): number {
    const serverPlayer = this.stateSync.getPlayer(this.myId);
    if (!serverPlayer) return 0;
    const dx = this.localPos.x - serverPlayer.x;
    const dy = this.localPos.y - serverPlayer.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getState(): DebugStateSnapshot {
    const entities = this.stateSync.getEntities();

    return {
      scene: this.scene.scene.key,
      myId: this.myId,
      tick: this.stateSync.getTick(),
      localPos: { ...this.localPos },
      localVelocity: { ...this.localVelocity },
      localSpeed: Math.sqrt(this.localVelocity.x ** 2 + this.localVelocity.y ** 2),
      lastProcessedInput: this.stateSync.getLastProcessedInput(),
      players: collect(entities.players, mapPlayer),
      projectiles: collect(entities.projectiles, mapProjectile),
      weaponPickups: collect(entities.weaponPickups, mapWeaponPickup),
      chests: collect(entities.chests, mapChest),
      destructibles: collect(entities.destructibles, mapDestructible),
      traps: collect(entities.traps, mapTrap),
      powerUps: collect(entities.powerUps, mapPowerUp),
      explosions: collect(entities.explosions, mapExplosion),
      zone: this.buildZoneSnapshot(),
      mapLoaded: this.mapLoaded,
      connected: this.connection.isConnected,
      gameActive: this.gameActive,
      predictionBuffer: this.buildPredictionBufferSnapshot(),
      reconciliationErrors: this.reconciliationLog.size,
    };
  }

  waitForState(
    predicate: WaitForStatePredicate,
    timeout = 5000,
    interval = 50,
  ): Promise<DebugStateSnapshot> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        const state = this.getState();
        if (predicate(state)) {
          resolve(state);
          return;
        }
        if (Date.now() - startTime > timeout) {
          reject(new Error(`waitForState timeout after ${timeout}ms`));
          return;
        }
        setTimeout(check, interval);
      };
      check();
    });
  }

  connectToRoom(options: ConnectRoomOptions): Promise<void> {
    this.connection.disconnect();
    return this.connection
      .connect({
        mapType: options.mapType ?? 'demo',
        botFillTo: options.botCount ?? 0,
        roomName: options.roomName,
      })
      .catch((err: Error) => {
        throw err;
      });
  }

  getPredictionEntries(fromSeq: number, toSeq: number): import('../types.js').InputRecord[] {
    const pooled = this.inputBuffer.getUnacknowledged(0);
    const out: import('../types.js').InputRecord[] = [];
    for (let i = 0; i < pooled.count; i++) {
      const r = pooled.records[i]!;
      if (r.frame.sequence >= fromSeq && r.frame.sequence <= toSeq) {
        out.push(r);
      }
    }
    return out;
  }

  getReconciliationLog(count?: number): ReconciliationEntry[] {
    return this.reconciliationLog.getEntries(count);
  }

  getSpriteState(playerId: string): SpriteState | null {
    return this.playerRenderer.getSpriteState(playerId);
  }

  captureScreenshot(): string {
    const snapshot = this.scene.game.renderer as unknown as {
      snapshot: (cb: (canvas: HTMLCanvasElement) => void) => void;
    };
    if (!snapshot || typeof snapshot.snapshot !== 'function') {
      return '';
    }
    const canvas = this.scene.game.canvas;
    return canvas.toDataURL('image/png');
  }

  // ── Spectator & Lifecycle APIs ──────────────────────────────────────────

  getSpectatorState(): {
    isSpectating: boolean;
    spectateTarget: string;
    freeCamera: boolean;
    spectatedPlayers: string[];
    spectateIndex: number;
  } {
    if (!this.spectatorRef) {
      return {
        isSpectating: false,
        spectateTarget: '',
        freeCamera: false,
        spectatedPlayers: [],
        spectateIndex: 0,
      };
    }
    return {
      isSpectating: this.spectatorRef.isSpectating,
      spectateTarget: this.spectatorRef.spectateTarget,
      freeCamera: this.spectatorRef.freeCamera,
      spectatedPlayers: [...this.spectatorRef.spectatedPlayers],
      spectateIndex: this.spectatorRef.spectateIndex,
    };
  }

  getCameraState(): { lerpEnabled: boolean; zoom: number; scrollX: number; scrollY: number } {
    const cam = this.scene.cameras.main;
    return {
      lerpEnabled: this.cameraServiceRef?.lerpEnabled ?? true,
      zoom: cam.zoom,
      scrollX: cam.scrollX,
      scrollY: cam.scrollY,
    };
  }

  isPlayerDead(): boolean {
    const player = this.stateSync.getPlayer(this.myId);
    if (!player) return false;
    // Player is dead/dying/spectating if any of DEAD(2), SPECTATING(4), DYING(64) flags set
    return (player.status & (0x02 | 0x04 | 0x40)) !== 0;
  }

  returnToMenu(): void {
    if (this.returnToMenuFn) {
      this.returnToMenuFn();
    }
  }

  /** Send debug:setHealth to server — triggers death pipeline if health=0 */
  forceKill(): void {
    if (this.connection.room) {
      this.connection.room.send('debug:setHealth', { health: 0 });
    }
  }

  getSceneKey(): string {
    return this.scene.scene.key;
  }

  private buildZoneSnapshot(): ZoneSnapshot {
    const zone = this.connection.room.state.zone;
    if (zone) {
      return {
        centerX: zone.centerX,
        centerY: zone.centerY,
        currentRadius: zone.currentRadius,
        phaseEndTime: zone.phaseEndTime,
      };
    }
    return {
      centerX: 0,
      centerY: 0,
      currentRadius: 1000,
      phaseEndTime: 0,
    };
  }

  private buildPredictionBufferSnapshot(): PredictionBufferSnapshot {
    const unacked = this.inputBuffer.getUnacknowledged(0);
    if (unacked.count === 0) {
      return { size: 0, firstSeq: 0, lastSeq: 0, droppedInputs: 0 };
    }
    return {
      size: unacked.count,
      firstSeq: unacked.records[0]!.frame.sequence,
      lastSeq: unacked.records[unacked.count - 1]!.frame.sequence,
      droppedInputs: 0,
    };
  }
}

declare global {
  interface Window {
    __SECTO_DEBUG__?: DebugBridge;
  }
}
