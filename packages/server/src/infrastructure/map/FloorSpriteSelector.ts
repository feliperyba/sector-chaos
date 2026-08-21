import {
  TileType,
  SectorType,
  type TileSpriteAtlas,
  type TileSpriteDef,
  type TileVisual,
  type MapData,
  type SectorData,
  SECTOR_TILE_SIZE,
} from '@sector-battle/shared';
import { SeededRNG } from '@sector-battle/shared';
import { logger } from '@sector-battle/shared';
import {
  SOLID_FLOOR_IMAGE_PATHS,
  GRID_ARENA_FLOOR_PATHS,
  OPEN_ARENA_FLOOR_PATHS,
  MAZE_FLOOR_PATHS,
  RESOURCE_RICH_FLOOR_PATHS,
  PLAZA_ACCENT_PATHS,
  ACCENT_CONFIGS,
  FLOOR_VARIANT_SPECS,
  resolveBeaconCourtAnchors,
  isBeaconCourtTile,
  type AccentConfig,
  type FloorVariantSpec,
} from './biomeConfig.js';

/**
 * A Biome floor palette: the ordered sprite pool a sector type draws its single
 * interior floor sprite from. This is the type-coded Biome framework (CONTEXT.md
 * → Biome / Sector Floor Theme). GridArena (T4) and OpenArena (T5) carry real
 * signature palettes; the remaining types share the shared pool until their
 * slices (T6–T7) land.
 */
type BiomePalette = TileSpriteDef[];

/**
 * The per-draw threshold (out of 10) for choosing a structure-adjacent preferred
 * spot over a freely scattered one in {@link FloorSpriteSelector.paintAccentPass}.
 * `rng.nextInt(0, 9) < 7` lands ~70% of decorations hugging walls / pillars /
 * cover, leaving ~30% as natural free scatter. (R4 decoration cohesion.)
 */
const CLUSTER_PREFERRED_RATIO = 7;

/**
 * Deterministic [0,1) hash of (seed, row, col) for the in-family floor variant
 * band — an integer avalanche (murmur3-style mix), so band membership is a PURE
 * position/seed function with no RNG-stream draws (ADR 0035) and no visible
 * axis-aligned patterning.
 */
