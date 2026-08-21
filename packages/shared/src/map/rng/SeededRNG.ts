/** Seeded pseudo-random number generator (XorShift128). */
export class SeededRNG {
  protected stateX: number;
  protected stateY: number;
  protected stateZ: number;
  protected stateW: number;

  constructor(seed: number) {
    const s = seed === 0 ? 1 : seed;
    this.stateX = s >>> 0;
    this.stateY = 362436069;
    this.stateZ = 521288629;
    this.stateW = 88675123;
  }

  nextUint32(): number {
    const t = this.stateX ^ (this.stateX << 11);
    this.stateX = this.stateY;
    this.stateY = this.stateZ;
    this.stateZ = this.stateW;
    this.stateW = this.stateW ^ (this.stateW >>> 19) ^ (t ^ (t >>> 8));
    return this.stateW >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.nextFloat() * (i + 1));
      const temp = result[i]!;
      result[i] = result[j]!;
      result[j] = temp;
    }
    return result;
  }

  weightedPick<T>(items: readonly { item: T; weight: number }[]): T {
    let total = 0;
    for (const entry of items) total += entry.weight;
    let roll = this.nextFloat() * total;
    for (const entry of items) {
      roll -= entry.weight;
      if (roll <= 0) return entry.item;
    }
    return items[items.length - 1]!.item;
  }

  fork(seed: number): SeededRNG {
    return new SeededRNG(seed);
  }

  clone(): SeededRNG {
    const c = new SeededRNG(1);
    c.stateX = this.stateX;
    c.stateY = this.stateY;
    c.stateZ = this.stateZ;
    c.stateW = this.stateW;
    return c;
  }
}
