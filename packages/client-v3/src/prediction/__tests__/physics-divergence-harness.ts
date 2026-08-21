/**
 * PHYSICS-DIVERGENCE HARNESS — differential feedback loop (TASK-01 / diagnose).
 *
 * Drives an IDENTICAL input stream through two simulations in parallel and diffs
 * their per-tick positions:
 *
 *   A) SERVER path: the REAL `MovementService.validateAndMove` (loaded across
 *      packages at runtime) wrapped in a faithful replica of the GameSimulation
 *      per-tick movement pipeline (MOVE-before-DASH bucket order from
 *      `room/handlers/input.ts`, `lastMoveDirection` coasting on gap ticks from
 *      the `GameSimulationInput.ts` momentum pass, `resolvePlayerCollision` +
 *      `resolveDashEndOverlap`, `step8_ExpireTimers` dash-end at
 *      `DASH_DURATION_TICKS`). The Player state is held in a thin adapter that
 *      exposes exactly the fields validateAndMove reads/writes — the rules run
 *      in the REAL MovementService; the adapter is wiring only.
 *
 *   B) CLIENT path: the REAL `PredictionService` + `simulatePhysicsStepInto` +
 *      `ClientCollisionService` (the same instance graph GameScene constructs),
 *      reconciled by the REAL `Reconciler` + `PlayerReconciler`.
 *
 * Latency is modelled as a fixed queue delay (no real network). Time is pinned
 * via the input send cadence; the loop is fully deterministic.
 *
 * WHY THIS CATCHES WHAT transition-drift-repro.test.ts CANNOT: that harness's
 * ServerShadow calls the SAME `simulatePhysicsStepInto` as the client → matched
 * physics → rewind-replay reconstructs exactly → 0 corrections. Production does
 * NOT use that primitive; it uses `MovementService.validateAndMove` + the
 * GameSimulation pipeline. This harness closes that blind spot.
 *
 * Cross-package import note: the server source is loaded with a NON-LITERAL
 * dynamic import specifier so the client tsconfig (rootDir=src) does not pull
 * the server source into its typecheck program (TS6059). The runtime module is
 * the real server file; the static types are local structural interfaces.
 */

