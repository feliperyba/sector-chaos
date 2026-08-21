/**
 * WallVisualSelector — pure, deterministic wall-visual selection + thick-wall
 * seam fill (map-polish tickets 12 + 13).
 *
 * `selectWallVisuals` (ticket 12, extracted from `SeedMapAdapter.buildWallLayer`)
 * picks the {sprite, rotation, flips} per wall cell. Ticket 13 makes the
 * straight/endcap facing RUN-CONSISTENT and THICK-AWARE: the historical
 * positional `%20` sector-border `isInternal` heuristic is DELETED — the
 * facing mode for a 1-open-cardinal tile is now derived purely from the grid
 * and the neighbour masks (`'open'` / `'run'` / `'partner'`, see
 * `OneOpenFaceMode`), and every 2-thick pair / wall-mass interior cell gets an
 * opaque fill cell in the new server-emitted `wall_fill` layer so thick walls
 * render as one continuous solid body.
 *
 * Ticket 27 render truth (pixel-verified against the canonically-decoded
 * demo border ring — `WallRenderTruth.test.ts`): every backed INDESTRUCTIBLE
 * 1-open cell faces its lone open cardinal — the floor — so the bar presents
 * toward the sector it encloses and the `wall_fill` closes the seam behind
 * it. The ticket-13 'partner' seam meeting and the 'run' axis rule both drew
 * the bar INTO the wall mass on sector borders (the owner-visible constant
 * four-side inversion); 'partner' now survives only for never-fillable
 * destructible pairs and 'run' only for unfillable destructible run cells.
 *
 * Determinism contract (ADR 0035): selection + fill placement are PURE
 * functions of `(grid, orientations, roleSpriteMaps, fillSprite)` — no RNG of
 * any kind, no wall-clock, no global state, no positional `%20` inputs. The
 * same inputs always produce the identical `TileVisual` grids.
 *
 * ── ATLAS COVERAGE TABLE (ticket 14 — written ground truth) ──────────────────
 *
 * The env tileset is a THIN-STRIP kit: every wall frame covers ≤ half a tile
 * (8×8 alpha coverage in `shared/map/wallArtShapes.ts`). Role→frame mapping
 * resolved by `buildWallRoleSpriteMap`:
 *
 * | WallRole                        | indestructible frame | destructible frame |
 * |---------------------------------|----------------------|--------------------|
 * | straight / isolated / endcap    | `wall`               | `wall_damaged`     |
 * | cross                           | `wall`               | `wall_damaged`     |
 * | t_junction (T-stem topologies)  | `wall` (stand-in)    | `wall_damaged`     |
 * | outer_corner                    | `wall_corner`        | `wall_edge`        |
 * | inner_corner                    | `inner_round`        | `wall_edge`        |
 * | diagonal                        | `wall_diagonal`      | `wall_curve`       |
 *
 * CORNER ORIENTATION (ticket 23 — see `WallVisualSelectorCorners` for the
 * full art-geometry derivation): every corner piece places its NW-anchored
 * solid feature (the L's elbow / the concave blob) ON the floor-side
 * quadrant, per `QUADRANT_ROTATION` — the solid bands face the open floor
 * and the transparent remainder points into the wall mass. `classifyWall`'s
 * `OUTER_ROTATION` and the historical destructible inner-corner +180° remap
 * both pointed the elbow the OTHER way (inside the mass) and are superseded
 * selector-side by `orientedOuterCornerRotation` / plain `INNER_ROTATION`.
 *
 * Known limits of the kit (documented so the next wall work starts here):
 *
 * - **No T-stem piece.** A T topology (walls on three cardinals) needs three
 *   connective edges; one strip carries one cap band. `classifyWall` never
 *   emits `t_junction` for this tileset — T-stem cells render the plain
 *   `wall` strip (the sanctioned stand-in, demo-consistent). Pure-destructible
 *   T-stem clusters are therefore the DOCUMENTED residual class of the
 *   wall-continuity gate (D5): unrepresentable, bounded + classified by the
 *   ticket-14 seed sweep, not silently zero.
 * - **`wall_curve` is a thick NE→SW diagonal, NOT a concave cap.** It is
 *   shape-incompatible with the destructible `inner_corner` role; ticket 13
 *   (D6) remapped that role to `wall_edge` (the same convex L as
 *   `wall_corner`) rotated +180° so the open quadrant faces the floor pocket.
 *   `wall_curve` is deliberately last in the inner_corner preference ladder.
 * - **`inner_round` covers only ~9% of the tile** (one quadrant) — correct as
 *   a concave cap next to `wall` strips, never as a connector.
 * - **No full-tile wall piece exists.** Wall-mass interiors / 2-thick seams
 *   are closed by the `wall_fill` LAYER instead: `resolveWallFillSprite`
 *   picks an EXISTING `TileType.EMPTY`-typed opaque floor frame
 *   (`tiles_center` preferred, ~0.96 alpha). The EMPTY typing is the load-
 *   bearing constraint: the client's `checkCellCollider` skips EMPTY-typed
 *   defs (no collision change) and `getWallVisualAt` skips them (the
 *   destructible-entity path is unaffected) — fills are visual mass only.
 * - **`wall_edge` == `wall_corner` shape** (convex L; different art skin).
 *
 * Generation-side composition rules that keep topologies inside this
 * coverage are enforced by `shared/map/refinement/WallCompositionPass.ts`
 * (ticket 14): no orphan 1-tile indestructible stubs outside sanctioned
 * placements, breakable WALL cover in ≥2-tile clusters, seams 2-thick + filled.
 *
 * ── CORNER-DANGLING RE-ROLE (map-polish round-2, ticket 20) ──────────────────
 *
 * A wall cell whose ONLY wall-like attachment is diagonal (zero wall-like
 * cardinal neighbours, ≥1 wall-like diagonal) renders as corner-hugging art
 * (`WallVisualSelectorCorners.cornerDanglingChoice`): an L hugging the first
 * wall diagonal (NE→SE→SW→NW), or — for a 45° run (two opposite wall
 * diagonals) — the diagonal-role frame rotated to the ART axis. This closes
 * the last "validator-green but visually wrong" class: pure-diagonal wall
 * chains (staircases, diagonal pairs, breakables tucked diagonally off a
 * wall mass) used to render as isolated strips connecting to nothing, and
 * the destructible diagonal now resolves to `wall_curve` (an existing
 * DESTRUCTIBLE-typed thick NE↔SW diagonal — shape-perfect for the role; it
 * was only ever rejected for the INNER-CORNER role, ticket 13/D6).
 * `validateWallComposition` gates the class via `cornerDanglingViolations`.
 */

