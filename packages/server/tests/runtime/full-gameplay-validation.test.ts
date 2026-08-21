import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import {
  PLAYER,
  NETWORK,
  COMBAT,
  GRID,
  ZONE,
  WeaponType,
  WeaponTier,
  weaponRegistry,
  TileType,
  MatchPhase,
  PlayerStatus,
  ChestRarity,
  InputAction,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity, Chest } from '../../src/domain/entities/index';
import { Position } from '../../src/domain/value-objects/index';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const FISTS_WINDUP_TICKS = Math.ceil(50 / (1000 / NETWORK.TICK_RATE));
const DAGGER_WINDUP_TICKS = Math.ceil(100 / (1000 / NETWORK.TICK_RATE));
const DASH_DURATION_TICKS = Math.round(PLAYER.DASH_DURATION * NETWORK.TICK_RATE);

const POS_A = { x: 5120, y: 5100 };
const POS_T_DOWN = { x: 5120, y: 5170 };

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await cleanup(server);
});

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getMatch();
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: { getCurrentState: () => { phase: number }; transitionTo: (p: number) => void };
    phase: number;
    matchEndedEmitted: boolean;
    simulation: { start(): void; running: boolean };
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
  orch.matchEndedEmitted = true;
  match.phase = MatchPhase.ACTIVE;
  if (!orch.simulation.running) {
    orch.simulation.start();
  }
  gameRoom.syncState();
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

function equipWeapon(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  weaponType: WeaponType,
  tier: WeaponTier,
): void {
  const player = getDomainPlayer(room, sessionId);
  const def = weaponRegistry.getDefinition(weaponType);
  const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
  const weapon = new WeaponEntity(`w-${weaponType}-${sessionId}`, weaponType, tier, 999, 999, cd);
  const slot = player.findFirstEmptySlot();
  if (slot !== null) {
    player.addWeapon(weapon);
    player.forceSwitchSlot(slot);
  }
}

function setFacing(room: Room<{ state: GameStateSchema }>, sessionId: string, angle: number): void {
  getDomainPlayer(room, sessionId).movement.facingAngle = angle;
}

function addPickup(
  room: Room<{ state: GameStateSchema }>,
  id: string,
  weapon: WeaponEntity,
  x: number,
  y: number,
): void {
  getMatch(room).addWeaponPickup(id, weapon, new Position(x, y));
}

function addChest(
  room: Room<{ state: GameStateSchema }>,
  id: string,
  tier: ChestRarity,
  x: number,
  y: number,
): void {
  const chest = Chest.create(id, tier, new Position(x, y));
  getMatch(room).getState().chests.set(id, chest);
}

async function prepareCombat(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
  posA: { x: number; y: number } = POS_A,
  posB: { x: number; y: number } = POS_T_DOWN,
): Promise<{ attacker: TestClient; target: TestClient }> {
  const attacker = await helper.addPlayer('Attacker');
  const target = await helper.addPlayer('Target');
  getDomainPlayer(room, attacker.sessionId).movement.position = new Position(posA.x, posA.y);
  getDomainPlayer(room, target.sessionId).movement.position = new Position(posB.x, posB.y);
  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);
  return { attacker, target };
}

function directInput(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  action: InputAction,
  data: Record<string, unknown>,
  helper: GameRoomHelper,
): void {
  const orch = (room as unknown as GameRoom).getOrchestrator();
  orch.handleInput(sessionId, action, { ...data, tick: helper.tick }, helper.tick);
}

function tickDirect(room: Room<{ state: GameStateSchema }>, count: number): void {
  const orch = (room as unknown as GameRoom).getOrchestrator();
  for (let i = 0; i < count; i++) {
    orch.update(NETWORK.TICK_INTERVAL);
  }
  (room as unknown as GameRoom).syncState();
}

async function prepareSingle(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
  name: string = 'Player1',
  pos: { x: number; y: number } = POS_A,
): Promise<TestClient> {
  const client = await helper.addPlayer(name);
  getDomainPlayer(room, client.sessionId).movement.position = new Position(pos.x, pos.y);
  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);
  return client;
}

