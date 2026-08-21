/**
 * Determinism parity test (ADR-0035) — server `MovementService.validateAndMove`
 * vs shared client primitive `simulatePhysicsStepInto`.
 *
 * RIGOR TIER 1 (BEST, per ticket 06-step3): instantiates the REAL
 * `MovementService` with a stubbed `ICollisionService` whose
 * `resolveTileCollision` is pass-through, on a no-collision (all EMPTY) grid.
 * No production helper is extracted from `validateAndMove` (prime directive).
 *
 * PARITY SCOPE (should-agree surface only — see ADR-0035):
 *   - Input normalization (ndx, ndy)
 *   - applyAccelerationInto with (effectiveMaxSpeed, ACCELERATION, DECELERATION, dt)
 *   - Integration pos += v * dt
 *   - Stagger penalty (effectiveSpeed *= STAGGER_PENALTY before accel)
 *   - dt value (SIM_TICK_DT)
 *
 * OUT OF PARITY SCOPE (deliberately divergent, ADR-0014/0016 — NOT asserted):
 *   - Collision (server AABB+MTV via CollisionService vs client collisionFn)
 *   - Dash (server applies via separate resolveDashEndOverlap on the Player
 *     aggregate, NOT inline in validateAndMove; client handles inline)
 *   - Bounds clamp (server-only via clampToBounds)
 *   - Speed validation (server-only via validateSpeed)
 *
 * DEVIATION NOTE: the ticket lists the path
 *   `packages/shared/src/simulation/__tests__/movementParity.test.ts`
 * but that location can only host tier 3 (reconstruction-only, "theater") —
 * the `shared` package cannot import `MovementService` from `server`
 * (dependency direction is server -> shared, not the reverse). Tier 1 REQUIRES
 * importing the real MovementService, so this test lives in the server package
 * alongside MovementService.test.ts and CollisionDeterminismRegression.test.ts.
 * This deviation is forced by the dependency graph and is the only way to
 * achieve the BEST rigor tier instead of the rejected tier-3 theater.
 */
import { describe, it, expect } from 'vitest';
import {
  PLAYER,
  COMBAT,
  TileType,
  PlayerStatus,
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  type PhysicsState,
  type PhysicsInput,
  type PhysicsConfig,
  type CollisionFn,
  type AABB,
} from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';
import { MovementService } from '../../../src/domain/services/MovementService.ts';
import type {
  ICollisionService,
  ResolvedPosition,
  EnrichedCollisionGrid,
} from '../../../src/domain/services/ICollisionService.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';

const DT = SIM_TICK_DT;

const PHYSICS_CONFIG: PhysicsConfig = {
  acceleration: PLAYER.ACCELERATION,
  deceleration: PLAYER.DECELERATION,
  dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
  dashDurationTicks: PLAYER.DASH_DURATION_TICKS,
  staggerMoveSpeedPenalty: COMBAT.STAGGER_MOVE_SPEED_PENALTY,
  playerHalfW: PLAYER.HITBOX_WIDTH / 2,
  playerHalfH: PLAYER.HITBOX_HEIGHT / 2,
};

/**
 * Pass-through ICollisionService: `resolveTileCollision` returns the input AABB
 * x/y unchanged (no walls, no MTV). All other interface methods are stubs that
 * are never invoked by `validateAndMove` on a no-collision grid. This isolates
 * the accel + integration + stagger core (the should-agree surface).
 */
class PassThroughCollisionService implements ICollisionService {
  resolveTileCollision(entity: AABB, _grid: TileType[][]): ResolvedPosition {
    return { x: entity.x, y: entity.y };
  }
  setEnrichedGrid(_data: EnrichedCollisionGrid): void {
    // no-op stub
  }
  clearEnrichedVisual(_gridX: number, _gridY: number): void {
    // no-op stub
  }
  isTileBlocked(_gridX: number, _gridY: number, _grid: TileType[][]): boolean {
    return false;
  }
  isPointBlocked(_x: number, _y: number, _grid: TileType[][]): boolean {
    return false;
  }
  segmentIntersectsTileCollider(
    _x1: number,
    _y1: number,
    _x2: number,
    _y2: number,
    _expand: number,
    _gridX: number,
    _gridY: number,
  ): boolean {
    return false;
  }
  getColliderCentroid(_gridX: number, _gridY: number): { x: number; y: number } | null {
    return null;
  }
  registerSiegeWallCollider(): void {
    // no-op stub
  }
  setSiegeWallEnriched(_gridX: number, _gridY: number): void {
    // no-op stub
  }
}

/** Pass-through client collisionFn (no walls). */
const noCollision: CollisionFn = (x, y) => ({ x, y });

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: PLAYER.BASE_SPEED,
    dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
    dashDuration: PLAYER.DASH_DURATION,
    dashCooldown: 60,
    baseHealth: PLAYER.BASE_HEALTH,
    maxHealth: PLAYER.MAX_HEALTH,
    inventorySize: PLAYER.INVENTORY_SIZE,
    hitboxWidth: PLAYER.HITBOX_WIDTH,
    hitboxHeight: PLAYER.HITBOX_HEIGHT,
    ...overrides,
  };
}

