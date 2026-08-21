/**
 * LightPlacerDoorway — the doorway sconce-PAIR geometry (map-polish ticket
 * 10: "a light at each side of every passage"). Mechanical split from
 * LightPlacerHierarchy.ts (F8 file-length discipline): the pair projection,
 * the deterministic fallback ladder and the placeability scan live here; the
 * anchor orchestration stays in {@link LightPlacer}.
 *
 * Every `mapData.connections` aperture — a 3-tile opening band carved by
 * `SectorConnector` at local rows/cols 9-11 — carries TWO sconces: one at
 * EACH end of the opening band, both on sector A's threshold face,
 * mirror-symmetric about the aperture axis (the identity pass's
 * `gatewayMidpoint` centerline), identical in offset across corridors. The
 * pre-ticket pass anchored its search at `positionA` (the band's FIRST
 * tile — a CORNER) and scored a 5×5 box; this module replaces that with the
 * pure geometric derivation below.
 *
 * Determinism (ADR-0035): everything here is a pure function of the
 * connection record + the grid — ZERO RNG draws for POSITION. The sconce
 * KIND is FIXED for every doorway placement (map-polish round-2 ticket 18 —
 * see {@link DOORWAY_SCONCE_KIND}); the doorway anchor consumes NO stream
 * draws at all.
 *
 * Fallback semantics (map-polish ticket-10 ADDENDUM repair): when a band-end
 * member is unplaceable the pair steps TOGETHER through the ladder rungs —
 * BOTH members advance to the same rung (outward one tile along the opening
 * axis, then travel-inward one tile), a rung being void only when the SIBLING
 * cannot take it too — so mirror symmetry about the aperture axis and the
 * 2-lights-per-passage guarantee both hold. With no common rung the aperture
 * falls back to per-member solo rungs (band end → travel-inward); sibling-only
 * (single light, counted in `doorwayAsymmetric`) happens only when a member
 * finds no common rung AND no solo rung. The superseded per-member mirror
 * guard (which unconditionally voided the outward rung for a solo member) is
 * gone: the outward rung is live, gated on the sibling taking it too.
 */
import {
  TILE_PIXEL_SIZE,
  TileType,
  type LightKind,
  type LightPlacementTiled,
  type SectorConnection,
} from '@sector-battle/shared';
import { DOORWAY_FALLBACK_REACH, DOORWAY_PAIR_BAND_END_OFFSET } from './lightHierarchyConfig.js';
import { hasUnifiedSpacing, isWalkableFloorTile } from './LightPlacerClassifiers.js';

// ─── Ticket 18 — ONE prop, ONE tone for every doorway sconce ──────────────────

/**
 * The FIXED light-prop kind for EVERY doorway-anchor sconce (map-polish
 * round-2 ticket 18: "The corridor lights must be the same light prop with
 * the same light color tone"). Pre-ticket the kind was drawn PER-PLACEMENT
 * from the isolated salted light stream (round-1 ticket 10 deliberately kept
 * that draw), so the two members of a pair — and the sconces across the 24
 * corridors — rendered as up to FIVE different props with different palette
 * tones: 14–18 of the 24 pairs per standard seed were mixed-kind (a torch
 * beside a candle, a brazier beside a lantern...), and candle [1.0, 0.85, 0.5]
 * + lantern [1.0, 0.7, 0.35] read GOLD against the orange fire family.
 *
 * Why `torch`:
 *   - The threshold archetype — the anchor's own contract phrase is "the
 *     torch by the door" (see `isDoorwayTilePlaceable`); a torch IS the door
 *     sconce.
 *   - The plurality kind today (18–19 of the 47–48 doorway sconces per
 *     standard seed), so fixing on torch preserves the corridor illumination
 *     character for most apertures — the alternative `lantern` would dim
 *     every corridor 256px/1.9 → 140px/1.3 (a visibility regression the
 *     ticket never asked for).
 *   - The ONLY kind weighted in ALL FOUR district sconce tables
 *     (`SECTOR_WALL_BRACKET_KIND_WEIGHTS`), so the fixed prop reads native in
 *     every district — no foreign fixture in any theme.
 */
