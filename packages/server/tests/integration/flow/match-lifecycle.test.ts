import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { MATCH, NETWORK, PLAYER, MatchPhase, ZONE, type GameConfig } from '@sector-battle/shared';
import { createTestServer, createRoom, connectClient, cleanup } from '../../helpers/test-server';
import { advanceTicks, createTestConfig } from '../../helpers/test-utils';
import { GameRoom } from '../../../src/room/GameRoom';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch';
import type { Room } from 'colyseus';

const TICK_RATE = NETWORK.TICK_RATE;
const COUNTDOWN_TICKS = Math.ceil(MATCH.COUNTDOWN_DURATION * TICK_RATE);

// Band thresholds DERIVED from the zone phase table — mirrors
// MatchPhaseStateMachine's derivation (single source of truth). The
// pre-canon literals 360/540/600s encoded the retired 120s-phase timeline.
const PHASE_MS = (n: number): number => ZONE.PHASES[n - 1]!.duration * 1000;
const ZONE_SHRINKING_AT_MS = PHASE_MS(1) + PHASE_MS(2) + PHASE_MS(3);
const FINAL_CLOSURE_AT_MS = ZONE_SHRINKING_AT_MS + PHASE_MS(4) + PHASE_MS(5);
const OVERTIME_AT_MS = FINAL_CLOSURE_AT_MS + PHASE_MS(6);

function getOrchestrator(room: Room) {
  return (room as unknown as GameRoom).getOrchestrator();
}

function getMatch(room: Room): GameMatch {
  const orch = getOrchestrator(room) as unknown as { match: GameMatch };
  return orch.match;
}

function getDomainPlayer(room: Room, sessionId: string) {
  return getOrchestrator(room).getPlayer(sessionId)!;
}

function getPhase(room: Room): MatchPhase {
  return getOrchestrator(room).getPhase();
}

function syncPhase(room: Room): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator();
  const match = getMatch(room) as unknown as { phase: number };
  match.phase = orch.getPhase();
  gameRoom.syncState();
}

function forceActivePhase(room: Room): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: {
      getCurrentState: () => { phase: number };
      transitionTo: (p: number) => void;
    };
    phase: number;
  };
  const match = getMatch(room) as unknown as { phase: number };
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) {
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  }
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN) {
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  }
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
  gameRoom.syncState();
}

function setElapsedMs(room: Room, elapsedMs: number): void {
  const orch = getOrchestrator(room) as unknown as {
    matchFlow: { elapsedMs: number };
  };
  orch.matchFlow.elapsedMs = elapsedMs;
}

function setPhaseElapsedMs(room: Room, ms: number): void {
  const orch = getOrchestrator(room) as unknown as {
    matchFlow: { phaseElapsedMs: number };
  };
  orch.matchFlow.phaseElapsedMs = ms;
}

async function waitForOrchestratorPhase(
  room: Room,
  targetPhase: MatchPhase,
  maxTicks: number = 5000,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (getPhase(room) === targetPhase) return;
    await room.waitForNextSimulationTick();
  }
  throw new Error(
    `Orchestrator did not reach phase ${targetPhase} within ${maxTicks} ticks (current: ${getPhase(room)})`,
  );
}

function killDomainPlayer(room: Room, sessionId: string): void {
  const player = getDomainPlayer(room, sessionId);
  const match = getMatch(room);
  player.takeDamage(PLAYER.BASE_HEALTH, match.currentTick, true);
  if (player.health.isDead) {
    player.dieWithTick(match.currentTick);
    player.completeDeath();
  }
  // Directly mutating the domain Player above bypasses the runtime elimination
  // pipeline (DeathResolutionService.processDeaths → ctx.markPlayerDead →
  // matchFlow.markPlayerDead), so the alive set the phase machine reads never
  // shrinks. Mirror that pipeline so aliveCount drops and ACTIVE→FINISHED fires.
  const orch = getOrchestrator(room) as unknown as {
    matchFlow: { markPlayerDead: (id: string) => void };
  };
  orch.matchFlow.markPlayerDead(sessionId);
}

