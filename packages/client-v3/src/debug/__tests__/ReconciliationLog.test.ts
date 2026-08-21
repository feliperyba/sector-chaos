import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationLog, RECONCILIATION_LOG_CAPACITY } from '../ReconciliationLog.js';
import type { ReconciliationEntry } from '../ReconciliationLog.js';

function makeEntry(overrides: Partial<ReconciliationEntry> = {}): ReconciliationEntry {
  return {
    tick: 0,
    seq: 0,
    serverX: 0,
    serverY: 0,
    localX: 0,
    localY: 0,
    correctionX: 0,
    correctionY: 0,
    wasCorrected: false,
    ...overrides,
  };
}

describe('ReconciliationLog', () => {
  let log: ReconciliationLog;

  beforeEach(() => {
    log = new ReconciliationLog();
  });

  describe('construction', () => {
    it('has default capacity of 100', () => {
      expect(log.getCapacity()).toBe(RECONCILIATION_LOG_CAPACITY);
      expect(RECONCILIATION_LOG_CAPACITY).toBe(100);
    });

    it('has zero size initially', () => {
      expect(log.size).toBe(0);
    });

    it('accepts custom capacity', () => {
      const l = new ReconciliationLog(10);
      expect(l.getCapacity()).toBe(10);
    });
  });

  describe('push', () => {
    it('increments size', () => {
      log.push(makeEntry());
      expect(log.size).toBe(1);
    });

    it('stores entry retrievable via getEntries', () => {
      const entry = makeEntry({ tick: 42, seq: 7, localX: 100, localY: 200 });
      log.push(entry);
      const entries = log.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.tick).toBe(42);
      expect(entries[0]!.seq).toBe(7);
      expect(entries[0]!.localX).toBe(100);
      expect(entries[0]!.localY).toBe(200);
    });

    it('stores all fields correctly', () => {
      const entry = makeEntry({
        tick: 100,
        seq: 55,
        serverX: 10,
        serverY: 20,
        localX: 15,
        localY: 25,
        correctionX: 5,
        correctionY: 5,
        wasCorrected: true,
      });
      log.push(entry);
      const e = log.getEntries()[0]!;
      expect(e.tick).toBe(100);
      expect(e.seq).toBe(55);
      expect(e.serverX).toBe(10);
      expect(e.serverY).toBe(20);
      expect(e.localX).toBe(15);
      expect(e.localY).toBe(25);
      expect(e.correctionX).toBe(5);
      expect(e.correctionY).toBe(5);
      expect(e.wasCorrected).toBe(true);
    });

    it('caps size at capacity', () => {
      const l = new ReconciliationLog(5);
      for (let i = 0; i < 10; i++) {
        l.push(makeEntry({ tick: i }));
      }
      expect(l.size).toBe(5);
    });

    it('overwrites oldest entry when full', () => {
      const l = new ReconciliationLog(3);
      l.push(makeEntry({ tick: 0 }));
      l.push(makeEntry({ tick: 1 }));
      l.push(makeEntry({ tick: 2 }));
      l.push(makeEntry({ tick: 3 }));
      const entries = l.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0]!.tick).toBe(1);
      expect(entries[1]!.tick).toBe(2);
      expect(entries[2]!.tick).toBe(3);
    });
  });

  describe('getEntries', () => {
    it('returns empty array when log is empty', () => {
      expect(log.getEntries()).toEqual([]);
    });

    it('returns all entries when no count given', () => {
      log.push(makeEntry({ tick: 10 }));
      log.push(makeEntry({ tick: 20 }));
      log.push(makeEntry({ tick: 30 }));
      const entries = log.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0]!.tick).toBe(10);
      expect(entries[1]!.tick).toBe(20);
      expect(entries[2]!.tick).toBe(30);
    });

    it('returns entries in insertion order (oldest first)', () => {
      for (let i = 0; i < 5; i++) {
        log.push(makeEntry({ seq: i }));
      }
      const entries = log.getEntries();
      for (let i = 0; i < 5; i++) {
        expect(entries[i]!.seq).toBe(i);
      }
    });

    it('returns last N entries when count specified', () => {
      for (let i = 0; i < 10; i++) {
        log.push(makeEntry({ tick: i }));
      }
      const entries = log.getEntries(3);
      expect(entries).toHaveLength(3);
      expect(entries[0]!.tick).toBe(7);
      expect(entries[1]!.tick).toBe(8);
      expect(entries[2]!.tick).toBe(9);
    });

    it('returns all entries when count exceeds size', () => {
      log.push(makeEntry({ tick: 1 }));
      log.push(makeEntry({ tick: 2 }));
      const entries = log.getEntries(100);
      expect(entries).toHaveLength(2);
    });

    it('returns empty array when count is 0', () => {
      log.push(makeEntry({ tick: 1 }));
      expect(log.getEntries(0)).toEqual([]);
    });

    it('handles wrap-around correctly', () => {
      const l = new ReconciliationLog(4);
      for (let i = 0; i < 7; i++) {
        l.push(makeEntry({ tick: i }));
      }
      const entries = l.getEntries();
      expect(entries).toHaveLength(4);
      expect(entries[0]!.tick).toBe(3);
      expect(entries[1]!.tick).toBe(4);
      expect(entries[2]!.tick).toBe(5);
      expect(entries[3]!.tick).toBe(6);
    });

    it('handles wrap-around with count parameter', () => {
      const l = new ReconciliationLog(4);
      for (let i = 0; i < 7; i++) {
        l.push(makeEntry({ tick: i }));
      }
      const entries = l.getEntries(2);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.tick).toBe(5);
      expect(entries[1]!.tick).toBe(6);
    });

    it('preserves wasCorrected flag correctly', () => {
      log.push(makeEntry({ wasCorrected: false }));
      log.push(makeEntry({ wasCorrected: true }));
      log.push(makeEntry({ wasCorrected: false }));
      const entries = log.getEntries();
      expect(entries[0]!.wasCorrected).toBe(false);
      expect(entries[1]!.wasCorrected).toBe(true);
      expect(entries[2]!.wasCorrected).toBe(false);
    });

    it('preserves correction vector with negative values', () => {
      log.push(makeEntry({ correctionX: -12.5, correctionY: 3.7 }));
      const e = log.getEntries()[0]!;
      expect(e.correctionX).toBeCloseTo(-12.5);
      expect(e.correctionY).toBeCloseTo(3.7);
    });

    it('returns stable references after push', () => {
      log.push(makeEntry({ tick: 1 }));
      const before = log.getEntries();
      log.push(makeEntry({ tick: 2 }));
      const after = log.getEntries();
      expect(after).toHaveLength(2);
      expect(before).toHaveLength(1);
    });
  });

  describe('peekLast', () => {
    it('returns null when log is empty', () => {
      expect(log.peekLast()).toBeNull();
    });

    it('returns the most recent pushed entry', () => {
      log.push(makeEntry({ tick: 1 }));
      log.push(makeEntry({ tick: 2, seq: 42 }));
      const last = log.peekLast();
      expect(last).not.toBeNull();
      expect(last!.tick).toBe(2);
      expect(last!.seq).toBe(42);
    });

    it('returns the exact stored reference (zero-copy)', () => {
      const entry = makeEntry({ tick: 9, correctionX: 3, correctionY: 4 });
      log.push(entry);
      expect(log.peekLast()).toBe(entry);
    });

    it('matches getEntries(1)[0] (telemetry equivalence, not yet wrapped)', () => {
      for (let i = 0; i < 5; i++) {
        log.push(makeEntry({ tick: i, seq: i * 10 }));
      }
      const viaOldApi = log.getEntries(1);
      expect(viaOldApi).toHaveLength(1);
      expect(log.peekLast()).toBe(viaOldApi[0]);
      expect(log.peekLast()!.seq).toBe(40);
    });

    it('matches getEntries(1)[0] after wrap-around', () => {
      const l = new ReconciliationLog(4);
      for (let i = 0; i < 9; i++) {
        l.push(makeEntry({ tick: i, seq: i }));
      }
      expect(l.size).toBe(4);
      const viaOldApi = l.getEntries(1);
      expect(viaOldApi).toHaveLength(1);
      expect(viaOldApi[0]!.tick).toBe(8);
      const last = l.peekLast();
      expect(last).toBe(viaOldApi[0]);
      expect(last!.tick).toBe(8);
      expect(last!.seq).toBe(8);
    });

    it('tracks the newest entry across successive pushes at capacity', () => {
      const l = new ReconciliationLog(3);
      for (let i = 0; i < 10; i++) {
        l.push(makeEntry({ tick: i }));
        expect(l.peekLast()!.tick).toBe(i);
      }
    });

    it('returns null after clear', () => {
      log.push(makeEntry({ tick: 1 }));
      log.clear();
      expect(log.peekLast()).toBeNull();
    });
  });

  describe('clear', () => {
    it('resets size to 0', () => {
      log.push(makeEntry());
      log.push(makeEntry());
      log.clear();
      expect(log.size).toBe(0);
    });

    it('empties getEntries result', () => {
      log.push(makeEntry({ tick: 99 }));
      log.clear();
      expect(log.getEntries()).toEqual([]);
    });

    it('allows push after clear', () => {
      log.push(makeEntry({ tick: 1 }));
      log.clear();
      log.push(makeEntry({ tick: 2 }));
      expect(log.size).toBe(1);
      expect(log.getEntries()[0]!.tick).toBe(2);
    });

    it('handles multiple clears', () => {
      log.push(makeEntry());
      log.clear();
      log.clear();
      expect(log.size).toBe(0);
    });
  });

  describe('capacity boundary', () => {
    it('exactly fills capacity without loss', () => {
      const l = new ReconciliationLog(5);
      for (let i = 0; i < 5; i++) {
        l.push(makeEntry({ seq: i }));
      }
      expect(l.size).toBe(5);
      const entries = l.getEntries();
      expect(entries[0]!.seq).toBe(0);
      expect(entries[4]!.seq).toBe(4);
    });

    it('push one over capacity evicts oldest', () => {
      const l = new ReconciliationLog(5);
      for (let i = 0; i < 6; i++) {
        l.push(makeEntry({ seq: i }));
      }
      expect(l.size).toBe(5);
      const entries = l.getEntries();
      expect(entries[0]!.seq).toBe(1);
      expect(entries[4]!.seq).toBe(5);
    });
  });
});
