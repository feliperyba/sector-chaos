import type { ColyseusTestServer } from '@colyseus/testing';
type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;
import type { Room } from 'colyseus';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import type { PlayerSchema } from '../../src/infrastructure/schemas/PlayerSchema';
import { MatchPhase, NETWORK, InputAction } from '@sector-battle/shared';
import { connectClient, createRoom } from './test-server';
import { advanceTicks, advanceSeconds, waitForPhase } from './test-utils';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { EventMapper } from '../../src/infrastructure/mappers/EventMapperHandlers';

interface CreateGameRoomOptions {
  matchId?: string;
  seed?: number;
  botFillTo?: number;
  botDifficulty?: 'easy' | 'normal' | 'hard';
  mapType?: 'procedural' | 'demo';
  forceActivePhase?: boolean;
}

export class GameRoomHelper {
  private clients: TestClient[] = [];

  constructor(
    private readonly server: ColyseusTestServer,
    private readonly room: Room<{ state: GameStateSchema }>,
  ) {}

  get state(): GameStateSchema {
    return this.room.state;
  }

  get playersAlive(): number {
    return this.room.state.playersAlive;
  }

  get phase(): number {
    return this.room.state.phase;
  }

  get tick(): number {
    return this.room.state.tick;
  }

  async addPlayer(name?: string): Promise<TestClient> {
    const client = await connectClient(this.server, this.room, { name });
    this.clients.push(client);
    return client;
  }

  async removePlayer(client: TestClient): Promise<void> {
    const gameRoom = this.room as unknown as GameRoom & {
      removedPlayers: Set<string>;
    };
    const orch = gameRoom.getOrchestrator();
    gameRoom.removedPlayers.add(client.sessionId);
    orch.removePlayer(client.sessionId);
    orch.getMatch().hardRemovePlayerForBenchmark(client.sessionId);
    gameRoom.syncState();
  }

  async sendInput(
    client: TestClient,
    input: {
      movementX?: number;
      movementY?: number;
      aimAngle?: number;
      actions?: string[];
    },
  ): Promise<void> {
    const gameRoom = this.room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator();
    const seq = this.room.state.tick;
    const mx = input.movementX ?? 0;
    const my = input.movementY ?? 0;
    const aim = input.aimAngle ?? 0;

    if (mx !== 0 || my !== 0) {
      orch.handleInput(
        client.sessionId,
        InputAction.MOVE,
        { dx: mx, dy: my, aimAngle: aim, tick: seq },
        seq,
      );
    }

    for (const action of input.actions ?? []) {
      switch (action) {
        case 'ATTACK':
          orch.handleInput(client.sessionId, InputAction.ATTACK, { aimAngle: aim, tick: seq }, seq);
          break;
        case 'DASH':
          orch.handleInput(client.sessionId, InputAction.DASH, { dx: mx, dy: my, tick: seq }, seq);
          break;
        case 'THROW':
          orch.handleInput(client.sessionId, InputAction.THROW, { aimAngle: aim, tick: seq }, seq);
          break;
        case 'PICKUP':
          orch.handleInput(client.sessionId, InputAction.PICKUP, { targetId: '', tick: seq }, seq);
          break;
        case 'WEAPON_SLOT_1':
          orch.handleInput(
            client.sessionId,
            InputAction.SWITCH_SLOT,
            { slotIndex: 0, tick: seq },
            seq,
          );
          break;
        case 'WEAPON_SLOT_2':
          orch.handleInput(
            client.sessionId,
            InputAction.SWITCH_SLOT,
            { slotIndex: 1, tick: seq },
            seq,
          );
          break;
        case 'WEAPON_SLOT_3':
          orch.handleInput(
            client.sessionId,
            InputAction.SWITCH_SLOT,
            { slotIndex: 2, tick: seq },
            seq,
          );
          break;
        case 'WEAPON_SLOT_4':
          orch.handleInput(
            client.sessionId,
            InputAction.SWITCH_SLOT,
            { slotIndex: 3, tick: seq },
            seq,
          );
          break;
      }
    }
  }

  getPlayer(client: TestClient): PlayerSchema | undefined {
    return this.room.state.players.get(client.sessionId);
  }

  getAllPlayers(): PlayerSchema[] {
    return Array.from(this.room.state.players.values());
  }

