import { RateLimiter } from '../../src/validation/index.ts';

describe('RateLimiter', () => {
  it('allows requests under the limit', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(5, 1000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('p1')).toBe(true);
    }
    vi.useRealTimers();
  });

  it('blocks requests over the limit', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(false);
    vi.useRealTimers();
  });

  it('resets counter after window expires', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 100);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(false);

    vi.advanceTimersByTime(101);
    expect(limiter.check('p1')).toBe(true);
    vi.useRealTimers();
  });

  it('tracks different players independently', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(false);
    expect(limiter.check('p2')).toBe(true);
    expect(limiter.check('p2')).toBe(false);
    vi.useRealTimers();
  });

  it('reset clears player history', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('p1')).toBe(true);
    expect(limiter.check('p1')).toBe(false);
    limiter.reset('p1');
    expect(limiter.check('p1')).toBe(true);
    vi.useRealTimers();
  });
});
