import { Interpolation } from '@sector-battle/shared';

export class Position {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  distanceTo(other: Position): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  distanceToSquared(other: Position): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return dx * dx + dy * dy;
  }

  lerp(other: Position, t: number): Position {
    return new Position(
      Interpolation.lerp(this.x, other.x, t),
      Interpolation.lerp(this.y, other.y, t),
    );
  }

  move(dx: number, dy: number): Position {
    return new Position(this.x + dx, this.y + dy);
  }

  equals(other: Position): boolean {
    return this.x === other.x && this.y === other.y;
  }

  clone(): Position {
    return new Position(this.x, this.y);
  }
}
