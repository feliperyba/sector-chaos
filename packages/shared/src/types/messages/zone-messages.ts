/**
 * Zone update channel message types.
 *
 * Channel: zone_update
 */

export interface ZoneDamageMessage {
  eventType: 'ZoneDamage';
  playersDamaged: ReadonlyArray<{ playerId: string; damage: number }>;
  tick: number;
}

export interface SuddenDeathTriggeredMessage {
  eventType: 'SuddenDeathTriggered';
  remainingPlayers: readonly string[];
  tick: number;
}

export interface ZonePhaseChangedMessage {
  eventType: 'ZonePhaseChanged';
  previousPhase: number;
  newPhase: number;
  currentRadius: number;
  targetRadius: number;
  tick: number;
}

export interface SectorSiegeStartedMessage {
  eventType: 'SectorSiegeStarted';
  sectorRow: number;
  sectorCol: number;
  tick: number;
}

export interface ZoneWarningMessage {
  eventType: 'ZoneWarning';
  nextPhaseIndex: number;
  nextCenterX: number;
  nextCenterY: number;
  nextRadius: number;
  transitionStartsInMs: number;
  tick: number;
}

export interface SiegeWallDroppedMessage {
  eventType: 'SiegeWallDropped';
  gridX: number;
  gridY: number;
  sectorRow: number;
  sectorCol: number;
  ring: number;
  tileIndex: number;
  audible: boolean;
  tick: number;
}

export interface SiegeWallWarningMessage {
  eventType: 'SiegeWallWarning';
  gridX: number;
  gridY: number;
  solidifyAt: number;
  tick: number;
}

export interface SuddenDeathEscalationMessage {
  eventType: 'SuddenDeathEscalation';
  level: number;
  damagePerTick: number;
  shrinkRateMultiplier: number;
  tick: number;
}

export type ZoneUpdateChannelMessage =
  | ZoneDamageMessage
  | SuddenDeathTriggeredMessage
  | ZonePhaseChangedMessage
  | SectorSiegeStartedMessage
  | ZoneWarningMessage
  | SiegeWallDroppedMessage
  | SiegeWallWarningMessage
  | SuddenDeathEscalationMessage;