import {
  TileType,
  type TileSpriteAtlas,
  type TileSpriteDef,
  type TileVisual,
} from '@sector-battle/shared';
import {
  classifyWall,
  outerCornerChoice,
  WALL_MASK_BITS,
  type WallRole,
} from './WallMaskClassifier.js';
import { cornerDanglingChoice, orientedOuterCornerRotation } from './WallVisualSelectorCorners.js';
import {
  DIR_OFFSETS,
  DIRS,
  inGridWallNeighbour,
  offMapCardinalCount,
  oneOpenFaceMode,
  OPPOSITE,
  openCardinalsOf,
  type Dir,
} from './WallVisualSelectorFacing.js';
import { repairRunConsistency } from './wallRunConsistency.js';
import { endcapRunFacing, thinRunCornerFacing } from './WallVisualSelectorThinRuns.js';

// ── public types ─────────────────────────────────────────────────────────────

/** Deterministic `WallRole` → sprite resolution for one wall material. */
export type WallRoleSpriteMap = Map<WallRole, TileSpriteDef>;

/** Role→sprite maps for the two wall materials the adapter emits. */
export interface WallRoleSpriteMaps {
  /** Used for `TileType.INDESTRUCTIBLE_WALL` cells (`wall`, `wall_corner`, …). */
  indestructible: WallRoleSpriteMap;
  /** Used for `TileType.DESTRUCTIBLE_WALL` cells (`wall_damaged`, `wall_edge`, …). */
  destructible: WallRoleSpriteMap;
}