function variantHash(seed: number, row: number, col: number): number {
  let h = (seed ^ 0x1b873593) >>> 0;
  h = Math.imul(h ^ (row + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (col + 0x9e3779b9), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 0x100000000;
}

/** One resolved variant band: the variant visual plus its density. */
interface ResolvedVariant {
  visual: TileVisual;
  density: number;
}

/**
 * Selects a floor sprite for EVERY grid cell, producing a dense underlay that
 * renders beneath the wall / interactive layers (the demo TMX paints floor in
 * all cells; the procedural map must do the same or transparent wall/entity
 * pixels show void).
 *
 * - Edge cells (on a sector border) get the `wood` edge floor, framing each room
 *   like the demo perimeter. Edge-vs-interior is a pure positional rule (no RNG).
 * - Interior cells get the per-sector theme floor: ONE base sprite picked per
 *   sector instance from a seed-deterministic RNG space, excluding `wood`
 *   (reserved for edges). The theme sprite is applied under interior walls /
 *   destructible walls / pillars / entities too, not only EMPTY cells.
 * - On top of the base, a tight IN-FAMILY variant band ({@link
 *   FLOOR_VARIANT_SPECS}) sprinkles the type's variant sprite through the
 *   interior via a pure (seed,row,col) hash — authored wear, zero RNG draws.
 * - The BEACON COURT accent ({@link PLAZA_ACCENT_PATHS}, map-polish ticket
 *   29) is anchored to each sector's hero landmark — the in-family sprite
 *   over the keep's interior court, so the medallion always reads as the
 *   beacon's floor; sectors with no resolvable anchor get NO medallion.
 * - Selection stays seed-deterministic via SeededRNG + pure position hashes.
 */
export class FloorSpriteSelector {
  /**
   * Build a 2D array of TileVisual | null for the floor layer.
   * Cells are null only when the atlas has no usable floor sprites at all.
   */
  select(
    grid: TileType[][],
    mapData: MapData,
    atlas: TileSpriteAtlas,
    seed: number,
  ): (TileVisual | null)[][] {
    // Pre-classify atlas sprites. Floor sprites are EMPTY-type cosmetics, minus
    // corridor / stairs art that must not be used as a generic field tile.
    // Only SOLID/opaque floor bases may be used as the floor itself. The
    // patterned stone full-tiles (`tiles_decorative`/`tiles_cracked`) are
    // ~94%-opaque FULL tiles (atlas pixel audit) — they belong in the floor
    // band / plaza medallions, not in the scatter overlay; the partially
    // transparent overlays (`tiles_corner` ~50%, `plants` ~19%, `puddle` ~56%)
    // decorate ON TOP of a full tile. `wood` is included only so the
    // edge-framing lookup below can find it; it is excluded from the interior
    // theme pool.
    const floorSprites = atlas.sprites.filter(
      (s) => s.tileType === TileType.EMPTY && SOLID_FLOOR_IMAGE_PATHS.has(s.imagePath),
    );

    if (floorSprites.length === 0) {
      logger.warn('No floor sprites found in atlas — floor layer will be all null');
      return grid.map((row) => row.map(() => null));
    }

    // The `wood` sprite frames sector borders (edge floor). Reserve it for edges
    // and exclude it from the interior theme pool.
    const woodSprite = floorSprites.find((s) => s.imagePath === 'wood');
    const interiorSprites = floorSprites.filter((s) => s.imagePath !== 'wood');
    // Edge cells fall back to the interior theme if `wood` is absent.
    const themePool = interiorSprites.length > 0 ? interiorSprites : floorSprites;

    const rng = new SeededRNG(seed ^ 0x5f3759df); // unique seed space for floor selection

    // Biome framework: the interior floor palette is keyed by SECTOR TYPE (a
    // type-coded Biome), not chosen type-independently. Every type's placeholder
    // palette is the same `themePool` for now, so the pick index and resulting
    // sprite are byte-identical to before biomes existed; the slices T4–T7 swap
    // each type's pool for a real signature palette.
    const biomePalettes = this.buildBiomePalettes(themePool);

    // Pre-pick ONE interior-theme BASE sprite per sector instance, in a fixed
    // (sr, sc) iteration order so the result is deterministic and independent of
    // grid traversal. Interior cells resolve to this base, except where the
    // in-family variant band / plaza accent (both deterministic, both same
    // value/hue family) deliberately varies it — the floor still reads as ONE
    // cohesive theme per room rather than per-tile noise.
    const sectorsPerSide = Math.max(1, Math.floor(grid.length / SECTOR_TILE_SIZE));
    const sectorFloor = new Map<string, TileVisual>();
    for (let sr = 0; sr < sectorsPerSide; sr++) {
      for (let sc = 0; sc < sectorsPerSide; sc++) {
        const palette = this.paletteForSector(mapData.sectors, sr, sc, biomePalettes, themePool);
        const sprite = palette[rng.nextInt(0, palette.length - 1)]!;
        sectorFloor.set(`${sr},${sc}`, {
          spriteId: sprite.id,
          rotation: 0,
          flipH: false,
          flipV: false,
        });
      }
    }

    const woodVisual: TileVisual | null = woodSprite
      ? { spriteId: woodSprite.id, rotation: 0, flipH: false, flipV: false }
      : null;

    // ── Corridor theming + beacon-anchored court accent (pure positional, no RNG) ─
    // All floor sprites are EMPTY-type, collider-free cosmetics — the tile grid
    // and collision are untouched. Transparent sprites (path/track/plants/etc.)
    // are NEVER used as floor — they go in the separate decoration overlay layer.
    const last = SECTOR_TILE_SIZE - 1;

    const plazaAccents = this.resolvePlazaAccents(atlas);
    const floorVariants = this.resolveFloorVariants(atlas);
    const courtAnchors = resolveBeaconCourtAnchors(mapData, sectorsPerSide);

    const result: (TileVisual | null)[][] = [];
    const totalRows = grid.length;

    for (let row = 0; row < totalRows; row++) {
      const totalCols = grid[row]!.length;
      const rowResult: (TileVisual | null)[] = [];

      const rowLocal = row % SECTOR_TILE_SIZE;
      const rowIsEdge = rowLocal === 0 || rowLocal === last;
      const sr = Math.floor(row / SECTOR_TILE_SIZE);

      for (let col = 0; col < totalCols; col++) {
        const colLocal = col % SECTOR_TILE_SIZE;
        const sc = Math.floor(col / SECTOR_TILE_SIZE);

        const isEdge = rowIsEdge || colLocal === 0 || colLocal === last;
        if (isEdge && woodVisual) {
          rowResult.push({ ...woodVisual });
          continue;
        }

        // Beacon court accent (ticket 29): the distinct focal floor over the
        // keep's interior court, anchored to the sector's hero landmark.
        // Falls back to the theme floor when the accent sprite is absent,
        // the type is unknown, or there is no resolvable anchor (never the
        // old fixed sector-center patch).
        const anchor = courtAnchors.get(`${sr},${sc}`);
        if (anchor && isBeaconCourtTile(col - anchor.x, row - anchor.y)) {
          const type = mapData.sectors[sr]?.[sc]?.type;
          const accent = type ? plazaAccents[type] : null;
          if (accent) {
            rowResult.push({ ...accent });
            continue;
          }
        }

        // Interior cell → the sector's base theme sprite, or the in-family
        // variant sprite when the pure (seed,row,col) hash lands in the band.
        // The band applies only to typed sectors with a resolved spec; unknown
        // types (e.g. empty `sectors` in unit tests) keep the uniform base.
        const sectorType = mapData.sectors[sr]?.[sc]?.type;
        const band = sectorType ? floorVariants[sectorType] : null;
        if (band && variantHash(seed, row, col) < band.density) {
          rowResult.push({ ...band.visual });
          continue;
        }
        const sprite = sectorFloor.get(`${sr},${sc}`);
        rowResult.push(sprite ? { ...sprite } : null);
      }

      result.push(rowResult);
    }

    // The base floor stays an opaque, hole-free underlay: all sprites used
    // here are EMPTY-type opaque floor tiles. Transparent sprites are produced
    // separately by {@link buildDecorationLayer} into a dedicated overlay layer
    // composited ON TOP of this floor (they would punch holes if they replaced
    // the opaque base tile).
    return result;
  }

  /**
   * Build the Decorative Accent OVERLAY layer: a fresh grid of `TileVisual | null`
   * the same size as the floor, `null` everywhere except the sparse accent cells.
   * Composited ON TOP of the opaque base floor (and BELOW the wall / interactive
   * layers) so transparent accent sprites decorate the floor without punching
   * holes. One independent, type-coded pass per {@link ACCENT_CONFIGS} entry, each
   * with its own salted RNG stream. Accents land ONLY on interior walkable floor
   * (`grid[r][c] === TileType.EMPTY`) and are EMPTY-type, collider-free sprites,
   * so the tile grid and collision are never altered.
   */
  buildDecorationLayer(
    grid: TileType[][],
    mapData: MapData,
    atlas: TileSpriteAtlas,
    seed: number,
    /**
     * Map-redesign ticket 04 — the landmark decor-free exclusion zone (global
     * `"row,col"` keys). Accents whose drawn tile falls in the zone are
     * skipped at the PAINT step only: the RNG draw order/count is unchanged
     * (same discipline as the `matches` gate), so determinism is preserved.
     */
    excludeTiles?: ReadonlySet<string>,
  ): (TileVisual | null)[][] {
    const overlay: (TileVisual | null)[][] = grid.map((row) => row.map(() => null));

    for (const config of ACCENT_CONFIGS) {
      this.paintAccentPass(overlay, grid, mapData, atlas, seed, config, excludeTiles);
    }

    return overlay;
  }

  /**
   * One type-coded Decorative Accent pass, painting into the overlay grid. Draws
   * per-sector placements for EVERY sector (RNG stream independent of which
   * sectors match the type); paints only sectors whose type equals `config.type`.
   * Uses a salted RNG stream isolated from floor selection and other passes.
   *
   * R4 cohesion — placement CLUSTERS near structures: for each sector the EMPTY
   * interior cells with ≥1 non-EMPTY cardinal neighbour are pre-collected as
   * "preferred" spots. Each draw has ~70% chance (`rng.nextInt(0, 9) < 7`) to
   * land on a preferred spot, ~30% to scatter freely. When a sector has no
   * preferred cells, all draws scatter. Determinism: `matches` only gates the
   * PAINT step — draws happen identically for EVERY sector, and the preferred
   * set is a pure function of the (deterministic) tile grid. An accent lands
   * only where `grid[r][c] === TileType.EMPTY`.
   */
  private paintAccentPass(
    overlay: (TileVisual | null)[][],
    grid: TileType[][],
    mapData: MapData,
    atlas: TileSpriteAtlas,
    seed: number,
    config: AccentConfig,
    excludeTiles?: ReadonlySet<string>,
  ): void {
    const accents = this.resolveAccentVisuals(atlas, config.paths);
    if (accents.length === 0) return;

    const rng = new SeededRNG((seed ^ config.salt) >>> 0);
    const sectors = mapData.sectors;
    const sectorsPerSide = Math.max(1, Math.floor(overlay.length / SECTOR_TILE_SIZE));
    const interiorPerSector = (SECTOR_TILE_SIZE - 2) * (SECTOR_TILE_SIZE - 2);
    const perSector = Math.max(1, Math.round(interiorPerSector * config.density));

    for (let sr = 0; sr < sectorsPerSide; sr++) {
      for (let sc = 0; sc < sectorsPerSide; sc++) {
        const matches = sectors[sr]?.[sc]?.type === config.type;
        // Preferred spots: EMPTY interior cells adjacent to a structure (pure
        // function of the tile grid → deterministic from the seed).
        const preferred = this.collectStructureAdjacentEmpties(grid, sr, sc);

        for (let i = 0; i < perSector; i++) {
          // Draws are always taken in the same order, independent of `matches`.
          const accent = accents[rng.nextInt(0, accents.length - 1)]!;
          const usePreferred = rng.nextInt(0, 9) < CLUSTER_PREFERRED_RATIO;

          let localR: number;
          let localC: number;
          if (usePreferred && preferred.length > 0) {
            [localR, localC] = preferred[rng.nextInt(0, preferred.length - 1)]!;
          } else {
            localR = rng.nextInt(1, SECTOR_TILE_SIZE - 2);
            localC = rng.nextInt(1, SECTOR_TILE_SIZE - 2);
          }

          if (!matches) continue;
          const r = sr * SECTOR_TILE_SIZE + localR;
          const c = sc * SECTOR_TILE_SIZE + localC;
          // Only decorate interior walkable floor — never a wall / crate / entity
          // — and never inside the landmark decor-free exclusion zone (ticket
          // 04; paint-gate only, RNG order unchanged).
          if (grid[r]?.[c] === TileType.EMPTY && !excludeTiles?.has(`${r},${c}`)) {
            overlay[r]![c] = { ...accent };
          }
        }
      }
    }
  }

  /**
   * Collect the EMPTY interior cells of one sector with ≥1 non-EMPTY cardinal
   * neighbour (wall / pillar / cover / crate) — the "preferred" decoration spots.
   * Pure function of the tile grid. Returns sector-local [row, col] pairs
   * (1..SECTOR_TILE_SIZE-2).
   */
  private collectStructureAdjacentEmpties(
    grid: TileType[][],
    sr: number,
    sc: number,
  ): Array<[number, number]> {
    const preferred: Array<[number, number]> = [];
    const baseR = sr * SECTOR_TILE_SIZE;
    const baseC = sc * SECTOR_TILE_SIZE;
    for (let lr = 1; lr <= SECTOR_TILE_SIZE - 2; lr++) {
      for (let lc = 1; lc <= SECTOR_TILE_SIZE - 2; lc++) {
        const r = baseR + lr;
        const c = baseC + lc;
        if (grid[r]?.[c] !== TileType.EMPTY) continue;
        const up = grid[r - 1]?.[c];
        const down = grid[r + 1]?.[c];
        const left = grid[r]?.[c - 1];
        const right = grid[r]?.[c + 1];
        const hasStructure =
          (up !== undefined && up !== TileType.EMPTY) ||
          (down !== undefined && down !== TileType.EMPTY) ||
          (left !== undefined && left !== TileType.EMPTY) ||
          (right !== undefined && right !== TileType.EMPTY);
        if (hasStructure) preferred.push([lr, lc]);
      }
    }
    return preferred;
  }

  /**
   * Build the per-sector-type Biome palette map. GridArena (T4) gets its
   * signature industrial crate-yard subset ({@link GRID_ARENA_FLOOR_PATHS}),
   * OpenArena (T5) its open-plaza subset ({@link OPEN_ARENA_FLOOR_PATHS}), Maze
   * (T6) its overgrown-ruins subset ({@link MAZE_FLOOR_PATHS}), and ResourceRich
   * (T7) its treasure-depot subset ({@link RESOURCE_RICH_FLOOR_PATHS}). Each
   * subset falls back to the shared pool when none of its sprites exist in the
   * atlas. Selection stays seed-deterministic regardless of which palette a type
   * draws from.
   *
   * @param themePool - the shared interior floor sprite pool
   * @returns a palette per {@link SectorType}
   */
  private buildBiomePalettes(themePool: BiomePalette): Record<SectorType, BiomePalette> {
    const gridArena = themePool.filter((s) => GRID_ARENA_FLOOR_PATHS.has(s.imagePath));
    const openArena = themePool.filter((s) => OPEN_ARENA_FLOOR_PATHS.has(s.imagePath));
    const maze = themePool.filter((s) => MAZE_FLOOR_PATHS.has(s.imagePath));
    const resourceRich = themePool.filter((s) => RESOURCE_RICH_FLOOR_PATHS.has(s.imagePath));
    return {
      [SectorType.GRID_ARENA]: gridArena.length > 0 ? gridArena : themePool,
      [SectorType.OPEN_ARENA]: openArena.length > 0 ? openArena : themePool,
      [SectorType.MAZE]: maze.length > 0 ? maze : themePool,
      [SectorType.RESOURCE_RICH]: resourceRich.length > 0 ? resourceRich : themePool,
    };
  }

  /**
   * Resolve the Biome palette for a sector by its type, falling back to the
   * shared pool when the sector grid is unavailable (e.g. unit tests pass an
   * empty `sectors` array). With placeholder palettes every branch returns the
   * same pool, so selection is unchanged.
   *
   * @param sectors - the per-sector grid from the map data
   * @param sr - the sector row index
   * @param sc - the sector column index
   * @param palettes - the per-type Biome palette map
   * @param fallback - the shared pool used when no sector type is available
   * @returns the floor palette this sector draws from
   */
  private paletteForSector(
    sectors: SectorData[][],
    sr: number,
    sc: number,
    palettes: Record<SectorType, BiomePalette>,
    fallback: BiomePalette,
  ): BiomePalette {
    const type = sectors[sr]?.[sc]?.type;
    return type ? palettes[type] : fallback;
  }

  /**
   * Resolve a single EMPTY-type, collider-free floor visual by imagePath. Used
   * for plaza accent sprites — walkable cosmetic floors that must never alter
   * the tile grid or collision. A sprite that is absent, non-EMPTY, or carries
   * a collider yields null (fallback-safe).
   *
   * @param atlas - the sprite atlas to search
   * @param imagePath - the sprite imagePath to resolve (nullish → null)
   * @returns the visual, or null when no qualifying sprite is found
   */
  private findFloorVisual(
    atlas: TileSpriteAtlas,
    imagePath: string | undefined,
  ): TileVisual | null {
    if (!imagePath) return null;
    const sprite = atlas.sprites.find(
      (s) => s.imagePath === imagePath && s.tileType === TileType.EMPTY && s.colliders.length === 0,
    );
    return sprite ? { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false } : null;
  }

  /**
   * Resolve the per-sector-type floor variant band ({@link FLOOR_VARIANT_SPECS})
   * against the atlas. A type's entry is null when its spec is disabled or its
   * variant sprite is absent — the base floor then paints uniformly
   * (fallback-safe). Band membership is decided by the pure {@link variantHash}
   * of (seed,row,col), so NO RNG stream is consumed (ADR 0035).
   */
  private resolveFloorVariants(atlas: TileSpriteAtlas): Record<SectorType, ResolvedVariant | null> {
    const resolve = (spec: FloorVariantSpec): ResolvedVariant | null => {
      if (spec.path === '' || spec.density <= 0) return null;
      const visual = this.findFloorVisual(atlas, spec.path);
      return visual ? { visual, density: spec.density } : null;
    };
    return {
      [SectorType.GRID_ARENA]: resolve(FLOOR_VARIANT_SPECS[SectorType.GRID_ARENA]),
      [SectorType.OPEN_ARENA]: resolve(FLOOR_VARIANT_SPECS[SectorType.OPEN_ARENA]),
      [SectorType.MAZE]: resolve(FLOOR_VARIANT_SPECS[SectorType.MAZE]),
      [SectorType.RESOURCE_RICH]: resolve(FLOOR_VARIANT_SPECS[SectorType.RESOURCE_RICH]),
    };
  }

  /**
   * Resolve the per-sector-type beacon court accent visuals — one distinct
   * solid floor sprite per type ({@link PLAZA_ACCENT_PATHS}), from the SAME
   * value/hue family as the type's main biome floor (v11 cohesion), so the
   * beacon-anchored court reads as a deliberately framed dais rather than a
   * foreign slab. Null when the accent sprite is absent; the caller then
   * falls back to the theme.
   */
  private resolvePlazaAccents(atlas: TileSpriteAtlas): Record<SectorType, TileVisual | null> {
    return {
      [SectorType.GRID_ARENA]: this.findFloorVisual(
        atlas,
        PLAZA_ACCENT_PATHS[SectorType.GRID_ARENA],
      ),
      [SectorType.OPEN_ARENA]: this.findFloorVisual(
        atlas,
        PLAZA_ACCENT_PATHS[SectorType.OPEN_ARENA],
      ),
      [SectorType.MAZE]: this.findFloorVisual(atlas, PLAZA_ACCENT_PATHS[SectorType.MAZE]),
      [SectorType.RESOURCE_RICH]: this.findFloorVisual(
        atlas,
        PLAZA_ACCENT_PATHS[SectorType.RESOURCE_RICH],
      ),
    };
  }

  /**
   * Resolve the ordered Decorative Accent sprites from the atlas by imagePath.
   * Only EMPTY-type, collider-free sprites qualify so the overlay can never add
   * collision; entries that are missing or carry a collider are skipped.
   *
   * @param atlas - the sprite atlas to search
   * @param paths - the ordered accent imagePaths to resolve
   * @returns the resolved accent visuals (may be empty)
   */
  private resolveAccentVisuals(atlas: TileSpriteAtlas, paths: readonly string[]): TileVisual[] {
    const visuals: TileVisual[] = [];
    for (const path of paths) {
      const visual = this.findFloorVisual(atlas, path);
      if (visual) visuals.push(visual);
    }
    return visuals;
  }
}
