import { Room, Client } from 'colyseus';
import { LobbyState } from './schema/LobbyState.ts';
import { LobbyPlayerManager } from './LobbyPlayerManager.ts';
import { netLogger as logger } from '@sector-battle/shared';

const GRACE_SECONDS = 30;

type ResyncCallback = (client: Client) => void;

export class LobbyReconnectionHelper {
  private static resyncCallbacks: Map<string, ResyncCallback> = new Map();

  static registerResync(roomId: string, callback: ResyncCallback): void {
    LobbyReconnectionHelper.resyncCallbacks.set(roomId, callback);
  }

  static unregisterResync(roomId: string): void {
    LobbyReconnectionHelper.resyncCallbacks.delete(roomId);
  }

  static async handleDrop(
    room: Room,
    client: Client,
    state: LobbyState,
    playerManager?: LobbyPlayerManager,
  ): Promise<void> {
    const player = state.players.get(client.sessionId);

    if (player) {
      player.connected = false;
    }

    room.broadcast('playerDisconnected', {
      sessionId: client.sessionId,
      graceSeconds: GRACE_SECONDS,
    });

    try {
      await room.allowReconnection(client, GRACE_SECONDS);

      if (player) {
        player.connected = true;
      }

      const resync = LobbyReconnectionHelper.resyncCallbacks.get(room.roomId);
      if (resync) {
        resync(client);
      }

      room.broadcast('playerReconnected', {
        sessionId: client.sessionId,
      });
    } catch {
      LobbyReconnectionHelper.handleTimeout(room, client.sessionId, state, playerManager);
    }
  }

  static handleTimeout(
    room: Room,
    sessionId: string,
    state: LobbyState,
    playerManager?: LobbyPlayerManager,
  ): void {
    const player = state.players.get(sessionId);

    if (player) {
      const name = player.name;
      logger.info(`player timeout: ${name}`);
      room.broadcast('playerTimeout', {
        sessionId,
        name,
        reason: 'timeout',
      });
    }

    if (playerManager) {
      playerManager.releaseColor(sessionId);
      playerManager.removePlayer(sessionId);
    } else {
      state.players.delete(sessionId);
    }
  }

  static handleVoluntaryLeave(
    room: Room,
    client: Client,
    state: LobbyState,
    playerManager?: LobbyPlayerManager,
  ): void {
    const player = state.players.get(client.sessionId);

    if (!player) {
      return;
    }

    const name = player.name;

    if (playerManager) {
      playerManager.releaseColor(client.sessionId);

      if (playerManager.isHost(client.sessionId)) {
        playerManager.transferHost(client.sessionId);
      }

      playerManager.removePlayer(client.sessionId);
    } else {
      state.players.delete(client.sessionId);
    }

    room.broadcast('playerLeft', {
      sessionId: client.sessionId,
      name,
    });
  }
}