/** The server-emitted visual layer that closes 2-thick seams / mass interiors. */
export const WALL_FILL_LAYER_NAME = 'wall_fill';

// ── selection ────────────────────────────────────────────────────────────────

/**
 * Options for {@link selectWallVisuals} (ticket 13).
 */
export interface SelectWallVisualsOptions {
  /**
   * The `wall_fill` layer cells (`selectWallFill` output). The run-consistency
   * repair pass treats any adjacent pair with a filled side as connected —
   * the opaque fill beneath the strips provides the shared solid band — and
   * only rotates unfilled pairs (destructible walls, crates, thin 1-thick
   * runs) into agreement. When omitted, pairs are constrained only if at
   * least one side is a tile type that can NEVER be filled
   * (`DESTRUCTIBLE_WALL` / `INDESTRUCTIBLE_CRATE`).
   */
  fillCells?: (TileVisual | null)[][];
}

/**
 * Select the wall visual (sprite + rotation + flips) for every wall-like cell
 * of the grid. Pure and deterministic.
 *
 * `orientations` is the parallel 8-bit neighbour-mask grid produced by
 * `WallOrientationDetector.detect` (`null` on non-wall cells → no visual).
 *
 * Destructible `inner_corner` remap (ticket 13, D6): the destructible material
 * has no concave-cap frame — `wall_curve` is a thick diagonal, shape-
 * incompatible with the role. It resolves to `wall_edge` (the same convex L
 * shape as `wall_corner`); ticket 23 orients it via `INNER_ROTATION` directly
 * (elbow ON the floor pocket — the same NW-anchored-feature rule as every
 * other corner piece), deleting the historical +180° counter-rotation.
 *
 * After the per-tile pass, a deterministic RUN-CONSISTENCY REPAIR pass
 * (ticket 13, D3) walks the grid in row-major order and rotates any UNFILLED
 * wall cell whose strip does not share a solid band with an adjacent wall
 * tile (band overlap measured against the art-shape ground truth — the same
 * predicate as the continuity audit). This is what makes facing
 * run-consistent: one deterministic strip side per wall run, endcaps and
 * junction notches included, so adjacent run tiles never face opposite sides.
 */
