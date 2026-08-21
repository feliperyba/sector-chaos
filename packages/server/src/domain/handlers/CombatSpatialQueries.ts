/**
 * CombatSpatialQueries — the combat scan sites' shared entry point into the
 * domain spatial index (`DomainSpatialIndex`, ticket 17).
 *
 * server-combat-spatial-queries (ticket 18). The five combat-path entity
 * scans — ranged arrow vs destructibles / vs players, thrown projectile vs
 * destructibles / vs players, and the melee hurtbox gather — route their
 * candidate iteration through these helpers instead of walking the whole
 * players/destructibles Map per query.
 *
 * Both helpers return candidates in source-Map iteration order (the query's
 * id-sorted output reordered by insertion rank via `sortQueryResultsBySeq`),
 * which is the exact order the pre-index linear scans visited — so
 * first-hit-wins tie-breaks and the melee gather order (weapon-break /
 * shield-block interruption sequences) are unchanged.
 *
 * ## Contract (per candidate, at the consumer)
 *
 * The query is a BROADPHASE: it returns every indexed entity whose CELL
 * overlaps the query circle's bounding box — a superset of the entities whose
 * center is within `radius`. Each consumer MUST apply, per candidate:
 *
 * 1. Its own liveness/owner filters (`isActive`, owner/immunity, `isDestroyed`
 *    ≡ map-membership re-verification — destructibles are only deleted AFTER
 *    `takeDamage` set `isDestroyed`, both delete sites), exactly as the old
 *    linear scans did inline.
 * 2. The site's exact distance/shape predicate on the entity's LIVE position
 *    (the index's stored position is only for cell assignment; positions can
 *    move after the step2 rebuild via step7 teleports / step8 dash overlap).
 *
 * The regression harness (`tests/domain/aggregates/DomainSpatialIndex.test.ts`)
 * asserts `collect* ∩ sitePredicate == oldLinearScan ∩ sitePredicate` — with
 * ORDER equality — per tick over a fast-forward bot match.
 *
 * ## Fallback (index null)
 *
 * Production always passes a non-null index: `GameSimulation.step2` rebuilds
 * it before any combat step runs (steps 3-8 all execute after step2 within
 * the same `step()`). The null path is the exact pre-index linear scan, kept
 * for callers that run outside a simulation step (unit tests, handlers driven
 * directly) — same members, same Map order, so behavior is identical either
 * way.
 */
import type {
  DomainSpatialIndex,
  DomainSpatialQueryResult,
} from '../aggregates/DomainSpatialIndex.ts';
import { sortQueryResultsBySeq } from '../aggregates/DomainSpatialIndex.ts';
import type { Player, Destructible } from '../entities/index.ts';

/**
 * Player candidates within `radius` of (x, y), in players-Map iteration
 * order. NOTE: the players grid indexes ALL map members (alive + dead) — the
 * ranged arrow site must see corpses (they absorb arrows); the other sites
 * filter `isActive` themselves.
 */
export function collectPlayersInMapOrder(
  spatialIndex: DomainSpatialIndex | null,
  players: Map<string, Player>,
  x: number,
  y: number,
  radius: number,
  scratch: DomainSpatialQueryResult<Player>,
): Player[] {
  if (!spatialIndex) {
    const entities = scratch.entities;
    const seqs = scratch.seqs;
    entities.length = 0;
    seqs.length = 0;
    let seq = 0;
    for (const p of players.values()) {
      entities.push(p);
      seqs.push(seq++);
    }
    return entities;
  }
  spatialIndex.queryPlayers(x, y, radius, scratch);
  sortQueryResultsBySeq(scratch);
  return scratch.entities;
}

/**
 * Destructible candidates within `radius` of (x, y), in
 * destructibles-Map iteration order. The grid indexes non-destroyed
 * destructibles only; consumers still re-check `isDestroyed` per candidate
 * (destruction happens mid-tick after the step2 rebuild).
 */
export function collectDestructiblesInMapOrder(
  spatialIndex: DomainSpatialIndex | null,
  destructibles: Map<string, Destructible>,
  x: number,
  y: number,
  radius: number,
  scratch: DomainSpatialQueryResult<Destructible>,
): Destructible[] {
  if (!spatialIndex) {
    const entities = scratch.entities;
    const seqs = scratch.seqs;
    entities.length = 0;
    seqs.length = 0;
    let seq = 0;
    for (const d of destructibles.values()) {
      entities.push(d);
      seqs.push(seq++);
    }
    return entities;
  }
  spatialIndex.queryDestructibles(x, y, radius, scratch);
  sortQueryResultsBySeq(scratch);
  return scratch.entities;
}
