/**
 * LightingAtmosphereSectorField — split the camera-following dust field into
 * per-SECTOR slices (map-polish round 5c). Pure (Phaser-free) so the Seam A
 * vitest asserts the geometry WITHOUT booting Phaser.
 *
 * Round 5c drives ONE dust emitter per sector (each with its own shape/hue
 * recipe — LightingAtmosphereThemes). This module decides, per frame, WHERE
 * each emitter spawns and HOW MUCH of the total dust budget it gets:
 *
 *   field (2× viewport, camera-follow) ∩ sector grid  →  ≤ 4 slices
 *   { sectorType, largest intersection rect, area weight }
 *
 * The EMIT zone of a sector's emitter is its largest intersection rect (a
 * mote's theme is chosen by which emitter spawns it — no per-particle
 * position sampling). The DEATH zone of every emitter stays the FULL field
 * rect (not the slice) so motes never pop at an on-screen sector border as
 * the camera pans — they drift across the border and die off-screen at the
 * field edge, exactly like the single-emitter regime.
 *
 * `weight` = that sector type's total covered area / field area — the
 * controller scales each emitter's `maxAliveParticles` by it, so a view deep
 * inside one district puts (almost) the whole dust budget into that one
 * recipe and a border-crossing view splits it by on-screen area. Weights sum
 * to ≤ 1 (the field can overhang the world edge at map borders; the
 * uncovered fraction simply spawns nothing).
 *
 * Allocation discipline: the accumulation scratch lives inside the call
 * (fixed 4 slots — one per SectorType) and the caller's `out` array objects
 * are REUSED slot-by-slot, so steady-state frames allocate nothing.
 */
import { SectorType } from '@sector-battle/shared';

/** One sector's slice of the dust field. */
export interface DustFieldSlice {
  /** The sector type whose recipe this slice feeds. */
  sectorType: SectorType;
  /** The emit-zone rect (the type's LARGEST intersection with the field). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The type's total covered area / field area (∈ (0, 1]; sum over slices ≤ 1). */
  weight: number;
}

/** Accumulator slot (module-private scratch, fixed per call). */
interface SliceAcc {
  type: SectorType;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number; // largest single-intersection area (drives the emit rect)
  total: number; // summed area across ALL intersections of this type
}

/**
 * Split `field` by the sector grid. Writes one slice per sector type present
 * in the field into `out` (reusing its objects; `out.length` becomes the
 * slice count). The grid is [row][col] of SectorType; `tileSize` is the
 * grid→px factor and `sectorTileSize` the sector edge in tiles
 * (SECTOR_TILE_SIZE), so one sector edge = tileSize × sectorTileSize px —
 * the same geometry as shared `wallTintAt`.
 */
export function splitDustFieldBySector(
  field: { x: number; y: number; w: number; h: number },
  sectorTypes: readonly (readonly SectorType[])[],
  tileSize: number,
  sectorTileSize: number,
  out: DustFieldSlice[],
): void {
  const acc: SliceAcc[] = [];
  const fieldArea = field.w * field.h;
  if (fieldArea <= 0 || tileSize <= 0 || sectorTileSize <= 0) {
    out.length = 0;
    return;
  }
  const edge = tileSize * sectorTileSize;
  const rows = sectorTypes.length;
  // Sector-cell range overlapping the field (clamped to the grid; the field
  // can overhang the world at map borders — those cells simply don't exist).
  const row0 = Math.max(0, Math.floor(field.y / edge));
  const row1 = Math.min(rows - 1, Math.floor((field.y + field.h - 1) / edge));
  for (let row = row0; row <= row1; row++) {
    const gridRow = sectorTypes[row];
    if (!gridRow) continue;
    const cols = gridRow.length;
    const col0 = Math.max(0, Math.floor(field.x / edge));
    const col1 = Math.min(cols - 1, Math.floor((field.x + field.w - 1) / edge));
    for (let col = col0; col <= col1; col++) {
      const type = gridRow[col];
      if (type === undefined) continue;
      // Field ∩ cell rect.
      const cx = col * edge;
      const cy = row * edge;
      const x0 = Math.max(field.x, cx);
      const y0 = Math.max(field.y, cy);
      const x1 = Math.min(field.x + field.w, cx + edge);
      const y1 = Math.min(field.y + field.h, cy + edge);
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      // Accumulate per type: total area (weight) + largest rect (emit zone).
      let slot = acc.find((a) => a.type === type);
      if (!slot) {
        slot = { type, x: x0, y: y0, w, h, area, total: 0 };
        acc.push(slot);
      }
      slot.total += area;
      if (area > slot.area) {
        slot.x = x0;
        slot.y = y0;
        slot.w = w;
        slot.h = h;
        slot.area = area;
      }
    }
  }
  // Publish into `out`, reusing its objects (steady-state zero allocation).
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i]!;
    let slice = out[i];
    if (!slice) {
      slice = { sectorType: a.type, x: 0, y: 0, w: 0, h: 0, weight: 0 };
      out[i] = slice;
    }
    slice.sectorType = a.type;
    slice.x = a.x;
    slice.y = a.y;
    slice.w = a.w;
    slice.h = a.h;
    slice.weight = a.total / fieldArea;
  }
  out.length = acc.length;
}
