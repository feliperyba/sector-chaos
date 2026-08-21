/**
 * DomainSpatialIndex — domain-side uniform spatial hash (broadphase) over the
 * two entity kinds the combat scan sites query: ALL players (alive + dead)
 * and ACTIVE (non-destroyed) destructibles.
 *
 * server-domain-spatial-hash (ticket 17); combat routing (ticket 18,
 * server-combat-spatial-queries) made the five combat scan sites consumers.
 * This module is the domain-layer counterpart of the AI package's shared
 * `EntitySpatialGrid` pattern (512px flat uniform hash, typed-array linked
 * lists). It deliberately does NOT import from `ai/` (or from shared's grid):
 * the domain index carries a stricter contract than the perception grid —
 * deterministic id-sorted query results plus per-entity insertion-rank (`seq`)
 * so routed consumers can reproduce the players-/destructibles-Map iteration
 * order the pre-index linear scans saw.
 *
 * ## Snapshot contract (read before routing a consumer through this index)
 *
 * The index is rebuilt ONCE per tick at the end of step2 (movement resolution)
 * — see `GameSimulation.step2_ResolveMovement`. It is a SNAPSHOT:
 *
 * 1. POSITIONS are post-step2 positions. Players do not move again until the
 *    next tick's step2, EXCEPT teleport traps (step7) and dash-end overlap
 *    resolution (step8), which mutate positions in place later in the tick.
 * 2. DESTRUCTIBLES can be destroyed during steps 3-8 (melee, projectiles,
 *    barrel chains — `BarrelExplosionManager` even *deletes* them from the
 *    match map mid-resolution). The index keeps pointing at the entity.
 * 3. PLAYER aliveness can flip in step9 (death resolution) and outside step()
 *    entirely (revive) — one tick later the stale index still lists players
 *    that died in the previous tick's step9. Because the PLAYERS grid indexes
 *    ALL players (alive + dead — see `rebuildFrom`), this staleness is only a
 *    liveness flag drift, never a missing candidate: consumers that filter
 *    `isActive` (thrown/melee/barrel sites) skip the stale-dead candidate a
 *    tick late — exactly what the old linear scans did too (they read
 *    `isActive` at scan time, which only flips in step9). The ranged arrow
 *    site deliberately does NOT filter `isActive` (corpses absorb arrows).
 *
 * Therefore: **a query result is a broadphase CANDIDATE set, nothing more.**
 * Every consumer MUST, per candidate, re-read live state — `player.isActive`,
 * `destructible.isDestroyed` (+ live map membership), and the entity's LIVE
 * position for the exact hit-shape test — exactly like the power-up grid's
 * re-validation precedent (`checkPowerUpWalkOverSim`). The regression harness
 * (`tests/domain/aggregates/DomainSpatialIndex.test.ts`) encodes this: it
 * asserts `query ∩ sitePredicate == linearScan ∩ sitePredicate` where the
 * predicate always re-reads live entity state.
 *
 * ## Query determinism (the ordering contract)
 *
 * `queryPlayers`/`queryDestructibles` return results sorted by entity id with
 * a plain code-unit string comparison (`a < b ? -1 : a > b ? 1 : 0`). Given
 * the same rebuilt state, the same query returns the same ordered list on
 * every call, every tick, every seed, every process:
 *
 * - Entity ids are unique within a map (players/destructibles are Map keys),
 *   so the sort is a total order — no ties, no stability dependence.
 * - The comparator is code-unit (binary) comparison, NOT `localeCompare`:
 *   locale/ICU-dependent collation varies across Node builds and would break
 *   cross-process determinism. (Ids are ASCII — session ids, `bot_*`,
 *   `match_*` generator ids — so code-unit order is also intuitive.)
 * - No `Math.random`, no `Set`/`Map` iteration order leaks into results: the
 *   cell walk is row-major deterministic, and the final id-sort makes even
 *   that irrelevant to the output order.
 *
 * IMPORTANT: id-sort is NOT the players-Map insertion order the current
 * linear scans iterate. Several scan sites are order-sensitive (first-hit
 * wins; melee durability/block interruption sequences; explosion victim
 * sequencing — see the ticket-17 audit in the regression harness and
 * `GameSimulation.step2_ResolveMovement`). For those sites, routed consumers
 * must reproduce Map insertion order by sorting candidates by the parallel
 * `seqs` array (ascending `seq` == Map iteration rank at rebuild time), which
 * this index stores per result entry for exactly that purpose.
 *
 * ## seq (insertion rank)
 *
 * At rebuild, entities are inserted in source-Map iteration order and their
 * slot number IS their rank (slot k = k-th player / k-th active destructible
 * in Map insertion order). Because Map iteration order is order-isomorphic on
 * any subset, sorting any subset by `seq` reproduces the relative order a
 * full-map linear scan would visit them in. For players the rank is over ALL
 * map members (alive + dead) — the exact population the pre-index ranged
 * arrow scan iterated; the isActive-filtering sites see the same relative
 * order within the alive subset.
 *
 * Routed consumers get this via `sortQueryResultsBySeq` (below) — used by all
 * five combat scan sites (ticket 18) to keep hit-selection tie-break order
 * identical to the linear scans they replaced.
 */

