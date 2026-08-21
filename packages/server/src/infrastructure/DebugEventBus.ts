import { EventEmitter } from 'node:events';
import type { GameEvent } from '../domain/events/index.ts';

class DebugEventBus {
  private emitter: EventEmitter;
  private static instance: DebugEventBus;

  private constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
  }

  static getInstance(): DebugEventBus {
    if (!DebugEventBus.instance) {
      DebugEventBus.instance = new DebugEventBus();
    }
    return DebugEventBus.instance;
  }

  emitEvents(events: GameEvent[]): void {
    // Hot-path guard: the Docker dev server (NODE_ENV=development) calls this
    // every tick with the full drained event list, but in the default run there
    // are ZERO listeners — the only subscriber is the optional debug HTTP tap
    // wired in `index.ts`. Node's EventEmitter.emit still acquires the handler
    // array and runs its guard bookkeeping per call even with no listeners, so
    // a 64-player brawl (dozens of events/tick) paid a pure per-event tax that
    // the benchmark never measured (the harness drives the sim directly,
    // bypassing `handleSimulationTick`). Short-circuit when nobody is listening.
    if (this.emitter.listenerCount('event') === 0) return;
    for (const event of events) {
      this.emitter.emit('event', event);
    }
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.emitter.on('event', handler);
  }

  offEvent(handler: (event: GameEvent) => void): void {
    this.emitter.off('event', handler);
  }
}

export const debugEventBus = DebugEventBus.getInstance();
