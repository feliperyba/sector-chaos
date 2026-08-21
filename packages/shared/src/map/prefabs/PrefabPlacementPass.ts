/**
 * THE PREFAB PLACEMENT PASS (map-polish tickets 25 + 28) — the deterministic
 * smart-reuse placement engine that is now the PRIMARY interior composer.
 *
 * Owner demand (verbatim): "STOP TO PLACE THINGS IN THE MAP AT RANDOM. DO
 * CREATE LOGICAL PREFABS AND COMPOSITIONS AND RE-USE THEM SMARTLY IN THE SEED
 * MAP GENERATOR, SO THE MAP DOES NOT FEEL 100% RANDOM."
 *
 * Ticket 28 PROMOTION: the sector skeletons' per-cell RNG scatter fills
 * (lattice/edge-trace/staggered-rows/diagonal-pairs) were removed, so this pass
 * now carries the interior cover between the authored structures. The window
 * criterion relaxed from strictly-featureless all-EMPTY 5×5 (the ticket-25
 * trigger) to a MOSTLY-OPEN window (≥{@link MIN_WINDOW_EMPTY} of 25 cells
 * EMPTY): with the fills gone the skeletons leave large open fields, and
 * stamped compositions may now frame AROUND authored skeleton geometry instead
 * of only landing in virgin pockets. Every stamp cell is still per-cell
 * paint-gated (never overwrites authored geometry), so the non-EMPTY minority
 * of a window is touched by NO stamp write. Per-type caps rose to carry the
 * added load (see {@link SECTOR_STAMP_CAP}).
 *
 * WHAT IT REPLACED (ticket 25): the refinement stage's three per-cell scatter
 * passes (dead-zone 3-crate random shapes, sightline midpoint crates,
 * density-balance shuffled top-ups — the classes are deleted). The stage's
 * zero-RNG cleanup half (orphan cleanup) is PRESERVED verbatim (imported,
 * phase A) so skeleton clutter that lost its structural context still
 * vanishes. In `MapGenerator.runPipeline` this pass occupies the exact stage
 * position the refinement pipeline held: after macro features + heal, before
 * landmark assignment / plaza keeps / entity placement.
 *
 * HOW IT PLACES (demand-driven, never blanket): per sector it slides a 5×5
 * window across the interior (row-major) and stamps ONE authored prefab
 * composition from {@link PREFAB_LIBRARY} into each qualifying mostly-open
 * window, selected + oriented by the isolated ADR-0035 stream (2 draws per
 * stamp attempt: weighted pick, orientation), with a per-type stamp cap so
 * biome density identities stay distinct. In-place mutation breaks later
 * overlapping windows, so stamps never stack; a dilation reservation keeps
 * consecutive stamps apart (round 7: ±2 ring). Round 7 cohesion — the scan is
 * TWO-PHASE: structure-framing windows (≥2 authored cells inside the box) are
 * stamped first, virgin open-field pockets fill only while the cap still has
 * room, so compositions read as built AGAINST the sector's geometry instead of
 * scattered across its floor.
 *
 * SMART REUSE: the last two prefab ids used in a sector are excluded from the
 * next pick while alternatives remain, so a sector cycles its biome family's
 * pool while the SAME library shapes recur map-wide with rotation/mirror
 * variation — designed places, not noise.
 *
 * GUARDS (all inherited/discipline-preserving):
 * - PAINT-GATE: walls/props only ever write EMPTY interior cells that are not
 *   corridor tiles, not macro-feature carved tiles, not authored lootSpots,
 *   and not within Chebyshev 1 of the sector's landmark anchor (the beacon
 *   keep owns that zone; the authored anchor must stay EMPTY so the landmark
 *   pass keeps resolving to it). Never overwrites authored geometry.
 * - KEEP ZONE: the window additionally rejects any box reaching within
 *   Chebyshev 2 of the landmark anchor, so prefab walls never crowd the keep
 *   the plaza pass stamps later.
 * - CONFLICT-CLIP: each wall run stamps its longest fully-paintable
 *   CONTIGUOUS stretch when ≥2 tiles survive (the ticket-16/24 rule) — a
 *   blocked run degrades to its clean remainder (a breach), never a stub.
 * - NO 2×2 WALL CLUMP: no wall write may complete a 2×2 wall-like block
 *   (checked against the grid AND earlier cells of the same stamp), so prefab
 *   walls can never collide or read as full tiles even against pre-existing
 *   skeleton geometry.
 * - NEVER-SEAL (full-map): a stamp may not split ANY open region. Before and
 *   after every stamp the pass labels the composite grid's EMPTY components
 *   (4-connected — exactly the validator flood-fill gate's semantics, so
 *   cross-sector collars and corridor mouths are covered too); a stamp whose
 *   walls/props disconnect the still-EMPTY members of any pre-component is
 *   fully reverted (restoring exact EMPTY). The flood-fill validator gate +
 *   the 10-retry loop remain the backstop.
 * - STUB-FREE BY CONSTRUCTION: clipped runs are ≥2 contiguous tiles, so every
 *   stamped wall keeps a cardinal run-mate — no orphan stubs for the wall
 *   composition pass to clear, no corner-dangling cells (those need ZERO
 *   wall-like cardinals) for the corner audit to flag.
 *
 * DETERMINISM (ADR 0035): ZERO `Math.random`; the sole stream is
 * `new SeededRNG((seed ^ PREFAB_SEED_SALT) >>> 0)` — an isolated XOR salt
 * like REFI/LNDM/IDTY, forked per pass, drawn only at qualifying windows. The
 * main generation stream and every other isolated stream are untouched, so
 * same seed ⇒ identical stamps ⇒ identical MapData.
 */

