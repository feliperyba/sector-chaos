/**
 * LightPlacerClassifiers — the pure geometry/classifier + scan helpers for the
 * motivated-lighting placer. Mechanical extraction from LightPlacer.ts (F8
 * file-length retirement of the over-cap file) — bodies verbatim, only the
 * module boundary moved. Determinism is unchanged: every helper is a pure
 * function of its arguments (the RNG stays injected by the caller), so the
 * map-gen light stream is byte-identical.
 */
import {
  SeededRNG,
  TileType,
  SectorType,
  type DestructiblePlacement,
  type LightKind,
  type LightPlacementTiled,
  type MapData,
} from '@sector-battle/shared';
import { CRYSTAL_MIN_SPACING } from './biomeCrystalConfig.js';

/**
 * Default minimum Manhattan spacing (in tiles) between two WALL-BRACKET light
 * placements within a sector. Prevents torch clumps when many wall-adjacent
 * floor tiles cluster along one wall face. Campfire anchors are EXEMPT (a
 * campfire and its 1:1 light have no spacing cap — they sit on the same tile).
 * Matches the spacing discipline the other placers use
 * (`placementUtils.hasMinSpacing` uses ≥2).
 *
 * Exported for the doorway sconce-pair ladder (map-polish ticket 10): the
 * band-end pair sits exactly `LIGHT_MIN_SPACING` apart (opening band ends are
 * 2 tiles apart) and every fallback rung only moves a member FURTHER from its
 * sibling, so the pair holds the discipline with NO exemption.
 */
export const LIGHT_MIN_SPACING = 2;

/**
 * Per-sector-type light `kind` distribution for the WALL-BRACKET anchor. The
 * kind carries the biome's flavor for the wall-sconce read:
 *  - GRID_ARENA  → industrial: torches + braziers (built wall fixtures).
 *  - MAZE        → dungeon: torches + lanterns (enclosed corridor flames).
 *  - OPEN_ARENA  → outdoor: torches + braziers + fireplaces (camp-adjacent).
 *  - RESOURCE_RICH → vault: candles + torches (warm vigil lights).
 *
 * `biome-glow` is NOT in this table — crystals are NOT wall sconces. They have
 * their OWN dedicated motivated anchor (Anchor C — crystal nooks / forest
 * clearings) that emits `biome-glow` with a per-biome `color` hue + the moody
 * crystal tune (see `biomeCrystalConfig.ts`). Keeping biome-glow out of the
 * wall-bracket family means the diversity down-weighting controls the FIRE
 * light mix (torch/candle/brazier/lantern/fireplace) cleanly, and crystals
 * never land on an open wall face reading as "a glow stuck on a sconce."
 *
 * `barrel-fire` is NOT emitted (barrels are inert until they explode; the
 * lighting system derives barrel lights from the destructible lifecycle on the
 * client). `campfire` is NOT in this table — campfire lights come ONLY from
 * Anchor A (1:1 on campfire tiles), never from the wall-bracket pass.
 */
const SECTOR_WALL_BRACKET_KIND_WEIGHTS: Record<
  SectorType,
  ReadonlyArray<{ item: LightKind; weight: number }>
> = {
  [SectorType.GRID_ARENA]: [
    { item: 'torch', weight: 6 },
    { item: 'brazier', weight: 2 },
    { item: 'candle', weight: 2 },
  ],
  [SectorType.OPEN_ARENA]: [
    { item: 'torch', weight: 5 },
    { item: 'fireplace', weight: 2 },
    { item: 'brazier', weight: 2 },
    { item: 'candle', weight: 1 },
  ],
  [SectorType.MAZE]: [
    { item: 'torch', weight: 5 },
    { item: 'lantern', weight: 3 },
    { item: 'candle', weight: 2 },
  ],
  [SectorType.RESOURCE_RICH]: [
    { item: 'candle', weight: 5 },
    { item: 'torch', weight: 2 },
  ],
};

/**
 * Diversity ceiling for the kind picker. Once a single kind reaches this
 * fraction of total placements so far, its weight is dropped sharply (×0.2,
 * floored at 1) so the dominant kind can no longer keep winning every pick —
 * but it isn't zeroed, so the biome's flavor is preserved (torch still
 * occasionally fires in GRID_ARENA; the cap just stops the 60-77% dominance
 * observed in the pre-D3 picker).
 *
 * 0.40 is the ticket C6 target ("campfires ≤ 40% of placements"), now applied
 * to the wall-bracket kind family so any runaway-dominant kind self-corrects.
 */
