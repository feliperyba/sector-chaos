import {
  PLAYER,
  TileType,
  AABBCollision,
  PLAYER_PHYSICS_CONFIG,
  applyAccelerationInto,
  normalizeMoveInputInto,
  effectiveWalkSpeed,
  clampToMapExtent,
  resolvePlayerSeparation,
} from '@sector-battle/shared';
import type { AABB, MTV } from '@sector-battle/shared';
import type { IMovementService, MovementResult } from './IMovementService.ts';
import type { ICollisionService } from './ICollisionService.ts';
import type { Player } from '../entities/index.ts';
import { Position, Direction } from '../value-objects/index.ts';

/**
 * Internal mutable Position for zero-alloc scratch returns
 * (server-movement-scratch-aabb). Extends Position so the existing
 * Position-typed signatures are preserved and callers don't change; the
 * readonly fields are written ONLY through `set` below (single localized
 * cast — readonly is a compile-time contract, the runtime slot is a plain
 * writable property). The global immutable `Position` type is untouched.
 *
 * CONTRACT: a returned ScratchPosition is invalidated by the next call to the
 * same service method. Callers must consume `.x`/`.y` synchronously or copy
 * (e.g. `.clone()`) when retention is needed — see the aliasing audit in
 * docs/perf-optimization for the full call-site table.
 */
class ScratchPosition extends Position {
  constructor() {
    super(0, 0);
  }

  set(x: number, y: number): this {
    const self = this as unknown as { x: number; y: number };
    self.x = x;
    self.y = y;
    return this;
  }
}

export class MovementService implements IMovementService {
  private collisionService: ICollisionService;
  private maxSpeed: number;
  private tileSize: number;
  private readonly collisionScratch: Player[] = [];
  private readonly velocityScratch: { vx: number; vy: number } = { vx: 0, vy: 0 };
  private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  /** Scratch position returned by resolvePlayerCollision (zero-alloc result delivery). */
  private readonly _collisionPos = new ScratchPosition();
  /** Scratch position returned by resolveDashEndOverlap (zero-alloc result delivery). */
  private readonly _dashPos = new ScratchPosition();
  /**
   * Scratch positions for validateAndMove's MovementResult. Declared before
   * _moveResult (field initializers run in declaration order). Written LAST in
   * validateAndMove — after every read of player.movement.position — so a
   * caller that aliased a previous result into the player's position cannot
   * observe mid-method mutation.
   */
  private readonly _resultNewPos = new ScratchPosition();
  private readonly _resultCorrectedPos = new ScratchPosition();
  private readonly _moveResult: MovementResult = {
    newPosition: this._resultNewPos,
    correctedPosition: this._resultCorrectedPos,
    moved: false,
    collisionOccurred: false,
  };
  /**
   * Scratch AABBs for the movement hot path (server-movement-scratch-aabb).
   * Widths/heights are constant (PLAYER hitbox) and set once here; only x/y
   * are rewritten per use. Never escape this class — getMTVInto and
   * resolveTileCollision only READ their AABB arguments.
   *
   * Ticket #44: the resolvePlayerCollision loop these two boxes served now
   * delegates to the shared `resolvePlayerSeparation` (which pools its own AABB
   * scratch), so both boxes are down to their OTHER user — resolveDashEndOverlap
   * (dash lifecycle is ADR-0035 divergent surface and stays server-local).
   */
  private readonly _moveAABB: AABB = {
    x: 0,
    y: 0,
    width: PLAYER.HITBOX_WIDTH,
    height: PLAYER.HITBOX_HEIGHT,
  };
  /** Dashing-player box in resolveDashEndOverlap (methods never nest). */
  private readonly _movingAABB: AABB = {
    x: 0,
    y: 0,
    width: PLAYER.HITBOX_WIDTH,
    height: PLAYER.HITBOX_HEIGHT,
  };
  /** Other-player box in resolveDashEndOverlap's push-back loop. */
  private readonly _otherAABB: AABB = {
    x: 0,
    y: 0,
    width: PLAYER.HITBOX_WIDTH,
    height: PLAYER.HITBOX_HEIGHT,
  };
  /** Dash push-back candidate box in resolveDashEndOverlap. */
  private readonly _candidateAABB: AABB = {
    x: 0,
    y: 0,
    width: PLAYER.HITBOX_WIDTH,
    height: PLAYER.HITBOX_HEIGHT,
  };
  /**
   * Flat other-player center buffer for resolvePlayerCollision (ticket #44):
   * [x0, y0, x1, y1, ...] packed from the id-sorted alive cache after the
   * caller-owned filter. Persistent scratch — grows to the high-water mark and
   * is reused (only the first 2*count entries are read by the shared resolver).
   * Copying the numbers (not the Position references) also severs any aliasing
   * between a retained scratch result and the separation inputs.
   */
  private readonly _othersFlat: number[] = [];
  /** Out receptacle for the shared resolvePlayerSeparation (ticket #44). */
  private readonly _separationOut: { x: number; y: number } = { x: 0, y: 0 };
  /**
   * Per-tick cache of the id-sorted alive-player list for resolvePlayerCollision.
   * Built once on the first collision call of a tick (the alive set is stable
   * within a tick — deaths resolve in step9) and reused across every subsequent
   * call that tick, eliminating the per-call O(n log n) collect+sort. Player
   * references are stored, so .movement.position reads are always live — the
   * AABB checks are identical to a fresh collect each call.
   *
   * server-alive-scratch-hoist: in production the `forEachAlive` callback
   * enumerates GameSimulation's shared per-tick alive array (players-Map
   * insertion order) rather than walking the Map — same membership and order
   * by the within-tick aliveness invariant, so the sorted cache is identical.
   * The id sort stays here: the shared array must remain map-ordered for its
   * other consumers.
   */
  private readonly _aliveCache: Player[] = [];
  private _aliveCacheTick = -1;
  /**
   * Dir receptacle for the shared normalize leaf (ticket 15). Never escapes
   * validateAndMove — consumed synchronously into ndx/ndy locals below.
   */
  private readonly _dirScratch: { x: number; y: number } = { x: 0, y: 0 };

