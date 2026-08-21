/**
 * LightPlacerHierarchy — the DEC-005 lighting-hierarchy passes (map-redesign
 * ticket 05): POI glow pools, route-mid sconces, and the per-tier
 * dark-pocket fill parameters. The doorway sconce PAIRS (map-polish ticket
 * 10 — pure-geometry band-end pairs replacing the retired route-biased
 * doorway scoring) live in `LightPlacerDoorway.ts` (F8 split).
 * Mechanical companion to {@link LightPlacer} (F8 file-length discipline: the
 * passes live here, the anchor orchestration stays in the placer).
 *
 * Hierarchy (DEC-005): beacons (ticket 04) > POI glow (reward) > sconce
 * routes (sanctioned travel) > deliberate dark pockets (risk). The budget
 * discipline is SAME-OR-LOWER TOTAL: every new light this module adds is
 * paid for by a light the hierarchy retires (the per-sector accent slot is
 * conserved — a chest-cluster sector spends it on the warm POI pool INSTEAD
 * OF the signature crystal; the dark-gap fill shrinks by the raised/removed
 * per-tier thresholds, funding the route-mid sconces). The ticket-10 doorway
 * pairs are anchor-motivated GEOMETRY, not discretionary spend — the doubled
 * doorway layer is funded by the `MAX_MAP_LIGHT_PLACEMENTS` rebalance
 * (80 → 112), leaving the discretionary budget untouched.
 *
 * Determinism: the POI-glow, doorway-pair and route passes are PURE GEOMETRY
 * (no RNG draws — band-end projection, clustering, centroid relocation, line
 * sampling and tile search are all deterministic functions of the grid). The
 * sconce KIND picks consume the placer's existing isolated light stream in
 * placement order, so same seed ⇒ byte-identical placements.
 */
import {
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  TileType,
  type ChestPlacement,
  type LightPlacementTiled,
  type MapData,
} from '@sector-battle/shared';
import {
  POI_GLOW_CLUSTER_CHEBYSHEV,
  POI_GLOW_LIGHT,
  POI_GLOW_MIN_CHESTS,
  POI_GLOW_SEARCH_RADIUS,
  ROUTE_ADJACENCY_CHEBYSHEV,
  ROUTE_SCONCE_CADENCE,
  ROUTE_SCONCE_SEARCH_RADIUS,
} from './lightHierarchyConfig.js';
import { hasWallNeighbour } from './LightPlacerClassifiers.js';
import { isEligibleFloor } from './LightPlacerDoorway.js';

/** A sector's sanctioned travel line: gateway midpoint → hero landmark anchor (global tiles). */
export interface RouteLine {
  /** Gateway aperture midpoint (global tile coords). */
  fromX: number;
  fromY: number;
  /** Hero landmark anchor (global tile coords). */
  toX: number;
  toY: number;
}

/** Per-sector route lines keyed `"sRow,sCol"` (a sector has one line per gateway). */
export type SectorRouteLines = Map<string, RouteLine[]>;

/**
 * Collect every sector's gateway→landmark travel lines from the map data.
 * For each connection (sector-border aperture) that borders a sector with a
 * hero landmark, the line runs from the aperture midpoint to that sector's
 * anchor — the "sanctioned route" a traveler walks entering the sector.
 * Pure projection; no RNG.
 */
export function collectSectorRouteLines(mapData: MapData): SectorRouteLines {
  const lines: SectorRouteLines = new Map();
  const heroes = mapData.landmarks?.heroes;
  if (!heroes) return lines;
  const add = (row: number, col: number, line: RouteLine) => {
    const key = `${row},${col}`;
    let list = lines.get(key);
    if (!list) {
      list = [];
      lines.set(key, list);
    }
    list.push(line);
  };
  for (const conn of mapData.connections) {
    const midX = Math.floor((conn.positionA.x + conn.positionB.x) / 2 / TILE_PIXEL_SIZE);
    const midY = Math.floor((conn.positionA.y + conn.positionB.y) / 2 / TILE_PIXEL_SIZE);
    for (const sector of [conn.sectorA, conn.sectorB]) {
      const hero = heroes[sector.row]?.[sector.col];
      if (!hero) continue;
      add(sector.row, sector.col, { fromX: midX, fromY: midY, toX: hero.tileX, toY: hero.tileY });
    }
  }
  return lines;
}

/** Chebyshev distance from point (x,y) to the segment (x0,y0)-(x1,y1). */
function chebDistToSegment(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return Math.max(Math.abs(x - px), Math.abs(y - py));
}

/** Min Chebyshev distance from (x,y) to any of the sector's route lines (Infinity if none). */
export function routeAdjacencyDistance(
  lines: RouteLine[] | undefined,
  x: number,
  y: number,
): number {
  if (!lines || lines.length === 0) return Infinity;
  let best = Infinity;
  for (const line of lines) {
    const d = chebDistToSegment(x, y, line.fromX, line.fromY, line.toX, line.toY);
    if (d < best) best = d;
  }
  return best;
}

