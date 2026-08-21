import { resolve } from 'node:path';
import {
  TileType,
  WeaponType,
  type TileSpriteAtlas,
  type TileSpriteDef,
} from '@sector-battle/shared';
import { TsxAtlasParser } from '../parsers/TsxAtlasParser.js';
import { logger } from '@sector-battle/shared';

// ── constants ─────────────────────────────────────────────────────────────────

/**
 * Maps weapon sprite imagePath → WeaponType for loot placement.
 * weapon_arrow is ammo art (arrow projectile), not a pickup weapon — excluded intentionally.
 */
export const WEAPON_IMAGE_MAP: Record<string, WeaponType> = {
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

export const ENTITY_TYPE_TO_TILE_TYPE: Record<string, TileType> = {
  CRATE: TileType.DESTRUCTIBLE_CRATE,
  BARREL: TileType.DESTRUCTIBLE_BARREL,
};

/** Tags for looking up sprite categories in the combined atlas. */
export interface SpriteLookup {
  wall: TileSpriteDef[]; // INDESTRUCTIBLE_WALL sprites (wall, wall_corner, etc.)
  destructibleWall: TileSpriteDef[]; // DESTRUCTIBLE_WALL sprites
  chest: TileSpriteDef[]; // CHEST sprites
  exit: TileSpriteDef[]; // EXIT sprites
  crate: TileSpriteDef[]; // DESTRUCTIBLE_CRATE sprites
  barrel: TileSpriteDef[]; // DESTRUCTIBLE_BARREL sprites
  trap_spike: TileSpriteDef[]; // TRAP_SPIKE sprites
  trap_fire: TileSpriteDef[]; // TRAP_FIRE sprites
  trap_teleport: TileSpriteDef[]; // TRAP_TELEPORT sprites
  weaponSprites: Map<string, TileSpriteDef>; // weapon textureKey → sprite
}

// ── parser ────────────────────────────────────────────────────────────────────

export class AtlasParser {
  private static atlasCache: Map<string, TileSpriteAtlas> = new Map();

  private tsxParser = new TsxAtlasParser();

  private getOrParse(tsxPath: string): TileSpriteAtlas {
    const cached = AtlasParser.atlasCache.get(tsxPath);
    if (cached) return cached;
    const atlas = this.tsxParser.parse(tsxPath);
    AtlasParser.atlasCache.set(tsxPath, atlas);
    return atlas;
  }

  /**
   * Parse env + weapons tilesets, combine into a single atlas,
   * and return the combined atlas along with the weapon offset.
   */
  parseAtlas(tsxDir: string): { atlas: TileSpriteAtlas; weaponOffset: number } {
    const envAtlas = this.getOrParse(resolve(tsxDir, 'env.tsx'));
    const weaponsAtlas = this.getOrParse(resolve(tsxDir, 'weapons.tsx'));

    // Combine: weapons sprites appended after env sprites
    const combinedSprites = [...envAtlas.sprites];
    const weaponOffset = combinedSprites.length;
    for (const ws of weaponsAtlas.sprites) {
      combinedSprites.push({
        ...ws,
        id: weaponOffset + ws.id,
      });
    }
    const atlas: TileSpriteAtlas = { sprites: combinedSprites };

    // Validate weapon sprite coverage (skip known non-pickup art like ammo/projectile sprites)
    const skipSprites = new Set(['weapon_arrow']);
    for (const sprite of weaponsAtlas.sprites) {
      if (skipSprites.has(sprite.imagePath)) continue;
      if (!WEAPON_IMAGE_MAP[sprite.imagePath]) {
        logger.warn(
          `Weapon sprite "${sprite.imagePath}" not in WEAPON_IMAGE_MAP — ` +
            `will default to generic weapon type`,
        );
      }
    }

    return { atlas, weaponOffset };
  }

  /**
   * Build a categorized sprite lookup from the combined atlas.
   */
  buildSpriteLookup(atlas: TileSpriteAtlas): SpriteLookup {
    const lookup: SpriteLookup = {
      wall: [],
      destructibleWall: [],
      chest: [],
      exit: [],
      crate: [],
      barrel: [],
      trap_spike: [],
      trap_fire: [],
      trap_teleport: [],
      weaponSprites: new Map(),
    };

    for (const sprite of atlas.sprites) {
      switch (sprite.tileType) {
        case TileType.INDESTRUCTIBLE_WALL:
          lookup.wall.push(sprite);
          break;
        case TileType.DESTRUCTIBLE_WALL:
          lookup.destructibleWall.push(sprite);
          break;
        case TileType.CHEST:
          lookup.chest.push(sprite);
          break;
        case TileType.EXIT:
          lookup.exit.push(sprite);
          break;
        case TileType.DESTRUCTIBLE_CRATE:
          lookup.crate.push(sprite);
          break;
        case TileType.DESTRUCTIBLE_BARREL:
          lookup.barrel.push(sprite);
          break;
      }

      // Weapon detection
      if (
        WEAPON_IMAGE_MAP[sprite.imagePath] !== undefined ||
        sprite.imagePath.startsWith('weapon_') ||
        sprite.imagePath.startsWith('shield_')
      ) {
        lookup.weaponSprites.set(sprite.imagePath, sprite);
      }
    }

    // Also categorize trap sprites by checking atlas more carefully
    // The TsxAtlasParser maps TRAP_SPIKE → the trap tileType is stored
    // But since TileType doesn't have TRAP values, traps are TileType.EMPTY (0)
    // We need to re-scan by looking at the original atlas entries
    for (const sprite of atlas.sprites) {
      if (sprite.imagePath === 'trap' || sprite.imagePath === 'wall_trap') {
        lookup.trap_spike.push(sprite);
      } else if (sprite.imagePath === 'trapdoor_round' || sprite.imagePath === 'trapdoor_square') {
        lookup.trap_fire.push(sprite);
      } else if (sprite.imagePath === 'trap_door') {
        lookup.trap_teleport.push(sprite);
      }
    }

    // Remove trap sprites from wall bucket (they were added because resolveTileType
    // mapped them to INDESTRUCTIBLE_WALL, but they're not wall visuals)
    const trapImagePaths = new Set([
      'trap',
      'trap_door',
      'trapdoor_round',
      'trapdoor_square',
      'wall_trap',
    ]);
    lookup.wall = lookup.wall.filter((s) => !trapImagePaths.has(s.imagePath));

    return lookup;
  }
}
