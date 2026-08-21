/**
 * GameMatchState.ts — Partial for the cached `getState()` projection.
 *
 * `getState()` is called every tick. Spreading the entity-map refs into a fresh
 * object each call allocates for data that is largely identical to the previous
 * tick. StateMapper/MatchStateProjector reads the fields once per tick and
 * projects them in place without retaining the reference, so a single cached
 * object per match (keyed by the GameMatch instance in a WeakMap) mutated in
 * place is safe and avoids the per-tick allocation.
 */
import type { TileType, MatchPhase, ZoneState } from '@sector-battle/shared';
import type { EntityMaps } from './GameMatchEntityOps.ts';
import type { GameMatch } from './GameMatch.ts';

/** The cached state shape: stable entity maps plus per-tick scalars. */
export interface MatchStateView extends EntityMaps {
  /** ticket 08 — static-row sync-gate counters (see StateMapperSync.StaticRowGate). */
  destructibleVersion: number;
  exitVersion: number;
  tick: number;
  phase: MatchPhase;
  zone: ZoneState;
  grid: TileType[][];
  matchTime: number;
  lastProcessedInput: number;
}

const stateCache = new WeakMap<GameMatch, MatchStateView>();

/**
 * Return the cached match-state view, mutating its scalar fields in place.
 * The entity-map references are stable for the match lifetime.
 */
export function getMatchStateCached(
  match: GameMatch,
  maps: EntityMaps,
  tick: number,
  phase: MatchPhase,
  zone: ZoneState,
  grid: TileType[][],
  matchTime: number,
): MatchStateView {
  let view = stateCache.get(match);
  if (!view) {
    view = {
      players: maps.players,
      projectiles: maps.projectiles,
      powerUps: maps.powerUps,
      traps: maps.traps,
      chests: maps.chests,
      destructibles: maps.destructibles,
      weaponPickups: maps.weaponPickups,
      exits: maps.exits,
      explosions: maps.explosions,
      projectileMeta: maps.projectileMeta,
      tileIndex: maps.tileIndex,
      destructibleVersion: 0,
      exitVersion: 0,
      tick: 0,
      phase: phase,
      zone,
      grid,
      matchTime: 0,
      lastProcessedInput: 0,
    };
    stateCache.set(match, view);
  }
  view.destructibleVersion = match.destructibleVersion;
  view.exitVersion = match.exitVersion;
  view.tick = tick;
  view.phase = phase;
  view.zone = zone;
  view.grid = grid;
  view.matchTime = matchTime;
  view.lastProcessedInput = 0;
  return view;
}
