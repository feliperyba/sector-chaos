/**
 * PvP-COLLISION HARNESS (NET-28) — multi-player extension of the
 * physics-divergence differential loop.
 *
 * The TASK-01 / NET-24 harnesses are SINGLE-PLAYER: `ServerAuthSim` passes a
 * no-op `forEachAlive` to `resolvePlayerCollision`, so the server's PvP
 * separation never runs and the client's `setNearbyPlayers` is never fed.
 * That blind spot is exactly the "near structures = near other players" half
 * of the sustained-walk symptom that NET-28 targets.
 *
 * This harness closes it by:
 *   (a) holding a SECOND player on the server side (`OtherPlayerAdapter`) — a
 *       thin read-only adapter over exactly the surface the REAL
 *       `MovementService.resolvePlayerCollision` reads (`other.id`,
 *       `other.isActive`, `other.hasDeathCollision(tick)`, `other.movement.isDashing`,
 *       `other.movement.position`),
 *   (b) driving the REAL `resolvePlayerCollision` every tick with a real
 *       `forEachAlive` that yields BOTH players id-sorted (the local p1 + the
 *       other p2),
 *   (c) feeding the REAL client `ClientCollisionService.setNearbyPlayers` each
 *       render frame with the other player's position, OPTIONALLY lagged by
 *       0/1/2/3 server ticks (a ring buffer of the other's authoritative
 *       positions) to model the ADR-0015/0020 interpolated-remote lag seam.
 *
 * Everything else mirrors `physics-divergence-harness.ts`:
 *   - Server path: the REAL `MovementService.validateAndMove` +
 *     `resolvePlayerCollision` (loaded across packages), wrapped in a faithful
 *     replica of the GameSimulation per-tick movement pipeline (MOVE-before-
 *     DASH, momentum coast, step8 dash-end).
 *   - Client path: the REAL `PredictionService` + `simulatePhysicsStepInto` +
 *     `ClientCollisionService` (the C5 `setNearbyPlayers` / separation block at
 *     `ClientCollisionService.ts:42, 126–157`), reconciled by the REAL
 *     `Reconciler` + `GameState.applyReconciledPosition`.
 *
 * Determinism + cadence anchors are identical to the TASK-01 harness
 * (TICK_RATE=60, PATCH_RATE=60, INPUT_SEND_INTERVAL_MS=16, SIM_TICK_DT=1/60;
 * latency = fixed queue delay; time pinned by the input send cadence).
 */

import { PLAYER, SIM_TICK_DT, type TileType } from '@sector-battle/shared';
import { computeSnapThreshold } from '../../types.js';
import type { InputFrame } from '../../types.js';
import {
  loadServerModules,
  makeClientStack,
  makeOpenGrid,
  PRODUCTION_MAX_SPEED,
  ServerPlayerAdapter,
  type ServerMovementService,
  type ScenarioResult,
} from './physics-divergence-harness.js';

// ─── Other-player adapter (read-only surface for resolvePlayerCollision) ─────

/**
 * Minimal adapter exposing EXACTLY the Player surface the server's
 * `MovementService.resolvePlayerCollision` reads from each `other` in the alive
 * list:
 *   - `other.id`                      (self-skip + id-sort determinism)
 *   - `other.isActive`                (alive gate)
 *   - `other.hasDeathCollision(tick)` (dying-body collision gate, only if !isActive)
 *   - `other.movement.isDashing`      (dashing players are skipped)
 *   - `other.movement.position.x/y`   (the AABB center the separation resolves against)
 *
 * The other player is driven KINEMATICALLY by the scenario's `stepOther` hook
 * (its position is set directly each tick — like a remote/bot whose authoritative
 * trajectory comes from elsewhere). The server's REAL `resolvePlayerCollision`
 * runs against this position unchanged. This faithfully models "a second player
 * in the local player's PvP separation range": the local player gets shoved by
 * the other's current authoritative position every tick, exactly as in
 * production `MovePlayerCommand`.
 *
 * (Mutual separation — the other also being shoved by the local — is not modelled
 * because the other is a remote whose trajectory the server receives, not one
 * the local's prediction reconciles. The local's correction path depends only on
 * the separation applied to the LOCAL player against the other's position.)
 */
