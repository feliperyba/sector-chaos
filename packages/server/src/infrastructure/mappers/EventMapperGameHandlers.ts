import { NetworkChannel } from '@sector-battle/shared';
import type {
  PlayerEliminatedMessage,
  ZoneDamageMessage,
  MatchPhaseChangedMessage,
  MatchEndMessage,
  MatchStartedMessage,
  SpectatingTransitionMessage,
  SuddenDeathTriggeredMessage,
  ZonePhaseChangedMessage,
  SectorSiegeStartedMessage,
  ZoneWarningMessage,
  SiegeWallDroppedMessage,
  SiegeWallWarningMessage,
  SuddenDeathEscalationMessage,
  ChatMessageMessage,
} from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import type { BroadcastMessage } from './EventMapperHandlers.ts';

export function toKillFeed(event: GameEvent): BroadcastMessage<PlayerEliminatedMessage> | null {
  if (event.type !== 'PlayerEliminated') return null;

  return {
    channel: NetworkChannel.KILL_FEED,
    message: {
      playerId: event.playerId,
      playerName: event.playerName,
      killedBy: event.killedBy,
      killerName: event.killerName,
      placement: event.placement,
      weapon: event.weapon,
      cause: event.cause,
      tick: event.tick,
      x: event.x,
      y: event.y,
      sessionId: event.playerId,
    },
  };
}

export function toZoneUpdate(event: GameEvent): BroadcastMessage<ZoneDamageMessage> | null {
  if (event.type !== 'ZoneDamage') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'ZoneDamage',
      playersDamaged: event.playersDamaged,
      tick: event.tick,
    },
  };
}

export function toMatchPhaseMessage(
  event: GameEvent,
): BroadcastMessage<MatchPhaseChangedMessage> | null {
  if (event.type !== 'MatchPhaseChanged') return null;

  return {
    channel: NetworkChannel.MATCH_START,
    message: {
      from: event.from,
      to: event.to,
      tick: event.tick,
    },
  };
}

export function toMatchEndMessage(event: GameEvent): BroadcastMessage<MatchEndMessage> | null {
  if (event.type !== 'MatchEnded') return null;

  return {
    channel: NetworkChannel.MATCH_END,
    message: {
      type: NetworkChannel.MATCH_END,
      winnerId: event.winnerId,
      placements: event.placements,
      stats: [],
    },
  };
}

export function toMatchStartedMessage(
  event: GameEvent,
): BroadcastMessage<MatchStartedMessage> | null {
  if (event.type !== 'MatchStarted') return null;

  return {
    channel: NetworkChannel.MATCH_START,
    message: {
      mapSeed: event.mapSeed,
      playerCount: event.playerCount,
      tick: event.tick,
    },
  };
}

export function toSpectatingTransitionMessage(
  event: GameEvent,
): BroadcastMessage<SpectatingTransitionMessage> | null {
  if (event.type !== 'SpectatingTransition') return null;

  return {
    channel: NetworkChannel.MATCH_START,
    message: {
      eventType: 'SpectatingTransition',
      playerId: event.playerId,
      killerId: event.killerId ?? '',
      cameraZoomFactor: event.cameraZoomFactor,
      cameraZoomDuration: event.cameraZoomDuration,
      tick: event.tick,
    },
  };
}

export function toSuddenDeathMessage(
  event: GameEvent,
): BroadcastMessage<SuddenDeathTriggeredMessage> | null {
  if (event.type !== 'SuddenDeathTriggered') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'SuddenDeathTriggered',
      remainingPlayers: event.remainingPlayers,
      tick: event.tick,
    },
  };
}

export function toZonePhaseChangedMessage(
  event: GameEvent,
): BroadcastMessage<ZonePhaseChangedMessage> | null {
  if (event.type !== 'ZonePhaseChanged') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'ZonePhaseChanged',
      previousPhase: event.previousPhase,
      newPhase: event.newPhase,
      currentRadius: event.currentRadius,
      targetRadius: event.targetRadius,
      tick: event.tick,
    },
  };
}

export function toSectorSiegeStartedMessage(
  event: GameEvent,
): BroadcastMessage<SectorSiegeStartedMessage> | null {
  if (event.type !== 'SectorSiegeStarted') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'SectorSiegeStarted',
      sectorRow: event.sectorRow,
      sectorCol: event.sectorCol,
      tick: event.tick,
    },
  };
}

export function toZoneWarningMessage(
  event: GameEvent,
): BroadcastMessage<ZoneWarningMessage> | null {
  if (event.type !== 'ZoneWarning') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'ZoneWarning',
      nextPhaseIndex: event.nextPhaseIndex,
      nextCenterX: event.nextCenterX,
      nextCenterY: event.nextCenterY,
      nextRadius: event.nextRadius,
      transitionStartsInMs: event.transitionStartsInMs,
      tick: event.tick,
    },
  };
}

export function toSiegeWallDroppedMessage(
  event: GameEvent,
): BroadcastMessage<SiegeWallDroppedMessage> | null {
  if (event.type !== 'SiegeWallDropped') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'SiegeWallDropped',
      gridX: event.gridX,
      gridY: event.gridY,
      sectorRow: event.sectorRow,
      sectorCol: event.sectorCol,
      ring: event.ring,
      tileIndex: event.tileIndex ?? 0,
      audible: event.audible ?? false,
      tick: event.tick,
    },
  };
}

export function toSiegeWallWarningMessage(
  event: GameEvent,
): BroadcastMessage<SiegeWallWarningMessage> | null {
  if (event.type !== 'SiegeWallWarning') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'SiegeWallWarning',
      gridX: event.gridX,
      gridY: event.gridY,
      solidifyAt: event.solidifyAt,
      tick: event.tick,
    },
  };
}

export function toSuddenDeathEscalationMessage(
  event: GameEvent,
): BroadcastMessage<SuddenDeathEscalationMessage> | null {
  if (event.type !== 'SuddenDeathEscalation') return null;

  return {
    channel: NetworkChannel.ZONE_UPDATE,
    message: {
      eventType: 'SuddenDeathEscalation',
      level: event.level,
      damagePerTick: event.damagePerTick,
      shrinkRateMultiplier: event.shrinkRateMultiplier,
      tick: event.tick,
    },
  };
}

export function toChatMessageMessage(
  event: GameEvent,
): BroadcastMessage<ChatMessageMessage> | null {
  if (event.type !== 'ChatMessage') return null;

  return {
    channel: NetworkChannel.CHAT,
    message: {
      eventType: 'ChatMessage',
      senderId: event.senderId,
      text: event.text,
      tick: event.tick,
    },
  };
}
