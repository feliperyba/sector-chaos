import type { Player } from '../entities/index.ts';
import type { Position } from '../value-objects/index.ts';
import type { TileType } from '@sector-battle/shared';

export interface MovementResult {
  newPosition: Position;
  correctedPosition: Position;
  moved: boolean;
  collisionOccurred: boolean;
}

export interface IMovementService {
  validateAndMove(
    player: Player,
    dx: number,
    dy: number,
    dt: number,
    grid: TileType[][],
  ): MovementResult;
  validateSpeed(player: Player, newPosition: Position, dt: number): boolean;
  clampToBounds(
    position: Position,
    playerSize: number,
    mapWidth: number,
    mapHeight: number,
  ): Position;

  resolvePlayerCollision(
    movingPlayer: Player,
    forEachAlive: (cb: (p: Player) => void) => void,
    resolvedPos: Position,
    currentTick: number,
  ): Position;

  resolveDashEndOverlap(
    dashingPlayer: Player,
    forEachAlive: (cb: (p: Player) => void) => void,
    grid: TileType[][],
  ): Position;
}