import { PLAYER, SIM_TICK_DT, type TileType } from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../PredictionService.js';
import { InputBuffer } from '../InputBuffer.js';
import { Reconciler } from '../Reconciler.js';
import { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import { computeSnapThreshold } from '../../types.js';
import type { InputFrame } from '../../types.js';

// ─── Server module surface (local structural types for the dynamic import) ──

export interface MovementResult {
  newPosition: { x: number; y: number };
  correctedPosition: { x: number; y: number };
  moved: boolean;
  collisionOccurred: boolean;
}

export interface ServerMovementService {
  validateAndMove(
    player: unknown,
    dx: number,
    dy: number,
    dt: number,
    grid: TileType[][],
  ): MovementResult;
  resolvePlayerCollision(
    movingPlayer: unknown,
    forEachAlive: (cb: (p: unknown) => void) => void,
    resolvedPos: { x: number; y: number },
    currentTick: number,
  ): { x: number; y: number };
  resolveDashEndOverlap(
    dashingPlayer: unknown,
    forEachAlive: (cb: (p: unknown) => void) => void,
    grid: TileType[][],
  ): { x: number; y: number };
}

type ServerMovementServiceCtor = new (
  collisionService: unknown,
  maxSpeed: number,
  tileSize: number,
) => ServerMovementService;

/** Production maxSpeed — see GameOrchestratorInit.ts:226. */
export const PRODUCTION_MAX_SPEED = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER * 1.5;

const SERVER_BASE = '../../../../server/src';

let serverModulesLoaded: Promise<{
  MovementService: ServerMovementServiceCtor;
  CollisionService: new (tileSize: number) => unknown;
}> | null = null;

/**
 * Load the REAL server MovementService + CollisionService once. Cached so the
 * 10-scenario matrix doesn't re-fetch per test. Returns the real constructors.
 */
export function loadServerModules(): Promise<{
  MovementService: ServerMovementServiceCtor;
  CollisionService: new (tileSize: number) => unknown;
}> {
  if (!serverModulesLoaded) {
    serverModulesLoaded = (async () => {
      const moveMod = (await import(
        /* @vite-ignore */ `${SERVER_BASE}/domain/services/MovementService.ts`
      )) as { MovementService: ServerMovementServiceCtor };
      const colMod = (await import(
        /* @vite-ignore */ `${SERVER_BASE}/domain/services/CollisionService.ts`
      )) as { CollisionService: new (tileSize: number) => unknown };
      return {
        MovementService: moveMod.MovementService,
        CollisionService: colMod.CollisionService,
      };
    })();
  }
  return serverModulesLoaded;
}

// ─── Server-side Player adapter (holds REAL Player state for validateAndMove) ─

/**
 * Thin adapter exposing exactly the Player surface that MovementService and the
 * GameSimulation movement pipeline read/write. The RULES run inside the real
 * MovementService.validateAndMove (loaded across packages); this object only
 * carries the state that rules-bearing code mutates. Mirrors PlayerMovement's
 * movement fields + the dash/stagger methods the DashCommand / step8 pipeline
 * calls. Single-player: no other alive players, so resolvePlayerCollision /
 * resolveDashEndOverlap loop over an empty alive set (no-op).
 */
export class ServerPlayerAdapter {
  readonly id = 'p1';
  isActive = true;
  private staggered = false;
  readonly movement: {
    position: { x: number; y: number };
    velocityX: number;
    velocityY: number;
    speed: { value: number; max: number };
    lastMoveDirection: { toVector: () => { dx: number; dy: number } };
    isDashing: boolean;
    facingAngle: number;
  } = {
    position: { x: 0, y: 0 },
    velocityX: 0,
    velocityY: 0,
    speed: {
      value: PLAYER.BASE_SPEED as number,
      max: (PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER) as number,
    },
    // Overwritten by the real validateAndMove with a real Direction object
    // (Direction.fromVector). Initial placeholder exposes toVector() for the
    // coast pass before the first MOVE lands.
    lastMoveDirection: {
      toVector: () => ({ dx: 0, dy: 0 }),
    },
    isDashing: false,
    facingAngle: 0,
  };

  isStaggered(): boolean {
    return this.staggered;
  }
  setStaggered(v: boolean): void {
    this.staggered = v;
  }
  setSpeedValue(value: number): void {
    this.movement.speed.value = value;
  }
  // --- dash lifecycle (mirrors PlayerMovement.startDash/endDash/
  //     startDashSpeed/endDashSpeed) ---
  startDash(): void {
    this.movement.isDashing = true;
  }
  endDash(): void {
    this.movement.isDashing = false;
  }
  // startDashSpeed sets value = baseSpeed * DASH_SPEED_MULTIPLIER (NOT the
  // powered-up value) — see PlayerMovement.startDashSpeed.
  startDashSpeed(): void {
    this.movement.speed.value = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
  }
  endDashSpeed(): void {
    this.movement.speed.value = PLAYER.BASE_SPEED;
  }
}

// ─── Server-authoritative sim (replicates GameSimulation movement pipeline) ──

export interface ServerTickInput {
  /** MOVE bucket contents for this tick: {dx,dy} or null if no MOVE arrived. */
  move: { dx: number; dy: number } | null;
  /** True if a DASH action edge is in this tick's bucket. */
  dashEdge: boolean;
}

/**
 * Wraps a ServerPlayerAdapter + the REAL MovementService and applies the
 * GameSimulation per-tick movement sequence. The order mirrors:
 *   step1_ProcessInputs  — MOVE processed before DASH (room/handlers/input.ts
 *                          enqueues MOVE then iterates actions[]), then the
 *                          momentum-coast pass for players with velocity who
 *                          received no MOVE this tick.
 *   step8_ExpireTimers    — dash ends when tick - dashStartTick >=
 *                          DASH_DURATION_TICKS (velocity zeroed AFTER step1).
 */
export class ServerAuthSim {
  readonly player: ServerPlayerAdapter;
  private readonly movementService: ServerMovementService;
  private readonly grid: TileType[][];
  private readonly forEachAliveNoop = (_cb: (p: unknown) => void) => {
    /* single-player: no other alive players */
  };
  dashStartTick = -1;

  constructor(
    movementService: ServerMovementService,
    grid: TileType[][],
    spawnX: number,
    spawnY: number,
  ) {
    this.player = new ServerPlayerAdapter();
    this.player.movement.position = { x: spawnX, y: spawnY };
    this.movementService = movementService;
    this.grid = grid;
  }

  /** Apply one server tick of the movement pipeline. */
  stepTick(tick: number, input: ServerTickInput): void {
    const p = this.player;
    let movedThisTick = false;

    // ── step1: MOVE (enqueued before DASH by the input handler) ──
    if (input.move) {
      const result = this.movementService.validateAndMove(
        p,
        input.move.dx,
        input.move.dy,
        SIM_TICK_DT,
        this.grid,
      );
      if (result.moved) {
        const resolved = this.movementService.resolvePlayerCollision(
          p,
          this.forEachAliveNoop,
          result.correctedPosition,
          tick,
        );
        p.movement.position = { x: resolved.x, y: resolved.y };
      }
      movedThisTick = true;
    }

    // ── step1: DASH edge (DashCommand.execute — canStartDash gate) ──
    if (input.dashEdge && !p.movement.isDashing && !p.isStaggered()) {
      p.startDash();
      p.startDashSpeed();
      // Direction: from the move input this tick, else facingAngle, else +X.
      let dirX: number;
      let dirY: number;
      if (input.move && (input.move.dx !== 0 || input.move.dy !== 0)) {
        const len = Math.hypot(input.move.dx, input.move.dy);
        dirX = input.move.dx / len;
        dirY = input.move.dy / len;
      } else {
        dirX = Math.cos(p.movement.facingAngle);
        dirY = Math.sin(p.movement.facingAngle);
        const len = Math.hypot(dirX, dirY);
        if (len > 0) {
          dirX /= len;
          dirY /= len;
        } else {
          dirX = 1;
          dirY = 0;
        }
      }
      const dashSpeed = p.movement.speed.value; // = BASE_SPEED * MULT after startDashSpeed
      p.movement.velocityX = dirX * dashSpeed;
      p.movement.velocityY = dirY * dashSpeed;
      this.dashStartTick = tick;
    }

    // ── step1: momentum-coast pass (players with velocity who got no MOVE) ──
    if (!movedThisTick && (p.movement.velocityX !== 0 || p.movement.velocityY !== 0)) {
      const dir = p.movement.lastMoveDirection.toVector();
      const result = this.movementService.validateAndMove(
        p,
        dir.dx,
        dir.dy,
        SIM_TICK_DT,
        this.grid,
      );
      if (result.moved) {
        const resolved = this.movementService.resolvePlayerCollision(
          p,
          this.forEachAliveNoop,
          result.correctedPosition,
          tick,
        );
        p.movement.position = { x: resolved.x, y: resolved.y };
      }
    }

    // ── step8: dash end (after step1 movement, exactly as GameSimulation) ──
    if (
      p.movement.isDashing &&
      this.dashStartTick >= 0 &&
      tick - this.dashStartTick >= PLAYER.DASH_DURATION_TICKS
    ) {
      p.endDashSpeed();
      p.endDash();
      p.movement.velocityX = 0;
      p.movement.velocityY = 0;
      const resolved = this.movementService.resolveDashEndOverlap(
        p,
        this.forEachAliveNoop,
        this.grid,
      );
      p.movement.position = { x: resolved.x, y: resolved.y };
    }
  }
}

// ─── Client stack (real PredictionService + Reconciler + ClientCollisionService) ─

/** Stub MapRenderer that returns the harness grid (non-enriched collision path). */
function makeStubMapRenderer(grid: TileType[][], tileSize: number): unknown {
  return {
    getGrid: () => grid,
    getTileSize: () => tileSize,
    getAtlas: () => null, // forces non-enriched MTV path (matches server resolveSimple)
    getVisualLayers: () => [],
    getSiegeWallVisual: () => null,
  };
}

export interface PatchResult {
  /** Whether applyReconciledPosition snapped (the REAL correction signal). */
  wasCorrected: boolean;
  /** Genuine posError after rewind-replay: |reconciledPos − localPosBefore|. */
  genuinePosError: number;
  /** Raw |serverPatchPos − clientLocalPos| at patch arrival (pre-reconcile). */
  rawPosError: number;
}

export interface ClientStack {
  gameState: GameState;
  predictionService: PredictionService;
  inputBuffer: InputBuffer;
  reconciler: Reconciler;
  /**
   * The REAL ClientCollisionService instance the PredictionService resolves
   * against. Exposed (NET-28) so PvP probes can drive `setNearbyPlayers` each
   * frame with interpolated/lagged remote-player positions — the same seam
   * GameScene feeds at `GameScene.ts:503`. Pure additive: existing callers
   * ignore this field.
   */
  collisionService: ClientCollisionService;
  /** Step the prediction one render frame. */
  stepPrediction: (params: {
    dirX: number;
    dirY: number;
    dt: number;
    mySpeed: number;
    isStaggered: boolean;
    edges: string[];
    sendFrame: InputFrame | null;
  }) => void;
  /** Reconcile a server patch through the REAL Reconciler + threshold gate. */
  reconcilePatch: (
    patch: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      lastSeq: number;
      /**
       * NET-23 — server-authoritative walk-speed scalar at the patch's send
       * tick (mirrors PlayerSchema.speed). The replay integrates the unacked
       * window with this value instead of each record's stale rec.speed.
       * Optional: matched-physics harnesses that don't model speed changes
       * omit it and the replay seeds at BASE_SPEED (the legacy default).
       */
      speed?: number;
      /** NET-23 — server-authoritative staggered flag at the patch's send tick. */
      isStaggered?: boolean;
    },
    currentTick: number,
    rttMs: number,
  ) => PatchResult;
}

