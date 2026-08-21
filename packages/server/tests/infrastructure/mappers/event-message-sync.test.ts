/**
 * Drift-catcher for EventMapper handlers (ticket #09, Step 4).
 *
 * For each `to*Message` handler this test:
 *   1. Builds a minimal fixture `GameEvent` matching the handler's input shape.
 *   2. Calls the real handler.
 *   3. Deep-equals the returned `.message` against a hand-built expected object.
 *   4. Compile-time links the expected object to the shared `*Message`
 *      interface via a `satisfies`-typed const, so future field drift between
 *      the inline literal and the shared interface surfaces as a test
 *      compile error (not just a tsc error in the handler file).
 *
 * This file complements `EventMapper.test.ts` (which covers ~13 handlers with
 * partial `toMatchObject` assertions). Here we cover ALL 34 handlers with full
 * deep-equal assertions, including the 17 previously-untested ones flagged in
 * ticket #09 recon.
 */

import {
  AttackType,
  ChestRarity,
  DamageType,
  EntityType,
  NetworkChannel,
  PowerUpType,
  TileType,
  TrapType,
  WeaponTier,
  WeaponType,
} from '@sector-battle/shared';
import type {
  AttackChannelMessage,
  BarrelExplodedMessage,
  ChatMessageMessage,
  ChestOpenedMessage,
  ChestOpeningInterruptedMessage,
  ChestRejectedMessage,
  DamageChannelMessage,
  DestructibleDestroyedMessage,
  DestructibleRespawnedMessage,
  ExplosionChannelMessage,
  MatchEndMessage,
  MatchPhaseChangedMessage,
  MatchStartedMessage,
  PickupChannelMessage,
  PlayerDamagedMessage,
  PowerUpCollectedMessage,
  PowerUpEffectExpiredMessage,
  PlayerEliminatedMessage,
  ProjectileBouncedMessage,
  ProjectileDestroyedMessage,
  SectorSiegeStartedMessage,
  ShieldBlockedMessage,
  SiegeWallDroppedMessage,
  SiegeWallWarningMessage,
  SpectatingTransitionMessage,
  SuddenDeathEscalationMessage,
  SuddenDeathTriggeredMessage,
  TrapCooldownExpiredMessage,
  TrapTriggeredMessage,
  WeaponBrokenMessage,
  WeaponFiredMessage,
  WeaponPickupCollectedMessage,
  WeaponShatteredMessage,
  WeaponThrownMessage,
  WeaponWallHitMessage,
  ZoneDamageMessage,
  ZonePhaseChangedMessage,
  ZoneUpdateChannelMessage,
  ZoneWarningMessage,
} from '@sector-battle/shared';
import type { GameEvent } from '../../../src/domain/events/index.ts';
import {
  toChatMessageMessage,
  toKillFeed,
  toMatchEndMessage,
  toMatchPhaseMessage,
  toMatchStartedMessage,
  toSectorSiegeStartedMessage,
  toSiegeWallDroppedMessage,
  toSiegeWallWarningMessage,
  toSpectatingTransitionMessage,
  toSuddenDeathEscalationMessage,
  toSuddenDeathMessage,
  toZonePhaseChangedMessage,
  toZoneUpdate,
  toZoneWarningMessage,
} from '../../../src/infrastructure/mappers/EventMapperGameHandlers.ts';
import {
  toBarrelExplodedMessage,
  toChestOpenedMessage,
  toChestOpeningInterruptedMessage,
  toChestRejectedMessage,
  toDestructibleDestroyedMessage,
  toDestructibleRespawnedMessage,
  toPowerUpExpiredMessage,
  toPowerUpMessage,
  toTrapCooldownExpiredMessage,
  toTrapTriggeredMessage,
  toWeaponPickupCollectedMessage,
} from '../../../src/infrastructure/mappers/EventMapperEntityHandlers.ts';
import {
  toDamageMessage,
  toProjectileBouncedMessage,
  toProjectileDestroyedMessage,
  toShieldBlockedMessage,
  toWeaponBrokenMessage,
  toWeaponFiredMessage,
  toWeaponShatteredMessage,
  toWeaponThrownMessage,
  toWeaponWallHitMessage,
} from '../../../src/infrastructure/mappers/EventMapperPlayerHandlers.ts';