const DOMINANT_KIND_CEILING_PCT = 0.4;

/**
 * Pick a wall-bracket kind for a sector, with diversity down-weighting. The
 * choice is a deterministic function of (sectorType, kindCounts, totalCount,
 * rng). The `rng` is consumed exactly once per pick (single `weightedPick`),
 * so the stream advances at a fixed rate per placement; the diversity
 * post-processing does NOT consume rng (it only rescales existing weights).
 */
export function pickWallBracketKind(
  sectorType: SectorType,
  rng: SeededRNG,
  kindCounts: ReadonlyMap<LightKind, number>,
  totalPlaced: number,
): LightKind {
  const baseWeights = SECTOR_WALL_BRACKET_KIND_WEIGHTS[sectorType];
  const adjusted = applyDiversityWeights(baseWeights, kindCounts, totalPlaced);
  return rng.weightedPick(adjusted);
}

/**
 * Apply the diversity down-weighting to a kind-weight table. Any kind that has
 * already reached {@link DOMINANT_KIND_CEILING_PCT} of `totalPlaced` has its
 * weight multiplied by 0.2 (floored at 1, so it can still fire — preserves
 * biome flavor). Pure function — does not consume rng.
 */
function applyDiversityWeights(
  weights: ReadonlyArray<{ item: LightKind; weight: number }>,
  kindCounts: ReadonlyMap<LightKind, number>,
  totalPlaced: number,
): Array<{ item: LightKind; weight: number }> {
  if (totalPlaced < 1) return [...weights];
  return weights.map((w) => {
    const count = kindCounts.get(w.item) ?? 0;
    if (count / totalPlaced >= DOMINANT_KIND_CEILING_PCT) {
      // Down-weight to 20% of base, floored at weight 1 (never zero — preserves
      // the biome's flavor, just stops the dominant run).
      return { item: w.item, weight: Math.max(1, w.weight * 0.2) };
    }
    return { item: w.item, weight: w.weight };
  });
}

/**
 * A walkable floor tile, exclusive of any tile that the interactive layer
 * (crates, barrels, chests, traps, exits) or the wall layer claims. Wall-
 * bracket lights sit ON the floor beside a wall, never inside a wall/crate/
 * barrel/chest/exit. `EMPTY` is the only purely-floor tile type (siege overlays
 * are runtime state, not in the static grid, so they cannot collide at gen
 * time). Campfire lights are EXEMPT — they sit ON a `DESTRUCTIBLE_CRATE` tile
 * (handled by Anchor A directly, not via this predicate).
 */
export function isWalkableFloorTile(tile: TileType): boolean {
  return tile === TileType.EMPTY;
}

/** Whether a grid tile is a wall (the two wall types — used by the 8-neighbour scan). */
function isWallType(tile: TileType | undefined): boolean {
  return tile === TileType.INDESTRUCTIBLE_WALL || tile === TileType.DESTRUCTIBLE_WALL;
}

// ── 8-neighbourhood wall-adjacency classifier (Anchor B's primary signal). ────

/**
 * The 8 neighbourhood deltas (N, NE, E, SE, S, SW, W, NW) — same ordering as
 * the legacy `buildWallMask` used. Used both by the candidate scan (does ANY
 * neighbour be a wall?) and is the contract the test-side wall-adjacency
 * assertion mirrors.
 */
const NEIGHBOURHOOD_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0] as const, // N
  [-1, 1] as const, // NE
  [0, 1] as const, // E
  [1, 1] as const, // SE
  [1, 0] as const, // S
  [1, -1] as const, // SW
  [0, -1] as const, // W
  [-1, -1] as const, // NW
];

/**
 * Whether the tile at (r,c) has ≥1 wall in its 8-neighbourhood. This is the
 * wall-bracket eligibility predicate: a torch/lantern/brazier on a floor tile
 * with a wall neighbour reads as a wall-sconce / wall-bracket, motivated by
 * real geometry. Off-map neighbours are NOT walls here (unlike the legacy
 * `buildWallMask` which treated off-map as wall) — the wall has to be a real
 * wall tile so the bracket is anchored to a visible fixture.
 *
 * Exported for the ticket-05 hierarchy passes (`LightPlacerHierarchy` doorway
 * / POI-glow / route-sconce tile searches share the same predicate).
 */
export function hasWallNeighbour(grid: TileType[][], r: number, c: number): boolean {
  for (const [dr, dc] of NEIGHBOURHOOD_DELTAS) {
    const rr = r + dr;
    const cc = c + dc;
    const row = grid[rr];
    if (!row) continue;
    if (isWallType(row[cc])) return true;
  }
  return false;
}

