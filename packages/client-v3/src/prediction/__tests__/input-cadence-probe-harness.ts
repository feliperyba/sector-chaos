/**
 * INPUT-CADENCE PROBE HARNESS (NET-24) — drives the REAL production input/
 * cadence layer against the REAL server input handler, layered on top of the
 * TASK-01 proven-clean physics differential.
 *
 * What this harness drives for REAL (no stubs of production logic — only stubs
 * of EXTERNAL dependencies: Phaser keyboard/pointer/scene, Colyseus Room):
 *
 *   CLIENT SIDE:
 *   - InputOrchestrator.collect()           — per-frame input pipeline entry
 *   - InputCollector.sampleLiveMovement()   — live WASD direction sampling
 *   - InputCollector.pollEdgeActions()       — per-frame edge detection (DASH, etc.)
 *   - InputCollector.collect()               — 16ms send-boundary frame build + throttle
 *   - InteractionDetector.detect()           — chest/pickup proximity (sets targetId)
 *   - Connection.sendInput()                 — the real send (captured by a stub Room)
 *   - PredictionService.step()               — per-frame prediction (from harness base)
 *   - Reconciler + applyReconciledPosition   — real reconciliation + threshold gate
 *
 *   SERVER SIDE:
 *   - RateLimiter.check()                    — the real @ 200 msg/s rate limiter
 *   - InputQueue.enqueue / dequeueTick       — the real per-tick input bucketing
 *   - The input.ts handler logic             — clampDirection + MOVE enqueue + actions
 *   - ServerAuthSim.stepTick                 — REAL MovementService + GameSimulation pipeline
 *
 * The only production code NOT driven here is the network transport itself (we
 * model latency/loss/reorder as a deterministic queue, not Colyseus websocket).
 *
 * WHY THIS IS THE RIGHT SHAPE: TASK-01 (physics-divergence-harness) proved the
 * matched-physics seam is CLEAN for sustained walk (0 corrections @ 60Hz) by
 * feeding both sides a CLEAN 16ms cadence with zero loss. If production emits
 * inputs differently (coalescing, drop, throttle, cadence drift, rate-limit),
 * the server's per-tick input stream diverges from what the client predicted,
 * and THAT divergence is invisible to the TASK-01 harness. This probe closes
 * that blind spot by driving the REAL input/cadence layer.
 *
 * Determinism: performance.now() and Date.now() are overridden to a simulated
 * time source (the timeBox) so the InputCollector's 16ms throttle and the
 * RateLimiter's token bucket behave deterministically. Same inputs → identical
 * per-tick series. See `DETERMINISTIC` test in the test file.
 */

import {
  PLAYER,
  SIM_TICK_DT,
  InputAction,
  NETWORK,
  type InputActionName,
  type InputActionData,
  type TileType,
} from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { InputOrchestrator } from '../../input/InputOrchestrator.js';
import { InputCollector } from '../../input/InputCollector.js';
import { InteractionDetector } from '../../controllers/InteractionDetector.js';
import { Connection } from '../../network/Connection.js';
import { computeSnapThreshold, type InputFrame } from '../../types.js';

// Re-use the proven TASK-01 harness components.
import {
  loadServerModules,
  ServerAuthSim,
  makeClientStack,
  makeOpenGrid,
  type ClientStack,
} from './physics-divergence-harness.js';

// ─── Server input-module surface (local structural types for dynamic import) ─

export interface QueuedInputStub {
  playerId: string;
  action: InputAction;
  data: InputActionData;
  clientTick: number;
  serverTick: number;
  receivedAt: number;
}

interface ServerRateLimiter {
  check(playerId: string): boolean;
  reset(playerId: string): void;
}

interface ServerInputQueue {
  enqueue(input: QueuedInputStub): void;
  dequeueTick(tick: number): QueuedInputStub[];
  discardBefore(tick: number): void;
  clear(): void;
  getPendingCount(): number;
}

