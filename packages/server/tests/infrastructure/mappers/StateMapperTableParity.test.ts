import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Schema } from '@colyseus/schema';
import {
  StateMapper,
  type MatchMeta,
  type MatchState,
  type AnimWireFields,
} from '../../../src/infrastructure/mappers/StateMapper.ts';
import { StateMapperSync } from '../../../src/infrastructure/mappers/StateMapperSync.ts';
import {
  PlayerSchema,
  ProjectileSchema,
  PowerUpSchema,
  TrapSchema,
  ChestSchema,
  DestructibleSchema,
  ExitSchema,
  ExplosionSchema,
  WeaponPickupSchema,
  GameStateSchema,
} from '../../../src/infrastructure/schemas/index.ts';
import {
  Player,
  Projectile,
  PowerUp,
  Trap,
  Chest,
  Destructible,
  Exit,
  Explosion,
  WeaponPickup,
  WeaponEntity,
} from '../../../src/domain/entities/index.ts';
import { Position, GridCoord } from '../../../src/domain/value-objects/index.ts';
import {
  NETWORK,
  WeaponTier,
  WeaponType,
  TrapType,
  ChestRarity,
  MatchPhase,
} from '@sector-battle/shared';
import type { ZoneState } from '@sector-battle/shared';

/**
 * Snapshot-parity gate for the table-driven entity sync (ticket #23).
 *
 * The server sim is non-deterministic (unseeded Math.random), so a committed
 * baseline fixture cannot pin the schema output. Instead this harness uses the
 * replica pattern: a VERBATIM transcription of the pre-refactor imperative
 * `StateMapper.mapDelta` cascade (the 10-call `StateMapperSync.syncMap` list
 * with inline factory/projector closures) is kept below as `mapDeltaReplica`.
 * Both the replica and the live mapper run against the SAME in-memory
 * `MatchState` at three checkpoints (fresh sync / mutations / removals) and
 * the resulting `GameStateSchema` trees must be equal field-for-field
 * (`toJSON` deep-equal) and wire-identical (Colyseus full-encode change-set
 * string equality). The shared per-type projectors (`playerToSchema` etc.) are
 * unchanged by the refactor; what this gate pins is the cascade itself — row
 * order, keying, create/update/delete semantics, and the per-call animation
 * resolver threading.
 *
 * Fidelity protocol: run this file on the PRE-change tree first — green means
 * the replica transcription is faithful (old path ≡ old path). After the
 * refactor, green means new table path ≡ old cascade.
 */

const DEFAULT_PLAYER_CONFIG = {
  baseHealth: 100,
  maxHealth: 100,
  baseSpeed: 200,
  dashSpeedMultiplier: 1.3,
  dashDuration: 10,
  dashCooldown: 120,
  inventorySize: 4,
  hitboxWidth: 28,
  hitboxHeight: 28,
};

const TEST_META: MatchMeta = {
  matchId: 'parity-match',
  mapSeed: 4242,
  mapWidth: 50,
  mapHeight: 50,
};

const TEST_ZONE: ZoneState = {
  currentPhase: 1,
  centerX: 25,
  centerY: 25,
  targetCenterX: 24,
  targetCenterY: 26,
  isTransitioningCenter: true,
  currentRadius: 45,
  targetRadius: 38,
  shrinkSpeed: 0.5,
  damagePerTick: 2,
  nextShrinkTick: 100,
  phaseStartTime: 10,
  phaseEndTime: 600,
};

/** All 34 PlayerSchema @type fields (32 scalars + weapons + items arrays). */
const PLAYER_SCHEMA_FIELDS = [
  'activeSlot',
  'animPhase',
  'animPhaseStartTick',
  'barrierActive',
  'barrierExpiryTick',
  'color',
  'comboIndex',
  'connected',
  'dashCooldown',
  'direction',
  'facingAngle',
  'freshSpawnExpiryTick',
  'health',
  'id',
  'isBlocking',
  'isBot',
  'isWindupActive',
  'items',
  'kills',
  'lastDamageTick',
  'lastProcessedInput',
  'maxHealth',
  'name',
  'speed',
  'speedBoostActive',
  'speedBoostExpiryTick',
  'status',
  'velocityX',
  'velocityY',
  'weapons',
  'windupAttackType',
  'windupWeaponType',
  'x',
  'y',
].sort();

