/**
 * Deterministic, MOTIVATED light-prop placement (ticket 09 — map-gen light
 * data contract; ticket 10 — geometry-driven map placement; ticket D3 —
 * wall + campfire anchor rewrite, scatter eliminated; map-redesign ticket 05
 * — DEC-005 lighting HIERARCHY).
 *
 * Emits `LightPlacementTiled[]` (torches, campfires, etc.) ONLY where real map
 * geometry motivates them. Lighting is COSMETIC-ONLY (GDD `docs/GDD.md:210`
 * forbids fog of war): the server emits positions + kind, the client resolves
 * the visual. The server does NO light simulation and holds NO light state in
 * Colyseus schema — placements ride the one-shot `mapData` message only.
 *
 * **Ticket 05 — the hierarchy (DEC-005):** light placement is restructured
 * from "even everywhere" into an explicit meaning hierarchy with a
 * SAME-OR-LOWER total budget (beacons, from ticket 04, are appended by the
 * SeedMapAdapter AFTER this placer and are never dropped):
 *
 *   1. **Beacons** (ticket 04, top — hero landmarks, theme-colored).
 *   2. **POI glow** — ONE warm pool per sector's primary chest cluster
 *      (never per chest; the chest glints stay), at the cluster centroid's
 *      nearest eligible fixture tile. Pays for itself: a pool sector does
 *      NOT get a signature crystal (the per-sector accent slot is
 *      conserved — `LightPlacerHierarchy`).
 *   3. **Sconce routes** — doorway sconces come in symmetric PAIRS (one at
 *      each end of every aperture's opening band, ticket 10 pure geometry;
 *      ticket 18 — ONE fixed prop + ONE fixed warm tone for all of them),
 *      plus capped route-mid sconces line the road (per-tier caps).
 *   4. **Dark pockets** — the dark-gap fill is REMOVED in cold/outer
 *      sectors and its threshold RAISED elsewhere (per-tier data-side
 *      parameters), so unlit stretches exist between POIs. Player auras
 *      (client, 640px) keep every player visible — dark is mood/risk,
 *      never invisible enemies.
 *
 * Per-tier parameters are DATA-SIDE (`lightHierarchyConfig.ts`); the
 * discipline gates (≤3 hue families per sector viewport, static value-band
 * ceiling) live in `LightingDiscipline.ts` and are enforced at map-build
 * time by the SeedMapAdapter + reported in the benchmark generation
 * manifest.
 *
 * The D3 contract still holds: every emitted placement has a visible prop
 * sprite and a geometric motivation — campfire tiles (1:1), wall-adjacent
 * sconce brackets, doorway threshold sconce pairs (ticket 10: the aperture
 * mouth itself motivates the fixture — band-end mouth tiles on open sector
 * borders may be genuinely wall-free), hoard/wall-adjacent POI pools,
 * nook/clearing crystals. No scatter; the map-wide safety ceiling caps
 * pathological maps only.
 *
 * Determinism is sacred (spec §"Map-gen light data contract"): identical
 * seeds MUST produce byte-identical `lightPlacements`. The light stream is
 * isolated (`LIGHT_PLACEMENT_SALT` XOR seed), the crystal stream isolated
 * (`CRYSTAL_PLACEMENT_SALT`); the ticket-05 passes (POI glow, route
 * sconces) and the ticket-10 doorway sconce PAIRS are pure geometry — ZERO
 * new RNG draws for POSITION, and (map-polish round-2 ticket 18) ZERO draws
 * for the doorway KIND — one fixed prop + one fixed tone. NO `Math.random()`.
 */
