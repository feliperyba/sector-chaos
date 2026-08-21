/**
 * Wall composition SEED SWEEP (map-polish ticket 14) — the committed evidence
 * that the wall pipeline's composition rules hold over a broad deterministic
 * seed set, run through the REAL pipeline (`MapGenerator.generate` →
 * `SeedMapAdapter.adapt` → `map_border_walls` + `wall_fill` → shared
 * `validateWallComposition`).
 *
 * Seeds: 1..50 plus {999, 12345, 0xdeadbeef} (superset of the ticket-13 gate
 * set). Measured state this sweep pins (post WallCompositionPass, 53 seeds):
 *
 * - seamViolations 0 and interiorViolations bounded: 48 total residuals
 *   (ticket-28 re-measure), every
 *   one CLASSIFIED pure-destructible T-stem (both tiles DESTRUCTIBLE_WALL, at
 *   least one in T topology) — the documented D5 art-coverage exception (the
 *   strip kit has no T piece; brute-force-proven unrepresentable in ticket 13's
 *   60-seed sweep, 36 residuals there; ticket-14 measured 32). A residual that
 *   fails the classifier
 *   is a REPRESENTABLE defect and fails this test — never widen the classifier
 *   to pass; fix the defect.
 * - cornerDanglingViolations 0 (ticket 20): every wall tile whose only
 *   wall-like attachment is diagonal renders corner-hugging art (or the
 *   art-axis diagonal piece) — the corner-dangling re-role
 *   (`WallVisualSelectorCorners`). Pre-fix this measured 91 violations across
 *   the 5-seed probe set (floating-strip staircases/pairs); post-fix 0.
 * - orphanStubWalls 0: no unsanctioned orphan 1-tile indestructible stubs. The
 *   sanctioned class (1×1 maze separator residue — the authored maze pillar
 *   topology) is exempted via `collectSanctionedStubCells` and reported as
 *   telemetry (413 cells across the ticket-28 sweep).
 * - destructibleShardCount 0: standing breakable WALL cover is always in
 *   ≥2-tile clusters (orphans became crates in the composition pass).
 * - Seam thick-fill coverage: every interior seam-line pair where both tiles
 *   are walls is closed by the `wall_fill` thick-wall pattern (both tiles
 *   indestructible → ≥1 fill) or is a both-destructible pair (unfillable by
 *   design — a destroyed wall must not leave baked fill behind — the strips
 *   meet on the seam via the 'partner' facing). Pinned exception bound: 5
 *   band-connected junction read-outs (world-edge ring tiles at seam
 *   intersections; gate-jamb dominoes), each still continuity-clean via
 *   seamViolations === 0.
 *
 * If this sweep goes red: a composition rule, the fill rule, the facing rules
 * or determinism regressed — do NOT bump the integers back up without
 * re-classifying every residual.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator,
  TileType,
  collectSanctionedStubCells,
  isPureDestructibleTStemPair,
  validateWallComposition,
  type TileSpriteDef,
  type TileVisual,
} from '@sector-battle/shared';
import { SeedMapAdapter } from '../SeedMapAdapter.ts';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

/** The deterministic sweep set: seeds 1..50 plus the standard probe seeds. */
const SEEDS = [...Array.from({ length: 50 }, (_, i) => i + 1), 999, 12345, 0xdeadbeef];

/**
 * Pinned bound for pure-destructible T-stem residuals (D5 art class) across
 * the whole sweep. Ticket-28 re-measure (interior scatter fills removed, prefab
 * pass promoted to primary composer at caps 5/5/3/5): 48, all 53 seeds
 * re-classified pure-destructible T-stem (more stamped wall runs ⇒ more T
 * junctions — the D5 strip-kit gap, not a representable defect). Measured
 * history: 36 (ticket 13's 60-seed sweep), 32 (ticket 14), 48 (ticket 28).
 */
const T_STEM_RESIDUAL_BOUND = 48;
/** Per-seed residual bound (ticket-28 measured max: 5, seed 48). */
const T_STEM_RESIDUAL_PER_SEED_BOUND = 5;
/**
 * Pinned bound for all-indestructible seam pairs carrying no fill — the
 * band-connected junction read-outs (world-edge seam intersections, gate-jamb
 * dominoes). Ticket-28 re-measure: 5 across the sweep (all band-connected,
 * seamViolations === 0 holds).
 *
 * Round-5e re-measure: 22 across the sweep. The post-stamp border-buffer
 * re-clean (`MapGenerator`, after the prefab + plaza-keep passes) removes the
 * walls that used to BURY seam-run end tiles at corridor junctions — those
 * ends now classify as the correct unfilled JAMBS (outer_corner / notch
 * straights with the corridor floor wrapping them) instead of filled buried
 * cells, so the exception count rose. Every one remains band-connected
 * (seamViolations === 0 holds above — the sweep's actual continuity gate),
 * and the flagged pairs repeat at the same coordinates across seeds (the
 * deterministic seam × corridor junctions), not scattered mid-seam.
 */