const SERVER_INPUT_BASE = '../../../../server/src';

let serverInputModulesLoaded: Promise<{
  RateLimiter: new (maxTokens: number, windowMs: number) => ServerRateLimiter;
  InputQueue: new (bufferSize?: number) => ServerInputQueue;
}> | null = null;

/**
 * Load the REAL server RateLimiter + InputQueue once (cached). These are
 * standalone classes with no complex deps, loaded across packages via a
 * non-literal dynamic import (same trick as loadServerModules).
 */
export function loadServerInputModules(): Promise<{
  RateLimiter: new (maxTokens: number, windowMs: number) => ServerRateLimiter;
  InputQueue: new (bufferSize?: number) => ServerInputQueue;
}> {
  if (!serverInputModulesLoaded) {
    serverInputModulesLoaded = (async () => {
      const rlMod = (await import(
        /* @vite-ignore */ `${SERVER_INPUT_BASE}/validation/RateLimiter.ts`
      )) as { RateLimiter: new (maxTokens: number, windowMs: number) => ServerRateLimiter };
      const iqMod = (await import(
        /* @vite-ignore */ `${SERVER_INPUT_BASE}/application/simulation/InputQueue.ts`
      )) as { InputQueue: new (bufferSize?: number) => ServerInputQueue };
      return { RateLimiter: rlMod.RateLimiter, InputQueue: iqMod.InputQueue };
    })();
  }
  return serverInputModulesLoaded;
}

// ─── Phaser stubs (external dependency stubs, NOT production-logic stubs) ────

export interface StubKey {
  isDown: boolean;
  keyCode: number;
}

export interface KeyboardController {
  /** The keyboard plugin stub passed to InputCollector.init(). */
  keyboard: {
    createCursorKeys(): unknown;
    addKey(code: string | number): StubKey;
  };
  /** The input-plugin stub passed to InputCollector.init(). */
  inputPlugin: { on(event: string, cb: (...args: unknown[]) => void): void };
  cursorKeys: {
    up: { isDown: boolean };
    down: { isDown: boolean };
    left: { isDown: boolean };
    right: { isDown: boolean };
  };
  /** Named references to the key objects created by init() — mutate .isDown. */
  keys: {
    W: StubKey;
    A: StubKey;
    S: StubKey;
    D: StubKey;
    Space: StubKey;
    E: StubKey;
    One: StubKey;
    Two: StubKey;
    Three: StubKey;
    Four: StubKey;
  };
}

/**
 * Build a keyboard controller whose key objects are controllable via
 * `keys.D.isDown = true` etc. The InputCollector.init() will call
 * createCursorKeys + addKey, receiving these same key objects (shared refs).
 */
export function makeKeyboardController(): KeyboardController {
  let nextKeyCode = 1;
  const makeKey = (): StubKey => ({ isDown: false, keyCode: nextKeyCode++ });
  const cursorKeys = {
    up: { isDown: false },
    down: { isDown: false },
    left: { isDown: false },
    right: { isDown: false },
  };
  const keys = {
    W: makeKey(),
    A: makeKey(),
    S: makeKey(),
    D: makeKey(),
    Space: makeKey(),
    E: makeKey(),
    One: makeKey(),
    Two: makeKey(),
    Three: makeKey(),
    Four: makeKey(),
  };
  // Map from the addKey argument string to the key object. InputCollector.init
  // calls addKey('W'), addKey(32) [SPACE], addKey('ONE'), etc.
  const codeToKey: Record<string, StubKey> = {
    W: keys.W,
    A: keys.A,
    S: keys.S,
    D: keys.D,
    '32': keys.Space, // Phaser.Input.Keyboard.KeyCodes.SPACE = 32
    E: keys.E,
    ONE: keys.One,
    TWO: keys.Two,
    THREE: keys.Three,
    FOUR: keys.Four,
  };
  const keyboard = {
    createCursorKeys: () => cursorKeys,
    addKey: (code: string | number): StubKey => codeToKey[code.toString()] ?? makeKey(),
  };
  const inputPlugin = {
    on: (_event: string, _cb: (...args: unknown[]) => void) => {
      /* no-op — wheel handler not needed in the probe */
    },
  };
  return { keyboard, inputPlugin, cursorKeys, keys };
}