describe('Full Gameplay Validation', () => {
  describe('1. Room Setup & Player Join', () => {
    it('creates room with seed option (deterministic map)', async () => {
      const { room: roomA } = await createGameRoom(server, { seed: 42 });
      const { room: roomB } = await createGameRoom(server, { seed: 42 });
      expect(roomA).toBeDefined();
      expect(roomB).toBeDefined();
      expect(roomA.state.mapWidth).toBe(roomB.state.mapWidth);
    });

    it('player connects and appears in state', async () => {
      const { room, helper } = await createGameRoom(server);
      const client = await helper.addPlayer('TestPlayer');
      expect(helper.state.players.size).toBe(1);

      const playerState = helper.getPlayer(client);
      expect(playerState).toBeDefined();
      expect(playerState!.id).toBe(client.sessionId);
      expect(playerState!.name).toBe('TestPlayer');
    });

    it('player has correct initial state', async () => {
      const { room, helper } = await createGameRoom(server);
      const client = await helper.addPlayer('InitPlayer');
      const p = helper.getPlayer(client)!;

      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.health).toBe(PLAYER.BASE_HEALTH);
      expect(p.maxHealth).toBe(PLAYER.MAX_HEALTH);
      expect(p.activeSlot).toBe(0);
      expect(p.status & PlayerStatus.INVINCIBLE).toBeTruthy();
      expect(p.status & PlayerStatus.FRESH_SPAWN).toBeTruthy();
      expect(p.status & PlayerStatus.ALIVE).toBeTruthy();
      expect(p.kills).toBe(0);
    });

    it('playersAlive increments with each join', async () => {
      const { helper } = await createGameRoom(server);
      await helper.addPlayer('P1');
      expect(helper.state.playersAlive).toBe(1);
      await helper.addPlayer('P2');
      expect(helper.state.playersAlive).toBe(2);
    });

    it('player starts with FISTS in slot 0', async () => {
      const { room, helper } = await createGameRoom(server);
      const client = await helper.addPlayer('FistCheck');
      const p = helper.getPlayer(client)!;
      expect(p.weapons.length).toBeGreaterThanOrEqual(1);
      expect(p.weapons.at(0)!.weaponType).toBe(WeaponType.FISTS);
    });

    it('player inventory size is correct', async () => {
      const { room, helper } = await createGameRoom(server);
      const client = await helper.addPlayer('InvCheck');
      const p = helper.getPlayer(client)!;
      expect(p.weapons.length).toBe(PLAYER.INVENTORY_SIZE);
    });
  });

  describe('2. Movement', () => {
    it('MOVE action updates player position (right)', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'MoverRight');
      const beforeX = helper.getPlayer(client)!.x;
      directInput(room, client.sessionId, InputAction.MOVE, { dx: 1, dy: 0 }, helper);
      await helper.advanceTicks(1);
      expect(helper.getPlayer(client)!.x).toBeGreaterThan(beforeX);
    });

    it('MOVE action updates player position (down)', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'MoverDown');
      const beforeY = helper.getPlayer(client)!.y;
      directInput(room, client.sessionId, InputAction.MOVE, { dx: 0, dy: 1 }, helper);
      await helper.advanceTicks(1);
      expect(helper.getPlayer(client)!.y).toBeGreaterThan(beforeY);
    });

    it('movement distance is approximately speed/tick_rate per tick', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'SpeedCheck');
      const beforeX = helper.getPlayer(client)!.x;

      for (let i = 0; i < 10; i++) {
        directInput(room, client.sessionId, InputAction.MOVE, { dx: 1, dy: 0 }, helper);
        await helper.advanceTicks(1);
      }

      const afterX = helper.getPlayer(client)!.x;
      const distance = afterX - beforeX;
      const expectedPerTick = PLAYER.BASE_SPEED / NETWORK.TICK_RATE;
      expect(distance).toBeGreaterThanOrEqual(expectedPerTick * 5);
      expect(distance).toBeLessThanOrEqual(expectedPerTick * 20);
    });

    it('player cannot move into walls', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      const wallGx = 41;
      const wallGy = 40;
      clearArea(grid, 40, 40, 1);
      grid[wallGy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

      const client = await prepareSingle(helper, room, 'WallMove', {
        x: (wallGx - 0.5) * GRID.TILE_SIZE,
        y: (wallGy + 0.5) * GRID.TILE_SIZE,
      });

      const startX = helper.getPlayer(client)!.x;
      directInput(room, client.sessionId, InputAction.MOVE, { dx: 1, dy: 0 }, helper);
      await helper.advanceTicks(1);
      const endX = helper.getPlayer(client)!.x;
      expect(endX).toBeLessThanOrEqual(startX + PLAYER.HITBOX_WIDTH);
    });

    it('no movement input does not change position', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'Still');
      const beforeX = helper.getPlayer(client)!.x;
      const beforeY = helper.getPlayer(client)!.y;
      await helper.advanceTicks(10);
      expect(helper.getPlayer(client)!.x).toBe(beforeX);
      expect(helper.getPlayer(client)!.y).toBe(beforeY);
    });
  });

  describe('3. Weapon Pickup', () => {
    it('weapon pickup appears on the map after state sync', async () => {
      const { room, helper } = await createGameRoom(server);
      await helper.addPlayer('SyncTrigger');
      await helper.advanceTicks(1);

      const weaponId = 'test-pickup-appear';
      const weapon = new WeaponEntity(weaponId, WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 10);
      addPickup(room, weaponId, weapon, 5120, 5120);
      await helper.advanceTicks(2);

      const pickups = [...helper.state.weaponPickups.values()];
      const ourPickup = pickups.find((p) => p.id === weaponId);
      expect(ourPickup).toBeDefined();
      expect(ourPickup!.weaponType).toBe(WeaponType.DAGGER);
    });

    it('player near weapon pickup can PICKUP it', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'Picker');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      const weaponId = 'test-pickup-grab';
      const weapon = new WeaponEntity(
        weaponId,
        WeaponType.SHORT_SWORD,
        WeaponTier.COMMON,
        10,
        10,
        10,
      );
      addPickup(
        room,
        weaponId,
        weapon,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, {}, helper);
      await helper.advanceTicks(1);

      expect(getMatch(room).getState().weaponPickups.has(weaponId)).toBe(false);
    });

    it('weapon goes into first empty slot', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'SlotCheck');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      const weaponId = 'test-pickup-slot';
      const weapon = new WeaponEntity(weaponId, WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 10);
      addPickup(
        room,
        weaponId,
        weapon,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, {}, helper);
      await helper.advanceTicks(1);

      expect(domainPlayer.inventory.weapons[1]).not.toBeNull();
      expect(domainPlayer.inventory.weapons[1]!.type).toBe(WeaponType.DAGGER);
    });

    it('player auto-switches to picked up weapon', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'AutoSwitch');
      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.inventory.activeSlot).toBe(0);

      const weaponId = 'test-pickup-switch';
      const weapon = new WeaponEntity(
        weaponId,
        WeaponType.SHORT_SWORD,
        WeaponTier.UNCOMMON,
        10,
        10,
        10,
      );
      addPickup(
        room,
        weaponId,
        weapon,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, {}, helper);
      await helper.advanceTicks(1);

      expect(domainPlayer.inventory.activeSlot).toBe(1);
    });

    it('player with full inventory swaps on pickup', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'FullInv');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
        const w = new WeaponEntity(`fill-${i}`, WeaponType.DAGGER, WeaponTier.COMMON, 5, 5, 5);
        domainPlayer.addWeapon(w);
      }
      await helper.advanceTicks(1);
      expect(domainPlayer.hasEmptySlot()).toBe(false);

      const weaponId = 'test-pickup-swap';
      const weapon = new WeaponEntity(weaponId, WeaponType.LONG_SWORD, WeaponTier.RARE, 10, 10, 10);
      addPickup(
        room,
        weaponId,
        weapon,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, {}, helper);
      await helper.advanceTicks(1);

      const hasLongSword = domainPlayer.inventory.weapons.some(
        (w) => w !== null && w.type === WeaponType.LONG_SWORD,
      );
      expect(hasLongSword).toBe(true);
    });
  });

  describe('4. Chest Opening', () => {
    it('chest exists on the map after player join', async () => {
      const { room, helper } = await createGameRoom(server);
      await helper.addPlayer('SyncTrigger');
      await helper.advanceTicks(2);

      const match = getMatch(room);
      const chests = [...match.getState().chests.values()];
      expect(chests.length).toBeGreaterThan(0);
    });

    it('player near chest can start opening via domain command', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'ChestOpener');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      const chestId = 'test-chest-1';
      addChest(
        room,
        chestId,
        ChestRarity.COMMON,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, { targetId: chestId }, helper);
      await helper.advanceTicks(3);

      const chest = getMatch(room).getState().chests.get(chestId);
      expect(chest!.state).toBe('opening');
    });

    it('chest completes opening after duration', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'ChestTimer');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      const chestId = 'test-chest-2';
      addChest(
        room,
        chestId,
        ChestRarity.COMMON,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, { targetId: chestId }, helper);
      await helper.advanceTicks(3);

      const chest = getMatch(room).getState().chests.get(chestId);
      expect(chest!.state).toBe('opening');

      const openDurationTicks = Math.ceil(0.5 * NETWORK.TICK_RATE);
      tickDirect(room, openDurationTicks + 10);

      const chestAfter = getMatch(room).getState().chests.get(chestId);
      expect(chestAfter).toBeUndefined();
    });

    it('player too far from chest is rejected', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'FarPlayer');

      const chestId = 'test-chest-3';
      addChest(room, chestId, ChestRarity.COMMON, 100, 100);
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, { targetId: chestId }, helper);
      await helper.advanceTicks(5);

      const chest = getMatch(room).getState().chests.get(chestId);
      expect(chest!.state).toBe('closed');
    });

    it('player moving away interrupts chest opening', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'ChestMoveAway');
      const domainPlayer = getDomainPlayer(room, client.sessionId);

      const chestId = 'test-chest-4';
      addChest(
        room,
        chestId,
        ChestRarity.COMMON,
        domainPlayer.movement.position.x,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.PICKUP, { targetId: chestId }, helper);
      await helper.advanceTicks(3);

      const chest = getMatch(room).getState().chests.get(chestId);
      expect(chest!.state).toBe('opening');

      domainPlayer.movement.position = new Position(
        domainPlayer.movement.position.x + 50,
        domainPlayer.movement.position.y,
      );
      await helper.advanceTicks(10);

      const chestAfter = getMatch(room).getState().chests.get(chestId);
      expect(chestAfter!.state).toBe('closed');
    });
  });

  describe('5. Attack System', () => {
    it('ATTACK action starts windup', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker } = await prepareCombat(helper, room);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(1);

      const domainAttacker = getDomainPlayer(room, attacker.sessionId);
      expect(domainAttacker.combat.isInWindup()).toBe(true);
    });

    it('windup completes and damage is dealt to target', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('attack with different weapon types deals damage', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);
      equipWeapon(room, attacker.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(DAGGER_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('attack rate limiter prevents rapid duplicate attacks', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const healthAfterFirst = helper.getPlayer(target)!.health;
      expect(healthAfterFirst).toBeLessThan(PLAYER.BASE_HEALTH);

      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBe(healthAfterFirst);
    });
  });

  describe('6. Throw', () => {
    it('player with throwable weapon can THROW', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const client = await prepareSingle(helper, room, 'Thrower');
      equipWeapon(room, client.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, client.sessionId, 0);
      await helper.advanceTicks(1);

      expect(getDomainPlayer(room, client.sessionId).inventory.activeSlot).toBeGreaterThan(0);

      directInput(room, client.sessionId, InputAction.THROW, { aimAngle: 0 }, helper);
      tickDirect(room, DAGGER_WINDUP_TICKS + 5);

      const projectiles = [...helper.state.projectiles.values()];
      expect(projectiles.length).toBeGreaterThan(0);
    });

    it('thrown weapon creates a projectile with correct properties', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const client = await prepareSingle(helper, room, 'ProjCheck');
      equipWeapon(room, client.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, client.sessionId, 0);
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.THROW, { aimAngle: 0 }, helper);
      tickDirect(room, DAGGER_WINDUP_TICKS + 5);

      const proj = [...helper.state.projectiles.values()][0];
      expect(proj).toBeDefined();
      expect(proj.ownerId).toBe(client.sessionId);
      expect(proj.weaponType).toBe(WeaponType.DAGGER);
    });

    it('throw removes weapon from player slot', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const client = await prepareSingle(helper, room, 'ThrowEmpty');
      equipWeapon(room, client.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.inventory.activeSlot).toBe(1);
      await helper.advanceTicks(1);

      directInput(room, client.sessionId, InputAction.THROW, { aimAngle: 0 }, helper);
      tickDirect(room, DAGGER_WINDUP_TICKS + 5);

      expect(domainPlayer.inventory.activeSlot).toBe(0);
    });
  });

  describe('7. Dash', () => {
    it('DASH action starts a dash', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'Dasher');

      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      await helper.advanceTicks(1);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.movement.isDashing).toBe(true);
    });

    it('dash speed multiplier is correct', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'DashSpeed');
      const startX = helper.getPlayer(client)!.x;

      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      tickDirect(room, 1);
      for (let i = 0; i < DASH_DURATION_TICKS; i++) {
        directInput(room, client.sessionId, InputAction.MOVE, { dx: 1, dy: 0 }, helper);
        tickDirect(room, 1);
      }
      tickDirect(room, 2);

      const endX = helper.getPlayer(client)!.x;
      const dashDistance = endX - startX;
      const normalDistancePerTick = PLAYER.BASE_SPEED / NETWORK.TICK_RATE;
      const expectedDashTotal =
        normalDistancePerTick * PLAYER.DASH_SPEED_MULTIPLIER * DASH_DURATION_TICKS;
      expect(dashDistance).toBeGreaterThanOrEqual(expectedDashTotal * 0.5);
    });

    it('dash has cooldown', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'DashCD');

      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      await helper.advanceTicks(DASH_DURATION_TICKS + 2);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.movement.dashCooldownRemaining).toBeGreaterThan(0);
    });

    it('player cannot dash while dashing', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'DashDouble');

      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      tickDirect(room, 1);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.movement.isDashing).toBe(true);

      const cooldownBefore = domainPlayer.movement.dashCooldownRemaining;
      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      tickDirect(room, 1);

      expect(domainPlayer.movement.dashCooldownRemaining).toBe(cooldownBefore - 1);
    });

    it('dash ends after duration', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const client = await prepareSingle(helper, room, 'DashEnd');

      directInput(room, client.sessionId, InputAction.DASH, { dx: 1, dy: 0 }, helper);
      await helper.advanceTicks(DASH_DURATION_TICKS + 5);

      const domainPlayer = getDomainPlayer(room, client.sessionId);
      expect(domainPlayer.movement.isDashing).toBe(false);
      expect(domainPlayer.movement.speed.value).toBe(PLAYER.BASE_SPEED);
    });
  });

  describe('8. Zone System', () => {
    it('zone is initialized with radius after player join', async () => {
      const { room, helper } = await createGameRoom(server);
      await helper.addPlayer('ZoneInit');
      await helper.advanceTicks(2);

      const zone = helper.state.zone;
      expect(zone.currentRadius).toBeGreaterThan(0);
      expect(zone.currentRadius).toBeLessThanOrEqual(ZONE.INITIAL_ZONE_RADIUS);
    });

    it('zone has correct initial phase', async () => {
      const { room, helper } = await createGameRoom(server);
      await helper.addPlayer('ZonePhase');
      await helper.advanceTicks(2);

      const zone = helper.state.zone;
      expect(zone.phase).toBe(1);
    });

    it('zone center is within map bounds', async () => {
      const { room, helper } = await createGameRoom(server);
      await helper.addPlayer('ZoneCenter');
      await helper.advanceTicks(2);

      const zone = helper.state.zone;
      expect(zone.centerX).toBeGreaterThan(0);
      expect(zone.centerY).toBeGreaterThan(0);
    });
  });

  describe('9. Combat Damage & Death', () => {
    it('player takes damage from attacks', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      const healthBefore = helper.getPlayer(target)!.health;
      directInput(room, attacker.sessionId, InputAction.ATTACK, { aimAngle: Math.PI / 2 }, helper);
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBeLessThan(healthBefore);
    });

    it('player at 0 HP dies', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      domainTarget.takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      await helper.advanceTicks(10);

      expect(helper.getPlayer(target)!.status & PlayerStatus.ALIVE).toBeFalsy();
    });

    it('dead player weapons drop as pickups', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);
      equipWeapon(room, target.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      equipWeapon(room, target.sessionId, WeaponType.SHORT_SWORD, WeaponTier.UNCOMMON);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      domainTarget.takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      await helper.advanceTicks(10);

      expect(domainTarget.isActive).toBe(false);

      const pickups = [...helper.state.weaponPickups.values()];
      const droppedWeaponTypes = pickups.map((p) => p.weaponType);
      expect(droppedWeaponTypes).toContain(WeaponType.DAGGER);
      expect(droppedWeaponTypes).toContain(WeaponType.SHORT_SWORD);
    });

    it('playersAlive decrements on death', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { target } = await prepareCombat(helper, room);
      expect(helper.state.playersAlive).toBe(2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      domainTarget.takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      await helper.advanceTicks(10);

      expect(helper.state.playersAlive).toBeLessThan(2);
    });

    it('elimination records track kills', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room);

      const domainAttacker = getDomainPlayer(room, attacker.sessionId);
      const domainTarget = getDomainPlayer(room, target.sessionId);

      domainTarget.takeDamage(PLAYER.BASE_HEALTH - 1, helper.tick, true);
      domainAttacker.recordKill();
      domainTarget.dieWithTick(helper.tick);
      getMatch(room).dropPlayerWeapons(target.sessionId);
      await helper.advanceTicks(10);

      expect(domainAttacker.kills).toBe(1);
      expect(helper.state.playersAlive).toBeLessThanOrEqual(1);
    });
  });

  describe('10. Bot Integration', () => {
    it('bot players can be added manually via domain', async () => {
      const { room, helper } = await createGameRoom(server);

      const match = getMatch(room);
      const botId = 'bot-manual-1';
      match.addPlayer(botId, 'TestBot');
      const bot = match.getPlayer(botId);
      expect(bot).toBeDefined();
      if (bot) bot.isBot = true;
      await helper.advanceTicks(2);
      await (room as unknown as GameRoom).syncState();
      await helper.advanceTicks(1);

      expect(bot).toBeDefined();
      expect(bot!.health.current).toBe(PLAYER.BASE_HEALTH);
      expect(bot!.isActive).toBe(true);
    });

    it('bot players can be killed', async () => {
      const { room, helper } = await createGameRoom(server);

      const match = getMatch(room);
      const botId = 'bot-manual-3';
      match.addPlayer(botId, 'TestBot3');
      const bot = match.getPlayer(botId);
      if (bot) bot.isBot = true;
      forceActivePhase(room);
      await helper.advanceTicks(2);

      expect(bot!.isActive).toBe(true);

      bot!.takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      tickDirect(room, 15);

      expect(bot!.isActive).toBe(false);
    });

    it('real player joins alongside bot players', async () => {
      const { room, helper } = await createGameRoom(server);

      const match = getMatch(room);
      match.addPlayer('bot-4a', 'TestBot4');
      match.addPlayer('bot-4b', 'TestBot5');
      (room as unknown as GameRoom).syncState();
      await helper.advanceTicks(2);

      const beforeCount = helper.state.players.size;
      await helper.addPlayer('RealPlayer');
      await helper.advanceTicks(2);

      expect(helper.state.players.size).toBe(beforeCount + 1);
      const realPlayer = helper.getAllPlayers().find((p) => p.name === 'RealPlayer');
      expect(realPlayer).toBeDefined();
    });
  });
});
