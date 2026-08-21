import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import { advanceTicks } from '../helpers/test-utils';
import {
  PLAYER,
  NETWORK,
  COMBAT,
  GRID,
  BARREL,
  WeaponType,
  WeaponTier,
  TileType,
  MatchPhase,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../src/domain/entities/index';
import { Position } from '../../src/domain/value-objects/index';
import { Destructible } from '../../src/domain/entities/Destructible';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const FISTS_WINDUP_TICKS = Math.ceil(50 / (1000 / NETWORK.TICK_RATE));
const BOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.windupMs / (1000 / 60),
);
const THROW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.windupMs / (1000 / 60),
);
const ARROW_PX_PER_TICK = 2000 / NETWORK.TICK_RATE;

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
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
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

function tileCenter(gx: number, gy: number): Position {
  return new Position((gx + 0.5) * GRID.TILE_SIZE, (gy + 0.5) * GRID.TILE_SIZE);
}

/**
 * Register a full-tile collider for a destructible in colliderData.
 * The melee sweep pipeline reads enriched collider data — tests that only
 * set the grid tile without registering collider data will have sweeps
 * pass through harmlessly.
 */
const TEST_COLLIDER_SPRITE_ID = 9999;
function registerTestCollider(match: GameMatch, destructible: Destructible): void {
  if (!match.colliderData) return;
  const atlas = match.colliderData.atlas;
  if (!atlas.sprites[TEST_COLLIDER_SPRITE_ID]) {
    atlas.sprites[TEST_COLLIDER_SPRITE_ID] = {
      id: TEST_COLLIDER_SPRITE_ID,
      imagePath: 'test-destructible',
      tileType: TileType.DESTRUCTIBLE_CRATE,
      colliders: [{ type: 'rect', x: 0, y: 0, width: GRID.TILE_SIZE, height: GRID.TILE_SIZE }],
    };
  }
  const gx = Math.floor(destructible.position.x / GRID.TILE_SIZE);
  const gy = Math.floor(destructible.position.y / GRID.TILE_SIZE);
  if (!match.colliderData.visuals[gy]) match.colliderData.visuals[gy] = [];
  match.colliderData.visuals[gy]![gx] = {
    spriteId: TEST_COLLIDER_SPRITE_ID,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: { getCurrentState: () => { phase: number }; transitionTo: (p: number) => void };
    phase: number;
    setLastStandingThreshold: (n: number) => void;
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
  orch.setLastStandingThreshold(-1);
  gameRoom.syncState();
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

async function setupTestRoom() {
  const { room, helper } = await createGameRoom(server);
  const match = getMatch(room);
  const grid = match.getGrid();
  const cx = 40;
  const cy = 40;
  clearArea(grid, cx, cy, 8);
  clearEntities(match);

  const client = await helper.addPlayer('Player1');
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);

  return { room, helper, match, grid, client, cx, cy };
}

describe('Destructible + Barrel Integration Tests', () => {
  describe('Crate Destruction', () => {
    it('crate: 2 HP, destroyed by single melee hit', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
      const cratePos = tileCenter(gx, gy);
      const crate = Destructible.create('crate-1', 'crate', cratePos);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        cratePos.x - 60,
        cratePos.y,
      );
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(grid[gy]![gx]).toBe(TileType.EMPTY);
      expect(match.getState().destructibles.has('crate-1')).toBe(false);
    });

    it('crate has 60% loot drop chance (statistical)', async () => {
      const lootCount = { drops: 0, total: 0 };

      for (let i = 0; i < 10; i++) {
        const { room, helper, match, grid, client } = await setupTestRoom();
        const gx = 41;
        const gy = 40;
        grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
        const cratePos = tileCenter(gx, gy);
        const crate = Destructible.create(`crate-stat-${i}`, 'crate', cratePos);
        match.addDestructible(crate);
        registerTestCollider(match, crate);

        getDomainPlayer(room, client.sessionId).movement.position = new Position(
          cratePos.x - 60,
          cratePos.y,
        );
        await helper.advanceTicks(1);
        getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

        await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

        // Crate loot rolls produce EITHER a weapon pickup OR a powerup
        // (LootService.rollCrateLoot — 70% weapon split, 30% powerup split,
        // gated by the 60% DROP_CHANCE). Count both toward the drop rate.
        const weaponPickups = [...room.state.weaponPickups.values()];
        const powerUps = [...room.state.powerUps.values()];
        if (weaponPickups.length > 0 || powerUps.length > 0) lootCount.drops++;
        lootCount.total++;
      }

      expect(lootCount.drops).toBeGreaterThanOrEqual(3);
    }, 90_000);

    it('crate destruction always clears tile regardless of loot', async () => {
      for (let i = 0; i < 10; i++) {
        const { room, helper, match, grid, client } = await setupTestRoom();
        const gx = 41;
        const gy = 40;
        grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
        const cratePos = tileCenter(gx, gy);
        const crate = Destructible.create(`crate-clear-${i}`, 'crate', cratePos);
        match.addDestructible(crate);
        registerTestCollider(match, crate);

        getDomainPlayer(room, client.sessionId).movement.position = new Position(
          cratePos.x - 60,
          cratePos.y,
        );
        await helper.advanceTicks(1);
        getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

        await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

        expect(grid[gy]![gx]).toBe(TileType.EMPTY);
      }
    }, 90_000);
  });

  describe('Barrel Explosion', () => {
    it('barrel: 2 HP, explodes on destruction', async () => {
      const { room, helper, match, grid } = await setupTestRoom();
      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(gx, gy);
      const barrel = Destructible.create('barrel-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      match.destroyDestructible('barrel-1');
      await helper.advanceTicks(5);

      expect(match.destructibles.has('barrel-1')).toBe(false);
      expect(grid[gy]![gx]).toBe(TileType.EMPTY);

      const explosions = [...room.state.explosions.values()];
      expect(explosions.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('barrel explosion deals 50 damage in radius', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 42;
      const barrelGy = 40;
      grid[barrelGy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(barrelGx, barrelGy);
      const barrel = Destructible.create('barrel-dmg-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      const playerPos = new Position(barrelPos.x - 100, barrelPos.y);
      getDomainPlayer(room, client.sessionId).movement.position = playerPos;
      await helper.advanceTicks(1);

      match.destroyDestructible('barrel-dmg-1');
      await helper.advanceTicks(5);

      const playerState = helper.getPlayer(client)!;
      expect(PLAYER.BASE_HEALTH - playerState.health).toBeGreaterThanOrEqual(
        BARREL.EXPLOSION_DAMAGE,
      );
    });

    it('barrel explosion damages all entities in radius', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const client2 = await helper.addPlayer('Player2');
      await helper.advanceTicks(SPAWN_INV_TICKS);

      const barrelGx = 42;
      const barrelGy = 40;
      grid[barrelGy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(barrelGx, barrelGy);
      const barrel = Destructible.create('barrel-multi-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x - 100,
        barrelPos.y,
      );
      getDomainPlayer(room, client2.sessionId).movement.position = new Position(
        barrelPos.x + 100,
        barrelPos.y,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('barrel-multi-1');
      await helper.advanceTicks(5);

      expect(helper.getPlayer(client)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
      expect(helper.getPlayer(client2)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('barrel explosion is environmental damage (bypasses shield)', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 42;
      const barrelGy = 40;
      grid[barrelGy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(barrelGx, barrelGy);
      const barrel = Destructible.create('barrel-env-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x - 100,
        barrelPos.y,
      );
      await helper.advanceTicks(1);

      const dp = getDomainPlayer(room, client.sessionId);
      dp.statusEffects.barrierActive = true;

      match.destroyDestructible('barrel-env-1');
      await helper.advanceTicks(5);

      expect(helper.getPlayer(client)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });
  });

  describe('Barrel Chain Reaction', () => {
    it('barrel chain reaction triggers nearby barrels', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx1 = 42;
      const gx2 = 43;
      const gy = 40;
      grid[gy]![gx1] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![gx2] = TileType.DESTRUCTIBLE_BARREL;
      const pos1 = tileCenter(gx1, gy);
      const pos2 = tileCenter(gx2, gy);
      const barrel1 = Destructible.create('chain-1', 'barrel', pos1);
      const barrel2 = Destructible.create('chain-2', 'barrel', pos2);
      match.addDestructible(barrel1);
      registerTestCollider(match, barrel1);
      match.addDestructible(barrel2);
      registerTestCollider(match, barrel2);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(pos1.x - 60, pos1.y);
      await helper.advanceTicks(1);

      match.destroyDestructible('chain-1');
      await helper.advanceTicks(5);

      expect(match.getState().destructibles.has('chain-2')).toBe(false);
    });

    it('DDA raycast stops at indestructible walls', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 38;
      const wallGx = 40;
      const gy = 40;

      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;
      const barrelPos = tileCenter(barrelGx, gy);
      const wallPos = tileCenter(wallGx, gy);
      const barrel = Destructible.create('ray-wall-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        wallPos.x + 60,
        wallPos.y,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('ray-wall-1');
      await helper.advanceTicks(10);

      expect(grid[gy]![wallGx]).toBe(TileType.INDESTRUCTIBLE_WALL);
      const playerHealth = helper.getPlayer(client)!.health;
      expect(playerHealth).toBe(PLAYER.BASE_HEALTH);
    });

    it('DDA raycast stops at indestructible crates', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 40;
      const crateGx = 42;
      const gy = 40;

      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![crateGx] = TileType.INDESTRUCTIBLE_CRATE;
      const barrelPos = tileCenter(barrelGx, gy);
      const barrel = Destructible.create('ray-crate-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x,
        barrelPos.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('ray-crate-1');
      await helper.advanceTicks(10);

      expect(grid[gy]![crateGx]).toBe(TileType.INDESTRUCTIBLE_CRATE);
    });

    it('barrel chain resolves instantly in same tick', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx1 = 40;
      const gx2 = 42;
      const gy = 40;
      grid[gy]![gx1] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![gx2] = TileType.DESTRUCTIBLE_BARREL;
      const pos1 = tileCenter(gx1, gy);
      const pos2 = tileCenter(gx2, gy);
      const barrel1 = Destructible.create('delay-1', 'barrel', pos1);
      const barrel2 = Destructible.create('delay-2', 'barrel', pos2);
      match.addDestructible(barrel1);
      registerTestCollider(match, barrel1);
      match.addDestructible(barrel2);
      registerTestCollider(match, barrel2);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        pos1.x,
        pos1.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('delay-1');

      expect(match.getState().destructibles.has('delay-2')).toBe(false);

      await helper.advanceTicks(5);

      const explosions = [...room.state.explosions.values()];
      expect(explosions.length).toBeGreaterThanOrEqual(2);
    });

    it('barrel chain respects safety cap of 20', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const startGx = 35;
      const gy = 40;

      for (let i = 0; i < 25; i++) {
        const gx = startGx + i;
        if (gx < grid[0]!.length) {
          grid[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
          const pos = tileCenter(gx, gy);
          const barrel = Destructible.create(`chain-max-${i}`, 'barrel', pos);
          match.addDestructible(barrel);
          registerTestCollider(match, barrel);
        }
      }

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        tileCenter(startGx, gy).x,
        tileCenter(startGx, gy).y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('chain-max-0');

      await helper.advanceTicks(5);

      let destroyedCount = 0;
      for (let i = 0; i < 25; i++) {
        if (!match.getState().destructibles.has(`chain-max-${i}`)) {
          destroyedCount++;
        }
      }

      expect(destroyedCount).toBeLessThanOrEqual(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION + 1);
    }, 30_000);

    it('chain reaction destroys crates', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 40;
      const crateGx = 42;
      const gy = 40;
      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![crateGx] = TileType.DESTRUCTIBLE_CRATE;
      const barrelPos = tileCenter(barrelGx, gy);
      const cratePos = tileCenter(crateGx, gy);
      const barrel = Destructible.create('chain-crate-b', 'barrel', barrelPos);
      const crate = Destructible.create('chain-crate-c', 'crate', cratePos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x,
        barrelPos.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('chain-crate-b');
      await helper.advanceTicks(10);

      expect(match.getState().destructibles.has('chain-crate-c')).toBe(false);
      expect(grid[gy]![crateGx]).toBe(TileType.EMPTY);
    });
  });

  describe('Destructible Wall', () => {
    it('destructible wall: 10 HP, no loot', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_WALL;
      const wallPos = tileCenter(gx, gy);
      const wall = Destructible.create('wall-1', 'wall', wallPos);
      match.addDestructible(wall);
      registerTestCollider(match, wall);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        wallPos.x - 60,
        wallPos.y,
      );
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      const cooldownTicks = Math.ceil(
        weaponRegistry.getDefinition(WeaponType.FISTS).baseStats.cooldown /
          (1000 / NETWORK.TICK_RATE),
      );

      for (let hit = 0; hit < 4; hit++) {
        await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + cooldownTicks + 2);
      }

      expect(grid[gy]![gx]).toBe(TileType.DESTRUCTIBLE_WALL);

      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(grid[gy]![gx]).toBe(TileType.EMPTY);
      expect(match.getState().destructibles.has('wall-1')).toBe(false);

      const pickups = [...room.state.weaponPickups.values()];
      expect(pickups.length).toBe(0);
    }, 30_000);

    it('destructible wall blocks movement until destroyed', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx = 42;
      const gy = 40;
      const wallPos = tileCenter(gx, gy);

      grid[gy]![gx] = TileType.DESTRUCTIBLE_WALL;
      const wall = Destructible.create('wall-block-1', 'wall', wallPos);
      match.addDestructible(wall);
      registerTestCollider(match, wall);
      // The raw grid write above is not enough for MOVEMENT collision: the
      // movement service's collision service resolves tiles through its
      // enriched-visuals store, which still holds the generated map's sprite
      // for this tile (registerTestCollider only feeds match.colliderData,
      // the projectile sweep store). Without a blocking visual the coasting
      // player passes straight through the "wall". Wire the same production
      // API the siege-wall drop path uses (GameOrchestratorInit wires
      // setSiegeWallEnriched onto this exact collision service) so the tile
      // carries a full-tile collider.
      const movementService = (
        room as unknown as GameRoom
      ).getOrchestrator()
        .getSimulation().movementService as unknown as {
        getCollisionService(): { setSiegeWallEnriched(gx: number, gy: number): void };
      };
      movementService.getCollisionService().setSiegeWallEnriched(gx, gy);

      expect(grid[gy]![gx]).toBe(TileType.DESTRUCTIBLE_WALL);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        wallPos.x - GRID.TILE_SIZE,
        wallPos.y,
      );
      await helper.advanceTicks(1);

      await helper.sendInput(client, { movementX: 1, movementY: 0 });
      await helper.advanceTicks(30);

      const playerState = helper.getPlayer(client)!;
      expect(playerState.x).toBeLessThan(wallPos.x);

      match.destroyDestructible('wall-block-1');
      await helper.advanceTicks(1);

      expect(grid[gy]![gx]).toBe(TileType.EMPTY);
      expect(match.getState().destructibles.has('wall-block-1')).toBe(false);
    });
  });

  describe('Melee vs Destructibles', () => {
    it('melee deals weapon destructibleDamage to destructibles (crate destroyed by long sword)', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.LONG_SWORD, WeaponTier.UNCOMMON);

      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
      const cratePos = tileCenter(gx, gy);
      const crate = Destructible.create('melee-dmg-1', 'crate', cratePos);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        cratePos.x - 60,
        cratePos.y,
      );
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      const windupTicks = Math.ceil(200 / (1000 / NETWORK.TICK_RATE));
      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(windupTicks + 5);

      expect(grid[gy]![gx]).toBe(TileType.EMPTY);
      expect(match.getState().destructibles.has('melee-dmg-1')).toBe(false);
    });

    it('melee deals 1 HP to barrel (2 HP → 1 HP) and primes the fuse', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(gx, gy);
      const barrel = Destructible.create('melee-barrel-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x - 60,
        barrelPos.y,
      );
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      const tickBefore = match.currentTick;
      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      // Juice-pass-1 ticket 05: flat two-hit model — a Fists punch costs
      // exactly 1 HP regardless of destructibleDamage, and the surviving hit
      // primes the 15s tick-based fuse.
      expect(barrel.isDestroyed).toBe(false);
      expect(barrel.hp).toBe(1);
      expect(barrel.primed).toBe(true);
      expect(barrel.fuseExpiresAtTick).toBeGreaterThan(tickBefore);
      expect(barrel.fuseExpiresAtTick).toBeLessThanOrEqual(
        tickBefore + FISTS_WINDUP_TICKS + 5 + BARREL.FUSE_TICKS,
      );
    });

    it('melee wall hit has no durability cost', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);

      const gx = 41;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_WALL;
      const wallPos = tileCenter(gx, gy);
      const wall = Destructible.create('melee-wall-dur-1', 'wall', wallPos);
      match.addDestructible(wall);
      registerTestCollider(match, wall);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        wallPos.x - 60,
        wallPos.y,
      );
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      const dp = getDomainPlayer(room, client.sessionId);
      const weaponBefore = dp.getActiveWeapon();
      const durabilityBefore = weaponBefore!.ammo;

      const windupTicks = Math.ceil(100 / (1000 / NETWORK.TICK_RATE));
      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(windupTicks + 5);

      const weaponAfter = dp.getActiveWeapon();
      expect(weaponAfter!.ammo).toBe(durabilityBefore);
    });
  });

  describe('Arrow vs Destructibles', () => {
    it('arrow destroys crate (2 HP), then disappears', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);

      const gx = 42;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
      const cratePos = tileCenter(gx, gy);
      const crate = Destructible.create('arrow-crate-1', 'crate', cratePos);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      const attackerPos = tileCenter(40, 40);
      getDomainPlayer(room, client.sessionId).movement.position = attackerPos;
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 30);

      expect(match.getState().destructibles.has('arrow-crate-1')).toBe(false);
    }, 30_000);

    it('arrow damages barrel (2 HP → 1 HP)', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);

      const gx = 42;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
      const barrelPos = tileCenter(gx, gy);
      const barrel = Destructible.create('arrow-barrel-1', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      const attackerPos = tileCenter(40, 40);
      getDomainPlayer(room, client.sessionId).movement.position = attackerPos;
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 30);

      // Juice-pass-1 ticket 05: arrow = exactly 1 HP to a barrel — a fresh
      // 2-HP barrel always survives and primes.
      expect(barrel.isDestroyed).toBe(false);
      expect(barrel.hp).toBe(1);
      expect(barrel.primed).toBe(true);
    }, 30_000);

    it('arrow damages destructible wall', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);

      const gx = 42;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_WALL;
      const wallPos = tileCenter(gx, gy);
      const wall = Destructible.create('arrow-wall-1', 'wall', wallPos);
      match.addDestructible(wall);
      registerTestCollider(match, wall);

      const attackerPos = tileCenter(40, 40);
      getDomainPlayer(room, client.sessionId).movement.position = attackerPos;
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 30);

      expect(wall.hp).toBeLessThan(wall.maxHp);
    }, 30_000);
  });

  describe('Thrown vs Destructibles', () => {
    it('thrown weapon destroys crate, then disappears', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);

      const gx = 42;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_CRATE;
      const cratePos = tileCenter(gx, gy);
      const crate = Destructible.create('thrown-crate-1', 'crate', cratePos);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      const attackerPos = tileCenter(40, 40);
      getDomainPlayer(room, client.sessionId).movement.position = attackerPos;
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 50);

      expect(crate.isDestroyed).toBe(true);
    }, 30_000);

    it('thrown weapon bounces off destructible wall', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      equipWeapon(room, client.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);

      const gx = 42;
      const gy = 40;
      grid[gy]![gx] = TileType.DESTRUCTIBLE_WALL;
      const wallPos = tileCenter(gx, gy);
      const wall = Destructible.create('thrown-wall-1', 'wall', wallPos);
      match.addDestructible(wall);
      registerTestCollider(match, wall);

      const attackerPos = tileCenter(40, 40);
      getDomainPlayer(room, client.sessionId).movement.position = attackerPos;
      await helper.advanceTicks(1);
      getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;

      await helper.sendInput(client, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 50);

      expect(wall.hp).toBeLessThan(wall.maxHp);
    }, 30_000);
  });

  describe('Explosion Ray Interactions', () => {
    it('explosion destroys crates in ray path', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 40;
      const crateGx = 42;
      const gy = 40;
      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![crateGx] = TileType.DESTRUCTIBLE_CRATE;
      const barrelPos = tileCenter(barrelGx, gy);
      const cratePos = tileCenter(crateGx, gy);
      const barrel = Destructible.create('exp-crate-b', 'barrel', barrelPos);
      const crate = Destructible.create('exp-crate-c', 'crate', cratePos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);
      match.addDestructible(crate);
      registerTestCollider(match, crate);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x,
        barrelPos.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('exp-crate-b');
      await helper.advanceTicks(10);

      expect(match.getState().destructibles.has('exp-crate-c')).toBe(false);
      expect(grid[gy]![crateGx]).toBe(TileType.EMPTY);
    });

    it('explosion damages destructible walls in ray path', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 40;
      const wallGx = 42;
      const gy = 40;
      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![wallGx] = TileType.DESTRUCTIBLE_WALL;
      const barrelPos = tileCenter(barrelGx, gy);
      const wallPos = tileCenter(wallGx, gy);
      const barrel = Destructible.create('exp-wall-b', 'barrel', barrelPos);
      const wall = Destructible.create('exp-wall-w', 'wall', wallPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);
      match.addDestructible(wall);
      registerTestCollider(match, wall);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x,
        barrelPos.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('exp-wall-b');
      await helper.advanceTicks(10);

      expect(grid[gy]![wallGx]).toBe(TileType.EMPTY);
      expect(match.getState().destructibles.has('exp-wall-w')).toBe(false);
    });

    it('explosion blocked by indestructible walls', async () => {
      const { room, helper, match, grid, client } = await setupTestRoom();
      const barrelGx = 40;
      const wallGx = 42;
      const gy = 40;

      grid[gy]![barrelGx] = TileType.DESTRUCTIBLE_BARREL;
      grid[gy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

      const barrelPos = tileCenter(barrelGx, gy);
      const barrel = Destructible.create('exp-blocked-b', 'barrel', barrelPos);
      match.addDestructible(barrel);
      registerTestCollider(match, barrel);

      getDomainPlayer(room, client.sessionId).movement.position = new Position(
        barrelPos.x,
        barrelPos.y - 200,
      );
      await helper.advanceTicks(1);

      match.destroyDestructible('exp-blocked-b');
      await helper.advanceTicks(10);

      expect(grid[gy]![wallGx]).toBe(TileType.INDESTRUCTIBLE_WALL);
    });
  });
});
