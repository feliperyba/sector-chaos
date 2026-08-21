import { Room, Client, Delayed, CloseCode } from 'colyseus';
import { LobbyState } from './schema/LobbyState.ts';
import { LobbyPlayerManager } from './LobbyPlayerManager.ts';
import { LobbyReconnectionHelper } from './ReconnectionManager.ts';
import { MatchmakerAPI } from '../matchmaking/MatchmakerAPI.ts';
import { MATCH, netLogger as logger } from '@sector-battle/shared';
import { registerLobbyMessageHandlers } from './LobbyMessageHandlers.ts';
import { randomUUID } from 'node:crypto';
import { BOT_NAMES } from './LobbyBotNames.ts';

interface LobbyOptions {
  mapId?: string;
  mode?: string;
  averageMmr?: number;
  botFill?: boolean;
}

interface JoinOptions {
  mmr?: number;
  name?: string;
}

/** Bot player in the lobby (not a real Colyseus client). */
interface BotEntry {
  id: string;
  name: string;
}

export class LobbyRoom extends Room<{ state: LobbyState }> {
  maxClients = 64;
  patchRate = 1000;
  autoDispose = true;
  seatReservationTimeout = MATCH.SEAT_RESERVATION_TIMEOUT;
  maxMessagesPerSecond = 30;

  private playerManager!: LobbyPlayerManager;
  private countdownTimer: Delayed | null = null;
  private afkCheckInterval: Delayed | null = null;
  private botFillTimer: Delayed | null = null;
  private mapVotes: Map<string, string> = new Map();
  private lastChatTime: Map<string, number> = new Map();
  private lobbyAverageMmr: number | undefined;
  private bots: BotEntry[] = [];
  private botFillStarted = false;
  private enableBotFill = true;
  /** True once this lobby has created a match and redirected players. A
   *  completed lobby is single-use; if joinOrCreate reuses it before it
   *  disposes, onJoin resets it via resetForNewMatch instead of stranding
   *  the new player in a dead 'starting' room. */
  private matchCreated = false;
  /** Consecutive match-creation failures from the current countdown. Bounded
   *  so a persistently-failing createGameRoom doesn't loop forever. */
  private startRetries = 0;

  private static readonly BOT_FILL_TIMEOUT_MS = MATCH.MATCHMAKING_DURATION * 1000;

  onCreate(options: LobbyOptions): void {
    this.setState(new LobbyState());

    const mapId = options.mapId ?? 'random';
    const mode = options.mode ?? 'battle_royale';
    this.lobbyAverageMmr = options.averageMmr;
    this.enableBotFill = options.botFill !== false;

    this.setMetadata({
      mapId,
      mode,
      status: 'waiting',
      playerCount: 0,
      maxPlayers: 64,
      hostId: '',
    });

    this.state.mapId = mapId;
    this.state.mode = mode;

    this.playerManager = new LobbyPlayerManager(this.state);

    this.afkCheckInterval = this.clock.setInterval(() => this.checkAfk(), 10000);

    if (this.enableBotFill) {
      this.botFillTimer = this.clock.setTimeout(
        () => this.autoStartWithBotFill(),
        LobbyRoom.BOT_FILL_TIMEOUT_MS,
      );
    }

    LobbyReconnectionHelper.registerResync(this.roomId, (client) => {
      this.broadcastLobbyStateTo(client);
    });

    this.registerMessageHandlers();
  }

  onJoin(client: Client, options: JoinOptions): void {
    // Reuse guard: if joinOrCreate('lobby') handed this player a lobby that
    // already created its match (it didn't auto-dispose in time), reset it to a
    // clean state so the normal first-join bot-fill + countdown runs. Without
    // this the player lands in a full, dead 'starting' lobby that never counts
    // down — the "lobby fills but never starts" symptom.
    if (this.matchCreated || this.state.status === 'starting') {
      logger.warn(`Lobby ${this.roomId} reused after matchCreated — resetting for new cycle`);
      this.resetForNewMatch();
    }

    this.playerManager.addPlayer(client.sessionId, options.mmr ?? 0);

    if (options.name && /^[a-zA-Z0-9_]{3,20}$/.test(options.name)) {
      this.playerManager.setName(client.sessionId, options.name);
    }

    if (this.state.players.size === 1) {
      this.playerManager.assignHost(client.sessionId);
    }

    this.playerManager.updateActivity(client.sessionId);

    this.setMetadata({
      playerCount: this.state.players.size,
      hostId: this.state.hostId,
    });

    const player = this.playerManager.getPlayer(client.sessionId);
    this.playerManager.addSystemMessage(`${player?.name ?? 'Player'} joined the lobby`);

    this.broadcastLobbyState();

    // First human joins → cancel the 90s wait and immediately start bot fill
    if (this.enableBotFill && !this.botFillStarted && this.state.status === 'waiting') {
      this.botFillStarted = true;
      if (this.botFillTimer) {
        this.botFillTimer.clear();
        this.botFillTimer = null;
      }
      this.startInstantBotFill();
    }
  }

