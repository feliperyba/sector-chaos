import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InputFrame } from '../../types.js';

class TestableInputCollector {
  private seq = 0;
  private lastSendTime = 0;
  private injectQueue: InputFrame[] = [];
  private continuousFrame: InputFrame | null = null;
  private continuousEnd = 0;
  private fakeNow = 0;

  constructor(private intervalMs = 16) {}

  setNow(now: number): void {
    this.fakeNow = now;
  }

  injectFrame(frame: InputFrame): void {
    this.injectQueue.push({ ...frame, sequence: this.seq++ });
  }

  injectContinuous(frame: InputFrame, durationMs: number): void {
    this.continuousFrame = { ...frame, sequence: this.seq };
    this.continuousEnd = this.fakeNow + durationMs;
  }

  clearInjection(): void {
    this.injectQueue = [];
    this.continuousFrame = null;
    this.continuousEnd = 0;
  }

  private consumeInjection(): InputFrame | null {
    if (this.continuousFrame !== null) {
      if (this.fakeNow < this.continuousEnd) {
        return { ...this.continuousFrame, sequence: this.seq++ };
      }
      this.continuousFrame = null;
      this.continuousEnd = 0;
    }
    if (this.injectQueue.length > 0) {
      return this.injectQueue.shift() ?? null;
    }
    return null;
  }

  collect(): InputFrame | null {
    if (this.fakeNow - this.lastSendTime < this.intervalMs) return null;
    this.lastSendTime = this.fakeNow;

    const injected = this.consumeInjection();
    if (injected) return injected;

    return { movementX: 0, movementY: 0, aimAngle: 0, sequence: this.seq++, actions: [] };
  }
}