import type { Player } from '../entities/Player.ts';
import type { Destructible } from '../entities/Destructible.ts';
import type { GameMatch } from './GameMatch.ts';

/** Cell size in pixels — matches the AI perception grid's canonical sizing. */
export const DOMAIN_SPATIAL_CELL_SIZE = 512;

/**
 * Caller-owned query result buffer (scratch idiom): pass one instance per
 * call site, reuse across ticks. `entities[i]` pairs with `seqs[i]`;
 * entries are ordered by entity id ascending (see module determinism notes).
 */
export interface DomainSpatialQueryResult<TEntity> {
  entities: TEntity[];
  /** Insertion rank of the paired entity at rebuild time (slot number). */
  seqs: number[];
}

export function createSpatialQueryResult<TEntity>(): DomainSpatialQueryResult<TEntity> {
  return { entities: [], seqs: [] };
}

/**
 * Reorder a query result in place by insertion rank (`seqs` ascending) — i.e.
 * into source-Map iteration order, the order the pre-index linear combat
 * scans visited candidates in. This is how routed order-sensitive consumers
 * (first-hit-wins scans, melee gather) reproduce the old tie-break order from
 * the id-sorted query output. Used by all five combat scan sites (ticket 18).
 * Zero steady-state allocation (module scratch, single-threaded sim).
 */
const seqSortPermutationScratch: number[] = [];
const seqSortEntitiesScratch: unknown[] = [];
const seqSortSeqsScratch: number[] = [];

export function sortQueryResultsBySeq<TEntity>(out: DomainSpatialQueryResult<TEntity>): void {
  const { entities, seqs } = out;
  const n = entities.length;
  if (n < 2) return;

  const perm = seqSortPermutationScratch;
  perm.length = 0;
  for (let i = 0; i < n; i++) perm.push(i);
  perm.sort((a, b) => seqs[a]! - seqs[b]!);

  const tmpEntities = seqSortEntitiesScratch as TEntity[];
  tmpEntities.length = 0;
  const tmpSeqs = seqSortSeqsScratch;
  tmpSeqs.length = 0;
  for (let i = 0; i < n; i++) {
    const j = perm[i]!;
    tmpEntities.push(entities[j]!);
    tmpSeqs.push(seqs[j]!);
  }
  for (let i = 0; i < n; i++) {
    entities[i] = tmpEntities[i]!;
    seqs[i] = tmpSeqs[i]!;
  }
}

/** Anything the index can key on — both indexed entities expose `id`. */
interface IdentifiableEntity {
  readonly id: string;
}

/** Plain code-unit string comparison — see determinism notes. Deterministic. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One kind's uniform grid: flat typed-array linked list
 * (`head[cell] → next[slot]`) over `cellSize`-pixel cells, mirroring the
 * shared `EntitySpatialGrid` layout. Unlike the shared grid, slots are
 * assigned in source-Map iteration order (slot == seq) and queries emit
 * id-sorted results plus the parallel seq column.
 */