export function makeClientStack(
  grid: TileType[][],
  tileSize: number,
  spawnX: number,
  spawnY: number,
): ClientStack {
  const mapRenderer = makeStubMapRenderer(grid, tileSize);
  const collisionService = new ClientCollisionService(mapRenderer as never);

  const gameState = new GameState();
  gameState.localPos = { x: spawnX, y: spawnY };
  gameState.localVelocity = { x: 0, y: 0 };

  const inputBuffer = new InputBuffer();
  const reconciler = new Reconciler(inputBuffer, (x, y, halfW, halfH) =>
    collisionService.resolveCollision(x, y, halfW, halfH),
  );
  const predictionService = new PredictionService(collisionService, inputBuffer, gameState);

  return {
    gameState,
    predictionService,
    inputBuffer,
    reconciler,
    collisionService,
    stepPrediction: ({ dirX, dirY, dt, mySpeed, isStaggered, edges, sendFrame }) => {
      predictionService.step(dirX, dirY, dt, mySpeed, isStaggered, edges as never, sendFrame);
    },
    // Reconcile via the REAL Reconciler.reconcile (same instance the production
    // PlayerReconciler calls) + the REAL GameState.applyReconciledPosition
    // threshold gate. Bypasses only the RTT smoother (rtt passed in directly,
    // deterministic) and the telemetry log — the correction decision is
    // identical. Exposing the reconciled position lets us measure the genuine
    // posError (|reconciled − localPos|) regardless of whether the gate snapped.
    reconcilePatch: (patch, _tick, rttMs) => {
      const beforeLocal = { x: gameState.localPos.x, y: gameState.localPos.y };
      const rawPosError = Math.hypot(patch.x - beforeLocal.x, patch.y - beforeLocal.y);
      const recon = reconciler.reconcile(
        patch.x,
        patch.y,
        patch.lastSeq,
        beforeLocal.x,
        beforeLocal.y,
        patch.vx,
        patch.vy,
        // NET-23: integrate the replay window with the SERVER-AUTHORITATIVE
        // speed/stagger at the patch's send tick (mirrors what the production
        // PlayerReconciler derives from PlayerSchema.speed / status). Default
        // to BASE_SPEED/false for matched-physics harnesses that omit them.
        patch.speed ?? PLAYER.BASE_SPEED,
        patch.isStaggered ?? false,
      );
      // Genuine error = how far the rewind-replay's result lands from the
      // prediction. This is the error the threshold gate actually sees.
      const genuinePosError = Math.hypot(recon.x - beforeLocal.x, recon.y - beforeLocal.y);
      const wasCorrected = gameState.applyReconciledPosition(
        recon.x,
        recon.y,
        recon.velocityX,
        recon.velocityY,
        rttMs,
      );
      void _tick;
      return { wasCorrected, genuinePosError, rawPosError };
    },
  };
}

