import { SeededRNG } from '../../src/map/rng/SeededRNG.js';

describe('SeededRNG', () => {
  it('produces deterministic output for 100 sequential nextFloat calls', () => {
    const a = new SeededRNG(42);
    const b = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(a.nextFloat()).toBe(b.nextFloat());
    }
  });

  it('produces deterministic output for 100 sequential nextUint32 calls', () => {
    const a = new SeededRNG(42);
    const b = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it('nextFloat always returns value in [0, 1)', () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt returns values within [min, max] inclusive', () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it('nextInt can produce both min and max values', () => {
    const rng = new SeededRNG(42);
    const values = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      values.add(rng.nextInt(5, 10));
    }
    for (let v = 5; v <= 10; v++) {
      expect(values.has(v)).toBe(true);
    }
  });

  it('weightedPick with single item always returns that item', () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(rng.weightedPick([{ item: 'A', weight: 100 }])).toBe('A');
    }
  });

  it('weightedPick with uniform weights produces roughly equal distribution', () => {
    const rng = new SeededRNG(42);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const items = [
      { item: 'a', weight: 1 },
      { item: 'b', weight: 1 },
      { item: 'c', weight: 1 },
    ];
    for (let i = 0; i < 1000; i++) {
      counts[rng.weightedPick(items)]++;
    }
    const total = 1000;
    for (const key of ['a', 'b', 'c']) {
      const ratio = counts[key]! / total;
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(0.5);
    }
  });

  it('weightedPick selects items according to weights', () => {
    const rng = new SeededRNG(42);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const items = [
      { item: 'a', weight: 50 },
      { item: 'b', weight: 30 },
      { item: 'c', weight: 20 },
    ];
    for (let i = 0; i < 10000; i++) {
      counts[rng.weightedPick(items)]++;
    }
    expect(counts.a).toBeGreaterThan(counts.b);
    expect(counts.b).toBeGreaterThan(counts.c);
  });

  it('shuffle preserves all elements', () => {
    const rng = new SeededRNG(42);
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = rng.shuffle(original);
    expect(shuffled.length).toBe(original.length);
    const sorted = [...shuffled].sort((a, b) => a - b);
    expect(sorted).toEqual(original);
  });

  it('different seed produces different shuffle order', () => {
    const a = new SeededRNG(42);
    const b = new SeededRNG(7);
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    expect(a.shuffle(arr)).not.toEqual(b.shuffle([...arr]));
  });

  it('fork creates an independent generator', () => {
    const rng = new SeededRNG(42);
    const forked = rng.fork(123);
    const resultsOriginal: number[] = [];
    const resultsForked: number[] = [];
    for (let i = 0; i < 10; i++) {
      resultsOriginal.push(rng.nextUint32());
      resultsForked.push(forked.nextUint32());
    }
    expect(resultsOriginal).not.toEqual(resultsForked);
  });

  it('clone continues from the same state as original', () => {
    const rng = new SeededRNG(42);
    rng.nextUint32();
    rng.nextUint32();
    const cloned = rng.clone();
    expect(rng.nextUint32()).toBe(cloned.nextUint32());
    expect(rng.nextUint32()).toBe(cloned.nextUint32());
    expect(rng.nextUint32()).toBe(cloned.nextUint32());
  });

  it('advancing clone does not affect original state', () => {
    const rng = new SeededRNG(42);
    rng.nextUint32();
    const cloned = rng.clone();
    for (let i = 0; i < 5; i++) {
      cloned.nextUint32();
    }
    const originalNext = rng.nextUint32();
    const fresh = new SeededRNG(42);
    fresh.nextUint32();
    expect(originalNext).toBe(fresh.nextUint32());
  });

  it('seed=0 is treated as seed=1', () => {
    const a = new SeededRNG(0);
    const b = new SeededRNG(1);
    for (let i = 0; i < 10; i++) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });
});