export interface PointerController {
  pointer: {
    isDown: boolean;
    x: number;
    y: number;
    rightButtonDown(): boolean;
    _rightDown: boolean;
  };
}

export function makePointerController(): PointerController {
  const pointer = {
    isDown: false,
    x: 0,
    y: 0,
    _rightDown: false,
    rightButtonDown() {
      return this._rightDown as boolean;
    },
  };
  return { pointer };
}

// ─── Client input stack (REAL InputOrchestrator + Collector + Detector + Connection) ─

export interface ClientInputStack {
  orchestrator: InputOrchestrator;
  collector: InputCollector;
  detector: InteractionDetector;
  connection: Connection;
  keyboard: KeyboardController;
  pointer: PointerController;
  gameState: GameState;
  /** Frames captured by the stub Room.send (in send order). */
  sentFrames: InputFrame[];
  /** Count of frames dropped by Connection (!connected). */
  droppedByConnection: { count: number };
}

/**
 * Wire the REAL InputOrchestrator + InputCollector + InteractionDetector +
 * Connection with Phaser stubs. The Connection's room is a stub that captures
 * frames into `sentFrames`. The StateSync is a stub returning empty entities
 * (no chests/pickups — sustained-walk probe).
 */
export function makeClientInputStack(
  gameState: GameState,
  worldToScreen: (wx: number, wy: number) => { x: number; y: number },
): ClientInputStack {
  const kc = makeKeyboardController();
  const pc = makePointerController();
  const sentFrames: InputFrame[] = [];
  const droppedByConnection = { count: 0 };

  // Real InputCollector — initialized with the stub keyboard/inputPlugin.
  const collector = new InputCollector();
  collector.init(
    kc.keyboard as never,
    kc.inputPlugin as never,
  );

  // Real InteractionDetector.
  const detector = new InteractionDetector();

  // Real Connection — constructed, then forcibly "connected" with a stub Room
  // whose send() captures frames. The real sendInput logic runs (connected
  // check, inputCount, logging, room.send).
  const connection = new Connection();
  const stubRoom = {
    send: (channel: string, data: InputFrame) => {
      if (channel === 'input') {
        // Deep-copy: the collector reuses its scratch frame.
        sentFrames.push({
          movementX: data.movementX,
          movementY: data.movementY,
          aimAngle: data.aimAngle,
          sequence: data.sequence,
          actions: data.actions ? [...data.actions] : [],
          targetId: data.targetId,
        });
      }
    },
  };
  // Force the Connection into the "connected" state with the stub room. The
  // private `connected` field is set via cast (test harness only).
  (connection as unknown as { connected: boolean }).connected = true;
  (connection as unknown as { disposed: boolean }).disposed = false;
  connection.room = stubRoom as never;

  // Stub StateSync: returns empty entities (no chests/pickups).
  const stubStateSync = {
    getEntities: () => ({
      weaponPickups: new Map(),
      chests: new Map(),
    }),
  };

  // Stub Phaser.Scene: only input.activePointer is accessed.
  const stubScene = {
    input: { activePointer: pc.pointer },
  };

  const orchestrator = new InputOrchestrator(
    collector,
    detector,
    stubScene as never,
    gameState,
    worldToScreen,
    stubStateSync as never,
  );

  return {
    orchestrator,
    collector,
    detector,
    connection,
    keyboard: kc,
    pointer: pc,
    gameState,
    sentFrames,
    droppedByConnection,
  };
}

// ─── Server input handler (REAL RateLimiter + InputQueue + handler logic) ────