  constructor(collisionService: ICollisionService, maxSpeed: number, tileSize: number) {
    this.collisionService = collisionService;
    this.maxSpeed = maxSpeed;
    this.tileSize = tileSize;
  }

  getCollisionService(): ICollisionService {
    return this.collisionService;
  }

  validateAndMove(
    player: Player,
    dx: number,
    dy: number,
    dt: number,
    grid: TileType[][],
  ): MovementResult {
    // Ticket 15: input normalization + stagger multiply are the shared
    // simulation leaves — the SAME sqrt-form arithmetic the client's
    // simulatePhysicsStepInto now runs, so both sides normalize and stagger
    // with identical code by construction. (0,0) is valid — normalizes to
    // (0,0), triggering deceleration via applyAcceleration.
    normalizeMoveInputInto(this._dirScratch, dx, dy);
    const ndx = this._dirScratch.x;
    const ndy = this._dirScratch.y;

    if (ndx !== 0 || ndy !== 0) {
      player.movement.lastMoveDirection = Direction.fromVector(ndx, ndy);
    }

    // Default config = PLAYER_PHYSICS_CONFIG; its staggerMoveSpeedPenalty is
    // derived from COMBAT.STAGGER_MOVE_SPEED_PENALTY (pinned by
    // playerPhysicsConfig.test.ts) — the same number the former local multiply
    // used, with bit-identical multiply order.
    const effectiveMaxSpeed = effectiveWalkSpeed(player.movement.speed.value, player.isStaggered());

    applyAccelerationInto(
      this.velocityScratch,
      player.movement.velocityX,
      player.movement.velocityY,
      ndx,
      ndy,
      effectiveMaxSpeed,
      PLAYER.ACCELERATION,
      PLAYER.DECELERATION,
      dt,
    );

    player.movement.velocityX = this.velocityScratch.vx;
    player.movement.velocityY = this.velocityScratch.vy;

    const newX = player.movement.position.x + this.velocityScratch.vx * dt;
    const newY = player.movement.position.y + this.velocityScratch.vy * dt;

    // Speed-validation uses a direct distance check against the proposed move
    // (no Position allocation in the hot path).
    const moveDx = newX - player.movement.position.x;
    const moveDy = newY - player.movement.position.y;
    const moveDist = Math.sqrt(moveDx * moveDx + moveDy * moveDy);
    const maxDistance = this.maxSpeed * dt * 1.1;
    if (moveDist > maxDistance) {
      // Rejected move: both result positions are the player's CURRENT position.
      // Scratch writes happen after every position read above — ordering rule
      // for the zero-alloc contract (see _resultCorrectedPos docs).
      this._resultNewPos.set(player.movement.position.x, player.movement.position.y);
      this._resultCorrectedPos.set(player.movement.position.x, player.movement.position.y);
      this._moveResult.moved = false;
      this._moveResult.collisionOccurred = false;
      return this._moveResult;
    }

    const playerAABB = this._moveAABB;
    playerAABB.x = newX - PLAYER.HITBOX_WIDTH / 2;
    playerAABB.y = newY - PLAYER.HITBOX_HEIGHT / 2;
    const resolved = this.collisionService.resolveTileCollision(playerAABB, grid);

    // Ticket 15: bounds clamp is the shared center-based leaf (halfSize from
    // PLAYER_PHYSICS_CONFIG — 48, bit-identical to the former HITBOX/2 derived
    // inside clampValue; per-axis extents: X = cols*tileSize, Y = rows*tileSize).
    const clampedX = clampToMapExtent(
      resolved.x + PLAYER.HITBOX_WIDTH / 2,
      PLAYER_PHYSICS_CONFIG.playerHalfW,
      grid[0]!.length * this.tileSize,
    );
    const clampedY = clampToMapExtent(
      resolved.y + PLAYER.HITBOX_HEIGHT / 2,
      PLAYER_PHYSICS_CONFIG.playerHalfH,
      grid.length * this.tileSize,
    );

    const moved = !(
      player.movement.position.x === clampedX && player.movement.position.y === clampedY
    );
    const collisionOccurred = resolved.x !== playerAABB.x || resolved.y !== playerAABB.y;

    // Scratch writes LAST: every read of player.movement.position (newX/newY,
    // moved) happens above, so the returned shared result can never corrupt
    // the computation even if a caller previously aliased it into the player.
    this._resultNewPos.set(newX, newY);
    this._resultCorrectedPos.set(clampedX, clampedY);
    this._moveResult.moved = moved;
    this._moveResult.collisionOccurred = collisionOccurred;
    return this._moveResult;
  }

