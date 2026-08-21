export const RECONCILIATION_LOG_CAPACITY = 100;

export interface ReconciliationEntry {
  tick: number;
  seq: number;
  serverX: number;
  serverY: number;
  localX: number;
  localY: number;
  correctionX: number;
  correctionY: number;
  wasCorrected: boolean;
}

export class ReconciliationLog {
  private readonly buf: (ReconciliationEntry | null)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number = RECONCILIATION_LOG_CAPACITY) {
    this.buf = Array.from({ length: capacity }, () => null);
  }

  push(entry: ReconciliationEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getEntries(count?: number): ReconciliationEntry[] {
    const n = count !== undefined ? Math.min(count, this.count) : this.count;
    if (n === 0) return [];

    const result: ReconciliationEntry[] = [];
    const start = this.count < this.capacity ? 0 : this.head;

    const total = this.count;
    const offset = total - n;

    for (let i = 0; i < n; i++) {
      const idx = (start + offset + i) % this.capacity;
      const entry = this.buf[idx];
      if (entry) result.push(entry);
    }

    return result;
  }

  /**
   * Most recent entry WITHOUT allocating anything (perf H-4 — the per-frame
   * telemetry deps read this twice every frame; `getEntries(1)` allocated a
   * fresh result array per call). Ring math: `head` is the next write slot, so
   * the newest entry lives at `(head - 1 + capacity) % capacity`; `null` when
   * the log is empty.
   *
   * READ-ONLY contract: returns the exact reference stored in the ring buffer
   * (`push` stores caller references — it does not copy). Callers MUST NOT
   * mutate the returned entry; a mutation would corrupt every other reader
   * (`getEntries` / DebugBridge) since the reference is shared. Read fields
   * only.
   */
  peekLast(): ReconciliationEntry | null {
    if (this.count === 0) return null;
    // Sound non-null: count > 0 means this slot was written by push (push
    // writes before advancing head) and only clear() nulls slots — which also
    // resets count to 0.
    return this.buf[(this.head - 1 + this.capacity) % this.capacity]!;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(null);
  }

  get size(): number {
    return this.count;
  }

  getCapacity(): number {
    return this.capacity;
  }
}