import {
  SeededRNG,
  TileType,
  SectorType,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  effectiveSectorTier,
  type ChestPlacement,
  type DestructiblePlacement,
  type LightAnchor,
  type LightKind,
  type LightPlacementTiled,
  type MapData,
} from '@sector-battle/shared';
import {
  BIOME_CRYSTAL_HUE,
  BIOME_CRYSTAL_LIGHT,
  CRYSTAL_FOREST_CLEARING_WALL_DISTANCE,
  CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS,
  CRYSTAL_PLACEMENT_SALT,
} from './biomeCrystalConfig.js';
import {
  DEFAULT_TIER_LIGHT_PARAMS,
  ROUTE_SCONCE_MIN_GAP,
  lightParamsForTier,
  type LightHierarchyParams,
} from './lightHierarchyConfig.js';
import {
  buildPoiGlowPlacement,
  collectSectorRouteLines,
  findPoiGlowTile,
  findRouteSconceTile,
  orderFillCandidatesRouteFirst,
  primaryChestClusterPerSector,
  routeSamplePoints,
} from './LightPlacerHierarchy.js';
import {
  placeDoorwaySconce,
  doorwayBandEndLadder,
  doorwayPairGeometry,
  firstPlaceableDoorwayPair,
  firstPlaceableDoorwaySoloTiles,
} from './LightPlacerDoorway.js';
import {
  pickWallBracketKind,
  isWalkableFloorTile,
  countWallNeighbours8,
  hasWallInNeighbourhoodRadius,
  countNonWallInRadius,
  hasUnifiedSpacing,
  isDarkGap,
  sectorTypeAt,
  collectCampfireTiles,
  collectWallAdjacentFloorTiles,
} from './LightPlacerClassifiers.js';

/**
 * Isolated RNG salt for light placement. Distinct from every other placer's
 * salt (biomeConfig accent salts, highway/compound macro salts, etc.) so adding
 * lights never perturbs another stream's deterministic output. XOR'd with the
 * map seed at fork time, exactly like the `AccentConfig.salt` pattern.
 */
export const LIGHT_PLACEMENT_SALT = 0x5e21a771;

/**
 * Hard map-wide cap on static light placements. The count is an OUTPUT of the
 * motivated anchors, so this cap is a SAFETY GUARD against pathological maps
 * (a sector wallpapered in wall-bracket candidates), not a placement target.
 *
 * Map-polish ticket 10 rebalanced the ceiling 80 → 112 to hold the DOUBLED
 * doorway layer (a sconce PAIR at every sector-border aperture) without
 * starving the DEC-005 hierarchy. Budget math, worst observed across the
 * standard seeds: 48 doorway sconces (2 × the 24 apertures) + 16 campfires
 * (worst observed) + 19 discretionary accents (POI pools / signature
 * crystals / route sconces — UNTOUCHED budget) = 83 ⇒ 112 keeps ~26% slack.
 * The ceiling stays a guard, never a target: the doorway pairs are
 * anchor-motivated geometry, not discretionary spend.
 *
 * The spec (§"Map-gen light data contract" + §"Performance budget") budgets
 * ~50–80 ON-SCREEN lights (a different constraint — the client budget trims
 * per viewport, and the doubled doorway layer adds ≤2 statics to the worst
 * sampled viewport): this cap leaves comfortable headroom for ~24 player
 * auras + dynamic explosions/projectiles.
 */
export const MAX_MAP_LIGHT_PLACEMENTS = 112;

