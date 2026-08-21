/**
 * HurtboxGathering — broad-phase candidate collection for melee attacks.
 * Extracted from AttackExecutor so both the legacy instant hit path and the
 * swept-melee handler share it.
 *
 * server-combat-spatial-queries (ticket 18, site S5): the former full-map
 * manual distance pre-filter is now the domain spatial index's broadphase
 * query. Query radius = the old filter's exact `broadRange`
 * (`range + max(HURTBOX_SIZE, DESTRUCTIBLE_HURTBOX_SIZE)` margin); the cell
 * query is a SUPERSET of the old circle (bbox-overlap semantics), so the old
 * exact squared-distance check still applies post-query and the gathered
 * candidate set is bit-for-bit what the linear pre-filter produced. Entities
 * are emitted per kind in source-Map iteration order (seq-sorted query
 * results) — the order MeleeSweepHandler consumes victims in (weapon-break /
 * shield-block interruption sequences depend on it).
 *
 * perf ticket 11: the gather is zero-allocation at steady state. The former
 * per-candidate 4-object cluster (HurtboxEntity + position + hurtbox + the
 * entities/entityMap/wrapper containers) is now a high-water object pool
 * (the WorldSnapshot slot-pool idiom, scaled down): DTOs are pre-allocated
 * once with their nested position/hurtbox boxes and rewritten field-for-field
 * in place with exactly the values the former literals held. `entities`,
 * `entityMap`, and the returned wrapper are reused (cleared) per gather.
 *
 * POOL CONTRACT — consume within the gather's scope, never stash:
 * every DTO, the arrays, the Map, and the wrapper are OVERWRITTEN by the next
 * `gatherHurtboxEntities` call. Retention audit (both call sites, verified):
 *   - MeleeSweepHandler.processSwing (:166): iterates `candidates.entities`
 *     in-loop; `hitPlayers` wrappers hold `entity` refs but are consumed
 *     within the same processSwing (same tick, same swing); `swing.hitSet`
 *     stores only ids; `entityMap` is not read on this path.
 *   - AttackExecutor.executeAttack (:138): `entities`/`entityMap` are read
 *     synchronously — filterByOcclusion (position/gridX/gridY), the attack
 *     strategy handlers (id/position/hurtbox), and the resolveMeleeDamage
 *     closure (entityMap → kind) all run inside the same synchronous
 *     `handler.execute` call; `ctx` (holding the closure) dies with
 *     executeAttack.
 * Neither consumption chain re-enters the gather (no nested attack/spawn
 * path calls gatherHurtboxEntities), so the pool is NOT re-entrant-safe by
 * design — matching the module-scope query scratches above (single-threaded
 * simulation, one gather per attack/swing-tick).
 */
import { COMBAT, type HurtboxEntity } from '@sector-battle/shared';
import type { GameMatch } from '../aggregates/GameMatch.ts';
import type {
  DomainSpatialIndex,
  DomainSpatialQueryResult,
} from '../aggregates/DomainSpatialIndex.ts';
import { createSpatialQueryResult } from '../aggregates/DomainSpatialIndex.ts';
import type { Player, Destructible } from '../entities/index.ts';
import {
  collectPlayersInMapOrder,
  collectDestructiblesInMapOrder,
} from './CombatSpatialQueries.ts';

export interface GatheredHurtboxes {
  entities: HurtboxEntity[];
  entityMap: Map<string, HurtboxEntity>;
}

/**
 * Module-scope query scratch (single-threaded simulation; the gather is never
 * re-entered — MeleeSweepHandler/AttackExecutor call it once per attack).
 * Same scratch idiom as GameMatchProjectileUpdater's collision buffer.
 */
const playerQueryScratch: DomainSpatialQueryResult<Player> = createSpatialQueryResult();
const destructibleQueryScratch: DomainSpatialQueryResult<Destructible> = createSpatialQueryResult();

/**
 * High-water DTO pool (perf ticket 11). Slot i is handed to the i-th emitted
 * candidate of a gather; slots are created once (with their nested
 * position/hurtbox boxes) and rewritten in place thereafter. The player
 * branch clears the destructible-only optional fields (gridX/gridY/nonSolid)
 * so a slot recycled from a destructible carries exactly the shape the former
 * fresh player literal had (all downstream reads are kind-gated anyway).
 */
