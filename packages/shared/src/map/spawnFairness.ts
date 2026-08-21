import type { SpawnPoint } from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  MIN_SPAWN_DIST,
} from './constants.js';
import {
  buildEquityModel,
  buildSectorEquityContext,
  componentValues,
  computeBlockedTiles,
  ratioOf,
  SPAWN_EQUITY_COMPONENTS,
  type EquityModel,
  type SectorEquityContext,
  type SpawnEquityComponent,
  type SpawnEquityInput,
  type SpawnEquityValues,
} from './spawnFairnessModel.js';

export { SPAWN_EQUITY_COMPONENTS, SPAWN_DESTRUCTIBLE_CLEARANCE } from './spawnFairnessModel.js';
export type {
  SpawnEquityComponent,
  SpawnEquityValues,
  EquityModel,
  SectorEquityContext,
  SpawnEquityInput,
} from './spawnFairnessModel.js';

/**
 * Per-spawn value-vector fairness gate + local repair (map-redesign ticket 10
 * / DEC-009): "fairness = bounded max deviation across spawns of a value
 * vector", tested at the generation seam so map fairness is regression-tested
 * rather than eyeballed. The measurement layer lives in spawnFairnessModel.ts
 * (split per the 500-line file gate).
 *
 * ## Value vector
 * Every spawn point is scored on four components:
 * 1. `weapon` — distance (px) to the nearest ground-weapon placement
 *    (`WEAPON_SPAWN`), measured on a chamfer(3-4) tile-resolution field.
 * 2. `chest` — distance to the nearest `CHEST` placement (same field).
 * 3. `clump` — distance to the nearest field-loot CLUMP.
 *    INTERPRETATION (documented deviation): DEC-003.5 specifies "bait clumps"
 *    as a distinct placement class, but no such class ever landed in the
 *    generator (verified: no bait/clump entity exists; ticket 02 shipped the
 *    tier pyramid + hot sector + legendary cap only). Per the ticket's
 *    instruction ("use the nearest existing equivalent ... do not invent new
 *    gameplay entities"), the component uses the nearest GROUND-WEAPON
 *    CLUSTER: WEAPON_SPAWN placements single-linkage-clustered at ≤ 2.5 tiles;
 *    every member of a cluster of ≥ 2 is a clump point. This is the shipped
 *    generator's clump-like concentration of field loot.
 * 4. `hot` — 4-dir BFS path distance (tiles) through traversable tiles to the
 *    nearest EFFECTIVE-HOT sector tile (base pyramid HOT + the per-match hot
 *    sector — the tier the match actually plays).
 *
 * ## Deviation reference — the sector's eligible-pool median
 * The DEC-009 wording is "no spawn worse than ~25–30% beyond the median on
 * any component". Measured over a 50-seed sweep, a MAP-WIDE median makes that
 * band structurally unsatisfiable: 25–37% of spawn-component observations
 * exceed 1.3× the map-wide median, dominated by the DESIGNED geography (the
 * tier pyramid puts COLD outer sectors far from the HOT center on purpose —
 * GDD §5 risk geography; the procgen research itself frames BR fairness as
 * "risk-reward self-balancing, not symmetry"). A map-wide bound would either
 * fail virtually every map or force the generator to fight its own design.
 * The gate therefore bounds each spawn against the median of its OWN sector's
 * eligible-pool value distribution (the sector's "offer" — the EMPTY-interior
 * candidate pool SpawnPointFinder selects from, minus the server-rejected
 * destructible-clearance tiles): a spawn is unfair when it is > 30% worse
 * than what its own sector could have offered, which is exactly what a local
 * re-pick CAN repair. Cross-sector starvation below the design floors is
 * already gated by the per-sector loot-density / loot-feasibility gates, and
 * cross-seed character is audited by the seed-sweep distribution suite +
 * benchmark drop/death bounds (DEC-003 dissent resolution).
 *
 * ## Repair
 * `repairSpawnEquity` re-picks each violating spawn from its sector's
 * eligible pool (never invents positions, never changes counts). A spawn on
 * a server-rejected destructible-clearance tile is repair-worthy even when
 * its ratios are in-bound (see computeBlockedTiles — repairs must never
 * create a spawn the server SpawnService would drop, which shrinks the valid
 * pool below 64 and forces clustered reuse+jitter spawns). Candidates
 * must respect the spawn spacing rules (global `MIN_SPAWN_DIST` px vs every
 * other spawn; ≥ 3-tile Manhattan vs same-sector spawns), are ranked by their
 * worst component ratio with deterministic (row, col) tie-breaks, and the
 * bounded-retry loop inspects at most `SPAWN_EQUITY_REPAIR_CANDIDATE_LIMIT`
 * candidates per spawn across `SPAWN_EQUITY_REPAIR_ROUNDS` rounds. Fully
 * deterministic — zero RNG draws (ADR 0035: same seed ⇒ identical output).
 * The repair pass runs BEFORE validation inside `MapGenerator.runPipeline`;
 * `MapValidator.checkSpawnEquity` then gates the POST-repair state, so an
 * unrepairable spawn fails the attempt and feeds the existing 10-retry
 * generation loop.
 */