export class OtherPlayerAdapter {
  readonly id = 'p2';
  isActive = true;
  readonly movement: {
    position: { x: number; y: number };
    isDashing: boolean;
  };

  constructor(x: number, y: number) {
    this.movement = { position: { x, y }, isDashing: false };
  }

  hasDeathCollision(_currentTick: number): boolean {
    return false;
  }
}

// ─── Server-authoritative sim with a second player ──────────────────────────

export interface PvPOtherStep {
  /** Local player's authoritative position this tick (read-only context). */
  localX: number;
  localY: number;
  /** The local player's (normalized) input direction this tick. */
  dirX: number;
  dirY: number;
  /** Server tick index. */
  tick: number;
  /** Per-tick dt (SIM_TICK_DT). */
  dt: number;
}

export interface ServerTickInput {
  move: { dx: number; dy: number } | null;
  dashEdge: boolean;
}

/**
 * Mirrors `ServerAuthSim` (the local-player movement pipeline) but holds a
 * second player (`other`) and drives the REAL `resolvePlayerCollision` with a
 * real `forEachAlive` yielding BOTH players id-sorted. After the local player's
 * movement resolves each tick, `stepOther` advances the other player's
 * authoritative position (stationary / co-walking / oncoming).
 */
export class ServerAuthSimPvP {
  readonly player: ServerPlayerAdapter;
  readonly other: OtherPlayerAdapter;
  private readonly movementService: ServerMovementService;
  private readonly grid: TileType[][];
  /** Real forEachAlive yielding both players, id-sorted ('p1' < 'p2'). */
  private readonly forEachAlive: (cb: (p: unknown) => void) => void;
  private readonly stepOther: (pos: { x: number; y: number }, ctx: PvPOtherStep) => void;
  dashStartTick = -1;

  constructor(
    movementService: ServerMovementService,
    grid: TileType[][],
    spawnX: number,
    spawnY: number,
    otherSpawnX: number,
    otherSpawnY: number,
    stepOther: (pos: { x: number; y: number }, ctx: PvPOtherStep) => void,
  ) {
    this.player = new ServerPlayerAdapter();
    this.player.movement.position = { x: spawnX, y: spawnY };
    this.other = new OtherPlayerAdapter(otherSpawnX, otherSpawnY);
    this.movementService = movementService;
    this.grid = grid;
    this.stepOther = stepOther;
    // id-sorted: 'p1' < 'p2'. resolvePlayerCollision skips the moving player by
    // id, so when resolving p1 it processes p2 (and vice versa). The cache inside
    // MovementService stores references; reads of `.movement.position` are live.
    this.forEachAlive = (cb) => {
      cb(this.player);
      cb(this.other);
    };
  }

  stepTick(tick: number, input: ServerTickInput): void {
    const p = this.player;
    let movedThisTick = false;
    let dirX = 0;
    let dirY = 0;

    // ── step1: MOVE (enqueued before DASH by the input handler) ──
    if (input.move) {
      const mag = Math.hypot(input.move.dx, input.move.dy);
      dirX = mag > 0 ? input.move.dx / mag : 0;
      dirY = mag > 0 ? input.move.dy / mag : 0;
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
          this.forEachAlive,
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
      let dashDirX: number;
      let dashDirY: number;
      if (input.move && (input.move.dx !== 0 || input.move.dy !== 0)) {
        const len = Math.hypot(input.move.dx, input.move.dy);
        dashDirX = input.move.dx / len;
        dashDirY = input.move.dy / len;
      } else {
        dashDirX = Math.cos(p.movement.facingAngle);
        dashDirY = Math.sin(p.movement.facingAngle);
        const len = Math.hypot(dashDirX, dashDirY);
        if (len > 0) {
          dashDirX /= len;
          dashDirY /= len;
        } else {
          dashDirX = 1;
          dashDirY = 0;
        }
      }
      const dashSpeed = p.movement.speed.value;
      p.movement.velocityX = dashDirX * dashSpeed;
      p.movement.velocityY = dashDirY * dashSpeed;
      this.dashStartTick = tick;
    }

    // ── step1: momentum-coast pass (players with velocity who got no MOVE) ──
    if (!movedThisTick && (p.movement.velocityX !== 0 || p.movement.velocityY !== 0)) {
      const dir = p.movement.lastMoveDirection.toVector();
      dirX = dir.dx;
      dirY = dir.dy;
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
          this.forEachAlive,
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
        this.forEachAlive,
        this.grid,
      );
      p.movement.position = { x: resolved.x, y: resolved.y };
    }

