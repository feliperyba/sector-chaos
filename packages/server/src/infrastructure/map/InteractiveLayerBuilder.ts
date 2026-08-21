/**
 * InteractiveLayerBuilder — places entities, loot, traps, and exits on the map grid.
 * Extracted from SeedMapAdapter for single-responsibility.
 */
import {
  TileType,
  TrapType,
  WeaponType,
  SectorType,
  SECTOR_TILE_SIZE,
  type SeededRNG,
  TILE_PIXEL_SIZE,
  type MapData,
  type TileSpriteDef,
  type TileVisual,
  type TiledEntityPlacements,
} from '@sector-battle/shared';

// ── Entity-to-tile mappings ────────────────────────────────────────────────

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

const ENTITY_TYPE_TO_TILE_TYPE: Record<string, TileType> = {
  CRATE: TileType.DESTRUCTIBLE_CRATE,
  BARREL: TileType.DESTRUCTIBLE_BARREL,
};

/**
 * Per-sector-type preferred crate sprites (by imagePath). Each sector type gets
 * a thematically distinct set of destructible objects so the map reads as
 * deliberate places rather than random noise:
 *  - OPEN_ARENA  → outdoor objects (tree, campfire, chair)
 *  - GRID_ARENA  → industrial/storage (crate, planks)
 *  - MAZE        → dungeon furniture (planks, chair)
 *  - RESOURCE_RICH → treasure storage (crate, planks)
 * Falls back to the full crate pool when a preferred sprite is absent.
 */
const SECTOR_CRATE_PREFS: Partial<Record<SectorType, string[]>> = {
  [SectorType.OPEN_ARENA]: ['tree', 'campfire', 'chair'],
  [SectorType.GRID_ARENA]: ['crate', 'planks'],
  [SectorType.MAZE]: ['planks', 'chair'],
  [SectorType.RESOURCE_RICH]: ['crate', 'planks'],
};

/**
 * OPEN_ARENA (forest) NON-hearth cover mix. A campfire is NO LONGER a uniform-
 * random crate texture (the old ~33% scatter that put 30-67 campfires on a
 * map, dominating the light scene). Campfires are now deliberate HEARTHS (see
 * {@link selectOpenArenaHearths}); the remaining forest cover is this varied
 * mix so a clearing reads as a lived-in forest — trees + a rest spot + a
 * stashed supply cache + fallen lumber — not a prop monoculture. Cohesive
 * within the 5-sprite destructible palette (tree/campfire/chair/crate/planks);
 * 'campfire' is deliberately ABSENT (hearths are the only campfires).
 */
const OPEN_ARENA_FOREST_MIX: ReadonlyArray<{ item: string; weight: number }> = [
  { item: 'tree', weight: 5 }, // dominant forest cover
  { item: 'chair', weight: 2 }, // a rest spot
  { item: 'crate', weight: 2 }, // a stashed supply cache
  { item: 'planks', weight: 1 }, // fallen lumber
];

/**
 * Max campfire HEARTHS per OPEN_ARENA sector. A clearing has a hearth or two
 * (a gathering point), not a campfire field — this is the CORRECT hearth count
 * for a forest clearing, not a numeric quota. Combined with
 * {@link HEARTH_MIN_SPACING} + the openness ranking, the campfire count emerges
 * from where clearings actually are (~4-8 map-wide), replacing the old random
 * scatter.
 */
const MAX_HEARTHS_PER_OPEN_ARENA_SECTOR = 2;

/** Min Manhattan spacing between two hearths in the same OPEN_ARENA sector. */
const HEARTH_MIN_SPACING = 4;

/** Radius (tiles) of the openness-score neighbourhood (5×5 at radius 2). */
const HEARTH_OPENNESS_RADIUS = 2;

/**
 * Count non-wall tiles in the (2*radius+1)² neighbourhood of (row,col) — the
 * "openness" score. A crate tile with high openness sits in an open clearing
 * (the natural hearth / gathering spot); low openness = a cramped tile against
 * walls (a poor hearth). Used to pick deliberate campfire locations instead of
 * the old uniform-random scatter.
 */
function opennessScore(grid: TileType[][], row: number, col: number, radius: number): number {
  let open = 0;
  for (let dr = -radius; dr <= radius; dr++) {
    const r = grid[row + dr];
    if (!r) continue;
    for (let dc = -radius; dc <= radius; dc++) {
      const t = r[col + dc];
      if (t === undefined) continue;
      if (t !== TileType.INDESTRUCTIBLE_WALL && t !== TileType.DESTRUCTIBLE_WALL) open++;
    }
  }
  return open;
}

