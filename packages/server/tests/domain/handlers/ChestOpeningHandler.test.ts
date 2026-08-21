import { describe, it, expect, vi } from 'vitest';
import {
  ChestOpeningHandler,
  type ChestOpeningHandlerContext,
} from '../../../src/domain/handlers/ChestOpeningHandler.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import {
  TileType,
  PlayerStatus,
  WeaponType,
  WeaponTier,
  ChestRarity,
  SeededRNG,
} from '@sector-battle/shared';
import { LootService } from '../../../src/domain/services/LootService.ts';
import type { DomainEvent } from '../../../src/domain/events/index.ts';

function createPlayer(id: string, x: number, y: number): Player {
  const player = new Player(id, `player_${id}`, new Position(x, y), {
    baseHealth: 100,
    maxHealth: 100,
    baseSpeed: 200,
    dashSpeedMultiplier: 3,
    dashDuration: 10,
    dashCooldown: 120,
    inventorySize: 4,
    hitboxWidth: 24,
    hitboxHeight: 24,
  });
  player.statusEffects.status = PlayerStatus.ALIVE;
  player.spawnTick = -10000;
  player.statusEffects.freshSpawnExpiryTick = 0;
  return player;
}

function createChest(id: string, tier: ChestRarity, x: number, y: number): Chest {
  return Chest.create(id, tier, new Position(x, y));
}

let emittedEvents: DomainEvent[] = [];
let weaponPickups: Array<{ id: string; weapon: WeaponEntity; position: Position }> = [];
let removedChests: string[] = [];
let tiles: Map<string, TileType> = new Map();

function createContext(
  overrides?: Partial<ChestOpeningHandlerContext>,
): ChestOpeningHandlerContext {
  emittedEvents = [];
  weaponPickups = [];
  removedChests = [];
  tiles = new Map();

  return {
    getPlayer: () => undefined,
    getChests: () => [],
    getCurrentTick: () => 100,
    emitEvent: (event: DomainEvent) => {
      emittedEvents.push(event);
    },
    setTileAt: (gx: number, gy: number, type: TileType) => {
      tiles.set(`${gx},${gy}`, type);
    },
    worldToGrid: (wx: number, wy: number) => ({
      gridX: Math.floor(wx / 32),
      gridY: Math.floor(wy / 32),
    }),
    addWeaponPickup: (id: string, weapon: WeaponEntity, position: Position) => {
      weaponPickups.push({ id, weapon, position });
    },
    removeChest: (id: string) => {
      removedChests.push(id);
    },
    unregisterChestOpening: () => {},
    getTileAt: () => TileType.EMPTY,
    nextId: () => `id_${Math.random().toString(36).slice(2, 8)}`,
    getTileWidth: () => 32,
    lootService: new LootService(),
    lootRng: new SeededRNG(42),
    ...overrides,
  };
}