export function selectWallVisuals(
  grid: TileType[][],
  orientations: (number | null)[][],
  roleSpriteMaps: WallRoleSpriteMaps,
  opts?: SelectWallVisualsOptions,
): (TileVisual | null)[][] {
  const result: (TileVisual | null)[][] = [];

  for (let row = 0; row < grid.length; row++) {
    const rowResult: (TileVisual | null)[] = [];

    for (let col = 0; col < grid[row]!.length; col++) {
      const tile = grid[row]![col]!;
      const mask = orientations[row]![col]!;

      if (mask === null) {
        rowResult.push(null);
        continue;
      }

      const open = openCardinalsOf(mask);
      let choice =
        open.length === 1
          ? classifyWall(mask, {
              oneOpenFace: oneOpenFaceMode(grid, orientations, row, col, open[0]!, tile),
            })
          : classifyWall(mask);

      // Thin-run mirror facing (round 5e): a 2-opposite-open straight follows
      // the ARM SIDE of the corner its run terminates into, so symmetric
      // structures (the beacon keep) get MIRrored facings and the strip
      // connects with the corner arm WITHOUT the repair pass rotating the
      // corner. BOTH materials — a mixed run (breakable breach mid-wall)
      // must not flip strip side at the material boundary. No corner end →
      // classifier tie-break stands.
      if (choice.role === 'straight' && open.length === 2 && OPPOSITE[open[0]!] === open[1]) {
        const mirrorRotation = thinRunCornerFacing(grid, orientations, row, col, open);
        if (mirrorRotation !== null) {
          choice = { role: choice.role, rotation: mirrorRotation, flipH: false, flipV: false };
        }
      }

      // Endcap run-following (round 5e): a pier capping a thin run adopts its
      // run's effective facing so both piers of a symmetric structure mirror
      // (the axis rule alone faces both vertical piers E — the same duplicated
      // orientation defect, one tile class later). Both materials, same
      // mixed-run reasoning as the straight rule above.
      if (choice.role === 'endcap' && open.length === 3) {
        const followRotation = endcapRunFacing(grid, orientations, row, col, open);
        if (followRotation !== null) {
          choice = { role: choice.role, rotation: followRotation, flipH: false, flipV: false };
        }
      }

      // Corner-dangling re-role (ticket 20, W1/W1b/W1c): a cell whose only
      // wall-like attachment is diagonal hugs that corner (or renders the
      // art-axis diagonal piece) instead of a strip connecting to nothing.
      const dangling = cornerDanglingChoice(mask);
      if (dangling) choice = dangling;

      // Destructible corner-reading (ticket 13): a destructible tile with
      // walls on two adjacent cardinals is geometrically a corner of its
      // cluster — the half-strip frame is shape-incompatible with hugging
      // both arms (the same mismatch class as the D6 `wall_curve` remap), so
      // the dirty-flank `straight` demotion is overridden with the plain
      // convex-corner choice (`wall_edge`; ticket 23 orients its elbow ON the
      // quadrant between the two open cardinals below). The indestructible
      // material KEEPS the demo-authored door-jamb reading.
      if (
        tile === TileType.DESTRUCTIBLE_WALL &&
        choice.role === 'straight' &&
        open.length === 2 &&
        OPPOSITE[open[0]!] !== open[1]
      ) {
        choice = outerCornerChoice(mask) ?? choice;
      }

      const roleMap =
        tile === TileType.DESTRUCTIBLE_WALL
          ? roleSpriteMaps.destructible
          : roleSpriteMaps.indestructible;
      let sprite = roleMap.get(choice.role);

      // W1c is a DANGLING-only fix: a buried (exposed-0) destructible
      // `diagonal` inside a breakable mass keeps the historical
      // straight-frame fallback (`wall_damaged`) — swapping it to
      // `wall_curve` there regresses mass-interior continuity (the 53-seed
      // T-stem residual bound). Only corner-dangling diagonal cells (45° runs
      // through open floor) take the `wall_curve` piece.
      if (tile === TileType.DESTRUCTIBLE_WALL && choice.role === 'diagonal' && !dangling) {
        const straight = roleMap.get('straight');
        if (straight) sprite = straight;
      }

      if (!sprite) {
        rowResult.push(null);
        continue;
      }

      let rotation: 0 | 90 | 180 | 270 = choice.rotation;
      // Ticket 23 corner-orientation ground truth: every NON-dangling
      // outer-corner cell places the convex L's elbow ON the quadrant between
      // its two adjacent open cardinals (the floor wrapping the corner), so
      // the solid bands run along the floor-facing edges and the elbow caps
      // the mass's outer corner — replacing the classifier's `OUTER_ROTATION`
      // (elbow on the OPPOSITE quadrant = inside the mass: the systematic
      // pin-wheel inversion). Dangling cells keep their hug choice (zero wall
      // cardinals → `orientedOuterCornerRotation` returns null).
      if (choice.role === 'outer_corner' && !dangling) {
        rotation = orientedOuterCornerRotation(mask) ?? rotation;
      }
      // inner_corner: `choice.rotation` (INNER_ROTATION) already puts the
      // concave cap's solid feature ON the floor pocket for BOTH frames —
      // `inner_round` (demo-verified) and the destructible `wall_edge` remap
      // (same NW-anchored elbow). The historical "+180° so its open quadrant
      // faces the pocket" remap was the inverted reading (transparent side
      // toward the floor) and is deleted — see WallVisualSelectorCorners.

      rowResult.push({
        spriteId: sprite.id,
        rotation,
        flipH: choice.flipH,
        flipV: choice.flipV,
      });
    }

    result.push(rowResult);
  }

  repairRunConsistency(grid, result, roleSpriteMaps, opts?.fillCells);

  return result;
}

// ── thick-wall fill (ticket 13, D1 / D2 / D8) ────────────────────────────────