const SEAM_FILL_EXCEPTION_BOUND = 22;
/**
 * Pinned bound for art-limited checkerboard corner cells (ticket 20): a
 * corner-dangling tile with a wall-like diagonal in ALL FOUR quadrants — no
 * single atlas frame solidifies four corner quadrants (the convex L covers
 * three), so the best hug leaves one corner open. Ticket-28 re-measure: 0
 * across the sweep (was 1, seed 11).
 */
const CORNER_ART_LIMITED_BOUND = 1;
/** Interior sector seam lines of the 4×4 sector composite (cols/rows 19|20, 39|40, 59|60). */
const SEAM_LINES = [19, 39, 59];
/** Composite map size (4 sectors × 20 tiles). */
const MAP_SIZE = 80;

const generator = new MapGenerator();
const adapter = new SeedMapAdapter();

/** Memoized per-seed pipeline sample (the sweep reads each seed once). */
const sampleCache = new Map<number, SweepSample>();

interface SweepSample {
  wallCells: (TileVisual | null)[][];
  fillCells: (TileVisual | null)[][];
  audit: ReturnType<typeof validateWallComposition>;
  seamFillExceptions: Array<{ r1: number; c1: number; r2: number; c2: number }>;
  fillTileErrors: string[];
  grid: TileType[][];
}

function sampleSeed(seed: number): SweepSample {
  const cached = sampleCache.get(seed);
  if (cached) return cached;

  const mapData = generator.generate(seed);
  const enriched = adapter.adapt(mapData, seed, TILED_DIR);
  const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
  const fillLayer = enriched.visualLayers.find((l) => l.name === 'wall_fill')!;
  const audit = validateWallComposition(enriched.grid, wallLayer.cells, {
    fillCells: fillLayer.cells,
    atlasSprites: enriched.atlas.sprites,
    sanctionedStubCells: collectSanctionedStubCells(mapData.sectors),
  });

  // Fill invariants: fills sit only on INDESTRUCTIBLE_WALL tiles and use
  // TileType.EMPTY-typed frames (no collision / no destroyed-wall residue).
  const defsById = new Map<number, TileSpriteDef>(enriched.atlas.sprites.map((s) => [s.id, s]));
  const fillTileErrors: string[] = [];
  for (let r = 0; r < enriched.height; r++) {
    for (let c = 0; c < enriched.width; c++) {
      const cell = fillLayer.cells[r]![c];
      if (!cell) continue;
      if (enriched.grid[r]![c] !== TileType.INDESTRUCTIBLE_WALL) {
        fillTileErrors.push(`(${r},${c}) on ${TileType[enriched.grid[r]![c]!]}`);
      }
      if (defsById.get(cell.spriteId)?.tileType !== TileType.EMPTY) {
        fillTileErrors.push(`(${r},${c}) non-EMPTY frame`);
      }
    }
  }

  // Seam thick-fill coverage (composition telemetry): every interior seam-line
  // pair with walls on both sides is filled, both-destructible (partner
  // facing), or a pinned junction-read exception.
  const seamFillExceptions: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];
  const isWallTile = (t: number): boolean =>
    t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL;
  for (const line of SEAM_LINES) {
    for (let i = 0; i < MAP_SIZE; i++) {
      const pairs: Array<[number, number, number, number]> = [
        [i, line, i, line + 1], // vertical seam (cols line | line+1)
        [line, i, line + 1, i], // horizontal seam (rows line | line+1)
      ];
      for (const [r1, c1, r2, c2] of pairs) {
        const a = enriched.grid[r1]![c1]!;
        const b = enriched.grid[r2]![c2]!;
        if (!isWallTile(a) || !isWallTile(b)) continue;
        if (a === TileType.DESTRUCTIBLE_WALL && b === TileType.DESTRUCTIBLE_WALL) continue;
        if (fillLayer.cells[r1]![c1] || fillLayer.cells[r2]![c2]) continue;
        seamFillExceptions.push({ r1, c1, r2, c2 });
      }
    }
  }

  const sample: SweepSample = {
    wallCells: wallLayer.cells,
    fillCells: fillLayer.cells,
    audit,
    seamFillExceptions,
    fillTileErrors,
    grid: enriched.grid,
  };
  sampleCache.set(seed, sample);
  return sample;
}

