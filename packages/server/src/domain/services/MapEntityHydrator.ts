import {
  TileType,
  ChestRarity,
  TrapType,
  WeaponType,
  WeaponTier,
  DURABILITY_BY_TIER,
  SeededRNG,
  weaponRegistry,
} from '@sector-battle/shared';
import { Chest } from '../entities/Chest.ts';
import { Destructible, type DestructibleType } from '../entities/Destructible.ts';
import { Trap } from '../entities/Trap.ts';
import { WeaponPickup } from '../entities/WeaponPickup.ts';
import { WeaponEntity } from '../entities/Weapon.ts';
import { Position } from '../value-objects/Position.ts';
import { simRandom } from '../shared/SimRandom.ts';
import type { MapResult } from './MapGenerator.ts';
import { logger } from '@sector-battle/shared';

export interface HydrationResult {
  chestCount: number;
  destructibleCounts: { crate: number; barrel: number; wall: number };
  trapCount: number;
  weaponPickupCount: number;
  warnings: number;
}

interface EntityFactories {
  createChest: (id: string, tier: ChestRarity, position: Position, textureKey?: string) => Chest;
  createDestructible: (
    id: string,
    type: DestructibleType,
    position: Position,
    textureKey?: string,
  ) => Destructible;
  createTrap: (id: string, type: TrapType, position: Position, textureKey?: string) => Trap;
  createWeaponPickup: (
    id: string,
    weapon: WeaponEntity,
    position: Position,
    spawnTick: number,
    textureKey?: string,
  ) => WeaponPickup;
}

const DEFAULT_FACTORIES: EntityFactories = {
  createChest: (id, tier, pos, textureKey) => Chest.create(id, tier, pos, textureKey ?? ''),
  createDestructible: (id, type, pos, textureKey) =>
    Destructible.create(id, type, pos, textureKey ?? ''),
  createTrap: (id, type, pos, textureKey) => Trap.create(id, type, pos, textureKey ?? ''),
  createWeaponPickup: (id, weapon, pos, spawnTick, textureKey) =>
    WeaponPickup.create(id, weapon, pos, spawnTick, textureKey ?? ''),
};

const TRAP_TYPES: TrapType[] = [TrapType.SPIKE, TrapType.FIRE, TrapType.TELEPORT];

const GROUND_WEAPON_TYPES: WeaponType[] = weaponRegistry.getSpawnableTypes();

const WEAPON_COOLDOWN_TICKS = 30;

export class MapEntityHydrator {
  private readonly grid: TileType[][];
  private readonly tileSize: number;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly rng: SeededRNG;
  private readonly warnings: number[] = [];
  private readonly usedIds: Set<string> = new Set();
  private readonly factories: EntityFactories;

  constructor(
    mapResult: MapResult,
    tileSize: number,
    factories?: Partial<EntityFactories>,
    seed?: number,
  ) {
    this.grid = mapResult.grid;
    this.tileSize = tileSize;
    this.mapHeight = mapResult.grid.length;
    this.mapWidth = mapResult.grid[0]?.length ?? 0;
    this.factories = { ...DEFAULT_FACTORIES, ...factories };
    this.rng = new SeededRNG(seed ?? 0);
  }

  hydrate(mapResult: MapResult): {
    chests: Chest[];
    destructibles: Destructible[];
    traps: Trap[];
    weaponPickups: WeaponPickup[];
  } {
    const chests = this.hydrateChests(mapResult.chestPlacements);
    const destructibles = this.hydrateDestructibles(mapResult.destructiblePlacements);
    const traps = this.hydrateTraps(mapResult.trapPlacements);
    const weaponPickups = this.hydrateWeaponPickups(mapResult.weaponSpawnPlacements);

    return { chests, destructibles, traps, weaponPickups };
  }

  computeResult(
    chests: Chest[],
    destructibles: Destructible[],
    traps: Trap[],
    weaponPickups: WeaponPickup[],
  ): HydrationResult {
    const destructibleCounts = { crate: 0, barrel: 0, wall: 0 };
    for (const d of destructibles) {
      if (d.type in destructibleCounts) {
        destructibleCounts[d.type as keyof typeof destructibleCounts]++;
      }
    }
    return {
      chestCount: chests.length,
      destructibleCounts,
      trapCount: traps.length,
      weaponPickupCount: weaponPickups.length,
      warnings: this.warnings.length,
    };
  }

