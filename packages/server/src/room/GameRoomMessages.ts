import type { Client } from 'colyseus';
import { NETWORK, NetworkChannel } from '@sector-battle/shared';
import type { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import { EventMapper } from '../infrastructure/mappers/EventMapperHandlers.ts';
import { toSpectatingTransitionMessage } from '../infrastructure/mappers/EventMapperGameHandlers.ts';
import { BotManager } from '../ai/BotManager.ts';
import type { MatchMeta } from '../infrastructure/mappers/StateMapper.ts';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';
import type { GameEvent } from '../domain/events/index.ts';
import { debugEventBus } from '../infrastructure/DebugEventBus.ts';
import { logger } from '@sector-battle/shared';

/**
 * Interface used by message/tick functions to interact with the GameRoom.
 */
export interface MessagesRoom {
  clients: Client[];
  broadcast(channel: string, message: unknown): void;
  orchestrator: GameOrchestrator;
  matchMeta: MatchMeta;
  botManager: BotManager;
  botTakenOver: Set<string>;
  spectatorFollowTargets: Map<string, string>;
  pathfinder: Pathfinder;
  matchStarted: boolean;

  syncState(): void;
  buildMapDataPayload(): Record<string, unknown>;
}

export function handleSimulationTick(ctx: MessagesRoom, deltaMs: number = NETWORK.TICK_INTERVAL): void {
  try {
    if (!ctx.matchStarted) {
      ctx.orchestrator.start();
      ctx.matchStarted = true;
    }
    const events = ctx.orchestrator.update(deltaMs);
    broadcastEvents(ctx, events);
    handleGridUpdates(ctx, events);
    sendSpectatingTransitions(ctx, events);
    sendSpectatorFollowTargets(ctx, events);
    processReconnectionEvents(ctx);
    if (process.env.NODE_ENV !== 'production') {
      debugEventBus.emitEvents(events);
    }
  } catch (err) {
    logger.error('simulation tick error', err);
  }
}

function broadcastEvents(ctx: MessagesRoom, events: GameEvent[]): void {
  const messages = EventMapper.broadcastEvents(events);
  for (const { channel, message } of messages) {
    ctx.broadcast(channel, message);
  }
}

function handleGridUpdates(ctx: MessagesRoom, events: GameEvent[]): void {
  for (const event of events) {
    if (event.type === 'DestructibleDestroyed') {
      const gridX = event.gridX as number;
      const gridY = event.gridY as number;
      ctx.pathfinder.markCellWalkable(gridX, gridY);
    }
  }
}

function processReconnectionEvents(ctx: MessagesRoom): void {
  const reconnectionEvents = ctx.orchestrator.drainReconnectionEvents();
  for (const event of reconnectionEvents) {
    switch (event.type) {
      case 'PHASE3_ENTER': {
        const playerId = event.playerId;
        ctx.botTakenOver.add(playerId);
        ctx.botManager.takeoverPlayer(ctx.orchestrator, playerId);
        break;
      }
      case 'AFK_WARNING': {
        const client = ctx.clients.find((c) => c.sessionId === event.playerId);
        if (client) {
          client.send(NetworkChannel.AFK_WARNING, {
            remainingSeconds: event.remainingSeconds,
            message: `No input detected. Bot takeover in ${event.remainingSeconds}s.`,
          });
        }
        break;
      }
      case 'AFK_TAKEOVER': {
        const playerId = event.playerId;
        ctx.botTakenOver.add(playerId);
        ctx.botManager.takeoverPlayer(ctx.orchestrator, playerId);
        break;
      }
    }
  }
}

function sendSpectatingTransitions(ctx: MessagesRoom, events: GameEvent[]): void {
  for (const event of events) {
    if (event.type !== 'SpectatingTransition') continue;
    const msg = toSpectatingTransitionMessage(event);
    if (!msg) continue;
    const client = ctx.clients.find((c) => c.sessionId === event.playerId);
    if (client) {
      client.send(msg.channel, msg.message);
    }
  }
}

function sendSpectatorFollowTargets(ctx: MessagesRoom, events: GameEvent[]): void {
  for (const event of events) {
    if (event.type !== 'PlayerEliminated') continue;
    const eliminatedId = event.playerId as string;
    const killedBy = event.killedBy as string;

    let targetId: string | null = null;

    if (killedBy) {
      const matchState = ctx.orchestrator.getMatchState();
      const killer = matchState.players.get(killedBy);
      if (killer && killer.isActive && killedBy !== eliminatedId) {
        targetId = killedBy;
      }
    }

    if (!targetId) {
      targetId = getLowestAlivePlayerId(ctx);
    }

    if (!targetId) continue;

    const killedClient = ctx.clients.find((c) => c.sessionId === eliminatedId);
    if (killedClient) {
      killedClient.send(NetworkChannel.SPECTATOR_FOLLOW_TARGET, { targetId });
      ctx.spectatorFollowTargets.set(eliminatedId, targetId);
    }

    for (const [spectatorId, followId] of ctx.spectatorFollowTargets) {
      if (followId === eliminatedId && spectatorId !== eliminatedId) {
        const specClient = ctx.clients.find((c) => c.sessionId === spectatorId);
        if (specClient) {
          specClient.send(NetworkChannel.SPECTATOR_FOLLOW_TARGET, { targetId });
          ctx.spectatorFollowTargets.set(spectatorId, targetId);
        }
      }
    }
  }
}

function getLowestAlivePlayerId(ctx: MessagesRoom): string | null {
  const matchState = ctx.orchestrator.getMatchState();
  let lowest: string | null = null;
  for (const [id, player] of matchState.players) {
    if (!player.isActive) continue;
    if (lowest === null || id < lowest) {
      lowest = id;
    }
  }
  return lowest;
}