/** All 24 top-level GameStateSchema @type fields (scalars + 11 maps + zone). */
const GAME_STATE_SCHEMA_FIELDS = [
  'chests',
  'destructibles',
  'eliminationRecords',
  'exits',
  'explosions',
  'lastProcessedInput',
  'mapHeight',
  'mapSeed',
  'mapSiegeProgress',
  'mapWidth',
  'matchId',
  'matchTimer',
  'phase',
  'players',
  'playersAlive',
  'powerUps',
  'projectiles',
  'siegedSectors',
  'tick',
  'timestamp',
  'traps',
  'weaponPickups',
  'zone',
].sort();

type AnimResolver = (playerId: string) => AnimWireFields | undefined;

/**
 * VERBATIM replica of `StateMapper.mapDelta` as of the pre-#23 imperative
 * cascade (StateMapper.ts mapDelta, 10 syncMap calls + header + tail).
 * Transcribed field-for-field; only the private `ZERO_ANIM_WIRE_FIELDS`
 * constant is inlined as its literal value. DO NOT "modernize" — it is the
 * frozen pre-refactor oracle.
 */
function mapDeltaReplica(
  state: MatchState,
  schema: GameStateSchema,
  meta: MatchMeta,
  getAnimState: AnimResolver,
): void {
  schema.matchId = meta.matchId;
  schema.mapSeed = meta.mapSeed;
  schema.mapWidth = meta.mapWidth;
  schema.mapHeight = meta.mapHeight;
  schema.tick = state.tick;
  schema.phase = state.phase;
  schema.timestamp = Date.now();
  schema.matchTimerSeconds = Math.floor((state.tick * NETWORK.TICK_INTERVAL) / 1000);
  schema.lastProcessedInput = state.lastProcessedInput;

  let alive = 0;
  for (const player of state.players.values()) {
    if (player.isActive) alive++;
  }
  schema.playersAlive = alive;

  StateMapperSync.syncMap(
    state.players,
    schema.players,
    () => new PlayerSchema(),
    (player, playerSchema) => {
      const animState =
        getAnimState(player.id) ?? Object.freeze({ phase: 0, phaseStartTick: 0, comboIndex: 0 });
      StateMapper.playerToSchema(player, playerSchema, animState);
    },
  );
  StateMapperSync.syncMap(
    state.projectiles,
    schema.projectiles,
    () => new ProjectileSchema(),
    StateMapper.projectileToSchema,
  );
  StateMapperSync.syncMap(
    state.powerUps,
    schema.powerUps,
    () => new PowerUpSchema(),
    StateMapper.powerUpToSchema,
  );
  StateMapperSync.syncMap(
    state.traps,
    schema.traps,
    () => new TrapSchema(),
    StateMapper.trapToSchema,
  );
  StateMapperSync.syncMap(
    state.chests,
    schema.chests,
    () => new ChestSchema(),
    StateMapper.chestToSchema,
  );
  StateMapperSync.syncMap(
    state.destructibles,
    schema.destructibles,
    () => new DestructibleSchema(),
    StateMapper.destructibleToSchema,
  );
  StateMapperSync.syncMap(
    state.exits,
    schema.exits,
    () => new ExitSchema(),
    StateMapper.exitToSchema,
  );
  StateMapperSync.syncMap(
    state.explosions,
    schema.explosions,
    () => new ExplosionSchema(),
    StateMapper.explosionToSchema,
  );
  StateMapperSync.syncMap(
    state.weaponPickups,
    schema.weaponPickups,
    () => new WeaponPickupSchema(),
    StateMapper.weaponPickupToSchema,
  );
  StateMapperSync.syncEliminations(state.eliminations, schema.eliminationRecords);
  StateMapperSync.syncSiegeSectors(state.siegedSectors, schema.siegedSectors);
  StateMapperSync.syncMapSiegeProgress(state.mapSiegeProgress, schema.mapSiegeProgress);
  StateMapper.zoneToSchema(state.zone, schema.zone);
}

