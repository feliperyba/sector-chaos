/**
 * LightingReportBuilder — the benchmark generation-manifest section for the
 * lighting hierarchy (map-redesign ticket 05 / DEC-005): the on-screen
 * light-count sampler and the aggregate report. Mechanical split from
 * LightingDiscipline.ts (F8 file-length retirement) — the discipline gates
 * (hue lint/enforcement, value band, dark pockets) live there; the REPORT
 * that aggregates them for the manifest lives here. Bodies verbatim.
 */
import {
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  TileType,
  isLightPropEntityPlacement,
  type LightPlacementTiled,
  type SectorConnection,
} from '@sector-battle/shared';
import { LIGHT_REPORT_VIEWPORT, POI_GLOW_LIGHT } from './lightHierarchyConfig.js';
import { doorwayPairGeometry } from './LightPlacerDoorway.js';
import {
  auditLightPropBacking,
  deriveExpectedLightBacking,
  type LightPropAuditEntity,
} from './LightPropAudit.js';
import {
  findDarkPockets,
  lintHueDiscipline,
  lintValueBand,
  resolvedRadius,
  type HueEnforcement,
  type HueViolation,
  type ValueBandViolation,
} from './LightingDiscipline.js';

// ─── On-screen budget report (the seed-sample light-count check) ─────────────

/**
 * Sample the worst-case on-screen STATIC light count: slide a
 * `LIGHT_REPORT_VIEWPORT` camera rect (grown by the client budget's 256px
 * halo margin) across the whole map at half-sector steps and count, per
 * viewport, the placements whose light disk intersects it (the same
 * conservative circle-vs-AABB test the client `LightBudget` cull uses).
 * Returns the max count + the sample grid size. The client's ≤80 on-screen
 * target must hold for this static count alone (dynamic auras/VFX are
 * budget-trimmed separately, top-priority-first).
 */
export function sampleMaxViewportStatics(
  placements: ReadonlyArray<LightPlacementTiled>,
  mapWidthTiles: number,
  mapHeightTiles: number,
): { maxCount: number; samples: number } {
  const margin = 256;
  const worldW = mapWidthTiles * TILE_PIXEL_SIZE;
  const worldH = mapHeightTiles * TILE_PIXEL_SIZE;
  const stepX = (SECTOR_TILE_SIZE * TILE_PIXEL_SIZE) / 2;
  const stepY = stepX;
  const xs: number[] = [];
  for (let x = -LIGHT_REPORT_VIEWPORT.width / 2; x <= worldW; x += stepX) xs.push(x);
  const ys: number[] = [];
  for (let y = -LIGHT_REPORT_VIEWPORT.height / 2; y <= worldH; y += stepY) ys.push(y);
  const points = placements.map((p) => ({
    x: p.gridX * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
    y: p.gridY * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
    r: resolvedRadius(p),
  }));
  let maxCount = 0;
  let samples = 0;
  for (const vx of xs) {
    for (const vy of ys) {
      samples++;
      const minX = vx - margin;
      const maxX = vx + LIGHT_REPORT_VIEWPORT.width + margin;
      const minY = vy - margin;
      const maxY = vy + LIGHT_REPORT_VIEWPORT.height + margin;
      let count = 0;
      for (const point of points) {
        const closestX = point.x < minX ? minX : point.x > maxX ? maxX : point.x;
        const closestY = point.y < minY ? minY : point.y > maxY ? maxY : point.y;
        const dx = point.x - closestX;
        const dy = point.y - closestY;
        if (dx * dx + dy * dy <= point.r * point.r) count++;
      }
      if (count > maxCount) maxCount = count;
    }
  }
  return { maxCount, samples };
}

// ─── The lighting report (benchmark generation manifest section) ─────────────

