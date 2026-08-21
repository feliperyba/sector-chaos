import { describe, it, expect } from 'vitest';
import {
  PLAYER,
  COMBAT,
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  AABBCollision,
  TileType,
  type TileVisual,
  type TiledMapLayer,
  type TileSpriteAtlas,
  type CollisionFn,
  type AABB,
  type MTV,
} from '@sector-battle/shared';
import { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../PredictionService.js';
import { InputBuffer } from '../InputBuffer.js';
import { Reconciler } from '../Reconciler.js';
import { PlayerReconciler } from '../../bridges/state-sync/PlayerReconciler.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ReconciliationLog, ReconciliationEntry } from '../../debug/ReconciliationLog.js';
import type { InputFrame } from '../../types.js';

/**
 * STUTTER REPRO — REAL collision (ClientCollisionService) + REAL
 * PredictionService + REAL Reconciler at a 30fps render rate (the user's
 * actual machine rate), driving sustained movement into a wall.
 *
 * The client prediction, the reconciler replay, AND the server shadow all use
 * the SAME ClientCollisionService over the SAME grid — collision is MATCHED by
 * construction (collision-divergence.test proves the algorithm agrees). So:
 *  - If corrections stay ZERO here, the live divergence is NOT the collision
 *    algorithm and NOT the 30fps render rate — it's a live DATA mismatch
 *    (client/server grids or visuals differ in the real game) or another
 *    server-pipeline difference.
 *  - If corrections fire here, the bug is reproducible in-test and we fix it
 *    test-first.
 */

const TILE_SIZE = 128;
const HALF_W = 48;
const HALF_H = 48;

const PHYSICS_CONFIG = {
  acceleration: PLAYER.ACCELERATION,
  deceleration: PLAYER.DECELERATION,
  dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
  dashDurationTicks: PLAYER.DASH_DURATION_TICKS,
  staggerMoveSpeedPenalty: COMBAT.STAGGER_MOVE_SPEED_PENALTY,
  playerHalfW: HALF_W,
  playerHalfH: HALF_H,
  baseSpeed: PLAYER.BASE_SPEED,
};

function floorVisual(): TileVisual {
  return { spriteId: 0, rotation: 0, flipH: false, flipV: false };
}
function wallVisual(): TileVisual {
  return { spriteId: 1, rotation: 0, flipH: false, flipV: false };
}

/** 8×8 grid with a wall the player will press against (row 4, col 5). */
function makeFixture(): {
  grid: number[][];
  atlas: TileSpriteAtlas;
  visualLayers: TiledMapLayer[];
} {
  const rows = 8;
  const cols = 8;
  const grid: number[][] = [];
  const floorCells: (TileVisual | null)[][] = [];
  const wallCells: (TileVisual | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const gridRow: number[] = [];
    const floorRow: (TileVisual | null)[] = [];
    const wallRow: (TileVisual | null)[] = [];
    for (let c = 0; c < cols; c++) {
      gridRow.push(0);
      floorRow.push(floorVisual());
      wallRow.push(null);
    }
    grid.push(gridRow);
    floorCells.push(floorRow);
    wallCells.push(wallRow);
  }
  grid[4]![5] = TileType.INDESTRUCTIBLE_WALL;
  wallCells[4]![5] = wallVisual();
  const atlas: TileSpriteAtlas = {
    sprites: [
      { id: 0, imagePath: 'floor', tileType: TileType.EMPTY, colliders: [] },
      {
        id: 1,
        imagePath: 'wall',
        tileType: TileType.INDESTRUCTIBLE_WALL,
        colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
      },
    ],
  };
  return {
    grid,
    atlas,
    visualLayers: [
      { name: 'floor', cells: floorCells },
      { name: 'decoration', cells: [] },
      { name: 'map_border_walls', cells: wallCells },
      { name: 'interactive_layer', cells: [] },
    ],
  };
}

function makeStubMapRenderer(
  grid: number[][],
  atlas: TileSpriteAtlas,
  visualLayers: TiledMapLayer[],
): MapRenderer {
  return {
    getGrid: () => grid,
    getTileSize: () => TILE_SIZE,
    getAtlas: () => atlas,
    getVisualLayers: () => visualLayers,
    getSiegeWallVisual: () => null,
  } as unknown as MapRenderer;
}

/**
 * Wrap a tile-collision fn with player-vs-player MTV separation — a faithful
 * model of the server's MovementService.resolvePlayerCollision (applied AFTER
 * tile collision in MovePlayerCommand). The client's ClientCollisionService
 * does NOT do this; this helper lets the shadow (server) shove the local
 * player against other players while the client predicts straight through.
 */
function withPlayerVsPlayer(
  tileFn: CollisionFn,
  others: () => Array<{ x: number; y: number }>,
): CollisionFn {
  const mtv: MTV = { x: 0, y: 0, depth: 0 };
  return (cx, cy, halfW, halfH) => {
    const resolved = tileFn(cx, cy, halfW, halfH);
    let px = resolved.x;
    let py = resolved.y;
    for (const o of others()) {
      const moving: AABB = { x: px - halfW, y: py - halfH, width: halfW * 2, height: halfH * 2 };
      const otherAabb: AABB = {
        x: o.x - halfW,
        y: o.y - halfH,
        width: halfW * 2,
        height: halfH * 2,
      };
      if (AABBCollision.getMTVInto(moving, otherAabb, mtv)) {
        const ox = mtv.x !== 0 ? mtv.x * mtv.depth : 0;
        const oy = mtv.y !== 0 ? mtv.y * mtv.depth : 0;
        px += ox;
        py += oy;
      }
    }
    return { x: px, y: py };
  };
}

/** Server shadow: 60Hz, matched collision, coasts on lastMoveDirection. */
class MatchedShadow {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  lastProcessedInput = 0;
  private readonly state = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: PLAYER.BASE_SPEED,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: false,
  };
  private readonly input = { dx: 0, dy: 0, hasDash: false, dashDirX: 0, dashDirY: 0 };
  private readonly collision: CollisionFn;
  private readonly bucket = new Map<number, { dx: number; dy: number; seq: number }>();
  private lastDx = 0;
  private lastDy = 0;
  constructor(collision: CollisionFn, x: number, y: number) {
    this.collision = collision;
    this.x = x;
    this.y = y;
  }
  enqueue(tick: number, dx: number, dy: number, seq: number): void {
    this.bucket.set(tick, { dx, dy, seq });
  }
  step(tick: number): void {
    const queued = this.bucket.get(tick);
    if (queued) {
      if (queued.seq > this.lastProcessedInput) this.lastProcessedInput = queued.seq;
      if (queued.dx !== 0 || queued.dy !== 0) {
        const mag = Math.hypot(queued.dx, queued.dy);
        this.lastDx = queued.dx / mag;
        this.lastDy = queued.dy / mag;
      } else {
        this.lastDx = 0;
        this.lastDy = 0;
      }
    }
    this.state.x = this.x;
    this.state.y = this.y;
    this.state.vx = this.vx;
    this.state.vy = this.vy;
    this.input.dx = queued ? queued.dx : this.lastDx;
    this.input.dy = queued ? queued.dy : this.lastDy;
    simulatePhysicsStepInto(this.state, this.input, PHYSICS_CONFIG, this.collision, SIM_TICK_DT);
    this.x = this.state.x;
    this.y = this.state.y;
    this.vx = this.state.vx;
    this.vy = this.state.vy;
  }
}

