import { MapSchema } from '@colyseus/schema';
import {
  EliminationRecordSchema,
  SiegeSectorSchema,
  MapSiegeProgressSchema,
  type GameStateSchema,
} from '../schemas/index.ts';
import type { EliminationRecord } from '../../domain/services/EliminationService.ts';
import type { SiegedSector } from '../../domain/services/SiegeService.ts';
import type { AnimStateResolver, MatchState } from './StateMapperTypes.ts';

/**
 * One row of the entity sync table (#23): how a single domain entity map is
 * mirrored into its wire `MapSchema`. Adding a new synced entity type is one
 * `entitySyncRow(...)` entry in `StateMapper.ENTITY_SYNC_ROWS`.
 */
export interface EntitySyncRow<D, S> {
  /** Domain source map (resolved once per sync tick from the match state). */
  domainMap(state: MatchState): Map<string, D>;
  /** Wire target map (resolved once per sync tick from the room schema). */
  schemaMap(schema: GameStateSchema): MapSchema<S>;
  /** Wire-object factory for keys not yet present on the wire. */
  create(): S;
  /** Field projector: copies domain fields onto the wire object. */
  project(domain: D, schema: S, getAnimState: AnimStateResolver): void;
  /**
   * Optional static-row sync gate (perf-arc-neo ticket 08): when present,
   * the row is only mirrored when the gate's domain version counter has
   * advanced since the last projection. For static entity kinds only.
   */
  gate?: StaticRowGate;
}

/**
 * Type-erased view of `EntitySyncRow` — the element type of the heterogeneous
 * sync table. Members are method-declared so each row's concrete generics stay
 * assignable (parameter bivariance) without resorting to `any`.
 */
export interface ErasedEntitySyncRow {
  domainMap(state: MatchState): Map<string, unknown>;
  schemaMap(schema: GameStateSchema): MapSchema<unknown>;
  create(): unknown;
  project(domain: unknown, schema: unknown, getAnimState: AnimStateResolver): void;
  gate?: StaticRowGate;
}

/**
 * perf-arc-neo ticket 08 — static-row sync gate. Stops `mapDelta` from
 * re-projecting unchanged static entity rows (destructibles, exits) into the
 * Colyseus schema on every 30Hz sync: the domain side bumps a per-kind
 * version counter at every real mutation site, the wire side remembers the
 * last-projected counter value in a plain never-encoded field on
 * `GameStateSchema`, and an unchanged counter skips the whole mirror walk.
 * This is wire-identical to re-projecting — skipped rows already hold the
 * current values, and Colyseus setters skip same-value writes anyway — so the
 * patch bytes are unchanged; it is a pure CPU win (up to 2048 destructibles ×
 * 13 accessor calls × 30Hz of no-op compares removed).
 *
 * LOAD-BEARING INVARIANT — the counter must be bumped at EVERY mutation /
 * membership site of the kind, or clients see stale rows (the stale-hp /
 * stale-primed-fuse class of bug). The audited destructible sites:
 *
 *   Membership:
 *   - `GameMatch.addDestructible` (MapEntityFactory spawns)
 *   - `GameMatch.hydrateEntities` (GameMatchHydration direct sets)
 *   - `GameMatch.destroyDestructible` — every destroy funnel: melee
 *     (DestructibleDamageHandler), arrow/thrown destroyed hits
 *     (ProjectileUpdateContext.destroyDestructible), fuse expiry
 *     (step5_PropagateBarrels), siege (MapSiegeService.destroyEntitiesOnTile),
 *     the orphan sweep (processDestroyedDestructibles)
 *   - the barrel-chain delete in `BarrelExplosionManager.resolveExplosion`
 *     (covered by its `onDestructiblesMutated` hook — deletion there only
 *     follows a destroying takeDamage)
 *
 *   Field damage (`Destructible.takeDamage` — hp / isDestroyed / primed /
 *   fuseExpiresAtTick are mutated nowhere else):
 *   - `DestructibleDamageHandler.handleDamage` (melee; AttackExecutor +
 *     MeleeSweepHandler batch into it)
 *   - `BarrelExplosionManager` chain damage (the same hook)
 *   - arrow hits (`RangedHandler.updateArrow`) and thrown hits
 *     (`ThrowHandlerCollision`) — surfaced to `GameMatchProjectileUpdater`
 *     via `destructibleHit` / `destructibleHits`, bumped through the
 *     `onDestructiblesMutated` ctx hook
 *
 * Exits are add-only today: `GameMatch.addExit` is the single site (exits are
 * never removed, and `Exit.activate()` has no callers — any future exit
 * mutation MUST bump `GameMatch.exitVersion`). Iron destructibles and hits on
 * already-destroyed rows bump without mutating — harmless (one extra
 * projection pass), never stale.
 */