class EntityKindGrid<TEntity extends IdentifiableEntity> {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellInv: number;
  private head: Int32Array;
  private next: Int32Array;
  /** Slot → entity. Slot number doubles as the insertion rank (seq). */
  private readonly slots: TEntity[] = [];
  private count = 0;
  /** Scratch for the id-sort permutation (single active query at a time). */
  private order: number[] = [];

  constructor(worldWidth: number, worldHeight: number, private readonly cellSize: number) {
    this.cellInv = 1 / cellSize;
    this.cols = Math.max(1, Math.ceil(worldWidth * this.cellInv));
    this.rows = Math.max(1, Math.ceil(worldHeight * this.cellInv));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(16).fill(-1);
  }

  /** Reset for a rebuild. O(cells) — a head.fill, same as the shared grid. */
  begin(): void {
    this.head.fill(-1);
    this.count = 0;
    this.slots.length = 0;
  }

  /** Insert an entity at (x, y). Call in source-Map iteration order. */
  insert(entity: TEntity, x: number, y: number): void {
    const slot = this.count;
    if (slot >= this.next.length) {
      // Grow the linked-list arrays when the entity population exceeds the
      // previous high-water mark (players ≤ lobby size; destructibles ≈ map
      // generation count — both known small, growth is rare after warmup).
      const grown = new Int32Array(this.next.length * 2).fill(-1);
      grown.set(this.next);
      this.next = grown;
    }
    this.slots[slot] = entity;

    let cx = (x * this.cellInv) | 0;
    let cy = (y * this.cellInv) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    const cell = cy * this.cols + cx;
    this.next[slot] = this.head[cell]!;
    this.head[cell] = slot;
    this.count = slot + 1;
  }

  /** Number of indexed entities (after the last rebuild / insert). */
  get size(): number {
    return this.count;
  }

  /**
   * Broadphase circle query: collects every indexed entity whose CELL overlaps
   * the query circle's bounding box (row-major cell walk), then emits them
   * into `out` sorted by id (with parallel seqs). This is a CANDIDATE set —
   * consumers apply the exact distance/shape predicate on live state.
   */
  queryInto(x: number, y: number, radius: number, out: DomainSpatialQueryResult<TEntity>): void {
    const inv = this.cellInv;
    let minCx = ((x - radius) * inv) | 0;
    let maxCx = ((x + radius) * inv) | 0;
    let minCy = ((y - radius) * inv) | 0;
    let maxCy = ((y + radius) * inv) | 0;
    if (minCx < 0) minCx = 0;
    if (minCy < 0) minCy = 0;
    if (maxCx >= this.cols) maxCx = this.cols - 1;
    if (maxCy >= this.rows) maxCy = this.rows - 1;

    // Collect candidate slot numbers (deterministic row-major walk).
    const order = this.order;
    order.length = 0;
    const cols = this.cols;
    const head = this.head;
    const next = this.next;
    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowBase = cy * cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        let slot = head[rowBase + cx]!;
        while (slot >= 0) {
          order.push(slot);
          slot = next[slot]!;
        }
      }
    }

    // Sort the slot permutation by entity id (code-unit) — deterministic
    // total order, ids are unique.
    const slots = this.slots;
    order.sort((a, b) => compareIds(slots[a]!.id, slots[b]!.id));

    const entities = out.entities;
    const seqs = out.seqs;
    entities.length = 0;
    seqs.length = 0;
    for (let i = 0; i < order.length; i++) {
      const slot = order[i]!;
      entities.push(slots[slot]!);
      seqs.push(slot);
    }
  }
}