interface RunResult {
  corrections: number;
  maxPosError: number;
  maxDivergence: number;
  endLocalX: number;
  endShadowX: number;
}

function run(opts: {
  renderDt: number;
  durationSec: number;
  latencySec: number;
  syncEveryN: number;
  walkIntoWall?: boolean;
  /** Static bot position the local player will collide with (player-vs-player). */
  bot?: { x: number; y: number };
  /** When true, the client prediction is bot-aware (setNearbyPlayers each frame). */
  clientBotAware?: boolean;
}): RunResult {
  const fixture = makeFixture();
  const startX = opts.walkIntoWall ? 200 : 100;
  const startY = 4 * TILE_SIZE + HALF_H;

  const stubMap = makeStubMapRenderer(fixture.grid, fixture.atlas, fixture.visualLayers);
  const ccs = new ClientCollisionService(stubMap);
  // Client collision fn (tile-only by default; bot-aware when setNearbyPlayers
  // is fed each frame). Used by prediction (via ccs) and replay (via this fn).
  const clientFn: CollisionFn = (cx, cy) => ccs.resolveCollision(cx, cy, HALF_W, HALF_H);
  // Server collision fn: tile + player-vs-player (matches MovementService).
  const bot = opts.bot;
  const others = bot ? () => [bot] : () => [];
  const serverFn: CollisionFn = bot ? withPlayerVsPlayer(clientFn, others) : clientFn;

  const gameState = new GameState();
  gameState.localPos = { x: startX, y: startY };
  gameState.localVelocity = { x: 0, y: 0 };
  const inputBuffer = new InputBuffer();
  const reconcilerCore = new Reconciler(inputBuffer, clientFn);
  const predictionService = new PredictionService(ccs, inputBuffer, gameState);

  const rttBox = { value: opts.latencySec * 1000 * 2 };
  let currentTick = 0;
  const reconEntries: Array<{ seq: number; wasCorrected: boolean }> = [];
  const reconLog: ReconciliationLog = {
    push: (e: ReconciliationEntry) =>
      reconEntries.push({ seq: e.seq, wasCorrected: e.wasCorrected }),
  } as unknown as ReconciliationLog;
  const reconciler = new PlayerReconciler({
    gameState,
    rtt: rttBox,
    inputBuffer,
    reconciler: reconcilerCore,
    stateSync: { value: { getTick: () => currentTick } as unknown as StateSync },
    reconciliationLog: { value: reconLog },
    isSpectating: { value: false },
  });

  const shadow = new MatchedShadow(serverFn, startX, startY);
  const inflightInputs = new Map<
    number,
    { dx: number; dy: number; seq: number; arrivalSec: number }
  >();
  const inflightPatches = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; lastSeq: number; arrivalSec: number }
  >();

  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;
  let corrections = 0;
  let maxPosError = 0;
  let maxDivergence = 0;

  const stepServer = (targetSec: number) => {
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      const tickWallSec = nextServerTickSec;
      let arriving: { dx: number; dy: number; seq: number } | null = null;
      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          arriving = inp;
          inflightInputs.delete(key);
          break;
        }
      }
      if (arriving) shadow.enqueue(currentTick, arriving.dx, arriving.dy, arriving.seq);
      shadow.step(currentTick);

      if (currentTick - lastPatchSentAtTick >= opts.syncEveryN) {
        lastPatchSentAtTick = currentTick;
        inflightPatches.set(tickWallSec + opts.latencySec, {
          x: shadow.x,
          y: shadow.y,
          vx: shadow.vx,
          vy: shadow.vy,
          lastSeq: shadow.lastProcessedInput,
          arrivalSec: tickWallSec + opts.latencySec,
        });
      }
      for (const [key, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(key);
          const before = reconEntries.length;
          reconciler.handleLocalPlayerPositionChange(
            patch.x,
            patch.y,
            patch.vx,
            patch.vy,
            patch.lastSeq,
            opts.latencySec * 1000 * 2,
          );
          if (reconEntries.length > before && reconEntries[reconEntries.length - 1]!.wasCorrected) {
            corrections++;
          }
          const err = Math.hypot(patch.x - gameState.localPos.x, patch.y - gameState.localPos.y);
          if (err > maxPosError) maxPosError = err;
          break;
        }
      }
      nextServerTickSec += SIM_TICK_DT;
    }
  };

  for (let elapsed = 0; elapsed < opts.durationSec; elapsed += opts.renderDt) {
    const frameEndSec = nowSec + opts.renderDt;
    stepServer(frameEndSec);
    nowSec = frameEndSec;
    // Feed the client prediction the bot position when bot-aware (C5 fix). When
    // NOT aware (the regression case), nearby stays empty → client predicts
    // through the bot while the server shoves → corrections.
    const nearby = opts.clientBotAware && bot ? [bot] : [];
    ccs.setNearbyPlayers(nearby, nearby.length);
    const dx = 1;
    const dy = 0;
    let sendFrame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + 16 / 1000;
      clientSeq++;
      sendFrame = { movementX: dx, movementY: dy, aimAngle: 0, sequence: clientSeq, actions: [] };
      inflightInputs.set(nowSec, { dx, dy, seq: clientSeq, arrivalSec: nowSec + opts.latencySec });
    }
    predictionService.step(dx, dy, opts.renderDt, PLAYER.BASE_SPEED, false, [], sendFrame);
    const div = Math.hypot(gameState.localPos.x - shadow.x, gameState.localPos.y - shadow.y);
    if (div > maxDivergence) maxDivergence = div;
  }
  stepServer(nowSec + opts.latencySec + SIM_TICK_DT);

  return {
    corrections,
    maxPosError,
    maxDivergence,
    endLocalX: gameState.localPos.x,
    endShadowX: shadow.x,
  };
}

