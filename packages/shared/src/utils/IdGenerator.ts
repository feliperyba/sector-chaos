/** Sequential unique ID generator. */
export class IdGenerator {
  private counter: number = 1;
  private prefix: string | undefined;

  constructor(prefix?: string) {
    this.prefix = prefix;
  }

  next(): string {
    const id = this.format(this.counter);
    this.counter++;
    return id;
  }

  peek(): string {
    return this.format(this.counter);
  }

  reset(): void {
    this.counter = 1;
  }

  private format(n: number): string {
    if (this.prefix !== undefined) {
      return `${this.prefix}-${n}`;
    }
    return `${n}`;
  }
}