/**
 * Select the OPEN_ARENA campfire HEARTH tiles: per OPEN_ARENA sector, the most-
 * open (clearing-center) `DESTRUCTIBLE_CRATE` tiles, well-spaced, up to
 * {@link MAX_HEARTHS_PER_OPEN_ARENA_SECTOR}. A campfire is a deliberate
 * gathering hearth at the heart of a forest clearing — NOT a uniform-random
 * crate texture. Returns global `"row,col"` keys. Gameplay-neutral: these are
 * EXISTING crate tiles re-textured to `'campfire'` (cover + loot unchanged);
 * the texture is cosmetic-only (a campfire is functionally identical to a tree
 * or chair crate).
 */
function selectOpenArenaHearths(grid: TileType[][], mapData: MapData): Set<string> {
  const hearths = new Set<string>();
  const sectors = mapData.sectors;
  for (let sr = 0; sr < sectors.length; sr++) {
    const sectorRow = sectors[sr];
    if (!sectorRow) continue;
    for (let sc = 0; sc < sectorRow.length; sc++) {
      const sector = sectorRow[sc];
      if (!sector || sector.type !== SectorType.OPEN_ARENA) continue;
      const r0 = sr * SECTOR_TILE_SIZE;
      const c0 = sc * SECTOR_TILE_SIZE;
      // Collect this sector's crate tiles, scored by openness (clearing-center-ness).
      const candidates: Array<{ row: number; col: number; open: number }> = [];
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        const gridRow = grid[r0 + r];
        if (!gridRow) continue;
        for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
          if (gridRow[c0 + c] !== TileType.DESTRUCTIBLE_CRATE) continue;
          candidates.push({
            row: r0 + r,
            col: c0 + c,
            open: opennessScore(grid, r0 + r, c0 + c, HEARTH_OPENNESS_RADIUS),
          });
        }
      }
      if (candidates.length === 0) continue;
      // Most-open first; greedily pick well-spaced hearths.
      candidates.sort((a, b) => b.open - a.open);
      const picked: Array<{ row: number; col: number }> = [];
      for (const cand of candidates) {
        if (picked.length >= MAX_HEARTHS_PER_OPEN_ARENA_SECTOR) break;
        const spaced = picked.every(
          (p) => Math.abs(p.row - cand.row) + Math.abs(p.col - cand.col) >= HEARTH_MIN_SPACING,
        );
        if (spaced) picked.push({ row: cand.row, col: cand.col });
      }
      for (const p of picked) hearths.add(`${p.row},${p.col}`);
    }
  }
  return hearths;
}

/** Find the first atlas crate sprite matching an imagePath (or undefined). */
function findCrateSprite(lookup: SpriteLookup, imagePath: string): TileSpriteDef | undefined {
  return lookup.crate.find((s) => s.imagePath === imagePath);
}

/** Tags for looking up sprite categories in the combined atlas. */
export interface SpriteLookup {
  wall: TileSpriteDef[];
  destructibleWall: TileSpriteDef[];
  chest: TileSpriteDef[];
  exit: TileSpriteDef[];
  crate: TileSpriteDef[];
  barrel: TileSpriteDef[];
  trap_spike: TileSpriteDef[];
  trap_fire: TileSpriteDef[];
  trap_teleport: TileSpriteDef[];
  weaponSprites: Map<string, TileSpriteDef>;
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildInteractiveLayer(
  grid: TileType[][],
  mapData: MapData,
  lookup: SpriteLookup,
  rng: SeededRNG,
): { cells: (TileVisual | null)[][]; entities: TiledEntityPlacements } {
  const height = grid.length;
  const width = height > 0 ? grid[0]!.length : 0;

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
    // Light placements are populated by `LightPlacer` after this builder runs
    // (it needs the final composite grid + occupied set). Initialized empty.
    lightPlacements: [],
  };

  // Spawn points
  entities.spawnPoints = mapData.spawnPoints.map((sp) => ({
    gridX: Math.floor(sp.x / TILE_PIXEL_SIZE),
    gridY: Math.floor(sp.y / TILE_PIXEL_SIZE),
  }));
  if (entities.spawnPoints.length === 0) {
    entities.spawnPoints = [{ gridX: 11, gridY: 11 }];
  }