  async advanceTicks(count: number): Promise<void> {
    const gameRoom = this.room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator();
    for (let i = 0; i < count; i++) {
      const events = orch.update(NETWORK.TICK_INTERVAL);
      const messages = EventMapper.broadcastEvents(events);
      for (const { channel, message } of messages) {
        this.room.broadcast(channel, message);
      }
    }
    gameRoom.syncState();
  }

  async advanceSeconds(seconds: number): Promise<void> {
    const ticks = Math.ceil(seconds * NETWORK.TICK_RATE);
    await this.advanceTicks(ticks);
  }

  /**
   * Advance ticks AND run the room's full simulation tick handler
   * (handleSimulationTick). This is needed for tests that depend on
   * side-effects that live in GameRoomMessages.ts (spectator follow targets,
   * reconnection processing, grid updates) rather than in the orchestrator's
   * event stream. Uses reflection to call the private onSimulationTick.
   */
  async advanceTicksWithRoom(count: number): Promise<void> {
    const gameRoom = this.room as unknown as {
      onSimulationTick: () => void;
      syncState: () => void;
    };
    for (let i = 0; i < count; i++) {
      gameRoom.onSimulationTick();
    }
    gameRoom.syncState();
  }

  forceActive(): void {
    const gameRoom = this.room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as GameOrchestrator & {
      matchFlow: {
        getCurrentState: () => { phase: number };
        transitionTo: (p: number) => void;
        phase: number;
        phaseElapsedMs: number;
        alivePlayerIds: Set<string>;
        playerIds: string[];
      };
      phase: number;
      setLastStandingThreshold: (n: number) => void;
      matchEndedEmitted: boolean;
    };
    const match = (
      gameRoom.getOrchestrator() as unknown as {
        match: GameMatch & {
          phase: number;
          forEachAlivePlayer: (cb: (p: { id: string }) => void) => void;
        };
      }
    ).match;

    // CRITICAL: Disable last-standing check. In bot tests, bots spawn
    // asynchronously (BotManager uses a delayed interval of 5000/count ms).
    // When forceActive() runs before all bots have registered, alivePlayerIds
    // contains only the human client. With GameRoom's lastStandingThreshold=1,
    // aliveCount=1 triggers an immediate ACTIVE→FINISHED transition, causing
    // all bot inputs to be silently discarded by isInputAllowed()=false.
    orch.setLastStandingThreshold(-1);
    (orch as any).matchEndedEmitted = false;

    const current = orch.matchFlow.getCurrentState().phase;
    if (current === MatchPhase.WAITING) {
      orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
    }
    if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN) {
      orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
    }
    // If already FINISHED (match ended on a prior tick), force back to ACTIVE.
    if (orch.matchFlow.getCurrentState().phase !== MatchPhase.ACTIVE) {
      orch.matchFlow.phase = MatchPhase.ACTIVE;
      orch.matchFlow.phaseElapsedMs = 0;
    }

    // Ensure all currently-alive players are tracked by matchFlow so
    // tickPhaseTransitions sees the correct aliveCount.
    match.forEachAlivePlayer((p: { id: string }) => {
      if (!orch.matchFlow.alivePlayerIds.has(p.id)) {
        orch.matchFlow.alivePlayerIds.add(p.id);
      }
      if (!orch.matchFlow.playerIds.includes(p.id)) {
        orch.matchFlow.playerIds.push(p.id);
      }
    });

    orch.phase = MatchPhase.ACTIVE;
    match.phase = MatchPhase.ACTIVE;
    gameRoom.syncState();
  }

  // OVERRIDE: attach full match for state-based visibility
  getMatch(): GameMatch | undefined {
    const gameRoom = this.room as unknown as GameRoom;
    try {
      return gameRoom.getOrchestrator().getMatch();
    } catch {
      return undefined;
    }
  }
}

export async function createGameRoom(
  server: ColyseusTestServer,
  options: CreateGameRoomOptions = {},
): Promise<{
  room: Room<{ state: GameStateSchema }>;
  helper: GameRoomHelper;
}> {
  const room = await createRoom(server, {
    matchId: options.matchId,
    seed: options.seed,
    botFillTo: options.botFillTo,
    botDifficulty: options.botDifficulty,
    mapType: options.mapType ?? 'procedural',
    forceActivePhase: options.forceActivePhase,
  });
  const helper = new GameRoomHelper(server, room);
  return { room, helper };
}