function makePlayer(id: string, name: string, x: number, y: number): Player {
  return new Player(id, name, new Position(x, y), DEFAULT_PLAYER_CONFIG);
}

/** Rich match state covering every synced entity map with distinct values. */
function buildRichState(): { state: MatchState; resolver: AnimResolver } {
  const p1 = makePlayer('p1', 'Alice', 100, 200);
  p1.spawnTick = -9999;
  p1.takeDamage(30, 55);
  p1.kills = 2;
  p1.items.push('item-key');
  p1.lastProcessedInput = 77;
  p1.statusEffects.barrierActive = true;
  p1.statusEffects.barrierExpiryTick = 900;

  const p2 = makePlayer('p2', 'DeadBob', 50, 60);
  p2.spawnTick = -9999;
  p2.takeDamage(100, 5);
  p2.die();

  const p3 = makePlayer('p3', 'BotCara', 10, 20);
  p3.isBot = true;
  p3.addWeapon(new WeaponEntity('w-sword', WeaponType.SHORT_SWORD, WeaponTier.RARE, 5, 9, 12));
  p3.addWeapon(new WeaponEntity('w-axe', WeaponType.LARGE_AXE, WeaponTier.LEGENDARY, 3, 3, 20));
  p3.inventory.activeSlot = 1;

  const pr1 = new Projectile(
    'pr1',
    'p1',
    new Position(10, 10),
    100,
    -40,
    25,
    3,
    WeaponType.THROWING_AXE,
    20,
    800,
    'thrown',
    true,
    'p1',
    999,
    0,
    15,
    WeaponTier.RARE,
  );
  const pr2 = new Projectile(
    'pr2',
    'p3',
    new Position(30, 40),
    -60,
    0,
    12,
    1,
    WeaponType.SHORT_BOW,
    4,
    300,
    'arrow',
  );

  const pu1 = PowerUp.create('pu1', 'health_pack', new Position(64, 64), 0);
  const pu2 = PowerUp.create('pu2', 'barrier', new Position(96, 128), 0);

  const t1 = Trap.create('t1', TrapType.SPIKE, new Position(96, 96));
  t1.isRevealed = true;
  const t2 = Trap.create('t2', TrapType.FIRE, new Position(128, 96));

  const c1 = Chest.create('c1', ChestRarity.RARE, new Position(128, 128));
  const c2 = Chest.create('c2', ChestRarity.EPIC, new Position(160, 128));
  c2.state = 'opening';
  c2.openingPlayerId = 'p1';
  c2.openingProgress = 0.5;

  const d1 = Destructible.create('d1', 'crate', new Position(160, 160));
  const d2 = Destructible.create('d2', 'barrel', new Position(192, 160));

  const e1 = new Exit('e1', new Position(192, 192), new GridCoord(6, 6), 0);
  const e2 = new Exit('e2', new Position(224, 192), new GridCoord(6, 7), 1);

  const x1 = new Explosion('x1', 'p1', new Position(32, 32), 20, 1);
  const x2 = new Explosion('x2', 'p3', new Position(64, 32), 45, 2);

  const wp1 = WeaponPickup.create(
    'wp1',
    new WeaponEntity('wp-sword', WeaponType.LONG_SWORD, WeaponTier.LEGENDARY, 7, 7, 14),
    new Position(200, 40),
    12,
    'crate_legendary',
    45,
    true,
    false,
  );
  const wp2 = WeaponPickup.create(
    'wp2',
    new WeaponEntity('wp-spear', WeaponType.SPEAR, WeaponTier.COMMON, 2, 5, 8),
    new Position(240, 40),
    14,
  );

  const state: MatchState = {
    players: new Map([
      ['p1', p1],
      ['p2', p2],
      ['p3', p3],
    ]),
    projectiles: new Map([
      ['pr1', pr1],
      ['pr2', pr2],
    ]),
    powerUps: new Map([
      ['pu1', pu1],
      ['pu2', pu2],
    ]),
    traps: new Map([
      ['t1', t1],
      ['t2', t2],
    ]),
    chests: new Map([
      ['c1', c1],
      ['c2', c2],
    ]),
    destructibles: new Map([
      ['d1', d1],
      ['d2', d2],
    ]),
    exits: new Map([
      ['e1', e1],
      ['e2', e2],
    ]),
    explosions: new Map([
      ['x1', x1],
      ['x2', x2],
    ]),
    weaponPickups: new Map([
      ['wp1', wp1],
      ['wp2', wp2],
    ]),
    // ticket 08 — static-row sync-gate counters (production mirrors them from
    // GameMatch; the checkpoints below bump them exactly where the audited
    // mutation sites would — see StaticRowGate's audit list).
    destructibleVersion: 1,
    exitVersion: 1,
    tick: 120,
    phase: MatchPhase.ACTIVE,
    zone: {
      ...TEST_ZONE,
      nextPhasePreview: { centerX: 20, centerY: 21, radius: 22 },
    },
    lastProcessedInput: 77,
    eliminations: [
      {
        order: 1,
        playerId: 'p2',
        killerId: 'p1',
        weaponType: 7,
        timestamp: 123,
        position: { x: 1, y: 2 },
      },
      {
        order: 2,
        playerId: 'p9',
        killerId: null,
        weaponType: null,
        timestamp: 456,
        position: { x: 3, y: 4 },
      },
    ],
    siegedSectors: [
      { row: 0, col: 1 },
      { row: 2, col: 3 },
    ],
    mapSiegeProgress: { northOffset: 11, eastOffset: 22, southOffset: 33, westOffset: 44 },
  };

  // p1 exercises a live anim projection, p3 one with comboIndex > 0xff (the
  // uint8 mask path), p2 the undefined → zero-state fallback.
  const resolver: AnimResolver = (playerId) => {
    if (playerId === 'p1') return { phase: 4, phaseStartTick: 120, comboIndex: 300 };
    if (playerId === 'p3') return { phase: 2, phaseStartTick: 33, comboIndex: 5 };
    return undefined;
  };

  return { state, resolver };
}

