import * as Colyseus from '@colyseus/sdk';
import { SERVER_URL } from '../types.js';
import { netLogger as logger } from '@sector-battle/shared';

// ---------------------------------------------------------------------------
// Server payload types
// ---------------------------------------------------------------------------

export interface LobbyPlayerInfo {
  sessionId: string;
  name: string;
  color: number;
  ready: boolean;
  isHost: boolean;
}

export interface LobbyStatePayload {
  mapId: string;
  mode: string;
  status: string;
  hostId: string;
  players: LobbyPlayerInfo[];
}

export interface MatchStartingPayload {
  roomId: string;
  seatToken: string;
  mapId: string;
  mode: string;
}

export interface PlayerEventPayload {
  sessionId: string;
  name?: string;
}

export interface LobbySnapshot {
  players: LobbyPlayerInfo[];
  status: string;
  countdownSeconds: number;
}

interface LobbyRoomPlayer {
  sessionId?: string;
  name?: string;
  color?: number;
  ready?: boolean;
  isHost?: boolean;
}

interface LobbyRoomState {
  players?: {
    forEach(cb: (player: LobbyRoomPlayer, key: string) => void): void;
  };
  status?: string;
  countdownSeconds?: number;
}

/** Callback types for lobby events. */
export type LobbyStateChangeCallback = (snapshot: LobbySnapshot) => void;
export type MatchStartCallback = (client: Colyseus.Client, data: MatchStartingPayload) => void;
export type ErrorCallback = (message: string) => void;

/**
 * LobbyConnection — encapsulates all Colyseus client + lobby room interaction.
 * Manages 7+ message types, state subscriptions, and match start flow.
 */
export class LobbyConnection {
  private client: Colyseus.Client | null = null;
  private lobbyRoom: Colyseus.Room | null = null;

  // Callbacks
  private onStateChangeCb: LobbyStateChangeCallback | null = null;
  private onMatchStartCb: MatchStartCallback | null = null;
  private onErrorCb: ErrorCallback | null = null;
  private onLeaveCb: (() => void) | null = null;

  // Latest state snapshot
  private snapshot: LobbySnapshot = {
    players: [],
    status: 'waiting',
    countdownSeconds: 0,
  };

  // --- Public API ---

  get currentSnapshot(): LobbySnapshot {
    return this.snapshot;
  }

  onStateChange(cb: LobbyStateChangeCallback): void {
    this.onStateChangeCb = cb;
  }

  onMatchStart(cb: MatchStartCallback): void {
    this.onMatchStartCb = cb;
  }

  onError(cb: ErrorCallback): void {
    this.onErrorCb = cb;
  }

  onLeave(cb: () => void): void {
    this.onLeaveCb = cb;
  }

  async connect(serverUrl?: string): Promise<void> {
    const url = serverUrl ?? SERVER_URL;
    this.client = new Colyseus.Client(url);

    try {
      logger.info('Connecting to lobby room...');
      this.lobbyRoom = await this.client.joinOrCreate('lobby', {});

      logger.info(`Joined lobby room: ${this.lobbyRoom.roomId} as ${this.lobbyRoom.sessionId}`);

      this.wireRoom();
    } catch (err) {
      logger.error('Failed to connect to lobby:', err);
      this.emitError('Failed to connect to server');
    }
  }

  disconnect(): void {
    if (this.lobbyRoom) {
      try {
        this.lobbyRoom.leave();
      } catch {
        // Ignore — may already be disconnected
      }
      this.lobbyRoom = null;
    }
    this.client = null;
  }

  getClient(): Colyseus.Client | null {
    return this.client;
  }

  // --- Room wiring ---

  private handleStateChange(state: LobbyRoomState): void {
    if (state.players && typeof state.players.forEach === 'function') {
      const playerList: LobbyPlayerInfo[] = [];
      state.players.forEach((player: LobbyRoomPlayer, key: string) => {
        playerList.push({
          sessionId: player.sessionId ?? key,
          name: player.name ?? '???',
          color: player.color ?? 0,
          ready: player.ready ?? false,
          isHost: player.isHost ?? false,
        });
      });
      this.snapshot.players = playerList;
    }

    if (state.status) {
      this.snapshot.status = state.status;
    }

    if (typeof state.countdownSeconds === 'number') {
      this.snapshot.countdownSeconds = state.countdownSeconds;
    }

    this.emitStateChange();
  }

  private wireRoom(): void {
    const room = this.lobbyRoom;
    if (!room) return;

    // --- Room state subscriptions ---
    room.onStateChange.once((state: LobbyRoomState) => {
      logger.info('Initial lobby state received');
      this.handleStateChange(state);
    });

    room.onStateChange((state: LobbyRoomState) => {
      this.handleStateChange(state);
    });

    // --- Message handlers ---
    room.onMessage('lobby_state', (data: LobbyStatePayload) => {
      this.snapshot.players = data.players;
      this.snapshot.status = data.status;
      this.emitStateChange();
    });

    room.onMessage('playerJoined', (data: PlayerEventPayload) => {
      logger.info(`Player joined: ${data.name ?? data.sessionId}`);
    });

    room.onMessage('playerLeft', (data: PlayerEventPayload) => {
      logger.info(`Player left: ${data.sessionId}`);
    });

    room.onMessage('readyChange', (data: { playerId: string; ready: boolean }) => {
      const player = this.snapshot.players.find((p) => p.sessionId === data.playerId);
      if (player) {
        player.ready = data.ready;
        this.emitStateChange();
      }
    });

    room.onMessage('matchStarting', (data: MatchStartingPayload) => {
      logger.info(`Match starting! Room: ${data.roomId}`);
      if (this.onMatchStartCb && this.client) {
        this.onMatchStartCb(this.client, data);
      }
    });

    room.onMessage('matchError', (data: { message: string }) => {
      logger.error('Match error:', data.message);
      this.emitError(data.message);
    });

    room.onMessage('nameChange', (data: { playerId: string; name: string }) => {
      const player = this.snapshot.players.find((p) => p.sessionId === data.playerId);
      if (player) {
        player.name = data.name;
        this.emitStateChange();
      }
    });

    room.onMessage('mapChanged', (data: { mapId: string }) => {
      logger.info(`Map changed: ${data.mapId}`);
    });

    // --- Disconnection handler ---
    room.onLeave((code: number) => {
      logger.warn(`Lobby room left, code=${code}`);
      if (this.onLeaveCb) {
        this.onLeaveCb();
      }
    });

    room.onError((err: unknown) => {
      logger.error('Lobby room error:', err);
      this.emitError('Connection error');
    });
  }

  // --- Emission helpers ---

  private emitStateChange(): void {
    if (this.onStateChangeCb) {
      this.onStateChangeCb({ ...this.snapshot, players: [...this.snapshot.players] });
    }
  }

  private emitError(message: string): void {
    if (this.onErrorCb) {
      this.onErrorCb(message);
    }
  }
}
