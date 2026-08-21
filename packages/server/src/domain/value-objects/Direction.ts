import { Direction as DirectionEnum } from '@sector-battle/shared';

export class Direction {
  readonly value: DirectionEnum;

  constructor(value: DirectionEnum) {
    this.value = value;
  }

  toVector(): { dx: number; dy: number } {
    switch (this.value) {
      case DirectionEnum.UP:
        return { dx: 0, dy: -1 };
      case DirectionEnum.DOWN:
        return { dx: 0, dy: 1 };
      case DirectionEnum.LEFT:
        return { dx: -1, dy: 0 };
      case DirectionEnum.RIGHT:
        return { dx: 1, dy: 0 };
      default:
        return { dx: 0, dy: 0 };
    }
  }

  isOpposite(other: Direction): boolean {
    const vec = this.toVector();
    const otherVec = other.toVector();
    return (
      vec.dx + otherVec.dx === 0 && vec.dy + otherVec.dy === 0 && this.value !== DirectionEnum.NONE
    );
  }

  static fromVector(vx: number, vy: number): Direction {
    const absX = Math.abs(vx);
    const absY = Math.abs(vy);
    if (absX === 0 && absY === 0) return Direction.NONE;
    if (absX >= absY) {
      return vx > 0 ? Direction.RIGHT : Direction.LEFT;
    }
    return vy > 0 ? Direction.DOWN : Direction.UP;
  }

  static readonly NONE: Direction = new Direction(DirectionEnum.NONE);
  static readonly UP: Direction = new Direction(DirectionEnum.UP);
  static readonly DOWN: Direction = new Direction(DirectionEnum.DOWN);
  static readonly LEFT: Direction = new Direction(DirectionEnum.LEFT);
  static readonly RIGHT: Direction = new Direction(DirectionEnum.RIGHT);
}
