import { describe, it, expect } from 'vitest';
import { WeaponType, PLAYER } from '@sector-battle/shared';
import { WorldSnapshot } from '../WorldSnapshot.ts';
import type { DestructibleDTO, TrapDTO } from '../WorldSnapshot.ts';
import type { EntityMaps } from '../../domain/aggregates/GameMatchEntityOps.ts';

interface MockWeapon {
  type: WeaponType;
  tier: string;
  ammo: number;
}

function createMockPlayer(opts: {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  facing?: number;
  hp?: number;
  maxHp?: number;
  alive?: boolean;
  bot?: boolean;
  weapons?: Array<MockWeapon | null>;
  activeSlot?: number;
  freshSpawn?: boolean;
  barrier?: boolean;
}): unknown {
  const weapons = opts.weapons ?? [];
  const activeSlot = opts.activeSlot ?? 0;
  return {
    movement: {
      position: { x: opts.x ?? 0, y: opts.y ?? 0 },
      velocityX: opts.vx ?? 0,
      velocityY: opts.vy ?? 0,
      facingAngle: opts.facing ?? 0,
    },
    health: { current: opts.hp ?? 100, max: opts.maxHp ?? 100 },
    isActive: opts.alive ?? true,
    isBot: opts.bot ?? false,
    inventory: {
      weapons,
      activeSlot,
      [Symbol.iterator]: function* () {
        for (const w of weapons) {
          yield w;
        }
      },
    },
    statusEffects: { barrierActive: opts.barrier ?? false },
    combat: {
      isInWindup: () => false,
      windupRemaining: 0,
      lastAttackTick: 0,
    },
    isFreshSpawn: () => opts.freshSpawn ?? false,
    getActiveWeapon: () => weapons[activeSlot] ?? undefined,
  };
}

function createMockWeaponPickup(opts: {
  id: string;
  x?: number;
  y?: number;
  active?: boolean;
  tier?: string;
  weaponType?: WeaponType;
}): unknown {
  return {
    isActive: opts.active ?? true,
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    weapon: { tier: opts.tier ?? 'common', type: opts.weaponType ?? WeaponType.SHORT_SWORD },
  };
}

function createMockPowerUp(opts: {
  id: string;
  x?: number;
  y?: number;
  active?: boolean;
  type?: 'health_pack' | 'barrier' | 'speed_boost';
}): unknown {
  return {
    isActive: opts.active ?? true,
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    type: opts.type ?? 'health_pack',
  };
}

function createMockChest(opts: {
  id: string;
  x?: number;
  y?: number;
  state?: 'closed' | 'opening' | 'open';
}): unknown {
  return {
    state: opts.state ?? 'closed',
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
  };
}

function createMockDestructible(opts: {
  id: string;
  x?: number;
  y?: number;
  type?: string;
  hp?: number;
  maxHp?: number;
  destroyed?: boolean;
}): unknown {
  return {
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    type: opts.type ?? 'crate',
    hp: opts.hp ?? 5,
    maxHp: opts.maxHp ?? 5,
    isDestroyed: opts.destroyed ?? false,
  };
}

function createMockTrap(opts: {
  id: string;
  x?: number;
  y?: number;
  type?: string | number;
}): unknown {
  return {
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    type: opts.type ?? 'SPIKE',
  };
}

function createMockProjectile(opts: {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}): unknown {
  return {
    position: { x: opts.x ?? 0, y: opts.y ?? 0 },
    velocityX: opts.vx ?? 0,
    velocityY: opts.vy ?? 0,
  };
}

function makeMaps(
  opts: {
    players?: Array<[string, unknown]>;
    weaponPickups?: Array<[string, unknown]>;
    powerUps?: Array<[string, unknown]>;
    chests?: Array<[string, unknown]>;
    destructibles?: Array<[string, unknown]>;
    traps?: Array<[string, unknown]>;
    projectiles?: Array<[string, unknown]>;
  } = {},
): EntityMaps {
  return {
    players: new Map(opts.players ?? []),
    weaponPickups: new Map(opts.weaponPickups ?? []),
    powerUps: new Map(opts.powerUps ?? []),
    chests: new Map(opts.chests ?? []),
    destructibles: new Map(opts.destructibles ?? []),
    traps: new Map(opts.traps ?? []),
    projectiles: new Map(opts.projectiles ?? []),
    exits: new Map(),
    explosions: new Map(),
    projectileMeta: new Map(),
  } as unknown as EntityMaps;
}