  resolvePlayerCollision(
    movingPlayer: Player,
    forEachAlive: (cb: (p: Player) => void) => void,
    resolvedPos: Position,
    currentTick: number,
  ): Position {
    if (movingPlayer.movement.isDashing) return resolvedPos;

    // Cache the id-sorted alive list once per tick. The alive set is stable
    // within a tick (deaths resolve in step9), so re-collecting + re-sorting on
    // every call is redundant. References are live — AABB checks read current
    // positions, identical to a fresh collect.
    const alive = this._aliveCache;
    if (this._aliveCacheTick !== currentTick) {
      alive.length = 0;
      forEachAlive((p) => {
        alive.push(p);
      });
      alive.sort((a, b) => a.id.localeCompare(b.id));
      this._aliveCacheTick = currentTick;
    }

    // CALLER-OWNED FILTER (ticket #44 — semantics verbatim from the pre-#44
    // inline loop; the shared resolver processes EVERY entry it is given):
    //   - skip the mover itself (by id);
    //   - skip inactive others UNLESS they still have death collision
    //     (corpse remains solid during the death-animation window);
    //   - skip dashing others (dash passes through).
    // The fill order IS the separation order: the id-sorted alive-cache order,
    // exactly what the inline loop iterated (order affects multi-overlap MTV
    // accumulation — the shared fn is order-sensitive on purpose).
    const flat = this._othersFlat;
    let count = 0;
    for (let i = 0; i < alive.length; i++) {
      const other = alive[i]!;
      if (other.id === movingPlayer.id) continue;
      if (!other.isActive && !other.hasDeathCollision(currentTick)) continue;
      if (other.movement.isDashing) continue;
      flat[count * 2] = other.movement.position.x;
      flat[count * 2 + 1] = other.movement.position.y;
      count++;
    }

    // Ticket #44: the separation loop is the shared pure calculator
    // (`resolvePlayerSeparation`, ticket 03) — the SAME function the client's
    // collision prediction calls, so both sides run identical MTV math by
    // construction. Half-extents come from the shared PLAYER_PHYSICS_CONFIG
    // (playerHalfW/H === PLAYER.HITBOX_WIDTH/HEIGHT / 2 === 48 — 48 * 2 === 96
    // exactly, bit-identical to the former PLAYER.HITBOX_* literals).
    resolvePlayerSeparation(
      resolvedPos.x,
      resolvedPos.y,
      PLAYER_PHYSICS_CONFIG.playerHalfW,
      PLAYER_PHYSICS_CONFIG.playerHalfH,
      flat,
      count,
      this.mtvScratch,
      this._separationOut,
    );

    const pos = this._collisionPos;
    pos.set(this._separationOut.x, this._separationOut.y);

    // Scratch return: the caller must consume .x/.y synchronously or copy
    // (movement-resolution results are copied on retain by movePlayerAction).
    return pos;
  }