/** The lighting-hierarchy section of the generation manifest (ticket 05). */
export interface LightingReport {
  /** Total static placements on the map (sconce layer + beacons). */
  total: number;
  /** Placements per light kind. */
  byKind: Record<string, number>;
  /** Per-cluster POI glow pool count (pooled, never per chest). */
  poiGlowPools: number;
  /**
   * Doorway sconce PAIRS placed (both band-end sconces present at an
   * aperture) — map-polish ticket 10. One pair per sector-border aperture
   * (24 on a standard 4×4 map) unless interactive props crowd a mouth —
   * those degrade to `doorwayAsymmetric`.
   */
  doorwaySconcePairs: number;
  /**
   * Apertures degraded below a complete pair (no COMMON ladder rung for both
   * members AND at least one member holds no band-end/travel-inward solo
   * rung — sibling-only or unlit — or the ceiling truncated the pass
   * mid-pair). Expected 0; a nonzero count means at least one door lost a
   * flank (e.g. an exit prop + chair crates claiming a mouth's band end and
   * every COMMON rung — the free tiles sit on different rungs, and mixed
   * stepping would break the pair's mirror symmetry).
   */
  doorwayAsymmetric: number;
  /** Residual hue violations (post-enforcement — expected 0). */
  hueViolations: HueViolation[];
  /** Enforcement actions taken (discretionary crystals dropped for the ≤3 gate). */
  hueEnforcements: HueEnforcement[];
  /** Value-band violations (expected 0 — statics never out-value the combat band). */
  valueBandViolations: ValueBandViolation[];
  /** Max static lights any sampled viewport can see (client target: ≤80 on-screen total). */
  maxViewportStatics: number;
  /** Number of viewport samples taken. */
  viewportSamples: number;
  /**
   * Light-prop destructible entities hydrated this map (map-polish ticket
   * 07): the placements with a CONVERTIBLE anchor (route-mid sconces,
   * dark-gap fill, POI glow pools, biome crystals). ≈19–21 on the standard
   * seeds; every one of these has a live `'light'` entity in
   * `state.destructibles`.
   */
  lightPropEntities: number;
  /**
   * Baked (never-converted) exempt placements, broken down (map-polish
   * ticket 07). `doorway` = the corridor-passage sconce pairs (Anchor B —
   * 2/aperture post-E-10); `beacon` = the kind-identified beacon append.
   * Campfires are not listed here — they are entities already (crate
   * backing), neither baked-light nor light-prop entities.
   */
  bakedExemptLights: { doorway: number; beacon: number };
  /**
   * The no-unbacked-lights audit gate's forward count (map-polish ticket 09):
   * non-exempt placements WITHOUT exactly one backing destructible at their
   * tile, per `auditLightPropBacking`. Expected 0 across the seed sweep —
   * every light on the map is either baked-exempt (beacons + doorway sconces
   * ONLY) or entity-backed. A nonzero value means an anchor pass forgot the
   * entity backing (or a placement lost its anchor/duplicated a tile).
   */
  unbackedNonExemptLights: number;
  /** Dark-pocket summary: pocket count, total tiles, sectors holding pockets, COLD-sector pockets. */
  darkPockets: {
    count: number;
    tiles: number;
    sectorsWithPockets: number;
    coldSectorPockets: number;
  };
}

/**
 * Whether a placement is a sconce-family fixture that could be a doorway
 * sconce (campfires are Anchor-A 1:1 sources, biome-glow crystals are Anchor
 * C accents, beacons are the ticket-04 append, and braziers carrying the POI
 * pool overrides are the ticket-05 reward layer — none of them are the
 * doorway pair).
 */
function isDoorwaySconceKind(p: LightPlacementTiled): boolean {
  if (p.kind === 'campfire' || p.kind === 'biome-glow' || p.kind === 'beacon') return false;
  if (
    p.kind === 'brazier' &&
    p.intensity === POI_GLOW_LIGHT.intensity &&
    p.radius === POI_GLOW_LIGHT.radius
  ) {
    return false; // the POI glow pool, not a sconce
  }
  return true;
}

/**
 * Audit the doorway sconce pairs against the map's connections (map-polish
 * ticket 10): for every aperture, each band end counts as lit when a
 * sconce-family placement sits within Manhattan 1 of it (the band-end tile
 * itself or any documented fallback rung). Both ends lit ⇒ a pair; any other
 * outcome (sibling-only, or fully blocked) ⇒ asymmetric (degraded). Pure
 * geometric derivation from the final placement list + the connection
 * records — deterministic, JSON-safe.
 */