import { TileType } from '../../enums/TileType.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import { buildCompositeGrid, createsUnrenderableJunction, isWallLikeTile } from '../gridUtils.js';
import { orphanCleanup } from '../refinement/OrphanCleanupPass.js';
import { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import { SectorType } from '../types.js';
import { PREFAB_LIBRARY } from './PrefabLibrary.js';
import {
  labelEmptyComponents,
  longestStretch,
  stampPinchesSlot,
  stampSplitsOpenRegions,
} from './PrefabGuards.js';
import { orientationCount, transformOffset, type PrefabDef } from './PrefabTypes.js';
import { ANCHOR_LO, ANCHOR_HI, corridorKey, windowQualifies } from './PrefabPlacementWindow.js';

/** Isolated stream salt — 'PREF' in ASCII bytes (REFI/LNDM precedent). */
const PREFAB_SEED_SALT = 0x50524546;

/**
 * Reservation dilation: stamps (and their ±2 ring) block later window boxes.
 * Round 7 raised the ring from ±1: consecutive compositions kept only a single
 * tile of breathing room and read as one crowded bazaar blob — two tiles of
 * separation restores each stamp as its own readable place.
 */
const RESERVE_DILATION = 2;

/** Recent-pick exclusion size (smart reuse: no immediate repeats per sector). */
const RECENT_DEPTH = 2;

/**
 * Per-sector stamp caps — keeps each biome family's density identity. Ticket 28
 * raised them from 3/3/2/3: with the skeleton scatter fills removed, this pass
 * carries the interior cover, so the cap space grew (MAZE stays lower — its
 * carve model already fills the interior with authored wall structure). Round
 * 6 raised OPEN/RICH to 6: the owner's "sectors became open areas" note — the
 * two wide-field biomes carry one more composition each (GRID stays 5; its
 * authored skeleton is already the densest).
 */
const SECTOR_STAMP_CAP: Record<SectorType, number> = {
  [SectorType.GRID_ARENA]: 5,
  [SectorType.OPEN_ARENA]: 6,
  [SectorType.MAZE]: 3,
  [SectorType.RESOURCE_RICH]: 6,
};

/** Telemetry of one pass run (never stored on MapData — byte identity). */
export interface PrefabPassStats {
  orphansRemoved: number;
  stamps: number;
  wallTiles: number;
  propTiles: number;
  revertedStamps: number;
  /**
   * Landed (non-reverted) stamp count per prefab id — census telemetry for the
   * map-polish repetition/reuse measurement. Never serialized into MapData.
   */
  idCounts: Record<string, number>;
}

/**
 * The deterministic prefab placement pass. Mutates `sectors` in place:
 * phase A runs the preserved zero-RNG orphan cleanup, phase B stamps authored
 * compositions into qualifying open pockets. See the module doc for the full
 * guard list.
 */
export class PrefabPlacementPass {
  /**
   * Never-seal label cache (ticket 28): the composite grid's current EMPTY
   * component labels, reused as the PRE-stamp baseline of every attempt while
   * the grid is unchanged. Only a LANDED stamp mutates the composite (reverts
   * restore exact EMPTY; no-write attempts touch nothing), so the baseline is
   * invalidated exactly when it must be. `labelEmptyComponents` is pure, so
   * the cached array is byte-identical to a fresh recompute — this is a pure
   * performance optimization (the raised caps made per-attempt relabeling the
   * dominant generation cost).
   */
  private preLabelsCache: Int32Array | null = null;

  run(
    sectors: SectorData[][],
    seed: number,
    corridorTiles: Set<string>,
    macroTiles: Set<string> = new Set<string>(),
  ): PrefabPassStats {
    const rng = new SeededRNG((seed ^ PREFAB_SEED_SALT) >>> 0);
    this.preLabelsCache = null;
    // Phase A — preserved from the replaced refinement stage (zero RNG).
    const orphansRemoved = orphanCleanup(sectors);

    // The composite grid backing the never-seal guard (maintained in lockstep
    // with every stamp/revert below; sector writes mirror into it).
    const composite = buildCompositeGrid(sectors);

    const stats: PrefabPassStats = {
      orphansRemoved,
      stamps: 0,
      wallTiles: 0,
      propTiles: 0,
      revertedStamps: 0,
      idCounts: {},
    };

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        this.placeInSector(
          sectors[row]![col]!,
          row,
          col,
          rng,
          corridorTiles,
          macroTiles,
          composite,
          stats,
        );
      }
    }
    return stats;
  }

  /** Phase B for one sector: scan windows, pick + stamp until the type cap. */
  private placeInSector(
    sector: SectorData,
    sRow: number,
    sCol: number,
    rng: SeededRNG,
    corridorTiles: Set<string>,
    macroTiles: Set<string>,
    composite: Uint8Array[],
    stats: PrefabPassStats,
  ): void {
    const reserved = new Set<string>();
    const recent: string[] = [];
    let placed = 0;
    const cap = SECTOR_STAMP_CAP[sector.type];

    // Round 7 (cohesion) — two-phase scan: phase 1 only stamps windows that
    // FRAME authored skeleton structure (≥2 non-EMPTY cells inside the 5×5
    // box), so compositions back onto / thread around real geometry first;
    // phase 2 then fills the remaining open fields up to the cap. A floating
    // stamp in a virgin 25/25-empty pocket is the "furniture scattered around
    // the room" read the owner rejected — it now happens only where the sector
    // genuinely has no structure edge left to frame.
    const scanWindows = (requireFraming: boolean): void => {
      for (let anchorRow = ANCHOR_LO; anchorRow <= ANCHOR_HI && placed < cap; anchorRow++) {
        for (let anchorCol = ANCHOR_LO; anchorCol <= ANCHOR_HI && placed < cap; anchorCol++) {
          if (
            !windowQualifies(
              sector,
              sRow,
              sCol,
              anchorRow,
              anchorCol,
              corridorTiles,
              macroTiles,
              reserved,
              requireFraming,
            )
          ) {
            continue;
          }
          // Smart reuse: exclude the sector's last picks while alternatives
          // remain, then weighted-pick + draw an orientation (2 draws total).
          const allowed = PREFAB_LIBRARY.filter((p) => p.allowedSectorTypes.includes(sector.type));
          let pool = allowed.filter((p) => !recent.includes(p.id));
          if (pool.length === 0) pool = allowed;
          const def = rng.weightedPick(pool.map((p) => ({ item: p, weight: p.weight })));
          const variant = rng.nextInt(0, orientationCount(def) - 1);

          const result = this.stampPrefab(
            sector,
            sRow,
            sCol,
            anchorRow,
            anchorCol,
            def,
            variant,
            corridorTiles,
            macroTiles,
            composite,
          );
          if (result.walls + result.props === 0) continue; // hostile site — nothing stamped
          // A stamp attempt — landed or reverted — consumes one of the sector's
          // cap slots: a revert means the pocket's geometry is hostile to THIS
          // composition family, and burning the slot keeps the sector's density
          // identity instead of hammering every overlapping window (measured:
          // cap-free reverts triple the attempt count and double the retry
          // census; the burned slot is the stable baseline).
          placed++;
          stats.stamps++;
          stats.wallTiles += result.walls;
          stats.propTiles += result.props;
          if (result.sealed) {
            stats.revertedStamps++;
            continue;
          }
          // Reserve the stamped footprint (+ ring) against later windows.
          for (const [r, c] of result.cells) {
            for (let dr = -RESERVE_DILATION; dr <= RESERVE_DILATION; dr++) {
              for (let dc = -RESERVE_DILATION; dc <= RESERVE_DILATION; dc++) {
                reserved.add(`${r + dr},${c + dc}`);
              }
            }
          }
          recent.push(def.id);
          if (recent.length > RECENT_DEPTH) recent.shift();
          stats.idCounts[def.id] = (stats.idCounts[def.id] ?? 0) + 1;
        }
      }
    };
    scanWindows(true);
    scanWindows(false);
  }

  /**
   * Stamp one prefab at the anchor with the full guard chain. Returns the
   * per-stamp outcome; when `sealed` is true every write was reverted and
   * `walls`/`props` count what briefly landed (revert restores exact EMPTY —
   * the paint-gate guarantees every written cell was EMPTY).
   */
  private stampPrefab(
    sector: SectorData,
    sRow: number,
    sCol: number,
    anchorRow: number,
    anchorCol: number,
    def: PrefabDef,
    variant: number,
    corridorTiles: Set<string>,
    macroTiles: Set<string>,
    composite: Uint8Array[],
  ): { walls: number; props: number; cells: Array<[number, number]>; sealed: boolean } {
    const paintable = (r: number, c: number): boolean => {
      if (r < 1 || r > SECTOR_TILE_SIZE - 2 || c < 1 || c > SECTOR_TILE_SIZE - 2) return false;
      if (sector.tiles[r]![c] !== TileType.EMPTY) return false;
      if (corridorTiles.has(corridorKey(sRow, sCol, r, c))) return false;
      if (macroTiles.has(`${sRow * SECTOR_TILE_SIZE + r},${sCol * SECTOR_TILE_SIZE + c}`)) {
        return false;
      }
      if (sector.lootSpots.some((spot) => spot.y === r && spot.x === c)) return false;
      const anchor = sector.landmarkAnchor;
      return Math.max(Math.abs(c - anchor.x), Math.abs(r - anchor.y)) > 1;
    };

    // Pending wall writes of THIS stamp (for the 2×2 clump guard).
    const pending = new Set<string>();
    const wouldForm2x2 = (r: number, c: number): boolean => {
      for (const [br, bc] of [
        [r - 1, c - 1],
        [r - 1, c],
        [r, c - 1],
        [r, c],
      ] as const) {
        let all = true;
        for (const [wr, wc] of [
          [br, bc],
          [br, bc + 1],
          [br + 1, bc],
          [br + 1, bc + 1],
        ] as const) {
          if (wr === r && wc === c) continue; // the candidate itself
          const tile = sector.tiles[wr]?.[wc];
          const wallLike = tile !== undefined && isWallLikeTile(tile);
          if (!wallLike && !pending.has(`${wr},${wc}`)) all = false;
        }
        if (all) return true;
      }
      return false;
    };

    // Never-seal baseline: the composite grid's EMPTY components BEFORE the
    // stamp (4-connected — the validator flood-fill gate's own semantics).
    // Served from {@link preLabelsCache} while the grid is unchanged.
    const preLabels = this.preLabelsOf(composite);

    const written: Array<[number, number]> = [];
    let walls = 0;
    let props = 0;
    // Every write mirrors into the composite grid (never-seal bookkeeping).
    const write = (r: number, c: number, tile: TileType): void => {
      sector.tiles[r]![c] = tile;
      composite[sRow * SECTOR_TILE_SIZE + r]![sCol * SECTOR_TILE_SIZE + c] = tile;
      written.push([r, c]);
    };

    for (const run of def.walls) {
      // Transform + gate every cell of the authored run, then conflict-clip
      // to the longest contiguous ≥2 stretch (never a stub).
      const cells = run.tiles.map(([dx, dy]) => {
        const [tx, ty] = transformOffset(dx, dy, variant);
        return [anchorRow + ty, anchorCol + tx] as [number, number];
      });
      // Own cells for the junction guard: previously stamped walls of this
      // composition (pending) + the current run's own cells (the run gates
      // before any of its cells are written, so its own arms must count).
      const runOwn = new Set<string>(pending);
      for (const [r, c] of cells) runOwn.add(`${r},${c}`);
      const best = longestStretch(cells, (r, c) => {
        if (!paintable(r, c)) return false;
        if (wouldForm2x2(r, c)) return false;
        // Run-join guard (round 8): a stamped wall may never sit at 3+ wall
        // cardinals (a T/plus junction — unrenderable strip art, the
        // WallContinuityGate D-class). Authored composition cells (own) are
        // junction-free by design; the run conflict-clips around conflicts.
        if (createsUnrenderableJunction(sector.tiles, r, c, run.tile, runOwn)) return false;
        return true;
      });
      if (!best) continue;
      for (const [r, c] of best) {
        write(r, c, run.tile);
        pending.add(`${r},${c}`);
        walls++;
      }
    }
    // Wall prefabs that lost every run stamp nothing (props alone at a hostile
    // site would read as clutter, and grove/stash carry their own no-wall read).
    if (def.walls.length > 0 && walls === 0) {
      return { walls: 0, props: 0, cells: [], sealed: false };
    }
    for (const [dx, dy] of def.props) {
      const [tx, ty] = transformOffset(dx, dy, variant);
      const r = anchorRow + ty;
      const c = anchorCol + tx;
      if (!paintable(r, c)) continue;
      write(r, c, TileType.DESTRUCTIBLE_CRATE);
      props++;
    }

    if (walls + props === 0) {
      return { walls: 0, props: 0, cells: [], sealed: false };
    }

    // NEVER-SEAL: the still-EMPTY cells of every pre-stamp component must
    // stay in ONE component — a stamp that splits any open region (alone or
    // jointly with skeleton walls, across corridor mouths or sector seams) is
    // fully reverted (restoring exact EMPTY; the paint-gate guarantees every
    // written cell was EMPTY).
    //
    // SLOT-PINCH guard (the late-closer class): a stamp may not leave any
    // EMPTY cell squeezed between wall-like tiles on opposite cardinals
    // (a 1-wide slot). The keep/entity passes that run AFTER this one write
    // single tiles with only anchor-local (or no) seal awareness — a slot is
    // exactly the gap one such tile can plug to seal a large pocket (the
    // documented ticket-24 seed-55 class, now reachable through prefab-adjacent
    // collars too). Refusing slots keeps every gap ≥2 wide by construction.
    const postLabels = labelEmptyComponents(composite);
    if (
      stampSplitsOpenRegions(preLabels, postLabels, composite) ||
      stampPinchesSlot(composite, written, sRow, sCol)
    ) {
      for (const [r, c] of written) {
        sector.tiles[r]![c] = TileType.EMPTY;
        composite[sRow * SECTOR_TILE_SIZE + r]![sCol * SECTOR_TILE_SIZE + c] = TileType.EMPTY;
      }
      return { walls, props, cells: [], sealed: true };
    }
    // The stamp LANDED — the composite changed, so the cached baseline is now
    // stale for every later attempt.
    this.preLabelsCache = null;
    return { walls, props, cells: written, sealed: false };
  }

  /**
   * The composite's current EMPTY-component labels (memoized while the grid
   * is unchanged — see {@link preLabelsCache}).
   */
  private preLabelsOf(composite: Uint8Array[]): Int32Array {
    if (!this.preLabelsCache) this.preLabelsCache = labelEmptyComponents(composite);
    return this.preLabelsCache;
  }
}