/**
 * Max tolerated deviation beyond the sector-offer median, per component
 * (DEC-009 band "~25–30%" — pinned at 30%, the generous end, so the gate
 * rejects genuine outliers without spurious generation retries).
 */
export const SPAWN_EQUITY_MAX_DEVIATION = 0.3;

/** Bounded-retry budget: repair evaluates at most this many candidates. */
export const SPAWN_EQUITY_REPAIR_CANDIDATE_LIMIT = 12;

/**
 * Bounded repair rounds: a later round re-searches for still-violating spawns
 * (earlier repairs free spacing slots). A round that makes no progress stops
 * the loop.
 */
export const SPAWN_EQUITY_REPAIR_ROUNDS = 3;

/** Same-sector spawn Manhattan spacing (mirrors SpawnPointFinder). */
const MIN_MANHATTAN_TILES = 3;

/** One gate violation: a spawn worse than the bound on one component. */
export interface SpawnEquityViolation {
  spawnIndex: number;
  sector: { row: number; col: number };
  component: SpawnEquityComponent;
  /** The spawn's component value (px / tiles). */
  value: number;
  /** The sector-offer median for the component. */
  median: number;
  /** value / median (> 1 + SPAWN_EQUITY_MAX_DEVIATION). */
  ratio: number;
}

/** The post-state fairness audit (gating + manifest diagnostics). */
export interface SpawnEquityAudit {
  /** Every bound violation across all spawns (empty on a gate-clean map). */
  violations: SpawnEquityViolation[];
  /**
   * Worst spawn ratio vs its own sector-offer median, per component, across
   * the map (diagnostics — rides the benchmark manifest; the gate itself is
   * the violations list).
   */
  maxRatio: Record<SpawnEquityComponent, number>;
  /** Per-sector offer medians (row-major, per component) — audit surface. */
  sectorMedians: Array<Record<SpawnEquityComponent, number>>;
}

interface RepairCandidate {
  row: number;
  col: number;
  x: number;
  y: number;
  worstRatio: number;
}

/**
 * Audit the map's spawns against the equity bound: every spawn's value vector
 * vs its OWN sector's eligible-pool median (see module doc for why the
 * reference is the sector offer, not the map-wide median). An optional
 * precomputed model/context lets the repair pass re-audit without rebuilding
 * (same final state — pure function of the input either way).
 */
export function auditSpawnEquity(
  input: SpawnEquityInput,
  precomputed?: { model: EquityModel; ctx: SectorEquityContext },
): SpawnEquityAudit {
  const model = precomputed?.model ?? buildEquityModel(input);
  const ctx = precomputed?.ctx ?? buildSectorEquityContext(model, input);
  const violations: SpawnEquityViolation[] = [];
  const maxRatio: Record<SpawnEquityComponent, number> = { weapon: 0, chest: 0, clump: 0, hot: 0 };

  for (let i = 0; i < input.spawnPoints.length; i++) {
    const sp = input.spawnPoints[i]!;
    const values = componentValues(model, sp.x, sp.y);
    const medians = ctx.medians[sp.sectorCoord.row * SECTOR_GRID_SIZE + sp.sectorCoord.col]!;
    for (const component of SPAWN_EQUITY_COMPONENTS) {
      const median = medians[component];
      if (median <= 0) continue;
      const ratio = values[component] / median;
      if (ratio > maxRatio[component]) maxRatio[component] = ratio;
      if (ratio > 1 + SPAWN_EQUITY_MAX_DEVIATION) {
        violations.push({
          spawnIndex: i,
          sector: { ...sp.sectorCoord },
          component,
          value: values[component],
          median,
          ratio,
        });
      }
    }
  }

  return { violations, maxRatio, sectorMedians: ctx.medians };
}

