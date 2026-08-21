import { LobbyState, LobbyPlayer } from './schema/index.ts';

type Result<T = void> = { success: true; value: T } | { success: false; reason: string };

const COLOR_PALETTE_SIZE = 64;
const CHAT_MAX_LENGTH = 200;
const CHAT_RATE_LIMIT_MS = 2000;
const AFK_THRESHOLD_MS = 90000;
const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 20;
const NO_COLOR = 255;

export class LobbyPlayerManager {
  private colorOwnership: Map<number, string> = new Map();
  private chatTimestamps: Map<string, number> = new Map();
  private activityTimestamps: Map<string, number> = new Map();

  constructor(private state: LobbyState) {}

  setName(playerId: string, name: string): Result<string> {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
      return {
        success: false,
        reason: `Name must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} alphanumeric characters or underscores`,
      };
    }

    const player = this.state.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found' };
    }

    const actualName = this.resolveUniqueName(name, playerId);
    player.name = actualName;
    return { success: true, value: actualName };
  }

  setColor(playerId: string, colorIndex: number): Result<number> {
    if (colorIndex < 0 || colorIndex >= COLOR_PALETTE_SIZE) {
      return {
        success: false,
        reason: `Color index must be 0-${COLOR_PALETTE_SIZE - 1}`,
      };
    }

    const currentOwner = this.colorOwnership.get(colorIndex);
    if (currentOwner !== undefined && currentOwner !== playerId) {
      const available = this.getAvailableColors();
      return {
        success: false,
        reason: `Color already taken. Available colors: [${available.join(', ')}]`,
      };
    }

    const player = this.state.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found' };
    }

    this.releaseColor(playerId);

    player.color = colorIndex;
    this.colorOwnership.set(colorIndex, playerId);
    return { success: true, value: colorIndex };
  }

  releaseColor(playerId: string): void {
    for (const [colorIdx, ownerId] of this.colorOwnership) {
      if (ownerId === playerId) {
        this.colorOwnership.delete(colorIdx);
        const player = this.state.players.get(playerId);
        if (player) {
          player.color = NO_COLOR;
        }
        return;
      }
    }
  }

  toggleReady(playerId: string): Result<boolean> {
    const player = this.state.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found' };
    }

    if (this.isDefaultName(player.name)) {
      return { success: false, reason: 'Player must set a custom name before readying up' };
    }

    if (player.color === NO_COLOR || player.color >= COLOR_PALETTE_SIZE) {
      return { success: false, reason: 'Player must select a color before readying up' };
    }

    player.ready = !player.ready;
    return { success: true, value: player.ready };
  }

  allReady(): boolean {
    for (const player of this.state.players.values()) {
      if (player.connected && !player.ready) return false;
    }
    return true;
  }

  getReadyCount(): number {
    let count = 0;
    for (const player of this.state.players.values()) {
      if (player.ready) count++;
    }
    return count;
  }

  assignHost(playerId: string): void {
    const player = this.state.players.get(playerId);
    if (!player) return;

    for (const p of this.state.players.values()) {
      p.isHost = false;
    }

    player.isHost = true;
    this.state.hostId = playerId;
  }

  transferHost(excludeId: string): string | null {
    for (const [id] of this.state.players) {
      if (id !== excludeId) {
        this.assignHost(id);
        return id;
      }
    }
    return null;
  }

  isHost(playerId: string): boolean {
    return this.state.hostId === playerId;
  }

  addChatMessage(playerId: string, text: string): Result<void> {
    if (text.length > CHAT_MAX_LENGTH) {
      return { success: false, reason: `Message exceeds ${CHAT_MAX_LENGTH} characters` };
    }

    const player = this.state.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found' };
    }

    const now = Date.now();
    const lastTimestamp = this.chatTimestamps.get(playerId) ?? 0;
    if (now - lastTimestamp < CHAT_RATE_LIMIT_MS) {
      return { success: false, reason: 'Sending messages too quickly' };
    }

    this.chatTimestamps.set(playerId, now);
    this.state.addChatMessage(`${player.name}: ${text}`);
    return { success: true, value: undefined };
  }

  addSystemMessage(text: string): void {
    this.state.addChatMessage(`[System] ${text}`);
  }

  updateActivity(playerId: string): void {
    this.activityTimestamps.set(playerId, Date.now());
  }

  getAfkPlayers(thresholdMs: number = AFK_THRESHOLD_MS): string[] {
    const now = Date.now();
    const afkIds: string[] = [];

    for (const [playerId, lastActivity] of this.activityTimestamps) {
      if (now - lastActivity > thresholdMs) {
        if (this.state.players.get(playerId) !== undefined) {
          afkIds.push(playerId);
        }
      }
    }

    return afkIds;
  }

  addPlayer(playerId: string, mmr: number = 0): LobbyPlayer {
    const player = new LobbyPlayer();
    player.sessionId = playerId;
    player.color = NO_COLOR;
    player.ready = false;
    player.isHost = false;
    player.mmr = mmr;

    const autoColor = this.findAvailableColor();
    if (autoColor !== null) {
      player.color = autoColor;
      this.colorOwnership.set(autoColor, playerId);
    }

    this.state.players.set(playerId, player);
    this.updateActivity(playerId);

    return player;
  }

  removePlayer(playerId: string): void {
    this.releaseColor(playerId);
    this.state.players.delete(playerId);
    this.chatTimestamps.delete(playerId);
    this.activityTimestamps.delete(playerId);
  }

  getPlayer(playerId: string): LobbyPlayer | undefined {
    return this.state.players.get(playerId);
  }

  private resolveUniqueName(desiredName: string, requesterId: string): string {
    const existingNames = new Set<string>();
    for (const [id, player] of this.state.players) {
      if (id !== requesterId) {
        existingNames.add(player.name);
      }
    }

    if (!existingNames.has(desiredName)) {
      return desiredName;
    }

    let suffix = 2;
    while (existingNames.has(`${desiredName}_${suffix}`)) {
      suffix++;
    }
    return `${desiredName}_${suffix}`;
  }

  private getAvailableColors(): number[] {
    const available: number[] = [];
    for (let i = 0; i < COLOR_PALETTE_SIZE; i++) {
      if (!this.colorOwnership.has(i)) {
        available.push(i);
      }
    }
    return available;
  }

  private findAvailableColor(): number | null {
    for (let i = 0; i < COLOR_PALETTE_SIZE; i++) {
      if (!this.colorOwnership.has(i)) {
        return i;
      }
    }
    return null;
  }

  private isDefaultName(name: string): boolean {
    return /^Player_\d{4}$/.test(name);
  }
}
