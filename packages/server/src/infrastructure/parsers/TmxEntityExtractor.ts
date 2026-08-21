import {
  TileType,
  TrapType,
  WeaponType,
  type TiledEntityPlacements,
  type WeaponPlacement,
  type TrapPlacementTiled,
  type DestructiblePlacement,
  type ChestPlacement,
  type ExitPlacement,
} from '@sector-battle/shared';

const TILE_TYPE_MAP: Record<string, TileType> = {
  DESTRUCTIBLE_BARREL: TileType.DESTRUCTIBLE_BARREL,
  DESTRUCTIBLE_CRATE: TileType.DESTRUCTIBLE_CRATE,
  CHEST: TileType.CHEST,
  INDESTRUCTIBLE_CRATE: TileType.INDESTRUCTIBLE_CRATE,
  INDESTRUCTIBLE_WALL: TileType.INDESTRUCTIBLE_WALL,
  DESTRUCTIBLE_WALL: TileType.DESTRUCTIBLE_WALL,
  EXIT: TileType.EXIT,
  DOOR_CLOSED: TileType.DOOR_CLOSED,
};

const TRAP_TYPE_MAP: Record<string, TrapType> = {
  TRAP_SPIKE: TrapType.SPIKE,
  TRAP_FIRE: TrapType.FIRE,
  TRAP_TELEPORT: TrapType.TELEPORT,
};

const WEAPON_IMAGE_MAP: Record<string, WeaponType> = {
  shield_curved: WeaponType.SMALL_SHIELD,
  shield_straight: WeaponType.LARGE_SHIELD,
  weapon_axe: WeaponType.THROWING_AXE,
  weapon_axe_blades: WeaponType.BLADED_AXE,
  weapon_axe_double: WeaponType.DOUBLE_AXE,
  weapon_axe_large: WeaponType.LARGE_AXE,
  weapon_bow: WeaponType.SHORT_BOW,
  weapon_bow_arrow: WeaponType.CROSSBOW,
  weapon_dagger: WeaponType.DAGGER,
  weapon_hammer: WeaponType.HAMMER,
  weapon_longsword: WeaponType.LONG_SWORD,
  weapon_pole: WeaponType.POLEARM,
  weapon_spear: WeaponType.SPEAR,
  weapon_staff: WeaponType.STAFF,
  weapon_sword: WeaponType.SHORT_SWORD,
};

interface DecodedGid {
  gid: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
}

interface ParsedTile {
  id: number;
  type: string;
  image: string;
  textureKey: string;
}