export const DOORWAY_SCONCE_KIND: LightKind = 'torch';

/**
 * The FIXED light color tone for every doorway-anchor sconce (ticket 18) —
 * linear RGB, the MAIN-MENU REGISTRY's unified warm-fire tone
 * (`menuDioramaPlacements.TONE_WARM`, byte-equal to the client
 * `LightPalette` warm fire + the discipline's FIRE_COLOR mirror). Emitted as
 * an explicit per-placement `color` override so the tone is pinned in the
 * DATA (immune to future torch-palette drift), not merely the kind default.
 *
 * Why this tone:
 *   - Hue ≈ 25°, squarely inside the 'warm' family band [0°, 60°) — the
 *     family every other fire sconce, the POI glow pools (≈34°) and the
 *     RESOURCE_RICH gold beacons (≈43°) already share — so the uniform tone
 *     can NEVER introduce a 4th hue family to a viewport (the ≤3-families
 *     gate stays 0; a uniform tone helps it).
 *   - Reads cohesively against ALL FOUR district themes: warm orange is
 *     complementary to GRID's steel-blue + MAZE's violet (the passages warm
 *     the cool districts' thresholds without fighting them), naturally
 *     firelit against OPEN_ARENA's green, and analogous with RESOURCE_RICH's
 *     gold — ONE "passage light" system map-wide, exactly as the menu
 *     dioramas read (every warm fixture there is forced to this same tone).
 *   - Radius/intensity stay the torch kind defaults (256px / 1.9 — no
 *     override): 1.9 ≤ STATIC_VALUE_CEILING (2.6) so the value-band gate
 *     stays 0, and the menu's 1.4–1.75 "support" intensities are menu-LOCAL
 *     chiaroscuro tuning, not the gameplay sconce tune.
 */
export const DOORWAY_SCONCE_COLOR: readonly [number, number, number] = [1.0, 0.55, 0.22];

/**
 * Place ONE doorway sconce with the ticket-18 FIXED kind + tone —
 * {@link DOORWAY_SCONCE_KIND} ('torch') + {@link DOORWAY_SCONCE_COLOR}, the
 * SAME prop + the SAME tone for BOTH members of every pair and every
 * corridor ("one prop, one tone"). Ticket 18 REMOVED the per-placement kind
 * draw from the isolated light stream for the doorway anchor — the draw was
 * the root cause of the owner's "2 random pieces" read (both pair members
 * drew independently, so 14–18 of the 24 pairs per seed mixed two props
 * with two palette tones). The removal shifts the stream for every later
 * draw (route/fill kind picks + the fill-pass shuffle) — the sanctioned
 * ticket-18 cascade. The fixed doorway kind is NOT counted in the placer's
 * `wallBracketKindCounts` (like campfires, it is not a DRAW) — the diversity
 * down-weighting governs the DRAWN sconce family only (feeding 47–48 fixed
 * torches into that signal would either ban torch from routes/fills via the
 * dominance ceiling or mask a genuine runaway). Zero RNG; the spacing check
 * uses the FIXED kind, so it exactly agrees with the ladder pre-check in
 * {@link isDoorwayTilePlaceable} (which probes the same fixed kind).
 */
export function placeDoorwaySconce(
  placements: LightPlacementTiled[],
  claimed: Set<string>,
  gridY: number,
  gridX: number,
): boolean {
  if (!hasUnifiedSpacing(gridY, gridX, DOORWAY_SCONCE_KIND, placements)) return false;
  claimed.add(`${gridY},${gridX}`);
  placements.push({
    gridX,
    gridY,
    kind: DOORWAY_SCONCE_KIND,
    anchor: 'doorway',
    color: DOORWAY_SCONCE_COLOR,
    rotation: 0,
    flipH: false,
    flipV: false,
  });
  return true;
}

