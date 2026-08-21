/**
 * Dev-only rendering helpers for the seed-gallery preview harness.
 *
 * Pure, dependency-free functions that turn a generated {@link MapData} into a
 * self-contained SVG thumbnail (one colour per {@link TileType}) plus a
 * one-line stat summary. No runtime dependencies are introduced so the shared
 * package stays framework-agnostic and deterministic.
 */
import { TileType } from '../src/enums/TileType.js';
import { buildCompositeGrid } from '../src/map/gridUtils.js';
import { SECTOR_TILE_SIZE, TILE_PIXEL_SIZE } from '../src/map/constants.js';
import type { MapData } from '../src/map/types.js';

/** One fixed colour per {@link TileType}. */
export const TILE_COLORS: Record<TileType, string> = {
  [TileType.EMPTY]: '#1b2230',
  [TileType.INDESTRUCTIBLE_WALL]: '#11151c',
  [TileType.DESTRUCTIBLE_WALL]: '#8a6d3b',
  [TileType.CHEST]: '#e8c84a',
  [TileType.EXIT]: '#4ad6e8',
  [TileType.DOOR_CLOSED]: '#6b4f2a',
  [TileType.DESTRUCTIBLE_CRATE]: '#b07a3f',
  [TileType.DESTRUCTIBLE_BARREL]: '#c0563b',
  [TileType.INDESTRUCTIBLE_CRATE]: '#3a3f4b',
};

/** Human-readable label per {@link TileType}, used by the legend. */
export const TILE_LABELS: Record<TileType, string> = {
  [TileType.EMPTY]: 'EMPTY',
  [TileType.INDESTRUCTIBLE_WALL]: 'INDESTRUCTIBLE_WALL',
  [TileType.DESTRUCTIBLE_WALL]: 'DESTRUCTIBLE_WALL',
  [TileType.CHEST]: 'CHEST',
  [TileType.EXIT]: 'EXIT',
  [TileType.DOOR_CLOSED]: 'DOOR_CLOSED',
  [TileType.DESTRUCTIBLE_CRATE]: 'DESTRUCTIBLE_CRATE',
  [TileType.DESTRUCTIBLE_BARREL]: 'DESTRUCTIBLE_BARREL',
  [TileType.INDESTRUCTIBLE_CRATE]: 'INDESTRUCTIBLE_CRATE',
};

/** Marker categories overlaid on the tile grid, with colour + glyph. */
export const MARKER_STYLES = {
  spawn: { color: '#39d353', label: 'spawn' },
  chest: { color: '#ffd700', label: 'chest' },
  exit: { color: '#00e5ff', label: 'exit' },
  weapon: { color: '#ff5cf0', label: 'weapon spawn' },
} as const;

/** Per-seed statistics summarised on stdout and under each thumbnail. */
export interface SeedStats {
  seed: number;
  openSpacePct: number;
  spawnCount: number;
  chestCount: number;
  weaponSpawnCount: number;
  lootCount: number;
}

/** A pixel-space position from {@link MapData}. */
interface PixelPos {
  x: number;
  y: number;
}

/**
 * Convert a pixel-space map position to a composite-grid tile coordinate.
 * Positions in {@link MapData} are world pixels; one tile is
 * {@link TILE_PIXEL_SIZE} pixels wide.
 *
 * @param pos - world-pixel position from the map data
 * @returns the `{ col, row }` tile coordinate in the composite grid
 */
function toTile(pos: PixelPos): { col: number; row: number } {
  return {
    col: Math.floor(pos.x / TILE_PIXEL_SIZE),
    row: Math.floor(pos.y / TILE_PIXEL_SIZE),
  };
}

/**
 * Compute the per-seed stat summary for a generated map.
 *
 * @param map - the generated map data
 * @returns the open-space percentage and spawn/loot counts
 */
export function computeStats(map: MapData): SeedStats {
  const grid = buildCompositeGrid(map.sectors);
  let empty = 0;
  let total = 0;
  for (const row of grid) {
    for (const tile of row) {
      total++;
      if (tile === TileType.EMPTY) empty++;
    }
  }

  const chestCount = map.lootPlacements.filter((l) => l.type === 'CHEST').length;
  const weaponSpawnCount = map.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN').length;

  return {
    seed: map.seed,
    openSpacePct: total === 0 ? 0 : (empty / total) * 100,
    spawnCount: map.spawnPoints.length,
    chestCount,
    weaponSpawnCount,
    lootCount: map.lootPlacements.length,
  };
}

/**
 * Format a {@link SeedStats} as a single stdout line.
 *
 * @param stats - the stats to format
 * @returns a one-line human-readable summary
 */