describe('wall composition sweep (ticket 14) — zero-violation regression lock', () => {
  it('every seed: zero seam violations, zero unsanctioned orphan stubs, zero shards', () => {
    for (const seed of SEEDS) {
      const { audit } = sampleSeed(seed);
      expect(
        audit.seamViolations,
        `seed ${seed} seam violations: ${JSON.stringify(audit.violations.slice(0, 3))}`,
      ).toBe(0);
      expect(
        audit.orphanStubWalls,
        `seed ${seed} orphan stubs: ${JSON.stringify(audit.orphanStubs.slice(0, 5))}`,
      ).toBe(0);
      expect(audit.destructibleShardCount, `seed ${seed} destructible shards`).toBe(0);
    }
  });

  it('every seed: zero corner-dangling violations (ticket 20 — diagonal-only attachments hug the corner)', () => {
    let artLimited = 0;
    for (const seed of SEEDS) {
      const { audit } = sampleSeed(seed);
      expect(
        audit.cornerDanglingViolations,
        `seed ${seed} corner-dangling violations: ${JSON.stringify(
          audit.cornerViolations.slice(0, 5),
        )}`,
      ).toBe(0);
      artLimited += audit.cornerArtLimitedCells;
    }
    // Checkerboard-pocket telemetry (documented art gap): a wall-like
    // diagonal in every quadrant cannot be fully corner-covered by any
    // single atlas frame. Growth beyond the pin = new dense pocket
    // topologies — investigate, do not silently bump.
    expect(artLimited, 'art-limited checkerboard corner cells').toBeLessThanOrEqual(
      CORNER_ART_LIMITED_BOUND,
    );
  });

  it('every interior residual is the pure-destructible T-stem class (D5), inside the pinned bound', () => {
    let total = 0;
    for (const seed of SEEDS) {
      const { audit, grid } = sampleSeed(seed);
      for (const v of audit.violations) {
        expect(
          isPureDestructibleTStemPair(grid, v.row, v.col, v.dir),
          `seed ${seed} residual (${v.row},${v.col})${v.dir} is NOT pure-destructible T-stem ` +
            `(${v.imagePath}@${v.rotation}-${v.neighborImagePath}@${v.neighborRotation}) — ` +
            `a representable defect, fix it; do NOT widen the classifier`,
        ).toBe(true);
      }
      expect(
        audit.interiorViolations,
        `seed ${seed} T-stem residuals exceed per-seed bound`,
      ).toBeLessThanOrEqual(T_STEM_RESIDUAL_PER_SEED_BOUND);
      total += audit.interiorViolations;
    }
    expect(total, 'sweep-total T-stem residuals exceed pinned bound').toBeLessThanOrEqual(
      T_STEM_RESIDUAL_BOUND,
    );
  });

  it('every interior sector seam is the thick-wall pattern (2-thick runs that receive fills)', () => {
    const exceptions: Array<{
      seed: number;
      pair: { r1: number; c1: number; r2: number; c2: number };
    }> = [];
    for (const seed of SEEDS) {
      for (const pair of sampleSeed(seed).seamFillExceptions) exceptions.push({ seed, pair });
    }
    // All-indestructible seam pairs overwhelmingly carry fills; the pinned
    // exceptions are band-connected junction read-outs (world-edge seam
    // intersections, gate-jamb dominoes, and — since the round-5e post-stamp
    // border-buffer re-clean — the seam-run END tiles at corridor junctions,
    // which now render as correct unfilled jambs instead of buried fills) —
    // and seamViolations === 0 above proves every one of them still shares a
    // solid band.
    expect(
      exceptions.length,
      `unfilled all-indestructible seam pairs: ${JSON.stringify(exceptions.slice(0, 6))}`,
    ).toBeLessThanOrEqual(SEAM_FILL_EXCEPTION_BOUND);
  });

  it('fills sit only on indestructible wall tiles and use TileType.EMPTY-typed frames', () => {
    for (const seed of SEEDS) {
      const { fillTileErrors } = sampleSeed(seed);
      expect(fillTileErrors.slice(0, 5), `seed ${seed} fill invariants`).toEqual([]);
    }
  });

  it('the sanctioned maze-pillar exemption is real and exercised (telemetry)', () => {
    let sanctioned = 0;
    for (const seed of SEEDS) {
      sanctioned += sampleSeed(seed).audit.sanctionedStubCount;
    }
    // 244 sanctioned maze separator-residue cells across this sweep.
    expect(sanctioned).toBeGreaterThan(0);
  });
});

describe('wall composition sweep (ticket 14) — determinism (ADR 0035)', () => {
  for (const seed of [1, 42, 12345]) {
    it(`seed ${seed}: two runs produce byte-identical wall visuals + validator counts`, () => {
      const first = sampleSeed(seed);
      // Fresh generator + adapter instances: identical OUTPUT must not depend
      // on instance state (the caches only memoize within this file).
      const freshAudit = (() => {
        const mapData = new MapGenerator().generate(seed);
        const enriched = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
        const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
        const fillLayer = enriched.visualLayers.find((l) => l.name === 'wall_fill')!;
        return {
          walls: JSON.stringify(wallLayer.cells),
          fills: JSON.stringify(fillLayer.cells),
          audit: JSON.stringify(
            validateWallComposition(enriched.grid, wallLayer.cells, {
              fillCells: fillLayer.cells,
              atlasSprites: enriched.atlas.sprites,
              sanctionedStubCells: collectSanctionedStubCells(mapData.sectors),
            }),
          ),
        };
      })();

      expect(JSON.stringify(first.wallCells)).toBe(freshAudit.walls);
      expect(JSON.stringify(first.fillCells)).toBe(freshAudit.fills);
      expect(JSON.stringify(first.audit)).toBe(freshAudit.audit);
    });
  }
});