  resolveDashEndOverlap(
    dashingPlayer: Player,
    forEachAlive: (cb: (p: Player) => void) => void,
    grid: TileType[][],
  ): Position {
    const pos = this._dashPos;
    pos.set(dashingPlayer.movement.position.x, dashingPlayer.movement.position.y);

    // Zero-alloc: fixed dashing box (computed once from the dash-end position,
    // never recomputed inside the loop) + per-other scratch box.
    const dashingAABB = this._movingAABB;
    dashingAABB.x = pos.x - PLAYER.HITBOX_WIDTH / 2;
    dashingAABB.y = pos.y - PLAYER.HITBOX_HEIGHT / 2;

    const scratch = this.collisionScratch;
    scratch.length = 0;
    forEachAlive((p) => {
      scratch.push(p);
    });

    for (const other of scratch) {
      if (other.id === dashingPlayer.id) continue;
      if (!other.isActive) continue;

      const otherAABB = this._otherAABB;
      otherAABB.x = other.movement.position.x - PLAYER.HITBOX_WIDTH / 2;
      otherAABB.y = other.movement.position.y - PLAYER.HITBOX_HEIGHT / 2;

      const mtv = this.mtvScratch;
      if (!AABBCollision.getMTVInto(dashingAABB, otherAABB, mtv)) continue;

      const vec = dashingPlayer.movement.lastMoveDirection.toVector();
      if (vec.dx !== 0 || vec.dy !== 0) {
        const pushDist = mtv.depth;
        const candidateX = pos.x - vec.dx * pushDist;
        const candidateY = pos.y - vec.dy * pushDist;
        const candidateAABB = this._candidateAABB;
        candidateAABB.x = candidateX - PLAYER.HITBOX_WIDTH / 2;
        candidateAABB.y = candidateY - PLAYER.HITBOX_HEIGHT / 2;
        const tileResolved = this.collisionService.resolveTileCollision(candidateAABB, grid);
        pos.set(
          clampToMapExtent(
            tileResolved.x + PLAYER.HITBOX_WIDTH / 2,
            PLAYER_PHYSICS_CONFIG.playerHalfW,
            grid[0]!.length * this.tileSize,
          ),
          clampToMapExtent(
            tileResolved.y + PLAYER.HITBOX_HEIGHT / 2,
            PLAYER_PHYSICS_CONFIG.playerHalfH,
            grid.length * this.tileSize,
          ),
        );
      } else {
        const offsetX = mtv.x !== 0 ? mtv.x * mtv.depth : 0;
        const offsetY = mtv.y !== 0 ? mtv.y * mtv.depth : 0;
        pos.set(pos.x + offsetX, pos.y + offsetY);
      }

      // Scratch return (same contract as resolvePlayerCollision).
      return pos;
    }

    scratch.length = 0;
    return pos;
  }

  validateSpeed(player: Player, newPosition: Position, dt: number): boolean {
    const distance = player.movement.position.distanceTo(newPosition);
    const maxDistance = this.maxSpeed * dt * 1.1;
    return distance <= maxDistance;
  }

  clampToBounds(
    position: Position,
    playerSize: number,
    mapWidth: number,
    mapHeight: number,
  ): Position {
    // Ticket 15: consumes the shared center-based clamp leaf — same formula
    // the client's ClientCollisionService now uses (center basis), so the
    // bounds clamp is one function on both sides. playerSize/2 is the
    // halfSize the leaf takes (exact: hitbox sizes are even integers).
    const halfSize = playerSize / 2;
    const x = clampToMapExtent(position.x, halfSize, mapWidth);
    const y = clampToMapExtent(position.y, halfSize, mapHeight);
    return new Position(x, y);
  }
}