describe('InputCollector injection', () => {
  let ic: TestableInputCollector;

  beforeEach(() => {
    ic = new TestableInputCollector();
  });

  describe('injectFrame', () => {
    it('returns injected frame on next collect', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 1, movementY: 0, aimAngle: 0.5, sequence: 0, actions: ['DASH'] });

      ic.setNow(16);
      const result = ic.collect();
      expect(result).not.toBeNull();
      expect(result!.movementX).toBe(1);
      expect(result!.actions).toEqual(['DASH']);
      expect(result!.aimAngle).toBe(0.5);
    });

    it('consumes injected frame only once', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });

      ic.setNow(16);
      const first = ic.collect();
      expect(first!.movementX).toBe(1);

      ic.setNow(32);
      const second = ic.collect();
      expect(second!.movementX).toBe(0);
    });

    it('queues multiple injectFrame calls in order', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectFrame({ movementX: 0, movementY: 1, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectFrame({ movementX: -1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(1);
      ic.setNow(32);
      expect(ic.collect()!.movementY).toBe(1);
      ic.setNow(48);
      expect(ic.collect()!.movementX).toBe(-1);
    });

    it('increments sequence for each injected frame', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectFrame({ movementX: 0, movementY: 1, aimAngle: 0, sequence: 0, actions: [] });

      ic.setNow(16);
      const first = ic.collect();
      ic.setNow(32);
      const second = ic.collect();
      expect(first!.sequence).toBe(0);
      expect(second!.sequence).toBe(1);
    });
  });

  describe('injectContinuous', () => {
    it('returns same frame for the entire duration', () => {
      ic.setNow(0);
      ic.injectContinuous(
        { movementX: 1, movementY: 1, aimAngle: 0, sequence: 0, actions: [] },
        100,
      );

      const frames: InputFrame[] = [];
      for (let t = 16; t <= 96; t += 16) {
        ic.setNow(t);
        const f = ic.collect();
        if (f) frames.push(f);
      }

      expect(frames.length).toBeGreaterThanOrEqual(5);
      for (const f of frames) {
        expect(f.movementX).toBe(1);
        expect(f.movementY).toBe(1);
      }
    });

    it('returns to normal after duration expires', () => {
      ic.setNow(0);
      ic.injectContinuous(
        { movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] },
        50,
      );

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(1);

      ic.setNow(32);
      expect(ic.collect()!.movementX).toBe(1);

      ic.setNow(64);
      const after = ic.collect();
      expect(after!.movementX).toBe(0);
    });

    it('increments sequence per frame during continuous injection', () => {
      ic.setNow(0);
      ic.injectContinuous(
        { movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] },
        50,
      );

      ic.setNow(16);
      const first = ic.collect();
      ic.setNow(32);
      const second = ic.collect();

      expect(first!.sequence).not.toBe(second!.sequence);
    });
  });

  describe('clearInjection', () => {
    it('cancels active continuous injection', () => {
      ic.setNow(0);
      ic.injectContinuous(
        { movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] },
        1000,
      );

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(1);

      ic.clearInjection();

      ic.setNow(32);
      expect(ic.collect()!.movementX).toBe(0);
    });

    it('cancels queued injectFrame calls', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectFrame({ movementX: 0, movementY: 1, aimAngle: 0, sequence: 0, actions: [] });

      ic.clearInjection();

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(0);
      ic.setNow(32);
      expect(ic.collect()!.movementY).toBe(0);
    });

    it('can be called when no injection is active', () => {
      expect(() => ic.clearInjection()).not.toThrow();
    });
  });

  describe('priority', () => {
    it('continuous injection takes priority over queued frames', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 99, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectContinuous(
        { movementX: 1, movementY: 1, aimAngle: 0, sequence: 0, actions: [] },
        50,
      );

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(1);

      ic.setNow(32);
      expect(ic.collect()!.movementX).toBe(1);
    });

    it('queued frames fire after continuous expires', () => {
      ic.setNow(0);
      ic.injectFrame({ movementX: 99, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ic.injectContinuous(
        { movementX: 1, movementY: 0, aimAngle: 0, sequence: 0, actions: [] },
        32,
      );

      ic.setNow(16);
      expect(ic.collect()!.movementX).toBe(1);

      ic.setNow(48);
      expect(ic.collect()!.movementX).toBe(99);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Perf ticket 21 — REAL-class JustDown edge semantics under the numeric
// prev-key map. The suites above exercise a replica of the send-boundary
// logic; these exercise the ACTUAL InputCollector (init() skipped; the
// private keys/cursorKeys fields are rigged with minimal stubs — the class
// only reads `.isDown`/`.keyCode` on them inside pollEdgeActions). The map
// swap (string keyCode keys → numeric) must not change any edge behavior:
// press fires exactly once, hold fires never, release+re-press fires again.
vi.mock('phaser', () => ({ default: {} }));

import { InputCollector } from '../InputCollector.js';

type StubKey = { keyCode: number; isDown: boolean };

interface StubKeySet {
  W: StubKey;
  A: StubKey;
  S: StubKey;
  D: StubKey;
  Space: StubKey;
  E: StubKey;
  One: StubKey;
  Two: StubKey;
  Three: StubKey;
  Four: StubKey;
}

function makeKey(keyCode: number): StubKey {
  return { keyCode, isDown: false };
}

function rigKeys(ic: InputCollector): StubKeySet {
  const keys: StubKeySet = {
    W: makeKey(87),
    A: makeKey(65),
    S: makeKey(83),
    D: makeKey(68),
    Space: makeKey(32),
    E: makeKey(69),
    One: makeKey(49),
    Two: makeKey(50),
    Three: makeKey(51),
    Four: makeKey(52),
  };
  const cursorKeys = {
    up: makeKey(38),
    down: makeKey(40),
    left: makeKey(37),
    right: makeKey(39),
  };
  const internals = ic as unknown as { keys: unknown; cursorKeys: unknown };
  internals.keys = keys;
  internals.cursorKeys = cursorKeys;
  return keys;
}

/** Pointer stub: right button never down (THROW edge inert). */
const stubPointer = () => ({ rightButtonDown: () => false }) as never;

describe('ticket 21 — numeric prev-key map edge semantics (real InputCollector)', () => {
  it('press fires the edge exactly once; hold and release fire nothing', () => {
    const ic = new InputCollector();
    const keys = rigKeys(ic);

    keys.Space.isDown = false;
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual([]);

    keys.Space.isDown = true; // press
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual(['DASH']);

    keys.Space.isDown = true; // hold
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual([]);

    keys.Space.isDown = false; // release
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual([]);

    keys.Space.isDown = true; // re-press
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual(['DASH']);
  });

  it('all seven polled keys keep independent per-key edge state', () => {
    const ic = new InputCollector();
    const keys = rigKeys(ic);
    const names = ['Space', 'E', 'One', 'Two', 'Three', 'Four'] as const;
    const expected = [
      'DASH',
      'PICKUP',
      'WEAPON_SLOT_1',
      'WEAPON_SLOT_2',
      'WEAPON_SLOT_3',
      'WEAPON_SLOT_4',
    ];

    // All pressed in one frame → all edges fire together.
    for (const n of names) keys[n].isDown = true;
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual(expected);

    // Held → nothing; release-polled then re-pressed while others stay held
    // → only that key's edge fires (numeric keys must not collide across
    // keyCodes; the release must be POLLED so the map records the up-state —
    // a release+re-press between two polls is invisible by design).
    for (const n of names) keys[n].isDown = true;
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual([]);
    keys.One.isDown = false;
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual([]);
    keys.One.isDown = true;
    expect(ic.pollEdgeActions(stubPointer(), 1)).toEqual(['WEAPON_SLOT_1']);
  });
});
