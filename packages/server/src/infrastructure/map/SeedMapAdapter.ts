import { resolve } from 'node:path';
import {
  TileType,
  SeededRNG,
  buildCompositeGrid,
  collectLandmarkReservedTiles,
  TILE_PIXEL_SIZE,
  type MapData,
  type TileSpriteAtlas,
  type TileVisual,
  type EnrichedMapData,
  type TiledMapLayer,
} from '@sector-battle/shared';
import { TsxAtlasParser } from '../parsers/TsxAtlasParser.js';
import { WallOrientationDetector } from './WallOrientationDetector.js';
import {
  buildWallRoleSpriteMap,
  resolveWallFillSprite,
  selectWallFill,
  selectWallVisuals,
  WALL_FILL_LAYER_NAME,
} from './WallVisualSelector.js';
import { FloorSpriteSelector } from './FloorSpriteSelector.js';
import { buildInteractiveLayer, type SpriteLookup } from './InteractiveLayerBuilder.js';
import { LightPlacer } from './LightPlacer.js';
import {
  buildBeaconLightPlacements,
  buildFortressBeaconPlacements,
} from './LandmarkBeaconPlacer.js';
import { enforceHueDiscipline } from './LightingDiscipline.js';
import { logger } from '@sector-battle/shared';

const WEAPON_IMAGE_MAP: Record<string, number> = {
  shield_curved: 1,
  shield_straight: 1,
  weapon_axe: 1,
  weapon_axe_blades: 1,
  weapon_axe_double: 1,
  weapon_axe_large: 1,
  weapon_bow: 1,
  weapon_bow_arrow: 1,
  weapon_dagger: 1,
  weapon_hammer: 1,
  weapon_longsword: 1,
  weapon_pole: 1,
  weapon_spear: 1,
  weapon_staff: 1,
  weapon_sword: 1,
};

export class SeedMapAdapter {
  private static atlasCache: Map<string, TileSpriteAtlas> = new Map();

  private atlasParser = new TsxAtlasParser();
  private orientationDetector = new WallOrientationDetector();
  private floorSelector = new FloorSpriteSelector();
  private lightPlacer = new LightPlacer();

  private getOrParse(tsxPath: string): TileSpriteAtlas {
    const cached = SeedMapAdapter.atlasCache.get(tsxPath);
    if (cached) return cached;
    const atlas = this.atlasParser.parse(tsxPath);
    SeedMapAdapter.atlasCache.set(tsxPath, atlas);
    return atlas;
  }