export interface StaticRowGate {
  /** Current domain version counter for the kind. */
  version(state: MatchState): number;
  /** Last version the mapper projected, stored on the per-room wire holder. */
  lastProjected(schema: GameStateSchema): number;
  /** Record a projection at `version`. */
  setLastProjected(schema: GameStateSchema, version: number): void;
}

/** Gate instance for the destructible row (module-stable — see the interface doc). */
export const DESTRUCTIBLE_ROW_GATE: StaticRowGate = {
  version: (state) => state.destructibleVersion,
  lastProjected: (schema) => schema.lastProjectedDestructibleVersion,
  setLastProjected: (schema, version) => {
    schema.lastProjectedDestructibleVersion = version;
  },
};

/** Gate instance for the exit row (module-stable — see the interface doc). */
export const EXIT_ROW_GATE: StaticRowGate = {
  version: (state) => state.exitVersion,
  lastProjected: (schema) => schema.lastProjectedExitVersion,
  setLastProjected: (schema, version) => {
    schema.lastProjectedExitVersion = version;
  },
};

/**
 * Anchor a table row's concrete domain/schema generics, then type-erase it for
 * the homogeneous table array. Internal row consistency (domainMap's `D`
 * matches project's `D`; schemaMap's `S` matches create's `S`) is checked
 * here, so a mismatched row fails at compile time.
 *
 * @param row Fully-typed sync row.
 * @returns The same row reference, type-erased for table storage.
 */
export function entitySyncRow<D, S>(row: EntitySyncRow<D, S>): ErasedEntitySyncRow {
  return row;
}

export class StateMapperSync {
  /**
   * Mirror a domain `Map` into a Colyseus `MapSchema`: create missing wire
   * objects via `create`, project fields via `update`, delete wire keys whose
   * domain key vanished. `getAnimState` is threaded verbatim into `update`'s
   * third parameter so per-call context reaches projectors as an argument
   * instead of a closure — zero allocation per sync tick (#23). Projectors
   * that don't need it simply declare fewer parameters; a caller whose
   * projector reads the resolver MUST pass it.
   *
   * @param domainMap Authoritative domain source map.
   * @param schemaMap Wire target map.
   * @param create Wire-object factory for fresh keys.
   * @param update Field projector for existing and fresh wire objects.
   * @param getAnimState Per-call context threaded into `update`.
   */
  static syncMap<D, S>(
    domainMap: Map<string, D>,
    schemaMap: MapSchema<S>,
    create: () => S,
    update: (domain: D, schema: S, getAnimState: AnimStateResolver) => void,
    getAnimState?: AnimStateResolver,
  ): void {
    for (const [id, entity] of domainMap) {
      let s = schemaMap.get(id);
      if (!s) {
        s = create();
        schemaMap.set(id, s);
      }
      update(entity, s, getAnimState as AnimStateResolver);
    }
    for (const id of schemaMap.keys()) {
      if (!domainMap.has(id)) {
        schemaMap.delete(id);
      }
    }
  }

  static syncEliminations(
    records: readonly EliminationRecord[],
    schemas: MapSchema<EliminationRecordSchema>,
  ): void {
    for (const record of records) {
      const key = String(record.order);
      let es = schemas.get(key);
      if (!es) {
        es = new EliminationRecordSchema();
        schemas.set(key, es);
      }
      es.order = record.order;
      es.playerId = record.playerId;
      es.killerId = record.killerId ?? '';
      es.weaponType = record.weaponType != null ? Number(record.weaponType) : 0;
      es.timestamp = record.timestamp;
    }
  }

  static syncSiegeSectors(
    sectors: readonly SiegedSector[],
    schemas: MapSchema<SiegeSectorSchema>,
  ): void {
    for (const sector of sectors) {
      const key = `${sector.row},${sector.col}`;
      let ss = schemas.get(key);
      if (!ss) {
        ss = new SiegeSectorSchema();
        schemas.set(key, ss);
      }
      ss.row = sector.row;
      ss.col = sector.col;
      ss.active = true;
    }
  }

  static syncMapSiegeProgress(
    progress: { northOffset: number; eastOffset: number; southOffset: number; westOffset: number },
    schema: MapSiegeProgressSchema,
  ): void {
    schema.northOffset = progress.northOffset;
    schema.eastOffset = progress.eastOffset;
    schema.southOffset = progress.southOffset;
    schema.westOffset = progress.westOffset;
  }
}
