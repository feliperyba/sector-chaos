import { InputAction, type InputActionData } from '@sector-battle/shared';

export interface QueuedInput {
  playerId: string;
  action: InputAction;
  data: InputActionData;
  clientTick: number;
  serverTick: number;
  receivedAt: number;
}

export class InputQueue {
  private queue: Map<number, QueuedInput[]>;
  private readonly bufferSize: number;

  constructor(bufferSize: number = 120) {
    this.queue = new Map();
    this.bufferSize = bufferSize;
  }

  enqueue(input: QueuedInput): void {
    let bucket = this.queue.get(input.serverTick);
    if (!bucket) {
      bucket = [];
      this.queue.set(input.serverTick, bucket);
    }
    const existingIndex = bucket.findIndex(
      (i) => i.playerId === input.playerId && i.action === input.action,
    );
    if (existingIndex !== -1) {
      bucket[existingIndex] = input;
    } else {
      bucket.push(input);
    }
    this.autoDiscard(input.serverTick);
  }

  private autoDiscard(currentTick: number): void {
    const threshold = currentTick - this.bufferSize;
    for (const key of this.queue.keys()) {
      if (key < threshold) {
        this.queue.delete(key);
      }
    }
  }

  dequeueTick(tick: number): QueuedInput[] {
    const inputs = this.queue.get(tick) ?? [];
    this.queue.delete(tick);
    return inputs;
  }

  getPendingCount(): number {
    let count = 0;
    for (const bucket of this.queue.values()) {
      count += bucket.length;
    }
    return count;
  }

  clear(): void {
    this.queue.clear();
  }

  discardBefore(tick: number): void {
    for (const key of this.queue.keys()) {
      if (key < tick) {
        this.queue.delete(key);
      }
    }
  }
}
