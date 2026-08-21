import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { ZONE, NETWORK, PLAYER, MATCH, MatchPhase } from '@sector-battle/shared';
import { createTestServer, createRoom, connectClient, cleanup } from '../helpers/test-server';
import { createTestConfig, movePlayersToPositions } from '../helpers/test-utils';
import { Position } from '../../src/domain/value-objects/Position';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import type { Room } from 'colyseus';
import { GameRoom } from '../../src/room/GameRoom';
import { EventMapper } from '../../src/infrastructure/mappers/EventMapperHandlers';

/**
 * Drive the simulation SYNCHRONOUSLY by calling orchestrator.update() directly,
 * bypassing room.waitForNextSimulationTick() (which is just a real setTimeout
 * that doesn't synchronize with the actual simulation interval). Under CI load
 * the real interval fires fewer times per wall-clock second, so tests that wait
 * for zone phase transitions (which need ~600 ticks of accumulated game-time)
 * would hit the vitest timeout before the zone advanced — flaky non-deterministic
 * failures. Synchronous driving blocks the event loop so the real interval can't
 * interfere, matching the documented bot-benchmark harness pattern (AGENTS.md).
 * Also syncs the schema state so room.state reads reflect the driven updates.
 */
function syncAdvanceTicks(room: Room, count: number): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator();
  for (let i = 0; i < count; i++) {
    const events = orch.update(NETWORK.TICK_INTERVAL);
    const messages = EventMapper.broadcastEvents(events);
    for (const { channel, message } of messages) {
      room.broadcast(channel, message);
    }
  }
  gameRoom.syncState();
}

/**
 * Synchronous drop-in replacement for the test-utils advanceTicks. The shared
 * helper uses room.waitForNextSimulationTick() (real setTimeout), which is
 * non-deterministic under load — see syncAdvanceTicks above.
 */
async function advanceTicks(room: Room, count: number): Promise<void> {
  syncAdvanceTicks(room, count);
}

const TICK_RATE = NETWORK.TICK_RATE;
const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * TICK_RATE);
const ZONE_DAMAGE_TICKS = Math.ceil(ZONE.ZONE_TICK_INTERVAL * TICK_RATE);

const ACCELERATED_PHASES = [
  { index: 1, radiusRatio: 1.0, duration: 2, name: 'Drop' },
  { index: 2, radiusRatio: 0.6, duration: 2, name: 'First Closure' },
  { index: 3, radiusRatio: 0.25, duration: 2, name: 'Edge Closure' },
  { index: 4, radiusRatio: 0.15, duration: 2, name: 'Final Ring' },
  { index: 5, radiusRatio: 0.1, duration: 1, name: 'Last Sector' },
  { index: 6, radiusRatio: 0.08, duration: 1, name: 'Final Closure' },
  { index: 7, radiusRatio: 0.08, duration: 9999, name: 'Sudden Death' },
];

const TINY_ZONE_PHASES = [
  { index: 1, radiusRatio: 1.0, duration: 0.2, name: 'Drop' },
  { index: 2, radiusRatio: 0.02, duration: 0.5, name: 'Shrink' },
  { index: 3, radiusRatio: 0.02, duration: 9999, name: 'Tiny' },
  { index: 4, radiusRatio: 0.02, duration: 9999, name: 'Tiny2' },
  { index: 5, radiusRatio: 0.02, duration: 9999, name: 'Tiny3' },
  { index: 6, radiusRatio: 0.02, duration: 9999, name: 'Tiny4' },
  { index: 7, radiusRatio: 0.02, duration: 9999, name: 'Sudden Death' },
];

function createAcceleratedConfig() {
  return createTestConfig({
    zone: {
      phases: ACCELERATED_PHASES,
      totalDuration: 10,
      transitionDuration: 1,
      tickInterval: 0.5,
      warningTime: 1,
    },
    player: {
      baseHealth: 1000,
      maxHealth: 1000,
    },
  });
}

function createTinyZoneConfig() {
  return createTestConfig({
    zone: {
      phases: TINY_ZONE_PHASES,
      totalDuration: 10,
      transitionDuration: 0.5,
      tickInterval: 0.5,
      warningTime: 0.1,
    },
  });
}

