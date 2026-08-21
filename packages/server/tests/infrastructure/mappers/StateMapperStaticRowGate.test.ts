import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Encoder } from '@colyseus/schema';
import {
  StateMapper,
  type MatchMeta,
  type MatchState,
} from '../../../src/infrastructure/mappers/StateMapper.ts';
import { GameStateSchema } from '../../../src/infrastructure/schemas/index.ts';
import { Destructible, Exit } from '../../../src/domain/entities/index.ts';
import { Position, GridCoord } from '../../../src/domain/value-objects/index.ts';
import { MatchPhase, WeaponType } from '@sector-battle/shared';
import type { ZoneState } from '@sector-battle/shared';
import { DestructibleDamageHandler } from '../../../src/application/commands/DestructibleDamageHandler.ts';
import { updateProjectilesAction } from '../../../src/domain/aggregates/GameMatchProjectiles.ts';
import { createTestMatch } from '../../helpers/createTestMatch.ts';

/**
 * perf-arc-neo ticket 08 — static-row sync-gate tests.
 *
 * `StateMapper.mapDelta` skips re-projecting the destructible/exits entity
 * rows while their per-kind domain version counter
 * (`GameMatch.destructibleVersion` / `exitVersion`) is unchanged since the
 * last projection. Skipping is wire-identical to re-projecting (Colyseus
 * setters skip same-value writes), so the patch bytes must be byte-identical.
 *
 * MUTATION-SITE ENUMERATION (the stale-visuals audit — every site that can
 * change a projected destructible/exit field or map membership must bump its
 * counter; mirrored in the StaticRowGate doc on StateMapperSync.ts):
 *
 *   Destructibles — membership:
 *   - GameMatch.addDestructible          (MapEntityFactory spawns)
 *   - GameMatch.hydrateEntities          (GameMatchHydration direct sets)
 *   - GameMatch.destroyDestructible      (every destroy funnel: melee,
 *                                         arrow/thrown destroyed hits, fuse
 *                                         expiry step5, siege
 *                                         destroyEntitiesOnTile, orphan sweep)
 *   - BarrelExplosionManager chain delete (covered by its
 *                                         onDestructiblesMutated hook — the
 *                                         delete only follows a destroying
 *                                         takeDamage)
 *   Destructibles — field damage (takeDamage is the only mutator of
 *   hp / isDestroyed / primed / fuseExpiresAtTick):
 *   - DestructibleDamageHandler.handleDamage (melee; AttackExecutor +
 *                                         MeleeSweepHandler batch into it)
 *   - BarrelExplosionManager chain damage (same hook)
 *   - arrow hits (RangedHandler.updateArrow) + thrown hits
 *                                         (ThrowHandlerCollision) — consumed
 *                                         in GameMatchProjectileUpdater via
 *                                         destructibleHit/destructibleHits,
 *                                         bumped through the
 *                                         onDestructiblesMutated ctx hook
 *   Exits — add-only today:
 *   - GameMatch.addExit                  (MapEntityFactory; Exit.activate()
 *                                         has no callers — any future exit
 *                                         mutation MUST bump exitVersion)
 */

const TEST_META: MatchMeta = {
  matchId: 'gate-match',
  mapSeed: 808,
  mapWidth: 50,
  mapHeight: 50,
};

const TEST_ZONE: ZoneState = {
  currentPhase: 0,
  centerX: 25,
  centerY: 25,
  targetCenterX: 25,
  targetCenterY: 25,
  isTransitioningCenter: false,
  currentRadius: 50,
  targetRadius: 40,
  shrinkSpeed: 0.5,
  damagePerTick: 1,
  nextShrinkTick: 100,
  phaseStartTime: 0,
  phaseEndTime: 0,
};

function makeDestructible(id: string): Destructible {
  return Destructible.create(id, 'crate', new Position(160, 160));
}

function makeBarrel(id: string): Destructible {
  return Destructible.create(id, 'barrel', new Position(192, 160));
}