/** One candidate rung tile of a doorway band-end ladder (pure geometry). */
export type DoorwayRung = { gridX: number; gridY: number };

/**
 * The two band-end ladders of one aperture, indexed by member (band-end
 * ascending) and consumed rung-by-rung in lockstep by the coordinated pair
 * scan / per-member solo fallback below.
 */
export type DoorwayLadderPair = readonly [ReadonlyArray<DoorwayRung>, ReadonlyArray<DoorwayRung>];

/** The derived pure-geometry contract of one connection's doorway sconce pair. */
export interface DoorwayPairGeometry {
  /**
   * The axis the 3-tile opening band runs along: `'row'` for a horizontal
   * sector pair (band spans rows on A's border column), `'col'` for a
   * vertical pair (band spans cols on A's border row).
   */
  openingAxis: 'row' | 'col';
  /**
   * The two BAND-END threshold tiles (both on sector A's border face),
   * opening-axis ascending. Pure projection of the connection record: the
   * `positionA` tile (the band's first tile — `SectorConnector` records
   * `offsets[0]` = local 9) and that tile shifted `width − 1` along the
   * opening axis (local 11). Zero RNG.
   */
  bandEnds: [{ gridX: number; gridY: number }, { gridX: number; gridY: number }];
  /**
   * The aperture-axis centerline coordinate (global row for `'row'`, col for
   * `'col'`) — the identity pass's `gatewayMidpoint` centerline the pair is
   * mirror-symmetric about.
   */
  axisCenter: number;
  /**
   * Unit step INWARD along the travel axis (into sector A, off the seam):
   * `{ dRow: 0, dCol: -1 }` for horizontal pairs, `{ dRow: -1, dCol: 0 }` for
   * vertical pairs. The fallback ladder's rung-2 direction.
   */
  travelInward: { dRow: number; dCol: number };
}

/**
 * Derive one aperture's doorway sconce-pair geometry from its connection
 * record — the PURE GEOMETRIC half of ticket 10 (zero RNG, ADR-0035).
 * Horizontal vs vertical is read off the sector pair (`sectorB` is
 * east/south of `sectorA` by `SectorConnector` construction); the band ends
 * read off `positionA` + `width`. The threshold face is always sector A's
 * border tile, where the pre-ticket single sconce already sat.
 */
export function doorwayPairGeometry(conn: SectorConnection): DoorwayPairGeometry {
  const horizontal = conn.sectorA.row === conn.sectorB.row;
  const baseRow = Math.floor(conn.positionA.y / TILE_PIXEL_SIZE);
  const baseCol = Math.floor(conn.positionA.x / TILE_PIXEL_SIZE);
  // Band center = the positionA tile (the band's FIRST tile, local 9) shifted
  // (width−1)/2 along the opening axis (local 10 for the 3-tile band); the
  // band ends are that center ± DOORWAY_PAIR_BAND_END_OFFSET (local 9/11).
  const center = (conn.width - 1) / 2;
  if (horizontal) {
    const axisRow = baseRow + center;
    return {
      openingAxis: 'row',
      bandEnds: [
        { gridX: baseCol, gridY: axisRow - DOORWAY_PAIR_BAND_END_OFFSET },
        { gridX: baseCol, gridY: axisRow + DOORWAY_PAIR_BAND_END_OFFSET },
      ],
      axisCenter: axisRow,
      travelInward: { dRow: 0, dCol: -1 },
    };
  }
  const axisCol = baseCol + center;
  return {
    openingAxis: 'col',
    bandEnds: [
      { gridX: axisCol - DOORWAY_PAIR_BAND_END_OFFSET, gridY: baseRow },
      { gridX: axisCol + DOORWAY_PAIR_BAND_END_OFFSET, gridY: baseRow },
    ],
    axisCenter: axisCol,
    travelInward: { dRow: -1, dCol: 0 },
  };
}