  adapt(mapData: MapData, seed: number, tsxDir?: string): EnrichedMapData {
    if (!tsxDir) throw new Error('tsxDir is required — must be provided by caller');
    const baseDir = tsxDir;

    // 1. Parse both tilesets and build a combined atlas
    const envAtlas = this.getOrParse(resolve(baseDir, 'env.tsx'));
    const weaponsAtlas = this.getOrParse(resolve(baseDir, 'weapons.tsx'));

    const combinedSprites = [...envAtlas.sprites];
    const weaponOffset = combinedSprites.length;
    for (const ws of weaponsAtlas.sprites) {
      // Weapons.tsx tiles carry authored collision boxes, which the atlas
      // parser types as INDESTRUCTIBLE_WALL (resolveTileType's
      // hasColliders default). Ground weapons are NOT collision geometry —
      // they render as entity pickups, and every projectile/movement path
      // only skips them thanks to a grid-EMPTY guard. Strip the colliders
      // at merge so the merged collision atlas can never resolve a weapon
      // tile as solid (the "zero colliders = intentionally passable"
      // contract in ProjectileTileCollision).
      combinedSprites.push({ ...ws, id: weaponOffset + ws.id, colliders: [] });
    }
    const atlas: TileSpriteAtlas = { sprites: combinedSprites };

    // Validate weapon sprite coverage
    const skipSprites = new Set(['weapon_arrow']);
    for (const sprite of weaponsAtlas.sprites) {
      if (skipSprites.has(sprite.imagePath)) continue;
      if (!WEAPON_IMAGE_MAP[sprite.imagePath]) {
        logger.warn(
          `Weapon sprite "${sprite.imagePath}" not in WEAPON_IMAGE_MAP — will default to generic weapon type`,
        );
      }
    }

    // 2. Build composite grid from sectors
    const uint8Grid = buildCompositeGrid(mapData.sectors);
    const grid: TileType[][] = uint8Grid.map((row) => Array.from(row) as TileType[]);
    const height = grid.length;
    const width = height > 0 ? grid[0]!.length : 0;

    // 3. Detect wall orientations
    const orientations = this.orientationDetector.detect(grid);

    // 4. Build sprite lookup tables
    const lookup = this.buildSpriteLookup(atlas);

    // 5. Build visual layers
    const rng = new SeededRNG(seed ^ 0xdeadbeef);

    // Map-redesign ticket 04 — the landmark reserved tiles (hero exclusion
    // zones + anchors + minor nodes, global "row,col" keys). Decorative
    // accents skip them (the decor-free exclusion zone) and light placements
    // avoid them so no sconce/crystal crowds the landmark. Entity/loot/spawn
    // placement is NOT affected. Pure projection of MapData.landmarks.
    const landmarkReserved = mapData.landmarks
      ? collectLandmarkReservedTiles(mapData.landmarks)
      : new Set<string>();

    const floorCells = this.floorSelector.select(grid, mapData, atlas, seed);
    const decorationCells = this.floorSelector.buildDecorationLayer(
      grid,
      mapData,
      atlas,
      seed,
      landmarkReserved,
    );
    // Map-polish ticket 13: the `wall_fill` under-layer closes the transparent
    // seams/interiors of 2-thick walls (sector rings, fortress doubles) and
    // wall masses. Fill cells sit only on INDESTRUCTIBLE_WALL tiles, so the
    // occupied-tile set below (which already claims every non-EMPTY grid tile)
    // is unchanged → light placements stay byte-identical. The fill is
    // computed BEFORE the wall layer so the run-consistency repair pass inside
    // `selectWallVisuals` knows which pairs are already fill-connected.
    const wallFillCells = selectWallFill(grid, orientations, resolveWallFillSprite(atlas));
    const wallCells = this.buildWallLayer(grid, orientations, lookup, wallFillCells);
    const { cells: interactiveCells, entities } = buildInteractiveLayer(grid, mapData, lookup, rng);

    // Deterministic light-prop placement (ticket 09). Runs AFTER the interactive
    // layer so lights avoid any tile already claimed by a crate/barrel/chest/
    // trap/exit/wall. The `occupied` set is the union of every non-null cell
    // across the wall + interactive layers (global "row,col" keys), plus the
    // composite-grid non-EMPTY tiles. Lights land only on walkable EMPTY floor.
    //
    // Ticket D3: the placer now also receives `entities.destructibles` so it can
    // locate campfire tiles (a `DESTRUCTIBLE_CRATE` whose `textureKey ===
    // 'campfire'`) and anchor a 1:1 light ON each — campfire IS the light
    // source. There is no `CAMPFIRE` TileType, so the textureKey is the only way
    // to find them. `entities` was already built above (line 100).
    const occupied = this.buildOccupiedTileSet(grid, wallCells, interactiveCells);
    // Map-redesign ticket 04 — sconces/crystals also avoid the landmark
    // reserved tiles (exclusion zones + anchors + minor nodes) so the beacon
    // owns its landmark's surroundings.
    for (const key of landmarkReserved) occupied.add(key);
    // Map-redesign ticket 06 — the fortress (compound/Citadel) beacon anchor
    // is likewise reserved BEFORE the sconce layer runs, so no sconce/crystal
    // can claim the tile the beacon will append to afterwards (the "no two
    // placements share a tile" placement contract). Ticket 08: the beacon's
    // Manhattan-1 neighbourhood is reserved too — hero beacons already carry
    // their Chebyshev-2 landmark exclusion zones, but the fortress beacon
    // reserved only its own tile, so a POI-glow pool could legally land
    // directly beside it (Manhattan 1), tripping the per-sector ≥2 spacing
    // discipline the moment the seed's geometry put a chest cluster at the
    // compound beacon's foot (measured on seed 2718 with the ticket-08
    // library). Reserving the neighbourhood extends the same rule.
    if (mapData.fortress) {
      const { tileY, tileX } = mapData.fortress.beacon;
      occupied.add(`${tileY},${tileX}`);
      occupied.add(`${tileY - 1},${tileX}`);
      occupied.add(`${tileY + 1},${tileX}`);
      occupied.add(`${tileY},${tileX - 1}`);
      occupied.add(`${tileY},${tileX + 1}`);
    }
    // Map-redesign ticket 05 (DEC-005 lighting hierarchy): the placer now
    // also receives the CHEST placements so it can pool one warm POI-glow
    // light per sector's primary chest cluster (never per chest), and the
    // combined list (sconce layer + beacons) runs through the hue-discipline
    // enforcement — a sector's discretionary biome crystal is dropped when
    // it would push the sector viewport past 3 active light hue families.
    // Beacons are NEVER dropped (ticket 04 contract). The enforcement record
    // rides `enrichedData.lightingEnforcements` into the benchmark manifest.
    // Ticket 06 (DEC-004.2): the fortress beacon (compound/Citadel vault)
    // joins the combined list after the hero/minor beacons — same kind
    // ('beacon', never dropped), same value-band gate (the Citadel vault
    // beacon sits AT the 2.6 ceiling with a wider radius).
    const sconceLayer = this.lightPlacer.place(
      grid,
      mapData,
      occupied,
      entities.destructibles,
      seed,
      entities.chests,
    );
    const combined = [
      ...sconceLayer,
      ...(mapData.landmarks ? buildBeaconLightPlacements(mapData.landmarks) : []),
      ...(mapData.fortress ? buildFortressBeaconPlacements(mapData.fortress) : []),
    ];
    const enforced = enforceHueDiscipline(combined);
    entities.lightPlacements = enforced.placements;

    // Layer order is load-bearing. `decoration` sits BETWEEN floor and walls so:
    //  - the client renderer draws it above the floor and below crates/entities;
    //  - the server collision merge (buildMergedVisuals, keeps the LAST non-empty
    //    cell) still resolves walls/interactive on top — decorations (EMPTY-type,
    //    zero-collider) never win the merge. `wall_fill` (ticket 13) sits between
    //    decoration and the walls for the same reason: its EMPTY-type fill cells
    //    can never win the last-wins merge against the wall cell above them.
    const visualLayers: TiledMapLayer[] = [
      { name: 'floor', cells: floorCells },
      { name: 'decoration', cells: decorationCells },
      { name: WALL_FILL_LAYER_NAME, cells: wallFillCells },
      { name: 'map_border_walls', cells: wallCells },
      { name: 'interactive_layer', cells: interactiveCells },
    ];

    logger.info(
      `Adapted seed map: ${width}x${height}, ${visualLayers.length} layers, ${atlas.sprites.length} atlas sprites, ` +
        `${entities.destructibles.length} destructibles, ${entities.chests.length} chests, ` +
        `${entities.weapons.length} weapons, ${entities.traps.length} traps, ` +
        `${entities.exits.length} exits, ${entities.powerups.length} powerups, ` +
        `${entities.lightPlacements.length} lightProps`,
    );

    return {
      grid,
      visualLayers,
      atlas,
      width,
      height,
      tileSize: TILE_PIXEL_SIZE,
      seed,
      entities,
      lightingEnforcements: enforced.enforcements,
    };
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /**
   * Build the global `"row,col"` key set of every tile claimed by a non-floor
   * layer: the composite grid's non-EMPTY tiles (walls, crates-in-grid, etc.)
   * PLUS every non-null cell in the wall + interactive visual layers (chests,
   * barrels, traps, exits, weapon spawns). Lights avoid all of these so they
   * never land on a wall/crate/siege-overlay-relevant tile.
   */
  private buildOccupiedTileSet(
    grid: TileType[][],
    wallCells: (TileVisual | null)[][],
    interactiveCells: (TileVisual | null)[][],
  ): Set<string> {
    const occupied = new Set<string>();
    for (let r = 0; r < grid.length; r++) {
      const gridRow = grid[r]!;
      const wallRow = wallCells[r];
      const intRow = interactiveCells[r];
      for (let c = 0; c < gridRow.length; c++) {
        if (gridRow[c] !== TileType.EMPTY) occupied.add(`${r},${c}`);
        if (wallRow?.[c]) occupied.add(`${r},${c}`);
        if (intRow?.[c]) occupied.add(`${r},${c}`);
      }
    }
    return occupied;
  }

  private buildSpriteLookup(atlas: TileSpriteAtlas): SpriteLookup {
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

      if (
        WEAPON_IMAGE_MAP[sprite.imagePath] !== undefined ||
        sprite.imagePath.startsWith('weapon_') ||
        sprite.imagePath.startsWith('shield_')
      ) {
        lookup.weaponSprites.set(sprite.imagePath, sprite);
      }
    }

    // Classify trap sprites by imagePath pattern
    for (const sprite of atlas.sprites) {
      if (sprite.imagePath === 'trap' || sprite.imagePath === 'wall_trap') {
        lookup.trap_spike.push(sprite);
      } else if (sprite.imagePath === 'trapdoor_round' || sprite.imagePath === 'trapdoor_square') {
        lookup.trap_fire.push(sprite);
      } else if (sprite.imagePath === 'trap_door') {
        lookup.trap_teleport.push(sprite);
      }
    }

    // Remove trap sprites from wall bucket
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

  private buildWallLayer(
    grid: TileType[][],
    orientations: (number | null)[][],
    lookup: SpriteLookup,
    fillCells: (TileVisual | null)[][],
  ): (TileVisual | null)[][] {
    // Wall visual selection is the pure `selectWallVisuals` seam (ticket 12).
    // Ticket 13: the historical positional `%20` sector-border heuristic is
    // DELETED — the facing mode for 1-open-cardinal tiles is derived inside
    // the pure function from the grid + neighbour masks (world-edge ring
    // tiles keep the demo-verified border facing; backed junction tiles face
    // along their run; mutual 2-thick pairs face the shared seam), and a
    // deterministic run-consistency repair pass closes any remaining
    // unfilled-pair side flips using the fill layer as the connected-by-
    // construction oracle.
    return selectWallVisuals(
      grid,
      orientations,
      {
        indestructible: buildWallRoleSpriteMap(lookup.wall),
        destructible: buildWallRoleSpriteMap(lookup.destructibleWall),
      },
      { fillCells },
    );
  }
}
