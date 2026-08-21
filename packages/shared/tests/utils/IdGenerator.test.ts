import { IdGenerator } from '../../src/utils/IdGenerator.ts';

describe('IdGenerator', () => {
  it('returns sequential IDs without prefix', () => {
    const gen = new IdGenerator();
    expect(gen.next()).toBe('1');
    expect(gen.next()).toBe('2');
    expect(gen.next()).toBe('3');
  });

  it('returns sequential IDs with prefix', () => {
    const gen = new IdGenerator('player');
    expect(gen.next()).toBe('player-1');
    expect(gen.next()).toBe('player-2');
    expect(gen.next()).toBe('player-3');
  });

  it('starts at 1 without prefix', () => {
    const gen = new IdGenerator();
    expect(gen.next()).toBe('1');
  });

  it('starts at 1 with prefix', () => {
    const gen = new IdGenerator('obj');
    expect(gen.next()).toBe('obj-1');
  });

  it('produces 1000 unique IDs from consecutive next() calls', () => {
    const gen = new IdGenerator();
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(gen.next());
    }
    expect(ids.size).toBe(1000);
  });

  it('peek returns next ID without advancing the counter', () => {
    const gen = new IdGenerator();
    expect(gen.peek()).toBe('1');
    expect(gen.next()).toBe('1');
  });

  it('peek returns the same value on repeated calls', () => {
    const gen = new IdGenerator();
    expect(gen.peek()).toBe('1');
    expect(gen.peek()).toBe('1');
    expect(gen.peek()).toBe('1');
  });

  it('peek and next return the same value when called in sequence', () => {
    const gen = new IdGenerator('item');
    expect(gen.peek()).toBe('item-1');
    expect(gen.next()).toBe('item-1');
    expect(gen.peek()).toBe('item-2');
    expect(gen.next()).toBe('item-2');
  });

  it('reset restarts the counter to 1', () => {
    const gen = new IdGenerator();
    gen.next();
    gen.next();
    gen.next();
    gen.reset();
    expect(gen.next()).toBe('1');
    expect(gen.next()).toBe('2');
  });

  it('reset restarts with prefix preserved', () => {
    const gen = new IdGenerator('zone');
    gen.next();
    gen.next();
    gen.reset();
    expect(gen.next()).toBe('zone-1');
  });

  it('formats with normal prefix as prefix-N', () => {
    const gen = new IdGenerator('entity');
    expect(gen.next()).toBe('entity-1');
  });

  it('formats with empty prefix as -N', () => {
    const gen = new IdGenerator('');
    expect(gen.next()).toBe('-1');
  });

  it('formats without prefix as N', () => {
    const gen = new IdGenerator();
    expect(gen.next()).toBe('1');
  });
});