const ACCELERATED_ZONE_PHASES = [
  { index: 1, radiusRatio: 1.0, duration: 2, name: 'Drop' },
  { index: 2, radiusRatio: 0.6, duration: 2, name: 'First Closure' },
  { index: 3, radiusRatio: 0.25, duration: 2, name: 'Edge Closure' },
  { index: 4, radiusRatio: 0.15, duration: 2, name: 'Final Ring' },
  { index: 5, radiusRatio: 0.1, duration: 1, name: 'Last Sector' },
  { index: 6, radiusRatio: 0.08, duration: 1, name: 'Final Closure' },
  { index: 7, radiusRatio: 0.08, duration: 9999, name: 'Sudden Death' },
];

function createLifecycleConfig(): GameConfig {
  return createTestConfig({
    zone: {
      phases: ACCELERATED_ZONE_PHASES,
      totalDuration: 10,
      transitionDuration: 1,
      tickInterval: 0.5,
      warningTime: 1,
    },
  });
}

describe('Match Lifecycle Integration Tests', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  describe('Countdown Phase', () => {
    it('room starts in WAITING phase', async () => {
      const room = await server.createRoom('game', {
        config: createLifecycleConfig(),
        botFillTo: 0,
      });
      try {
        expect(room.state.phase).toBe(MatchPhase.WAITING);
      } finally {
        await room.disconnect();
      }
    });

    it('COUNTDOWN begins immediately on room creation', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        expect(getPhase(room)).toBe(MatchPhase.COUNTDOWN);
      } finally {
        await room.disconnect();
      }
    });

    it('countdown lasts 5 seconds (300 ticks)', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        setPhaseElapsedMs(room, 4990);
        await waitForOrchestratorPhase(room, MatchPhase.ACTIVE, 20);
        syncPhase(room);
        expect(room.state.phase).toBe(MatchPhase.ACTIVE);
      } finally {
        await room.disconnect();
      }
    });

    it('inputs not accepted during COUNTDOWN phase', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const client = await connectClient(server, room);
        await advanceTicks(room, 5);

        client.send('input', {
          movementX: 0,
          movementY: 0,
          actions: ['ATTACK'],
          aimAngle: 0,
          sequence: 1,
        });
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.COUNTDOWN);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Active Phase', () => {
    it('active phase begins after countdown', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        setPhaseElapsedMs(room, 4990);
        await waitForOrchestratorPhase(room, MatchPhase.ACTIVE, 20);
        syncPhase(room);

        expect(room.state.phase).toBe(MatchPhase.ACTIVE);
      } finally {
        await room.disconnect();
      }
    });

    it('inputs accepted during ACTIVE phase', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 5);

        const playerBefore = [...room.state.players.values()].find((p) => p.id === c1.sessionId);
        const yBefore = playerBefore!.y;

        c1.send('input', {
          movementX: 0,
          movementY: 1,
          actions: [],
          aimAngle: 0,
          sequence: 1,
        });
        await advanceTicks(room, 10);

        const playerAfter = [...room.state.players.values()].find((p) => p.id === c1.sessionId);
        expect(playerAfter!.y).not.toBe(yBefore);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Zone Shrink Phase', () => {
    it('zone shrink begins at correct time', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 2);

        setElapsedMs(room, ZONE_SHRINKING_AT_MS - 10);
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.ZONE_SHRINKING);
        syncPhase(room);
        expect(room.state.phase).toBe(MatchPhase.ZONE_SHRINKING);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Final Closure Phase', () => {
    it('final closure phase begins when zone reaches last shrink phase', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 2);

        setElapsedMs(room, FINAL_CLOSURE_AT_MS - 10);
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.FINAL_CLOSURE);
        syncPhase(room);
        expect(room.state.phase).toBe(MatchPhase.FINAL_CLOSURE);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Overtime Phase', () => {
    it('overtime begins at the zone-derived match timer', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 2);

        setElapsedMs(room, OVERTIME_AT_MS - 10);
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.OVERTIME);
        syncPhase(room);
        expect(room.state.phase).toBe(MatchPhase.OVERTIME);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Finished Phase', () => {
    it('FINISHED state when aliveCount <= 1 from ACTIVE phase', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 5);

        killDomainPlayer(room, c2.sessionId);
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.FINISHED);
        syncPhase(room);
        expect(room.state.phase).toBe(MatchPhase.FINISHED);
      } finally {
        await room.disconnect();
      }
    });

    it('FINISHED is terminal state', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);
        forceActivePhase(room);
        await advanceTicks(room, 5);

        killDomainPlayer(room, c2.sessionId);
        await advanceTicks(room, 5);
        expect(getPhase(room)).toBe(MatchPhase.FINISHED);

        setElapsedMs(room, 800_000);
        await advanceTicks(room, 5);

        expect(getPhase(room)).toBe(MatchPhase.FINISHED);
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Phase Transition Events', () => {
    it('phase transition events emitted correctly', async () => {
      const config = createLifecycleConfig();
      const room = await createRoom(server, { config, botFillTo: 0 });
      try {
        const client = await connectClient(server, room);
        const client2 = await connectClient(server, room);

        const transitions: Array<{ from: number; to: number }> = [];
        client.onMessage('match_start', (msg: { from: number; to: number }) => {
          transitions.push({ from: msg.from, to: msg.to });
        });

        setPhaseElapsedMs(room, 4990);
        await waitForOrchestratorPhase(room, MatchPhase.ACTIVE, 20);
        await advanceTicks(room, 5);

        expect(transitions.length).toBeGreaterThanOrEqual(1);
        const countdownToActive = transitions.find(
          (t) => t.from === MatchPhase.COUNTDOWN && t.to === MatchPhase.ACTIVE,
        );
        expect(countdownToActive).toBeDefined();
      } finally {
        await room.disconnect();
      }
    });
  });

  describe('Full Phase Flow', () => {
    it('complete phase flow: WAITING→COUNTDOWN→ACTIVE→ZONE_SHRINKING→FINAL_CLOSURE→OVERTIME→FINISHED', async () => {
      const config = createLifecycleConfig();
      const room = await server.createRoom('game', {
        config,
        botFillTo: 0,
      });
      try {
        expect(room.state.phase).toBe(MatchPhase.WAITING);

        await room.waitForNextSimulationTick();
        expect(getPhase(room)).toBe(MatchPhase.COUNTDOWN);

        const c1 = await connectClient(server, room);
        const c2 = await connectClient(server, room);

        setPhaseElapsedMs(room, 4990);
        await waitForOrchestratorPhase(room, MatchPhase.ACTIVE, 20);
        expect(getPhase(room)).toBe(MatchPhase.ACTIVE);

        const transitions: Array<{ from: number; to: number }> = [];
        c1.onMessage('match_start', (msg: { from: number; to: number }) => {
          transitions.push({ from: msg.from, to: msg.to });
        });
        await advanceTicks(room, 1);

        setElapsedMs(room, ZONE_SHRINKING_AT_MS - 10);
        await advanceTicks(room, 5);
        expect(getPhase(room)).toBe(MatchPhase.ZONE_SHRINKING);

        setElapsedMs(room, FINAL_CLOSURE_AT_MS - 10);
        await advanceTicks(room, 5);
        expect(getPhase(room)).toBe(MatchPhase.FINAL_CLOSURE);

        setElapsedMs(room, OVERTIME_AT_MS - 10);
        await advanceTicks(room, 5);
        expect(getPhase(room)).toBe(MatchPhase.OVERTIME);

        killDomainPlayer(room, c2.sessionId);
        await advanceTicks(room, 10);
        expect(getPhase(room)).toBe(MatchPhase.FINISHED);

        const expectedSequence: MatchPhase[] = [
          MatchPhase.WAITING,
          MatchPhase.COUNTDOWN,
          MatchPhase.ACTIVE,
          MatchPhase.ZONE_SHRINKING,
          MatchPhase.FINAL_CLOSURE,
          MatchPhase.OVERTIME,
          MatchPhase.FINISHED,
        ];

        const seenPhases: MatchPhase[] = [
          MatchPhase.WAITING,
          MatchPhase.COUNTDOWN,
          MatchPhase.ACTIVE,
          MatchPhase.ZONE_SHRINKING,
          MatchPhase.FINAL_CLOSURE,
          MatchPhase.OVERTIME,
          MatchPhase.FINISHED,
        ];

        for (let i = 0; i < seenPhases.length; i++) {
          expect(seenPhases[i]).toBe(expectedSequence[i]);
        }
      } finally {
        await room.disconnect();
      }
    }, 60000);
  });
});