export function formatStatLine(stats: SeedStats): string {
  const pct = stats.openSpacePct.toFixed(1);
  return (
    `seed ${stats.seed}: open ${pct}% | spawns ${stats.spawnCount} | ` +
    `chests ${stats.chestCount} | weaponSpawns ${stats.weaponSpawnCount} | loot ${stats.lootCount}`
  );
}

/** Options controlling a single SVG thumbnail render. */
interface ThumbOptions {
  /** Pixel size of one tile in the rendered SVG. */
  tilePx: number;
}

/**
 * Append `<rect>` cells for every tile in the composite grid.
 *
 * @param parts - the SVG fragment accumulator to push into
 * @param grid - the composite tile grid
 * @param tilePx - pixel size of one rendered tile
 */
function renderTiles(parts: string[], grid: Uint8Array[], tilePx: number): void {
  for (let r = 0; r < grid.length; r++) {
    const rowArr = grid[r]!;
    for (let c = 0; c < rowArr.length; c++) {
      const tile = rowArr[c] as TileType;
      const color = TILE_COLORS[tile] ?? '#ff00ff';
      parts.push(
        `<rect x="${c * tilePx}" y="${r * tilePx}" width="${tilePx}" height="${tilePx}" fill="${color}"/>`,
      );
    }
  }
}

/**
 * Append faint sector-grid lines (every {@link SECTOR_TILE_SIZE} tiles).
 *
 * @param parts - the SVG fragment accumulator to push into
 * @param sideTiles - the composite grid side length in tiles
 * @param tilePx - pixel size of one rendered tile
 */
function renderSectorLines(parts: string[], sideTiles: number, tilePx: number): void {
  const sidePx = sideTiles * tilePx;
  const sectorsPerSide = sideTiles / SECTOR_TILE_SIZE;
  for (let s = 0; s <= sectorsPerSide; s++) {
    const p = s * SECTOR_TILE_SIZE * tilePx;
    parts.push(
      `<line x1="${p}" y1="0" x2="${p}" y2="${sidePx}" stroke="#7fb0ff" stroke-opacity="0.35" stroke-width="1"/>`,
    );
    parts.push(
      `<line x1="0" y1="${p}" x2="${sidePx}" y2="${p}" stroke="#7fb0ff" stroke-opacity="0.35" stroke-width="1"/>`,
    );
  }
}

/**
 * Append a single circular marker centred on a tile.
 *
 * @param parts - the SVG fragment accumulator to push into
 * @param pos - world-pixel position to mark
 * @param color - marker fill colour
 * @param tilePx - pixel size of one rendered tile
 */
function renderMarker(parts: string[], pos: PixelPos, color: string, tilePx: number): void {
  const { col, row } = toTile(pos);
  const cx = col * tilePx + tilePx / 2;
  const cy = row * tilePx + tilePx / 2;
  const radius = Math.max(1.4, tilePx * 0.42);
  parts.push(
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" stroke="#000" stroke-opacity="0.5" stroke-width="0.5"/>`,
  );
}

/**
 * Render a single map to a self-contained `<svg>` thumbnail string: one colour
 * per {@link TileType}, faint sector-grid outlines, and overlaid markers for
 * spawns, chests, exits, and ground-weapon spawns.
 *
 * @param map - the generated map data
 * @param opts - thumbnail render options (tile pixel size)
 * @returns an `<svg>...</svg>` string
 */
export function renderThumbnailSvg(map: MapData, opts: ThumbOptions): string {
  const grid = buildCompositeGrid(map.sectors);
  const sideTiles = grid.length;
  const sidePx = sideTiles * opts.tilePx;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sidePx} ${sidePx}" ` +
      `width="${sidePx}" height="${sidePx}" shape-rendering="crispEdges">`,
  );

  renderTiles(parts, grid, opts.tilePx);
  renderSectorLines(parts, sideTiles, opts.tilePx);

  for (const loot of map.lootPlacements) {
    if (loot.type === 'CHEST')
      renderMarker(parts, loot.position, MARKER_STYLES.chest.color, opts.tilePx);
    else if (loot.type === 'WEAPON_SPAWN')
      renderMarker(parts, loot.position, MARKER_STYLES.weapon.color, opts.tilePx);
  }
  for (const exit of map.exits) {
    renderMarker(parts, exit.position, MARKER_STYLES.exit.color, opts.tilePx);
  }
  for (const spawn of map.spawnPoints) {
    renderMarker(parts, { x: spawn.x, y: spawn.y }, MARKER_STYLES.spawn.color, opts.tilePx);
  }

  parts.push('</svg>');
  return parts.join('');
}