const FULL_COVERAGE_PHASES = [
  { index: 1, radiusRatio: 1.0, duration: 0.2, name: 'Drop' },
  { index: 2, radiusRatio: 2.0, duration: 0.5, name: 'Grow' },
  { index: 3, radiusRatio: 2.0, duration: 9999, name: 'Cover' },
  { index: 4, radiusRatio: 2.0, duration: 9999, name: 'Cover2' },
  { index: 5, radiusRatio: 2.0, duration: 9999, name: 'Cover3' },
  { index: 6, radiusRatio: 2.0, duration: 9999, name: 'Cover4' },
  { index: 7, radiusRatio: 2.0, duration: 9999, name: 'Sudden Death' },
];

function createFullCoverageConfig() {
  return createTestConfig({
    zone: {
      phases: FULL_COVERAGE_PHASES,
      totalDuration: 10,
      transitionDuration: 0.5,
      tickInterval: 0.5,
      warningTime: 0.1,
    },
  });
}

async function waitForZonePhase(
  room: Room,
  targetPhase: number,
  maxTicks: number = 2000,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (room.state.zone.phase >= targetPhase) return;
    syncAdvanceTicks(room, 1);
  }
  throw new Error(
    `Zone did not reach phase ${targetPhase} within ${maxTicks} ticks (current: ${room.state.zone.phase})`,
  );
}

function findPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  return [...room.state.players.values()].find((p) => p.id === sessionId);
}

