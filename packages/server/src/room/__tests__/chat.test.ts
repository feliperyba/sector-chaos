import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerChatHandler } from '../handlers/chat.ts';
import { PlayerStatus, MATCH } from '@sector-battle/shared';

interface MockPlayer {
  id: string;
  name: string;
  statusEffects: { status: number };
}

interface MockPlayerOverrides {
  id?: string;
  name?: string;
  status?: number;
}

interface MockRoom {
  onMessage: ReturnType<typeof vi.fn>;
  getOrchestrator: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
}

function createMockRoom(): {
  room: MockRoom;
  getPlayer: ReturnType<typeof vi.fn>;
  getCallback: () => ((client: unknown, data: unknown) => void) | null;
} {
  let chatCallback: ((client: unknown, data: unknown) => void) | null = null;
  const getPlayer = vi.fn();
  const room: MockRoom = {
    onMessage: vi.fn((type: string, cb: (client: unknown, data: unknown) => void) => {
      if (type === 'chat') chatCallback = cb;
    }),
    getOrchestrator: vi.fn(() => ({ getPlayer })),
    broadcast: vi.fn(),
  };
  return { room, getPlayer, getCallback: () => chatCallback };
}

function createMockClient(sessionId = 'test-id') {
  return { sessionId, send: vi.fn() };
}

function createMockPlayer(overrides: MockPlayerOverrides = {}): MockPlayer {
  return {
    id: overrides.id ?? 'test-id',
    name: overrides.name ?? 'TestPlayer',
    statusEffects: { status: overrides.status ?? PlayerStatus.ALIVE },
  };
}

describe('registerChatHandler', () => {
  let mockRoom: MockRoom;
  let getPlayer: ReturnType<typeof vi.fn>;
  let getCallback: () => ((client: unknown, data: unknown) => void) | null;
  let lastChatTime: Map<string, number>;

  beforeEach(() => {
    const setup = createMockRoom();
    mockRoom = setup.room;
    getPlayer = setup.getPlayer;
    getCallback = setup.getCallback;
    lastChatTime = new Map();
    registerChatHandler(mockRoom, lastChatTime);
  });

  it('blocks SPECTATING players from sending chat', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.SPECTATING });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(client.send).toHaveBeenCalledWith('chatError', { reason: 'spectators_cannot_chat' });
    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('blocks DEAD players from sending chat', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.DEAD });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(client.send).toHaveBeenCalledWith('chatError', { reason: 'spectators_cannot_chat' });
    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('blocks DYING players from sending chat', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.DYING });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(client.send).toHaveBeenCalledWith('chatError', { reason: 'spectators_cannot_chat' });
    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('allows ALIVE players to send chat and broadcasts', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.ALIVE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    const beforeCall = Date.now();
    callback!(client, { text: 'hello everyone' });

    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);
    const broadcastCall = mockRoom.broadcast.mock.calls[0]!;
    expect(broadcastCall[0]).toBe('chat');
    expect(broadcastCall[1]).toMatchObject({
      senderId: 'test-id',
      senderName: 'TestPlayer',
      text: 'hello everyone',
    });
    expect(broadcastCall[1].timestamp).toBeGreaterThanOrEqual(beforeCall);
  });

  it('rate limits messages within cooldown period', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.ALIVE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'first message' });
    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);

    callback!(client, { text: 'second message' });
    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);
  });

  it('allows message after rate limit cooldown', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.ALIVE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    const pastTime = Date.now() - MATCH.CHAT_RATE_LIMIT_MS - 100;
    lastChatTime.set('test-id', pastTime);

    callback!(client, { text: 'delayed message' });
    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);
  });

  it('silently drops invalid input', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.ALIVE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 123 });
    callback!(client, {});
    callback!(client, { text: '' });

    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('silently drops when player not found', () => {
    const client = createMockClient();
    getPlayer.mockReturnValue(undefined);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(client.send).not.toHaveBeenCalled();
    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('silently drops non-ALIVE status without SPECTATING/DEAD/DYING flags', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.INVINCIBLE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(client.send).not.toHaveBeenCalled();
    expect(mockRoom.broadcast).not.toHaveBeenCalled();
  });

  it('allows ALIVE with additional status flags', () => {
    const client = createMockClient();
    const player = createMockPlayer({ status: PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE });
    getPlayer.mockReturnValue(player);

    const callback = getCallback();
    callback!(client, { text: 'hello' });

    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);
  });

  it('independent rate limiting per session', () => {
    const client1 = createMockClient('session-1');
    const client2 = createMockClient('session-2');
    const player1 = createMockPlayer({ id: 'session-1', status: PlayerStatus.ALIVE });
    const player2 = createMockPlayer({ id: 'session-2', status: PlayerStatus.ALIVE });

    const callback = getCallback();

    getPlayer.mockReturnValue(player1);
    callback!(client1, { text: 'from client1' });
    expect(mockRoom.broadcast).toHaveBeenCalledTimes(1);

    getPlayer.mockReturnValue(player2);
    callback!(client2, { text: 'from client2' });
    expect(mockRoom.broadcast).toHaveBeenCalledTimes(2);
  });
});