// ─── Grid builders ──────────────────────────────────────────────────────────

const EMPTY_TILE = 0 as TileType;
const WALL_TILE = 1 as TileType;

export function makeOpenGrid(size: number): TileType[][] {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(EMPTY_TILE);
    grid.push(row);
  }
  return grid;
}

/** Set the given (gridX, gridY) cells to INDESTRUCTIBLE_WALL. */
export function setWalls(grid: TileType[][], cells: Array<[number, number]>): void {
  for (const [gx, gy] of cells) {
    if (grid[gy]) grid[gy]![gx] = WALL_TILE;
  }
}

/** Non-square grid (cols × rows) for the bounds-clamp cross-axis probe. */
export function makeOpenGridRect(cols: number, rows: number): TileType[][] {
  const grid: TileType[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < cols; x++) row.push(EMPTY_TILE);
    grid.push(row);
  }
  return grid;
}

// ─── Differential loop ──────────────────────────────────────────────────────

export interface ScenarioOptions {
  durationSec?: number;
  /** One-way latency (seconds). RTT = 2× this. Default 0 (localhost). */
  latencySec?: number;
  renderDt?: number;
  syncEveryN?: number;
  spawn?: { x: number; y: number };
  grid: TileType[][];
  tileSize: number;
  /** Live keyboard direction at wall-clock t (seconds), raw (not normalized). */
  directionAt: (tSec: number) => { dx: number; dy: number };
  /** DASH edge: true on render frames where dash was pressed. */
  dashEdgeAt?: (tSec: number, frameIndex: number) => boolean;
  /** Live server walk-speed value at tick T. Default BASE_SPEED. */
  serverSpeedAt?: (tick: number) => number;
  /** Live server staggered flag at tick T. Default false. */
  serverStaggeredAt?: (tick: number) => boolean;
  /** Override the production maxSpeed (hypothesis probes only). */
  maxSpeedOverride?: number;
}