describe('Zone System Integration Tests', () => {
  let server: ColyseusTestServer;
  const activeRooms: Room[] = [];

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterEach(() => {
    for (const room of activeRooms) {
      try {
        room.disconnect();
      } catch {}
    }
    activeRooms.length = 0;
  });

  afterAll(async () => {
    await cleanup(server);
  });

  describe('Phase Transitions', () => {
    it('match starts in COUNTDOWN phase after first tick', async () => {
      const room = await createRoom(server, { matchId: `zone-waiting-${Date.now()}` });
      activeRooms.push(room);
      expect(room.state.phase).toBe(MatchPhase.COUNTDOWN);
    });

    it('zone phase 1 on creation', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-p1-${Date.now()}`, config });
      activeRooms.push(room);
      expect(room.state.zone.phase).toBe(1);
    });

    it('phase transitions through phases 1 to 7', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-transitions-${Date.now()}`, config });
      activeRooms.push(room);

      const seenPhases = new Set<number>();
      seenPhases.add(room.state.zone.phase);

      const maxTicks = Math.ceil(11 * TICK_RATE);
      for (let i = 0; i < maxTicks; i++) {
        syncAdvanceTicks(room, 1);
        seenPhases.add(room.state.zone.phase);
        if (seenPhases.size === 7) break;
      }

      for (let p = 1; p <= 7; p++) {
        expect(seenPhases.has(p)).toBe(true);
      }
    }, 15000);
  });

  describe('Radius Interpolation', () => {
    it('radius interpolates during transition', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-interp-${Date.now()}`, config });
      activeRooms.push(room);

      await waitForZonePhase(room, 2);

      const stableDurationTicks = Math.ceil(1 * TICK_RATE);
      await advanceTicks(room, stableDurationTicks);

      const radiusBeforeTransition = room.state.zone.currentRadius;
      const targetRadius = room.state.zone.targetRadius;
      expect(targetRadius).toBeLessThan(radiusBeforeTransition);

      const halfTransitionTicks = Math.ceil(0.5 * TICK_RATE);
      await advanceTicks(room, halfTransitionTicks);

      const radiusMidpoint = room.state.zone.currentRadius;
      expect(radiusMidpoint).toBeLessThan(radiusBeforeTransition);
      expect(radiusMidpoint).toBeGreaterThan(targetRadius);

      await advanceTicks(room, halfTransitionTicks + 10);

      const radiusAfterTransition = room.state.zone.currentRadius;
      expect(Math.abs(radiusAfterTransition - targetRadius)).toBeLessThan(100);
    }, 15000);

    it('radius stays constant during phase hold', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-hold-${Date.now()}`, config });
      activeRooms.push(room);

      await waitForZonePhase(room, 2);

      const holdCheckTicks = 20;
      const radiusAtStart = room.state.zone.currentRadius;
      await advanceTicks(room, holdCheckTicks);
      const radiusAfterHold = room.state.zone.currentRadius;

      expect(Math.abs(radiusAfterHold - radiusAtStart)).toBeLessThan(1);
    });

    it('transition is linear', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-linear-${Date.now()}`, config });
      activeRooms.push(room);

      await waitForZonePhase(room, 2);

      const stableDurationTicks = Math.ceil(1 * TICK_RATE);
      await advanceTicks(room, stableDurationTicks);

      const startRadius = room.state.zone.currentRadius;
      const targetRadius = room.state.zone.targetRadius;
      const totalDelta = targetRadius - startRadius;

      const quarterTicks = Math.ceil(0.25 * TICK_RATE);

      for (const fraction of [0.25, 0.5, 0.75]) {
        await advanceTicks(room, quarterTicks);
        const currentRadius = room.state.zone.currentRadius;
        const expectedRadius = startRadius + totalDelta * fraction;
        expect(Math.abs(currentRadius - expectedRadius)).toBeLessThan(
          Math.abs(totalDelta) * 0.2 + 50,
        );
      }
    }, 15000);
  });

  describe('Zone Damage Ticks', () => {
    it('zone damage ticks at 0.5s interval', async () => {
      const config = createTinyZoneConfig();
      const room = await createRoom(server, { matchId: `zone-dmg-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'DmgTest' });

      await waitForZonePhase(room, 3);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 2);
      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBeLessThan(healthBefore);
    }, 15000);

    it('zone damage is discrete, not continuous', async () => {
      const config = createTinyZoneConfig();
      const room = await createRoom(server, { matchId: `zone-discrete-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'DiscreteTest' });

      await waitForZonePhase(room, 3);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 2);
      const healthAfter = findPlayer(room, client.sessionId)!.health;

      const damage = healthBefore - healthAfter;
      expect(damage).toBeGreaterThan(0);
      expect(damage % ZONE.ZONE_DAMAGE_PER_TICK).toBe(0);
    }, 15000);

    it('zone damage does not tick for in-zone players', async () => {
      const config = createFullCoverageConfig();
      const room = await createRoom(server, { matchId: `zone-safe-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'SafeTest' });

      await waitForZonePhase(room, 3);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 4);
      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBe(healthBefore);
    }, 15000);
  });

  describe('Safe vs Unsafe Positions', () => {
    it('players outside zone take damage', async () => {
      const config = createTinyZoneConfig();
      const room = await createRoom(server, { matchId: `zone-out-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'OutTest' });

      await waitForZonePhase(room, 3);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 2);
      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBeLessThan(healthBefore);
    }, 15000);

    it('players inside zone are safe', async () => {
      const config = createFullCoverageConfig();
      const room = await createRoom(server, { matchId: `zone-in-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'InTest' });

      await waitForZonePhase(room, 3);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 4);
      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBe(healthBefore);
    }, 15000);

    it('zone boundary is precise', async () => {
      const fullConfig = createFullCoverageConfig();

      const roomIn = await createRoom(server, {
        matchId: `zone-bnd-in-${Date.now()}`,
        config: fullConfig,
      });
      activeRooms.push(roomIn);
      const clientIn = await connectClient(server, roomIn, { name: 'In' });

      await waitForZonePhase(roomIn, 3);
      await advanceTicks(roomIn, SPAWN_INV_TICKS);

      const healthInBefore = findPlayer(roomIn, clientIn.sessionId)!.health;
      await advanceTicks(roomIn, ZONE_DAMAGE_TICKS * 2);
      expect(findPlayer(roomIn, clientIn.sessionId)!.health).toBe(healthInBefore);

      const tinyConfig = createTinyZoneConfig();
      const roomOut = await createRoom(server, {
        matchId: `zone-bnd-out-${Date.now()}`,
        config: tinyConfig,
      });
      activeRooms.push(roomOut);
      const clientOut = await connectClient(server, roomOut, { name: 'Out' });

      await waitForZonePhase(roomOut, 3);
      await advanceTicks(roomOut, SPAWN_INV_TICKS);

      const healthOutBefore = findPlayer(roomOut, clientOut.sessionId)!.health;
      await advanceTicks(roomOut, ZONE_DAMAGE_TICKS * 2);
      expect(findPlayer(roomOut, clientOut.sessionId)!.health).toBeLessThan(healthOutBefore);
    }, 30000);
  });

  describe('Center Shift', () => {
    it('center stays at map center for phase 1', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-ctr-p1-${Date.now()}`, config });
      activeRooms.push(room);

      expect(room.state.zone.phase).toBe(1);
      expect(room.state.zone.centerX).toBe(ZONE.ZONE_CENTER_X);
      expect(room.state.zone.centerY).toBe(ZONE.ZONE_CENTER_Y);

      await advanceTicks(room, 30);
      expect(room.state.zone.centerX).toBe(ZONE.ZONE_CENTER_X);
      expect(room.state.zone.centerY).toBe(ZONE.ZONE_CENTER_Y);
    });

    it('center shifts per phase after phase 1', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-shift-${Date.now()}`, config });
      activeRooms.push(room);

      const phase1CenterX = room.state.zone.centerX;
      const phase1CenterY = room.state.zone.centerY;

      await waitForZonePhase(room, 2, 300);

      const targetCenterX = room.state.zone.targetCenterX;
      const targetCenterY = room.state.zone.targetCenterY;

      const targetMoved =
        Math.abs(targetCenterX - phase1CenterX) > 1 || Math.abs(targetCenterY - phase1CenterY) > 1;

      expect(targetMoved).toBe(true);
    });

    it('overtime does NOT shift center', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-ot-noshift-${Date.now()}`, config });
      activeRooms.push(room);

      await waitForZonePhase(room, 7, 5000);

      const centerX = room.state.zone.centerX;
      const centerY = room.state.zone.centerY;

      await advanceTicks(room, Math.ceil(2 * TICK_RATE));

      expect(room.state.zone.centerX).toBeCloseTo(centerX, 0);
      expect(room.state.zone.centerY).toBeCloseTo(centerY, 0);
    }, 30000);

    it('center shift stays within bounds', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-bounds-${Date.now()}`, config });
      activeRooms.push(room);
      const mapWidth = ZONE.ZONE_CENTER_X * 2;
      const mapHeight = ZONE.ZONE_CENTER_Y * 2;

      await waitForZonePhase(room, 3, 800);

      const zone = room.state.zone;
      const targetX = zone.targetCenterX;
      const targetY = zone.targetCenterY;
      const targetRadius = zone.targetRadius;

      expect(targetX).toBeGreaterThanOrEqual(targetRadius);
      expect(targetX).toBeLessThanOrEqual(mapWidth - targetRadius);
      expect(targetY).toBeGreaterThanOrEqual(targetRadius);
      expect(targetY).toBeLessThanOrEqual(mapHeight - targetRadius);
    }, 15000);
  });

  describe('Overtime', () => {
    it('overtime constant OVERTIME_START is the tuned 500s', () => {
      expect(MATCH.OVERTIME_START).toBe(500);
    });

    it('overtime damage is 10 per tick (20 HP/s)', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-otdmg-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'OTDmg' });

      await movePlayersToPositions([client], room, [{ x: 100, y: 100 }]);
      await waitForZonePhase(room, 6, 2000);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const player = findPlayer(room, client.sessionId);
      if (!player || player.health === 0) {
        await waitForZonePhase(room, 6, 500);
        const p = findPlayer(room, client.sessionId);
        expect(p).toBeDefined();
        expect(p!.health).toBeGreaterThan(0);
      }

      const current = findPlayer(room, client.sessionId)!;
      const healthBefore = current.health;

      await advanceTicks(room, ZONE_DAMAGE_TICKS);

      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthBefore - healthAfter).toBeGreaterThanOrEqual(ZONE.ZONE_DAMAGE_SUDDEN_DEATH);
    }, 30000);

    it('overtime radius stays at 0.08 ratio', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-otrad-${Date.now()}`, config });
      activeRooms.push(room);

      await waitForZonePhase(room, 7, 5000);

      const fullMapRadius = ZONE.INITIAL_ZONE_RADIUS;
      const expectedRadius = fullMapRadius * 0.08;

      expect(room.state.zone.currentRadius).toBeCloseTo(expectedRadius, -1);

      await advanceTicks(room, Math.ceil(2 * TICK_RATE));

      expect(room.state.zone.currentRadius).toBeCloseTo(expectedRadius, -1);
    }, 30000);
  });

  describe('Zone Elimination', () => {
    it('zone damage can kill players', async () => {
      const lowHealthConfig = createAcceleratedConfig();
      lowHealthConfig.player.baseHealth = 15;
      lowHealthConfig.player.maxHealth = 15;

      const room = await createRoom(server, {
        matchId: `zone-kill-${Date.now()}`,
        config: lowHealthConfig,
      });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'KillTest' });

      await movePlayersToPositions([client], room, [{ x: 100, y: 100 }]);
      await advanceTicks(room, SPAWN_INV_TICKS);

      const maxWaitTicks = ZONE_DAMAGE_TICKS * 10;
      let eliminated = false;
      for (let i = 0; i < maxWaitTicks; i++) {
        syncAdvanceTicks(room, 1);
        const current = findPlayer(room, client.sessionId);
        if (current && (current.health === 0 || !(current.status & 1))) {
          eliminated = true;
          break;
        }
      }

      expect(eliminated).toBe(true);
    }, 15000);

    it('zone damage during invincibility does not reduce HP', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-inv-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'InvTest' });

      // Deterministic variant of the old real-tick move to (100,100): the
      // number of real simulation ticks that elapse during the awaited setup
      // (createRoom/connect/movePlayersToPositions all await real timers, and
      // the room interval passes its real deltaTime into the sim) is
      // load-dependent, so the old hardcoded "120 ticks elapsed during the
      // move" accounting drifted and the check ran past the invincibility
      // window. Instead: teleport to the corner (outside every shrinking
      // zone) and read the AUTHORITATIVE expiry tick from the domain player.
      const gameRoom = room as unknown as GameRoom;
      const orch = gameRoom.getOrchestrator();
      const match = orch.getMatch();
      const domainPlayer = match.getPlayer(client.sessionId);
      expect(domainPlayer).toBeDefined();
      domainPlayer!.movement.position = new Position(100, 100);

      const expiryTick = domainPlayer!.statusEffects.freshSpawnExpiryTick;
      // Fail loudly if setup drift ever consumes the whole window — the
      // invariant below would otherwise be vacuous.
      expect(match.tick).toBeLessThan(expiryTick);

      const healthBefore = findPlayer(room, client.sessionId)!.health;
      // Sync-drive up to one tick BEFORE expiry: with the accelerated zone
      // (damage onset ~tick 150 < expiry ~tick 185) the player sits in a
      // damaging zone outside its radius for the tail of the window, so this
      // genuinely exercises "damage attempted while invincible".
      syncAdvanceTicks(room, expiryTick - match.tick - 1);

      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBe(healthBefore);
    }, 15000);

    it('zone damage resumes after invincibility expires', async () => {
      const config = createAcceleratedConfig();
      const room = await createRoom(server, { matchId: `zone-invresume-${Date.now()}`, config });
      activeRooms.push(room);
      const client = await connectClient(server, room, { name: 'InvResume' });

      await movePlayersToPositions([client], room, [{ x: 100, y: 100 }]);
      await advanceTicks(room, SPAWN_INV_TICKS + 30);

      const player = findPlayer(room, client.sessionId);
      if (!player || player.health === 0) return;

      const healthBefore = player.health;
      await advanceTicks(room, ZONE_DAMAGE_TICKS * 2);

      const healthAfter = findPlayer(room, client.sessionId)!.health;
      expect(healthAfter).toBeLessThanOrEqual(healthBefore);
    }, 15000);
  });
});