const TICK = 42;
const TIMESTAMP = 1_700_000_000_000;

/** Cast a partial fixture to GameEvent — tests build only the fields the handler reads. */
function ev(partial: Record<string, unknown> & { type: string }): GameEvent {
  return { tick: TICK, timestamp: TIMESTAMP, ...partial } as GameEvent;
}

/**
 * Pin a handler's emitted message to its shared interface AND record the
 * deep-equal expectation. The `satisfies` clause is the compile-time link:
 * if the handler's inline literal drifts from the shared interface, tsc fails
 * here too. The runtime deep-equal catches field-value drift that TS can't see
 * (e.g. a literal reading the wrong event field).
 */
function expectMsg<M>(handlerOut: { message: M } | null, expected: M): void {
  expect(handlerOut).not.toBeNull();
  expect(handlerOut!.message).toEqual(expected);
}

describe('EventMapper handler → shared message sync (ticket #09)', () => {
  // ---- Player handlers (9) — damage / attack / throw channels ----

  it('toDamageMessage emits PlayerDamagedMessage', () => {
    const event = ev({
      type: 'PlayerDamaged',
      playerId: 'p1',
      damage: 25,
      sourceId: 'src1',
      sourceType: EntityType.PROJECTILE,
      damageType: DamageType.RANGED_HIT,
      knockbackX: 1,
      knockbackY: 2,
      killed: false,
      x: 10,
      y: 20,
    });
    const expected: PlayerDamagedMessage = {
      eventType: 'PlayerDamaged',
      playerId: 'p1',
      damage: 25,
      sourceId: 'src1',
      sourceType: EntityType.PROJECTILE,
      damageType: DamageType.RANGED_HIT,
      knockbackX: 1,
      knockbackY: 2,
      killed: false,
      tick: TICK,
      x: 10,
      y: 20,
    };
    const out = toDamageMessage(event);
    expect(out?.channel).toBe(NetworkChannel.DAMAGE);
    expectMsg<PlayerDamagedMessage>(
      out,
      expected satisfies DamageChannelMessage as PlayerDamagedMessage,
    );
  });

  it('toWeaponFiredMessage emits WeaponFiredMessage', () => {
    const event = ev({
      type: 'WeaponFired',
      playerId: 'p1',
      weaponType: WeaponType.DAGGER,
      attackType: AttackType.ARC,
      direction: 1.5,
      x: 5,
      y: 6,
    });
    const expected: WeaponFiredMessage = {
      playerId: 'p1',
      weaponType: WeaponType.DAGGER,
      attackType: AttackType.ARC,
      direction: 1.5,
      tick: TICK,
      x: 5,
      y: 6,
    };
    const out = toWeaponFiredMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ATTACK);
    expectMsg<WeaponFiredMessage>(
      out,
      expected satisfies AttackChannelMessage as WeaponFiredMessage,
    );
  });

  it('toWeaponBrokenMessage emits WeaponBrokenMessage', () => {
    const event = ev({
      type: 'WeaponBroken',
      playerId: 'p1',
      weaponType: WeaponType.SHORT_SWORD,
      slotIndex: 2,
      x: 7,
      y: 8,
    });
    const expected: WeaponBrokenMessage = {
      eventType: 'WeaponBroken',
      playerId: 'p1',
      weaponType: WeaponType.SHORT_SWORD,
      slotIndex: 2,
      x: 7,
      y: 8,
      tick: TICK,
    };
    const out = toWeaponBrokenMessage(event);
    expect(out?.channel).toBe(NetworkChannel.DAMAGE);
    expectMsg<WeaponBrokenMessage>(
      out,
      expected satisfies DamageChannelMessage as WeaponBrokenMessage,
    );
  });

  it('toWeaponThrownMessage emits WeaponThrownMessage', () => {
    const event = ev({
      type: 'WeaponThrown',
      playerId: 'p1',
      weaponType: WeaponType.THROWING_AXE,
      weaponSlot: 1,
      x: 9,
      y: 10,
    });
    const expected: WeaponThrownMessage = {
      eventType: 'WeaponThrown',
      playerId: 'p1',
      weaponType: WeaponType.THROWING_AXE,
      weaponSlot: 1,
      x: 9,
      y: 10,
      tick: TICK,
    };
    const out = toWeaponThrownMessage(event);
    expect(out?.channel).toBe(NetworkChannel.THROW);
    expectMsg<WeaponThrownMessage>(out, expected);
  });

  it('toWeaponShatteredMessage emits WeaponShatteredMessage', () => {
    const event = ev({
      type: 'WeaponShattered',
      projectileId: 'pr1',
      weaponType: WeaponType.THROWING_AXE,
      x: 11,
      y: 12,
    });
    const expected: WeaponShatteredMessage = {
      eventType: 'WeaponShattered',
      projectileId: 'pr1',
      weaponType: WeaponType.THROWING_AXE,
      x: 11,
      y: 12,
      tick: TICK,
    };
    const out = toWeaponShatteredMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ATTACK);
    expectMsg<WeaponShatteredMessage>(
      out,
      expected satisfies AttackChannelMessage as WeaponShatteredMessage,
    );
  });

  it('toShieldBlockedMessage emits ShieldBlockedMessage', () => {
    const event = ev({
      type: 'ShieldBlocked',
      playerId: 'p1',
      damageType: DamageType.MELEE_HIT,
      sourceId: 'src2',
      x: 13,
      y: 14,
      contactX: 15,
      contactY: 16,
      attackerWeaponType: WeaponType.LONG_SWORD,
    });
    const expected: ShieldBlockedMessage = {
      eventType: 'ShieldBlocked',
      playerId: 'p1',
      damageType: DamageType.MELEE_HIT,
      sourceId: 'src2',
      x: 13,
      y: 14,
      tick: TICK,
      contactX: 15,
      contactY: 16,
      attackerWeaponType: WeaponType.LONG_SWORD,
    };
    const out = toShieldBlockedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.DAMAGE);
    expectMsg<ShieldBlockedMessage>(
      out,
      expected satisfies DamageChannelMessage as ShieldBlockedMessage,
    );
  });

  it('toWeaponWallHitMessage emits WeaponWallHitMessage', () => {
    const event = ev({
      type: 'WeaponWallHit',
      playerId: 'p1',
      weaponType: WeaponType.HAMMER,
      x: 17,
      y: 18,
      gridX: 3,
      gridY: 4,
    });
    const expected: WeaponWallHitMessage = {
      eventType: 'WeaponWallHit',
      playerId: 'p1',
      weaponType: WeaponType.HAMMER,
      x: 17,
      y: 18,
      gridX: 3,
      gridY: 4,
      tick: TICK,
    };
    const out = toWeaponWallHitMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ATTACK);
    expectMsg<WeaponWallHitMessage>(
      out,
      expected satisfies AttackChannelMessage as WeaponWallHitMessage,
    );
  });

  it('toProjectileBouncedMessage emits ProjectileBouncedMessage', () => {
    const event = ev({
      type: 'ProjectileBounced',
      projectileId: 'pr2',
      x: 19,
      y: 20,
      remainingBounces: 2,
    });
    const expected: ProjectileBouncedMessage = {
      projectileId: 'pr2',
      x: 19,
      y: 20,
      remainingBounces: 2,
      tick: TICK,
    };
    const out = toProjectileBouncedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ATTACK);
    expectMsg<ProjectileBouncedMessage>(
      out,
      expected satisfies AttackChannelMessage as ProjectileBouncedMessage,
    );
  });

  it('toProjectileDestroyedMessage emits ProjectileDestroyedMessage (tileType optional)', () => {
    const event = ev({
      type: 'ProjectileDestroyed',
      projectileId: 'pr3',
      x: 21,
      y: 22,
      hitTile: true,
      tileType: TileType.DESTRUCTIBLE_WALL,
      gridX: 5,
      gridY: 6,
    });
    const expected: ProjectileDestroyedMessage = {
      projectileId: 'pr3',
      x: 21,
      y: 22,
      hitTile: true,
      tileType: TileType.DESTRUCTIBLE_WALL,
      gridX: 5,
      gridY: 6,
      tick: TICK,
    };
    const out = toProjectileDestroyedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ATTACK);
    expectMsg<ProjectileDestroyedMessage>(
      out,
      expected satisfies AttackChannelMessage as ProjectileDestroyedMessage,
    );
  });

  it('toProjectileDestroyedMessage emits without tileType when event omits it', () => {
    const event = ev({
      type: 'ProjectileDestroyed',
      projectileId: 'pr4',
      x: 23,
      y: 24,
      hitTile: false,
      gridX: 7,
      gridY: 8,
    });
    const out = toProjectileDestroyedMessage(event);
    expect(out?.message.tileType).toBeUndefined();
    expect(out?.message.hitTile).toBe(false);
  });

  // ---- Entity handlers (11) — pickup / explosion channels ----

  it('toPowerUpMessage emits PowerUpCollectedMessage', () => {
    const event = ev({
      type: 'PowerUpCollected',
      playerId: 'p1',
      powerUpId: 'pu1',
      powerUpType: PowerUpType.HEALTH_PACK,
    });
    const expected: PowerUpCollectedMessage = {
      eventType: 'PowerUpCollected',
      playerId: 'p1',
      powerUpId: 'pu1',
      powerUpType: PowerUpType.HEALTH_PACK,
      tick: TICK,
    };
    const out = toPowerUpMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<PowerUpCollectedMessage>(
      out,
      expected satisfies PickupChannelMessage as PowerUpCollectedMessage,
    );
  });

  it('toPowerUpExpiredMessage emits PowerUpEffectExpiredMessage', () => {
    const event = ev({
      type: 'PowerUpEffectExpired',
      playerId: 'p1',
      effectType: 'speed',
    });
    const expected: PowerUpEffectExpiredMessage = {
      eventType: 'PowerUpEffectExpired',
      playerId: 'p1',
      effectType: 'speed',
      tick: TICK,
    };
    const out = toPowerUpExpiredMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<PowerUpEffectExpiredMessage>(
      out,
      expected satisfies PickupChannelMessage as PowerUpEffectExpiredMessage,
    );
  });

  it('toChestOpenedMessage emits ChestOpenedMessage', () => {
    const loot = { kind: 'weapon', weaponType: WeaponType.SPEAR };
    const event = ev({
      type: 'ChestOpened',
      chestId: 'c1',
      playerId: 'p1',
      tier: ChestRarity.RARE,
      lootContents: loot,
    });
    const expected: ChestOpenedMessage = {
      eventType: 'ChestOpened',
      chestId: 'c1',
      playerId: 'p1',
      tier: ChestRarity.RARE,
      lootContents: loot,
      tick: TICK,
    };
    const out = toChestOpenedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<ChestOpenedMessage>(
      out,
      expected satisfies PickupChannelMessage as ChestOpenedMessage,
    );
  });

  it('toChestRejectedMessage emits ChestRejectedMessage', () => {
    const event = ev({
      type: 'ChestRejected',
      chestId: 'c2',
      playerId: 'p1',
      reason: 'out_of_range',
    });
    const expected: ChestRejectedMessage = {
      eventType: 'ChestRejected',
      chestId: 'c2',
      playerId: 'p1',
      reason: 'out_of_range',
      tick: TICK,
    };
    const out = toChestRejectedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<ChestRejectedMessage>(
      out,
      expected satisfies PickupChannelMessage as ChestRejectedMessage,
    );
  });

  it('toChestOpeningInterruptedMessage emits ChestOpeningInterruptedMessage', () => {
    const event = ev({
      type: 'ChestOpeningInterrupted',
      chestId: 'c3',
      playerId: 'p1',
    });
    const expected: ChestOpeningInterruptedMessage = {
      eventType: 'ChestOpeningInterrupted',
      chestId: 'c3',
      playerId: 'p1',
      tick: TICK,
    };
    const out = toChestOpeningInterruptedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<ChestOpeningInterruptedMessage>(
      out,
      expected satisfies PickupChannelMessage as ChestOpeningInterruptedMessage,
    );
  });

  it('toDestructibleDestroyedMessage emits DestructibleDestroyedMessage', () => {
    const loot = { kind: 'ammo' };
    const event = ev({
      type: 'DestructibleDestroyed',
      id: 'd1',
      position: { x: 192, y: 256 },
      droppedLoot: loot,
      gridX: 3,
      gridY: 4,
    });
    // Ticket 08 (A7 wire-fix): the `eventType` discriminator is now present
    // (was omitted pre-fix — the codified-bug). Every multi-variant channel
    // producer sets this; the three EXPLOSION-channel producers were the only
    // ones missing it. The client's `ExplosionEventHandler` switches on it.
    const expected: DestructibleDestroyedMessage = {
      eventType: 'DestructibleDestroyed',
      id: 'd1',
      gridX: 3,
      gridY: 4,
      x: 192,
      y: 256,
      droppedLoot: loot,
      tick: TICK,
    };
    const out = toDestructibleDestroyedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.EXPLOSION);
    expectMsg<DestructibleDestroyedMessage>(
      out,
      expected satisfies ExplosionChannelMessage as DestructibleDestroyedMessage,
    );
  });

  it('toDestructibleRespawnedMessage emits DestructibleRespawnedMessage (eventType present per A7 wire-fix)', () => {
    const event = ev({
      type: 'DestructibleRespawned',
      id: 'd2',
      destructibleType: 'crate',
      position: { x: 64, y: 64 },
    });
    // Ticket 08 (A7 wire-fix): `eventType` is now present. Without it, the
    // client's early-out at `ExplosionEventHandler.ts:32`
    // (`if (data.eventType === 'DestructibleRespawned') return;`) was dead, so
    // respawns fell through to the explosion SFX + camera-shake block.
    const expected: DestructibleRespawnedMessage = {
      eventType: 'DestructibleRespawned',
      id: 'd2',
      destructibleType: 'crate',
      tick: TICK,
    };
    const out = toDestructibleRespawnedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.EXPLOSION);
    expectMsg<DestructibleRespawnedMessage>(
      out,
      expected satisfies ExplosionChannelMessage as DestructibleRespawnedMessage,
    );
  });

  it('toBarrelExplodedMessage emits BarrelExplodedMessage', () => {
    const event = ev({
      type: 'BarrelExploded',
      id: 'b1',
      position: { x: 128, y: 128 },
      radius: 48,
      damage: 50,
    });
    // Ticket 08 (A7 wire-fix) — LOAD-BEARING: `eventType: 'BarrelExploded'` is
    // now present. Pre-fix this field was OMITTED, which dead-gated the client
    // light path: `ExplosionEventHandler.ts:91` requires
    // `data.eventType === 'BarrelExploded'` and the field was `undefined`, so
    // `ExplosionLightRegistry.register` was NEVER called and the deferred
    // explosion light NEVER fired in any build ever
    // (`git log -S "eventType: 'BarrelExploded'"` was empty across all history
    // pre-this-commit). The registry's unit tests passed because they bypass
    // the gate by calling `register()` directly — false confidence. This test
    // now asserts the field present so the wire format matches the gate.
    const expected: BarrelExplodedMessage = {
      eventType: 'BarrelExploded',
      id: 'b1',
      x: 128,
      y: 128,
      radius: 48,
      damage: 50,
      tick: TICK,
    };
    const out = toBarrelExplodedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.EXPLOSION);
    expectMsg<BarrelExplodedMessage>(
      out,
      expected satisfies ExplosionChannelMessage as BarrelExplodedMessage,
    );
  });

  it('toTrapTriggeredMessage emits TrapTriggeredMessage', () => {
    const event = ev({
      type: 'TrapTriggered',
      trapId: 't1',
      trapType: TrapType.SPIKE,
      targetId: 'p1',
      effects: [],
    });
    const expected: TrapTriggeredMessage = {
      eventType: 'TrapTriggered',
      trapId: 't1',
      trapType: TrapType.SPIKE,
      targetId: 'p1',
      tick: TICK,
    };
    const out = toTrapTriggeredMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<TrapTriggeredMessage>(
      out,
      expected satisfies PickupChannelMessage as TrapTriggeredMessage,
    );
  });

  it('toTrapCooldownExpiredMessage emits TrapCooldownExpiredMessage', () => {
    const event = ev({ type: 'TrapCooldownExpired', trapId: 't1' });
    const expected: TrapCooldownExpiredMessage = {
      eventType: 'TrapCooldownExpired',
      trapId: 't1',
      tick: TICK,
    };
    const out = toTrapCooldownExpiredMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<TrapCooldownExpiredMessage>(
      out,
      expected satisfies PickupChannelMessage as TrapCooldownExpiredMessage,
    );
  });

  it('toWeaponPickupCollectedMessage emits WeaponPickupCollectedMessage (tier is WeaponTier)', () => {
    const event = ev({
      type: 'WeaponPickupCollected',
      playerId: 'p1',
      pickupId: 'wp1',
      weaponType: WeaponType.CROSSBOW,
      tier: WeaponTier.RARE,
    });
    const expected: WeaponPickupCollectedMessage = {
      eventType: 'WeaponPickupCollected',
      playerId: 'p1',
      pickupId: 'wp1',
      weaponType: WeaponType.CROSSBOW,
      tier: WeaponTier.RARE,
      tick: TICK,
    };
    const out = toWeaponPickupCollectedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.PICKUP);
    expectMsg<WeaponPickupCollectedMessage>(
      out,
      expected satisfies PickupChannelMessage as WeaponPickupCollectedMessage,
    );
  });

  // ---- Game handlers (14) — kill_feed / zone_update / match_* / chat ----

  it('toKillFeed emits PlayerEliminatedMessage (weapon is WeaponType)', () => {
    const event = ev({
      type: 'PlayerEliminated',
      playerId: 'p1',
      playerName: 'Alice',
      killedBy: 'p2',
      killerName: 'Bob',
      placement: 3,
      weapon: WeaponType.DAGGER,
      x: 100,
      y: 200,
      cause: 'melee',
    });
    const expected: PlayerEliminatedMessage = {
      playerId: 'p1',
      playerName: 'Alice',
      killedBy: 'p2',
      killerName: 'Bob',
      placement: 3,
      weapon: WeaponType.DAGGER,
      cause: 'melee',
      tick: TICK,
      x: 100,
      y: 200,
      sessionId: 'p1',
    };
    const out = toKillFeed(event);
    expect(out?.channel).toBe(NetworkChannel.KILL_FEED);
    expectMsg<PlayerEliminatedMessage>(out, expected);
  });

  it('toZoneUpdate emits ZoneDamageMessage', () => {
    const event = ev({
      type: 'ZoneDamage',
      playersDamaged: [
        { playerId: 'p1', damage: 5 },
        { playerId: 'p2', damage: 7 },
      ],
    });
    const expected: ZoneDamageMessage = {
      eventType: 'ZoneDamage',
      playersDamaged: [
        { playerId: 'p1', damage: 5 },
        { playerId: 'p2', damage: 7 },
      ],
      tick: TICK,
    };
    const out = toZoneUpdate(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<ZoneDamageMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as ZoneDamageMessage,
    );
  });

  it('toMatchPhaseMessage emits MatchPhaseChangedMessage', () => {
    const event = ev({ type: 'MatchPhaseChanged', from: 0, to: 1 });
    const expected: MatchPhaseChangedMessage = { from: 0, to: 1, tick: TICK };
    const out = toMatchPhaseMessage(event);
    expect(out?.channel).toBe(NetworkChannel.MATCH_START);
    expectMsg<MatchPhaseChangedMessage>(out, expected);
  });

  it('toMatchEndMessage emits MatchEndMessage', () => {
    const placements = [
      {
        playerId: 'p1',
        placement: 1,
        kills: 3,
        damageDealt: 200,
        damageTaken: 50,
        itemsCollected: 4,
        survivalTimeMs: 60000,
        weaponsUsed: 2,
      },
    ];
    const event = ev({ type: 'MatchEnded', winnerId: 'p1', placements });
    const expected: MatchEndMessage = {
      type: 'match_end',
      winnerId: 'p1',
      placements,
      stats: [],
    };
    const out = toMatchEndMessage(event);
    expect(out?.channel).toBe(NetworkChannel.MATCH_END);
    expectMsg<MatchEndMessage>(out, expected);
  });

  it('toMatchStartedMessage emits MatchStartedMessage', () => {
    const event = ev({ type: 'MatchStarted', mapSeed: 12345, playerCount: 4 });
    const expected: MatchStartedMessage = {
      mapSeed: 12345,
      playerCount: 4,
      tick: TICK,
    };
    const out = toMatchStartedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.MATCH_START);
    expectMsg<MatchStartedMessage>(out, expected);
  });

  it('toSpectatingTransitionMessage emits SpectatingTransitionMessage (killerId null → "")', () => {
    const event = ev({
      type: 'SpectatingTransition',
      playerId: 'p1',
      killerId: null,
      cameraZoomFactor: 1.5,
      cameraZoomDuration: 2000,
    });
    const expected: SpectatingTransitionMessage = {
      eventType: 'SpectatingTransition',
      playerId: 'p1',
      killerId: '',
      cameraZoomFactor: 1.5,
      cameraZoomDuration: 2000,
      tick: TICK,
    };
    const out = toSpectatingTransitionMessage(event);
    expect(out?.channel).toBe(NetworkChannel.MATCH_START);
    expectMsg<SpectatingTransitionMessage>(out, expected);
  });

  it('toSuddenDeathMessage emits SuddenDeathTriggeredMessage', () => {
    const event = ev({
      type: 'SuddenDeathTriggered',
      timestamp: TIMESTAMP,
      remainingPlayers: ['p1', 'p2'],
    });
    const expected: SuddenDeathTriggeredMessage = {
      eventType: 'SuddenDeathTriggered',
      remainingPlayers: ['p1', 'p2'],
      tick: TICK,
    };
    const out = toSuddenDeathMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<SuddenDeathTriggeredMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as SuddenDeathTriggeredMessage,
    );
  });

  it('toZonePhaseChangedMessage emits ZonePhaseChangedMessage', () => {
    const event = ev({
      type: 'ZonePhaseChanged',
      previousPhase: 1,
      newPhase: 2,
      currentRadius: 100,
      targetRadius: 80,
    });
    const expected: ZonePhaseChangedMessage = {
      eventType: 'ZonePhaseChanged',
      previousPhase: 1,
      newPhase: 2,
      currentRadius: 100,
      targetRadius: 80,
      tick: TICK,
    };
    const out = toZonePhaseChangedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<ZonePhaseChangedMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as ZonePhaseChangedMessage,
    );
  });

  it('toSectorSiegeStartedMessage emits SectorSiegeStartedMessage', () => {
    const event = ev({ type: 'SectorSiegeStarted', sectorRow: 1, sectorCol: 2 });
    const expected: SectorSiegeStartedMessage = {
      eventType: 'SectorSiegeStarted',
      sectorRow: 1,
      sectorCol: 2,
      tick: TICK,
    };
    const out = toSectorSiegeStartedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<SectorSiegeStartedMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as SectorSiegeStartedMessage,
    );
  });

  it('toZoneWarningMessage emits ZoneWarningMessage', () => {
    const event = ev({
      type: 'ZoneWarning',
      nextPhaseIndex: 3,
      nextCenterX: 50,
      nextCenterY: 60,
      nextRadius: 40,
      transitionStartsInMs: 5000,
    });
    const expected: ZoneWarningMessage = {
      eventType: 'ZoneWarning',
      nextPhaseIndex: 3,
      nextCenterX: 50,
      nextCenterY: 60,
      nextRadius: 40,
      transitionStartsInMs: 5000,
      tick: TICK,
    };
    const out = toZoneWarningMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<ZoneWarningMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as ZoneWarningMessage,
    );
  });

  it('toSiegeWallDroppedMessage emits SiegeWallDroppedMessage (defaults tileIndex=0, audible=false)', () => {
    const event = ev({
      type: 'SiegeWallDropped',
      gridX: 5,
      gridY: 6,
      sectorRow: 1,
      sectorCol: 2,
      ring: 3,
    });
    const expected: SiegeWallDroppedMessage = {
      eventType: 'SiegeWallDropped',
      gridX: 5,
      gridY: 6,
      sectorRow: 1,
      sectorCol: 2,
      ring: 3,
      tileIndex: 0,
      audible: false,
      tick: TICK,
    };
    const out = toSiegeWallDroppedMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<SiegeWallDroppedMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as SiegeWallDroppedMessage,
    );
  });

  it('toSiegeWallWarningMessage emits SiegeWallWarningMessage', () => {
    const event = ev({ type: 'SiegeWallWarning', gridX: 7, gridY: 8, solidifyAt: 3000 });
    const expected: SiegeWallWarningMessage = {
      eventType: 'SiegeWallWarning',
      gridX: 7,
      gridY: 8,
      solidifyAt: 3000,
      tick: TICK,
    };
    const out = toSiegeWallWarningMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<SiegeWallWarningMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as SiegeWallWarningMessage,
    );
  });

  it('toSuddenDeathEscalationMessage emits SuddenDeathEscalationMessage', () => {
    const event = ev({
      type: 'SuddenDeathEscalation',
      level: 2,
      damagePerTick: 3,
      shrinkRateMultiplier: 1.5,
    });
    const expected: SuddenDeathEscalationMessage = {
      eventType: 'SuddenDeathEscalation',
      level: 2,
      damagePerTick: 3,
      shrinkRateMultiplier: 1.5,
      tick: TICK,
    };
    const out = toSuddenDeathEscalationMessage(event);
    expect(out?.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expectMsg<SuddenDeathEscalationMessage>(
      out,
      expected satisfies ZoneUpdateChannelMessage as SuddenDeathEscalationMessage,
    );
  });

  it('toChatMessageMessage emits ChatMessageMessage', () => {
    const event = ev({ type: 'ChatMessage', senderId: 'SYSTEM', text: 'hi' });
    const expected: ChatMessageMessage = {
      eventType: 'ChatMessage',
      senderId: 'SYSTEM',
      text: 'hi',
      tick: TICK,
    };
    const out = toChatMessageMessage(event);
    expect(out?.channel).toBe(NetworkChannel.CHAT);
    expectMsg<ChatMessageMessage>(out, expected);
  });

  // ---- Null-return guard spot-checks (one per handler family) ----

  it('player handlers return null on event-type mismatch', () => {
    const wrong = ev({ type: 'PlayerDamaged' });
    expect(toWeaponFiredMessage(wrong as GameEvent)).toBeNull();
  });

  it('entity handlers return null on event-type mismatch', () => {
    const wrong = ev({ type: 'PowerUpCollected' });
    expect(toChestOpenedMessage(wrong as GameEvent)).toBeNull();
  });

  it('game handlers return null on event-type mismatch', () => {
    const wrong = ev({ type: 'ZoneDamage' });
    expect(toKillFeed(wrong as GameEvent)).toBeNull();
  });
});