function makeExit(id: string): Exit {
  return new Exit(id, new Position(192, 192), new GridCoord(6, 6), 0);
}

function createGateState(): MatchState {
  return {
    players: new Map(),
    projectiles: new Map(),
    powerUps: new Map(),
    traps: new Map(),
    chests: new Map(),
    destructibles: new Map<string, Destructible>(),
    exits: new Map<string, Exit>(),
    explosions: new Map(),
    weaponPickups: new Map(),
    destructibleVersion: 1,
    exitVersion: 1,
    tick: 0,
    phase: MatchPhase.WAITING,
    zone: { ...TEST_ZONE },
    lastProcessedInput: 0,
    eliminations: [],
    siegedSectors: [],
    mapSiegeProgress: { northOffset: 0, eastOffset: 0, southOffset: 0, westOffset: 0 },
  };
}

describe('StateMapper static-row sync gate (ticket 08)', () => {
  beforeEach(() => {
    // mapDelta stamps Date.now() into schema.timestamp — pin it so the byte
    // comparisons below are deterministic.
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips re-projecting unchanged destructible/exit rows', () => {
    const state = createGateState();
    state.destructibles.set('d1', makeDestructible('d1'));
    state.exits.set('e1', makeExit('e1'));
    const schema = new GameStateSchema();
    StateMapper.mapDelta(state, schema, TEST_META, () => undefined);
    expect(schema.destructibles.get('d1')!.hp).toBe(2);
    expect(schema.exits.get('e1')!.sectorIndex).toBe(0);

    // Corrupt the wire rows directly. With the version counters unchanged,
    // the next sync must NOT re-project — the corruption survives, proving
    // the walk was skipped (an ungated re-projection would overwrite it with
    // the domain values).
    schema.destructibles.get('d1')!.hp = 99;
    schema.exits.get('e1')!.sectorIndex = 42;
    StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

    expect(schema.destructibles.get('d1')!.hp).toBe(99);
    expect(schema.exits.get('e1')!.sectorIndex).toBe(42);
  });

  it('re-projects destructibles/exits when their version counter advances', () => {
    const state = createGateState();
    const barrel = makeBarrel('b1');
    state.destructibles.set('b1', barrel);
    state.exits.set('e1', makeExit('e1'));
    const schema = new GameStateSchema();
    StateMapper.mapDelta(state, schema, TEST_META, () => undefined);
    expect(schema.destructibles.get('b1')!.hp).toBe(2);
    expect(schema.destructibles.get('b1')!.primed).toBe(false);

    // A surviving hit mutates hp/primed; the audited damage sites bump the
    // counter (simulated here exactly as DestructibleDamageHandler does).
    barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 10 });
    state.destructibleVersion++;
    const exit = state.exits.get('e1')!;
    exit.active = true;
    state.exitVersion++;
    StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

    expect(schema.destructibles.get('b1')!.hp).toBe(1);
    expect(schema.destructibles.get('b1')!.primed).toBe(true);
    expect(schema.exits.get('e1')!.active).toBe(true);

    // Membership changes ride the same counter: a removed row leaves the wire.
    state.destructibles.delete('b1');
    state.destructibleVersion++;
    StateMapper.mapDelta(state, schema, TEST_META, () => undefined);
    expect(schema.destructibles.get('b1')).toBeUndefined();
  });

  it('produces byte-identical patches vs the ungated always-reproject path', () => {
    // Two parallel universes: GATED skips no-change walks (ticket-08
    // behavior); UNGATED force-bumps the counters before every sync, which
    // reproduces the pre-ticket behavior of re-projecting every row every
    // sync. The Colyseus patch stream must be byte-identical at every step.
    const gated = createGateState();
    const ungated = createGateState();
    gated.destructibles.set('d1', makeDestructible('d1'));
    gated.destructibles.set('b1', makeBarrel('b1'));
    gated.exits.set('e1', makeExit('e1'));
    ungated.destructibles.set('d1', gated.destructibles.get('d1')!);
    ungated.destructibles.set('b1', gated.destructibles.get('b1')!);
    ungated.exits.set('e1', gated.exits.get('e1')!);

    const gatedSchema = new GameStateSchema();
    const ungatedSchema = new GameStateSchema();
    const gatedEncoder = new Encoder(gatedSchema);
    const ungatedEncoder = new Encoder(ungatedSchema);

    const syncAndCompare = (label: string) => {
      // Force the ungated universe to walk every row every sync.
      ungated.destructibleVersion++;
      ungated.exitVersion++;
      ungated.tick = gated.tick;

      StateMapper.mapDelta(gated, gatedSchema, TEST_META, () => undefined);
      StateMapper.mapDelta(ungated, ungatedSchema, TEST_META, () => undefined);

      const gatedBytes = gatedEncoder.encode();
      const ungatedBytes = ungatedEncoder.encode();
      expect(
        Buffer.from(gatedBytes).equals(Buffer.from(ungatedBytes)),
        `patch bytes at ${label}`,
      ).toBe(true);
    };

    // Step 1 — fresh sync (both walk; the -1 last-projected seed also forces
    // the gated first pass).
    syncAndCompare('fresh sync');

    // Step 2 — no domain change (gated skips, ungated re-projects).
    gated.tick = 5;
    syncAndCompare('unchanged tick');

    // Step 3 — real mutation + production-style bump (both walk the same
    // changed values).
    gated.destructibles.get('b1')!.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 10 });
    gated.destructibleVersion++;
    ungated.destructibles.get('b1')!.takeDamage({ source: 'melee', rawDamage: 1, currentTick: 10 });
    gated.tick = 10;
    syncAndCompare('barrel damaged + primed');

    // Step 4 — destruction + membership removal (both walk the delete).
    gated.destructibles.delete('b1');
    gated.destructibleVersion++;
    ungated.destructibles.delete('b1');
    gated.tick = 15;
    syncAndCompare('barrel destroyed');

    // Full-encode parity as the final byte-level proof.
    expect(
      Buffer.from(gatedEncoder.encodeAll()).equals(Buffer.from(ungatedEncoder.encodeAll())),
    ).toBe(true);
  });

  it('GameMatch mutation sites bump the per-kind counters', () => {
    const match = createTestMatch();

    // addDestructible / addExit (membership adds).
    const barrel = Destructible.create('b1', 'barrel', new Position(5 * 32 + 16, 5 * 32 + 16));
    match.addDestructible(barrel);
    expect(match.destructibleVersion).toBe(1);
    match.addExit(new Exit('e1', new Position(64, 64), new GridCoord(2, 2), 0));
    expect(match.exitVersion).toBe(1);

    // DestructibleDamageHandler.handleDamage (surviving melee hit: hp + the
    // primed fuse both change — the field-damage bump).
    const handler = new DestructibleDamageHandler(match);
    const events: unknown[] = [];
    handler.handleDamage(['b1'], match, events as never, WeaponType.FISTS);
    expect(match.destructibleVersion).toBe(2);
    expect(match.destructibles.get('b1')!.primed).toBe(true);

    // destroyDestructible (the destroy funnel) + the BarrelExplosionManager
    // hook: destroying the barrel runs resolveExplosion, whose ray hits the
    // adjacent crate → takeDamage → the onDestructiblesMutated hook fires.
    const crate = Destructible.create('c1', 'crate', new Position(6 * 32 + 16, 5 * 32 + 16));
    match.addDestructible(crate); // → 3
    expect(match.destructibleVersion).toBe(3);
    match.destroyDestructible('b1');
    expect(match.destructibleVersion).toBe(5); // destroy funnel + explosion hook

    // updateProjectilesAction wires the arrow/thrown damage hook into the
    // cached per-match context (the arrow/thrown takeDamage sites).
    updateProjectilesAction(match, 16);
    const bump = match.projectileUpdateCtx!.onDestructiblesMutated;
    expect(bump).toBeTypeOf('function');
    bump!();
    expect(match.destructibleVersion).toBe(6);
  });
});
