import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { logger } from '@sector-battle/shared';
import {
  TileType,
  type TileCollider,
  type TileSpriteDef,
  type TileVisual,
  type EnrichedMapData,
  type TiledMapLayer,
} from '@sector-battle/shared';
import { extractEntities } from './TmxEntityExtractor.ts';

function normalizeImagePath(path: string): string {
  const filename = path.split('/').pop() ?? '';
  return filename.replace(/\.[^.]+$/, '');
}

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const FLIP_MASK = FLIP_H | FLIP_V | FLIP_D;
const GID_MASK = ~FLIP_MASK & 0x1fffffff;

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

const TRAP_TYPE_MAP: Record<string, number> = {
  TRAP_SPIKE: 1,
  TRAP_FIRE: 2,
  TRAP_TELEPORT: 3,
};

interface DecodedGid {
  gid: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
}

function decodeGid(raw: number): DecodedGid {
  return {
    gid: raw & GID_MASK,
    flipH: (raw & FLIP_H) !== 0,
    flipV: (raw & FLIP_V) !== 0,
    flipD: (raw & FLIP_D) !== 0,
  };
}

interface TileTransform {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

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

interface ParsedTile {
  id: number;
  type: string;
  image: string;
  textureKey: string;
  colliders: TileCollider[];
}

interface ParsedTileset {
  firstGid: number;
  name: string;
  tileWidth: number;
  tileHeight: number;
  tilecount: number;
  tiles: Map<number, ParsedTile>;
}

interface ParsedLayer {
  name: string;
  width: number;
  height: number;
  data: (DecodedGid | null)[][];
}

interface TmxObject {
  '@_name'?: string;
  '@_x'?: string;
  '@_y'?: string;
  polygon?: { '@_points': string };
}

interface TmxObjectGroup {
  '@_name'?: string;
  object?: TmxObject | TmxObject[];
}

function arr<T>(val: T | T[] | undefined): T[] {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}

function parsePolygonPoints(
  pointsStr: string,
  offsetX: number,
  offsetY: number,
): Array<{ x: number; y: number }> {
  return pointsStr
    .split(' ')
    .filter((p) => p.includes(','))
    .map((pair) => {
      const parts = pair.split(',');
      return {
        x: parseFloat(parts[0] ?? '0') + offsetX,
        y: parseFloat(parts[1] ?? '0') + offsetY,
      };
    });
}

function parseTsx(filePath: string): ParsedTileset {
  const xml = readFileSync(filePath, 'utf-8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const ts = doc.tileset;

  const name: string = ts['@_name'] || '';
  const tileWidth = parseInt(ts['@_tilewidth'] || '128', 10);
  const tileHeight = parseInt(ts['@_tileheight'] || '128', 10);
  const tilecount = parseInt(ts['@_tilecount'] || '0', 10);
  const tiles = new Map<number, ParsedTile>();

  for (const tile of arr(ts.tile)) {
    const id = parseInt(tile['@_id'], 10);
    let tileType = '';
    for (const p of arr(tile.properties?.property)) {
      if (p['@_name'] === 'TYPE') tileType = p['@_value'] || '';
    }

    const imageSource: string = tile.image?.['@_source'] || '';
    const textureKey = normalizeImagePath(imageSource);
    const colliders: TileCollider[] = [];

    for (const og of arr(tile.objectgroup)) {
      for (const obj of arr(og.object)) {
        const ox = parseFloat(obj['@_x'] || '0');
        const oy = parseFloat(obj['@_y'] || '0');
        if (obj.polygon) {
          colliders.push({
            type: 'polygon',
            points: parsePolygonPoints(obj.polygon['@_points'], ox, oy),
          });
        } else {
          const ow = parseFloat(obj['@_width'] || '0');
          const oh = parseFloat(obj['@_height'] || '0');
          if (ow > 0 && oh > 0) {
            colliders.push({ type: 'rect', x: ox, y: oy, width: ow, height: oh });
          }
        }
      }
    }

    tiles.set(id, { id, type: tileType, image: imageSource, textureKey, colliders });
  }

  return { firstGid: 1, name, tileWidth, tileHeight, tilecount, tiles };
}

export class TmxParser {
  private tilesets: ParsedTileset[] = [];
  private mapWidth = 0;
  private mapHeight = 0;
  private tileWidth = 128;
  private tileHeight = 128;
  private spriteAtlas: TileSpriteDef[] = [];
  private spriteIdMap = new Map<number, number>();
  private weaponFirstGid = Infinity;

  parse(tmxPath: string): EnrichedMapData {
    const xml = readFileSync(tmxPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const doc = parser.parse(xml);
    const map = doc.map;

    this.mapWidth = parseInt(map['@_width'], 10);
    this.mapHeight = parseInt(map['@_height'], 10);
    this.tileWidth = parseInt(map['@_tilewidth'], 10);
    this.tileHeight = parseInt(map['@_tileheight'], 10);

    const tmxDir = dirname(tmxPath);
    this.tilesets = [];
    this.weaponFirstGid = Infinity;

    for (const tsRef of arr(map.tileset)) {
      const firstGid = parseInt(tsRef['@_firstgid'], 10);
      const source: string = tsRef['@_source'];
      const parsed = parseTsx(resolve(tmxDir, source));
      parsed.firstGid = firstGid;
      this.tilesets.push(parsed);
      if (parsed.name === 'weapons') this.weaponFirstGid = firstGid;
    }

    this.buildAtlas();

    const layers = arr(map.layer).map((l) => this.parseLayer(l));
    const spawnPoints = this.parseObjectLayers(map);

    return this.buildEnrichedMapData(layers, spawnPoints);
  }

  private buildAtlas(): void {
    this.spriteAtlas = [];
    this.spriteIdMap.clear();

    for (const ts of this.tilesets) {
      // The weapons tileset's authored collision boxes would type its sprites
      // as INDESTRUCTIBLE_WALL via resolveTileType's hasColliders default.
      // Ground weapons are entity pickups, never tile collision — strip the
      // colliders so the merged collision atlas cannot resolve a weapon tile
      // as solid (mirrors the SeedMapAdapter weapons-atlas merge).
      const isWeaponTileset = ts.name === 'weapons';
      for (let id = 0; id < ts.tilecount; id++) {
        const gid = ts.firstGid + id;
        const spriteId = this.spriteAtlas.length;
        this.spriteIdMap.set(gid, spriteId);

        const tile = ts.tiles.get(id);
        this.spriteAtlas.push({
          id: spriteId,
          imagePath: tile?.textureKey ?? '',
          tileType: tile
            ? this.resolveTileType(tile.type, tile.colliders.length > 0)
            : TileType.EMPTY,
          colliders: isWeaponTileset ? [] : (tile?.colliders ?? []),
        });
      }
    }
  }

  private resolveTileType(typeStr: string, hasColliders: boolean): TileType {
    if (TILE_TYPE_MAP[typeStr]) return TILE_TYPE_MAP[typeStr];
    if (hasColliders) return TileType.INDESTRUCTIBLE_WALL;
    return TileType.EMPTY;
  }

  private parseLayer(layer: Record<string, unknown>): ParsedLayer {
    const name = layer['@_name'] as string;
    const width = parseInt(layer['@_width'] as string, 10);
    const height = parseInt(layer['@_height'] as string, 10);

    const data = layer.data as Record<string, unknown>;
    const csv = (data['#text'] as string).trim();
    const values = csv.split(',').map((v) => parseInt(v.trim(), 10));

    const grid: (DecodedGid | null)[][] = [];
    for (let y = 0; y < height; y++) {
      const row: (DecodedGid | null)[] = [];
      for (let x = 0; x < width; x++) {
        const raw = values[y * width + x];
        row.push(raw === 0 ? null : decodeGid(raw!));
      }
      grid.push(row);
    }

    return { name, width, height, data: grid };
  }

  private parseObjectLayers(map: Record<string, unknown>): { gridX: number; gridY: number }[] {
    const spawns: { gridX: number; gridY: number }[] = [];

    for (const og of arr<TmxObjectGroup>(
      map.objectgroup as TmxObjectGroup | TmxObjectGroup[] | undefined,
    )) {
      if (og['@_name'] !== 'spawns') continue;
      for (const obj of arr(og.object)) {
        if (obj['@_name'] === 'Player_spawn') {
          spawns.push({
            gridX: Math.floor(parseFloat(obj['@_x'] || '0') / this.tileWidth),
            gridY: Math.floor(parseFloat(obj['@_y'] || '0') / this.tileHeight),
          });
        }
      }
    }

    return spawns;
  }

  private getTileForGid(gid: number): ParsedTile | null {
    for (const ts of this.tilesets) {
      const localId = gid - ts.firstGid;
      if (localId >= 0 && localId < ts.tilecount && ts.tiles.has(localId)) {
        return ts.tiles.get(localId)!;
      }
    }
    return null;
  }

  private getTileTypeForGid(gid: number): TileType {
    const tile = this.getTileForGid(gid);
    if (tile) return this.resolveTileType(tile.type, tile.colliders.length > 0);
    return TileType.EMPTY;
  }

  private debugTiles: Set<string> = new Set(['15,13', '11,15', '12,3']);

  private logTileDebug(
    label: string,
    x: number,
    y: number,
    raw: DecodedGid,
    spriteId: number,
    tf: TileTransform,
  ): void {
    if (!this.debugTiles.has(`${x},${y}`)) return;
    const tile = this.getTileForGid(raw.gid);
    logger.debug(
      `${label} (${x},${y}): rawGid=${raw.gid} flipH=${raw.flipH} flipV=${raw.flipV} flipD=${raw.flipD} → rotation=${tf.rotation} flipH=${tf.flipH} flipV=${tf.flipV} spriteId=${spriteId} image=${tile?.textureKey ?? 'N/A'} tileType=${tile?.type ?? 'N/A'}`,
    );
    if (tile && tile.colliders.length > 0) {
      for (const c of tile.colliders) {
        logger.debug(
          `  collider: ${c.type} ${c.type === 'rect' ? `x=${c.x} y=${c.y} w=${c.width} h=${c.height}` : `points=${JSON.stringify(c.points)}`}`,
        );
      }
    }
  }

  private buildEnrichedMapData(
    layers: ParsedLayer[],
    spawnPoints: { gridX: number; gridY: number }[],
  ): EnrichedMapData {
    const grid: TileType[][] = [];
    for (let y = 0; y < this.mapHeight; y++) {
      grid.push(Array(this.mapWidth).fill(TileType.EMPTY));
    }

    for (const layer of layers) {
      for (let y = 0; y < this.mapHeight; y++) {
        for (let x = 0; x < this.mapWidth; x++) {
          const cell = layer.data[y]?.[x];
          if (!cell || cell.gid === 0) continue;
          if (layer.name === 'interactive_layer') {
            if (cell.gid >= this.weaponFirstGid) continue;
            const tile = this.getTileForGid(cell.gid);
            if (tile && TRAP_TYPE_MAP[tile.type] !== undefined) continue;
          }
          grid[y]![x] = this.getTileTypeForGid(cell.gid);
        }
      }
    }

    const visualLayers: TiledMapLayer[] = layers.map((layer) => {
      const cells: (TileVisual | null)[][] = [];
      for (let y = 0; y < this.mapHeight; y++) {
        const row: (TileVisual | null)[] = [];
        for (let x = 0; x < this.mapWidth; x++) {
          const cell = layer.data[y]?.[x];
          if (!cell || cell.gid === 0) {
            row.push(null);
            continue;
          }
          const tf = computeTileTransform(cell.flipH, cell.flipV, cell.flipD);
          const spriteId = this.spriteIdMap.get(cell.gid) ?? -1;
          this.logTileDebug(layer.name, x, y, cell, spriteId, tf);
          row.push({
            spriteId,
            rotation: tf.rotation,
            flipH: tf.flipH,
            flipV: tf.flipV,
          });
        }
        cells.push(row);
      }
      return { name: layer.name, cells };
    });

    return {
      grid,
      visualLayers,
      atlas: { sprites: this.spriteAtlas },
      width: this.mapWidth,
      height: this.mapHeight,
      tileSize: this.tileWidth,
      seed: 0,
      entities: extractEntities(
        layers,
        spawnPoints,
        this.mapHeight,
        this.mapWidth,
        this.weaponFirstGid,
        this.tilesets,
      ),
    };
  }
}
