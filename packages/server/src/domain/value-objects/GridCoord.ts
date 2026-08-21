export class GridCoord {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  neighbors4(): GridCoord[] {
    return [
      new GridCoord(this.x, this.y - 1),
      new GridCoord(this.x, this.y + 1),
      new GridCoord(this.x - 1, this.y),
      new GridCoord(this.x + 1, this.y),
    ];
  }

  neighbors8(): GridCoord[] {
    const result: GridCoord[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        result.push(new GridCoord(this.x + dx, this.y + dy));
      }
    }
    return result;
  }

  distance(other: GridCoord): number {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }

  equals(other: GridCoord): boolean {
    return this.x === other.x && this.y === other.y;
  }
}