interface TileTransform {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

interface ParsedTileset {
  firstGid: number;
  name: string;
  tilecount: number;
  tiles: Map<number, ParsedTile>;
}

interface ParsedLayer {
  name: string;
  data: (DecodedGid | null)[][];
}

export type { DecodedGid, ParsedTile, TileTransform, ParsedTileset, ParsedLayer };

function computeTileTransform(flipH: boolean, flipV: boolean, flipD: boolean): TileTransform {
  if (flipH && flipV && flipD) return { rotation: 90, flipH: true, flipV: false };
  if (flipH && flipV) return { rotation: 180, flipH: false, flipV: false };
  if (flipH && flipD) return { rotation: 90, flipH: false, flipV: false };
  if (flipV && flipD) return { rotation: 270, flipH: false, flipV: false };
  if (flipH) return { rotation: 0, flipH: true, flipV: false };
  if (flipV) return { rotation: 0, flipH: false, flipV: true };
  if (flipD) return { rotation: 90, flipH: false, flipV: true };
  return { rotation: 0, flipH: false, flipV: false };
}

function getTileForGid(tilesets: ParsedTileset[], gid: number): ParsedTile | null {
  for (const ts of tilesets) {
    const localId = gid - ts.firstGid;
    if (localId >= 0 && localId < ts.tilecount && ts.tiles.has(localId)) {
      return ts.tiles.get(localId)!;
    }
  }
  return null;
}

export function extractEntities(
  layers: ParsedLayer[],
  spawnPoints: { gridX: number; gridY: number }[],
  mapHeight: number,
  mapWidth: number,
  weaponFirstGid: number,
  tilesets: ParsedTileset[],
): TiledEntityPlacements {
  const weapons: WeaponPlacement[] = [];
  const traps: TrapPlacementTiled[] = [];
  const destructibles: DestructiblePlacement[] = [];
  const chests: ChestPlacement[] = [];
  const exits: ExitPlacement[] = [];

  for (const layer of layers) {
    if (layer.name !== 'interactive_layer') continue;

    for (let y = 0; y < mapHeight; y++) {
      for (let x = 0; x < mapWidth; x++) {
        const cell = layer.data[y]?.[x];
        if (!cell || cell.gid === 0) continue;

        if (cell.gid >= weaponFirstGid) {
          const tile = getTileForGid(tilesets, cell.gid);
          if (!tile) continue;
          const weaponType = WEAPON_IMAGE_MAP[tile.textureKey];
          if (weaponType !== undefined) {
            const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
            weapons.push({
              gridX: x,
              gridY: y,
              weaponType,
              textureKey: tile.textureKey,
              rotation: tf.rotation,
              flipH: tf.flipH,
              flipV: tf.flipV,
            });
          }
          continue;
        }

        const tile = getTileForGid(tilesets, cell.gid);
        if (!tile) continue;

        if (tile.type.startsWith('TRAP_')) {
          const trapType = TRAP_TYPE_MAP[tile.type];
          if (trapType !== undefined) {
            const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
            traps.push({
              gridX: x,
              gridY: y,
              trapType,
              textureKey: tile.textureKey,
              rotation: tf.rotation,
              flipH: tf.flipH,
              flipV: tf.flipV,
            });
          }
          continue;
        }

        if (tile.type === 'CHEST') {
          const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
          chests.push({
            gridX: x,
            gridY: y,
            textureKey: tile.textureKey,
            rotation: tf.rotation,
            flipH: tf.flipH,
            flipV: tf.flipV,
          });
          continue;
        }

        if (tile.type.startsWith('DESTRUCTIBLE_')) {
          const tileType = TILE_TYPE_MAP[tile.type];
          if (tileType !== undefined) {
            const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
            destructibles.push({
              gridX: x,
              gridY: y,
              tileType,
              textureKey: tile.textureKey,
              rotation: tf.rotation,
              flipH: tf.flipH,
              flipV: tf.flipV,
            });
          }
          continue;
        }

        if (tile.type === 'INDESTRUCTIBLE_CRATE') {
          const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
          destructibles.push({
            gridX: x,
            gridY: y,
            tileType: TileType.INDESTRUCTIBLE_CRATE,
            textureKey: tile.textureKey,
            rotation: tf.rotation,
            flipH: tf.flipH,
            flipV: tf.flipV,
          });
          continue;
        }

        if (tile.type === 'INDESTRUCTIBLE_WALL') {
          const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
          destructibles.push({
            gridX: x,
            gridY: y,
            tileType: TileType.INDESTRUCTIBLE_WALL,
            textureKey: tile.textureKey,
            rotation: tf.rotation,
            flipH: tf.flipH,
            flipV: tf.flipV,
          });
          continue;
        }

        if (tile.type === 'EXIT') {
          const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
          exits.push({
            gridX: x,
            gridY: y,
            textureKey: tile.textureKey,
            rotation: tf.rotation,
            flipH: tf.flipH,
            flipV: tf.flipV,
          });
          continue;
        }
      }
    }
  }

  return {
    weapons,
    spawnPoints: spawnPoints.length > 0 ? spawnPoints : [{ gridX: 11, gridY: 11 }],
    traps,
    destructibles,
    chests,
    powerups: [],
    exits,
    // TMX-driven maps do not emit light placements (those come from the
    // deterministic LightPlacer on the seed-map path). Initialized empty.
    lightPlacements: [],
  };
}