  onLeave(client: Client, code?: number): void {
    const isConsented = code === CloseCode.CONSENTED;

    if (isConsented) {
      LobbyReconnectionHelper.handleVoluntaryLeave(this, client, this.state, this.playerManager);
    }

    this.setMetadata({
      playerCount: this.state.players.size,
      hostId: this.state.hostId,
    });
  }

  async onDrop(client: Client): Promise<void> {
    await LobbyReconnectionHelper.handleDrop(this, client, this.state, this.playerManager);
  }

  private registerMessageHandlers(): void {
    registerLobbyMessageHandlers(
      this as unknown as Parameters<typeof registerLobbyMessageHandlers>[0],
    );
  }

  private beginCountdown(): void {
    this.applyMapVoteResult();

    this.state.status = 'countdown';
    this.state.countdownSeconds = 5;
    this.startRetries = 0;

    this.setMetadata({ status: 'countdown' });

    if (this.countdownTimer !== null) {
      this.countdownTimer.clear();
    }

    this.countdownTimer = this.clock.setInterval(() => {
      this.state.countdownSeconds--;

      if (this.state.countdownSeconds <= 0) {
        this.countdownTimer?.clear();
        this.countdownTimer = null;

        this.state.status = 'starting';
        this.setMetadata({ status: 'starting' });

        void this.createMatchAndRedirect();
      }
    }, 1000);
  }

  private async createMatchAndRedirect(): Promise<void> {
    const playerIds: string[] = [];
    let mmrSum = 0;
    let mmrCount = 0;
    for (const [id, player] of this.state.players) {
      if (player.connected) {
        playerIds.push(id);
        if (player.mmr > 0) {
          mmrSum += player.mmr;
          mmrCount++;
        }
      }
    }
    const humanCount = this.clients.length;

    // Include bot IDs so GameRoom receives the full 64-player roster
    for (const bot of this.bots) {
      playerIds.push(bot.id);
    }

    const averageMmr = mmrCount > 0 ? mmrSum / mmrCount : this.lobbyAverageMmr;

    try {
      const result = await MatchmakerAPI.createGameRoom({
        mapId: this.state.mapId,
        mode: this.state.mode,
        playerIds,
        humanCount,
        averageMmr,
      });

      for (const reservation of result.seatReservations) {
        // Send matchStarting to real clients only
        const client = this.clients.find((c) => c.sessionId === reservation.playerId);
        if (client) {
          client.send('matchStarting', {
            roomId: result.roomId,
            seatToken: reservation.seatToken,
            mapId: this.state.mapId,
            mode: this.state.mode,
          });
        }
      }

      // Match created and players redirected — this lobby's lifecycle is
      // complete. Mark it so a joinOrCreate reuse resets rather than strands.
      this.matchCreated = true;
    } catch (err) {
      // Never swallow this silently — an invisible failure here strands the
      // lobby at 64/64 with botFillStarted=true and no way to re-trigger the
      // countdown. Log, retry a couple of times, then reset so the player can
      // leave/rejoin cleanly instead of being stuck forever.
      logger.error('createMatchAndRedirect failed', err);
      this.startRetries++;
      if (this.startRetries <= 2) {
        this.playerManager.addSystemMessage('Match creation failed — retrying...');
        this.clock.setTimeout(() => void this.createMatchAndRedirect(), 3000);
        return;
      }
      this.playerManager.addSystemMessage('Match creation failed — resetting lobby');
      this.broadcast('matchError', { message: 'Failed to create game room' });
      this.resetForNewMatch();
    }
  }

  private autoStartWithBotFill(): void {
    this.botFillTimer = null;
    if (this.state.status !== 'waiting') return;
    if (this.state.players.size < 1) return;

    this.playerManager.addSystemMessage('Match timer expired - auto-starting with bot fill');
    this.beginCountdown();
  }