/**
 * DESTRUCTIBLE GRID-SYNC harness. Two SEPARATE grids (client + server), each
 * with the wall at [4][5]. The server clears its grid cell at `serverClearTick`
 * (it destroyed the wall); the client clears its grid `lagTicks` later (the
 * destruction arrives via state sync after `lagTicks` of ticks). The local
 * player walks toward the wall. If `lagTicks` is small (localhost, ~1 tick),
 * the divergence window is tiny and stays under the snap threshold → no
 * correction. If `lagTicks` is large (high latency), the client blocks at a
 * wall the server no longer has → a large forward correction.
 */
function runGridSync(opts: {
  renderDt: number;
  durationSec: number;
  latencySec: number;
  syncEveryN: number;
  lagTicks: number;
  serverClearTick: number;
}): RunResult {
  const clientFix = makeFixture();
  const serverFix = makeFixture();
  const WALL_R = 4;
  const WALL_C = 5;
  const startX = 500;
  const startY = 4 * TILE_SIZE + HALF_H;

  const clientMap = makeStubMapRenderer(clientFix.grid, clientFix.atlas, clientFix.visualLayers);
  const serverMap = makeStubMapRenderer(serverFix.grid, serverFix.atlas, serverFix.visualLayers);
  const clientCCS = new ClientCollisionService(clientMap);
  const serverCCS = new ClientCollisionService(serverMap);
  const clientFn: CollisionFn = (cx, cy) => clientCCS.resolveCollision(cx, cy, HALF_W, HALF_H);
  const serverFn: CollisionFn = (cx, cy) => serverCCS.resolveCollision(cx, cy, HALF_W, HALF_H);

  const gameState = new GameState();
  gameState.localPos = { x: startX, y: startY };
  gameState.localVelocity = { x: 0, y: 0 };
  const inputBuffer = new InputBuffer();
  const reconcilerCore = new Reconciler(inputBuffer, clientFn);
  const predictionService = new PredictionService(clientCCS, inputBuffer, gameState);

  const rttBox = { value: opts.latencySec * 1000 * 2 };
  let currentTick = 0;
  const reconEntries: Array<{ seq: number; wasCorrected: boolean }> = [];
  const reconLog: ReconciliationLog = {
    push: (e: ReconciliationEntry) =>
      reconEntries.push({ seq: e.seq, wasCorrected: e.wasCorrected }),
  } as unknown as ReconciliationLog;
  const reconciler = new PlayerReconciler({
    gameState,
    rtt: rttBox,
    inputBuffer,
    reconciler: reconcilerCore,
    stateSync: { value: { getTick: () => currentTick } as unknown as StateSync },
    reconciliationLog: { value: reconLog },
    isSpectating: { value: false },
  });

  const shadow = new MatchedShadow(serverFn, startX, startY);
  const inflightInputs = new Map<
    number,
    { dx: number; dy: number; seq: number; arrivalSec: number }
  >();
  const inflightPatches = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; lastSeq: number; arrivalSec: number }
  >();

  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;
  let corrections = 0;
  let maxPosError = 0;
  let maxDivergence = 0;
  const clientClearTick = opts.serverClearTick + opts.lagTicks;

  const stepServer = (targetSec: number) => {
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      // Server destroys the wall at serverClearTick.
      if (currentTick === opts.serverClearTick) serverFix.grid[WALL_R]![WALL_C] = 0;
      // Client receives the destruction at clientClearTick (state-sync lag).
      if (currentTick === clientClearTick) clientFix.grid[WALL_R]![WALL_C] = 0;
      const tickWallSec = nextServerTickSec;
      let arriving: { dx: number; dy: number; seq: number } | null = null;
      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          arriving = inp;
          inflightInputs.delete(key);
          break;
        }
      }
      if (arriving) shadow.enqueue(currentTick, arriving.dx, arriving.dy, arriving.seq);
      shadow.step(currentTick);
      if (currentTick - lastPatchSentAtTick >= opts.syncEveryN) {
        lastPatchSentAtTick = currentTick;
        inflightPatches.set(tickWallSec + opts.latencySec, {
          x: shadow.x,
          y: shadow.y,
          vx: shadow.vx,
          vy: shadow.vy,
          lastSeq: shadow.lastProcessedInput,
          arrivalSec: tickWallSec + opts.latencySec,
        });
      }
      for (const [key, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(key);
          const before = reconEntries.length;
          reconciler.handleLocalPlayerPositionChange(
            patch.x,
            patch.y,
            patch.vx,
            patch.vy,
            patch.lastSeq,
            opts.latencySec * 1000 * 2,
          );
          if (reconEntries.length > before && reconEntries[reconEntries.length - 1]!.wasCorrected) {
            corrections++;
          }
          const err = Math.hypot(patch.x - gameState.localPos.x, patch.y - gameState.localPos.y);
          if (err > maxPosError) maxPosError = err;
          break;
        }
      }
      nextServerTickSec += SIM_TICK_DT;
    }
  };

  for (let elapsed = 0; elapsed < opts.durationSec; elapsed += opts.renderDt) {
    const frameEndSec = nowSec + opts.renderDt;
    stepServer(frameEndSec);
    nowSec = frameEndSec;
    const dx = 1;
    const dy = 0;
    let sendFrame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + 16 / 1000;
      clientSeq++;
      sendFrame = { movementX: dx, movementY: dy, aimAngle: 0, sequence: clientSeq, actions: [] };
      inflightInputs.set(nowSec, { dx, dy, seq: clientSeq, arrivalSec: nowSec + opts.latencySec });
    }
    predictionService.step(dx, dy, opts.renderDt, PLAYER.BASE_SPEED, false, [], sendFrame);
    const div = Math.hypot(gameState.localPos.x - shadow.x, gameState.localPos.y - shadow.y);
    if (div > maxDivergence) maxDivergence = div;
  }
  stepServer(nowSec + opts.latencySec + SIM_TICK_DT);

  return {
    corrections,
    maxPosError,
    maxDivergence,
    endLocalX: gameState.localPos.x,
    endShadowX: shadow.x,
  };
}

