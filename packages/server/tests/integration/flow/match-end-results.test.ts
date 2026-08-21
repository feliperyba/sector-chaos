import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../../helpers/game-room-helper';
import {
  PLAYER,
  NETWORK,
  COMBAT,
  MATCH,
  MatchPhase,
  WeaponType,
  TileType,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../../src/room/GameRoom';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch';
import { Position } from '../../../src/domain/value-objects/index';
import { MatchEndService } from '../../../src/domain/services/MatchEndService';
import type { PlayerRoundStats } from '../../../src/domain/services/MatchEndService';
import type { EliminationRecord } from '../../../src/domain/services/EliminationService';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const DEATH_ANIM_TICKS = Math.ceil(COMBAT.DEATH_ANIMATION_DURATION * NETWORK.TICK_RATE);
const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);

const POS_A = { x: 5120, y: 5100 };
const POS_B = { x: 5120, y: 5170 };
const POS_C = { x: 5190, y: 5100 };
const POS_D = { x: 5190, y: 5170 };

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await cleanup(server);
});

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as { match: GameMatch };
  return orch.match;
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  return (room as unknown as GameRoom).getOrchestrator().getPlayer(sessionId)!;
}

function clearArea(grid: TileType[][], cx: number, cy: number, radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gy = cy + dy;
      const gx = cx + dx;
      if (gy >= 0 && gy < grid.length && gx >= 0 && gx < grid[0]!.length) {
        grid[gy]![gx] = TileType.EMPTY;
      }
    }
  }
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
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

function syncPhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator();
  const match = getMatch(room) as unknown as { phase: number };
  match.phase = orch.getPhase();
  gameRoom.syncState();
}

function killPlayerDirect(
  room: Room<{ state: GameStateSchema }>,
  targetId: string,
  killerId: string | null,
  weaponType: WeaponType,
  tick: number,
): void {
  const target = getDomainPlayer(room, targetId);
  if (killerId !== null) {
    target.statusEffects.lastDamageSource = {
      playerId: killerId,
      weaponType: String(weaponType),
      tick,
    };
  } else {
    target.statusEffects.lastDamageSource = null;
  }
  target.takeDamage(PLAYER.BASE_HEALTH, tick, true);
}

async function setupFourPlayers(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
): Promise<[TestClient, TestClient, TestClient, TestClient]> {
  const p1 = await helper.addPlayer('P1');
  const p2 = await helper.addPlayer('P2');
  const p3 = await helper.addPlayer('P3');
  const p4 = await helper.addPlayer('P4');

  getDomainPlayer(room, p1.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
  getDomainPlayer(room, p2.sessionId).movement.position = new Position(POS_B.x, POS_B.y);
  getDomainPlayer(room, p3.sessionId).movement.position = new Position(POS_C.x, POS_C.y);
  getDomainPlayer(room, p4.sessionId).movement.position = new Position(POS_D.x, POS_D.y);

  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);

  return [p1, p2, p3, p4];
}

async function setupTwoPlayers(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
): Promise<[TestClient, TestClient]> {
  const p1 = await helper.addPlayer('P1');
  const p2 = await helper.addPlayer('P2');

  getDomainPlayer(room, p1.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
  getDomainPlayer(room, p2.sessionId).movement.position = new Position(POS_B.x, POS_B.y);

  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);

  return [p1, p2];
}

interface MatchEndMessage {
  type: string;
  winnerId: string;
  placements: Array<{
    playerId: string;
    placement: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    itemsCollected: number;
    survivalTimeMs: number;
    weaponsUsed: number;
  }>;
  stats: unknown[];
}

function waitForMatchEnd(client: TestClient): Promise<MatchEndMessage> {
  return new Promise<MatchEndMessage>((resolve) => {
    client.onMessage('match_end', (msg: MatchEndMessage) => {
      resolve(msg);
    });
  });
}