export interface ScenarioResult {
  perTickPosError: number[];
  peakPosError: number;
  peakPosErrorTick: number;
  /** Patches where the REAL reconciler fired a correction. */
  correctionFires: number;
  /** Peak genuine posError after rewind-replay. */
  peakGenuinePosError: number;
  /** Peak raw |serverPatch − clientLocal| across all patches (pre-reconcile). */
  peakRawPatchError: number;
  finalDivergence: number;
  totalTicks: number;
  snapThreshold: number;
  /** Ticks where raw per-tick posError >= snapThreshold. */
  ticksOverRawThreshold: number;
  serverEnd: { x: number; y: number };
  clientEnd: { x: number; y: number };
  /**
   * NET-23 — raw |server − client| sampled in the STEADY-STATE window (at ~60%
   * of total ticks), excluding both the warmup/transient (first ~20%) and the
   * end-flush artifact (last ~10%, where the harness advances the server past
   * the client's last prediction step). This is the faithful measure of whether
   * a speed/stagger change leaves a PERSISTENT offset: `finalDivergence` is
   * noisy for speed-up scenarios because the boosted server outruns the frozen
   * client during the end-flush, inflating the last-tick reading even though
   * the steady-state offset has converged.
   */
  steadyStateDivergence: number;
  /** The tick index (1-based) sampled for steadyStateDivergence. */
  steadyStateTick: number;
  /**
   * NET-23 — genuine posError (|reconciled − localPos|, what the threshold gate
   * actually sees) sampled at the STEADY-STATE patch (~60% of patches). This is
   * the faithful measure of whether the speed/stagger desync is still MASKED:
   * if the replay integrates with the stale client speed, the genuine error
   * stays ~0 (the replay reconstructs the client's wrong trajectory); once the
   * replay uses the server-authoritative speed, the genuine error reveals any
   * residual desync. A converged steady-state shows this at ~0 (well under the
   * snap threshold), distinct from the transient `peakGenuinePosError` spike at
   * the speed-change boundary.
   */
  steadyStateGenuinePosError: number;
}