describe('stutter repro — matched collision + real pipeline at 30fps', () => {
  it('open-field walk @30fps localhost: ZERO corrections', () => {
    const r = run({ renderDt: 1 / 30, durationSec: 2.0, latencySec: 0.001, syncEveryN: 1 });
    console.log('[stutter-repro] open-field @30fps:', r);
    expect(r.corrections).toBe(0);
  });

  it('walk INTO wall @30fps localhost: ZERO corrections (matched collision)', () => {
    const r = run({
      renderDt: 1 / 30,
      durationSec: 2.0,
      latencySec: 0.001,
      syncEveryN: 1,
      walkIntoWall: true,
    });
    console.log('[stutter-repro] into-wall @30fps:', r);
    expect(r.corrections).toBe(0);
  });

  it('walk INTO wall @30fps + 150ms RTT: ZERO corrections', () => {
    const r = run({
      renderDt: 1 / 30,
      durationSec: 2.5,
      latencySec: 0.075,
      syncEveryN: 1,
      walkIntoWall: true,
    });
    console.log('[stutter-repro] into-wall @30fps @150msRTT:', r);
    expect(r.corrections).toBe(0);
  });
});

describe('stutter repro — player-vs-player collision (the live divergence source)', () => {
  // The local player starts at x=100, walks +X. A static bot sits at x=320
  // (same row, y=576). The server shoves the local player via
  // resolvePlayerCollision; the client's ClientCollisionService (tile-only)
  // does NOT → the client predicts through the bot → reconciliation
  // corrections fire. This reproduces the live "walk stutter" in-test.
  const BOT = { x: 320, y: 4 * TILE_SIZE + HALF_H };

  it('RED: walk into a bot, client NOT bot-aware → corrections fire (reproduces the stutter)', () => {
    const r = run({
      renderDt: 1 / 30,
      durationSec: 2.5,
      latencySec: 0.075,
      syncEveryN: 1,
      bot: BOT,
      clientBotAware: false,
    });
    console.log('[stutter-repro] into-bot, client NOT aware (RED):', r);
    // The bug: the client predicts through the bot while the server shoves →
    // the client races ahead → corrections fire every patch.
    expect(r.corrections).toBeGreaterThan(0);
  });

  it('GREEN: walk into a bot, client bot-aware (setNearbyPlayers) → ZERO corrections', () => {
    const r = run({
      renderDt: 1 / 30,
      durationSec: 2.5,
      latencySec: 0.075,
      syncEveryN: 1,
      bot: BOT,
      clientBotAware: true,
    });
    console.log('[stutter-repro] into-bot, client bot-aware (GREEN):', r);
    // C5 fix: with the client predicting the same player-vs-player separation
    // as the server, the prediction tracks the server → no corrections.
    expect(r.corrections).toBe(0);
  });
});