/**
 * The deterministic eligibility-fallback ladder for ONE band end (documented
 * order, zero RNG — replaces the retired 5×5 route-biased scoring). The rungs
 * are PAIR rungs, consumed COORDINATED (see {@link firstPlaceableDoorwayPair}):
 *   rung 0 — the band-end tile itself;
 *   rung 1 — one tile OUTWARD along the opening axis (the shoulder, deeper
 *            into the flanking wall band; away from the sibling);
 *   rung 2 — one tile INWARD along the travel axis (off the seam, into
 *            sector A; also away from the sibling).
 * Both members of a pair always take the SAME rung, so every rung is
 * mirror-symmetric about the aperture axis by construction and keeps
 * Manhattan ≥ LIGHT_MIN_SPACING between the members (rungs 0 and 2 sit
 * exactly 2 apart; rung 1 sits 4 apart) — the pair's internal spacing
 * discipline holds with NO exemption at every rung.
 */
export function doorwayBandEndLadder(
  geometry: DoorwayPairGeometry,
  bandEndIndex: 0 | 1,
): Array<{ gridX: number; gridY: number }> {
  const end = geometry.bandEnds[bandEndIndex];
  const outward = (bandEndIndex === 0 ? -1 : 1) * DOORWAY_FALLBACK_REACH;
  const inward = geometry.travelInward;
  const rungs: Array<{ gridX: number; gridY: number }> = [{ ...end }];
  if (geometry.openingAxis === 'row') {
    rungs.push({ gridX: end.gridX, gridY: end.gridY + outward });
    rungs.push({ gridX: end.gridX + inward.dCol, gridY: end.gridY + inward.dRow });
  } else {
    rungs.push({ gridX: end.gridX + outward, gridY: end.gridY });
    rungs.push({ gridX: end.gridX + inward.dCol, gridY: end.gridY + inward.dRow });
  }
  return rungs;
}

/**
 * Whether ONE doorway rung tile is placeable: eligible floor (walkable
 * EMPTY, unclaimed by the interactive/wall layers and prior lights) holding
 * the unified spacing discipline. The doorway anchor does NOT require a wall
 * neighbour — the THRESHOLD is the motivation (the "torch by the door": open
 * sector borders leave several band-end mouth tiles genuinely wall-free, and
 * the ticket-10 contract places the sconces AT the band-end tiles). Every
 * light placed before the doorway pass is a fire kind (campfires) and every
 * doorway sconce is the FIXED `DOORWAY_SCONCE_KIND` fire kind (ticket 18),
 * so the binding minimum is `LIGHT_MIN_SPACING` regardless of kind — checked
 * here against the FIXED kind itself, so the placer's own post-pick spacing
 * check can never disagree (the pre-ticket-18 "representative fire kind"
 * probe is now literally the kind placed). (The superseded per-member
 * MIRROR-SYMMETRY filter is gone — symmetry now comes from coordinated
 * stepping: both members of a pair always take the same rung.) Pure geometry;
 * no RNG.
 */
export function isDoorwayTilePlaceable(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  placed: ReadonlyArray<LightPlacementTiled>,
  tile: DoorwayRung,
): boolean {
  return (
    isEligibleFloor(grid, occupied, claimed, tile.gridY, tile.gridX) &&
    hasUnifiedSpacing(tile.gridY, tile.gridX, 'torch', placed)
  );
}

