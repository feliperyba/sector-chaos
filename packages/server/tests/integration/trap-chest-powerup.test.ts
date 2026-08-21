import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import {
  PLAYER,
  NETWORK,
  GRID,
  TRAP,
  CHEST,
  POWERUP,
  TileType,
  TrapType,
  ChestRarity,
  PlayerStatus,
} from '@sector-battle/shared';
import type { Room } from 'colyseus';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { createTestServer, cleanup, createRoom } from '../helpers/test-server';
import { GameRoomHelper } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import type { Player } from '../../src/domain/entities/Player';
import { Trap } from '../../src/domain/entities/Trap';
import { Chest } from '../../src/domain/entities/Chest';
import { PowerUp } from '../../src/domain/entities/PowerUp';
import { Position } from '../../src/domain/value-objects/Position';

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const CHEST_OPEN_TICKS = Math.ceil(CHEST.OPEN_DURATION * NETWORK.TICK_RATE);
const BARRIER_TICKS = Math.ceil(POWERUP.BARRIER_DURATION * NETWORK.TICK_RATE);
const SPEED_BOOST_TICKS = Math.ceil(POWERUP.SPEED_BOOST_DURATION * NETWORK.TICK_RATE);

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  const orchestrator = gameRoom.getOrchestrator() as GameOrchestrator & {
    match: GameMatch;
  };
  return orchestrator.match;
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string): Player {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
}

function clearArea(grid: TileType[][], centerGx: number, centerGy: number, radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gy = centerGy + dy;
      const gx = centerGx + dx;
      if (gy >= 0 && gy < grid.length && gx >= 0 && gx < grid[0]!.length) {
        grid[gy]![gx] = TileType.EMPTY;
      }
    }
  }
}

function clearEntities(match: GameMatch): void {
  const state = match.getState();
  state.traps.clear();
  state.destructibles.clear();
  state.chests.clear();
  state.weaponPickups.clear();
  state.powerUps.clear();
  state.explosions.clear();
  state.projectiles.clear();
}

function gridCenter(grid: TileType[][]): { gx: number; gy: number } {
  return {
    gx: Math.floor(grid[0]!.length / 2),
    gy: Math.floor(grid.length / 2),
  };
}

function tileCenter(gx: number, gy: number): Position {
  return new Position((gx + 0.5) * GRID.TILE_SIZE, (gy + 0.5) * GRID.TILE_SIZE);
}

async function setupTestRoom(server: ColyseusTestServer) {
  const room = await createRoom(server, {
    matchId: `tcp-${Date.now()}`,
    seed: 42,
    botFillTo: 0,
  });
  const helper = new GameRoomHelper(server, room);
  const client = await helper.addPlayer('Player1');
  helper.forceActive();
  await helper.advanceTicks(SPAWN_INV_TICKS);
  const match = getMatch(room);
  const grid = match.getGrid();
  const { gx, gy } = gridCenter(grid);
  clearArea(grid, gx, gy, 5);
  clearEntities(match);
  return { helper, room, client, match, grid, gx, gy };
}