describe('stutter repro — destructible grid-sync lag (the "near walls" suspect)', () => {
  // Player walks +X from x=500 toward the wall at [4][5] (blocks at x≈592).
  // The server destroys it at serverClearTick=30 (~0.5s, before the player
  // arrives). The client grid clears `lagTicks` later (state-sync arrival).

  it('LOCALHOST (lagTicks=1, ~16ms): destructible grid-sync produces only a SMALL (sub-perceptible) correction — not the visible periodic stutter source', () => {
    const r = runGridSync({
      renderDt: 1 / 30,
      durationSec: 1.5,
      latencySec: 0.001,
      syncEveryN: 1,
      lagTicks: 1,
      serverClearTick: 30,
    });
    console.log('[stutter-repro] destructible @localhost (lag=1 tick):', r);
    // A ~1-tick state-sync lag yields a small (~14px) forward correction when
    // the server destroys a wall the client still sees. At ERROR_DECAY_RATE=30
    // a 14px correction is a sub-pixel (~0.9px) visual nudge — imperceptible.
    // The VISIBLE periodic walk stutter was the player-vs-player divergence
    // (89px, now fixed); destructibles are a minor transient residual.
    expect(r.maxPosError).toBeLessThan(30);
  });

  it('HIGH LATENCY (lagTicks=18, ~300ms): the client blocks at a wall the server destroyed → corrections fire (destructibles ARE a source at high latency)', () => {
    const r = runGridSync({
      renderDt: 1 / 30,
      durationSec: 1.8,
      latencySec: 0.15,
      syncEveryN: 1,
      lagTicks: 18,
      serverClearTick: 30,
    });
    console.log('[stutter-repro] destructible @high-latency (lag=18 ticks):', r);
    expect(r.corrections).toBeGreaterThan(0);
  });
});