  private hydrateChests(
    placements: Array<{
      gridX: number;
      gridY: number;
      tier: ChestRarity;
      textureKey?: string;
    }>,
  ): Chest[] {
    const chests: Chest[] = [];
    for (const placement of placements) {
      const row = placement.gridY;
      const col = placement.gridX;
      if (this.isOverlappingWall(row, col)) {
        this.warnings.push(row * this.mapWidth + col);
        logger.warn(`Skipping chest at (${col},${row}) — overlaps wall`);
        continue;
      }
      const id = this.generateId('chest', row, col);
      // Tier is authored by map generation (single source of truth, DEC-003.1):
      // a chest placed as RARE by the generator hydrates — and opens — as RARE.
      // No re-roll here.
      const position = this.tileToWorld(row, col);
      chests.push(this.factories.createChest(id, placement.tier, position, placement.textureKey));
    }
    return chests;
  }

  private hydrateDestructibles(
    destructiblePlacements?: Array<{
      gridX: number;
      gridY: number;
      tileType: TileType;
      textureKey: string;
      rotation?: number;
    }>,
  ): Destructible[] {
    const textureMap = new Map<string, string>();
    if (destructiblePlacements) {
      for (const p of destructiblePlacements) {
        textureMap.set(`${p.gridY},${p.gridX}`, p.textureKey);
      }
    }

    const destructibles: Destructible[] = [];
    for (let row = 0; row < this.mapHeight; row++) {
      for (let col = 0; col < this.mapWidth; col++) {
        const tile = this.grid[row]![col]!;
        const type = this.tileToDestructibleType(tile);
        if (!type) continue;
        const id = this.generateId(`dest_${type}`, row, col);
        const position = this.tileToWorld(row, col);
        const textureKey = textureMap.get(`${row},${col}`);
        destructibles.push(this.factories.createDestructible(id, type, position, textureKey));
      }
    }
    return destructibles;
  }

  private hydrateTraps(
    placements: Array<{ gridX: number; gridY: number; trapType?: TrapType; textureKey?: string }>,
  ): Trap[] {
    const traps: Trap[] = [];
    for (const placement of placements) {
      const row = placement.gridY;
      const col = placement.gridX;
      if (this.isOverlappingWall(row, col)) {
        this.warnings.push(row * this.mapWidth + col);
        logger.warn(`Skipping trap at (${col},${row}) — overlaps wall`);
        continue;
      }
      const id = this.generateId('trap', row, col);
      const type = placement.trapType ?? TRAP_TYPES[this.rng.nextInt(0, TRAP_TYPES.length - 1)]!;
      const position = this.tileToWorld(row, col);
      traps.push(this.factories.createTrap(id, type, position, placement.textureKey));
    }
    return traps;
  }

  private hydrateWeaponPickups(
    placements: Array<{
      gridX: number;
      gridY: number;
      tier: WeaponTier;
      weaponType?: WeaponType;
      textureKey?: string;
    }>,
  ): WeaponPickup[] {
    const pickups: WeaponPickup[] = [];
    for (const placement of placements) {
      const row = placement.gridY;
      const col = placement.gridX;
      const id = this.generateId('wpn', row, col);
      const position = this.tileToWorld(row, col);
      const weaponType =
        placement.weaponType ??
        GROUND_WEAPON_TYPES[
          Math.floor(simRandom('ground-weapon-type') * GROUND_WEAPON_TYPES.length)
        ]!;
      const durability = DURABILITY_BY_TIER[placement.tier];
      const weapon = new WeaponEntity(
        `wpn_ent_${row}_${col}`,
        weaponType,
        placement.tier,
        durability,
        durability,
        WEAPON_COOLDOWN_TICKS,
      );
      pickups.push(
        this.factories.createWeaponPickup(id, weapon, position, 0, placement.textureKey),
      );
    }
    return pickups;
  }

  private tileToDestructibleType(tile: TileType): DestructibleType | null {
    switch (tile) {
      case TileType.DESTRUCTIBLE_CRATE:
        return 'crate';
      case TileType.DESTRUCTIBLE_BARREL:
        return 'barrel';
      case TileType.DESTRUCTIBLE_WALL:
        return 'wall';
      default:
        return null;
    }
  }

  private isOverlappingWall(row: number, col: number): boolean {
    if (row < 0 || row >= this.mapHeight || col < 0 || col >= this.mapWidth) return true;
    const tile = this.grid[row]![col]!;
    return tile === TileType.INDESTRUCTIBLE_WALL;
  }

  private tileToWorld(row: number, col: number): Position {
    return new Position(
      col * this.tileSize + this.tileSize / 2,
      row * this.tileSize + this.tileSize / 2,
    );
  }

  private generateId(prefix: string, row: number, col: number): string {
    let id = `${prefix}_${row}_${col}`;
    let counter = 1;
    while (this.usedIds.has(id)) {
      id = `${prefix}_${row}_${col}_${counter}`;
      counter++;
    }
    this.usedIds.add(id);
    return id;
  }
}
