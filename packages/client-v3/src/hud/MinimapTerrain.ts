import type Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import type { MinimapData } from './MinimapRenderer.js';

/**
 * STATIC minimap terrain rendering (perf ticket 18), extracted from
 * MinimapRenderer for the terrain render cache. Everything here is a pure
 * function of (grid contents, gridVersion, player position, tileSize,
 * worldW, sectorTiers) — the cache key MinimapRenderer compares per frame.
 * Dynamic overlays (zone rings, dots, landmark icons, player marker) stay
 * in MinimapRenderer's per-frame Graphics pass.
 */

/** World px → minimap px divisor (player-centered local view). */
export const MINIMAP_SCALE = 16.5;

/** Half-extent of the world window shown in the minimap, shrunk one tile. */
export function minimapViewRange(tileSize: number): number {
  return (ComponentConfig.minimap.size * MINIMAP_SCALE) / 2 - tileSize;
}

// ---------------------------------------------------------------------------
// TileType constants (mirror of shared enum for minimap rendering)
// ---------------------------------------------------------------------------

const TILE_EMPTY = 0;
const TILE_INDESTRUCTIBLE_WALL = 1;
const TILE_CHEST = 3;
const TILE_EXIT = 4;
const TILE_INDESTRUCTIBLE_CRATE = 8;

// ---------------------------------------------------------------------------
// Sector loot-tier tint colors (map-redesign ticket 02 / DEC-003)
// ---------------------------------------------------------------------------

/** HOT districts — warm gold, brightest of the three tints. */
const TIER_TINT_HOT = 0xffc94d;
/** WARM districts — mid ember, the default band (subtlest tint). */
const TIER_TINT_WARM = 0xd98b45;
/** COLD districts — cool blue for the outer edges. */
const TIER_TINT_COLD = 0x5b8bd6;
/** Subtle tint alphas per tier — background wash, never occludes terrain. */
const TIER_TINT_ALPHA: Record<string, number> = { HOT: 0.1, WARM: 0.05, COLD: 0.08 };
/** Sector grid is 4x4 (matches SECTOR_GRID_SIZE in shared constants). */
const SECTOR_GRID = 4;

/**
 * Redraw the full static terrain layer into `gfx`: sector loot-tier wash,
 * then the three tile passes batched by fillStyle (indestructible walls,
 * destructibles, exits). `gfx` must already be cleared — the caller only
 * invokes this when the terrain cache key changed, so the commands persist
 * untouched on every steady-state frame.
 *
 * @param gfx - the terrain Graphics (positioned at the minimap origin)
 * @param data - the per-frame minimap data (terrain fields read only)
 * @param toMMX - world X → minimap X transform for the current frame
 * @param toMMY - world Y → minimap Y transform for the current frame
 */