/**
 * Resolve the deterministic opaque fill frame — an EXISTING `TileType.EMPTY`
 * floor frame (no new art; the atlas already ships it ~0.96 opaque):
 * `tiles_center` preferred, then the other full-tile stone frames, then any
 * EMPTY-typed frame. `null` when the atlas has no EMPTY-typed frame at all.
 */
export function resolveWallFillSprite(atlas: TileSpriteAtlas): TileSpriteDef | null {
  const byPath = new Map(atlas.sprites.map((s) => [s.imagePath, s]));
  for (const path of ['tiles_center', 'tile', 'tiles', 'tiles_cracked', 'tiles_corner']) {
    const sprite = byPath.get(path);
    if (sprite && sprite.tileType === TileType.EMPTY) return sprite;
  }
  return atlas.sprites.find((s) => s.tileType === TileType.EMPTY) ?? null;
}

/** The diagonal lying between two adjacent cardinals (mirror of the classifier's `betweenQuadrant`). */
function betweenDiagonal(a: Dir, b: Dir): 'NE' | 'SE' | 'SW' | 'NW' {
  const pair = `${a}${b}`;
  if (pair === 'NE' || pair === 'EN') return 'NE';
  if (pair === 'SE' || pair === 'ES') return 'SE';
  if (pair === 'SW' || pair === 'WS') return 'SW';
  return 'NW'; // N + W
}

/**
 * Junction/bend fill (ticket 13): a 2-adjacent-open tile (walls on two
 * adjacent cardinals) sits at a bend where two wall runs meet perpendicularly.
 * The strip kit has no junction piece, so a DIRTY-flank bend (rendered as a
 * straight strip) and a bend on a THICK body (clean corner, but the wall mass
 * continues behind it — the between-diagonal is walled) are closed by the
 * fill. A CLEAN corner of a THIN 1-thick wall keeps its authored look: the
 * convex L art already hugs both arms with full bands, so no fill is emitted.
 *
 * Also fills indestructible tiles that hug a DESTRUCTIBLE wall (the
 * destructible side can never be filled — a destroyed wall must not leave
 * baked fill behind — so the indestructible partner carries the seam).
 */
