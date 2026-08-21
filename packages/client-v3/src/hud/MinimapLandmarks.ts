import type Phaser from 'phaser';
import type { LandmarkAssignment } from '@sector-battle/shared';

/**
 * Landmark icons on the local minimap (map-redesign ticket 04 / DEC-002):
 * each hero landmark's anchor renders as a theme-colored ringed dot — the
 * same hue vocabulary as the beacon (the sector TYPE's identity hue,
 * map-polish ticket 03) so the minimap icon and the world beacon read as
 * one identity. Minor landmarks render as small neutral diamonds (distinct
 * from the chest/pickup dots and the hot-sector gold diamond). Bounds-checked, zero alloc — drawn straight into the
 * minimap Graphics during the frame pass. Positions are server-authored
 * (MapData.landmarks via the one-shot mapData payload).
 */

/** Hero icon: ringed dot radii (px, minimap space). */
const HERO_ICON_RADIUS = 3;
const HERO_ICON_RING = 1.5;
/** Minor icon: half-size of the small diamond (px, minimap space). */
const MINOR_ICON_HALF = 2.5;

/** Convert a linear-RGB [0,1] beacon color to a minimap fill color (0xRRGGBB). */
function linearRgbToFillColor([r, g, b]: readonly [number, number, number]): number {
  const to8 = (c: number) => Math.min(255, Math.max(0, Math.round(255 * Math.pow(c, 1 / 2.2))));
  return (to8(r) << 16) | (to8(g) << 8) | to8(b);
}

/**
 * Draw the hero + minor landmark icons into the minimap graphics. In-view
 * only (like chest/pickup dots) — the minimap is the local view; the
 * hot-sector diamond already handles off-map pointing.
 *
 * @param gfx - the minimap Graphics (already positioned at the minimap origin)
 * @param landmarks - the server-authored landmark assignment (null on demo maps)
 * @param toMMX - world X → minimap X transform for the current frame
 * @param toMMY - world Y → minimap Y transform for the current frame
 * @param size - the minimap box size (bounds check)
 * @param tileSize - world px per tile (grid → world center conversion)
 */
export function drawLandmarkIcons(
  gfx: Phaser.GameObjects.Graphics,
  landmarks: LandmarkAssignment | null | undefined,
  toMMX: (wx: number) => number,
  toMMY: (wy: number) => number,
  size: number,
  tileSize: number,
): void {
  if (!landmarks) return;
  const half = tileSize / 2;

  for (const row of landmarks.heroes) {
    for (const hero of row) {
      const x = toMMX(hero.tileX * tileSize + half);
      const y = toMMY(hero.tileY * tileSize + half);
      if (x < 0 || x > size || y < 0 || y > size) continue;
      const color = linearRgbToFillColor(hero.beacon.color);
      gfx.lineStyle(1.5, color, 0.95);
      gfx.strokeCircle(x, y, HERO_ICON_RADIUS + HERO_ICON_RING);
      gfx.fillStyle(color, 0.95);
      gfx.fillCircle(x, y, HERO_ICON_RADIUS);
    }
  }

  gfx.lineStyle(1, 0xd8dee9, 0.8);
  gfx.fillStyle(0xaeb8c8, 0.85);
  for (const minor of landmarks.minors) {
    const x = toMMX(minor.tileX * tileSize + half);
    const y = toMMY(minor.tileY * tileSize + half);
    if (x < 0 || x > size || y < 0 || y > size) continue;
    gfx.beginPath();
    gfx.moveTo(x, y - MINOR_ICON_HALF);
    gfx.lineTo(x + MINOR_ICON_HALF, y);
    gfx.lineTo(x, y + MINOR_ICON_HALF);
    gfx.lineTo(x - MINOR_ICON_HALF, y);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }
}