    // ── drive the OTHER player's authoritative position for THIS tick ──
    // (After the local player resolved, mirroring the per-tick order: both
    // players' authoritative positions are settled by end-of-tick.)
    this.stepOther(
      this.other.movement.position,
      {
        localX: p.movement.position.x,
        localY: p.movement.position.y,
        dirX,
        dirY,
        tick,
        dt: SIM_TICK_DT,
      },
    );
  }
}

// ─── Other-player drivers (stationary / co-walking / oncoming) ──────────────

export type OtherDriver = (pos: { x: number; y: number }, ctx: PvPOtherStep) => void;

/** Stationary other player — position never moves. Lag is irrelevant (constant). */
export const stationaryOther: OtherDriver = () => {
  /* no-op: position stays at spawn */
};

/**
 * Co-walking other player — same direction as the local player's input, matched
 * speed (BASE_SPEED). Starts OUTSIDE overlap range and stays there → separation
 * is INERT → 0 corrections expected (the spec's negative control).
 */
export const coWalkingOther: OtherDriver = (pos, ctx) => {
  if (ctx.dirX === 0 && ctx.dirY === 0) return;
  const step = PLAYER.BASE_SPEED * ctx.dt;
  pos.x += ctx.dirX * step;
  pos.y += ctx.dirY * step;
};

/**
 * Oncoming other player — moves toward the local player's CURRENT authoritative
 * position at BASE_SPEED. Guarantees a sustained overlap window (the other
 * homes in, so even as the local gets shoved away the other follows), exercising
 * the lag seam against a MOVING other-position.
 */
export const oncomingOther: OtherDriver = (pos, ctx) => {
  const dx = ctx.localX - pos.x;
  const dy = ctx.localY - pos.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0.0001) return;
  const step = PLAYER.BASE_SPEED * ctx.dt;
  pos.x += (dx / len) * step;
  pos.y += (dy / len) * step;
};

// ─── PvP differential scenario ──────────────────────────────────────────────

export interface PvPScenarioOptions {
  durationSec?: number;
  /** One-way latency (seconds). RTT = 2× this. Default 0 (localhost). */
  latencySec?: number;
  renderDt?: number;
  syncEveryN?: number;
  spawn: { x: number; y: number };
  otherSpawn: { x: number; y: number };
  grid?: TileType[][];
  tileSize?: number;
  /** Live local-player direction at wall-clock t (raw, normalized internally). */
  directionAt: (tSec: number) => { dx: number; dy: number };
  /** Other-player driver (stationary / coWalking / oncoming). */
  stepOther: OtherDriver;
  /** Interpolated-remote lag in SERVER ticks (the ADR-0015/0020 seam). 0/1/2/3. */
  remoteLagTicks?: number;
  /**
   * NET-29: when true, model the production fix (feed `setNearbyPlayers` the
   * LATEST RECEIVED authoritative remote position, pre-interpolation). The lag
   * applied to the fed position is then ONLY the residual network delay
   * (`latencySec` one-way → `round(latencySec / SIM_TICK_DT)` ticks), NOT the
   * synthetic `remoteLagTicks` knob (which modeled the smoothing-buffer lag the
   * production fix eliminates). At localhost this is 0 ticks regardless of the
   * `remoteLagTicks` knob — the oncoming+lag≥2 cells drop from 2–4 corrections
   * to 0. Default false (preserves the NET-28 characterization mode that
   * measures "what would happen under N patches of smoothing lag").
   */
  feedLatestReceived?: boolean;
}