function createPlayer(id: string, x: number, y: number, staggered = false): Player {
  const player = new Player(id, `Player_${id}`, new Position(x, y), createDefaultConfig());
  player.spawnTick = -9999;
  player.statusEffects.freshSpawnExpiryTick = -9999;
  player.statusEffects.status = PlayerStatus.ALIVE;
  if (staggered) player.startStagger(2000, 60);
  return player;
}

function makeGrid(rows: number, cols: number, fill: TileType): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  return grid;
}

/** Large all-EMPTY grid so bounds-clamp never engages (server-only divergence). */
const GRID = makeGrid(40, 40, TileType.EMPTY);
const CENTER_X = 2560;
const CENTER_Y = 2560;

function makePhysicsState(player: Player, staggered: boolean): PhysicsState {
  return {
    x: player.movement.position.x,
    y: player.movement.position.y,
    vx: player.movement.velocityX,
    vy: player.movement.velocityY,
    speed: PLAYER.BASE_SPEED,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: staggered,
  };
}

function makePhysicsInput(dx: number, dy: number): PhysicsInput {
  // No dash — dash is out of parity scope (deliberately divergent).
  return { dx, dy, hasDash: false, dashDirX: 0, dashDirY: 0 };
}

/** Precision for `(x,y,vx,vy)` parity assertions. */
const PRECISION = 6;

