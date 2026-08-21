import type {
  BarrelExplodedEvent,
  DestructibleDestroyedEvent,
  DestructibleRespawnedEvent,
} from './DestructibleEvents.ts';
import type {
  ChestOpenedEvent,
  ChestOpeningInterruptedEvent,
  ChestRejectedEvent,
} from './ChestEvents.ts';
import type { DomainEvent } from './DomainEvent.ts';
import type {
  MatchEndedEvent,
  MatchStartedEvent,
  SuddenDeathTriggeredEvent,
} from './MatchEvents.ts';
import type { MatchPhaseChangedEvent } from './MatchPhaseChanged.ts';
import type { PlayerDamagedEvent } from './PlayerDamaged.ts';
import type { PlayerEliminatedEvent } from './PlayerEliminated.ts';
import type { PowerUpCollectedEvent } from './PowerUpCollected.ts';
import type { PowerUpEffectExpiredEvent } from './PowerUpEvents.ts';
import type { ProjectileBouncedEvent } from './ProjectileBounced.ts';
import type { ProjectileDestroyedEvent } from './ProjectileDestroyed.ts';
import type { ShieldBlockedEvent } from './ShieldBlocked.ts';
import type { TrapCooldownExpiredEvent, TrapTriggeredEvent } from './TrapEvents.ts';
import type { WeaponFiredEvent } from './WeaponFired.ts';
import type { WeaponWallHitEvent } from './WeaponWallHit.ts';
import type { WeaponPickupCollectedEvent } from './WeaponPickupEvents.ts';
import type { WeaponShatteredEvent } from './WeaponShattered.ts';
import type { WeaponThrownEvent } from './WeaponThrown.ts';
import type { WeaponBrokenEvent } from './WeaponBroken.ts';
import type { ZoneDamageEvent } from './ZoneDamage.ts';
import type { ZonePhaseChangedEvent } from './ZonePhaseChanged.ts';
import type { SectorSiegeStartedEvent } from './SectorSiegeStarted.ts';
import type { ZoneWarningEvent } from './ZoneWarning.ts';
import type { SpectatingTransitionEvent } from './SpectatingTransition.ts';
import type { SiegeWallDroppedEvent } from './SiegeWallDropped.ts';
import type { SiegeWallWarningEvent } from './SiegeWallWarning.ts';
import type { ChatMessageEvent } from './ChatMessage.ts';
import type { SuddenDeathEscalationEvent } from './SuddenDeathEscalation.ts';

export type {
  BarrelExplodedEvent,
  ChatMessageEvent,
  ChestOpenedEvent,
  ChestOpeningInterruptedEvent,
  ChestRejectedEvent,
  DestructibleDestroyedEvent,
  DestructibleRespawnedEvent,
  DomainEvent,
  MatchEndedEvent,
  MatchPhaseChangedEvent,
  MatchStartedEvent,
  PlayerDamagedEvent,
  PlayerEliminatedEvent,
  PowerUpCollectedEvent,
  PowerUpEffectExpiredEvent,
  ProjectileBouncedEvent,
  ProjectileDestroyedEvent,
  SectorSiegeStartedEvent,
  ShieldBlockedEvent,
  SiegeWallDroppedEvent,
  SiegeWallWarningEvent,
  SpectatingTransitionEvent,
  SuddenDeathEscalationEvent,
  SuddenDeathTriggeredEvent,
  TrapCooldownExpiredEvent,
  TrapTriggeredEvent,
  WeaponBrokenEvent,
  WeaponFiredEvent,
  WeaponPickupCollectedEvent,
  WeaponShatteredEvent,
  WeaponThrownEvent,
  WeaponWallHitEvent,
  ZoneDamageEvent,
  ZonePhaseChangedEvent,
  ZoneWarningEvent,
};

export type GameEvent =
  | BarrelExplodedEvent
  | ChatMessageEvent
  | ChestOpenedEvent
  | ChestOpeningInterruptedEvent
  | ChestRejectedEvent
  | DestructibleDestroyedEvent
  | DestructibleRespawnedEvent
  | MatchEndedEvent
  | MatchPhaseChangedEvent
  | MatchStartedEvent
  | PlayerDamagedEvent
  | PlayerEliminatedEvent
  | PowerUpCollectedEvent
  | PowerUpEffectExpiredEvent
  | ProjectileBouncedEvent
  | ProjectileDestroyedEvent
  | SectorSiegeStartedEvent
  | ShieldBlockedEvent
  | SiegeWallDroppedEvent
  | SiegeWallWarningEvent
  | SpectatingTransitionEvent
  | SuddenDeathEscalationEvent
  | SuddenDeathTriggeredEvent
  | TrapCooldownExpiredEvent
  | TrapTriggeredEvent
  | WeaponBrokenEvent
  | WeaponFiredEvent
  | WeaponPickupCollectedEvent
  | WeaponShatteredEvent
  | WeaponThrownEvent
  | WeaponWallHitEvent
  | ZoneDamageEvent
  | ZonePhaseChangedEvent
  | ZoneWarningEvent;