/**
 * Run the PvP differential scenario. Shape mirrors `runDifferentialScenario`
 * (latency queues, per-tick patching, rewind-replay via the REAL Reconciler) but
 * with a second player on the server + lagged `setNearbyPlayers` on the client.
 *
 * Returns the same ScenarioResult shape so the existing headline/report helpers
 * reuse directly, plus PvP-specific overlap telemetry.
 */
export async function runPvPScenario(opts: PvPScenarioOptions): Promise<ScenarioResult & {
  /** Server ticks where the local + other AABBs overlapped (separation fired). */
  overlapTicks: number;
  /** Peak |server − client| sampled DURING an overlap tick (the PvP-relevant divergence). */
  peakOverlapDivergence: number;
}> {
  const { MovementService, CollisionService } = await loadServerModules();
  const durationSec = opts.durationSec ?? 1.2;
  const latencySec = opts.latencySec ?? 0;
  const renderDt = opts.renderDt ?? SIM_TICK_DT;
  const syncEveryN = opts.syncEveryN ?? 1;
  const inputSendIntervalMs = 16;
  const spawn = opts.spawn;
  const otherSpawn = opts.otherSpawn;
  const tileSize = opts.tileSize ?? 128;
  const grid = opts.grid ?? makeOpenGrid(24);
  const maxSpeed = PRODUCTION_MAX_SPEED;
  const remoteLagTicks = opts.remoteLagTicks ?? 0;

  const serverCollision = new CollisionService(tileSize);
  const movementService = new MovementService(serverCollision, maxSpeed, tileSize);

  const server = new ServerAuthSimPvP(
    movementService,
    grid,
    spawn.x,
    spawn.y,
    otherSpawn.x,
    otherSpawn.y,
    opts.stepOther,
  );
  const client = makeClientStack(grid, tileSize, spawn.x, spawn.y);

  const rttMs = latencySec * 1000 * 2;
  const snapThreshold = computeSnapThreshold(rttMs);

  // NET-29: when modeling the production fix (feedLatestReceived=true), the lag
  // applied to the position fed to setNearbyPlayers is ONLY the residual
  // network delay (latencySec one-way → round(latencySec / SIM_TICK_DT) ticks).
  // The synthetic `remoteLagTicks` knob — which modeled the smoothing-buffer lag
  // the production fix eliminates — is bypassed. At localhost this is 0 ticks
  // regardless of `remoteLagTicks`. In the default characterization mode
  // (feedLatestReceived=false) the synthetic knob is honored as before.
  const feedLatestReceived = opts.feedLatestReceived ?? false;
  const effectiveLagTicks = feedLatestReceived
    ? Math.round(latencySec / SIM_TICK_DT)
    : remoteLagTicks;

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
  const inputBucket = new Map<
    number,
    { dx: number; dy: number; dashEdge: boolean; seq: number }
  >();

  // Ring buffer of the other player's authoritative position at each server
  // tick (for the interpolated-remote lag seam). Indexed by tick; we keep the
  // last (effectiveLagTicks+1) entries.
  const otherPosHistory = new Map<number, { x: number; y: number }>();
  const laggedPosAt = (tick: number): { x: number; y: number } => {
    const idx = Math.max(0, tick - effectiveLagTicks);
    return otherPosHistory.get(idx) ?? otherSpawn;
  };

  const perTickPosError: number[] = [];
  const perPatchGenuinePosError: number[] = [];
  let correctionFires = 0;
  let peakGenuinePosError = 0;
  let peakRawPatchError = 0;
  let ticksOverRawThreshold = 0;
  let overlapTicks = 0;
  let peakOverlapDivergence = 0;

  let currentTick = 0;
  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;
  let serverLastSeq = 0;

  let clientVisibleSpeed: number = PLAYER.BASE_SPEED;
  let clientVisibleStaggered = false;

  const HALF = PLAYER.HITBOX_WIDTH / 2;

  // PvP "in-separation-range" test. The server's resolvePlayerCollision
  // resolves overlap to EXACTLY touching (centers HITBOX apart, depth→0), so a
  // strict-overlap (< HITBOX) check on the post-separation authoritative
  // positions reads as non-overlapping at steady state. Use <= (contact-or-
  // overlap) to count every tick where the separation was actively maintaining
  // the gap (the local player is pressed against the other). This matches the
  // production "worse near structures" surface: the player is IN CONTACT with
  // another player, not merely passing through.
  const aabbInContact = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean => {
    return (
      Math.abs(a.x - b.x) <= PLAYER.HITBOX_WIDTH &&
      Math.abs(a.y - b.y) <= PLAYER.HITBOX_HEIGHT
    );
  };

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

      server.stepTick(currentTick, {
        move: bucket ? { dx: bucket.dx, dy: bucket.dy } : null,
        dashEdge: bucket?.dashEdge ?? false,
      });

      // Record the other's authoritative position for the lag ring buffer.
      otherPosHistory.set(currentTick, {
        x: server.other.movement.position.x,
        y: server.other.movement.position.y,
      });
      // Trim the ring buffer (keep last effectiveLagTicks+4 entries for safety).
      if (otherPosHistory.size > effectiveLagTicks + 4) {
        const oldest = Math.min(...otherPosHistory.keys());
        otherPosHistory.delete(oldest);
      }

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

      // Track contact ticks (server-side: local vs other authoritative AABB).
      // `aabbInContact` counts touching OR overlapping — the steady-state after
      // resolvePlayerCollision is "just touching" (centers HITBOX apart), which
      // is the production "pressed against another player" surface.
      if (
        aabbInContact(
          server.player.movement.position,
          server.other.movement.position,
        )
      ) {
        overlapTicks++;
        if (rawErr > peakOverlapDivergence) peakOverlapDivergence = rawErr;
      }

      nextServerTickSec += SIM_TICK_DT;
    }
  };

  let frameIndex = 0;
  for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt) {
    const frameEndSec = nowSec + renderDt;
    stepServer(frameEndSec);
    nowSec = frameEndSec;

    const live = opts.directionAt(nowSec);
    const dashEdge = false; // walk scenarios only — dash is out of scope for NET-28

    // Feed the client's setNearbyPlayers the lagged other position. Two modes:
    //   - feedLatestReceived=false (default, NET-28 characterization): models the
    //     smoothing-buffer lag seam. Production PRE-NET-29 fed the INTERPOLATED
    //     remote (renderer's smoothed view); we feed the authoritative position
    //     lagged by `remoteLagTicks` server ticks. With lag=0 the client sees
    //     the same position the server resolves against; with lag>0 it resolves
    //     against a stale circle.
    //   - feedLatestReceived=true (NET-29 regression gate): models the
    //     production fix. Production POST-NET-29 feeds the LATEST RECEIVED
    //     authoritative position (pre-interpolation); the only residual lag is
    //     the network delay (`latencySec` one-way → effectiveLagTicks). At
    //     localhost this is 0 regardless of `remoteLagTicks`, so the lag seam
    //     the C5 separation was resolving against is gone.
    const lagged = laggedPosAt(currentTick);
    client.collisionService.setNearbyPlayers([lagged], 1);

    let sendFrame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + inputSendIntervalMs / 1000;
      clientSeq++;
      sendFrame = {
        movementX: live.dx,
        movementY: live.dy,
        aimAngle: 0,
        sequence: clientSeq,
        actions: [],
      };
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
      edges: [],
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

  const steadyIdx = Math.min(
    perTickPosError.length - 1,
    Math.floor(perTickPosError.length * 0.6),
  );
  const steadyPatchIdx = Math.min(
    Math.max(0, perPatchGenuinePosError.length - 1),
    Math.floor(perPatchGenuinePosError.length * 0.6),
  );

  void HALF;

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
    overlapTicks,
    peakOverlapDivergence,
  };
}
