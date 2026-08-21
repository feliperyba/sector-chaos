import { ObjectPool } from '../../src/utils/ObjectPool.ts';

describe('ObjectPool', () => {
  it('acquire returns new object from createFn when pool empty', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    const obj = pool.acquire();
    expect(obj).toEqual({ val: 0 });
  });

  it('release returns object to pool and next acquire reuses it after resetFn called', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    const obj = pool.acquire();
    obj.val = 42;
    pool.release(obj);
    expect(pool.available).toBe(1);
    const reused = pool.acquire();
    expect(reused).toBe(obj);
    expect(reused.val).toBe(0);
  });

  it('createFn is called once per new object', () => {
    let createCount = 0;
    const pool = new ObjectPool<{ val: number }>(
      () => {
        createCount++;
        return { val: 0 };
      },
      (obj) => {
        obj.val = 0;
      },
    );
    pool.acquire();
    expect(createCount).toBe(1);
    pool.acquire();
    expect(createCount).toBe(2);
  });

  it('resetFn is called on release and object is reset', () => {
    let resetCalledWith: { val: number } | null = null;
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
        resetCalledWith = obj;
      },
    );
    const obj = pool.acquire();
    obj.val = 99;
    pool.release(obj);
    expect(resetCalledWith).toBe(obj);
    expect(obj.val).toBe(0);
  });

  it('acquiring beyond initial pool size calls createFn and increments size', () => {
    let createCount = 0;
    const pool = new ObjectPool<{ val: number }>(
      () => {
        createCount++;
        return { val: 0 };
      },
      (obj) => {
        obj.val = 0;
      },
      2,
    );
    expect(createCount).toBe(2);
    expect(pool.size).toBe(2);
    pool.acquire();
    pool.acquire();
    expect(createCount).toBe(2);
    pool.acquire();
    expect(createCount).toBe(3);
    expect(pool.size).toBe(3);
  });

  it('preallocate creates objects upfront with correct size and available', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
      5,
    );
    expect(pool.size).toBe(5);
    expect(pool.available).toBe(5);
  });

  it('size tracks total objects ever created including preallocated', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
      3,
    );
    expect(pool.size).toBe(3);
    pool.acquire();
    pool.acquire();
    pool.acquire();
    pool.acquire();
    expect(pool.size).toBe(4);
  });

  it('available tracks number of objects currently in pool', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    expect(pool.available).toBe(0);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.available).toBe(0);
    pool.release(a);
    expect(pool.available).toBe(1);
    pool.release(b);
    expect(pool.available).toBe(2);
    pool.acquire();
    expect(pool.available).toBe(1);
  });

  it('acquire then release then acquire returns same object reference', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    const first = pool.acquire();
    pool.release(first);
    const second = pool.acquire();
    expect(second).toBe(first);
  });

  it('handles multiple interleaved acquire/release cycles', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    pool.release(a);
    pool.release(c);
    const d = pool.acquire();
    const e = pool.acquire();
    expect(d).toBe(c);
    expect(e).toBe(a);
    pool.release(b);
    pool.release(d);
    pool.release(e);
    expect(pool.available).toBe(3);
    expect(pool.size).toBe(3);
  });

  it('starts empty when initialSize is 0 or undefined and first acquire calls createFn', () => {
    let createCount = 0;
    const poolNoInit = new ObjectPool<{ val: number }>(
      () => {
        createCount++;
        return { val: 0 };
      },
      (obj) => {
        obj.val = 0;
      },
    );
    expect(poolNoInit.size).toBe(0);
    expect(poolNoInit.available).toBe(0);
    poolNoInit.acquire();
    expect(createCount).toBe(1);
    expect(poolNoInit.size).toBe(1);

    createCount = 0;
    const poolZero = new ObjectPool<{ val: number }>(
      () => {
        createCount++;
        return { val: 0 };
      },
      (obj) => {
        obj.val = 0;
      },
      0,
    );
    expect(poolZero.size).toBe(0);
    expect(poolZero.available).toBe(0);
    poolZero.acquire();
    expect(createCount).toBe(1);
    expect(poolZero.size).toBe(1);
  });

  it('accepts releasing same object twice without deduplication', () => {
    const pool = new ObjectPool<{ val: number }>(
      () => ({ val: 0 }),
      (obj) => {
        obj.val = 0;
      },
    );
    const obj = pool.acquire();
    pool.release(obj);
    pool.release(obj);
    expect(pool.available).toBe(2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a).toBe(obj);
    expect(b).toBe(obj);
  });
});