describe('WorldSnapshot', () => {
  describe('sync - players', () => {
    it('populates player DTOs with correct field values', () => {
      const snapshot = new WorldSnapshot();
      const maps = makeMaps({
        players: [
          [
            'p1',
            createMockPlayer({
              id: 'p1',
              x: 100,
              y: 200,
              vx: 10,
              vy: -5,
              facing: 1.57,
              hp: 75,
              maxHp: 120,
              alive: true,
              bot: true,
              weapons: [
                { type: WeaponType.FISTS, tier: 'common', ammo: -1 },
                { type: WeaponType.SHORT_SWORD, tier: 'rare', ammo: 50 },
              ],
              activeSlot: 1,
              freshSpawn: true,
              barrier: true,
            }),
          ],
        ],
      });

      snapshot.sync(maps);

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto).toBeDefined();
      expect(dto.id).toBe('p1');
      expect(dto.x).toBe(100);
      expect(dto.y).toBe(200);
      expect(dto.velocityX).toBe(10);
      expect(dto.velocityY).toBe(-5);
      expect(dto.facingAngle).toBe(1.57);
      expect(dto.health).toBe(75);
      expect(dto.maxHealth).toBe(120);
      expect(dto.isAlive).toBe(true);
      expect(dto.isBot).toBe(true);
      expect(dto.activeSlot).toBe(1);
      expect(dto.isFreshSpawn).toBe(true);
      expect(dto.barrierActive).toBe(true);
    });

    it('flattens position to x/y — no nested position object', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1', x: 42, y: 99 })]],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.x).toBe(42);
      expect(dto.y).toBe(99);
      expect((dto as unknown as Record<string, unknown>).position).toBeUndefined();
    });

    it('syncs weapon inventory with correct tier mapping', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [
                  { type: WeaponType.FISTS, tier: 'common', ammo: -1 },
                  { type: WeaponType.SHORT_SWORD, tier: 'uncommon', ammo: 10 },
                  { type: WeaponType.LONG_SWORD, tier: 'legendary', ammo: 5 },
                ],
                activeSlot: 0,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.weaponCount).toBe(3);
      expect(dto.weapons[0]!.weaponType).toBe(WeaponType.FISTS);
      expect(dto.weapons[0]!.tier).toBe(0);
      expect(dto.weapons[0]!.ammo).toBe(-1);
      expect(dto.weapons[0]!.durability).toBe(-1);
      expect(dto.weapons[1]!.weaponType).toBe(WeaponType.SHORT_SWORD);
      expect(dto.weapons[1]!.tier).toBe(1);
      expect(dto.weapons[1]!.durability).toBe(10);
      expect(dto.weapons[2]!.tier).toBe(3);
      expect(dto.weapons[2]!.durability).toBe(5);
    });

    it('weapon arrays pre-allocated to PLAYER.INVENTORY_SIZE', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1' })]],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.weapons.length).toBe(PLAYER.INVENTORY_SIZE);
    });

    it('syncs weapons SLOT-INDEXED (not compacted) for sparse inventories', () => {
      // Regression: a sparse inventory [FISTS, null, LONG_SWORD, null] with
      // activeSlot=2 must sync the LONG_SWORD at weapons[2], NOT compacted to
      // weapons[1]. Compaction broke getActiveWeapon (ctx.weapons[2] was
      // undefined → FISTS fallback when actually holding a sword) and
      // SWITCH_SLOT (targeted null server slots).
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [
                  { type: WeaponType.FISTS, tier: 'common', ammo: -1 },
                  null,
                  { type: WeaponType.LONG_SWORD, tier: 'legendary', ammo: 5 },
                  null,
                ],
                activeSlot: 2,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.activeSlot).toBe(2);
      // The sword MUST be at its slot index (2), not compacted to index 1.
      expect(dto.weapons[2]!.weaponType).toBe(WeaponType.LONG_SWORD);
      expect(dto.weapons[2]!.tier).toBe(3);
      expect(dto.weapons[2]!.durability).toBe(5);
      // The empty slot 1 is marked FISTS/0 (slot 0 is the real immutable FISTS;
      // the bot's updateSelfState treats FISTS-in-slot->0 as empty/null).
      expect(dto.weapons[1]!.weaponType).toBe(WeaponType.FISTS);
      expect(dto.weapons[1]!.ammo).toBe(0);
      expect(dto.weapons[3]!.weaponType).toBe(WeaponType.FISTS);
      expect(dto.weapons[3]!.ammo).toBe(0);
      // weaponCount counts non-null weapons (FISTS + LONG_SWORD = 2).
      expect(dto.weaponCount).toBe(2);
    });

    it('computes hasWeapon, weaponTier, weaponType from active weapon', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [
                  { type: WeaponType.FISTS, tier: 'common', ammo: -1 },
                  { type: WeaponType.SHORT_SWORD, tier: 'rare', ammo: 30 },
                ],
                activeSlot: 1,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.hasWeapon).toBe(true);
      expect(dto.weaponTier).toBe(2);
      expect(dto.weaponType).toBe(WeaponType.SHORT_SWORD);
    });

    it('defaults weaponType to FISTS when no active weapon', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [],
                activeSlot: 0,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.weaponCount).toBe(0);
      expect(dto.hasWeapon).toBe(false);
      expect(dto.weaponTier).toBe(0);
      expect(dto.weaponType).toBe(WeaponType.FISTS);
    });

    it('hasWeapon is false when only fists (single weapon)', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [{ type: WeaponType.FISTS, tier: 'common', ammo: -1 }],
                activeSlot: 0,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getPlayerById('p1')!;
      expect(dto.weaponCount).toBe(1);
      expect(dto.hasWeapon).toBe(false);
    });
  });

  describe('sync - items', () => {
    it('combines weaponPickups, powerUps, and chests into items', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          weaponPickups: [
            ['wp1', createMockWeaponPickup({ id: 'wp1', x: 10, y: 20, tier: 'rare' })],
          ],
          powerUps: [['pu1', createMockPowerUp({ id: 'pu1', x: 30, y: 40, type: 'barrier' })]],
          chests: [['c1', createMockChest({ id: 'c1', x: 50, y: 60 })]],
        }),
      );

      expect(snapshot.activeItemCount).toBe(3);

      const wp = snapshot.getItemById('wp1')!;
      expect(wp.type).toBe('weapon');
      expect(wp.x).toBe(10);
      expect(wp.y).toBe(20);
      expect(wp.tier).toBe(2);
      expect(wp.weaponType).toBe(WeaponType.SHORT_SWORD); // BUG C: floor-weapon type surfaces for loadout fit
      expect(wp.powerUpType).toBeUndefined();

      const pu = snapshot.getItemById('pu1')!;
      expect(pu.type).toBe('powerup');
      expect(pu.tier).toBe(0);
      expect(pu.weaponType).toBeUndefined(); // powerups have no weaponType
      expect(pu.powerUpType).toBe('barrier');

      const chest = snapshot.getItemById('c1')!;
      expect(chest.type).toBe('powerup');
      expect(chest.tier).toBe(5);
      expect(chest.weaponType).toBeUndefined(); // chests have no weaponType
      expect(chest.powerUpType).toBeUndefined();
    });

    it('surfaces distinct weaponTypes for melee vs ranged floor weapons (loadout-fit)', () => {
      // Regression for BUG C: the bot must be able to tell a melee floor weapon
      // from a ranged one to fill a loadout gap (e.g. grab a sword when holding
      // only a bow). The weaponType must sync through to the ItemDTO.
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          weaponPickups: [
            ['melee', createMockWeaponPickup({ id: 'melee', weaponType: WeaponType.SHORT_SWORD })],
            ['ranged', createMockWeaponPickup({ id: 'ranged', weaponType: WeaponType.SHORT_BOW })],
          ],
        }),
      );
      expect(snapshot.getItemById('melee')!.weaponType).toBe(WeaponType.SHORT_SWORD);
      expect(snapshot.getItemById('ranged')!.weaponType).toBe(WeaponType.SHORT_BOW);
    });

    it('filters inactive weaponPickups', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          weaponPickups: [
            ['wp1', createMockWeaponPickup({ id: 'wp1', active: true })],
            ['wp2', createMockWeaponPickup({ id: 'wp2', active: false })],
          ],
        }),
      );

      expect(snapshot.activeItemCount).toBe(1);
      expect(snapshot.getItemById('wp1')).toBeDefined();
      expect(snapshot.getItemById('wp2')).toBeUndefined();
    });

    it('filters inactive powerUps', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          powerUps: [
            ['pu1', createMockPowerUp({ id: 'pu1', active: true })],
            ['pu2', createMockPowerUp({ id: 'pu2', active: false })],
          ],
        }),
      );

      expect(snapshot.activeItemCount).toBe(1);
      expect(snapshot.getItemById('pu1')).toBeDefined();
      expect(snapshot.getItemById('pu2')).toBeUndefined();
    });

    it('filters non-closed chests', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          chests: [
            ['c1', createMockChest({ id: 'c1', state: 'closed' })],
            ['c2', createMockChest({ id: 'c2', state: 'opening' })],
            ['c3', createMockChest({ id: 'c3', state: 'open' })],
          ],
        }),
      );

      expect(snapshot.activeItemCount).toBe(1);
      expect(snapshot.getItemById('c1')).toBeDefined();
      expect(snapshot.getItemById('c2')).toBeUndefined();
      expect(snapshot.getItemById('c3')).toBeUndefined();
    });
  });

  describe('sync - destructibles', () => {
    it('populates destructible DTOs with correct field values', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          destructibles: [
            [
              'd1',
              createMockDestructible({
                id: 'd1',
                x: 5,
                y: 10,
                type: 'crate',
                hp: 3,
                maxHp: 5,
                destroyed: false,
              }),
            ],
          ],
        }),
      );

      const dto = snapshot.getDestructibleById('d1')!;
      expect(dto.id).toBe('d1');
      expect(dto.x).toBe(5);
      expect(dto.y).toBe(10);
      expect(dto.type).toBe('crate');
      expect(dto.hp).toBe(3);
      expect(dto.maxHp).toBe(5);
      expect(dto.isDestroyed).toBe(false);
    });
  });

  describe('sync - traps', () => {
    it('populates trap DTOs with correct field values', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          traps: [['t1', createMockTrap({ id: 't1', x: 15, y: 25, type: 'FIRE' })]],
        }),
      );

      const dto = snapshot.getTrapById('t1')!;
      expect(dto.id).toBe('t1');
      expect(dto.x).toBe(15);
      expect(dto.y).toBe(25);
      expect(dto.type).toBe('FIRE');
    });

    it('coerces numeric trap types to string', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          traps: [['t1', createMockTrap({ id: 't1', type: 0 })]],
        }),
      );

      const dto = snapshot.getTrapById('t1')!;
      expect(dto.type).toBe('0');
    });
  });

  describe('sync - projectiles', () => {
    it('populates projectile DTOs with correct field values', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          projectiles: [
            ['proj1', createMockProjectile({ id: 'proj1', x: 7, y: 8, vx: 100, vy: -50 })],
          ],
        }),
      );

      const dto = snapshot.getProjectileById('proj1')!;
      expect(dto.id).toBe('proj1');
      expect(dto.x).toBe(7);
      expect(dto.y).toBe(8);
      expect(dto.velocityX).toBe(100);
      expect(dto.velocityY).toBe(-50);
    });
  });

  describe('forEachActivePlayer', () => {
    it('iterates exactly the active players', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
            ['p3', createMockPlayer({ id: 'p3' })],
          ],
        }),
      );

      const ids: string[] = [];
      snapshot.forEachActivePlayer((dto) => {
        ids.push(dto.id);
      });

      expect(ids).toEqual(['p1', 'p2', 'p3']);
    });

    it('iterates in domain Map insertion order', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['zebra', createMockPlayer({ id: 'zebra' })],
            ['alpha', createMockPlayer({ id: 'alpha' })],
            ['mango', createMockPlayer({ id: 'mango' })],
          ],
        }),
      );

      const ids: string[] = [];
      snapshot.forEachActivePlayer((dto) => {
        ids.push(dto.id);
      });

      expect(ids).toEqual(['zebra', 'alpha', 'mango']);
    });

    it('provides correct sequential indices', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
          ],
        }),
      );

      const indices: number[] = [];
      snapshot.forEachActivePlayer((_dto, index) => {
        indices.push(index);
      });

      expect(indices).toEqual([0, 1]);
    });
  });

  describe('queryPlayers (spatial grid)', () => {
    it('returns only players within range (O(local-density) perception)', () => {
      // The spatial grid converts bot perception from O(N²) (every bot × all
      // players) to O(N × local-density). This test pins that queryPlayers
      // returns only nearby players, not all active players.
      const snapshot = new WorldSnapshot();
      snapshot.setMapBounds(2048, 2048);
      snapshot.sync(
        makeMaps({
          players: [
            ['near1', createMockPlayer({ id: 'near1', x: 100, y: 100 })],
            ['near2', createMockPlayer({ id: 'near2', x: 200, y: 100 })],
            ['far', createMockPlayer({ id: 'far', x: 1800, y: 1800 })],
          ],
        }),
      );

      const ids: string[] = [];
      snapshot.queryPlayers(100, 100, 500, (dto) => {
        ids.push(dto.id);
      });

      // near1 + near2 are within 500px; far is not.
      expect(ids).toContain('near1');
      expect(ids).toContain('near2');
      expect(ids).not.toContain('far');
    });

    it('skips dead players (not indexed in the grid)', () => {
      const snapshot = new WorldSnapshot();
      snapshot.setMapBounds(2048, 2048);
      snapshot.sync(
        makeMaps({
          players: [
            ['alive', createMockPlayer({ id: 'alive', x: 100, y: 100, alive: true })],
            ['dead', createMockPlayer({ id: 'dead', x: 100, y: 100, alive: false })],
          ],
        }),
      );

      const ids: string[] = [];
      snapshot.queryPlayers(0, 0, 1000, (dto) => {
        ids.push(dto.id);
      });

      expect(ids).toContain('alive');
      expect(ids).not.toContain('dead');
    });

    it('is a no-op when setMapBounds was never called (grid undefined)', () => {
      // Backward-compat: if the snapshot was never given map bounds, the grid
      // is undefined and queryPlayers silently returns nothing (no throw).
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1', x: 0, y: 0 })]],
        }),
      );

      const ids: string[] = [];
      expect(() => {
        snapshot.queryPlayers(0, 0, 500, (dto) => ids.push(dto.id));
      }).not.toThrow();
      expect(ids).toEqual([]);
    });
  });

  describe('forEachActiveItem', () => {
    it('iterates items in domain order (weaponPickups, powerUps, chests)', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          weaponPickups: [['wp1', createMockWeaponPickup({ id: 'wp1' })]],
          powerUps: [['pu1', createMockPowerUp({ id: 'pu1' })]],
          chests: [['c1', createMockChest({ id: 'c1' })]],
        }),
      );

      const ids: string[] = [];
      snapshot.forEachActiveItem((dto) => {
        ids.push(dto.id);
      });

      expect(ids).toEqual(['wp1', 'pu1', 'c1']);
    });
  });

  describe('getById', () => {
    it('returns undefined for non-existent id', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({}));

      expect(snapshot.getPlayerById('nope')).toBeUndefined();
      expect(snapshot.getItemById('nope')).toBeUndefined();
      expect(snapshot.getDestructibleById('nope')).toBeUndefined();
      expect(snapshot.getTrapById('nope')).toBeUndefined();
      expect(snapshot.getProjectileById('nope')).toBeUndefined();
    });
  });

  describe('activeCount', () => {
    it('returns correct counts per entity type', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
          ],
          weaponPickups: [['wp1', createMockWeaponPickup({ id: 'wp1' })]],
          destructibles: [
            ['d1', createMockDestructible({ id: 'd1' })],
            ['d2', createMockDestructible({ id: 'd2' })],
            ['d3', createMockDestructible({ id: 'd3' })],
          ],
          traps: [['t1', createMockTrap({ id: 't1' })]],
          projectiles: [
            ['pr1', createMockProjectile({ id: 'pr1' })],
            ['pr2', createMockProjectile({ id: 'pr2' })],
          ],
        }),
      );

      expect(snapshot.activePlayerCount).toBe(2);
      expect(snapshot.activeItemCount).toBe(1);
      expect(snapshot.activeDestructibleCount).toBe(3);
      expect(snapshot.activeTrapCount).toBe(1);
      expect(snapshot.activeProjectileCount).toBe(2);
    });

    it('returns zero for empty world', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({}));

      expect(snapshot.activePlayerCount).toBe(0);
      expect(snapshot.activeItemCount).toBe(0);
      expect(snapshot.activeDestructibleCount).toBe(0);
      expect(snapshot.activeTrapCount).toBe(0);
      expect(snapshot.activeProjectileCount).toBe(0);
    });
  });

  describe('entity add lifecycle', () => {
    it('new entity appears in active list on next sync', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({ players: [['p1', createMockPlayer({ id: 'p1' })]] }));
      expect(snapshot.activePlayerCount).toBe(1);

      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
          ],
        }),
      );
      expect(snapshot.activePlayerCount).toBe(2);
      expect(snapshot.getPlayerById('p2')).toBeDefined();
    });

    it('new entity claims a free slot', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({ players: [['p1', createMockPlayer({ id: 'p1' })]] }));
      const dtoP1Tick1 = snapshot.getPlayerById('p1');

      snapshot.sync(makeMaps({}));
      expect(snapshot.getPlayerById('p1')).toBeUndefined();

      snapshot.sync(makeMaps({ players: [['p2', createMockPlayer({ id: 'p2' })]] }));
      const dtoP2Tick3 = snapshot.getPlayerById('p2');

      expect(dtoP2Tick3).toBeDefined();
      expect(dtoP2Tick3).toBe(dtoP1Tick1);
    });
  });

  describe('entity remove lifecycle', () => {
    it('removed entity excluded from active list', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
          ],
        }),
      );

      snapshot.sync(makeMaps({ players: [['p2', createMockPlayer({ id: 'p2' })]] }));

      expect(snapshot.activePlayerCount).toBe(1);
      expect(snapshot.getPlayerById('p1')).toBeUndefined();
      expect(snapshot.getPlayerById('p2')).toBeDefined();
    });

    it('removed item excluded when weaponPickup becomes inactive', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          weaponPickups: [
            ['wp1', createMockWeaponPickup({ id: 'wp1', active: true })],
            ['wp2', createMockWeaponPickup({ id: 'wp2', active: true })],
          ],
        }),
      );
      expect(snapshot.activeItemCount).toBe(2);

      snapshot.sync(
        makeMaps({
          weaponPickups: [
            ['wp1', createMockWeaponPickup({ id: 'wp1', active: true })],
            ['wp2', createMockWeaponPickup({ id: 'wp2', active: false })],
          ],
        }),
      );

      expect(snapshot.activeItemCount).toBe(1);
      expect(snapshot.getItemById('wp1')).toBeDefined();
      expect(snapshot.getItemById('wp2')).toBeUndefined();
    });

    it('removed item excluded when chest opens', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          chests: [['c1', createMockChest({ id: 'c1', state: 'closed' })]],
        }),
      );
      expect(snapshot.activeItemCount).toBe(1);

      snapshot.sync(
        makeMaps({
          chests: [['c1', createMockChest({ id: 'c1', state: 'open' })]],
        }),
      );

      expect(snapshot.activeItemCount).toBe(0);
      expect(snapshot.getItemById('c1')).toBeUndefined();
    });
  });

  describe('slot reuse', () => {
    it('freed slot is reused by new entity', () => {
      const snapshot = new WorldSnapshot();

      snapshot.sync(makeMaps({ players: [['A', createMockPlayer({ id: 'A' })]] }));
      const dtoA = snapshot.getPlayerById('A')!;

      snapshot.sync(makeMaps({ players: [] }));
      expect(snapshot.getPlayerById('A')).toBeUndefined();

      snapshot.sync(makeMaps({ players: [['B', createMockPlayer({ id: 'B' })]] }));
      const dtoB = snapshot.getPlayerById('B')!;

      expect(dtoB).toBe(dtoA);
      expect(dtoB.id).toBe('B');
    });

    it('multiple freed slots are reused by new entities', () => {
      const snapshot = new WorldSnapshot();

      snapshot.sync(
        makeMaps({
          players: [
            ['A', createMockPlayer({ id: 'A' })],
            ['B', createMockPlayer({ id: 'B' })],
            ['C', createMockPlayer({ id: 'C' })],
          ],
        }),
      );
      const dtoA = snapshot.getPlayerById('A')!;
      const dtoB = snapshot.getPlayerById('B')!;
      const dtoC = snapshot.getPlayerById('C')!;

      snapshot.sync(makeMaps({ players: [] }));

      snapshot.sync(
        makeMaps({
          players: [
            ['D', createMockPlayer({ id: 'D' })],
            ['E', createMockPlayer({ id: 'E' })],
          ],
        }),
      );

      const dtoD = snapshot.getPlayerById('D')!;
      const dtoE = snapshot.getPlayerById('E')!;

      expect(dtoD.id).toBe('D');
      expect(dtoE.id).toBe('E');
      expect([dtoA, dtoB, dtoC]).toContain(dtoD);
      expect([dtoA, dtoB, dtoC]).toContain(dtoE);
      expect(dtoD).not.toBe(dtoE);
    });
  });

  describe('reference stability', () => {
    it('same entity returns same DTO reference across multiple ticks', () => {
      const snapshot = new WorldSnapshot();
      const player = createMockPlayer({ id: 'p1', x: 100, y: 200 });

      snapshot.sync(makeMaps({ players: [['p1', player]] }));
      const ref1 = snapshot.getPlayerById('p1');

      snapshot.sync(makeMaps({ players: [['p1', player]] }));
      const ref2 = snapshot.getPlayerById('p1');

      snapshot.sync(makeMaps({ players: [['p1', player]] }));
      const ref3 = snapshot.getPlayerById('p1');

      expect(ref1).toBe(ref2);
      expect(ref2).toBe(ref3);
    });

    it('DTO fields update in place across ticks without changing reference', () => {
      const snapshot = new WorldSnapshot();

      snapshot.sync(
        makeMaps({ players: [['p1', createMockPlayer({ id: 'p1', x: 10, hp: 100 })]] }),
      );
      const ref1 = snapshot.getPlayerById('p1')!;
      expect(ref1.x).toBe(10);
      expect(ref1.health).toBe(100);

      snapshot.sync(
        makeMaps({ players: [['p1', createMockPlayer({ id: 'p1', x: 999, hp: 50 })]] }),
      );
      const ref2 = snapshot.getPlayerById('p1')!;

      expect(ref2).toBe(ref1);
      expect(ref2.x).toBe(999);
      expect(ref2.health).toBe(50);
    });

    it('forEachActivePlayer returns same references as getById', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [
            ['p1', createMockPlayer({ id: 'p1' })],
            ['p2', createMockPlayer({ id: 'p2' })],
          ],
        }),
      );

      const byId1 = snapshot.getPlayerById('p1');
      const byId2 = snapshot.getPlayerById('p2');

      snapshot.forEachActivePlayer((dto) => {
        if (dto.id === 'p1') expect(dto).toBe(byId1);
        if (dto.id === 'p2') expect(dto).toBe(byId2);
      });
    });

    it('weapon DTO references are stable across ticks', () => {
      const snapshot = new WorldSnapshot();

      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [{ type: WeaponType.FISTS, tier: 'common', ammo: -1 }],
              }),
            ],
          ],
        }),
      );
      const weaponRef1 = snapshot.getPlayerById('p1')!.weapons[0]!;

      snapshot.sync(
        makeMaps({
          players: [
            [
              'p1',
              createMockPlayer({
                id: 'p1',
                weapons: [{ type: WeaponType.FISTS, tier: 'common', ammo: -1 }],
              }),
            ],
          ],
        }),
      );
      const weaponRef2 = snapshot.getPlayerById('p1')!.weapons[0]!;

      expect(weaponRef1).toBe(weaponRef2);
    });
  });

  describe('multi-entity-type sync', () => {
    it('handles all entity types in a single sync', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1' })]],
          weaponPickups: [['wp1', createMockWeaponPickup({ id: 'wp1' })]],
          powerUps: [['pu1', createMockPowerUp({ id: 'pu1' })]],
          chests: [['c1', createMockChest({ id: 'c1' })]],
          destructibles: [['d1', createMockDestructible({ id: 'd1' })]],
          traps: [['t1', createMockTrap({ id: 't1' })]],
          projectiles: [['pr1', createMockProjectile({ id: 'pr1' })]],
        }),
      );

      expect(snapshot.activePlayerCount).toBe(1);
      expect(snapshot.activeItemCount).toBe(3);
      expect(snapshot.activeDestructibleCount).toBe(1);
      expect(snapshot.activeTrapCount).toBe(1);
      expect(snapshot.activeProjectileCount).toBe(1);
    });

    it('updates DTO fields across ticks for all types', () => {
      const snapshot = new WorldSnapshot();

      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1', x: 10 })]],
          projectiles: [['pr1', createMockProjectile({ id: 'pr1', x: 100 })]],
        }),
      );
      expect(snapshot.getPlayerById('p1')!.x).toBe(10);
      expect(snapshot.getProjectileById('pr1')!.x).toBe(100);

      snapshot.sync(
        makeMaps({
          players: [['p1', createMockPlayer({ id: 'p1', x: 500 })]],
          projectiles: [['pr1', createMockProjectile({ id: 'pr1', x: 900 })]],
        }),
      );
      expect(snapshot.getPlayerById('p1')!.x).toBe(500);
      expect(snapshot.getProjectileById('pr1')!.x).toBe(900);
    });
  });

  describe('forEachActive for all entity types', () => {
    it('forEachActiveDestructible iterates correctly', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          destructibles: [
            ['d1', createMockDestructible({ id: 'd1', hp: 5 })],
            ['d2', createMockDestructible({ id: 'd2', hp: 10 })],
          ],
        }),
      );

      const collected: DestructibleDTO[] = [];
      snapshot.forEachActiveDestructible((dto) => collected.push(dto));

      expect(collected).toHaveLength(2);
      expect(collected[0]!.id).toBe('d1');
      expect(collected[1]!.hp).toBe(10);
    });

    it('forEachActiveTrap iterates correctly', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          traps: [
            ['t1', createMockTrap({ id: 't1' })],
            ['t2', createMockTrap({ id: 't2' })],
          ],
        }),
      );

      const collected: TrapDTO[] = [];
      snapshot.forEachActiveTrap((dto) => collected.push(dto));

      expect(collected).toHaveLength(2);
    });

    it('forEachActiveProjectile iterates correctly', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(
        makeMaps({
          projectiles: [
            ['pr1', createMockProjectile({ id: 'pr1' })],
            ['pr2', createMockProjectile({ id: 'pr2' })],
            ['pr3', createMockProjectile({ id: 'pr3' })],
          ],
        }),
      );

      let count = 0;
      snapshot.forEachActiveProjectile(() => count++);

      expect(count).toBe(3);
    });
  });

  describe('DTO type shapes', () => {
    it('PlayerDTO has flattened fields and no nested position', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({ players: [['p1', createMockPlayer({ id: 'p1' })]] }));

      const dto = snapshot.getPlayerById('p1')!;
      const keys = Object.keys(dto);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
      expect(keys).not.toContain('position');
      expect(keys).toContain('velocityX');
      expect(keys).toContain('velocityY');
      expect(keys).toContain('facingAngle');
      expect(keys).toContain('isAlive');
      expect(keys).toContain('isBot');
    });

    it('ItemDTO has flattened fields', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({ weaponPickups: [['wp1', createMockWeaponPickup({ id: 'wp1' })]] }));

      const dto = snapshot.getItemById('wp1')!;
      const keys = Object.keys(dto);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
      expect(keys).not.toContain('position');
    });

    it('ProjectileDTO has flattened fields', () => {
      const snapshot = new WorldSnapshot();
      snapshot.sync(makeMaps({ projectiles: [['pr1', createMockProjectile({ id: 'pr1' })]] }));

      const dto = snapshot.getProjectileById('pr1')!;
      const keys = Object.keys(dto);
      expect(keys).toContain('x');
      expect(keys).toContain('y');
      expect(keys).toContain('velocityX');
      expect(keys).toContain('velocityY');
      expect(keys).not.toContain('position');
    });
  });

  describe('capacity bounds', () => {
    it('skips items beyond MAX_ITEMS without crashing', () => {
      const capacity = 512;
      const snapshot = new WorldSnapshot({ maxItems: capacity });
      const weaponPickups: Array<[string, unknown]> = Array.from(
        { length: capacity + 1 },
        (_, i) => [`wp${i}`, createMockWeaponPickup({ id: `wp${i}` })],
      );

      snapshot.sync(makeMaps({ weaponPickups }));

      expect(snapshot.activeItemCount).toBe(capacity);
      expect(snapshot.getItemById(`wp${capacity}`)).toBeUndefined();
    });

    it('skips items from combined sources beyond MAX_ITEMS without crashing', () => {
      const capacity = 512;
      const snapshot = new WorldSnapshot({ maxItems: capacity });
      const half = Math.floor(capacity / 2);
      const weaponPickups: Array<[string, unknown]> = Array.from({ length: half }, (_, i) => [
        `wp${i}`,
        createMockWeaponPickup({ id: `wp${i}` }),
      ]);
      const powerUps: Array<[string, unknown]> = Array.from(
        { length: capacity - half + 1 },
        (_, i) => [`pu${i}`, createMockPowerUp({ id: `pu${i}` })],
      );

      snapshot.sync(makeMaps({ weaponPickups, powerUps }));

      expect(snapshot.activeItemCount).toBe(capacity);
    });

    it('skips projectiles beyond MAX_PROJECTILES without crashing', () => {
      const capacity = 512;
      const snapshot = new WorldSnapshot({ maxProjectiles: capacity });
      const projectiles: Array<[string, unknown]> = Array.from({ length: capacity + 1 }, (_, i) => [
        `pr${i}`,
        createMockProjectile({ id: `pr${i}` }),
      ]);

      snapshot.sync(makeMaps({ projectiles }));

      expect(snapshot.activeProjectileCount).toBe(capacity);
      expect(snapshot.getProjectileById(`pr${capacity}`)).toBeUndefined();
    });
  });
});