/**
 * Repair the map's spawn equity in place: every violating spawn is re-picked
 * from its sector's eligible pool under the spawn spacing rules, bounded to
 * `SPAWN_EQUITY_REPAIR_CANDIDATE_LIMIT` inspected candidates per spawn and
 * `SPAWN_EQUITY_REPAIR_ROUNDS` rounds. Deterministic (no RNG): candidates are
 * ranked by worst component ratio with (row, col) tie-breaks; the first
 * candidate inside the bound wins, else the strictly-best candidate is taken
 * as an improvement, else the spawn is left for the validator gate to reject
 * (generation retry). Returns the number of re-picked spawns plus the
 * post-repair audit.
 */
export function repairSpawnEquity(input: SpawnEquityInput): {
  repairs: number;
  audit: SpawnEquityAudit;
} {
  const model = buildEquityModel(input);
  const ctx = buildSectorEquityContext(model, input);
  // Server-rejected tiles (destructible clearance): a spawn sitting on one is
  // repair-worthy REGARDLESS of its value ratios — the server would drop it
  // from the valid pool, forcing spawn reuse + jitter (clustered spawns).
  // Repair candidates come from the (blocked-free) eligible pool, so every
  // re-pick is server-valid by construction.
  const blocked = computeBlockedTiles(input.entityPlacements);
  const COMPOSITE_SIZE = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
  const isBlockedPos = (x: number, y: number): boolean =>
    blocked.has(Math.floor(y / TILE_PIXEL_SIZE) * COMPOSITE_SIZE + Math.floor(x / TILE_PIXEL_SIZE));
  const spawns = input.spawnPoints;
  // Spatial buckets of LIVE spawn references (512px cells — ≥ MIN_SPAWN_DIST,
  // so a candidate only needs the 3x3 neighbourhood to find every conflicting
  // spawn: Euclid < 384 ⇒ bucket offset ≤ 1; Manhattan < 3 ⇒ Euclid ≤ 256 ⇒
  // also inside). Repairs MUTATE the spawn objects in place, so the bucketed
  // references always see current positions. Keeps the repair pass
  // O(candidates × neighbors) instead of O(candidates × allSpawns).
  const BUCKET_PX = 512;
  // Bucket key: row * 1024 + col — 1024 exceeds the map's 80-cell width, so
  // (row, col) pairs never collide.
  const bucketKey = (x: number, y: number): number =>
    Math.floor(y / BUCKET_PX) * 1024 + Math.floor(x / BUCKET_PX);
  const buckets = new Map<number, SpawnPoint[]>();
  for (const sp of spawns) {
    const key = bucketKey(sp.x, sp.y);
    const list = buckets.get(key);
    if (list) list.push(sp);
    else buckets.set(key, [sp]);
  }
  /** Live spawns whose buckets touch (x, y)'s 3x3 neighbourhood. */
  const nearbySpawns = (x: number, y: number): SpawnPoint[] => {
    const br = Math.floor(y / BUCKET_PX);
    const bc = Math.floor(x / BUCKET_PX);
    const out: SpawnPoint[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const list = buckets.get((br + dr) * 1024 + (bc + dc));
        if (list) out.push(...list);
      }
    }
    return out;
  };
  const MIN_DIST_SQ = MIN_SPAWN_DIST * MIN_SPAWN_DIST;
  /** Re-file a spawn under its (new) position after an in-place repair. */
  const refileSpawn = (spawn: SpawnPoint, fromKey: number): void => {
    const toKey = bucketKey(spawn.x, spawn.y);
    if (toKey === fromKey) return;
    const oldList = buckets.get(fromKey);
    if (oldList) {
      const at = oldList.indexOf(spawn);
      if (at >= 0) oldList.splice(at, 1);
    }
    const list = buckets.get(toKey);
    if (list) list.push(spawn);
    else buckets.set(toKey, [spawn]);
  };

  function repairRound(): number {
    let roundRepairs = 0;

    for (let i = 0; i < spawns.length; i++) {
      const sp = spawns[i]!;
      const sRow = sp.sectorCoord.row;
      const sCol = sp.sectorCoord.col;
      const medians = ctx.medians[sRow * SECTOR_GRID_SIZE + sCol]!;
      const currentValues = componentValues(model, sp.x, sp.y);
      const currentWorst = ratioOf(currentValues, medians);
      // A spawn on a server-rejected (destructible-clearance) tile is always
      // repair-worthy, even when its value ratios are in-bound.
      const spawnBlocked = isBlockedPos(sp.x, sp.y);
      if (!spawnBlocked && currentWorst <= 1 + SPAWN_EQUITY_MAX_DEVIATION) continue; // clean spawn

      const sector = input.sectors[sRow]![sCol]!;
      const pool = ctx.pools[sRow * SECTOR_GRID_SIZE + sCol]!;

      const candidates: RepairCandidate[] = [];
      for (const tile of pool) {
        // Spacing rules against every live conflicting spawn: the global px
        // rule (squared compare) + the same-sector Manhattan rule, mirroring
        // SpawnPointFinder (occupied tiles are Manhattan 0 — caught here too).
        const conflicts = nearbySpawns(tile.x, tile.y);
        let valid = true;
        for (const o of conflicts) {
          if (o === sp) continue;
          const dx = tile.x - o.x;
          const dy = tile.y - o.y;
          if (dx * dx + dy * dy < MIN_DIST_SQ) {
            valid = false;
            break;
          }
          if (o.sectorCoord.row === sRow && o.sectorCoord.col === sCol) {
            const oRow = Math.round((o.y - sector.bounds.y) / TILE_PIXEL_SIZE);
            const oCol = Math.round((o.x - sector.bounds.x) / TILE_PIXEL_SIZE);
            if (Math.abs(tile.row - oRow) + Math.abs(tile.col - oCol) < MIN_MANHATTAN_TILES) {
              valid = false;
              break;
            }
          }
        }
        if (!valid) continue;
        candidates.push({
          ...tile,
          worstRatio: ratioOf(componentValues(model, tile.x, tile.y), medians),
        });
      }
      // Deterministic ranking: best worst-ratio first, tie-break row then col.
      candidates.sort((a, b) => a.worstRatio - b.worstRatio || a.row - b.row || a.col - b.col);

      let replacement: RepairCandidate | null = null;
      for (let k = 0; k < Math.min(candidates.length, SPAWN_EQUITY_REPAIR_CANDIDATE_LIMIT); k++) {
        const candidate = candidates[k]!;
        if (candidate.worstRatio <= 1 + SPAWN_EQUITY_MAX_DEVIATION) {
          replacement = candidate; // first in-bound candidate — done
          break;
        }
        if (replacement === null && (spawnBlocked || candidate.worstRatio < currentWorst)) {
          replacement = candidate; // best improvement so far (kept if none in bound);
          // for a blocked spawn ANY pool candidate (unblocked by construction)
          // beats staying on a tile the server would reject
        }
      }
      if (replacement) {
        // In-place mutation (never changes counts), then re-file the spawn in
        // its position buckets so later repairs see the new position. Priority
        // is kept from the replaced spawn.
        const fromKey = bucketKey(sp.x, sp.y);
        sp.x = replacement.x;
        sp.y = replacement.y;
        refileSpawn(sp, fromKey);
        roundRepairs++;
      }
    }
    return roundRepairs;
  }

  // Bounded repair rounds (DEC-009 "bounded retries" at two scales: rounds ×
  // the per-spawn candidate limit). Round N+1 re-runs the candidate search
  // for still-violating spawns — earlier rounds' repairs can free spacing
  // slots and lower a spawn's current value, so a second look can succeed
  // where the first pass found no in-bound candidate. Stops as soon as a
  // round makes no progress; the validator gate arbitrates the final state.
  let repairs = 0;
  for (let round = 0; round < SPAWN_EQUITY_REPAIR_ROUNDS; round++) {
    const roundRepairs = repairRound();
    repairs += roundRepairs;
    if (roundRepairs === 0) break;
  }

  return { repairs, audit: auditSpawnEquity(input, { model, ctx }) };
}