  /**
   * Reset a completed/stranded lobby back to a clean 'waiting' state so it can
   * start a fresh match cycle. Called when a new player joins a room that
   * already created its match (joinOrCreate reuse race) or when match creation
   * failed repeatedly. Clears the previous bot roster, re-arms bot-fill, and
   * tears down any in-flight countdown.
   */
  private resetForNewMatch(): void {
    if (this.countdownTimer) {
      this.countdownTimer.clear();
      this.countdownTimer = null;
    }
    for (const bot of this.bots) {
      this.playerManager.removePlayer(bot.id);
    }
    this.bots = [];
    this.botFillStarted = false;
    this.matchCreated = false;
    this.startRetries = 0;
    this.state.status = 'waiting';
    this.state.countdownSeconds = 0;
    this.setMetadata({ status: 'waiting', playerCount: this.state.players.size });
  }

  /**
   * Instantly fills the lobby with bots and starts the 5s countdown.
   * Called when the first human player joins (instead of waiting 90s).
   */
  private startInstantBotFill(): void {
    const humanCount = this.clients.length;
    const botsNeeded = MATCH.MAX_PLAYERS - humanCount;

    if (botsNeeded <= 0) {
      this.beginCountdown();
      return;
    }

    this.playerManager.addSystemMessage('Filling lobby with bots...');

    // Generate bot entries
    for (let i = 0; i < botsNeeded; i++) {
      const botId = `bot-${randomUUID().slice(0, 8)}`;
      const name = BOT_NAMES[i % BOT_NAMES.length] ?? `Bot_${i + 1}`;
      this.bots.push({ id: botId, name });

      // Add bot as a lobby player (no mmr, not connected client)
      const player = this.playerManager.addPlayer(botId, 0);
      this.playerManager.setName(botId, name);
      player.ready = true;
    }

    this.setMetadata({
      playerCount: this.state.players.size,
      hostId: this.state.hostId,
    });

    this.broadcastLobbyState();

    // Start countdown immediately after fill
    this.beginCountdown();
  }

  private checkAfk(): void {
    const afkPlayers = this.playerManager.getAfkPlayers(90000);

    for (const playerId of afkPlayers) {
      const player = this.playerManager.getPlayer(playerId);
      const name = player?.name ?? 'Player';

      const wasHost = playerId === this.state.hostId;
      this.playerManager.removePlayer(playerId);

      if (wasHost) {
        this.playerManager.transferHost(playerId);
      }

      this.setMetadata({
        playerCount: this.state.players.size,
        hostId: this.state.hostId,
      });

      this.playerManager.addSystemMessage(`${name} was removed (AFK)`);
      this.broadcast('playerAfk', { playerId });
      this.broadcastLobbyState();
    }
  }

  private applyMapVoteResult(): void {
    const tally = this.tallyMapVotes();
    if (tally.length === 0) return;
    const winner = tally[0]!;
    this.state.mapId = winner.mapId;
    this.setMetadata({ mapId: winner.mapId });
    this.broadcast('mapChanged', { mapId: winner.mapId });
  }

  private tallyMapVotes(): Array<{ mapId: string; count: number }> {
    const counts = new Map<string, number>();
    for (const mapId of this.mapVotes.values()) {
      counts.set(mapId, (counts.get(mapId) ?? 0) + 1);
    }
    const result: Array<{ mapId: string; count: number }> = [];
    for (const [mapId, count] of counts) {
      result.push({ mapId, count });
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  private broadcastLobbyState(): void {
    this.broadcast('lobby_state', {
      mapId: this.state.mapId,
      mode: this.state.mode,
      status: this.state.status,
      hostId: this.state.hostId,
      players: this.serializePlayers(),
    });
  }

  private broadcastLobbyStateTo(client: Client): void {
    client.send('lobby_state', {
      mapId: this.state.mapId,
      mode: this.state.mode,
      status: this.state.status,
      hostId: this.state.hostId,
      players: this.serializePlayers(),
    });
  }

  private serializePlayers(): Array<{
    sessionId: string;
    name: string;
    color: number;
    ready: boolean;
    isHost: boolean;
  }> {
    const result: Array<{
      sessionId: string;
      name: string;
      color: number;
      ready: boolean;
      isHost: boolean;
    }> = [];
    for (const [id, p] of this.state.players) {
      result.push({
        sessionId: id,
        name: p.name,
        color: p.color,
        ready: p.ready,
        isHost: p.isHost,
      });
    }
    return result;
  }

  onDispose(): void {
    LobbyReconnectionHelper.unregisterResync(this.roomId);
    if (this.countdownTimer) {
      this.countdownTimer.clear();
      this.countdownTimer = null;
    }
    if (this.afkCheckInterval) {
      this.afkCheckInterval.clear();
      this.afkCheckInterval = null;
    }
    if (this.botFillTimer) {
      this.botFillTimer.clear();
      this.botFillTimer = null;
    }
  }
}
