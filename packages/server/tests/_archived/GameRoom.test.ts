import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameRoom } from '../../src/room/GameRoom.ts';
import { GameStateSchema } from '../../src/infrastructure/schemas/index.ts';
import { PlayerStatus } from '@sector-battle/shared';
import type { Client } from 'colyseus';

function createMockClient(sessionId: string): Client {
  return { sessionId, id: sessionId, readyState: 1, send: vi.fn() } as unknown as Client;
}

describe('GameRoom', () => {
  let room: GameRoom;
  let messageHandlers: Map<string, (client: Client, data: unknown) => void>;

  beforeEach(() => {
    room = new GameRoom();
    messageHandlers = new Map();

    vi.spyOn(GameRoom.prototype as GameRoom, 'setState').mockImplementation(function (
      this: GameRoom,
      state: GameStateSchema,
    ) {
      this.state = state;
    });
    vi.spyOn(GameRoom.prototype as GameRoom, 'setSimulationInterval').mockImplementation(() => {});
    vi.spyOn(GameRoom.prototype as GameRoom, 'broadcast').mockImplementation(() => {});
    vi.spyOn(GameRoom.prototype as GameRoom, 'onMessage').mockImplementation(function (
      this: GameRoom,
      type: string,
      handler: (client: Client, data: unknown) => void,
    ) {
      messageHandlers.set(type, handler);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onCreate initializes state with match metadata', () => {
    room.onCreate({ matchId: 'test-init' });
    const client = createMockClient('init-client');
    room.onJoin(client, { name: 'InitPlayer' });

    expect(room.state).toBeDefined();
    expect(room.state.matchId).toBe('test-init');
    expect(room.state.mapWidth).toBe(80);
    expect(room.state.mapHeight).toBe(80);
    expect(room.state.players.size).toBe(1);
    expect(room.state.projectiles.size).toBe(0);
    expect(room.state.zone).toBeDefined();
    expect(room.maxClients).toBe(64);
  });

  it('onCreate uses provided config', () => {
    room.onCreate({ matchId: 'custom-match', config: undefined });
    const client = createMockClient('config-client');
    room.onJoin(client, { name: 'ConfigPlayer' });

    expect(room.state.matchId).toBe('custom-match');
  });

  it('onCreate generates matchId when not provided', () => {
    room.onCreate({});
    const client = createMockClient('auto-id-client');
    room.onJoin(client, { name: 'AutoIdPlayer' });

    expect(room.state.matchId).toMatch(/^match-\d+$/);
  });

  it('onJoin adds player to state', () => {
    room.onCreate({ matchId: 'test-join' });
    const client = createMockClient('session-1');
    room.onJoin(client, { name: 'TestPlayer' });

    const playerState = room.state.players.get('session-1');
    expect(playerState).toBeDefined();
    expect(playerState.name).toBe('TestPlayer');
    expect(playerState.health).toBe(100);
    expect(playerState.maxHealth).toBe(100);
    expect(playerState.status & PlayerStatus.INVINCIBLE).toBeTruthy();
    expect(room.state.playersAlive).toBe(1);
  });

  it('onJoin uses default name when none provided', () => {
    room.onCreate({ matchId: 'test-default-name' });
    const client = createMockClient('session-2');
    room.onJoin(client, {});

    const playerState = room.state.players.get('session-2');
    expect(playerState).toBeDefined();
    expect(playerState.name).toBe('Player');
  });

  it('onLeave calls orchestrator removePlayer and syncs state', () => {
    room.onCreate({ matchId: 'test-leave' });
    const client = createMockClient('session-3');
    room.onJoin(client, { name: 'LeavingPlayer' });

    expect(room.state.players.get('session-3')).toBeDefined();

    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'removePlayer');
    room.onLeave(client);

    expect(spy).toHaveBeenCalledWith('session-3');
    expect(room.state.players.get('session-3')).toBeDefined();
  });

  it('multiple clients can join', () => {
    room.onCreate({ matchId: 'test-multi' });
    const client1 = createMockClient('session-a');
    const client2 = createMockClient('session-b');
    room.onJoin(client1, { name: 'Player1' });
    room.onJoin(client2, { name: 'Player2' });

    expect(room.state.players.size).toBe(2);
    expect(room.state.players.get('session-a')).toBeDefined();
    expect(room.state.players.get('session-a')!.name).toBe('Player1');
    expect(room.state.players.get('session-b')).toBeDefined();
    expect(room.state.players.get('session-b')!.name).toBe('Player2');
    expect(room.state.playersAlive).toBe(2);
  });

  it('onLeave on one player keeps others intact', () => {
    room.onCreate({ matchId: 'test-partial-leave' });
    const client1 = createMockClient('stay');
    const client2 = createMockClient('go');
    room.onJoin(client1, { name: 'Stays' });
    room.onJoin(client2, { name: 'Leaves' });

    room.onLeave(client2);

    expect(room.state.players.get('stay')).toBeDefined();
    expect(room.state.players.get('stay')!.status & PlayerStatus.INVINCIBLE).toBeTruthy();
    expect(room.state.players.get('go')).toBeDefined();
  });

  it('onDispose stops orchestrator', () => {
    room.onCreate({ matchId: 'test-dispose' });
    const client = createMockClient('dispose-client');
    room.onJoin(client, { name: 'DisposePlayer' });
    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'removePlayer');
    room.onDispose();
    expect(room.state.matchId).toBe('test-dispose');
    expect(spy).not.toHaveBeenCalled();
  });

  it('registers input message handler on create', () => {
    room.onCreate({ matchId: 'test-handlers' });

    expect(messageHandlers.has('input')).toBe(true);
  });

  it('valid MOVE input routes to orchestrator', () => {
    room.onCreate({ matchId: 'test-move-msg' });
    const client = createMockClient('move-player');
    room.onJoin(client, { name: 'MovePlayer' });

    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'handleInput');

    const inputHandler = messageHandlers.get('input')!;
    inputHandler(client, { movementX: 1, movementY: 0, sequence: 1 });

    expect(spy).toHaveBeenCalledWith(
      'move-player',
      expect.anything(),
      expect.objectContaining({
        dx: expect.any(Number),
        dy: expect.any(Number),
        tick: expect.any(Number),
      }),
    );
  });

  it('input with no movement does not trigger MOVE', () => {
    room.onCreate({ matchId: 'test-no-move' });
    const client = createMockClient('no-move-player');
    room.onJoin(client, { name: 'NoMovePlayer' });

    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'handleInput');

    const inputHandler = messageHandlers.get('input')!;
    inputHandler(client, { movementX: 0, movementY: 0, sequence: 1 });

    expect(spy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ direction: expect.any(Number) }),
    );
  });

  it('valid ATTACK action routes to orchestrator', () => {
    room.onCreate({ matchId: 'test-attack-msg' });
    const client = createMockClient('attack-player');
    room.onJoin(client, { name: 'AttackPlayer' });

    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'handleInput');

    const inputHandler = messageHandlers.get('input')!;
    inputHandler(client, {
      movementX: 0,
      movementY: 0,
      sequence: 1,
      aimAngle: 0.7,
      actions: ['ATTACK'],
    });

    expect(spy).toHaveBeenCalledWith(
      'attack-player',
      expect.anything(),
      expect.objectContaining({ aimAngle: 0.7 }),
    );
  });

  it('invalid input payload is silently dropped', () => {
    room.onCreate({ matchId: 'test-invalid-input' });
    const client = createMockClient('invalid-input-player');
    room.onJoin(client, { name: 'InvalidInputPlayer' });

    const orchestrator = room.getOrchestrator();
    const spy = vi.spyOn(orchestrator, 'handleInput');

    const inputHandler = messageHandlers.get('input')!;
    inputHandler(client, 'not-an-object');

    expect(spy).not.toHaveBeenCalled();
  });
});