export class LightPlacer {
  /**
   * Place deterministic light props across the whole map, ANCHORED TO REAL MAP
   * GEOMETRY via four motivated anchor types (the structure-driven rewrite that
   * eliminates the "scattered without logic" read):
   *
   *   **Anchor A — Campfire tiles (1:1).** For every destructible whose
   *   `tileType === DESTRUCTIBLE_CRATE && textureKey === 'campfire'`, place a
   *   `campfire` light ON that exact tile. A campfire IS a fire — the light
   *   sits on the source. No RNG, no spacing (1:1). Campfire tiles are in the
   *   `occupied` set (they're interactive cells); this anchor OVERRIDES the old
   *   "avoid occupied" rule for the campfire case specifically.
   *
   *   **Anchor B — Doorway sconce PAIRS (ticket 10: "a light at each side of
   *   every passage").** For each `mapData.connections` sector-border aperture,
   *   place TWO sconces — one at EACH end of the 3-tile opening band, both on
   *   sector A's threshold face, mirror-symmetric about the aperture axis and
   *   identical in offset across every corridor. Positions are a pure
   *   geometric derivation from the connection record (zero RNG); the kind +
   *   tone are FIXED (ticket 18 — one prop, one tone, zero stream draws). This
   *   is the PRIMARY sconce layer; the threshold structure is what keeps the
   *   map legible rather than random.
   *
   *   **Anchor C — Crystal nooks / forest clearings (motivated biome-glow).**
   *   `biome-glow` crystals are NOT wall sconces — they get their OWN dedicated
   *   geometry anchor. Enclosed biomes (GRID_ARENA / MAZE / RESOURCE_RICH) get
   *   NOOK crystals (EMPTY tile with ≥3 wall neighbours in the 8-neighbourhood =
   *   a concave corner / dead-end pocket); OPEN_ARENA (forest, open — few nooks)
   *   gets FOREST-CLEARING crystals (EMPTY tile with no wall in the 5×5 box = a
   *   deep clearing). Each crystal carries its sector's muted `color` hue + the
   *   moody `radius`/`intensity`/`pulse` tune, ≥3 spacing from every prior light
   *   in the sector, on an isolated RNG fork. Drives the per-biome crystal
   *   identity + the "alive" pulse, replacing the old flat cool-blue static
   *   biome-glow that the wall-bracket pass used to emit.
   *
   *   **Anchor D — Dark-gap fill (last-resort sconces).** After the motivated
   *   anchors structure the map, drop a sconce ONLY into a genuine dark gap — a
   *   wall-adjacent EMPTY tile whose nearest existing light is ≥
   *   `FILL_GAP_SPACING` (8) tiles away — so no corridor reads pitch-black. The
   *   old cadence fill wallpapered a torch every Nth wall tile along every wall
   *   and read as "lights scattered without logic"; the gap gate confines fill
   *   to the holes the motivated anchors leave, keeping their structure legible.
   *   No `isScatter: true` placements exist — every emitted placement has a
   *   visible prop sprite and a geometric motivation.
   *
   * The hero prop COUNT is STRICTLY an OUTPUT of these four anchors — there
   * is no per-sector "budget" to spend. Sectors without campfires or walls get
   * fewer lights, which is the correct "no light where there's no fixture
   * motivation" read the user asked for. The map-wide cap is a SAFETY CEILING
   * only (pathological wall-wallpapered maps).
   *
   * @param grid - the composite post-adapter tile grid (global rows/cols)
   * @param mapData - the raw generated map data (sectors for kind-by-sectorType)
   * @param occupied - global `"row,col"` keys already claimed by the interactive
   *   and wall layers. CAMPFIRE TILES ARE IN THIS SET — the campfire anchor
   *   overrides the avoid-occupied rule for them specifically.
   * @param destructibles - the interactive layer's destructibles (the campfire
   *   source list — a campfire is a `DESTRUCTIBLE_CRATE` whose `textureKey ===
   *   'campfire'`). Built by `InteractiveLayerBuilder` before this placer runs.
   * @param seed - the map seed (the same one passed to `SeedMapAdapter.adapt`)
   * @returns the deterministic `LightPlacementTiled[]` (campfires + wall-brackets)
   */
  place(
    grid: TileType[][],
    mapData: MapData,
    occupied: Set<string>,
    destructibles: ReadonlyArray<DestructiblePlacement>,
    seed: number,
    chests: ReadonlyArray<ChestPlacement> = [],
  ): LightPlacementTiled[] {
    // Isolated RNG stream — fork off (seed ^ LIGHT_PLACEMENT_SALT), exactly the
    // biomeConfig AccentConfig pattern. Independent of every other placer's
    // stream; adding lights never shifts another stream's output.
    const rng = new SeededRNG((seed ^ LIGHT_PLACEMENT_SALT) >>> 0);

    const placements: LightPlacementTiled[] = [];
    // Map-wide claim set (global "r,c" keys) so a wall-bracket in one sector
    // can't sit on the same tile as a campfire light or a bracket in an
    // adjacent sector. (The per-sector spacing rule is local; this is the
    // global dedupe.)
    const claimed = new Set<string>();

    // Track WALL-BRACKET kind counts (separate from campfire) so the diversity
    // down-weighting controls the wall-bracket family specifically. Campfire is
    // a 1:1 anchor driven by destructible count (not the RNG) — including it in
    // the diversity calculation would either (a) make campfire dominate the
    // down-weighting signal (every other kind gets over-weighted), or (b)
    // mask a torch runaway in the wall-bracket family. Tracking wall-bracket
    // counts separately means "no wall-bracket kind exceeds 40% of wall-bracket
    // placements" is the contract the picker actually upholds.
    const wallBracketKindCounts = new Map<LightKind, number>();
    let wallBracketsPlaced = 0;

    // ── Ticket 05 hierarchy context ──────────────────────────────────────────
    // Per-sector gateway→landmark travel lines (route bias for doorway sconces
    // + route-mid sconces + the fill pass's route-adjacent ordering) and the
    // per-tier parameters (dark-gap fill thresholds, route caps), resolved via
    // the EFFECTIVE tier (base pyramid + per-match hot upgrade).
    const routeLines = collectSectorRouteLines(mapData);
    const tierAssignment =
      mapData.sectorTiers.length > 0
        ? { tiers: mapData.sectorTiers, hotSector: mapData.hotSector }
        : null;
    const paramsAt = (sRow: number, sCol: number): LightHierarchyParams => {
      // Guard: degenerate tier grids (unit-test synthetic maps, missing rows)
      // fall back to the default band instead of throwing.
      if (!tierAssignment || tierAssignment.tiers[sRow]?.[sCol] === undefined) {
        return DEFAULT_TIER_LIGHT_PARAMS;
      }
      return lightParamsForTier(effectiveSectorTier(tierAssignment, sRow, sCol));
    };
    /**
     * Place a sconce-kind fixture (kind mix + spacing + claim set). `anchor`
     * (ticket 07) is the PROVENANCE — the DRAWN sconce kind mix (route-mid +
     * dark-gap fill). The doorway anchor does NOT come through here: its kind
     * + tone are FIXED (ticket 18 — `placeDoorwaySconce` in
     * LightPlacerDoorway, which owns the doorway kind/color).
     */
    const placeSconceKind = (
      sectorType: SectorType,
      gridY: number,
      gridX: number,
      anchor: LightAnchor,
    ): boolean => {
      const kind = pickWallBracketKind(sectorType, rng, wallBracketKindCounts, wallBracketsPlaced);
      if (!hasUnifiedSpacing(gridY, gridX, kind, placements)) return false;
      wallBracketKindCounts.set(kind, (wallBracketKindCounts.get(kind) ?? 0) + 1);
      wallBracketsPlaced++;
      claimed.add(`${gridY},${gridX}`);
      placements.push({ gridX, gridY, kind, anchor, rotation: 0, flipH: false, flipV: false });
      return true;
    };

    // ── Anchor A — Campfire tiles (1:1, deterministic, no RNG). A campfire is
    //    a `DESTRUCTIBLE_CRATE` whose `textureKey === 'campfire'` — there is
    //    NO `CAMPFIRE` TileType, the textureKey is the only signal. Place a
    //    `campfire` light ON each (campfire tiles ARE occupied; the light sits
    //    ON the source). ─────────────────────────────────────────────────────
    const campfireTiles = collectCampfireTiles(destructibles);
    for (const { gridX, gridY } of campfireTiles) {
      if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
      const key = `${gridY},${gridX}`;
      if (claimed.has(key)) continue; // duplicate campfire entry (defensive)
      claimed.add(key);
      // Fixed transform (no rotation/flip RNG) — a 1:1 anchor on a specific
      // tile; the client resolves the sprite/anim from `kind: 'campfire'`.
      placements.push({
        gridX,
        gridY,
        kind: 'campfire',
        anchor: 'campfire',
        rotation: 0,
        flipH: false,
        flipV: false,
      });
    }

    // All later anchors check spacing GLOBALLY against `placements` (which already
    // holds the campfire lights). A crystal keeps ≥CRYSTAL_MIN_SPACING from any
    // light on the whole map; fire lights keep ≥LIGHT_MIN_SPACING — kind-aware
    // via hasUnifiedSpacing. Global (not per-sector) spacing is what spreads
    // crystals across the map so they read as a well-distributed ambience layer
    // instead of clumping several per sector.

    // ── Anchor B — Doorway sconce PAIRS (map-polish ticket 10; fallback
    //    semantics per its ADDENDUM repair — coordinated pair stepping).
    //    mapData.connections are the 3-tile sector-border apertures. Every
    //    aperture carries TWO sconces — one at EACH end of the opening band,
    //    both on sector A's threshold face, mirror-symmetric about the
    //    aperture axis, identical band-end offset on all apertures. Positions
    //    are a PURE GEOMETRIC derivation from the connection record (ZERO RNG,
    //    ADR-0035). Ticket 18 (round 2 — "one prop, one tone") also FIXED the
    //    kind + color: every doorway sconce is the SAME torch prop in the SAME
    //    warm tone (`placeDoorwaySconce` — the kind DRAW is REMOVED), member
    //    order fixed band-end-ascending. When a band end is unplaceable the
    //    pair steps TOGETHER through the ladder rungs (band end → outward
    //    along the opening axis → travel-inward, `doorwayBandEndLadder`/
    //    `firstPlaceableDoorwayPair`): BOTH members advance to the same
    //    rung, a rung being void only when the SIBLING cannot take it too,
    //    so mirror symmetry and the 2-lights-per-passage guarantee both
    //    hold. Only when NO rung fits both members does the aperture fall
    //    back to per-member solo rungs (`firstPlaceableDoorwaySoloTiles` —
    //    every solo rung preserves the opening-axis coordinate, so even a
    //    mixed solo pair keeps the mirror); an aperture loses a flank
    //    (sibling-only single light, audited as `doorwayAsymmetric`) exactly
    //    when a member finds no solo rung either. ────────────────────────
    for (const conn of mapData.connections) {
      const geometry = doorwayPairGeometry(conn);
      const ladders = [
        doorwayBandEndLadder(geometry, 0),
        doorwayBandEndLadder(geometry, 1),
      ] as const;
      const pair = firstPlaceableDoorwayPair(grid, occupied, claimed, placements, ladders);
      const members =
        pair?.tiles ?? firstPlaceableDoorwaySoloTiles(grid, occupied, claimed, placements, ladders);
      for (const target of members) {
        if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
        placeDoorwaySconce(placements, claimed, target.gridY, target.gridX);
      }
    }

    // ── Anchor C — Per-sector SIGNATURE ACCENT: POI glow pool XOR biome
    //    crystal (ticket 05 / DEC-005 #2). Every sector keeps AT MOST ONE
    //    discretionary accent light — the budget conservation that pays for
    //    the hierarchy (same-or-lower total): a sector whose primary chest
    //    cluster can host a fixture spends the accent on the warm POI pool
    //    (one light per CLUSTER, never per chest — the glints stay); every
    //    other sector keeps its signature crystal at its best motivated spot
    //    (DEEP nook ≥4 wall neighbours in enclosed biomes, DEEP clearing in
    //    OPEN_ARENA), exactly as before. Pure geometry — no RNG draws.
    const crystalRng = new SeededRNG((seed ^ CRYSTAL_PLACEMENT_SALT) >>> 0);
    const poiClusters = primaryChestClusterPerSector(chests);
    const crystalSectors = mapData.sectors;
    for (let sRow = 0; sRow < crystalSectors.length; sRow++) {
      const sectorRow = crystalSectors[sRow];
      if (!sectorRow) continue;
      for (let sCol = 0; sCol < sectorRow.length; sCol++) {
        if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
        const sector = sectorRow[sCol];
        if (!sector) continue;
        const sectorType = sector.type;
        const r0 = sRow * SECTOR_TILE_SIZE;
        const c0 = sCol * SECTOR_TILE_SIZE;
        const isOpen = sectorType === SectorType.OPEN_ARENA;
        // ── POI glow first (the reward layer outranks the mood accent) ──
        const cluster = poiClusters.get(`${sRow},${sCol}`);
        if (cluster) {
          const tile = findPoiGlowTile(grid, occupied, claimed, cluster);
          if (tile && hasUnifiedSpacing(tile.gridY, tile.gridX, 'brazier', placements)) {
            claimed.add(`${tile.gridY},${tile.gridX}`);
            placements.push(buildPoiGlowPlacement(tile));
            continue; // accent spent on the pool — no crystal this sector
          }
          // Unplaceable pool (no eligible tile / spacing) → fall through to
          // the crystal so the sector never loses its accent entirely.
        }
        // ── Signature crystal (unchanged D3 logic) ──
        // Collect this sector's motivated crystal candidates, scored (deeper
        // nook / more-open clearing = better signature spot).
        const sectorCands: Array<{ gridX: number; gridY: number; score: number }> = [];
        for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
          const gridRow = grid[r0 + r];
          if (!gridRow) continue;
          for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
            const gx = c0 + c;
            const gy = r0 + r;
            const tile = gridRow[gx];
            if (tile === undefined || !isWalkableFloorTile(tile)) continue;
            const key = `${gy},${gx}`;
            if (occupied.has(key) || claimed.has(key)) continue;
            if (isOpen) {
              if (
                !hasWallInNeighbourhoodRadius(grid, gy, gx, CRYSTAL_FOREST_CLEARING_WALL_DISTANCE)
              ) {
                sectorCands.push({
                  gridX: gx,
                  gridY: gy,
                  score: countNonWallInRadius(grid, gy, gx, CRYSTAL_FOREST_CLEARING_WALL_DISTANCE),
                });
              }
            } else {
              const walls = countWallNeighbours8(grid, gy, gx);
              if (walls >= CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS) {
                sectorCands.push({ gridX: gx, gridY: gy, score: walls });
              }
            }
          }
        }
        if (sectorCands.length === 0) continue; // sector with no motivated spot
        // Deterministic rank: shuffle (breaks row-major bias), then stable-sort
        // by score desc so the best signature spot wins.
        const ranked = crystalRng.shuffle(sectorCands).sort((a, b) => b.score - a.score);
        const hue = BIOME_CRYSTAL_HUE[sectorType];
        for (const cand of ranked) {
          if (!hasUnifiedSpacing(cand.gridY, cand.gridX, 'biome-glow', placements)) continue;
          claimed.add(`${cand.gridY},${cand.gridX}`);
          // `color` (sector hue) upgrades the sprite to the tinted biome-crystal;
          // radius/intensity/pulse carry the moody tune. textureKey NOT set.
          placements.push({
            gridX: cand.gridX,
            gridY: cand.gridY,
            kind: 'biome-glow',
            anchor: 'crystal',
            color: hue,
            radius: BIOME_CRYSTAL_LIGHT.radius,
            intensity: BIOME_CRYSTAL_LIGHT.intensity,
            pulse: BIOME_CRYSTAL_LIGHT.pulse,
            rotation: 0,
            flipH: false,
            flipV: false,
          });
          break; // ONE signature accent per sector
        }
      }
    }

    // ── Anchor B2 — Route-mid sconces (ticket 05 / DEC-005 #3): line the
    //    sanctioned travel route from gateway to hero landmark. Along each
    //    sector's gateway→landmark lines, at ROUTE_SCONCE_CADENCE intervals,
    //    a sconce fires on the nearest wall-adjacent floor tile — capped per
    //    tier (`routeSconceCap`) and spaced like every sconce. The count is
    //    paid for by the shrunken dark-gap fill (below), keeping the total
    //    same-or-lower. Deterministic: sectors row-major, connections order,
    //    integer line sampling. ─────────────────────────────────────────────
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const params = paramsAt(sRow, sCol);
        let routePlaced = 0;
        const lines = routeLines.get(`${sRow},${sCol}`) ?? [];
        for (const line of lines) {
          if (routePlaced >= params.routeSconceCap) break;
          if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
          for (const sample of routeSamplePoints(line)) {
            if (routePlaced >= params.routeSconceCap) break;
            if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
            // Only line DARK stretches of the road — a sample already near a
            // doorway sconce / pool / crystal / beacon needs no extra lamp
            // (ROUTE_SCONCE_MIN_GAP is the same-or-lower-total governor).
            if (!isDarkGap(sample.gridY, sample.gridX, placements, ROUTE_SCONCE_MIN_GAP)) continue;
            const tile = findRouteSconceTile(grid, occupied, claimed, sample.gridY, sample.gridX);
            if (!tile) continue;
            const sectorType = sectorTypeAt(mapData, sRow, sCol) ?? SectorType.GRID_ARENA;
            if (placeSconceKind(sectorType, tile.gridY, tile.gridX, 'route')) routePlaced++;
          }
        }
      }
    }

    // ── Anchor D — Dark-gap fill (the LAST-resort sconce layer), run LAST.
    //    Ticket 05 / DEC-005 #4: the pass is REMOVED in cold/outer sectors
    //    (`darkGapFillEnabled: false` — deliberate dark pockets between POIs)
    //    and its threshold RAISED elsewhere (per-tier `fillGapSpacing`, 16 in
    //    HOT / 18 in WARM vs the legacy 14) so even lit districts keep thin
    //    dark bands between POIs. Candidates within ROUTE_ADJACENCY_CHEBYSHEV
    //    of a travel line are offered first — the last-resort budget lines
    //    the sanctioned road, and off-route gaps stay dark. ─────────────────
    const candidates = collectWallAdjacentFloorTiles(grid, occupied, claimed);
    const shuffled = rng.shuffle(candidates);
    const ordered = orderFillCandidatesRouteFirst(shuffled, routeLines);
    for (const cand of ordered) {
      if (placements.length >= MAX_MAP_LIGHT_PLACEMENTS) break;
      const sRow = Math.floor(cand.gridY / SECTOR_TILE_SIZE);
      const sCol = Math.floor(cand.gridX / SECTOR_TILE_SIZE);
      const params = paramsAt(sRow, sCol);
      if (!params.darkGapFillEnabled) continue; // COLD/outer: dark pockets stay
      // GAP gate — the closest placed light must be ≥ the per-tier threshold
      // tiles (Manhattan) away. This is the anti-scatter lever: a sconce fires
      // only in a real dark stretch, never as wall wallpaper.
      if (!isDarkGap(cand.gridY, cand.gridX, placements, params.fillGapSpacing)) continue;
      const sectorType = sectorTypeAt(mapData, sRow, sCol) ?? SectorType.GRID_ARENA;
      // Sconce props stand UPRIGHT (rotation 0, no flips) — a torch/brazier/
      // lantern reads as a physical fixture, never upside down or sideways.
      placeSconceKind(sectorType, cand.gridY, cand.gridX, 'fill');
    }

    return placements;
  }
}