/** Apply checkpoint-B mutations across every entity map. */
function mutateState(state: MatchState): void {
  state.tick = 999;
  state.phase = MatchPhase.ACTIVE;
  state.lastProcessedInput = 200;

  const p1 = state.players.get('p1')!;
  p1.movement.position = new Position(500, 600);
  p1.kills = 3;

  const p4 = makePlayer('p4', 'LateJoiner', 400, 100);
  p4.spawnTick = -9999;
  p4.takeDamage(10, 60);
  state.players.set('p4', p4);

  const pr2 = state.projectiles.get('pr2')!;
  pr2.damage = 44;
  pr2.position = new Position(70, 80);

  const pu2 = state.powerUps.get('pu2')!;
  pu2.isActive = false;
  state.powerUps.set('pu3', PowerUp.create('pu3', 'speed_boost', new Position(32, 160), 999));

  const t2 = state.traps.get('t2')!;
  t2.isRevealed = true;
  t2.cooldownRemaining = 7;
  state.traps.set('t3', Trap.create('t3', TrapType.TELEPORT, new Position(160, 96)));

  const c2 = state.chests.get('c2')!;
  c2.state = 'open';
  c2.openingProgress = 1;
  c2.openingPlayerId = null;
  state.chests.set('c3', Chest.create('c3', ChestRarity.COMMON, new Position(192, 128)));

  const d2 = state.destructibles.get('d2')!;
  d2.hp = d2.hp > 0 ? d2.hp - 1 : 0;
  state.destructibles.set('d3', Destructible.create('d3', 'iron', new Position(224, 160)));
  state.destructibleVersion++; // ticket 08 — hp mutation + membership add

  const e1 = state.exits.get('e1')!;
  e1.active = true;
  state.exitVersion++; // ticket 08 — field mutation

  state.explosions.set('x3', new Explosion('x3', 'p4', new Position(96, 96), 33, 1));

  state.weaponPickups.get('wp1')!.deactivate();

  state.eliminations = [
    ...state.eliminations,
    {
      order: 3,
      playerId: 'p4',
      killerId: 'p3',
      weaponType: 8,
      timestamp: 789,
      position: { x: 5, y: 6 },
    },
  ];

  state.siegedSectors = [{ row: 4, col: 5 }];
  state.mapSiegeProgress = { northOffset: 55, eastOffset: 66, southOffset: 77, westOffset: 88 };
  state.zone = { ...TEST_ZONE, nextPhasePreview: null };
}