describe('Movement determinism parity — MovementService.validateAndMove vs simulatePhysicsStepInto (ADR-0035)', () => {
  /**
   * The core parity harness. For each (dx, dy) input it runs ONE tick of both
   * implementations from identical starting state and asserts the four-tuple
   * (x, y, vx, vy) agrees. Only the should-agree surface is exercised:
   * non-dash, pass-through collision (no walls), centered player (no bounds).
   */
  function assertParityOneTick(
    label: string,
    dx: number,
    dy: number,
    startVx: number,
    startVy: number,
    staggered = false,
  ): void {
    it(`${label}: identical (x,y,vx,vy) after one tick`, () => {
      const service = new MovementService(
        new PassThroughCollisionService(),
        PLAYER.BASE_SPEED,
        128,
      );
      const player = createPlayer('parity', CENTER_X, CENTER_Y, staggered);
      player.movement.velocityX = startVx;
      player.movement.velocityY = startVy;

      const state = makePhysicsState(player, staggered);

      // Server path: real MovementService.validateAndMove (no extraction).
      const result = service.validateAndMove(player, dx, dy, DT, GRID);
      const serverX = result.correctedPosition.x;
      const serverY = result.correctedPosition.y;
      const serverVx = player.movement.velocityX;
      const serverVy = player.movement.velocityY;

      // Client path: shared primitive.
      simulatePhysicsStepInto(state, makePhysicsInput(dx, dy), PHYSICS_CONFIG, noCollision, DT);

      expect(serverVx).toBeCloseTo(state.vx, PRECISION);
      expect(serverVy).toBeCloseTo(state.vy, PRECISION);
      expect(serverX).toBeCloseTo(state.x, PRECISION);
      expect(serverY).toBeCloseTo(state.y, PRECISION);
    });
  }

  describe('should-agree surface (non-dash, no collision, no bounds)', () => {
    // rest -> accel
    assertParityOneTick('rest -> accel (+x)', 1, 0, 0, 0);
    assertParityOneTick('rest -> accel (-x)', -1, 0, 0, 0);
    assertParityOneTick('rest -> accel (+y)', 0, 1, 0, 0);
    assertParityOneTick('rest -> accel (-y)', 0, -1, 0, 0);

    // diagonal normalization
    assertParityOneTick('diagonal (1,1) from rest', 1, 1, 0, 0);
    assertParityOneTick('diagonal (-1,1) from rest', -1, 1, 0, 0);
    assertParityOneTick('diagonal (1,1) magnitude-agnostic vs (100,100)', 100, 100, 0, 0);

    // input against existing velocity (direction-change curve)
    assertParityOneTick('moving +x, input -x (direction change)', -1, 0, PLAYER.BASE_SPEED, 0);
    assertParityOneTick('moving +y, input 0 (decel)', 0, 0, 0, PLAYER.BASE_SPEED);

    // decel-to-zero from a sub-cap velocity
    assertParityOneTick('decel partial (vx=200, no input)', 0, 0, 200, 0);

    // terminal velocity hold (velocity already at cap, aligned input)
    assertParityOneTick('terminal hold +x', 1, 0, PLAYER.BASE_SPEED, 0);
    assertParityOneTick(
      'terminal hold diagonal',
      1,
      1,
      PLAYER.BASE_SPEED / Math.SQRT2,
      PLAYER.BASE_SPEED / Math.SQRT2,
    );
  });

  describe('stagger penalty (parity holds when both apply STAGGER_PENALTY)', () => {
    assertParityOneTick('staggered rest -> accel (+x)', 1, 0, 0, 0, true);
    assertParityOneTick('staggered terminal hold +x', 1, 0, PLAYER.BASE_SPEED, 0, true);
    assertParityOneTick('staggered diagonal (1,1)', 1, 1, 0, 0, true);
    assertParityOneTick('staggered decel (no input)', 0, 0, 200, 0, true);
  });

  describe('multi-tick trajectory parity (warm-up to terminal, then hold)', () => {
    it('60-tick (+x) trajectory: every tick agrees on (x,y,vx,vy)', () => {
      const service = new MovementService(
        new PassThroughCollisionService(),
        PLAYER.BASE_SPEED,
        128,
      );
      const player = createPlayer('traj', CENTER_X, CENTER_Y);
      const state = makePhysicsState(player, false);
      const input = makePhysicsInput(1, 0);

      for (let i = 0; i < 60; i++) {
        const result = service.validateAndMove(player, 1, 0, DT, GRID);
        simulatePhysicsStepInto(state, input, PHYSICS_CONFIG, noCollision, DT);

        expect(player.movement.velocityX).toBeCloseTo(state.vx, PRECISION);
        expect(player.movement.velocityY).toBeCloseTo(state.vy, PRECISION);
        expect(result.correctedPosition.x).toBeCloseTo(state.x, PRECISION);
        expect(result.correctedPosition.y).toBeCloseTo(state.y, PRECISION);

        // The server mutates player position inside its own pipeline only via
        // the returned correctedPosition; sync the player onto it for the next
        // tick so both paths continue from the same (x,y) — exactly what the
        // real GameSimulation does via movePlayer (which copies on retain, so
        // the test clones the zero-alloc scratch result the same way).
        player.movement.position = result.correctedPosition.clone();
        // state.x/y are already updated in place by simulatePhysicsStepInto.
      }
    });

    it('60-tick diagonal (1,1) then 30-tick decel: every tick agrees', () => {
      const service = new MovementService(
        new PassThroughCollisionService(),
        PLAYER.BASE_SPEED,
        128,
      );
      const player = createPlayer('traj2', CENTER_X, CENTER_Y);
      const state = makePhysicsState(player, false);

      for (let i = 0; i < 60; i++) {
        const result = service.validateAndMove(player, 1, 1, DT, GRID);
        simulatePhysicsStepInto(state, makePhysicsInput(1, 1), PHYSICS_CONFIG, noCollision, DT);
        expect(player.movement.velocityX).toBeCloseTo(state.vx, PRECISION);
        expect(player.movement.velocityY).toBeCloseTo(state.vy, PRECISION);
        expect(result.correctedPosition.x).toBeCloseTo(state.x, PRECISION);
        expect(result.correctedPosition.y).toBeCloseTo(state.y, PRECISION);
        // RETAIN → copy (scratch result invalidated by the next call).
        player.movement.position = result.correctedPosition.clone();
      }
      for (let i = 0; i < 30; i++) {
        const result = service.validateAndMove(player, 0, 0, DT, GRID);
        simulatePhysicsStepInto(state, makePhysicsInput(0, 0), PHYSICS_CONFIG, noCollision, DT);
        expect(player.movement.velocityX).toBeCloseTo(state.vx, PRECISION);
        expect(player.movement.velocityY).toBeCloseTo(state.vy, PRECISION);
        expect(result.correctedPosition.x).toBeCloseTo(state.x, PRECISION);
        expect(result.correctedPosition.y).toBeCloseTo(state.y, PRECISION);
        player.movement.position = result.correctedPosition.clone();
      }
    });
  });

  describe('divergence surface correctly EXCLUDED (sanity — not parity-asserted)', () => {
    // These cases document WHY dash/collision/bounds are out of scope. They
    // are NOT parity assertions; they assert the structural difference.

    it('validateAndMove does NOT touch isDashing (dash handled elsewhere on server)', () => {
      const service = new MovementService(
        new PassThroughCollisionService(),
        PLAYER.BASE_SPEED,
        128,
      );
      const player = createPlayer('dashcheck', CENTER_X, CENTER_Y);
      player.movement.isDashing = false;
      service.validateAndMove(player, 1, 0, DT, GRID);
      // The server's validateAndMove never sets isDashing; the dash lifecycle
      // is owned by GameSimulationInput/resolveDashEndOverlap on the aggregate.
      expect(player.movement.isDashing).toBe(false);
    });

    it('bounds clamp engages near map edge (server-only divergence, OUT of parity)', () => {
      // Player near the LEFT edge: server clamps to halfSize; client primitive
      // (with pass-through collisionFn) does not. This is the accepted
      // divergence surface — we only confirm it exists, we do NOT assert parity.
      const service = new MovementService(
        new PassThroughCollisionService(),
        PLAYER.BASE_SPEED,
        128,
      );
      const grid = makeGrid(40, 40, TileType.EMPTY);
      const player = createPlayer('edge', PLAYER.HITBOX_WIDTH / 2 + 1, CENTER_Y);
      const result = service.validateAndMove(player, -1, 0, DT, grid);
      // Server clamped the corrected position to >= halfSize.
      expect(result.correctedPosition.x).toBeGreaterThanOrEqual(PLAYER.HITBOX_WIDTH / 2);
    });
  });
});