/**
 * Run the differential scenario. Mirrors the transition-drift-repro loop shape
 * (latency queues, per-tick patching) but drives the REAL server path.
 */
export async function runDifferentialScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  const { MovementService, CollisionService } = await loadServerModules();
  const durationSec = opts.durationSec ?? 1.2;
  const latencySec = opts.latencySec ?? 0;
  const renderDt = opts.renderDt ?? SIM_TICK_DT;
  const syncEveryN = opts.syncEveryN ?? 1;
  const inputSendIntervalMs = 16;
  const spawn = opts.spawn ?? { x: 640, y: 640 };
  const maxSpeed = opts.maxSpeedOverride ?? PRODUCTION_MAX_SPEED;

  const tileSize = opts.tileSize;
  const collisionService = new CollisionService(tileSize);
  const movementService = new MovementService(collisionService, maxSpeed, tileSize);

  const server = new ServerAuthSim(movementService, opts.grid, spawn.x, spawn.y);
  const client = makeClientStack(opts.grid, tileSize, spawn.x, spawn.y);

  const rttMs = latencySec * 1000 * 2;
  const snapThreshold = computeSnapThreshold(rttMs);

  const inflightInputs = new Map<
    number,
    { dx: number; dy: number; dashEdge: boolean; seq: number; arrivalSec: number }
  >();
  const inflightPatches = new Map<
    number,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      lastSeq: number;
      arrivalSec: number;
      sendTick: number;
      speedAtSend: number;
      staggeredAtSend: boolean;
    }
  >();
  const inputBucket = new Map<number, { dx: number; dy: number; dashEdge: boolean; seq: number }>();

  const perTickPosError: number[] = [];
  const perPatchGenuinePosError: number[] = [];
  let correctionFires = 0;
  let peakGenuinePosError = 0;
  let peakRawPatchError = 0;
  let ticksOverRawThreshold = 0;

  let currentTick = 0;
  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;
  // Server's lastProcessedInput — persists across ticks, updated ONLY when an
  // input bucket is processed (mirrors GameSimulation._lastProcessedInput).
  let serverLastSeq = 0;

  const initialSpeed = opts.serverSpeedAt ? opts.serverSpeedAt(0) : PLAYER.BASE_SPEED;
  const initialStaggered = opts.serverStaggeredAt ? opts.serverStaggeredAt(0) : false;
  let clientVisibleSpeed = initialSpeed;
  let clientVisibleStaggered = initialStaggered;

  const stepServer = (targetSec: number) => {
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      const tickWallSec = nextServerTickSec;

      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          inputBucket.set(currentTick, {
            dx: inp.dx,
            dy: inp.dy,
            dashEdge: inp.dashEdge,
            seq: inp.seq,
          });
          inflightInputs.delete(key);
        }
      }
      const bucket = inputBucket.get(currentTick);
      inputBucket.delete(currentTick);

      if (opts.serverSpeedAt) server.player.setSpeedValue(opts.serverSpeedAt(currentTick));
      if (opts.serverStaggeredAt) server.player.setStaggered(opts.serverStaggeredAt(currentTick));

      server.stepTick(currentTick, {
        move: bucket ? { dx: bucket.dx, dy: bucket.dy } : null,
        dashEdge: bucket?.dashEdge ?? false,
      });

      // Mirror GameSimulation._lastProcessedInput: advance only when an input
      // bucket was actually processed this tick (gap ticks leave it unchanged).
      if (bucket && bucket.seq > serverLastSeq) serverLastSeq = bucket.seq;

      if (currentTick - lastPatchSentAtTick >= syncEveryN) {
        lastPatchSentAtTick = currentTick;
        const patchArrivalSec = tickWallSec + latencySec;
        inflightPatches.set(patchArrivalSec, {
          x: server.player.movement.position.x,
          y: server.player.movement.position.y,
          vx: server.player.movement.velocityX,
          vy: server.player.movement.velocityY,
          lastSeq: serverLastSeq,
          arrivalSec: patchArrivalSec,
          sendTick: currentTick,
          speedAtSend: server.player.movement.speed.value,
          staggeredAtSend: server.player.isStaggered(),
        });
      }

      for (const [key, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(key);
          clientVisibleSpeed = patch.speedAtSend;
          clientVisibleStaggered = patch.staggeredAtSend;
          const result = client.reconcilePatch(
            {
              x: patch.x,
              y: patch.y,
              vx: patch.vx,
              vy: patch.vy,
              lastSeq: patch.lastSeq,
              // NET-23: the server-authoritative speed/stagger at the patch's
              // send tick — what the production PlayerReconciler reads off
              // PlayerSchema.speed / status at patch arrival.
              speed: patch.speedAtSend,
              isStaggered: patch.staggeredAtSend,
            },
            currentTick,
            rttMs,
          );
          if (result.wasCorrected) correctionFires++;
          if (result.genuinePosError > peakGenuinePosError) {
            peakGenuinePosError = result.genuinePosError;
          }
          perPatchGenuinePosError.push(result.genuinePosError);
          if (result.rawPosError > peakRawPatchError) peakRawPatchError = result.rawPosError;
          break;
        }
      }

      const rawErr = Math.hypot(
        server.player.movement.position.x - client.gameState.localPos.x,
        server.player.movement.position.y - client.gameState.localPos.y,
      );
      perTickPosError.push(rawErr);
      if (rawErr >= snapThreshold) ticksOverRawThreshold++;

      nextServerTickSec += SIM_TICK_DT;
    }
  };

  let frameIndex = 0;
  for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt) {
    const frameEndSec = nowSec + renderDt;
    stepServer(frameEndSec);
    nowSec = frameEndSec;

    const live = opts.directionAt(nowSec);
    const dashEdge = opts.dashEdgeAt ? opts.dashEdgeAt(nowSec, frameIndex) : false;

    let sendFrame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + inputSendIntervalMs / 1000;
      clientSeq++;
      sendFrame = {
        movementX: live.dx,
        movementY: live.dy,
        aimAngle: 0,
        sequence: clientSeq,
        actions: dashEdge ? ['DASH'] : [],
      };
      // unique key to allow multiple sends per render frame window
      inflightInputs.set(nowSec + clientSeq * 1e-9, {
        dx: live.dx,
        dy: live.dy,
        dashEdge,
        seq: clientSeq,
        arrivalSec: nowSec + latencySec,
      });
    }

    client.stepPrediction({
      dirX: live.dx,
      dirY: live.dy,
      dt: renderDt,
      mySpeed: clientVisibleSpeed,
      isStaggered: clientVisibleStaggered,
      edges: dashEdge ? ['DASH'] : [],
      sendFrame,
    });

    frameIndex++;
  }
  stepServer(nowSec + latencySec + SIM_TICK_DT);

  let peakPosError = 0;
  let peakPosErrorTick = 0;
  for (let i = 0; i < perTickPosError.length; i++) {
    if (perTickPosError[i]! > peakPosError) {
      peakPosError = perTickPosError[i]!;
      peakPosErrorTick = i + 1;
    }
  }

  // NET-23: sample the steady-state divergence at ~60% of total ticks — past
  // the warmup/transient (first ~20%) and before the end-flush artifact (last
  // ~10%, where the server outruns the frozen client during the final patch
  // flush). This is the faithful PERSISTENT-offset measure.
  const steadyIdx = Math.min(perTickPosError.length - 1, Math.floor(perTickPosError.length * 0.6));
  // NET-23: sample the steady-state GENUINE posError at ~60% of patches — the
  // faithful measure of whether the desync is still masked (genuine ~0 means
  // the replay reconstructed the client's wrong trajectory; genuine > 0 means
  // the server-authoritative replay revealed residual desync).
  const steadyPatchIdx = Math.min(
    Math.max(0, perPatchGenuinePosError.length - 1),
    Math.floor(perPatchGenuinePosError.length * 0.6),
  );

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
    steadyStateDivergence: perTickPosError[steadyIdx] ?? 0,
    steadyStateTick: steadyIdx + 1,
    steadyStateGenuinePosError: perPatchGenuinePosError[steadyPatchIdx] ?? 0,
  };
}
