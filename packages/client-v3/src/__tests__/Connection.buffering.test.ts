import { describe, it, expect, vi } from 'vitest';
import { MessageBuffer } from '../network/MessageBuffer.js';
import { Connection } from '../network/Connection.js';

/**
 * Minimal Room stub. Captures onMessage registrations and lets the test
 * dispatch messages to verify buffering/replay behavior.
 */
function makeRoomStub() {
  // Handlers keyed by message type. Wildcard is stored under '*'.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (...args: any[]) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMessage = vi.fn((type: string | number, cb: (...args: any[]) => void) => {
    handlers.set(String(type), cb);
    return () => handlers.delete(String(type));
  });
  return {
    sessionId: 'test-session',
    roomId: 'test-room',
    handlers,
    onMessage,
    onLeave: vi.fn(),
    onError: vi.fn(),
    leave: vi.fn(),
    // Helper for tests to dispatch a message as Colyseus would
    dispatch(type: string, data: unknown) {
      const handler = handlers.get(type);
      if (handler) {
        handler(data);
      } else {
        const wildcard = handlers.get('*');
        if (wildcard) wildcard(type, data);
      }
    },
    hasHandler(type: string) {
      return handlers.has(type);
    },
  };
}

describe('MessageBuffer', () => {
  it('buffers messages arriving before handlers register (matchmaking path)', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);

    // Messages arrive during scene transition (no specific handlers yet)
    room.dispatch('match_start', { matchId: 'abc' });
    room.dispatch('pickup', { item: 'sword' });
    room.dispatch('attack', { attacker: 'p1' });

    expect(buffer.size).toBe(3);

    // Now register real handlers via drain() (as Connection does)
    const matchStartCb = vi.fn();
    const pickupCb = vi.fn();
    buffer.drain(room as never, 'match_start', matchStartCb);
    buffer.drain(room as never, 'pickup', pickupCb);

    // Buffered messages should have been replayed to the real handlers
    expect(matchStartCb).toHaveBeenCalledTimes(1);
    expect(matchStartCb).toHaveBeenCalledWith({ matchId: 'abc' });
    expect(pickupCb).toHaveBeenCalledTimes(1);
    expect(pickupCb).toHaveBeenCalledWith({ item: 'sword' });

    // 'attack' is still buffered (no handler registered for it)
    expect(buffer.size).toBe(1);

    // New messages of these types now go directly (not via wildcard)
    room.dispatch('match_start', { matchId: 'def' });
    expect(matchStartCb).toHaveBeenCalledTimes(2);
    expect(matchStartCb).toHaveBeenLastCalledWith({ matchId: 'def' });

    buffer.detach();
  });

  it('does not double-deliver when handler registers before message arrives', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);

    const cb = vi.fn();
    buffer.drain(room as never, 'attack', cb);

    // Handler registered — now message arrives
    room.dispatch('attack', { attacker: 'p1' });

    expect(cb).toHaveBeenCalledTimes(1);
    buffer.detach();
  });

  it('does not buffer internal __ prefixed messages', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);

    room.dispatch('__schema_patch', null);
    room.dispatch('match_start', null);

    expect(buffer.size).toBe(1);
    buffer.detach();
  });

  it('detach removes the wildcard handler', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);
    expect(room.hasHandler('*')).toBe(true);
    buffer.detach();
    expect(room.hasHandler('*')).toBe(false);
  });

  it('detach is idempotent', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);
    buffer.detach();
    buffer.detach(); // no throw
    expect(room.hasHandler('*')).toBe(false);
  });

  it('caps buffer at MAX_BUFFERED_MESSAGES to prevent unbounded growth', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);

    // Spam 1000 messages
    for (let i = 0; i < 1000; i++) {
      room.dispatch('attack', { i });
    }

    // Buffer should be capped (MAX_BUFFERED_MESSAGES = 500 in source)
    expect(buffer.size).toBeLessThanOrEqual(500);
    buffer.detach();
  });
});

describe('Connection + MessageBuffer integration', () => {
  it('connectWithRoom adopts supplied buffer and drains on handler register', () => {
    const room = makeRoomStub();
    const buffer = MessageBuffer.attach(room as never);

    // Messages arrive while buffer is attached
    room.dispatch('match_start', { phase: 2 });
    room.dispatch('pickup', { item: 'bow' });

    const conn = new Connection();
    conn.connectWithRoom(room as never, buffer);

    // Register handlers — should drain the buffer
    const matchStartCb = vi.fn();
    conn.onMessage('match_start', matchStartCb);

    expect(matchStartCb).toHaveBeenCalledTimes(1);
    expect(matchStartCb).toHaveBeenCalledWith({ phase: 2 });

    conn.detachMessageBuffer();
  });

  it('detachMessageBuffer cleans up the wildcard on disconnect', () => {
    const room = makeRoomStub();
    const conn = new Connection();
    conn.connectWithRoom(room as never);
    conn.disconnect();
    expect(room.hasHandler('*')).toBe(false);
  });

  it('connectWithRoom called twice detaches the first buffer (no leak)', () => {
    const roomA = makeRoomStub();
    const roomB = makeRoomStub();
    const conn = new Connection();
    conn.connectWithRoom(roomA as never);
    expect(roomA.hasHandler('*')).toBe(true);
    conn.connectWithRoom(roomB as never);
    // roomA's wildcard should be detached
    expect(roomA.hasHandler('*')).toBe(false);
    expect(roomB.hasHandler('*')).toBe(true);
    conn.disconnect();
  });
});
