import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { PLAYER, NETWORK, GRID, COMBAT, POWERUP, TileType } from '@sector-battle/shared';
import type { Room } from 'colyseus';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import type { Player } from '../../src/domain/entities/Player';
import { Position } from '../../src/domain/value-objects/Position';
import { Speed } from '../../src/domain/value-objects/Speed';

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const DASH_DURATION_TICKS = Math.ceil(PLAYER.DASH_DURATION * NETWORK.TICK_RATE);
const DASH_COOLDOWN_TICKS = Math.ceil(PLAYER.DASH_COOLDOWN * NETWORK.TICK_RATE);

async function skipSpawnInvincibility(helper: GameRoomHelper): Promise<void> {
  helper.forceActive();
  await helper.advanceTicks(SPAWN_INV_TICKS);
}

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

describe('Movement Integration Tests', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  describe('Basic Movement', () => {
    it('player moves right on movementX=1 input', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      const openX = (gx + 0.5) * GRID.TILE_SIZE;
      const openY = (gy + 0.5) * GRID.TILE_SIZE;
      domainPlayer.movement.position = new Position(openX, openY);
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;
      const y0 = player.y;

      await helper.sendInput(client, { movementX: 1, movementY: 0 });
      await helper.advanceTicks(1);

      expect(player.x).toBeGreaterThan(x0);
      expect(Math.abs(player.y - y0)).toBeLessThan(1);
    });

    it('player moves left on movementX=-1 input', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      await helper.sendInput(client, { movementX: -1, movementY: 0 });
      await helper.advanceTicks(1);

      expect(player.x).toBeLessThan(x0);
    });

    it('player moves up on movementY=-1 input', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const y0 = player.y;

      await helper.sendInput(client, { movementX: 0, movementY: -1 });
      await helper.advanceTicks(1);

      expect(player.y).toBeLessThan(y0);
    });

    it('player moves down on movementY=1 input', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const y0 = player.y;

      await helper.sendInput(client, { movementX: 0, movementY: 1 });
      await helper.advanceTicks(1);

      expect(player.y).toBeGreaterThan(y0);
    });

    it('player moves diagonally on both axes', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;
      const y0 = player.y;

      await helper.sendInput(client, { movementX: 1, movementY: 1 });
      await helper.advanceTicks(1);

      expect(player.x).toBeGreaterThan(x0);
      expect(player.y).toBeGreaterThan(y0);
    });

    it('movement distance matches BASE_SPEED over time', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      expect(deltaX).toBeGreaterThan(180);
      expect(deltaX).toBeLessThan(220);
    });

    it('zero input keeps player stationary', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 4);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;
      const y0 = player.y;

      await helper.sendInput(client, { movementX: 0, movementY: 0 });

      expect(player.x).toBe(x0);
      expect(player.y).toBe(y0);
    });
  });

  describe('Map Bounds Clamping', () => {
    it('player position clamped at left boundary', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      clearArea(grid, 1, 40, 2);
      grid[40]![0] = TileType.EMPTY;
      grid[41]![0] = TileType.EMPTY;
      grid[39]![0] = TileType.EMPTY;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        PLAYER.HITBOX_WIDTH / 2 + 10,
        40.5 * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: -1, movementY: 0 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.x).toBeGreaterThanOrEqual(PLAYER.HITBOX_WIDTH / 2 - 1);
    });

    it('player position clamped at right boundary', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const maxGx = grid[0]!.length - 1;
      clearArea(grid, maxGx - 1, 40, 2);
      grid[40]![maxGx] = TileType.EMPTY;
      grid[41]![maxGx] = TileType.EMPTY;
      grid[39]![maxGx] = TileType.EMPTY;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        GRID.WORLD_WIDTH - PLAYER.HITBOX_WIDTH / 2 - 10,
        40.5 * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.x).toBeLessThanOrEqual(GRID.WORLD_WIDTH - PLAYER.HITBOX_WIDTH / 2 + 1);
    });

    it('player position clamped at top boundary', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      clearArea(grid, 40, 1, 2);
      grid[0]![40] = TileType.EMPTY;
      grid[0]![41] = TileType.EMPTY;
      grid[0]![39] = TileType.EMPTY;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        40.5 * GRID.TILE_SIZE,
        PLAYER.HITBOX_HEIGHT / 2 + 10,
      );
      await helper.advanceTicks(1);

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 0, movementY: -1 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.y).toBeGreaterThanOrEqual(PLAYER.HITBOX_HEIGHT / 2 - 1);
    });

    it('player position clamped at bottom boundary', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const maxGy = grid.length - 1;
      clearArea(grid, 40, maxGy - 1, 2);
      grid[maxGy]![40] = TileType.EMPTY;
      grid[maxGy]![41] = TileType.EMPTY;
      grid[maxGy]![39] = TileType.EMPTY;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        40.5 * GRID.TILE_SIZE,
        GRID.WORLD_HEIGHT - PLAYER.HITBOX_HEIGHT / 2 - 10,
      );
      await helper.advanceTicks(1);

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 0, movementY: 1 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.y).toBeLessThanOrEqual(GRID.WORLD_HEIGHT - PLAYER.HITBOX_HEIGHT / 2 + 1);
    });
  });

  describe('Wall Collision', () => {
    it('player cannot walk through walls', async () => {
      const { helper, room } = await createGameRoom(server, { seed: 42 });
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();

      let wallGridX = -1;
      let wallGridY = -1;
      const { gx: centerGx, gy: centerGy } = gridCenter(grid);
      outer: for (let gy = centerGy - 5; gy <= centerGy + 5; gy++) {
        for (let gx = centerGx - 5; gx <= centerGx + 5; gx++) {
          if (grid[gy]![gx] === TileType.INDESTRUCTIBLE_WALL) {
            wallGridX = gx;
            wallGridY = gy;
            break outer;
          }
        }
      }
      expect(wallGridX).toBeGreaterThanOrEqual(0);

      clearArea(grid, wallGridX + 2, wallGridY, 2);
      grid[wallGridY]![wallGridX] = TileType.INDESTRUCTIBLE_WALL;

      const wallRightEdge = (wallGridX + 1) * GRID.TILE_SIZE;
      const wallCenterY = (wallGridY + 0.5) * GRID.TILE_SIZE;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      const startX = wallRightEdge + PLAYER.HITBOX_WIDTH / 2 + 5;
      domainPlayer.movement.position = new Position(startX, wallCenterY);
      await helper.advanceTicks(1);

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: -1, movementY: 0 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.x).toBeGreaterThanOrEqual(wallRightEdge + PLAYER.HITBOX_WIDTH / 2 - 5);
    });

    it('player slides along wall when moving diagonally', async () => {
      const { helper, room } = await createGameRoom(server, { seed: 42 });
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();

      let wallGridX = -1;
      let wallGridY = -1;
      const { gx: centerGx, gy: centerGy } = gridCenter(grid);
      outer: for (let gy = centerGy - 5; gy <= centerGy + 5; gy++) {
        for (let gx = centerGx - 5; gx <= centerGx + 5; gx++) {
          if (grid[gy]![gx] === TileType.INDESTRUCTIBLE_WALL) {
            wallGridX = gx;
            wallGridY = gy;
            break outer;
          }
        }
      }
      expect(wallGridX).toBeGreaterThanOrEqual(0);

      clearArea(grid, wallGridX + 2, wallGridY, 2);
      grid[wallGridY]![wallGridX] = TileType.INDESTRUCTIBLE_WALL;
      for (let dy = 0; dy <= 4; dy++) {
        const clearGy = wallGridY + dy;
        if (clearGy < grid.length) {
          grid[clearGy]![wallGridX + 1] = TileType.EMPTY;
          grid[clearGy]![wallGridX + 2] = TileType.EMPTY;
          grid[clearGy]![wallGridX + 3] = TileType.EMPTY;
        }
      }

      const wallRightEdge = (wallGridX + 1) * GRID.TILE_SIZE;
      const wallCenterY = (wallGridY + 0.5) * GRID.TILE_SIZE;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      const startX = wallRightEdge + PLAYER.HITBOX_WIDTH / 2 + 5;
      domainPlayer.movement.position = new Position(startX, wallCenterY);
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const y0 = player.y;

      for (let i = 0; i < 3; i++) {
        await helper.sendInput(client, { movementX: -1, movementY: 1 });
        await helper.advanceTicks(1);
      }

      expect(player.x).toBeGreaterThanOrEqual(wallRightEdge + PLAYER.HITBOX_WIDTH / 2 - 5);
      expect(Math.abs(player.y - y0)).toBeGreaterThan(1);
    });
  });

  describe('Player Collision (Body Blocking)', () => {
    it('two players cannot overlap', async () => {
      const { helper, room } = await createGameRoom(server);
      const client1 = await helper.addPlayer('Player1');
      const client2 = await helper.addPlayer('Player2');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);

      const p1 = match.getPlayer(client1.sessionId)!;
      const p2 = match.getPlayer(client2.sessionId)!;
      const baseX = (gx + 0.5) * GRID.TILE_SIZE;
      const baseY = (gy + 0.5) * GRID.TILE_SIZE;
      p1.movement.position = new Position(baseX - 100, baseY);
      p2.movement.position = new Position(baseX + 100, baseY);
      await helper.advanceTicks(1);

      for (let i = 0; i < 60; i++) {
        await helper.sendInput(client1, { movementX: 1, movementY: 0 });
      }

      const s1 = helper.getPlayer(client1)!;
      const s2 = helper.getPlayer(client2)!;
      const distance = Math.abs(s1.x - s2.x);
      expect(distance).toBeGreaterThanOrEqual(PLAYER.HITBOX_WIDTH - 2);
    });

    it('body blocking works in all directions', async () => {
      const { helper, room } = await createGameRoom(server);
      const client1 = await helper.addPlayer('Player1');
      const client2 = await helper.addPlayer('Player2');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);
      clearEntities(match);

      const p1 = match.getPlayer(client1.sessionId)!;
      const p2 = match.getPlayer(client2.sessionId)!;
      const baseX = (gx + 0.5) * GRID.TILE_SIZE;
      const baseY = (gy + 0.5) * GRID.TILE_SIZE;

      const directions = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
      ];

      for (const dir of directions) {
        const sep = PLAYER.HITBOX_WIDTH + 20;
        if (dir.dx !== 0) {
          p1.movement.position = new Position(baseX - (sep / 2) * dir.dx, baseY);
          p2.movement.position = new Position(baseX + (sep / 2) * dir.dx, baseY);
        } else {
          p1.movement.position = new Position(baseX, baseY - (sep / 2) * dir.dy);
          p2.movement.position = new Position(baseX, baseY + (sep / 2) * dir.dy);
        }
        await helper.advanceTicks(1);

        for (let i = 0; i < 60; i++) {
          await helper.sendInput(client1, {
            movementX: dir.dx,
            movementY: dir.dy,
          });
        }

        const s1 = helper.getPlayer(client1)!;
        const s2 = helper.getPlayer(client2)!;

        if (dir.dx !== 0) {
          const dist = Math.abs(s2.x - s1.x);
          expect(dist).toBeGreaterThanOrEqual(PLAYER.HITBOX_WIDTH - 2);
        } else {
          const dist = Math.abs(s2.y - s1.y);
          expect(dist).toBeGreaterThanOrEqual(PLAYER.HITBOX_HEIGHT - 2);
        }
      }
    }, 60000);
  });

  describe('Dash', () => {
    it('dash moves player faster than normal speed', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);
      clearEntities(match);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);

      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      const normalDisplacement = DASH_DURATION_TICKS * (PLAYER.BASE_SPEED / NETWORK.TICK_RATE);
      expect(deltaX).toBeGreaterThan(normalDisplacement);
    });

    it('dash passes through other players', async () => {
      const { helper, room } = await createGameRoom(server);
      const clientA = await helper.addPlayer('Blocker');
      const clientB = await helper.addPlayer('Dasher');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 8);
      clearEntities(match);

      const domainA = match.getPlayer(clientA.sessionId)!;
      const domainB = match.getPlayer(clientB.sessionId)!;
      const baseX = (gx + 0.5) * GRID.TILE_SIZE;
      const baseY = (gy + 0.5) * GRID.TILE_SIZE;
      domainA.movement.position = new Position(baseX, baseY);
      domainB.movement.position = new Position(baseX - 100, baseY);
      await helper.advanceTicks(1);

      const blockerX = helper.getPlayer(clientA)!.x;

      await helper.sendInput(clientB, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < DASH_DURATION_TICKS + 10; i++) {
        await helper.sendInput(clientB, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const dasherFinal = helper.getPlayer(clientB)!;
      expect(dasherFinal.x).toBeGreaterThan(blockerX);
    });

    it('dash stops at walls', async () => {
      const { helper, room } = await createGameRoom(server, { seed: 42 });
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();

      let wallGridX = -1;
      let wallGridY = -1;
      const { gx: centerGx, gy: centerGy } = gridCenter(grid);
      outer: for (let gy = centerGy - 5; gy <= centerGy + 5; gy++) {
        for (let gx = centerGx - 5; gx <= centerGx + 5; gx++) {
          if (grid[gy]![gx] === TileType.INDESTRUCTIBLE_WALL) {
            wallGridX = gx;
            wallGridY = gy;
            break outer;
          }
        }
      }
      expect(wallGridX).toBeGreaterThanOrEqual(0);

      clearArea(grid, wallGridX + 2, wallGridY, 2);
      grid[wallGridY]![wallGridX] = TileType.INDESTRUCTIBLE_WALL;

      const wallRightEdge = (wallGridX + 1) * GRID.TILE_SIZE;
      const wallCenterY = (wallGridY + 0.5) * GRID.TILE_SIZE;

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      const startX = wallRightEdge + PLAYER.HITBOX_WIDTH / 2 + 5;
      domainPlayer.movement.position = new Position(startX, wallCenterY);
      await helper.advanceTicks(1);

      await helper.sendInput(client, {
        movementX: -1,
        movementY: 0,
        actions: ['DASH'],
      });
      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: -1, movementY: 0 });
      }

      const player = helper.getPlayer(client)!;
      expect(player.x).toBeGreaterThanOrEqual(wallRightEdge + PLAYER.HITBOX_WIDTH / 2 - 5);
    });

    it('dash has correct duration (0.5s = 30 ticks)', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 8);
      clearEntities(match);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      for (let i = 0; i < 10; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      const expected = 10 * (PLAYER.BASE_SPEED / NETWORK.TICK_RATE);
      expect(deltaX).toBeGreaterThan(expected * 0.8);
      expect(deltaX).toBeLessThan(expected * 1.2);
    });

    it('dash has cooldown (3s = 180 ticks)', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      // Radius 15 (not 10): after the two dash+move segments the player keeps
      // coasting at base speed through the 180-tick cooldown window (the
      // server's momentum-integration pass replays the last move direction),
      // covering ~1290px — the +x corridor must stay clear all the way to
      // dash2 or the second dash measures 0 displacement against a wall.
      clearArea(grid, gx, gy, 15);
      clearEntities(match);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;

      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const xAfterDash1 = player.x;

      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < 10; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - xAfterDash1);
      const normalDisplacement = 11 * (PLAYER.BASE_SPEED / NETWORK.TICK_RATE);
      expect(deltaX).toBeLessThan(normalDisplacement * 1.5);

      await helper.advanceTicks(DASH_COOLDOWN_TICKS);

      const xBeforeDash2 = player.x;
      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const dashDisplacement = Math.abs(player.x - xBeforeDash2);
      expect(dashDisplacement).toBeGreaterThan(normalDisplacement);
    });

    it('dash uses facing angle when direction is zero', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);
      clearEntities(match);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      await helper.advanceTicks(1);

      await helper.sendInput(client, {
        movementX: 0,
        movementY: 0,
        aimAngle: 0,
      });
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      await helper.sendInput(client, {
        movementX: 0,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < 10; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      const normalDisplacement = 10 * (PLAYER.BASE_SPEED / NETWORK.TICK_RATE);
      expect(deltaX).toBeGreaterThan(normalDisplacement);
    });
  });

  describe('Speed Modifiers', () => {
    it('speed boost: 1.3x multiplier', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      domainPlayer.movement.speed = new Speed(
        domainPlayer.movement.speed.value * POWERUP.SPEED_BOOST_MULTIPLIER,
        domainPlayer.movement.speed.max,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      for (let i = 0; i < 60; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      expect(deltaX).toBeGreaterThan(250);
    });

    it('blocking: tuned speed penalty', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      domainPlayer.statusEffects.barrierActive = true;
      domainPlayer.statusEffects.barrierExpiryTick = 999999;
      // Simulate a slowed speed directly (the former PLAYER.BLOCKING_SPEED_PENALTY
      // constant had no production applier and was deleted — ticket 16).
      domainPlayer.movement.speed = domainPlayer.movement.speed.scale(0.65);
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      // 30 ticks at BASE_SPEED with the acceleration ramp travels ~200px;
      // the bounds scale with the tuned penalty (0.65x, the old 50% band).
      expect(deltaX).toBeGreaterThan(160 * PLAYER.BLOCKING_SPEED_PENALTY);
      expect(deltaX).toBeLessThan(240 * PLAYER.BLOCKING_SPEED_PENALTY);
    });

    it('stagger: tuned speed penalty', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 6);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      domainPlayer.startStagger(5000, NETWORK.TICK_RATE);
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      for (let i = 0; i < 30; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      // Same ~200px 30-tick baseline scaled by the tuned stagger penalty
      // (0.75x, COMBAT.STAGGER_MOVE_SPEED_PENALTY).
      expect(deltaX).toBeGreaterThan(160 * COMBAT.STAGGER_MOVE_SPEED_PENALTY);
      expect(deltaX).toBeLessThan(240 * COMBAT.STAGGER_MOVE_SPEED_PENALTY);
    });

    it('speed boost + dash stacks', async () => {
      const { helper, room } = await createGameRoom(server);
      const client = await helper.addPlayer('Player1');
      await skipSpawnInvincibility(helper);

      const match = getMatch(room);
      const grid = match.getGrid();
      const { gx, gy } = gridCenter(grid);
      clearArea(grid, gx, gy, 8);
      clearEntities(match);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      domainPlayer.movement.position = new Position(
        (gx + 0.5) * GRID.TILE_SIZE,
        (gy + 0.5) * GRID.TILE_SIZE,
      );
      domainPlayer.movement.speed = new Speed(
        domainPlayer.movement.speed.value * POWERUP.SPEED_BOOST_MULTIPLIER,
        domainPlayer.movement.speed.max,
      );
      await helper.advanceTicks(1);

      const player = helper.getPlayer(client)!;
      const x0 = player.x;

      await helper.sendInput(client, {
        movementX: 1,
        movementY: 0,
        actions: ['DASH'],
      });
      await helper.advanceTicks(1);
      for (let i = 0; i < DASH_DURATION_TICKS - 1; i++) {
        await helper.sendInput(client, { movementX: 1, movementY: 0 });
        await helper.advanceTicks(1);
      }

      const deltaX = Math.abs(player.x - x0);
      const expectedBaseDash =
        (DASH_DURATION_TICKS * (PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER)) /
        NETWORK.TICK_RATE;
      expect(deltaX).toBeGreaterThan(expectedBaseDash * 0.7);
      expect(deltaX).toBeLessThan(expectedBaseDash * 1.3);
    });
  });
});