const entityPool: HurtboxEntity[] = [];
/** Reused output containers + wrapper (cleared at the top of every gather). */
const entitiesScratch: HurtboxEntity[] = [];
const entityMapScratch = new Map<string, HurtboxEntity>();
const gatheredScratch: GatheredHurtboxes = {
  entities: entitiesScratch,
  entityMap: entityMapScratch,
};

/** Take-or-grow pool slot i as a pre-allocated HurtboxEntity. */
function pooledEntity(index: number): HurtboxEntity {
  let entity = entityPool[index];
  if (!entity) {
    entity = {
      id: '',
      kind: 'player',
      position: { x: 0, y: 0 },
      hurtbox: { x: 0, y: 0, width: 0, height: 0 },
    };
    entityPool[index] = entity;
  }
  return entity;
}

export function gatherHurtboxEntities(
  match: GameMatch,
  player: Player,
  range: number,
): GatheredHurtboxes {
  const state = match.getState();
  const entities = entitiesScratch;
  entities.length = 0;
  const entityMap = entityMapScratch;
  entityMap.clear();
  const halfPlayerHurtbox = COMBAT.HURTBOX_SIZE / 2;
  const halfDestructibleHurtbox = COMBAT.DESTRUCTIBLE_HURTBOX_SIZE / 2;
  const broadRange = range + Math.max(COMBAT.HURTBOX_SIZE, COMBAT.DESTRUCTIBLE_HURTBOX_SIZE);
  const originX = player.movement.position.x;
  const originY = player.movement.position.y;
  // The spatial index is rebuilt every tick at step2, which runs before both
  // consumers (step3 melee sweeps, step8 windup completions) — null only
  // outside a live simulation (unit tests), where collect* falls back to the
  // identical linear scan.
  const spatialIndex: DomainSpatialIndex | null = match.spatialIndex;

  const playerCandidates = collectPlayersInMapOrder(
    spatialIndex,
    state.players,
    originX,
    originY,
    broadRange,
    playerQueryScratch,
  );
  for (const p of playerCandidates) {
    if (p.id === player.id) continue;
    if (!p.isActive) continue;

    const dx = p.movement.position.x - originX;
    const dy = p.movement.position.y - originY;
    if (dx * dx + dy * dy > broadRange * broadRange) continue;

    const entity = pooledEntity(entities.length);
    entity.id = p.id;
    entity.kind = 'player';
    entity.position.x = p.movement.position.x;
    entity.position.y = p.movement.position.y;
    entity.hurtbox.x = p.movement.position.x - halfPlayerHurtbox;
    entity.hurtbox.y = p.movement.position.y - halfPlayerHurtbox - COMBAT.HURTBOX_VERTICAL_OFFSET;
    entity.hurtbox.width = COMBAT.HURTBOX_SIZE;
    entity.hurtbox.height = COMBAT.HURTBOX_SIZE;
    entity.gridX = undefined;
    entity.gridY = undefined;
    entity.nonSolid = undefined;
    entities.push(entity);
    entityMap.set(p.id, entity);
  }

  const destructibleCandidates = collectDestructiblesInMapOrder(
    spatialIndex,
    state.destructibles,
    originX,
    originY,
    broadRange,
    destructibleQueryScratch,
  );
  for (const d of destructibleCandidates) {
    if (!d.isActive) continue;

    const dx = d.position.x - originX;
    const dy = d.position.y - originY;
    if (dx * dx + dy * dy > broadRange * broadRange) continue;

    const entity = pooledEntity(entities.length);
    entity.id = d.id;
    entity.kind = 'destructible';
    entity.position.x = d.position.x;
    entity.position.y = d.position.y;
    entity.hurtbox.x = d.position.x - halfDestructibleHurtbox;
    entity.hurtbox.y = d.position.y - halfDestructibleHurtbox;
    entity.hurtbox.width = COMBAT.DESTRUCTIBLE_HURTBOX_SIZE;
    entity.hurtbox.height = COMBAT.DESTRUCTIBLE_HURTBOX_SIZE;
    entity.gridX = Math.floor(d.position.x / match.tileWidth);
    entity.gridY = Math.floor(d.position.y / match.tileWidth);
    // Map-polish ticket 07: light-prop fixtures sit on EMPTY tiles with no
    // enriched tile collider — flag them so the swept-melee contact falls
    // back to this hurtbox (solid destructibles keep the tile-collider
    // contact path unchanged). Keyed on the entity's non-solid property
    // (ticket 09) so future non-solid types inherit the fallback.
    entity.nonSolid = d.nonSolid;
    entities.push(entity);
    entityMap.set(d.id, entity);
  }

  return gatheredScratch;
}