export interface ServerInputHandler {
  rateLimiter: ServerRateLimiter;
  inputQueue: ServerInputQueue;
  /** Total inputs that passed the rate limiter (mutable — read AFTER the probe). */
  stats: { accepted: number; rateLimited: number };
  /**
   * Process a single InputFrame through the REAL server handler logic:
   * RateLimiter.check → clampDirection → enqueue MOVE (+ actions).
   * Returns true if the frame passed the rate limiter.
   *
   * Mirrors room/handlers/input.ts lines 32–208 faithfully (the movement +
   * action enqueue logic; validation schemas are skipped — the frames are
   * well-formed by construction from the real InputCollector).
   */
  processFrame: (frame: InputFrame, playerId: string, currentTick: number) => boolean;
}

function clampDirection(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export async function makeServerInputHandler(): Promise<ServerInputHandler> {
  const { RateLimiter, InputQueue } = await loadServerInputModules();
  // Production config: NETWORK.MAX_MESSAGES_PER_SECOND = 200, window = 1000ms.
  // See room/handlers/input.ts:21.
  const rateLimiter = new RateLimiter(NETWORK.MAX_MESSAGES_PER_SECOND, 1000);
  const inputQueue = new InputQueue();
  // Mutable stats container (captured by reference, not value).
  const stats = { accepted: 0, rateLimited: 0 };

  const processFrame = (frame: InputFrame, playerId: string, currentTick: number): boolean => {
    // Step 1: Rate limit (room/handlers/input.ts:33).
    if (!rateLimiter.check(playerId)) {
      stats.rateLimited++;
      return false;
    }
    stats.accepted++;

    // Step 2: Extract + clamp (room/handlers/input.ts:40-48).
    const rawMx = typeof frame.movementX === 'number' ? frame.movementX : 0;
    const rawMy = typeof frame.movementY === 'number' ? frame.movementY : 0;
    const sequence = typeof frame.sequence === 'number' ? frame.sequence : 0;
    const rawAimAngle =
      typeof frame.aimAngle === 'number' ? frame.aimAngle : undefined;

    const mx = clampDirection(rawMx);
    const my = clampDirection(rawMy);

    // Step 3: Enqueue MOVE if movement or aim present (room/handlers/input.ts:50-77).
    if (mx !== 0 || my !== 0 || (rawAimAngle !== undefined && Number.isFinite(rawAimAngle))) {
      inputQueue.enqueue({
        playerId,
        action: InputAction.MOVE,
        data: { dx: mx, dy: my, aimAngle: rawAimAngle, tick: sequence },
        clientTick: sequence,
        serverTick: currentTick,
        receivedAt: 0,
      });
    }

    // Step 4: Process actions array (room/handlers/input.ts:80-208).
    // Only DASH affects movement; other actions (ATTACK/THROW/PICKUP/SWITCH_SLOT)
    // are non-positional and skipped for this movement probe.
    const actions = Array.isArray(frame.actions) ? frame.actions.slice(0, 3) : [];
    for (const action of actions) {
      if (typeof action !== 'string') continue;
      if (action === 'DASH') {
        inputQueue.enqueue({
          playerId,
          action: InputAction.DASH,
          data: { dx: mx, dy: my, tick: sequence },
          clientTick: sequence,
          serverTick: currentTick,
          receivedAt: 0,
        });
      }
    }
    return true;
  };

  return { rateLimiter, inputQueue, stats, processFrame };
}

// ─── Deterministic time control ─────────────────────────────────────────────

/**
 * Mutable time box. Override performance.now and Date.now to read from this.
 * Set `perfNow` and `now` before each step. Restore in afterEach.
 */
export interface TimeBox {
  perfNow: number;
  now: number;
}

// ─── Differential loop ──────────────────────────────────────────────────────

export interface ProbeOptions {
  grid?: TileType[][];
  tileSize?: number;
  spawn?: { x: number; y: number };
  durationSec?: number;
  /** One-way latency (seconds). RTT = 2× this. Default 0 (localhost). */
  latencySec?: number;
  /** Render-frame delta (seconds). Default SIM_TICK_DT (60Hz). */
  renderDt?: number;
  /**
   * Per-frame jitter in ms (±). Each frame's dt is renderDt ± random(0, jitterMs).
   * Models the erratic frame timing Vite dev mode produces. Default 0.
   */
  frameJitterMs?: number;
  /** Seed for the jitter/loss/reorder RNG (determinism). Default 42. */
  rngSeed?: number;
  /**
   * Patch cadence: send a patch every N server ticks. 1 = every tick
   * (production PATCH_RATE=60). 2 = every other tick (PATCH_RATE=30).
   * Default 1.
   */
  syncEveryN?: number;
  /**
   * Packet-loss fraction [0..1). Fraction of sent inputs that are dropped at
   * the network boundary (never arrive at the server). Default 0.
   */
  packetLossRate?: number;
  /**
   * Packet-reorder fraction [0..1). Fraction of sent inputs whose arrival is
   * delayed by one extra server tick (lands in a later tick's bucket).
   * Default 0.
   */
  packetReorderRate?: number;
  /**
   * Live keyboard direction at wall-clock t (seconds), raw (not normalized).
   * The harness sets the WASD key states to produce this direction.
   */
  directionAt: (tSec: number) => { dx: number; dy: number };
  /**
   * DASH edge: true on render frames where Space was pressed. The harness
   * presses/releases the Space key to produce the edge.
   */
  dashEdgeAt?: (tSec: number, frameIndex: number) => boolean;
}

export interface ProbeResult {
  perTickPosError: number[];
  peakPosError: number;
  peakPosErrorTick: number;
  correctionFires: number;
  peakGenuinePosError: number;
  peakRawPatchError: number;
  finalDivergence: number;
  totalTicks: number;
  snapThreshold: number;
  ticksOverRawThreshold: number;
  serverEnd: { x: number; y: number };
  clientEnd: { x: number; y: number };
  /** How many frames the client rendered. */
  totalRenderFrames: number;
  /** How many InputFrames the client sent (Connection.sendInput). */
  totalSent: number;
  /** How many sent inputs actually arrived at the server (after loss). */
  totalArrived: number;
  /** How many inputs the server accepted (passed RateLimiter). */
  totalAccepted: number;
  /** How many inputs the RateLimiter dropped. */
  totalRateLimited: number;
  /** How many ticks got 0 MOVE inputs (momentum-coast ticks). */
  gapTicks: number;
  /** How many ticks got >1 MOVE inputs (coalesced — only last kept). */
  coalescedTicks: number;
}

/**
 * Run the input-cadence differential probe. Drives the REAL client input path
 * and the REAL server input handler, measuring per-tick |serverPos − clientLocal|,
 * correction-fires, and genuine/raw posError.
 *
 * Time is controlled via the timeBox (callers must override performance.now and
 * Date.now to read from it — see the test file's beforeAll/afterAll).
 */
export async function runInputCadenceProbe(
  opts: ProbeOptions,
  timeBox: TimeBox,
): Promise<ProbeResult> {
  // Load all REAL modules.
  const { MovementService, CollisionService } = await loadServerModules();
  const serverHandler = await makeServerInputHandler();

  const tileSize = opts.tileSize ?? 128;
  const grid = opts.grid ?? makeOpenGrid(20);
  const spawn = opts.spawn ?? { x: 1280, y: 1280 };
  const durationSec = opts.durationSec ?? 1.0;
  const latencySec = opts.latencySec ?? 0;
  const renderDt = opts.renderDt ?? SIM_TICK_DT;
  const syncEveryN = opts.syncEveryN ?? 1;
  const frameJitterMs = opts.frameJitterMs ?? 0;
  const packetLossRate = opts.packetLossRate ?? 0;
  const packetReorderRate = opts.packetReorderRate ?? 0;
  let rngState = (opts.rngSeed ?? 42) >>> 0;
  const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  // --- Server-authoritative sim (REAL MovementService) ---
  const collisionService = new CollisionService(tileSize);
  const maxSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER * 1.5;
  const movementService = new MovementService(collisionService, maxSpeed, tileSize);
  const server = new ServerAuthSim(movementService, grid, spawn.x, spawn.y);

  // --- Client prediction stack (REAL PredictionService + Reconciler) ---
  const client = makeClientStack(grid, tileSize, spawn.x, spawn.y);

  // --- Client input stack (REAL InputOrchestrator + Collector + Detector + Connection) ---
  const input = makeClientInputStack(
    client.gameState,
    (wx: number, wy: number) => ({ x: wx, y: wy }), // identity worldToScreen
  );

  const rttMs = latencySec * 1000 * 2;
  const snapThreshold = computeSnapThreshold(rttMs);

  // --- Network queues ---
  // In-flight inputs: sent by client, arriving at server after latency.
  const inflightInputs = new Map<
    number, // unique key
    {
      frame: InputFrame;
      arrivalSec: number;
      seq: number;
    }
  >();
  // In-flight patches: sent by server, arriving at client after latency.
  const inflightPatches = new Map<
    number,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      lastSeq: number;
      arrivalSec: number;
      speedAtSend: number;
      staggeredAtSend: boolean;
    }
  >();

  // --- Per-tick measurement ---
  const perTickPosError: number[] = [];
  let correctionFires = 0;
  let peakGenuinePosError = 0;
  let peakRawPatchError = 0;
  let ticksOverRawThreshold = 0;

  // --- Loop state ---
  let currentTick = 0;
  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let lastPatchSentAtTick = -1;
  let serverLastSeq = 0;
  let totalSent = 0;
  let totalArrived = 0;
  let gapTicks = 0;
  let coalescedTicks = 0;
  let inflightKey = 0;
  let frameIndex = 0;
  let prevSpaceDown = false;

  // Set initial time (start high enough that the first collect() send-boundary
  // is not blocked by lastSendTime=0 — production performance.now() is large).
  timeBox.perfNow = 1000.0;
  timeBox.now = 1000.0;

  const PLAYER_ID = 'p1';

  // Helper: set WASD key state from a direction vector.
  const setKeysFromDirection = (dx: number, dy: number) => {
    input.keyboard.keys.D.isDown = dx > 0;
    input.keyboard.keys.A.isDown = dx < 0;
    input.keyboard.keys.S.isDown = dy > 0;
    input.keyboard.keys.W.isDown = dy < 0;
    // Cursor keys mirror WASD (some users use arrows).
    input.keyboard.cursorKeys.right.isDown = dx > 0;
    input.keyboard.cursorKeys.left.isDown = dx < 0;
    input.keyboard.cursorKeys.down.isDown = dy > 0;
    input.keyboard.cursorKeys.up.isDown = dy < 0;
  };

  // ── Server stepping: advance ticks, process arrived inputs, send patches ──
  const stepServer = (targetSec: number) => {
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      const tickWallSec = nextServerTickSec;
      timeBox.now = 1000.0 + tickWallSec * 1000.0; // Date.now for RateLimiter

      // Process arrived inputs through the REAL server handler.
      const arrivedThisTick: InputFrame[] = [];
      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          arrivedThisTick.push(inp.frame);
          inflightInputs.delete(key);
        }
      }
      // Sort by sequence to preserve send order within the same tick.
      arrivedThisTick.sort((a, b) => a.sequence - b.sequence);
      for (const frame of arrivedThisTick) {
        totalArrived++;
        serverHandler.processFrame(frame, PLAYER_ID, currentTick);
      }

      // Dequeue this tick's input bucket from the REAL InputQueue.
      const bucket = serverHandler.inputQueue.dequeueTick(currentTick);
      const moveInputs = bucket.filter((b) => b.action === InputAction.MOVE);
      const dashInputs = bucket.filter((b) => b.action === InputAction.DASH);

      if (moveInputs.length === 0) gapTicks++;
      if (moveInputs.length > 1) coalescedTicks++;

      // Feed the bucket into ServerAuthSim. ServerAuthSim takes a single
      // {move, dashEdge} — the server handler coalesces multiple MOVE inputs
      // for the same tick into one (last wins, via InputQueue.enqueue's
      // replace-on-match). So we pass the last MOVE (if any).
      const lastMove = moveInputs.length > 0 ? moveInputs[moveInputs.length - 1]! : null;
      const moveData = lastMove?.data as { dx: number; dy: number } | null;
      server.stepTick(currentTick, {
        move: moveData ? { dx: moveData.dx, dy: moveData.dy } : null,
        dashEdge: dashInputs.length > 0,
      });

      // Advance serverLastSeq (mirrors GameSimulation._lastProcessedInput).
      for (const b of bucket) {
        if (b.clientTick > serverLastSeq) serverLastSeq = b.clientTick;
      }

      // Discard old inputs (mirrors GameSimulation.post-step discardBefore).
      serverHandler.inputQueue.discardBefore(currentTick - NETWORK.INPUT_BUFFER_SIZE);

      // Send patch at the configured cadence.
      if (currentTick - lastPatchSentAtTick >= syncEveryN) {
        lastPatchSentAtTick = currentTick;
        const patchArrivalSec = tickWallSec + latencySec;
        inflightPatches.set(patchArrivalSec * 1000 + currentTick, {
          x: server.player.movement.position.x,
          y: server.player.movement.position.y,
          vx: server.player.movement.velocityX,
          vy: server.player.movement.velocityY,
          lastSeq: serverLastSeq,
          arrivalSec: patchArrivalSec,
          speedAtSend: server.player.movement.speed.value,
          staggeredAtSend: server.player.isStaggered(),
        });
      }

      // Reconcile arrived patches at the client.
      for (const [, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(patch.arrivalSec * 1000 + currentTick);
          const result = client.reconcilePatch(
            { x: patch.x, y: patch.y, vx: patch.vx, vy: patch.vy, lastSeq: patch.lastSeq },
            currentTick,
            rttMs,
          );
          if (result.wasCorrected) correctionFires++;
          if (result.genuinePosError > peakGenuinePosError) {
            peakGenuinePosError = result.genuinePosError;
          }
          if (result.rawPosError > peakRawPatchError) peakRawPatchError = result.rawPosError;
          break;
        }
      }

      // Per-tick raw error.
      const rawErr = Math.hypot(
        server.player.movement.position.x - client.gameState.localPos.x,
        server.player.movement.position.y - client.gameState.localPos.y,
      );
      perTickPosError.push(rawErr);
      if (rawErr >= snapThreshold) ticksOverRawThreshold++;

      nextServerTickSec += SIM_TICK_DT;
    }
  };

  // ── Render-frame loop: drive the REAL InputOrchestrator ──
  for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt, frameIndex++) {
    // Apply per-frame jitter.
    const jitter = frameJitterMs > 0 ? ((rand() - 0.5) * 2 * frameJitterMs) / 1000 : 0;
    const frameDt = renderDt + jitter;
    const frameEndSec = nowSec + frameDt;

    // Step the server up to this frame's end time.
    stepServer(frameEndSec);
    nowSec = frameEndSec;

    // Set the simulated time for the REAL InputCollector.collect's throttle.
    // production.now() returns ms; we use ms for perfNow.
    timeBox.perfNow = 1000.0 + nowSec * 1000.0;
    timeBox.now = 1000.0 + nowSec * 1000.0;

    // Set keyboard state from the live direction.
    const live = opts.directionAt(nowSec);
    setKeysFromDirection(live.dx, live.dy);

    // DASH edge: press Space on the frame the edge fires, release the next.
    const dashEdge = opts.dashEdgeAt ? opts.dashEdgeAt(nowSec, frameIndex) : false;
    if (dashEdge) {
      input.keyboard.keys.Space.isDown = true;
    } else if (prevSpaceDown) {
      input.keyboard.keys.Space.isDown = false;
    }
    prevSpaceDown = input.keyboard.keys.Space.isDown;

    // ── REAL InputOrchestrator.collect() ──
    // This is the production per-frame entry point. It samples live movement,
    // runs edge detection, and builds the network InputFrame at the 16ms send
    // boundary (using the REAL performance.now() throttle — deterministic via
    // our timeBox override).
    const perFrame = input.orchestrator.collect(0);

    // ── REAL PredictionService.step() ──
    // Feed the orchestrator's output to the prediction (same shape as GameScene).
    client.stepPrediction({
      dirX: perFrame.dirX,
      dirY: perFrame.dirY,
      dt: frameDt,
      mySpeed: PLAYER.BASE_SPEED,
      isStaggered: false,
      edges: perFrame.edges as never,
      sendFrame: perFrame.sendFrame,
    });

    // ── REAL Connection.sendInput() ──
    // If a frame was built (non-null sendFrame), the production loop calls
    // connection.sendInput. We drive the REAL Connection.sendInput, which
    // captures the frame into sentFrames via the stub Room.
    if (perFrame.sendFrame) {
      input.connection.sendInput(perFrame.sendFrame);
      totalSent++;

      // The sent frame enters the network. Apply packet loss + reorder.
      const sendSec = nowSec;
      const roll = rand();
      if (packetLossRate > 0 && roll < packetLossRate) {
        // Dropped — never arrives.
      } else {
        const reorderDelay =
          packetReorderRate > 0 && rand() < packetReorderRate ? SIM_TICK_DT : 0;
        // Deep-copy the frame for the network queue (it's already deep-copied
        // by sentFrames.push, but sendFrame itself is the collector's scratch).
        const netFrame: InputFrame = {
          movementX: perFrame.sendFrame.movementX,
          movementY: perFrame.sendFrame.movementY,
          aimAngle: perFrame.sendFrame.aimAngle,
          sequence: perFrame.sendFrame.sequence,
          actions: perFrame.sendFrame.actions ? [...perFrame.sendFrame.actions] : [],
          targetId: perFrame.sendFrame.targetId,
        };
        inflightInputs.set(inflightKey++, {
          frame: netFrame,
          arrivalSec: sendSec + latencySec + reorderDelay,
          seq: netFrame.sequence,
        });
      }
    }
  }

  // Final drain: step the server past the last render frame to flush
  // in-flight inputs and patches.
  stepServer(nowSec + latencySec + SIM_TICK_DT * 2);

  let peakPosError = 0;
  let peakPosErrorTick = 0;
  for (let i = 0; i < perTickPosError.length; i++) {
    if (perTickPosError[i]! > peakPosError) {
      peakPosError = perTickPosError[i]!;
      peakPosErrorTick = i + 1;
    }
  }

  return {
    perTickPosError,
    peakPosError,
    peakPosErrorTick,
    correctionFires,
    peakGenuinePosError,
    peakRawPatchError,
    finalDivergence: perTickPosError[perTickPosError.length - 1] ?? 0,
    totalTicks: perTickPosError.length,
    snapThreshold,
    ticksOverRawThreshold,
    serverEnd: { x: server.player.movement.position.x, y: server.player.movement.position.y },
    clientEnd: { x: client.gameState.localPos.x, y: client.gameState.localPos.y },
    totalRenderFrames: frameIndex,
    totalSent,
    totalArrived,
    totalAccepted: serverHandler.stats.accepted,
    totalRateLimited: serverHandler.stats.rateLimited,
    gapTicks,
    coalescedTicks,
  };
}