export function redrawMinimapTerrain(
  gfx: Phaser.GameObjects.Graphics,
  data: MinimapData,
  toMMX: (wx: number) => number,
  toMMY: (wy: number) => number,
): void {
  const SIZE = ComponentConfig.minimap.size;
  const ts = data.tileSize;
  const tilePx = ts / MINIMAP_SCALE;
  const wallSize = tilePx + 1;

  const grid = data.grid;

  // Tile coordinate bounds for visible area
  const VIEW_RANGE = minimapViewRange(ts);
  const minCol = Math.max(0, Math.floor((data.playerX - VIEW_RANGE) / ts));
  const maxCol = Math.min(grid[0]?.length ?? 0, Math.ceil((data.playerX + VIEW_RANGE) / ts));
  const minRow = Math.max(0, Math.floor((data.playerY - VIEW_RANGE) / ts));
  const maxRow = Math.min(grid.length, Math.ceil((data.playerY + VIEW_RANGE) / ts));

  const drawClampedRect = (rx: number, ry: number) => {
    const cx = Math.max(0, rx);
    const cy = Math.max(0, ry);
    const cw = Math.min(SIZE, rx + wallSize) - cx;
    const ch = Math.min(SIZE, ry + wallSize) - cy;
    if (cw > 0 && ch > 0) gfx.fillRect(cx, cy, cw, ch);
  };

  // --- Sector loot-tier tint (map-redesign ticket 02) — drawn FIRST, under
  // all terrain, so the subtle wash can never occlude walls/chests/exits.
  // Sector tint color encodes risk: gold=HOT, ember=WARM, cool blue=COLD.
  const tiers = data.sectorTiers;
  if (tiers && tiers.length > 0 && data.worldW > 0) {
    const sectorPx = data.worldW / SECTOR_GRID;
    const sectorMm = sectorPx / MINIMAP_SCALE;
    for (let sRow = 0; sRow < Math.min(SECTOR_GRID, tiers.length); sRow++) {
      const tierRow = tiers[sRow];
      if (!tierRow) continue;
      for (let sCol = 0; sCol < Math.min(SECTOR_GRID, tierRow.length); sCol++) {
        const tier = tierRow[sCol];
        const alpha = TIER_TINT_ALPHA[tier ?? ''] ?? 0;
        if (alpha <= 0) continue;
        const tint =
          tier === 'HOT' ? TIER_TINT_HOT : tier === 'COLD' ? TIER_TINT_COLD : TIER_TINT_WARM;
        const rx = toMMX(sCol * sectorPx);
        const ry = toMMY(sRow * sectorPx);
        if (rx > SIZE || ry > SIZE || rx + sectorMm < 0 || ry + sectorMm < 0) continue;
        const cx = Math.max(0, rx);
        const cy = Math.max(0, ry);
        const cw = Math.min(SIZE, rx + sectorMm) - cx;
        const ch = Math.min(SIZE, ry + sectorMm) - cy;
        if (cw > 0 && ch > 0) {
          gfx.fillStyle(tint, alpha);
          gfx.fillRect(cx, cy, cw, ch);
        }
      }
    }
  }

  // Pass 1: indestructible walls (light gray — permanent structure).
  gfx.fillStyle(0x9999bb, 0.9);
  for (let r = minRow; r < maxRow; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = minCol; c < maxCol; c++) {
      const tile = row[c];
      if (tile !== TILE_INDESTRUCTIBLE_WALL && tile !== TILE_INDESTRUCTIBLE_CRATE) continue;
      const x = toMMX(c * ts);
      const y = toMMY(r * ts);
      if (x + wallSize < 0 || x > SIZE || y + wallSize < 0 || y > SIZE) continue;
      drawClampedRect(x, y);
    }
  }

  // Pass 2: destructible walls/objects (brown — breakable cover).
  gfx.fillStyle(0x886644, 0.75);
  for (let r = minRow; r < maxRow; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = minCol; c < maxCol; c++) {
      const tile = row[c];
      if (tile === TILE_EMPTY || tile === TILE_CHEST || tile === TILE_EXIT) continue;
      if (tile === TILE_INDESTRUCTIBLE_WALL || tile === TILE_INDESTRUCTIBLE_CRATE) continue;
      const x = toMMX(c * ts);
      const y = toMMY(r * ts);
      if (x + wallSize < 0 || x > SIZE || y + wallSize < 0 || y > SIZE) continue;
      drawClampedRect(x, y);
    }
  }

  // Pass 3: exits (green dots — extraction points).
  gfx.fillStyle(DesignTokens.colors.positive, 1);
  for (let r = minRow; r < maxRow; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = minCol; c < maxCol; c++) {
      if (row[c] !== TILE_EXIT) continue;
      const ex = toMMX(c * ts) + tilePx / 2;
      const ey = toMMY(r * ts) + tilePx / 2;
      if (ex >= 0 && ex <= SIZE && ey >= 0 && ey <= SIZE) gfx.fillCircle(ex, ey, 3);
    }
  }
}