/**
 * Domain-side broadphase spatial hash over all players (alive + dead) and
 * active (non-destroyed) destructibles for one match. Rebuilt once per tick by
 * `GameMatch.rebuildSpatialIndex` (called from step2, after movement
 * resolution) — the same placement pattern as the power-up grid rebuild.
 *
 * Consumers (ticket 18, server-combat-spatial-queries): the five combat scan
 * sites route their entity iteration through `queryPlayers` /
 * `queryDestructibles` via the `collect*InMapOrder` helpers
 * (`domain/handlers/CombatSpatialQueries.ts`) — ranged arrow vs
 * destructibles/players, thrown vs destructibles/players, and the melee
 * hurtbox gather. The regression harness
 * (`tests/domain/aggregates/DomainSpatialIndex.test.ts`) cross-checks the
 * routed candidate streams against the old linear scans every tick.
 */
export class DomainSpatialIndex {
  private readonly playersGrid: EntityKindGrid<Player>;
  private readonly destructiblesGrid: EntityKindGrid<Destructible>;
  /** Match tick of the last rebuild (diagnostic/harness marker). */
  lastRebuildTick = -1;

  constructor(worldWidth: number, worldHeight: number, cellSize = DOMAIN_SPATIAL_CELL_SIZE) {
    this.playersGrid = new EntityKindGrid<Player>(worldWidth, worldHeight, cellSize);
    this.destructiblesGrid = new EntityKindGrid<Destructible>(worldWidth, worldHeight, cellSize);
  }

  /**
   * Rebuild from the match's live maps:
   * - players: ALL players (alive + dead), in players-Map insertion order.
   *   The combat player scans split on liveness: the thrown/melee/barrel
   *   sites filter `isActive` at scan time, but the RANGED arrow scan does
   *   NOT — corpses absorb arrows today (the pre-index scan iterated the full
   *   map with only an owner skip; see RangedHandler.updateArrow). An
   *   alive-only grid could not return corpse candidates, so ticket 18 made
   *   the players grid a superset (all map members) and left the liveness
   *   decision to each consumer — the same division the destructibles grid
   *   already had. Corpse positions are frozen post-death (dead players are
   *   excluded from the per-tick alive array that drives step2 movement;
   *   DamagePipeline skips inactive targets at :53/:191/:317, so no knockback
   *   velocity is ever applied to a corpse), and the per-tick rebuild keeps
   *   every indexed position fresh regardless.
   * - destructibles: non-destroyed (`!isDestroyed`, identical to the
   *   entity's `isActive` getter), in destructibles-Map insertion order.
   *   (Destructibles are only ever deleted from the map AFTER `takeDamage`
   *   set `isDestroyed` — both delete sites, `destroyDestructibleAction` and
   *   the barrel chain, are guarded by a destroyed result — so a candidate's
   *   `isDestroyed` re-check also covers live map membership.)
   */
  rebuildFrom(match: GameMatch): void {
    const playersGrid = this.playersGrid;
    playersGrid.begin();
    for (const p of match.players.values()) {
      playersGrid.insert(p, p.movement.position.x, p.movement.position.y);
    }

    const destructiblesGrid = this.destructiblesGrid;
    destructiblesGrid.begin();
    for (const d of match.destructibles.values()) {
      if (d.isDestroyed) continue;
      destructiblesGrid.insert(d, d.position.x, d.position.y);
    }

    this.lastRebuildTick = match.tick;
  }

  /** Indexed player count (all map members at last rebuild). */
  get playerCount(): number {
    return this.playersGrid.size;
  }

  /** Indexed destructible count (non-destroyed at last rebuild). */
  get destructibleCount(): number {
    return this.destructiblesGrid.size;
  }

  /**
   * Broadphase circle query over indexed players. Results are id-sorted
   * candidates — re-verify `isActive` + live position per candidate.
   */
  queryPlayers(x: number, y: number, radius: number, out: DomainSpatialQueryResult<Player>): void {
    this.playersGrid.queryInto(x, y, radius, out);
  }

  /**
   * Broadphase circle query over indexed destructibles. Results are
   * id-sorted candidates — re-verify `isDestroyed`/map membership + live
   * position per candidate (destructibles are destroyed/deleted mid-tick).
   */
  queryDestructibles(
    x: number,
    y: number,
    radius: number,
    out: DomainSpatialQueryResult<Destructible>,
  ): void {
    this.destructiblesGrid.queryInto(x, y, radius, out);
  }
}
