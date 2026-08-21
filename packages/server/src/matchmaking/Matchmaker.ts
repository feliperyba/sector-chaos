import { Schema, MapSchema, type } from '@colyseus/schema';
import { Room, Client } from 'colyseus';
import type { MatchmakingEntry, MatchPreferences } from './types.ts';
import { MatchmakerAPI } from './MatchmakerAPI.ts';
import { NetworkChannel, MATCH } from '@sector-battle/shared';

class MatchmakingPlayer extends Schema {
  @type('string') playerId: string = '';
  @type('float32') mmr: number = 0;
  @type('string') phase: string = 'primary';
  @type('uint8') position: number = 0;
  @type('string') status: string = 'waiting';
}

class MatchmakingState extends Schema {
  @type('uint16') totalQueued: number = 0;
  @type('string') currentPhase: string = 'primary';
  @type('uint32') elapsedSeconds: number = 0;
  @type('uint16') playersFound: number = 0;
  @type('uint8') playersNeeded: number = MATCH.MIN_PLAYERS;
  @type({ map: MatchmakingPlayer }) players = new MapSchema<MatchmakingPlayer>();
}

interface JoinOptions {
  mmr?: number;
  mapId?: string;
  mode?: string;
}

interface MatchmakingRoomOptions {
  mode?: string;
}

export class Matchmaker extends Room<{ state: MatchmakingState }> {
  maxClients = 1000;
  patchRate = 1000;
  autoDispose = false;
  maxMessagesPerSecond = 10;

  private entries: Map<string, MatchmakingEntry> = new Map();
  private cycleStartMs: number = 0;
  private retryCount: number = 0;
  private matchingInProgress = false;
  private cycleIntervalMs: number = MATCH.MATCHMAKING_DURATION * 1000;

  private static readonly MMR_RANGE = 100;
  private static readonly MIN_MATCH_SIZE = 2;

  onCreate(options: MatchmakingRoomOptions): void {
    this.setState(new MatchmakingState());

    const envDuration = process.env.MATCHMAKING_CYCLE_SECONDS;
    if (envDuration) {
      const parsed = parseInt(envDuration, 10);
      if (parsed > 0) this.cycleIntervalMs = parsed * 1000;
    }

    this.setMetadata({
      mode: options.mode ?? 'battle_royale',
      playerCount: 0,
    });

    const now = Date.now();
    const elapsed = now % this.cycleIntervalMs;
    this.cycleStartMs = now - elapsed;

    this.clock.setInterval(() => this.checkCycle(), 1000);

    this.onMessage('cancel', (client: Client) => {
      this.removePlayer(client.sessionId);
    });

    this.onMessage('forceStart', (client: Client) => {
      if (this.entries.size < Matchmaker.MIN_MATCH_SIZE) {
        client.send(NetworkChannel.ERROR, {
          message: `Need at least ${Matchmaker.MIN_MATCH_SIZE} players`,
        });
        return;
      }
      this.createMatch();
    });
  }

  onJoin(client: Client, options: JoinOptions): void {
    const preferences: MatchPreferences = {
      mapId: options.mapId,
      mode: options.mode,
    };

    const entry: MatchmakingEntry = {
      playerId: client.sessionId,
      mmr: options.mmr ?? 0,
      preferences,
      enqueuedAt: Date.now(),
      phase: 'primary',
    };

    this.entries.set(client.sessionId, entry);

    const player = new MatchmakingPlayer();
    player.playerId = client.sessionId;
    player.mmr = entry.mmr;
    player.phase = 'primary';
    player.position = this.entries.size;
    player.status = 'waiting';
    this.state.players.set(client.sessionId, player);

    this.state.totalQueued = this.entries.size;

    client.send('queuePosition', {
      position: this.entries.size,
      totalQueued: this.entries.size,
    });
  }

  onLeave(client: Client): void {
    this.removePlayer(client.sessionId);
  }

  private removePlayer(playerId: string): void {
    this.entries.delete(playerId);
    this.state.players.delete(playerId);
    this.state.totalQueued = this.entries.size;
    this.setMetadata({ playerCount: this.entries.size });
  }

  private checkCycle(): void {
    if (this.matchingInProgress) return;

    const now = Date.now();
    const elapsed = now - this.cycleStartMs;

    this.state.elapsedSeconds = Math.floor(elapsed / 1000);
    this.state.playersFound = this.entries.size;

    if (elapsed < this.cycleIntervalMs) return;

    const humanCount = this.entries.size;

    if (humanCount < Matchmaker.MIN_MATCH_SIZE) {
      this.retryCount++;
      const phases = ['primary', 'fallback1', 'fallback2', 'timeout'] as const;
      this.state.currentPhase = phases[Math.min(this.retryCount, phases.length - 1)]!;
      if (this.retryCount >= MATCH.MATCHMAKING_MAX_RETRIES) {
        this.dissolveLobby();
        return;
      }
      this.cycleStartMs = now;
      return;
    }

    this.createMatch();
  }

  private createMatch(): void {
    const sorted = Array.from(this.entries.values()).sort((a, b) => a.mmr - b.mmr);

    let matchedEntries: MatchmakingEntry[];
    if (sorted.length > MATCH.MAX_PLAYERS) {
      matchedEntries = sorted.slice(0, MATCH.MAX_PLAYERS);
    } else {
      matchedEntries = sorted;
    }

    const playerIds = matchedEntries.map((e) => e.playerId);
    const averageMmr =
      matchedEntries.length > 0
        ? matchedEntries.reduce((sum, e) => sum + e.mmr, 0) / matchedEntries.length
        : 0;

    void this.attemptMatch(playerIds, averageMmr);
    this.retryCount = 0;
    this.cycleStartMs = Date.now();
  }

  private dissolveLobby(): void {
    for (const client of this.clients) {
      client.send('matchmakingFailed', {
        reason: 'max_retries_exceeded',
        maxRetries: MATCH.MATCHMAKING_MAX_RETRIES,
      });
    }
    this.entries.clear();
    this.state.players.clear();
    this.state.totalQueued = 0;
    this.retryCount = 0;
    this.cycleStartMs = Date.now();
  }

  private async attemptMatch(playerIds: string[], averageMmr: number = 0): Promise<void> {
    if (this.matchingInProgress || playerIds.length === 0) {
      return;
    }
    this.matchingInProgress = true;
    try {
      const firstEntry = this.entries.get(playerIds[0]!);
      const preferences = firstEntry?.preferences ?? {};

      const result = await MatchmakerAPI.createLobbyRoom({
        mapId: preferences.mapId ?? 'random',
        mode: preferences.mode ?? 'battle_royale',
        playerIds,
        averageMmr,
      });

      for (const reservation of result.seatReservations) {
        const client = this.clients.find((c) => c.sessionId === reservation.playerId);
        if (client) {
          client.send('matchFound', {
            roomId: reservation.roomId,
            seatToken: reservation.seatToken,
          });
        }
      }

      for (const playerId of playerIds) {
        this.entries.delete(playerId);
        this.state.players.delete(playerId);
      }

      this.state.totalQueued = this.entries.size;
      this.state.playersFound += playerIds.length;
      this.setMetadata({ playerCount: this.entries.size });
    } catch {
      this.broadcast('matchError', { message: 'Failed to create lobby room' });
    } finally {
      this.matchingInProgress = false;
    }
  }

  onDispose(): void {}
}
