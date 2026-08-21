import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '@sector-battle/shared';
import {
  TileType,
  type TileCollider,
  type TileSpriteAtlas,
  type TileSpriteDef,
} from '@sector-battle/shared';

// ── helpers (mirrors TmxParser) ──────────────────────────────────────────────

function arr<T>(val: T | T[] | undefined): T[] {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}

function normalizeImagePath(path: string): string {
  const filename = path.split('/').pop() ?? '';
  return filename.replace(/\.[^.]+$/, '');
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

const TILE_TYPE_MAP: Record<string, TileType> = {
  EMPTY: TileType.EMPTY,
  INDESTRUCTIBLE_WALL: TileType.INDESTRUCTIBLE_WALL,
  DESTRUCTIBLE_WALL: TileType.DESTRUCTIBLE_WALL,
  CHEST: TileType.CHEST,
  EXIT: TileType.EXIT,
  DOOR_CLOSED: TileType.DOOR_CLOSED,
  DESTRUCTIBLE_CRATE: TileType.DESTRUCTIBLE_CRATE,
  DESTRUCTIBLE_BARREL: TileType.DESTRUCTIBLE_BARREL,
  INDESTRUCTIBLE_CRATE: TileType.INDESTRUCTIBLE_CRATE,
};

function resolveTileType(typeStr: string, hasColliders: boolean): TileType {
  if (TILE_TYPE_MAP[typeStr]) return TILE_TYPE_MAP[typeStr];
  if (hasColliders) return TileType.INDESTRUCTIBLE_WALL;
  return TileType.EMPTY;
}

// ── parser ───────────────────────────────────────────────────────────────────

export class TsxAtlasParser {
  /**
   * Parse a `.tsx` tileset file and return a `TileSpriteAtlas`.
   * Works identically to the atlas-building portion of `TmxParser` so that
   * both the demo-map path and the seed-map path produce the same atlas shape.
   */
  parse(tsxPath: string): TileSpriteAtlas {
    const absPath = resolve(tsxPath);
    logger.info(`Parsing tileset: ${absPath}`);

    const xml = readFileSync(absPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const doc = parser.parse(xml);
    const ts = doc.tileset;

    const tilecount = parseInt(ts['@_tilecount'] || '0', 10);
    const sprites: TileSpriteDef[] = [];

    // Iterate every tile id from 0 to tilecount-1 so spriteId === array index
    // (matches how TmxParser.buildAtlas assigns sequential IDs).
    const tileMap = new Map<
      number,
      { type: string; textureKey: string; colliders: TileCollider[] }
    >();

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

      tileMap.set(id, { type: tileType, textureKey, colliders });
    }

    // Build sequential atlas (spriteId = array index)
    for (let id = 0; id < tilecount; id++) {
      const entry = tileMap.get(id);
      sprites.push({
        id,
        imagePath: entry?.textureKey ?? '',
        tileType: entry ? resolveTileType(entry.type, entry.colliders.length > 0) : TileType.EMPTY,
        colliders: entry?.colliders ?? [],
      });
    }

    logger.info(`Atlas built: ${sprites.length} sprites`);
    return { sprites };
  }
}