  // Entity placements (CRATE/BARREL → destructibles)
  for (const ep of mapData.entityPlacements) {
    const gridX = Math.floor(ep.position.x / TILE_PIXEL_SIZE);
    const gridY = Math.floor(ep.position.y / TILE_PIXEL_SIZE);
    if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

    const tileType = ENTITY_TYPE_TO_TILE_TYPE[ep.entityType];
    if (tileType === undefined) continue;

    let spriteList: TileSpriteDef[];
    switch (ep.entityType) {
      case 'CRATE': {
        // Sector-themed crate selection: prefer sprites matching the sector's
        // biome, fall back to the full crate pool.
        const sr = Math.floor(gridY / SECTOR_TILE_SIZE);
        const sc = Math.floor(gridX / SECTOR_TILE_SIZE);
        const sectorType = mapData.sectors[sr]?.[sc]?.type;
        const prefs = sectorType ? SECTOR_CRATE_PREFS[sectorType] : undefined;
        const themed = prefs ? lookup.crate.filter((s) => prefs.includes(s.imagePath)) : [];
        spriteList = themed.length > 0 ? themed : lookup.crate;
        break;
      }
      case 'BARREL':
        spriteList = lookup.barrel;
        break;
      default:
        continue;
    }

    const sprite =
      spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;
    if (!sprite) continue;

    if (gridY < cells.length && gridX < (cells[gridY]?.length ?? 0)) {
      cells[gridY]![gridX] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
    }

    entities.destructibles.push({
      gridX,
      gridY,
      tileType,
      textureKey: sprite.imagePath,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  }

  // Loot placements (CHEST → chests, WEAPON_SPAWN → weapons)
  for (const lp of mapData.lootPlacements) {
    const gridX = Math.floor(lp.position.x / TILE_PIXEL_SIZE);
    const gridY = Math.floor(lp.position.y / TILE_PIXEL_SIZE);
    if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

    if (lp.type === 'CHEST') {
      const spriteList = lookup.chest;
      const sprite =
        spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;
      if (!sprite) continue;

      cells[gridY]![gridX] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
      entities.chests.push({
        gridX,
        gridY,
        textureKey: sprite.imagePath,
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    } else if (lp.type === 'WEAPON_SPAWN') {
      const weaponKeys = Array.from(lookup.weaponSprites.keys());
      if (weaponKeys.length === 0) continue;

      const weaponKey = weaponKeys[rng.nextInt(0, weaponKeys.length - 1)]!;
      const sprite = lookup.weaponSprites.get(weaponKey)!;
      const weaponType = WEAPON_IMAGE_MAP[weaponKey] ?? WeaponType.SHORT_SWORD;

      cells[gridY]![gridX] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
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
      entities.powerups.push({
        gridX,
        gridY,
        textureKey: 'puddle',
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }
  }

  // Trap placements
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

    cells[gridY]![gridX] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
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

  // Exit placements
  for (const ex of mapData.exits) {
    const gridX = Math.floor(ex.position.x / TILE_PIXEL_SIZE);
    const gridY = Math.floor(ex.position.y / TILE_PIXEL_SIZE);
    if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;

    const spriteList = lookup.exit;
    const sprite =
      spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;
    if (!sprite) continue;

    cells[gridY]![gridX] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
    entities.exits.push({
      gridX,
      gridY,
      textureKey: sprite.imagePath,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  }

  // Grid scan: hydrate DESTRUCTIBLE_CRATE tiles written directly by skeleton
  // generators with sector-themed textures and interactive-layer cells so they
  // get proper collision and visuals. OPEN_ARENA (forest) is special-cased:
  // campfires are deliberate HEARTHS (clearing-center crates, see
  // selectOpenArenaHearths) and the remaining cover is a varied forest mix, NOT
  // the old uniform tree/campfire/chair scatter that put 30-67 campfires on a
  // map. Other sector types keep their themed prefs (crate/planks/chair).
  const openArenaHearths = selectOpenArenaHearths(grid, mapData);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (grid[row]![col] !== TileType.DESTRUCTIBLE_CRATE) continue;
      if (cells[row]![col] !== null) continue;

      const sr = Math.floor(row / SECTOR_TILE_SIZE);
      const sc = Math.floor(col / SECTOR_TILE_SIZE);
      const sectorType = mapData.sectors[sr]?.[sc]?.type;
      let sprite: TileSpriteDef | undefined;

      if (sectorType === SectorType.OPEN_ARENA) {
        // Hearth → campfire; otherwise the varied forest mix (no campfire in the
        // mix — hearths are the ONLY campfires). weightedPick advances the RNG
        // one draw per non-hearth crate (deterministic per seed).
        const imagePath = openArenaHearths.has(`${row},${col}`)
          ? 'campfire'
          : rng.weightedPick(OPEN_ARENA_FOREST_MIX);
        sprite = findCrateSprite(lookup, imagePath);
        // Fallback to the full crate pool if the chosen sprite is absent.
        if (!sprite && lookup.crate.length > 0) {
          sprite = lookup.crate[rng.nextInt(0, lookup.crate.length - 1)];
        }
      } else {
        const prefs = sectorType ? SECTOR_CRATE_PREFS[sectorType] : undefined;
        const themed = prefs ? lookup.crate.filter((s) => prefs.includes(s.imagePath)) : [];
        const spriteList = themed.length > 0 ? themed : lookup.crate;
        sprite =
          spriteList.length > 0 ? spriteList[rng.nextInt(0, spriteList.length - 1)] : undefined;
      }
      if (!sprite) continue;

      cells[row]![col] = { spriteId: sprite.id, rotation: 0, flipH: false, flipV: false };
      entities.destructibles.push({
        gridX: col,
        gridY: row,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: sprite.imagePath,
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }
  }

  return { cells, entities };
}