// ── Anchor C — crystal-nook / forest-clearing classifiers ─────────────────────

/**
 * Count the wall tiles (`INDESTRUCTIBLE_WALL` / `DESTRUCTIBLE_WALL`) in the
 * 8-neighbourhood of (r,c). The NOOK signal for enclosed-biome crystals: ≥
 * {@link CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS} walls around an EMPTY tile = a
 * concave corner or dead-end pocket (the natural bioluminescent-crystal
 * locale). This is the crystal counterpart to `hasWallNeighbour` (which only
 * asks ≥1 for the wall-bracket sconce read).
 */
export function countWallNeighbours8(grid: TileType[][], r: number, c: number): number {
  let count = 0;
  for (const [dr, dc] of NEIGHBOURHOOD_DELTAS) {
    const row = grid[r + dr];
    if (!row) continue;
    if (isWallType(row[c + dc])) count++;
  }
  return count;
}

/**
 * Whether ANY wall tile exists within the square neighbourhood of (r,c) of the
 * given radius (a (2*radius+1)² box, off-map cells skipped). The FOREST-
 * CLEARING signal for OPEN_ARENA crystals: an EMPTY tile with no wall within
 * radius 2 (the 5×5 box) = a deep forest clearing (≥2 tiles from any wall).
 * OPEN_ARENA is open with few wall-nooks, so its crystals use this complementary
 * motivated signal instead of the nook count.
 */
export function hasWallInNeighbourhoodRadius(
  grid: TileType[][],
  r: number,
  c: number,
  radius: number,
): boolean {
  for (let dr = -radius; dr <= radius; dr++) {
    const row = grid[r + dr];
    if (!row) continue;
    for (let dc = -radius; dc <= radius; dc++) {
      if (isWallType(row[c + dc])) return true;
    }
  }
  return false;
}

/**
 * Count NON-wall tiles in the (2*radius+1)² neighbourhood of (r,c) — the
 * "openness" of a forest-clearing candidate. A higher count = a more central,
 * deeper clearing (the better signature-crystal spot for OPEN_ARENA). Pairs with
 * {@link countWallNeighbours8} (the nook depth score for enclosed biomes) to
 * rank each sector's crystal candidates so the single signature crystal lands at
 * the region's most motivated spot.
 */
export function countNonWallInRadius(
  grid: TileType[][],
  r: number,
  c: number,
  radius: number,
): number {
  let open = 0;
  for (let dr = -radius; dr <= radius; dr++) {
    const row = grid[r + dr];
    if (!row) continue;
    for (let dc = -radius; dc <= radius; dc++) {
      const t = row[c + dc];
      if (t === undefined) continue;
      if (t !== TileType.INDESTRUCTIBLE_WALL && t !== TileType.DESTRUCTIBLE_WALL) open++;
    }
  }
  return open;
}

/**
 * Kind-aware GLOBAL spacing check. A candidate light of `kind` keeps clear of
 * every light already placed (anywhere on the map) by the LARGER of the two
 * kinds' spacing minimums: a `biome-glow` crystal keeps ≥
 * {@link CRYSTAL_MIN_SPACING} from ANY other light (crystals are deliberate
 * accents that stand alone, well-spread across the whole map — the correctness
 * lever that keeps them an ambience minority rather than lighting every nook);
 * two fire lights keep ≥ {@link LIGHT_MIN_SPACING}. GLOBAL (not per-sector) so
 * crystals spread across the map instead of clumping several per sector, and so
 * the wall-nook fill respects crystals across sector borders too.
 */
export function hasUnifiedSpacing(
  gridY: number,
  gridX: number,
  kind: LightKind,
  placed: ReadonlyArray<LightPlacementTiled>,
): boolean {
  for (const p of placed) {
    const min =
      kind === 'biome-glow' || p.kind === 'biome-glow' ? CRYSTAL_MIN_SPACING : LIGHT_MIN_SPACING;
    if (Math.abs(gridY - p.gridY) + Math.abs(gridX - p.gridX) < min) return false;
  }
  return true;
}

// ── Anchor D — dark-gap fill classifier ──────────────────────────────────────

