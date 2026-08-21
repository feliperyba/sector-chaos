export class Health {
  readonly current: number;
  readonly max: number;

  constructor(current: number, max: number) {
    this.current = current;
    this.max = max;
  }

  damage(amount: number): Health {
    return new Health(Math.max(0, this.current - amount), this.max);
  }

  heal(amount: number): Health {
    return new Health(Math.min(this.max, this.current + amount), this.max);
  }

  get isDead(): boolean {
    return this.current === 0;
  }

  get percentage(): number {
    return this.current / this.max;
  }

  get isFull(): boolean {
    return this.current === this.max;
  }

  equals(other: Health): boolean {
    return this.current === other.current && this.max === other.max;
  }
}
