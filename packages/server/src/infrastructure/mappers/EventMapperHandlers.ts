import type { GameEvent } from '../../domain/events/index.ts';
import {
  toKillFeed,
  toZoneUpdate,
  toMatchPhaseMessage,
  toMatchEndMessage,
  toMatchStartedMessage,
  toSuddenDeathMessage,
  toZonePhaseChangedMessage,
  toSectorSiegeStartedMessage,
  toZoneWarningMessage,
  toSiegeWallDroppedMessage,
  toSiegeWallWarningMessage,
  toSuddenDeathEscalationMessage,
  toChatMessageMessage,
} from './EventMapperGameHandlers.ts';
import {
  toDamageMessage,
  toWeaponFiredMessage,
  toWeaponBrokenMessage,
  toWeaponThrownMessage,
  toWeaponShatteredMessage,
  toShieldBlockedMessage,
  toProjectileBouncedMessage,
  toProjectileDestroyedMessage,
  toWeaponWallHitMessage,
} from './EventMapperPlayerHandlers.ts';
import {
  toPowerUpMessage,
  toPowerUpExpiredMessage,
  toChestOpenedMessage,
  toChestRejectedMessage,
  toChestOpeningInterruptedMessage,
  toDestructibleDestroyedMessage,
  toDestructibleRespawnedMessage,
  toBarrelExplodedMessage,
  toTrapTriggeredMessage,
  toTrapCooldownExpiredMessage,
  toWeaponPickupCollectedMessage,
} from './EventMapperEntityHandlers.ts';

/**
 * A single outbound broadcast message: the channel name plus the payload.
 *
 * Generic over the payload type `T` so per-handler return annotations can pin
 * the inline object literal to its shared `*ChannelMessage` interface at
 * compile time (ticket #09 — server emission link). The unparametrized
 * `BroadcastMessage` keeps `message: unknown` so the dispatcher stays
 * channel-agnostic; per-handler annotations use `BroadcastMessage<T>` to
 * surface drift between the inline literal and the shared interface.
 */
export interface BroadcastMessage<T = unknown> {
  channel: string;
  message: T;
}

/** Every discriminator literal of the `GameEvent` union. */
type GameEventType = GameEvent['type'];

/**
 * Handler signature for a single event type `K`: `Extract` narrows the
 * parameter to the exact union member carrying that discriminant — the same
 * narrowing the former switch in `mapEvent` performed per-arm.
 */
type TypedEventHandler<K extends GameEventType> = (
  event: Extract<GameEvent, { type: K }>,
) => BroadcastMessage | null;

/**
 * Broadcast dispatch table (ticket #22): replaces `mapEvent`'s former 34-arm
 * switch. Built once at module load; dispatch is an O(1) property lookup.
 *
 * Exhaustiveness is compile-enforced: the mapped type requires an entry for
 * EVERY `GameEventType`, so adding a new event to the `GameEvent` union
 * without a table entry is a compile error (TS2739 "missing property") — a
 * new event type cannot silently fall through to a no-op. Deliberately NOT
 * `Partial<Record<…>>`, which would re-open the gap the old `default` arm hid.
 *
 * `SpectatingTransition` intentionally holds a no-op: its message is a
 * targeted (per-client) send via `toSpectatingTransitionMessage` in
 * `GameRoomMessages.ts`, not a broadcast — the old switch returned null for it.
 */
const EVENT_HANDLERS: { [K in GameEventType]: TypedEventHandler<K> } = {
  PlayerEliminated: toKillFeed,
  PlayerDamaged: toDamageMessage,
  ZoneDamage: toZoneUpdate,
  MatchPhaseChanged: toMatchPhaseMessage,
  PowerUpCollected: toPowerUpMessage,
  ChestOpened: toChestOpenedMessage,
  DestructibleDestroyed: toDestructibleDestroyedMessage,
  WeaponFired: toWeaponFiredMessage,
  MatchEnded: toMatchEndMessage,
  PowerUpEffectExpired: toPowerUpExpiredMessage,
  ChestRejected: toChestRejectedMessage,
  TrapTriggered: toTrapTriggeredMessage,
  SuddenDeathTriggered: toSuddenDeathMessage,
  BarrelExploded: toBarrelExplodedMessage,
  DestructibleRespawned: toDestructibleRespawnedMessage,
  ChestOpeningInterrupted: toChestOpeningInterruptedMessage,
  ProjectileBounced: toProjectileBouncedMessage,
  TrapCooldownExpired: toTrapCooldownExpiredMessage,
  ZonePhaseChanged: toZonePhaseChangedMessage,
  WeaponPickupCollected: toWeaponPickupCollectedMessage,
  ProjectileDestroyed: toProjectileDestroyedMessage,
  MatchStarted: toMatchStartedMessage,
  SectorSiegeStarted: toSectorSiegeStartedMessage,
  WeaponBroken: toWeaponBrokenMessage,
  WeaponThrown: toWeaponThrownMessage,
  WeaponShattered: toWeaponShatteredMessage,
  ShieldBlocked: toShieldBlockedMessage,
  WeaponWallHit: toWeaponWallHitMessage,
  ZoneWarning: toZoneWarningMessage,
  SpectatingTransition: () => null,
  SiegeWallDropped: toSiegeWallDroppedMessage,
  SiegeWallWarning: toSiegeWallWarningMessage,
  ChatMessage: toChatMessageMessage,
  SuddenDeathEscalation: toSuddenDeathEscalationMessage,
};

export class EventMapper {
  static broadcastEvents(events: GameEvent[]): BroadcastMessage[] {
    const messages: BroadcastMessage[] = [];
    for (const event of events) {
      const msg = EventMapper.mapEvent(event);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  private static mapEvent(event: GameEvent): BroadcastMessage | null {
    // Widening assertion to the channel-agnostic dispatch signature: per-key
    // entries are contravariantly narrower than `(event: GameEvent) => …`,
    // and the dispatcher receives the full union. The table itself already
    // guarantees key↔handler agreement at compile time, so this is a pure
    // widening; `| undefined` covers lookups by runtime-foreign keys.
    const handler = EVENT_HANDLERS[event.type] as TypedEventHandler<GameEventType> | undefined;
    // Missing-entry guard reproduces the old switch's `default: return null`:
    // a runtime object whose `type` is not a compile-time GameEventType (e.g.
    // an untyped producer casting a foreign payload to GameEvent) is skipped
    // silently, exactly as before.
    return handler ? handler(event) : null;
  }
}