// ─── POI glow (DEC-005 #2) ────────────────────────────────────────────────────

/** A chest cluster: its member tiles + centroid (global tile coords). */
interface ChestCluster {
  chests: Array<{ gridX: number; gridY: number }>;
  centroidX: number;
  centroidY: number;
  sectorRow: number;
  sectorCol: number;
}

/**
 * Cluster the map's chests per sector (single-linkage, Chebyshev ≤
 * `POI_GLOW_CLUSTER_CHEBYSHEV`). Clusters never span sectors — a hoard is
 * one sector's reward. Deterministic union-find in chest list order.
 */
function clusterChests(chests: ReadonlyArray<ChestPlacement>): ChestCluster[] {
  const bySector = new Map<string, ChestPlacement[]>();
  for (const chest of chests) {
    const row = Math.floor(chest.gridY / SECTOR_TILE_SIZE);
    const col = Math.floor(chest.gridX / SECTOR_TILE_SIZE);
    const key = `${row},${col}`;
    let list = bySector.get(key);
    if (!list) {
      list = [];
      bySector.set(key, list);
    }
    list.push(chest);
  }
  const clusters: ChestCluster[] = [];
  for (const [key, sectorChests] of bySector) {
    const [sectorRow, sectorCol] = key.split(',').map(Number) as [number, number];
    const parent = sectorChests.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < sectorChests.length; i++) {
      for (let j = i + 1; j < sectorChests.length; j++) {
        const a = sectorChests[i]!;
        const b = sectorChests[j]!;
        const d = Math.max(Math.abs(a.gridX - b.gridX), Math.abs(a.gridY - b.gridY));
        if (d <= POI_GLOW_CLUSTER_CHEBYSHEV) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, ChestPlacement[]>();
    for (let i = 0; i < sectorChests.length; i++) {
      const root = find(i);
      let group = groups.get(root);
      if (!group) {
        group = [];
        groups.set(root, group);
      }
      group.push(sectorChests[i]!);
    }
    for (const group of groups.values()) {
      if (group.length < POI_GLOW_MIN_CHESTS) continue; // a lone chest keeps only its glint
      let sumX = 0;
      let sumY = 0;
      for (const chest of group) {
        sumX += chest.gridX;
        sumY += chest.gridY;
      }
      clusters.push({
        chests: group.map((c) => ({ gridX: c.gridX, gridY: c.gridY })),
        centroidX: Math.floor(sumX / group.length),
        centroidY: Math.floor(sumY / group.length),
        sectorRow,
        sectorCol,
      });
    }
  }
  return clusters;
}

/**
 * The per-sector PRIMARY chest cluster (the sector's reward POI): the
 * largest cluster, tie-broken by centroid row-major. Deterministic.
 */
export function primaryChestClusterPerSector(
  chests: ReadonlyArray<ChestPlacement>,
): Map<string, ChestCluster> {
  const primary = new Map<string, ChestCluster>();
  for (const cluster of clusterChests(chests)) {
    const key = `${cluster.sectorRow},${cluster.sectorCol}`;
    const incumbent = primary.get(key);
    if (
      !incumbent ||
      cluster.chests.length > incumbent.chests.length ||
      (cluster.chests.length === incumbent.chests.length &&
        (cluster.centroidY < incumbent.centroidY ||
          (cluster.centroidY === incumbent.centroidY && cluster.centroidX < incumbent.centroidX)))
    ) {
      primary.set(key, cluster);
    }
  }
  return primary;
}

/**
 * Find the POI pool's fixture tile: the eligible floor tile nearest the
 * cluster centroid (Manhattan, row-major tie-break) within the search box
 * that is EITHER wall-adjacent (the sconce motivation) OR within Chebyshev
 * 2 of a cluster chest (the hoard itself motivates the brazier — a pool
 * light beside the treasure it marks). Returns undefined when the whole
 * box is ineligible (the caller falls back to the signature crystal).
 */
export function findPoiGlowTile(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  cluster: {
    chests: Array<{ gridX: number; gridY: number }>;
    centroidX: number;
    centroidY: number;
  },
): { gridX: number; gridY: number } | undefined {
  let best: { gridX: number; gridY: number; dist: number } | undefined;
  for (let dr = -POI_GLOW_SEARCH_RADIUS; dr <= POI_GLOW_SEARCH_RADIUS; dr++) {
    const row = grid[cluster.centroidY + dr];
    if (!row) continue;
    for (let dc = -POI_GLOW_SEARCH_RADIUS; dc <= POI_GLOW_SEARCH_RADIUS; dc++) {
      const c = cluster.centroidX + dc;
      const r = cluster.centroidY + dr;
      if (!isEligibleFloor(grid, occupied, claimed, r, c)) continue;
      const nearHoard = cluster.chests.some(
        (chest) => Math.max(Math.abs(chest.gridX - c), Math.abs(chest.gridY - r)) <= 2,
      );
      if (!hasWallNeighbour(grid, r, c) && !nearHoard) continue;
      const dist = Math.abs(dr) + Math.abs(dc);
      if (!best || dist < best.dist) best = { gridX: c, gridY: r, dist };
    }
  }
  return best ? { gridX: best.gridX, gridY: best.gridY } : undefined;
}

/** Build the POI glow placement (one warm pool per cluster; glints stay per-chest). */
export function buildPoiGlowPlacement(tile: { gridX: number; gridY: number }): LightPlacementTiled {
  return {
    gridX: tile.gridX,
    gridY: tile.gridY,
    kind: 'brazier',
    anchor: 'poi-pool',
    color: POI_GLOW_LIGHT.color,
    radius: POI_GLOW_LIGHT.radius,
    intensity: POI_GLOW_LIGHT.intensity,
    pulse: POI_GLOW_LIGHT.pulse,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

// ─── Route-mid sconces (DEC-005 #3) ───────────────────────────────────────────

/**
 * Sample points along one travel line at `ROUTE_SCONCE_CADENCE` intervals
 * (skipping the gateway end — the doorway sconce covers the threshold).
 * Integer DDA; deterministic.
 */
export function routeSamplePoints(line: RouteLine): Array<{ gridX: number; gridY: number }> {
  const dx = line.toX - line.fromX;
  const dy = line.toY - line.fromY;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const out: Array<{ gridX: number; gridY: number }> = [];
  if (steps < ROUTE_SCONCE_CADENCE) return out;
  for (let i = ROUTE_SCONCE_CADENCE; i < steps; i += ROUTE_SCONCE_CADENCE) {
    const t = i / steps;
    out.push({
      gridX: Math.round(line.fromX + dx * t),
      gridY: Math.round(line.fromY + dy * t),
    });
  }
  return out;
}

/**
 * Find the sconce tile for one route sample: the nearest wall-adjacent
 * eligible floor tile in the search box (Manhattan, row-major tie-break).
 */
export function findRouteSconceTile(
  grid: TileType[][],
  occupied: Set<string>,
  claimed: Set<string>,
  y: number,
  x: number,
): { gridX: number; gridY: number } | undefined {
  let best: { gridX: number; gridY: number; dist: number } | undefined;
  for (let dr = -ROUTE_SCONCE_SEARCH_RADIUS; dr <= ROUTE_SCONCE_SEARCH_RADIUS; dr++) {
    const row = grid[y + dr];
    if (!row) continue;
    for (let dc = -ROUTE_SCONCE_SEARCH_RADIUS; dc <= ROUTE_SCONCE_SEARCH_RADIUS; dc++) {
      const c = x + dc;
      const r = y + dr;
      if (!isEligibleFloor(grid, occupied, claimed, r, c)) continue;
      if (!hasWallNeighbour(grid, r, c)) continue;
      const dist = Math.abs(dr) + Math.abs(dc);
      if (!best || dist < best.dist) best = { gridX: c, gridY: r, dist };
    }
  }
  return best ? { gridX: best.gridX, gridY: best.gridY } : undefined;
}

// ─── Dark-gap fill ordering (DEC-005 #4) ──────────────────────────────────────

/**
 * Partition fill candidates route-adjacent-first (stable): candidates within
 * `ROUTE_ADJACENCY_CHEBYSHEV` of their sector's travel lines are offered to
 * the fill pass BEFORE generic candidates, so the last-resort budget is
 * spent lining the sanctioned road ("sconce line = safe road" while
 * off-route gaps stay dark). Deterministic; preserves the seeded shuffle
 * order within each partition.
 */
export function orderFillCandidatesRouteFirst<T extends { gridX: number; gridY: number }>(
  candidates: T[],
  lines: SectorRouteLines,
): T[] {
  const routeAdjacent: T[] = [];
  const generic: T[] = [];
  for (const cand of candidates) {
    const sRow = Math.floor(cand.gridY / SECTOR_TILE_SIZE);
    const sCol = Math.floor(cand.gridX / SECTOR_TILE_SIZE);
    const sectorLines = lines.get(`${sRow},${sCol}`);
    if (routeAdjacencyDistance(sectorLines, cand.gridX, cand.gridY) <= ROUTE_ADJACENCY_CHEBYSHEV) {
      routeAdjacent.push(cand);
    } else {
      generic.push(cand);
    }
  }
  return [...routeAdjacent, ...generic];
}