describe('ChestOpeningHandler', () => {
  describe('tickOpenings', () => {
    it('completes after 0.5s', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.5);

      const opened = emittedEvents.find((e) => e.type === 'ChestOpened');
      expect(opened).toBeDefined();
      expect((opened as Record<string, unknown>).chestId).toBe('c1');
      expect((opened as Record<string, unknown>).playerId).toBe('p1');
    });

    it('completes with multiple dt calls', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.3);
      expect(chest.state).toBe('opening');

      handler.tickOpenings(0.2);
      expect(emittedEvents.some((e) => e.type === 'ChestOpened')).toBe(true);
    });

    it('interrupts when player dies', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      player.die();
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.1);

      expect(chest.state).toBe('closed');
      expect(emittedEvents.some((e) => e.type === 'ChestOpeningInterrupted')).toBe(true);
      expect(removedChests).not.toContain('c1');
    });

    it('interrupts when player moves out of range', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      player.movement.position = new Position(200, 100);
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.1);

      expect(chest.state).toBe('closed');
      expect(emittedEvents.some((e) => e.type === 'ChestOpeningInterrupted')).toBe(true);
    });

    it('does NOT interrupt when player takes damage', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      player.takeDamage(30, 100);
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.1);

      expect(chest.state).toBe('opening');
      expect(emittedEvents.some((e) => e.type === 'ChestOpeningInterrupted')).toBe(false);
    });

    it('does NOT interrupt when player stays still within range', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.1);

      expect(chest.state).toBe('opening');
      expect(emittedEvents.length).toBe(0);
    });

    it('player not found: interrupts and saves chest', () => {
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const ctx = createContext({
        getPlayer: () => undefined,
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.1);

      expect(chest.state).toBe('closed');
      expect(emittedEvents.some((e) => e.type === 'ChestOpeningInterrupted')).toBe(true);
      expect(removedChests).not.toContain('c1');
    });

    it('no opening chests: no-op', () => {
      const closedChest = createChest('c1', ChestRarity.COMMON, 110, 100);
      const ctx = createContext({
        getChests: () => [closedChest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.5);

      expect(closedChest.state).toBe('closed');
      expect(emittedEvents.length).toBe(0);
    });

    it('multiple chests opening simultaneously', () => {
      const player1 = createPlayer('p1', 100, 100);
      const player2 = createPlayer('p2', 200, 200);
      const chest1 = createChest('c1', ChestRarity.COMMON, 110, 100);
      const chest2 = createChest('c2', ChestRarity.RARE, 210, 200);
      chest1.startOpening('p1', 10, new Position(100, 100));
      chest2.startOpening('p2', 10, new Position(200, 200));

      player2.die();

      const ctx = createContext({
        getPlayer: (id) => {
          if (id === 'p1') return player1;
          if (id === 'p2') return player2;
          return undefined;
        },
        getChests: () => [chest1, chest2],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.5);

      expect(
        emittedEvents.some(
          (e) => e.type === 'ChestOpened' && (e as Record<string, unknown>).playerId === 'p1',
        ),
      ).toBe(true);
      expect(chest1.state === 'open' || removedChests.includes('c1')).toBe(true);
      expect(chest2.state).toBe('closed');
      expect(
        emittedEvents.some(
          (e) =>
            e.type === 'ChestOpeningInterrupted' &&
            (e as Record<string, unknown>).playerId === 'p2',
        ),
      ).toBe(true);
    });
  });

  describe('completeOpening', () => {
    it('sets tile to EMPTY', () => {
      const player = createPlayer('p1', 50, 20);
      const chest = createChest('c1', ChestRarity.COMMON, 48, 16);
      chest.startOpening('p1', 10, new Position(50, 20));
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      const gridX = Math.floor(48 / 32);
      const gridY = Math.floor(16 / 32);
      expect(tiles.get(`${gridX},${gridY}`)).toBe(TileType.EMPTY);
    });

    it('spawns weapon loot', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const lootService = new LootService();
      vi.spyOn(lootService, 'rollChestLoot').mockReturnValue({
        kind: 'weapon',
        tier: WeaponTier.COMMON,
      });
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
        lootService,
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      expect(weaponPickups.length).toBe(1);
      expect(weaponPickups[0].weapon.tier).toBe(WeaponTier.COMMON);
    });

    it('weapon spawned at adjacent empty tile', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const lootService = new LootService();
      vi.spyOn(lootService, 'rollChestLoot').mockReturnValue({
        kind: 'weapon',
        tier: WeaponTier.COMMON,
      });
      const chestGridX = Math.floor(110 / 32);
      const chestGridY = Math.floor(100 / 32);
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
        lootService,
        getTileAt: (gx: number, gy: number) => {
          if (gx === chestGridX && gy === chestGridY - 1) return TileType.EMPTY;
          return TileType.INDESTRUCTIBLE_WALL;
        },
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      expect(weaponPickups.length).toBe(1);
      const expectedX = chestGridX * 32 + 16;
      const expectedY = (chestGridY - 1) * 32 + 16;
      expect(weaponPickups[0].position.x).toBe(expectedX);
      expect(weaponPickups[0].position.y).toBe(expectedY);
    });

    it('weapon placed at chest position when no adjacent empty tile', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.COMMON, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const lootService = new LootService();
      vi.spyOn(lootService, 'rollChestLoot').mockReturnValue({
        kind: 'weapon',
        tier: WeaponTier.COMMON,
      });
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
        lootService,
        getTileAt: () => TileType.INDESTRUCTIBLE_WALL,
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      expect(weaponPickups.length).toBe(1);
      expect(weaponPickups[0].position.x).toBe(chest.position.x);
      expect(weaponPickups[0].position.y).toBe(chest.position.y);
    });

    it('calls lootService with chest tier', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.EPIC, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const lootService = new LootService();
      const rng = new SeededRNG(42);
      const rollSpy = vi
        .spyOn(lootService, 'rollChestLoot')
        .mockReturnValue({ kind: 'weapon', tier: WeaponTier.COMMON });
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
        lootService,
        lootRng: rng,
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      expect(rollSpy).toHaveBeenCalledWith(ChestRarity.EPIC, rng);
    });

    it('emits ChestOpened event with loot info', () => {
      const player = createPlayer('p1', 100, 100);
      const chest = createChest('c1', ChestRarity.RARE, 110, 100);
      chest.startOpening('p1', 10, new Position(100, 100));
      const lootService = new LootService();
      const lootResult = { kind: 'weapon' as const, tier: WeaponTier.RARE };
      vi.spyOn(lootService, 'rollChestLoot').mockReturnValue(lootResult);
      const ctx = createContext({
        getPlayer: (id) => (id === 'p1' ? player : undefined),
        getChests: () => [chest],
        lootService,
      });
      const handler = new ChestOpeningHandler(ctx);

      handler.tickOpenings(0.6);

      const opened = emittedEvents.find((e) => e.type === 'ChestOpened');
      expect(opened).toBeDefined();
      const evt = opened as Record<string, unknown>;
      expect(evt.chestId).toBe('c1');
      expect(evt.playerId).toBe('p1');
      expect(evt.tier).toBe(ChestRarity.RARE);
      expect(evt.lootContents).toEqual(lootResult);
    });
  });
});
