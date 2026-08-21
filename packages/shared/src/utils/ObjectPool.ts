/** Generic object pool for reuse. */
export class ObjectPool<T> {
  private pool: T[] = [];
  private createFn: () => T;
  private resetFn: (obj: T) => void;
  private _size: number = 0;

  constructor(createFn: () => T, resetFn: (obj: T) => void, initialSize?: number) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    if (initialSize !== undefined && initialSize > 0) {
      this.preallocate(initialSize);
    }
  }

  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    this._size++;
    return this.createFn();
  }

  release(obj: T): void {
    this.resetFn(obj);
    this.pool.push(obj);
  }

  preallocate(count: number): void {
    for (let i = 0; i < count; i++) {
      this.pool.push(this.createFn());
      this._size++;
    }
  }

  get size(): number {
    return this._size;
  }

  get available(): number {
    return this.pool.length;
  }
}
