import type { Room, Client } from 'colyseus';
import { NetworkChannel, MATCH } from '@sector-battle/shared';
import {
  validateChatInput,
  validateSelectNameInput,
  validateSelectColorInput,
  validateSelectMapInput,
  validateKickPlayerInput,
} from '../validation/index.ts';
import type { LobbyPlayerManager } from './LobbyPlayerManager.ts';
import type { LobbyState } from './schema/LobbyState.ts';

type LobbyRoomLike = Room<{ state: LobbyState }> & {
  playerManager: LobbyPlayerManager;
  mapVotes: Map<string, string>;
  lastChatTime: Map<string, number>;
  broadcastLobbyState: () => void;
  beginCountdown: () => void;
  tallyMapVotes: () => Array<{ mapId: string; count: number }>;
  setMetadata: (meta: Record<string, unknown>) => void;
  state: LobbyState;
  clients: Client[];
};

export function registerLobbyMessageHandlers(room: LobbyRoomLike): void {
  room.onMessage('ready', (client: Client) => {
    const player = room.playerManager.getPlayer(client.sessionId);
    if (!player) {
      client.send(NetworkChannel.ERROR, { message: 'Player not found' });
      return;
    }

    const result = room.playerManager.toggleReady(client.sessionId);
    if (result.success) {
      room.broadcast('readyChange', {
        playerId: client.sessionId,
        ready: result.value,
      });
    } else {
      client.send(NetworkChannel.ERROR, { message: result.reason });
    }
  });

  room.onMessage('chat', (client: Client, data: unknown) => {
    const now = Date.now();
    if (now - (room.lastChatTime.get(client.sessionId) ?? 0) < MATCH.CHAT_RATE_LIMIT_MS) {
      client.send(NetworkChannel.ERROR, { message: 'Messages sent too quickly' });
      return;
    }
    room.lastChatTime.set(client.sessionId, now);
    const validation = validateChatInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const player = room.playerManager.getPlayer(client.sessionId);
    if (!player) {
      client.send(NetworkChannel.ERROR, { message: 'Player not found' });
      return;
    }
    const result = room.playerManager.addChatMessage(client.sessionId, validation.data.text);
    if (result.success) return;
    client.send(NetworkChannel.ERROR, { message: result.reason });
  });

  room.onMessage('selectName', (client: Client, data: unknown) => {
    const validation = validateSelectNameInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const validated = validation.data;

    const result = room.playerManager.setName(client.sessionId, validated.name);
    if (result.success) {
      room.broadcast('nameChange', {
        playerId: client.sessionId,
        name: result.value,
      });
    } else {
      client.send(NetworkChannel.ERROR, { message: result.reason });
    }
  });

  room.onMessage('selectColor', (client: Client, data: unknown) => {
    const validation = validateSelectColorInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const validated = validation.data;

    const result = room.playerManager.setColor(client.sessionId, validated.colorIndex);
    if (result.success) {
      room.broadcast('colorChange', {
        playerId: client.sessionId,
        colorIndex: result.value,
      });
    } else {
      client.send(NetworkChannel.ERROR, { message: result.reason });
    }
  });

  room.onMessage('selectMap', (client: Client, data: unknown) => {
    const validation = validateSelectMapInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const validated = validation.data;

    if (!room.playerManager.isHost(client.sessionId)) {
      client.send(NetworkChannel.ERROR, { message: 'Only the host can select the map' });
      return;
    }

    room.state.mapId = validated.mapId;
    room.setMetadata({ mapId: validated.mapId });
    room.broadcast('mapChanged', { mapId: validated.mapId });
  });

  room.onMessage('voteMap', (client: Client, data: unknown) => {
    const validation = validateSelectMapInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const validated = validation.data;
    const player = room.playerManager.getPlayer(client.sessionId);
    if (!player) {
      client.send(NetworkChannel.ERROR, { message: 'Player not found' });
      return;
    }

    room.mapVotes.set(client.sessionId, validated.mapId);
    room.broadcast('mapVote', {
      playerId: client.sessionId,
      mapId: validated.mapId,
      votes: room.tallyMapVotes(),
    });
  });

  room.onMessage('startGame', (client: Client) => {
    if (!room.playerManager.isHost(client.sessionId)) {
      client.send(NetworkChannel.ERROR, { message: 'Only the host can start the game' });
      return;
    }

    if (room.state.players.size < 2) {
      client.send(NetworkChannel.ERROR, { message: 'Need at least 2 players to start' });
      return;
    }

    if (!room.playerManager.allReady()) {
      client.send(NetworkChannel.ERROR, { message: 'All players must be ready' });
      return;
    }

    room.beginCountdown();
  });

  room.onMessage('kickPlayer', (client: Client, data: unknown) => {
    const validation = validateKickPlayerInput(data);
    if (!validation.success) {
      client.send(NetworkChannel.ERROR, { message: 'Invalid input' });
      return;
    }
    const validated = validation.data;

    if (!room.playerManager.isHost(client.sessionId)) {
      client.send(NetworkChannel.ERROR, { message: 'Only the host can kick players' });
      return;
    }

    if (validated.playerId === client.sessionId) {
      client.send(NetworkChannel.ERROR, { message: 'Cannot kick yourself' });
      return;
    }

    const target = room.playerManager.getPlayer(validated.playerId);
    if (!target) {
      client.send(NetworkChannel.ERROR, { message: 'Target player not found' });
      return;
    }

    if (target.isHost) {
      client.send(NetworkChannel.ERROR, { message: 'Cannot kick the host' });
      return;
    }

    const targetClient = room.clients.find((c) => c.sessionId === validated.playerId);
    if (targetClient) {
      targetClient.send('kicked', { reason: 'Removed by host' });
    }

    room.playerManager.removePlayer(validated.playerId);

    room.setMetadata({
      playerCount: room.state.players.size,
      hostId: room.state.hostId,
    });

    room.broadcast('playerKicked', { playerId: validated.playerId });
    room.broadcastLobbyState();
  });
}