describe('Match End & Results Integration Tests', () => {
  describe('Match End: Last Player Standing', () => {
    it('match ends when 1 player alive', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      syncPhase(room);
      expect(room.state.playersAlive).toBe(1);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);
    });

    it('winner is the last player alive', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      const matchEndPromise = waitForMatchEnd(p1);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const matchEnd = await matchEndPromise;
      expect(matchEnd.winnerId).toBe(p1.sessionId);
      expect(matchEnd.placements.length).toBeGreaterThan(0);
    });
  });

  describe('Match End: All Players Dead', () => {
    it('match ends when 0 players alive (all dead same tick)', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p1.sessionId, p2.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      syncPhase(room);
      expect(room.state.playersAlive).toBe(0);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);
    });

    it('mutual kill: tiebreaker determines winner', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      const matchEndP1 = waitForMatchEnd(p1);
      const matchEndP2 = waitForMatchEnd(p2);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p1.sessionId, p2.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const matchEnd = await Promise.race([matchEndP1, matchEndP2]);
      expect(matchEnd.winnerId).toBeDefined();
      expect(matchEnd.winnerId).not.toBe('');
      expect(matchEnd.winnerId === p1.sessionId || matchEnd.winnerId === p2.sessionId).toBe(true);
      expect(matchEnd.placements.length).toBe(2);
      expect(matchEnd.placements[0]!.placement).toBe(1);
      expect(matchEnd.placements[1]!.placement).toBe(2);
    });
  });

  describe('Elimination Records', () => {
    it('elimination records complete', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(5);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(5);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const records = [...room.state.eliminationRecords.values()];
      expect(records.length).toBeGreaterThanOrEqual(3);

      const r2 = records.find((r) => r.playerId === p2.sessionId);
      const r3 = records.find((r) => r.playerId === p3.sessionId);
      const r4 = records.find((r) => r.playerId === p4.sessionId);

      expect(r2).toBeDefined();
      expect(r3).toBeDefined();
      expect(r4).toBeDefined();

      expect(r2!.killerId).toBe(p1.sessionId);
      expect(r3!.killerId).toBe(p1.sessionId);
      expect(r4!.killerId).toBe(p1.sessionId);

      expect(r2!.order).toBeGreaterThan(0);
      expect(r3!.order).toBeGreaterThan(0);
      expect(r4!.order).toBeGreaterThan(0);
      expect(r2!.timestamp).toBeGreaterThan(0);
      expect(r3!.timestamp).toBeGreaterThan(0);
      expect(r4!.timestamp).toBeGreaterThan(0);

      expect(r2!.order).toBeLessThan(r3!.order);
      expect(r3!.order).toBeLessThan(r4!.order);
    });

    it('elimination records include environmental deaths', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, null, WeaponType.FISTS, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const records = [...room.state.eliminationRecords.values()];
      const envRecord = records.find((r) => r.playerId === p2.sessionId);
      expect(envRecord).toBeDefined();
      expect(envRecord!.killerId).toBe('');
      expect(envRecord!.order).toBeGreaterThan(0);
      expect(envRecord!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('4-Way Tiebreaker', () => {
    const matchEndService = new MatchEndService();

    function makeStat(
      overrides: Partial<PlayerRoundStats> & { playerId: string },
    ): PlayerRoundStats {
      return {
        alive: false,
        hp: 0,
        kills: 0,
        damageDealt: 0,
        damageTaken: 0,
        itemsCollected: 0,
        survivalTimeMs: 0,
        weaponsUsed: 0,
        ...overrides,
      };
    }

    function makeElimination(playerId: string, order: number): EliminationRecord {
      return {
        order,
        playerId,
        killerId: null,
        weaponType: null,
        timestamp: Date.now(),
        position: { x: 0, y: 0 },
      };
    }

    it('tiebreaker: primary sort is alive vs dead', () => {
      const stats: PlayerRoundStats[] = [
        makeStat({ playerId: 'A', alive: true, hp: 100 }),
        makeStat({ playerId: 'B', alive: false, kills: 10, damageDealt: 500 }),
        makeStat({ playerId: 'C', alive: false, kills: 8, damageDealt: 400 }),
        makeStat({ playerId: 'D', alive: false, kills: 6, damageDealt: 300 }),
      ];
      const eliminations: EliminationRecord[] = [
        makeElimination('B', 1),
        makeElimination('C', 2),
        makeElimination('D', 3),
      ];

      const placements = matchEndService.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('A');
      expect(placements[0]!.placement).toBe(1);
      expect(placements.length).toBe(4);
    });

    it('tiebreaker: elimination order when multiple dead', () => {
      const stats: PlayerRoundStats[] = [makeStat({ playerId: 'B' }), makeStat({ playerId: 'C' })];
      const eliminations: EliminationRecord[] = [makeElimination('B', 1), makeElimination('C', 2)];

      const placements = matchEndService.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('C');
      expect(placements[1]!.playerId).toBe('B');
      expect(placements[0]!.placement).toBe(1);
      expect(placements[1]!.placement).toBe(2);
    });

    it('tiebreaker 3: most kills when elimination order tied', () => {
      const stats: PlayerRoundStats[] = [
        makeStat({ playerId: 'A', kills: 5 }),
        makeStat({ playerId: 'B', kills: 3 }),
        makeStat({ playerId: 'C', kills: 2 }),
        makeStat({ playerId: 'D', kills: 1 }),
      ];

      const placements = matchEndService.calculatePlacements(stats, []);

      expect(placements.map((p) => p.playerId)).toEqual(['A', 'B', 'C', 'D']);
      expect(placements[0]!.placement).toBe(1);
    });

    it('tiebreaker 4: total damage dealt when kills tied', () => {
      const stats: PlayerRoundStats[] = [
        makeStat({ playerId: 'A', kills: 3, damageDealt: 250 }),
        makeStat({ playerId: 'B', kills: 3, damageDealt: 180 }),
      ];

      const placements = matchEndService.calculatePlacements(stats, []);

      expect(placements[0]!.playerId).toBe('A');
      expect(placements[1]!.playerId).toBe('B');
    });

    it('tiebreaker 5: survival time when kills and damage tied', () => {
      const stats: PlayerRoundStats[] = [
        makeStat({
          playerId: 'A',
          kills: 3,
          damageDealt: 200,
          survivalTimeMs: 450000,
        }),
        makeStat({
          playerId: 'B',
          kills: 3,
          damageDealt: 200,
          survivalTimeMs: 300000,
        }),
      ];

      const placements = matchEndService.calculatePlacements(stats, []);

      expect(placements[0]!.playerId).toBe('A');
      expect(placements[1]!.playerId).toBe('B');
    });

    it('tiebreaker 6: lowest Player ID when all else tied', () => {
      expect(MATCH.TIEBREAKER_4).toBe('player_id');

      const stats: PlayerRoundStats[] = [
        makeStat({
          playerId: '200',
          kills: 3,
          damageDealt: 200,
          survivalTimeMs: 300000,
        }),
        makeStat({
          playerId: '100',
          kills: 3,
          damageDealt: 200,
          survivalTimeMs: 300000,
        }),
      ];

      const placements1 = matchEndService.calculatePlacements(stats, []);
      expect(placements1[0]!.playerId).toBe('100');

      const placements2 = matchEndService.calculatePlacements(stats, []);
      expect(placements2[0]!.playerId).toBe('100');
      expect(placements1[0]!.playerId).toBe(placements2[0]!.playerId);
    });
  });

  describe('Results in Room State', () => {
    it('match end event emitted after FINISHED', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      const matchEndPromise = waitForMatchEnd(p1);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      syncPhase(room);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);

      const matchEnd = await matchEndPromise;
      expect(matchEnd.type).toBe('match_end');
      expect(matchEnd.winnerId).toBe(p1.sessionId);
      expect(matchEnd.placements).toBeDefined();
      expect(Array.isArray(matchEnd.placements)).toBe(true);
    });

    it('placements include all players', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      const matchEndPromise = waitForMatchEnd(p1);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const matchEnd = await matchEndPromise;
      expect(matchEnd.placements.length).toBe(4);

      const ids = matchEnd.placements.map((p) => p.playerId);
      expect(ids).toContain(p1.sessionId);
      expect(ids).toContain(p2.sessionId);
      expect(ids).toContain(p3.sessionId);
      expect(ids).toContain(p4.sessionId);

      for (let i = 0; i < matchEnd.placements.length; i++) {
        const p = matchEnd.placements[i]!;
        expect(p.placement).toBe(i + 1);
        expect(typeof p.kills).toBe('number');
        expect(typeof p.damageDealt).toBe('number');
        expect(typeof p.damageTaken).toBe('number');
        expect(typeof p.itemsCollected).toBe('number');
        expect(typeof p.survivalTimeMs).toBe('number');
        expect(typeof p.weaponsUsed).toBe('number');
      }

      expect(matchEnd.placements[0]!.placement).toBe(1);
      expect(matchEnd.placements[3]!.placement).toBe(4);
    });
  });

  describe('Room Transition', () => {
    it('room transitions to FINISHED state', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      syncPhase(room);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);

      const aliveDomain = getDomainPlayer(room, p1.sessionId);
      expect(aliveDomain.isActive).toBe(true);
    });

    it('FINISHED is terminal state', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2] = await setupTwoPlayers(helper, room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      syncPhase(room);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);

      await helper.advanceTicks(100);

      syncPhase(room);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);

      await helper.advanceTicks(100);

      syncPhase(room);
      expect(room.state.phase).toBe(MatchPhase.FINISHED);
    });
  });

  describe('Winner Announcement', () => {
    it('winner announcement data present', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      const domainP1 = getDomainPlayer(room, p1.sessionId);
      domainP1.damageDealt = 300;
      domainP1.recordKill();
      domainP1.recordKill();
      domainP1.recordKill();

      const matchEndPromise = waitForMatchEnd(p1);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const matchEnd = await matchEndPromise;
      expect(matchEnd.winnerId).toBe(p1.sessionId);

      const winnerPlacement = matchEnd.placements.find((pl) => pl.playerId === p1.sessionId);
      expect(winnerPlacement).toBeDefined();
      expect(winnerPlacement!.kills).toBeGreaterThanOrEqual(3);
      expect(winnerPlacement!.damageDealt).toBeGreaterThanOrEqual(300);
      expect(winnerPlacement!.survivalTimeMs).toBeGreaterThan(0);
    });

    it('all clients receive winner announcement', async () => {
      const { room, helper } = await createGameRoom(server, { botFillTo: 0 });
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [p1, p2, p3, p4] = await setupFourPlayers(helper, room);

      const matchEndP1 = waitForMatchEnd(p1);
      const matchEndP2 = waitForMatchEnd(p2);
      const matchEndP3 = waitForMatchEnd(p3);
      const matchEndP4 = waitForMatchEnd(p4);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p3.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      killPlayerDirect(room, p4.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 10);

      const [me1, me2, me3, me4] = await Promise.all([
        matchEndP1,
        matchEndP2,
        matchEndP3,
        matchEndP4,
      ]);

      expect(me1.winnerId).toBe(p1.sessionId);
      expect(me2.winnerId).toBe(p1.sessionId);
      expect(me3.winnerId).toBe(p1.sessionId);
      expect(me4.winnerId).toBe(p1.sessionId);

      expect(me1.placements.length).toBe(4);
      expect(me2.placements.length).toBe(4);
      expect(me3.placements.length).toBe(4);
      expect(me4.placements.length).toBe(4);
    });
  });
});