function junctionFill(
  grid: TileType[][],
  row: number,
  col: number,
  mask: number,
  open: Dir[],
): boolean {
  if (open.length === 2 && OPPOSITE[open[0]!] !== open[1]!) {
    const walls = DIRS.filter((d) => !open.includes(d)) as [Dir, Dir];
    const massBehind = (mask & WALL_MASK_BITS[betweenDiagonal(walls[0], walls[1])]) !== 0;
    const cleanThinCorner = classifyWall(mask).role === 'outer_corner' && !massBehind;
    if (!cleanThinCorner) return true;
    // A clean thin corner whose L art already connects both arms needs no
    // bend fill — fall through to the destructible-hug clause only.
  }
  for (const dir of DIRS) {
    if (inGridWallNeighbour(grid, row, col, dir)) {
      const [dr, dc] = DIR_OFFSETS[dir];
      const t = grid[row + dr]![col + dc]!;
      if (t === TileType.DESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Select the `wall_fill` layer cells — pure, mask-derived thick-wall detection
 * (no RNG, no positional `%20` inputs). A cell needs filling iff its grid tile
 * is `INDESTRUCTIBLE_WALL` (fills NEVER cover `DESTRUCTIBLE_WALL` tiles — a
 * destroyed wall must not leave baked fill behind — and never crate tiles)
 * and either:
 *
 * - **2-thick pair face** — exactly one open cardinal, pointing outward, with
 *   an in-grid wall neighbour behind it (sector-ring seams, fortress-adjacent
 *   doubles, wall-mass edges, run abutments); or
 * - **mass interior** — no open cardinals at all, with at most one off-map
 *   cardinal (fully buried cells plus the world-edge seam junction caps; the
 *   four map-corner ring tiles keep their demo-authored open look).
 */
export function selectWallFill(
  grid: TileType[][],
  orientations: (number | null)[][],
  fillSprite: TileSpriteDef | null,
): (TileVisual | null)[][] {
  const result: (TileVisual | null)[][] = [];

  for (let row = 0; row < grid.length; row++) {
    const rowResult: (TileVisual | null)[] = [];

    for (let col = 0; col < grid[row]!.length; col++) {
      const tile = grid[row]![col]!;
      const mask = orientations[row]![col]!;

      if (fillSprite === null || mask === null || tile !== TileType.INDESTRUCTIBLE_WALL) {
        rowResult.push(null);
        continue;
      }

      const open = openCardinalsOf(mask);
      const needsFill =
        (open.length === 0 && offMapCardinalCount(grid, row, col) <= 1) ||
        (open.length === 1 && inGridWallNeighbour(grid, row, col, OPPOSITE[open[0]!])) ||
        junctionFill(grid, row, col, mask, open);

      rowResult.push(
        needsFill ? { spriteId: fillSprite.id, rotation: 0, flipH: false, flipV: false } : null,
      );
    }

    result.push(rowResult);
  }

  return result;
}

// ── role → sprite resolution ─────────────────────────────────────────────────

/**
 * Resolve a deterministic single canonical sprite for every `WallRole` from a
 * material's sprite set, keyed by `imagePath`.
 *
 * Indestructible art (from `env.tsx`):
 *   straight/isolated/endcap/cross/t_junction → `wall`
 *   outer_corner → `wall_corner`
 *   inner_corner → `inner_round` (concave rounded inner piece, per the demo)
 *   diagonal → `wall_diagonal`
 *
 * Destructible art (also from `env.tsx`):
 *   straight/isolated/endcap/cross/t_junction → `wall_damaged`
 *   outer_corner → `wall_edge` (convex L-shaped destructible corner)
 *   inner_corner → `wall_edge` TOO (ticket 13/D6: `wall_curve` is a thick
 *     diagonal — shape-incompatible with a concave cap; `wall_edge` is the
 *     same L shape as `wall_corner`, with its elbow ON the floor pocket via
 *     INNER_ROTATION — the ticket-23 orientation, no counter-rotation)
 *   diagonal → `wall_curve` (ticket 20/W1c: an existing DESTRUCTIBLE-typed
 *     thick NE↔SW diagonal — shape-perfect for a 45° breakable run; the
 *     historical `wall_damaged` strip fallback connected to nothing)
 *
 * Any role whose preferred imagePath is absent falls back to the straight
 * sprite, and finally to the first available sprite — so the map always has
 * one coherent material with no per-tile randomness.
 */
export function buildWallRoleSpriteMap(wallSprites: TileSpriteDef[]): WallRoleSpriteMap {
  const byPath = new Map<string, TileSpriteDef>();
  for (const s of wallSprites) {
    if (!byPath.has(s.imagePath)) byPath.set(s.imagePath, s);
  }

  const straight = byPath.get('wall') ?? byPath.get('wall_damaged') ?? wallSprites[0];

  const preferred: Record<WallRole, string[]> = {
    straight: [],
    isolated: [],
    endcap: [],
    cross: [],
    t_junction: [],
    outer_corner: ['wall_corner', 'wall_edge'],
    inner_corner: ['inner_round', 'wall_edge', 'wall_curve'],
    // Ticket 20 (W1c): the destructible material gets `wall_curve` — an
    // existing DESTRUCTIBLE-typed thick NE↔SW diagonal, shape-perfect for a
    // 45° breakable run (it was only ever rejected for the inner-CORNER
    // role, ticket 13/D6). The indestructible bucket still prefers
    // `wall_diagonal`; each bucket falls through to its own straight frame.
    diagonal: ['wall_diagonal', 'wall_curve'],
  };

  const map = new Map<WallRole, TileSpriteDef>();
  for (const role of Object.keys(preferred) as WallRole[]) {
    const candidates = preferred[role];
    let sprite: TileSpriteDef | undefined;
    for (const path of candidates) {
      sprite = byPath.get(path);
      if (sprite) break;
    }
    if (!sprite) sprite = straight;
    if (sprite) map.set(role, sprite);
  }
  return map;
}
