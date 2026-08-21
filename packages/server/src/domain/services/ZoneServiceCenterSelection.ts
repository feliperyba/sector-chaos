import { ZONE, TileType, type SeededRNG } from '@sector-battle/shared';

/**
 * Zone center selection algorithms (ZoneService partial, map-redesign
 * ticket 09 / DEC-008) — the GDD §8.1.6 candidate machinery, split out of
 * the phase machine so each file changes for one reason:
 *
 *  - `selectNextCenter` — the legacy per-phase random walk (phases 2..5).
 *    RNG draw order is IDENTICAL to the pre-ticket inline loop (two draws
 *    per attempt: angle, then sqrt-distributed distance), so the unbiased
 *    stream consumption — and therefore every pinned sequence — is
 *    unchanged.
 *  - `selectBiasedFinalCenter` — the final-phase (5→6) landmark bias: score
 *    GDD-valid candidates by proximity to hero-POI/compound anchors and
 *    pick weighted-random. Near-landmark candidates are preferred; the roll
 *    keeps it a bias, not a guarantee (DEC-008.2, Marcus's dissent
 *    resolution: final phase only).
 */

/**
 * How many valid candidates the final-phase selection scores before the
 * weighted pick. More candidates = stronger pull toward the best-scoring
 * ground; the pick itself stays a weighted RANDOM roll (bias, not force).
 */
const FINAL_BIAS_CANDIDATES = 12;
/**
 * Distance falloff (world px) of the landmark-bias candidate score
 * `1 / (1 + distanceToNearestAnchor / falloff)²`. Scaled to the late-zone
 * geometry (the phase 5→6 search disc is ≤ 0.8 × 512px): the squared
 * falloff makes an on-structure candidate (d ≪ falloff) score ~13× a
 * dead-field candidate one sector away — a decisive but non-forced pull.
 */
const FINAL_BIAS_FALLOFF_PX = 256;

type Center = { x: number; y: number };

/**
 * The shared GDD §8.1.6 search-disc prelude: the new circle must fit the
 * map (2 × newRadius) and the center offset limit is
 * `currentRadius × (1 - MIN_BOUNDARY_RATIO)`. Returns null when the search
 * is degenerate (callers keep the current center — the sanctioned
 * fallback).
 */
function resolveCandidateDisc(
  currentRadius: number,
  newRadius: number,
  worldBounds: { width: number; height: number },
): number | null {
  if (worldBounds.width < 2 * newRadius || worldBounds.height < 2 * newRadius) return null;
  const maxOffset = currentRadius * (1 - ZONE.ZONE_CENTER_MIN_BOUNDARY_RATIO);
  if (maxOffset <= 0 || currentRadius < newRadius) return null;
  return maxOffset;
}

/**
 * Draw ONE random center candidate and validate it (GDD §8.1.6): uniform
 * angle + sqrt-distributed distance within `maxOffset`, NaN guard, boundary
 * clamp so the new circle keeps `newRadius` inside the map, and walkability
 * (EMPTY tile) when a grid is set. Consumes exactly two RNG draws per call
 * (angle, distance) — identical to the legacy inline loop.
 */
function drawCandidate(
  rng: SeededRNG,
  grid: TileType[][] | null,
  currentCenter: Center,
  maxOffset: number,
  newRadius: number,
  worldBounds: { width: number; height: number },
): Center | null {
  const angle = rng.nextFloat() * 2 * Math.PI;
  const distance = Math.sqrt(rng.nextFloat()) * maxOffset;

  let newX = currentCenter.x + Math.cos(angle) * distance;
  let newY = currentCenter.y + Math.sin(angle) * distance;

  if (isNaN(newX) || isNaN(newY)) return null;

  newX = Math.max(newRadius, Math.min(worldBounds.width - newRadius, newX));
  newY = Math.max(newRadius, Math.min(worldBounds.height - newRadius, newY));

  if (grid) {
    const tileSize = worldBounds.width / grid[0]!.length;
    const gridX = Math.floor(newX / tileSize);
    const gridY = Math.floor(newY / tileSize);
    const row = grid[gridY];
    if (row && row[gridX] === TileType.EMPTY) {
      return { x: newX, y: newY };
    }
    return null;
  }

  return { x: newX, y: newY };
}

/** The legacy per-phase center walk: first valid candidate wins. */
export function selectNextCenter(
  rng: SeededRNG,
  grid: TileType[][] | null,
  currentCenter: Center,
  currentRadius: number,
  newRadius: number,
  worldBounds: { width: number; height: number },
): Center {
  const maxOffset = resolveCandidateDisc(currentRadius, newRadius, worldBounds);
  if (maxOffset === null) return { x: currentCenter.x, y: currentCenter.y };

  for (let attempt = 0; attempt < ZONE.ZONE_CENTER_MAX_ATTEMPTS; attempt++) {
    const candidate = drawCandidate(rng, grid, currentCenter, maxOffset, newRadius, worldBounds);
    if (candidate) return candidate;
  }

  return { x: currentCenter.x, y: currentCenter.y };
}

/**
 * Final-phase center selection with the landmark bias (ticket 09 /
 * DEC-008.2): collect up to {@link FINAL_BIAS_CANDIDATES} GDD §8.1.6-valid
 * candidates using the SAME draw mechanics as {@link selectNextCenter},
 * score each by proximity to the nearest landmark anchor
 * (`1 / (1 + distance / FINAL_BIAS_FALLOFF_PX)²`), then pick
 * weighted-random from the phase stream. Falls back to the current center
 * when no valid candidate exists (same as the legacy path). An empty anchor
 * set must not reach this function (the caller keeps the legacy walk).
 */
export function selectBiasedFinalCenter(
  rng: SeededRNG,
  anchors: ReadonlyArray<Center>,
  grid: TileType[][] | null,
  currentCenter: Center,
  currentRadius: number,
  newRadius: number,
  worldBounds: { width: number; height: number },
): Center {
  const maxOffset = resolveCandidateDisc(currentRadius, newRadius, worldBounds);
  if (maxOffset === null) return { x: currentCenter.x, y: currentCenter.y };

  const candidates: Center[] = [];
  for (let attempt = 0; attempt < ZONE.ZONE_CENTER_MAX_ATTEMPTS; attempt++) {
    const candidate = drawCandidate(rng, grid, currentCenter, maxOffset, newRadius, worldBounds);
    if (candidate) {
      candidates.push(candidate);
      if (candidates.length >= FINAL_BIAS_CANDIDATES) break;
    }
  }

  if (candidates.length === 0) {
    return { x: currentCenter.x, y: currentCenter.y };
  }

  const weighted = candidates.map((c) => {
    let nearest = Infinity;
    for (const anchor of anchors) {
      const dx = c.x - anchor.x;
      const dy = c.y - anchor.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearest) nearest = dist;
    }
    return { item: c, weight: 1 / (1 + nearest / FINAL_BIAS_FALLOFF_PX) ** 2 };
  });

  return rng.weightedPick(weighted);
}
