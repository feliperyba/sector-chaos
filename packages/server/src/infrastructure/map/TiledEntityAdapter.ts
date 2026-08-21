import {
  TileType,
  TrapType,
  WeaponType,
  SeededRNG,
  TILE_PIXEL_SIZE,
  type TileSpriteDef,
  type TileVisual,
  type MapData,
  type TiledEntityPlacements,
} from '@sector-battle/shared';
import { WEAPON_IMAGE_MAP, ENTITY_TYPE_TO_TILE_TYPE, type SpriteLookup } from './AtlasParser.js';

// ── adapter ───────────────────────────────────────────────────────────────────

export class TiledEntityAdapter {
  /**
   * Place interactive entities from Tiled data onto the visual layer.
   * Handles destructibles (crates, barrels), chests, weapons, traps, exits, and powerups.
   */
  placeEntities(
    grid: TileType[][],
    mapData: MapData,
    lookup: SpriteLookup,
    weaponOffset: number,
    rng: SeededRNG,
  ): { cells: (TileVisual | null)[][]; entities: TiledEntityPlacements } {
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    // Initialize all cells to null
    const cells: (TileVisual | null)[][] = Array.from({ length: height }, () =>
      Array(width).fill(null),
    );

    const entities: TiledEntityPlacements = {
      weapons: [],
      spawnPoints: [],
      traps: [],
      destructibles: [],
      chests: [],
      powerups: [],
      exits: [],
      lightPlacements: [],
    };

    // Set spawn points from all spawns
    entities.spawnPoints = mapData.spawnPoints.map((sp) => ({
      gridX: Math.floor(sp.x / TILE_PIXEL_SIZE),
      gridY: Math.floor(sp.y / TILE_PIXEL_SIZE),
    }));
    if (entities.spawnPoints.length === 0) {
      entities.spawnPoints = [{ gridX: 11, gridY: 11 }];
    }

    this.placeDestructibles(mapData, grid, lookup, rng, cells, entities);
    this.placeLoot(mapData, grid, lookup, weaponOffset, rng, cells, entities);
    this.placeTraps(mapData, grid, lookup, rng, cells, entities);
    this.placeExits(mapData, grid, lookup, rng, cells, entities);

    return { cells, entities };
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private placeDestructibles(
    mapData: MapData,
    grid: TileType[][],
    lookup: SpriteLookup,
    rng: SeededRNG,
    cells: (TileVisual | null)[][],
    entities: TiledEntityPlacements,
  ): void {
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    for (const ep of mapData.entityPlacements) {
      const gridX = Math.floor(ep.position.x / TILE_PIXEL_SIZE);
      const gridY = Math.floor(ep.position.y / TILE_PIXEL_SIZE);

      if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

      const tileType = ENTITY_TYPE_TO_TILE_TYPE[ep.entityType];
      if (tileType === undefined) continue;

      let spriteList: TileSpriteDef[];
      switch (ep.entityType) {
        case 'CRATE':
          spriteList = lookup.crate;
          break;
        case 'BARREL':
          spriteList = lookup.barrel;
          break;
        default:
          continue;
      }

      const sprite =
        spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;

      if (!sprite) continue;

      const rotation: 0 | 90 | 180 | 270 = 0;
      const flipH = false;
      const flipV = false;

      // Place in interactive layer
      if (gridY < cells.length && gridX < (cells[gridY]?.length ?? 0)) {
        cells[gridY]![gridX] = {
          spriteId: sprite.id,
          rotation,
          flipH,
          flipV,
        };
      }

      entities.destructibles.push({
        gridX,
        gridY,
        tileType,
        textureKey: sprite.imagePath,
        rotation,
        flipH,
        flipV,
      });
    }
  }

  private placeLoot(
    mapData: MapData,
    grid: TileType[][],
    lookup: SpriteLookup,
    _weaponOffset: number,
    rng: SeededRNG,
    cells: (TileVisual | null)[][],
    entities: TiledEntityPlacements,
  ): void {
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    for (const lp of mapData.lootPlacements) {
      const gridX = Math.floor(lp.position.x / TILE_PIXEL_SIZE);
      const gridY = Math.floor(lp.position.y / TILE_PIXEL_SIZE);

      if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

      if (lp.type === 'CHEST') {
        const spriteList = lookup.chest;
        const sprite =
          spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;

        if (!sprite) continue;

        cells[gridY]![gridX] = {
          spriteId: sprite.id,
          rotation: 0,
          flipH: false,
          flipV: false,
        };

        entities.chests.push({
          gridX,
          gridY,
          textureKey: sprite.imagePath,
          rotation: 0,
          flipH: false,
          flipV: false,
        });
      } else if (lp.type === 'WEAPON_SPAWN') {
        // Pick a random weapon sprite from the weapons atlas
        const weaponKeys = Array.from(lookup.weaponSprites.keys());
        if (weaponKeys.length === 0) continue;

        const weaponKey = weaponKeys[rng.nextInt(0, weaponKeys.length - 1)]!;
        const sprite = lookup.weaponSprites.get(weaponKey)!;
        const weaponType = WEAPON_IMAGE_MAP[weaponKey] ?? WeaponType.SHORT_SWORD;

        cells[gridY]![gridX] = {
          spriteId: sprite.id,
          rotation: 0,
          flipH: false,
          flipV: false,
        };

        entities.weapons.push({
          gridX,
          gridY,
          weaponType,
          textureKey: sprite.imagePath,
          rotation: 0,
          flipH: false,
          flipV: false,
        });
      } else if (lp.type === 'POWERUP_SPAWN') {
        // Powerups rendered dynamically by client — placeholder sprite
        entities.powerups.push({
          gridX,
          gridY,
          textureKey: 'puddle', // placeholder until dedicated sprites
          rotation: 0,
          flipH: false,
          flipV: false,
        });
      }
    }
  }

  private placeTraps(
    mapData: MapData,
    grid: TileType[][],
    lookup: SpriteLookup,
    rng: SeededRNG,
    cells: (TileVisual | null)[][],
    entities: TiledEntityPlacements,
  ): void {
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    for (const tp of mapData.trapPlacements) {
      const gridX = Math.floor(tp.position.x / TILE_PIXEL_SIZE);
      const gridY = Math.floor(tp.position.y / TILE_PIXEL_SIZE);

      if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

      let spriteList: TileSpriteDef[];
      switch (tp.trapType) {
        case TrapType.SPIKE:
          spriteList = lookup.trap_spike;
          break;
        case TrapType.FIRE:
          spriteList = lookup.trap_fire;
          break;
        case TrapType.TELEPORT:
          spriteList = lookup.trap_teleport;
          break;
        default:
          spriteList = lookup.trap_spike;
      }

      const sprite =
        spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;

      if (!sprite) continue;

      cells[gridY]![gridX] = {
        spriteId: sprite.id,
        rotation: 0,
        flipH: false,
        flipV: false,
      };

      entities.traps.push({
        gridX,
        gridY,
        trapType: tp.trapType,
        textureKey: sprite.imagePath,
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }
  }

  private placeExits(
    mapData: MapData,
    grid: TileType[][],
    lookup: SpriteLookup,
    rng: SeededRNG,
    cells: (TileVisual | null)[][],
    entities: TiledEntityPlacements,
  ): void {
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    for (const ex of mapData.exits) {
      const gridX = Math.floor(ex.position.x / TILE_PIXEL_SIZE);
      const gridY = Math.floor(ex.position.y / TILE_PIXEL_SIZE);

      if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

      const spriteList = lookup.exit;
      const sprite =
        spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;

      if (!sprite) continue;

      cells[gridY]![gridX] = {
        spriteId: sprite.id,
        rotation: 0,
        flipH: false,
        flipV: false,
      };

      entities.exits.push({
        gridX,
        gridY,
        textureKey: sprite.imagePath,
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }
  }
}
