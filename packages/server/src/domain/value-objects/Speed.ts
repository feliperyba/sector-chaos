export class Speed {
  readonly value: number;
  readonly max: number;

  constructor(value: number, max: number) {
    this.value = value;
    this.max = max;
  }

  scale(factor: number): Speed {
    return new Speed(Math.max(0, this.value * factor), this.max);
  }

  get isZero(): boolean {
    return this.value === 0;
  }

  get normalized(): number {
    return this.value / this.max;
  }
}
