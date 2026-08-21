/**
 * MapRendererWallFill — the `wall_fill` under-layer client contract
 * (map-polish ticket 13).
 *
 * The server emits a `wall_fill` visual layer of opaque EXISTING
 * `TileType.EMPTY`-typed atlas frames under 2-thick wall seams / wall-mass
 * interiors so thick walls render as one continuous solid body. The bake
 * (`MapRenderer.renderStaticVisualLayers`) draws those cells INTO the
 * decoration render texture — above the floor/decoration content, beneath the
 * wall layer's depth-2 RT — with the district wall tint applied, allocating
 * no new render textures and costing nothing per frame (bake-time only).
 */

import { TileType } from '@sector-battle/shared';

/**
 * The server-emitted fill layer's name. Mirrors `WALL_FILL_LAYER_NAME` in the
 * server's `WallVisualSelector` — both literals are pinned by their side's
 * tests, so drift fails a suite rather than silently dropping the layer.
 */
export const WALL_FILL_LAYER_NAME = 'wall_fill';

/**
 * Whether the static bake skips the cell at (row, col) of a wall-ish layer
 * because the grid tile is a DESTRUCTIBLE_WALL: breakable walls render as
 * live HP entities (autotiled art + damage feedback in one sprite), so baking
 * them would double-render and leave a ghost. Applies to `map_border_walls`
 * AND the `wall_fill` under-layer — a destroyed wall must not leave baked
 * fill behind. Pure; unit-tested.
 */
export function skipsWallBakeAt(
  layerName: string,
  grid: number[][],
  row: number,
  col: number,
): boolean {
  return (
    (layerName === 'map_border_walls' || layerName === WALL_FILL_LAYER_NAME) &&
    grid[row]?.[col] === TileType.DESTRUCTIBLE_WALL
  );
}