describe('Trap + Chest + PowerUp Integration Tests', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  describe('Spike Trap', () => {
    it('spike trap deals 15 damage on step', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('spike-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = trapPos;
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH - TRAP.SPIKE_DAMAGE);
      expect(trap.cooldownRemaining).toBeGreaterThan(0);
    });

    it('spike trap reactivates after cooldown', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const client2 = await helper.addPlayer('Player2');
      await helper.advanceTicks(SPAWN_INV_TICKS);

      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('spike-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp1 = getDomainPlayer(room, client.sessionId);
      dp1.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(trap.cooldownRemaining).toBeGreaterThan(0);
      const healthP1 = helper.getPlayer(client)!.health;

      // Advance past cooldown (60 ticks) so trap can re-trigger
      await helper.advanceTicks(TRAP.SPIKE_COOLDOWN_TICKS + 2);

      const dp2 = getDomainPlayer(room, client2.sessionId);
      dp2.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client2, { movementX: 1, movementY: 0 });

      // Second player IS damaged — trap reactivated after cooldown
      expect(helper.getPlayer(client2)!.health).toBe(PLAYER.BASE_HEALTH - TRAP.SPIKE_DAMAGE);
      expect(helper.getPlayer(client)!.health).toBe(healthP1);
    }, 30000);

    it('spike trap triggers even on invulnerable player', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);

      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('spike-inv-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      dp.statusEffects.freshSpawnExpiryTick = match.currentTick + SPAWN_INV_TICKS;
      dp.statusEffects.status =
        PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.FRESH_SPAWN;
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(trap.cooldownRemaining).toBeGreaterThan(0);
      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH);
    });
  });

  describe('Fire Trap', () => {
    it('fire trap activates area and registers DOT on trigger', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('fire-1', TrapType.FIRE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      // Per GDD §10.2.2: no instant damage, but fire area is now active
      expect(trap.fireAreaActive).toBe(true);
      expect(trap.fireAreaRemainingTicks).toBeGreaterThan(0);
    });

    it('fire trap DOT ticks damage over time', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('fire-dot-1', TrapType.FIRE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      // No movement input: the per-tick walk-over pass (step2) triggers the trap,
      // and a STATIONARY player is the behavior under test (GDD §10.2.2: damage
      // comes from standing in the fire area). Sending a MOVE input would engage
      // the server momentum-coast (GameSimulationInput.ts momentum pass), which
      // carries the player out of the 3x3-tile fire area well before the first
      // 60-tick DOT cadence — deterministic no-damage.
      await helper.advanceTicks(1);

      // Per GDD §10.2.2: no instant damage. Damage comes from standing in fire area.
      // Advance 65 ticks (1 DOT tick at 60-tick interval + buffer)
      await helper.advanceTicks(65);

      const healthAfterDot = dp.health.current;
      expect(healthAfterDot).toBeLessThan(PLAYER.BASE_HEALTH);

      await helper.advanceTicks(65);

      const healthAfterSecondDot = dp.health.current;
      expect(healthAfterSecondDot).toBeLessThan(healthAfterDot);
    }, 30000);

    it('fire trap max DOT damage is bounded', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('fire-max-1', TrapType.FIRE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      // No movement input — see 'fire trap DOT ticks damage over time': the
      // player must remain standing in the fire area for the DOT to land.
      await helper.advanceTicks(1);

      // Wait for DOT to apply
      await helper.advanceTicks(65);

      expect(dp.health.current).toBeLessThan(PLAYER.BASE_HEALTH);

      await helper.advanceTicks(65);

      const healthAfter = dp.health.current;
      const totalDamage = PLAYER.BASE_HEALTH - healthAfter;
      expect(totalDamage).toBeGreaterThan(0);
      expect(totalDamage).toBeLessThan(PLAYER.BASE_HEALTH);
    }, 30000);

    it('fire trap reactivates after area expires', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const client2 = await helper.addPlayer('Player2');
      await helper.advanceTicks(SPAWN_INV_TICKS);

      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('fire-reuse-1', TrapType.FIRE, trapPos);
      match.addTrap(trap);

      const dp1 = getDomainPlayer(room, client.sessionId);
      dp1.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      // Fire area is active — trap can't re-trigger while burning
      expect(trap.fireAreaActive).toBe(true);

      // Move player 1 off the trap so they don't re-trigger it
      dp1.movement.position = new Position(trapPos.x + 500, trapPos.y);

      // Advance past fire area duration (300 ticks) so trap returns to idle
      await helper.advanceTicks(TRAP.FIRE_DURATION_TICKS + 2);
      expect(trap.fireAreaActive).toBe(false);

      // Second player steps on trap — it reactivates
      const dp2 = getDomainPlayer(room, client2.sessionId);
      dp2.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client2, { movementX: 1, movementY: 0 });

      expect(trap.fireAreaActive).toBe(true);
    }, 30000);
  });

  describe('Teleport Trap', () => {
    it('teleport trap moves player to random walkable tile', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('tele-1', TrapType.TELEPORT, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      const originalPos = new Position(dp.movement.position.x, dp.movement.position.y);
      dp.movement.position = trapPos;
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });
      await helper.advanceTicks(2);

      const playerState = helper.getPlayer(client)!;
      const moved =
        Math.abs(playerState.x - originalPos.x) > 1 || Math.abs(playerState.y - originalPos.y) > 1;
      expect(moved).toBe(true);

      const grid = match.getGrid();
      const newGx = Math.floor(playerState.x / GRID.TILE_SIZE);
      const newGy = Math.floor(playerState.y / GRID.TILE_SIZE);
      expect(grid[newGy]![newGx]).toBe(TileType.EMPTY);
    });

    it('teleport trap does not deal damage', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('tele-nodmg-1', TrapType.TELEPORT, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('teleport trap reactivates after cooldown', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const client2 = await helper.addPlayer('Player2');
      await helper.advanceTicks(SPAWN_INV_TICKS);

      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('tele-reuse-1', TrapType.TELEPORT, trapPos);
      match.addTrap(trap);

      const dp1 = getDomainPlayer(room, client.sessionId);
      dp1.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(trap.cooldownRemaining).toBeGreaterThan(0);

      // Advance past cooldown (60 ticks) so trap can re-trigger
      await helper.advanceTicks(TRAP.TELEPORT_COOLDOWN_TICKS + 2);

      // Second player steps on trap — it teleports them
      const dp2 = getDomainPlayer(room, client2.sessionId);
      dp2.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client2, { movementX: 1, movementY: 0 });

      const p2After = helper.getPlayer(client2)!;
      const stillOnTrap =
        Math.abs(p2After.x - trapPos.x) < 5 && Math.abs(p2After.y - trapPos.y) < 5;
      expect(stillOnTrap).toBe(false);
    }, 30000);
  });

  describe('Trap Reveal', () => {
    it('trap reveals on proximity (2 tiles = 256 px)', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('reveal-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      const farPos = new Position(trapPos.x, trapPos.y + 3 * GRID.TILE_SIZE);
      dp.movement.position = farPos;
      await helper.advanceTicks(1);
      expect(trap.isRevealed).toBe(false);

      const nearPos = new Position(trapPos.x, trapPos.y + 2 * GRID.TILE_SIZE);
      dp.movement.position = nearPos;
      await helper.advanceTicks(1);
      expect(trap.isRevealed).toBe(true);
    });

    it('trap reveals before player steps on it', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('reveal-before-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      const approachPos = new Position(trapPos.x, trapPos.y + 2 * GRID.TILE_SIZE);
      dp.movement.position = approachPos;
      await helper.advanceTicks(1);

      expect(trap.isRevealed).toBe(true);
      expect(trap.cooldownRemaining).toBe(0);

      const distance = dp.movement.position.distanceTo(trapPos);
      expect(distance).toBeGreaterThan(trap.getTriggerRadius());
    });

    it('revealed trap still triggers on step', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('reveal-trigger-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      const nearPos = new Position(trapPos.x, trapPos.y + 2 * GRID.TILE_SIZE);
      dp.movement.position = nearPos;
      await helper.advanceTicks(1);
      expect(trap.isRevealed).toBe(true);

      dp.movement.position = trapPos;
      await helper.advanceTicks(1);
      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      expect(trap.cooldownRemaining).toBeGreaterThan(0);
      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH - TRAP.SPIKE_DAMAGE);
    });

    it('dash triggers traps', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const trapPos = tileCenter(gx, gy);
      const trap = Trap.create('dash-trap-1', TrapType.SPIKE, trapPos);
      match.addTrap(trap);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = trapPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 1,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['DASH'],
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      expect(trap.cooldownRemaining).toBeGreaterThan(0);
      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH - TRAP.SPIKE_DAMAGE);
    });
  });

  describe('Chest Opening', () => {
    it('chest opens in 0.5s (30 ticks)', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = chestPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(CHEST_OPEN_TICKS);

      const chestSchema = [...room.state.chests.values()].find((c) => c.id === chest.id);
      expect(chestSchema).toBeUndefined();
      expect([...room.state.weaponPickups.values()].length).toBeGreaterThan(0);
    }, 30000);

    it('moving cancels chest opening (chest not consumed)', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-move-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = chestPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(5);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });

      await helper.advanceTicks(CHEST_OPEN_TICKS);

      expect(chest.state).toBe('closed');
    }, 30000);

    it('taking damage does NOT cancel chest opening', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-dmg-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = chestPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(5);
      dp.takeDamage(20, match.currentTick, true);
      await helper.advanceTicks(1);

      expect(chest.state).toBe('opening');

      await helper.advanceTicks(CHEST_OPEN_TICKS);

      const chestSchema = [...room.state.chests.values()].find((c) => c.id === chest.id);
      expect(chestSchema).toBeUndefined();
    }, 30000);

    it('player dying cancels chest opening', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-die-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = chestPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(5);
      dp.takeDamage(PLAYER.BASE_HEALTH, match.currentTick, true);
      await helper.advanceTicks(5);

      expect(chest.state).toBe('closed');
    });

    it('chest must remain stationary', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-stat-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = new Position(chestPos.x + 5, chestPos.y);
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(3);

      dp.movement.position = new Position(chestPos.x + 20, chestPos.y);
      await helper.advanceTicks(2);

      expect(chest.state).toBe('closed');
    });

    it('chest spawns loot on completion', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      clearArea(grid, gx, gy, 2);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-loot-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = chestPos;
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(CHEST_OPEN_TICKS + 5);

      const pickups = [...room.state.weaponPickups.values()];
      expect(pickups.length).toBeGreaterThan(0);
    }, 30000);

    it('player must be within PICKUP_RADIUS to open', async () => {
      const { helper, room, client, match, grid, gx, gy } = await setupTestRoom(server);
      const chestPos = tileCenter(gx, gy);
      grid[gy]![gx] = TileType.CHEST;
      const chest = Chest.create('chest-range-1', ChestRarity.COMMON, chestPos);
      match.addChest(chest);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = new Position(chestPos.x + CHEST.INTERACTION_RANGE + 20, chestPos.y);
      await helper.advanceTicks(1);

      client.send('input', {
        movementX: 0,
        movementY: 0,
        sequence: room.state.tick,
        actions: ['PICKUP'],
        targetId: chest.id,
      });
      await room.waitForNextSimulationTick();
      await room.waitForNextSimulationTick();

      await helper.advanceTicks(CHEST_OPEN_TICKS + 5);

      expect(chest.state).toBe('closed');
    }, 30000);
  });

  describe('PowerUp Auto-Collection', () => {
    it('health pack heals 30 HP', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu = PowerUp.create('hp-1', 'health_pack', puPos, 0);
      match.getState().powerUps.set(pu.id, pu);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      dp.takeDamage(50, match.currentTick, true);
      await helper.advanceTicks(1);

      await helper.advanceTicks(2);

      expect(helper.getPlayer(client)!.health).toBe(
        PLAYER.BASE_HEALTH - 50 + POWERUP.HEALTH_PACK_HEAL,
      );
    });

    it('health pack skipped at full HP', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu = PowerUp.create('hp-full-1', 'health_pack', puPos, 0);
      match.getState().powerUps.set(pu.id, pu);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      await helper.advanceTicks(3);

      expect(pu.isActive).toBe(true);
      expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('barrier grants invulnerability for 10 seconds', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu = PowerUp.create('barrier-1', 'barrier', puPos, 0);
      match.getState().powerUps.set(pu.id, pu);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      await helper.advanceTicks(3);

      expect(dp.statusEffects.barrierActive).toBe(true);
      expect(dp.isInvulnerable(match.currentTick)).toBe(true);
    });

    it('barrier expireBarrier clears active barrier', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu = PowerUp.create('barrier-exp-1', 'barrier', puPos, 0);
      match.getState().powerUps.set(pu.id, pu);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      await helper.advanceTicks(3);

      expect(dp.statusEffects.barrierActive).toBe(true);
      expect(dp.isInvulnerable(match.currentTick)).toBe(true);

      const expiryTick = dp.statusEffects.barrierExpiryTick;
      expect(expiryTick).toBeGreaterThan(0);

      dp.expireBarrier(expiryTick);
      expect(dp.statusEffects.barrierActive).toBe(false);
      expect(dp.statusEffects.barrierExpiryTick).toBe(0);
    });

    it('speed boost: 1.3x multiplier for 7 seconds', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu = PowerUp.create('speed-1', 'speed_boost', puPos, 0);
      match.getState().powerUps.set(pu.id, pu);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      await helper.advanceTicks(3);

      const expectedSpeed = PLAYER.BASE_SPEED * POWERUP.SPEED_BOOST_MULTIPLIER;
      expect(dp.movement.speed.value).toBeCloseTo(expectedSpeed, 1);

      await helper.advanceTicks(SPEED_BOOST_TICKS + 5);

      expect(dp.movement.speed.value).toBe(PLAYER.BASE_SPEED);
    }, 30000);

    it('different power-ups stack simultaneously', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const barrierPos = tileCenter(gx, gy);
      const barrier = PowerUp.create('stack-b-1', 'barrier', barrierPos, 0);
      match.getState().powerUps.set(barrier.id, barrier);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = barrierPos;
      await helper.advanceTicks(3);

      expect(dp.statusEffects.barrierActive).toBe(true);

      const speedPos = new Position(dp.movement.position.x + 10, dp.movement.position.y);
      const speed = PowerUp.create('stack-s-1', 'speed_boost', speedPos, 0);
      match.getState().powerUps.set(speed.id, speed);
      dp.movement.position = speedPos;
      await helper.advanceTicks(3);

      const expectedSpeed = PLAYER.BASE_SPEED * POWERUP.SPEED_BOOST_MULTIPLIER;
      expect(dp.statusEffects.barrierActive).toBe(true);
      expect(dp.movement.speed.value).toBeCloseTo(expectedSpeed, 1);
    });

    it('same power-up type refreshes duration', async () => {
      const { helper, room, client, match, gx, gy } = await setupTestRoom(server);
      const puPos = tileCenter(gx, gy);
      const pu1 = PowerUp.create('refresh-1', 'speed_boost', puPos, 0);
      match.getState().powerUps.set(pu1.id, pu1);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.movement.position = puPos;
      await helper.advanceTicks(3);

      const expectedSpeed = PLAYER.BASE_SPEED * POWERUP.SPEED_BOOST_MULTIPLIER;
      expect(dp.movement.speed.value).toBeCloseTo(expectedSpeed, 1);

      await helper.advanceTicks(200);

      const pu2Pos = new Position(dp.movement.position.x + 10, dp.movement.position.y);
      const pu2 = PowerUp.create('refresh-2', 'speed_boost', pu2Pos, 0);
      match.getState().powerUps.set(pu2.id, pu2);
      dp.movement.position = pu2Pos;
      await helper.advanceTicks(3);

      expect(dp.movement.speed.value).toBeCloseTo(expectedSpeed, 1);

      await helper.advanceTicks(200);
      expect(dp.movement.speed.value).toBeCloseTo(expectedSpeed, 1);

      await helper.advanceTicks(SPEED_BOOST_TICKS + 10);
      expect(dp.movement.speed.value).toBe(PLAYER.BASE_SPEED);
    }, 30000);
  });
});