/**
 * LEGACY baseline minimum Manhattan distance (in tiles) from the nearest
 * existing light for a dark-gap fill sconce (Anchor D) to fire. Kept as the
 * documented pre-ticket-05 value (14): map-redesign ticket 05 / DEC-005 #4
 * moves the threshold into the per-tier data table
 * (`lightHierarchyConfig.SECTOR_TIER_LIGHT_PARAMS.fillGapSpacing` — 16 in
 * HOT, 18 in WARM, and the pass is REMOVED in COLD/outer sectors so
 * deliberate dark pockets exist between POIs). The parameter is passed into
 * {@link isDarkGap} by the placer.
 */
const FILL_GAP_SPACING = 14;

/**
 * Whether (gridY,gridX) is a DARK GAP relative to the lights placed so far —
 * i.e. its nearest placed light is ≥`minGap` tiles (Manhattan) away. The
 * Anchor D gate with the PER-TIER threshold (ticket 05): `true` means the
 * tile sits in a genuine dark stretch that merits a safety sconce; `false`
 * means a motivated light already covers it. `Infinity` initial (an empty
 * `placed` list = every tile is a gap, which never happens in practice
 * because A/B/C run first).
 */
export function isDarkGap(
  gridY: number,
  gridX: number,
  placed: ReadonlyArray<LightPlacementTiled>,
  minGap: number = FILL_GAP_SPACING,
): boolean {
  let minDist = Infinity;
  for (const p of placed) {
    const d = Math.abs(gridY - p.gridY) + Math.abs(gridX - p.gridX);
    if (d < minDist) minDist = d;
  }
  return minDist >= minGap;
}

/** Resolve the (sRow,sCol) sector's type, or undefined if out of range. */
export function sectorTypeAt(mapData: MapData, sRow: number, sCol: number): SectorType | undefined {
  return mapData.sectors[sRow]?.[sCol]?.type;
}

/**
 * Collect the campfire tiles from the destructibles list. A campfire is a
 * `DESTRUCTIBLE_CRATE` whose `textureKey === 'campfire'`. Returns global grid
 * coords `{ gridX, gridY }`. Deduped by tile (defensive against a duplicate
 * destructibles entry — the grid scan in InteractiveLayerBuilder can in
 * principle produce one if a crate tile is hydrated twice).
 */
export function collectCampfireTiles(
  destructibles: ReadonlyArray<DestructiblePlacement>,
): Array<{ gridX: number; gridY: number }> {
  const out: Array<{ gridX: number; gridY: number }> = [];
  const seen = new Set<string>();
  for (const d of destructibles) {
    if (d.tileType !== TileType.DESTRUCTIBLE_CRATE) continue;
    if (d.textureKey !== 'campfire') continue;
    const key = `${d.gridY},${d.gridX}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ gridX: d.gridX, gridY: d.gridY });
  }
  return out;
}

/**
 * Collect the wall-bracket candidates across the whole map: EMPTY floor tiles
 * with ≥1 wall (`INDESTRUCTIBLE_WALL` or `DESTRUCTIBLE_WALL`) in the
 * 8-neighbourhood, exclusive of tiles already claimed (by a campfire light or
 * by the interactive/wall layers via `occupied`). Returns global grid coords
 * `{ gridX, gridY }`.
 *
 * Row-major scan order is intentional — combined with the seeded shuffle in
 * `place()`, it gives a deterministic candidate list whose sampling is
 * map-wide-spread (the shuffle randomizes which candidates fire, the cadence
 * gate controls density). Border tiles ARE eligible (a wall-bracket can sit on
 * the row-1 / col-1 ring against the map's outer wall).
 */
export function collectWallAdjacentFloorTiles(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
): Array<{ gridX: number; gridY: number }> {
  const tiles: Array<{ gridX: number; gridY: number }> = [];
  const rows = grid.length;
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    if (!row) continue;
    const cols = row.length;
    for (let c = 0; c < cols; c++) {
      const tile = row[c];
      if (tile === undefined || !isWalkableFloorTile(tile)) continue;
      // Skip tiles the interactive/wall layers claimed — a wall-bracket never
      // sits on a crate/barrel/chest/trap/exit/wall tile (it sits BESIDE a
      // wall, on EMPTY floor).
      const key = `${r},${c}`;
      if (occupied.has(key)) continue;
      // Skip tiles already claimed by a campfire light (the campfire anchor
      // runs first; a wall-bracket can't share a campfire tile).
      if (claimed.has(key)) continue;
      // The wall-bracket eligibility predicate: ≥1 wall in the 8-neighbourhood.
      if (!hasWallNeighbour(grid, r, c)) continue;
      tiles.push({ gridX: c, gridY: r });
    }
  }
  return tiles;
}