/**
 * COORDINATED pair stepping (map-polish ticket-10 ADDENDUM repair): walk the
 * two band-end ladders' rungs IN LOCKSTEP — rung k is placeable only when
 * BOTH members can take it; if either member's rung-k tile is unplaceable,
 * BOTH advance to rung k+1. The pair is placed at the first rung both hold,
 * so a complete pair is ALWAYS mirror-symmetric about the aperture axis by
 * construction (rungs 0/2 keep the band-end axis distance ±1 on opposite
 * sides; rung 1 puts both members at axis distance 2 on opposite sides) and
 * the members stay ≥ LIGHT_MIN_SPACING apart at every rung (exactly 2 on
 * rungs 0/2, 4 on rung 1 — placing member 0 first can never invalidate
 * member 1). Both members are evaluated against the placement list AS-IS
 * (before either is placed). Returns undefined when NO rung is placeable
 * for both members — the aperture falls back to the per-member solo rungs
 * ({@link firstPlaceableDoorwaySoloTiles}, audited as `doorwayAsymmetric`
 * when a member finds no solo rung either). Pure geometry; no RNG.
 */
export function firstPlaceableDoorwayPair(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  placed: ReadonlyArray<LightPlacementTiled>,
  ladders: DoorwayLadderPair,
): { tiles: [DoorwayRung, DoorwayRung] } | undefined {
  const rungCount = Math.min(ladders[0].length, ladders[1].length);
  for (let rung = 0; rung < rungCount; rung++) {
    const member0 = ladders[0][rung]!;
    const member1 = ladders[1][rung]!;
    if (!isDoorwayTilePlaceable(grid, occupied, claimed, placed, member0)) continue;
    if (!isDoorwayTilePlaceable(grid, occupied, claimed, placed, member1)) continue;
    return {
      tiles: [
        { gridX: member0.gridX, gridY: member0.gridY },
        { gridX: member1.gridX, gridY: member1.gridY },
      ],
    };
  }
  return undefined;
}

/**
 * The per-member SOLO fallback (the ticket-10 addendum escape hatch): when NO
 * rung is placeable for BOTH members, each member walks its own solo ladder —
 * band end → travel-inward (rungs 0 and 2). The OUTWARD rung is excluded: it
 * is a coordinated rung, live only when the sibling takes it too (the
 * addendum's gate), and it is also the only rung that moves a member's
 * opening-axis coordinate — every solo rung preserves it, so even a mixed
 * solo pair (one member on its band end, the other travel-inward — the
 * seeds 1/42 chest-crowded mouths) still holds the mirror-symmetry
 * invariant (equal axis distance, opposite sides) and lights both ends.
 * Returns each member's first placeable solo rung in band-end-ascending
 * member order (0–2 tiles; the placer places them in this order). An
 * aperture degrades to sibling-only (single light, `doorwayAsymmetric`)
 * exactly when at least one member finds NO solo rung; a fully blocked
 * mouth places nothing. Pure geometry; no RNG.
 */
export function firstPlaceableDoorwaySoloTiles(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  placed: ReadonlyArray<LightPlacementTiled>,
  ladders: DoorwayLadderPair,
): DoorwayRung[] {
  const survivors: DoorwayRung[] = [];
  for (const member of [0, 1] as const) {
    for (const rung of [0, 2] as const) {
      const tile = ladders[member][rung];
      if (tile && isDoorwayTilePlaceable(grid, occupied, claimed, placed, tile)) {
        survivors.push({ gridX: tile.gridX, gridY: tile.gridY });
        break; // this member holds a solo rung — on to the sibling
      }
    }
  }
  return survivors;
}

/**
 * Whether a tile is eligible for a fire-fixture sconce/pool light: walkable
 * EMPTY floor, unclaimed by the interactive/wall layers and prior lights.
 * (Shared with LightPlacerHierarchy's POI-glow / route-sconce searches —
 * exported so the doorway scan holds the identical predicate.)
 */
export function isEligibleFloor(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  r: number,
  c: number,
): boolean {
  const row = grid[r];
  const tile = row?.[c];
  if (tile === undefined || !isWalkableFloorTile(tile)) return false;
  const key = `${r},${c}`;
  return !occupied.has(key) && !claimed.has(key);
}
