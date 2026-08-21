import { NetworkChannel } from '@sector-battle/shared';
import type {
  PowerUpCollectedMessage,
  PowerUpEffectExpiredMessage,
  ChestOpenedMessage,
  ChestRejectedMessage,
  ChestOpeningInterruptedMessage,
  DestructibleDestroyedMessage,
  DestructibleRespawnedMessage,
  BarrelExplodedMessage,
  TrapTriggeredMessage,
  TrapCooldownExpiredMessage,
  WeaponPickupCollectedMessage,
} from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import type { BroadcastMessage } from './EventMapperHandlers.ts';

export function toPowerUpMessage(
  event: GameEvent,
): BroadcastMessage<PowerUpCollectedMessage> | null {
  if (event.type !== 'PowerUpCollected') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'PowerUpCollected',
      playerId: event.playerId,
      powerUpId: event.powerUpId,
      powerUpType: event.powerUpType,
      tick: event.tick,
    },
  };
}

export function toPowerUpExpiredMessage(
  event: GameEvent,
): BroadcastMessage<PowerUpEffectExpiredMessage> | null {
  if (event.type !== 'PowerUpEffectExpired') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'PowerUpEffectExpired',
      playerId: event.playerId,
      effectType: event.effectType,
      tick: event.tick,
    },
  };
}

export function toChestOpenedMessage(
  event: GameEvent,
): BroadcastMessage<ChestOpenedMessage> | null {
  if (event.type !== 'ChestOpened') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'ChestOpened',
      chestId: event.chestId,
      playerId: event.playerId,
      tier: event.tier,
      lootContents: event.lootContents,
      tick: event.tick,
    },
  };
}

export function toChestRejectedMessage(
  event: GameEvent,
): BroadcastMessage<ChestRejectedMessage> | null {
  if (event.type !== 'ChestRejected') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'ChestRejected',
      chestId: event.chestId,
      playerId: event.playerId,
      reason: event.reason,
      tick: event.tick,
    },
  };
}

export function toChestOpeningInterruptedMessage(
  event: GameEvent,
): BroadcastMessage<ChestOpeningInterruptedMessage> | null {
  if (event.type !== 'ChestOpeningInterrupted') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'ChestOpeningInterrupted',
      chestId: event.chestId,
      playerId: event.playerId,
      tick: event.tick,
    },
  };
}

export function toDestructibleDestroyedMessage(
  event: GameEvent,
): BroadcastMessage<DestructibleDestroyedMessage> | null {
  if (event.type !== 'DestructibleDestroyed') return null;

  return {
    channel: NetworkChannel.EXPLOSION,
    message: {
      // Ticket 08 (A7 wire-fix): set the discriminator the client gate requires.
      // Every other multi-variant channel sets `eventType`; the three EXPLOSION-
      // channel producers were the only ones that omitted it, leaving the client
      // `ExplosionEventHandler` unable to switch on the variant. The barrel-
      // exploded omission specifically dead-gated `ExplosionLightRegistry.register`
      // (the deferred explosion light NEVER fired in any build, ever — see the A7
      // findings doc). The other two are set for consistency so the client's
      // existing early-out (`DestructibleRespawned`) + future tightening resolve
      // correctly.
      eventType: 'DestructibleDestroyed',
      id: event.id,
      gridX: event.gridX,
      gridY: event.gridY,
      x: event.position.x,
      y: event.position.y,
      droppedLoot: event.droppedLoot,
      tick: event.tick,
    },
  };
}

export function toDestructibleRespawnedMessage(
  event: GameEvent,
): BroadcastMessage<DestructibleRespawnedMessage> | null {
  if (event.type !== 'DestructibleRespawned') return null;

  return {
    channel: NetworkChannel.EXPLOSION,
    message: {
      // Ticket 08 (A7 wire-fix): set the discriminator the client gate requires
      // (see `toDestructibleDestroyedMessage` above for the full rationale).
      // Without this, the client's `DestructibleRespawned` early-out at
      // `ExplosionEventHandler.ts:32` is dead and respawns fall through to the
      // explosion SFX/camera-shake block.
      eventType: 'DestructibleRespawned',
      id: event.id,
      destructibleType: event.destructibleType,
      tick: event.tick,
    },
  };
}

export function toBarrelExplodedMessage(
  event: GameEvent,
): BroadcastMessage<BarrelExplodedMessage> | null {
  if (event.type !== 'BarrelExploded') return null;

  return {
    channel: NetworkChannel.EXPLOSION,
    message: {
      // Ticket 08 (A7 wire-fix) — LOAD-BEARING: this is the field the client
      // gate at `ExplosionEventHandler.ts:91` keys on
      // (`data.eventType === 'BarrelExploded'`). Omitting it dead-gated the
      // entire deferred-explosion-light path: `register()` was never called,
      // `collect()` returned `[]`, the populator pushed nothing. The light
      // NEVER fired in any build, ever (`git log -S "eventType: 'BarrelExploded'"`
      // was empty across all history pre-this-commit). The registry's 13/13 unit
      // tests passed because they called `register()` directly, bypassing the
      // gate — false confidence. Setting this discriminator is the one-line fix
      // that lights the deferred explosion path. The downstream chain is already
      // correct (verified end-to-end in the A7 findings doc §2.2).
      eventType: 'BarrelExploded',
      id: event.id,
      x: event.position.x,
      y: event.position.y,
      radius: event.radius,
      damage: event.damage,
      tick: event.tick,
    },
  };
}

export function toTrapTriggeredMessage(
  event: GameEvent,
): BroadcastMessage<TrapTriggeredMessage> | null {
  if (event.type !== 'TrapTriggered') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'TrapTriggered',
      trapId: event.trapId,
      trapType: event.trapType,
      targetId: event.targetId,
      tick: event.tick,
    },
  };
}

export function toTrapCooldownExpiredMessage(
  event: GameEvent,
): BroadcastMessage<TrapCooldownExpiredMessage> | null {
  if (event.type !== 'TrapCooldownExpired') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'TrapCooldownExpired',
      trapId: event.trapId,
      tick: event.tick,
    },
  };
}

export function toWeaponPickupCollectedMessage(
  event: GameEvent,
): BroadcastMessage<WeaponPickupCollectedMessage> | null {
  if (event.type !== 'WeaponPickupCollected') return null;

  return {
    channel: NetworkChannel.PICKUP,
    message: {
      eventType: 'WeaponPickupCollected',
      playerId: event.playerId,
      pickupId: event.pickupId,
      weaponType: event.weaponType,
      tier: event.tier,
      tick: event.tick,
    },
  };
}