/** Apply checkpoint-C removals across every entity map. */
function removeFromState(state: MatchState): void {
  state.tick = 1500;
  state.players.delete('p4');
  state.projectiles.clear();
  state.powerUps.delete('pu1');
  state.traps.delete('t1');
  state.chests.delete('c2');
  state.destructibles.delete('d1');
  state.exits.delete('e2');
  state.destructibleVersion++; // ticket 08 — membership removal
  state.exitVersion++; // ticket 08 — membership removal
  state.explosions.delete('x1');
  state.weaponPickups.clear();
  state.siegedSectors = [];
}

describe('StateMapper table-driven sync parity (ticket #23)', () => {
  beforeEach(() => {
    // mapDelta stamps Date.now() — pin it so the diff is deterministic.
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces field-for-field identical schema output vs the pre-refactor cascade replica', () => {
    const { state, resolver } = buildRichState();
    const schemaOld = new GameStateSchema();
    const schemaNew = new GameStateSchema();

    const syncAndDiff = (label: string) => {
      mapDeltaReplica(state, schemaOld, TEST_META, resolver);
      StateMapper.mapDelta(state, schemaNew, TEST_META, resolver);
      expect(
        Object.keys(schemaNew.toJSON()).sort(),
        `top-level schema field coverage at ${label}`,
      ).toEqual(GAME_STATE_SCHEMA_FIELDS);
      expect(schemaNew.toJSON(), `toJSON deep parity at ${label}`).toEqual(schemaOld.toJSON());
    };

    // Checkpoint A — fresh full sync of every entity type.
    syncAndDiff('checkpoint A (fresh)');

    // Checkpoint B — mutations + additions across every map (delta path).
    mutateState(state);
    syncAndDiff('checkpoint B (mutations)');

    // Checkpoint C — removals across every map (delete path).
    removeFromState(state);
    syncAndDiff('checkpoint C (removals)');

    // Wire-level parity: identical full-encode change sets (the Colyseus byte
    // stream content, including per-instance refIds / encoding order).
    const wireOld = new GameStateSchema();
    const wireNew = new GameStateSchema();
    mapDeltaReplica(state, wireOld, TEST_META, resolver);
    StateMapper.mapDelta(state, wireNew, TEST_META, resolver);
    expect(Schema.debugChanges(wireNew, true)).toBe(Schema.debugChanges(wireOld, true));
  });

  it('parity diff surface covers all 34 PlayerSchema fields', () => {
    const { state, resolver } = buildRichState();
    const schema = new GameStateSchema();
    StateMapper.mapDelta(state, schema, TEST_META, resolver);

    for (const [id, playerSchema] of schema.players) {
      expect(
        Object.keys(playerSchema.toJSON()).sort(),
        `player ${id} toJSON must expose every PlayerSchema field`,
      ).toEqual(PLAYER_SCHEMA_FIELDS);
    }
  });
});