function auditDoorwayPairs(
  placements: ReadonlyArray<LightPlacementTiled>,
  connections: ReadonlyArray<SectorConnection>,
): { doorwaySconcePairs: number; doorwayAsymmetric: number } {
  let doorwaySconcePairs = 0;
  let doorwayAsymmetric = 0;
  for (const conn of connections) {
    const { bandEnds } = doorwayPairGeometry(conn);
    let litEnds = 0;
    for (const end of bandEnds) {
      const lit = placements.some(
        (p) =>
          isDoorwaySconceKind(p) &&
          Math.abs(p.gridY - end.gridY) + Math.abs(p.gridX - end.gridX) <= 1,
      );
      if (lit) litEnds++;
    }
    if (litEnds === bandEnds.length) doorwaySconcePairs++;
    else doorwayAsymmetric++;
  }
  return { doorwaySconcePairs, doorwayAsymmetric };
}

/**
 * Build the lighting report from the FINAL placement list (post hue
 * enforcement) + the map grid. `tierOf` (optional, effective tier incl. the
 * per-match hot upgrade) splits the dark-pocket stats by COLD sectors — the
 * DEC-005 mood guarantee that cold/outer districts keep the deepest dark.
 * `connections` (optional, the map's sector-border apertures) drives the
 * doorway sconce-pair audit (ticket 10). `hydratedDestructibles` (optional,
 * map-polish ticket 09) — the live hydrated destructible entities — drives
 * the no-unbacked-lights audit's forward count; when absent the expected
 * backing is DERIVED from the placements + grid via the deterministic
 * hydration rules (still catches placements the rules will never back).
 * Deterministic; JSON-safe for the manifest.
 */
export function buildLightingReport(
  placements: ReadonlyArray<LightPlacementTiled>,
  grid: TileType[][],
  enforcements: ReadonlyArray<HueEnforcement> = [],
  tierOf?: (row: number, col: number) => 'HOT' | 'WARM' | 'COLD',
  connections: ReadonlyArray<SectorConnection> = [],
  hydratedDestructibles?: ReadonlyArray<LightPropAuditEntity>,
): LightingReport {
  const byKind: Record<string, number> = {};
  let poiGlowPools = 0;
  // Map-polish ticket 07 — converted-vs-exempt census: the anchor provenance
  // (not the kind) discriminates the light-prop entity set.
  let lightPropEntities = 0;
  let exemptDoorway = 0;
  let exemptBeacon = 0;
  for (const p of placements) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    if (isLightPropEntityPlacement(p)) lightPropEntities++;
    if (p.anchor === 'doorway') exemptDoorway++;
    if (p.kind === 'beacon') exemptBeacon++;
    // The POI pool signature: a brazier carrying the authored pool overrides.
    if (
      p.kind === 'brazier' &&
      p.intensity === POI_GLOW_LIGHT.intensity &&
      p.radius === POI_GLOW_LIGHT.radius
    ) {
      poiGlowPools++;
    }
  }
  const height = grid.length;
  const width = height > 0 ? grid[0]!.length : 0;
  const pockets = findDarkPockets(grid, placements);
  const sectorsWithPockets = new Set(pockets.map((p) => `${p.sectorRow},${p.sectorCol}`));
  const coldSectorPockets = tierOf
    ? [...sectorsWithPockets].filter((key) => {
        const [row, col] = key.split(',').map(Number) as [number, number];
        return tierOf(row, col) === 'COLD';
      }).length
    : 0;
  const viewport = sampleMaxViewportStatics(placements, width, height);
  // Map-polish ticket 09 — the no-unbacked-lights audit gate rides the
  // manifest: forward count of non-exempt placements without exactly one
  // backing destructible at their tile (expected 0 on every seed).
  const audit = auditLightPropBacking(
    placements,
    hydratedDestructibles ?? deriveExpectedLightBacking(placements, grid),
  );
  return {
    total: placements.length,
    byKind,
    poiGlowPools,
    ...auditDoorwayPairs(placements, connections),
    hueViolations: lintHueDiscipline(placements),
    hueEnforcements: [...enforcements],
    valueBandViolations: lintValueBand(placements),
    maxViewportStatics: viewport.maxCount,
    viewportSamples: viewport.samples,
    lightPropEntities,
    bakedExemptLights: { doorway: exemptDoorway, beacon: exemptBeacon },
    unbackedNonExemptLights: audit.unbackedNonExemptLights.length,
    darkPockets: {
      count: pockets.length,
      tiles: pockets.reduce((sum, p) => sum + p.size, 0),
      sectorsWithPockets: sectorsWithPockets.size,
      coldSectorPockets,
    },
  };
}
