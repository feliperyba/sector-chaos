import { MATCH } from '@sector-battle/shared';

export type DisconnectPhase = 1 | 2 | 3;

export interface ReconnectionEvent {
  type: 'PHASE2_ENTER' | 'PHASE3_ENTER' | 'AFK_WARNING' | 'AFK_TAKEOVER';
  playerId: string;
  remainingSeconds?: number;
}

interface DisconnectState {
  phase: DisconnectPhase;
  elapsedMs: number;
}

interface AfkState {
  lastInputTime: number;
  warningSent: boolean;
}

export class InMatchReconnectionManager {
  private disconnects = new Map<string, DisconnectState>();
  private afkTracking = new Map<string, AfkState>();
  private takenOver = new Set<string>();

  onDisconnect(playerId: string): void {
    this.disconnects.set(playerId, { phase: 1, elapsedMs: 0 });
  }

  onReconnect(playerId: string): void {
    this.disconnects.delete(playerId);
  }

  recordInput(playerId: string): void {
    const now = Date.now();
    const existing = this.afkTracking.get(playerId);
    if (existing) {
      existing.lastInputTime = now;
      existing.warningSent = false;
    } else {
      this.afkTracking.set(playerId, { lastInputTime: now, warningSent: false });
    }
  }

  tick(deltaMs: number): ReconnectionEvent[] {
    const events: ReconnectionEvent[] = [];

    this.processDisconnectPhases(deltaMs, events);
    this.processAfk(events);

    return events;
  }

  isDisconnected(playerId: string): boolean {
    return this.disconnects.has(playerId);
  }

  getPhase(playerId: string): DisconnectPhase | null {
    return this.disconnects.get(playerId)?.phase ?? null;
  }

  isTakenOver(playerId: string): boolean {
    return this.takenOver.has(playerId);
  }

  removePlayer(playerId: string): void {
    this.disconnects.delete(playerId);
    this.afkTracking.delete(playerId);
    this.takenOver.delete(playerId);
  }

  private processDisconnectPhases(deltaMs: number, events: ReconnectionEvent[]): void {
    for (const [playerId, state] of this.disconnects) {
      state.elapsedMs += deltaMs;

      if (state.phase === 1 && state.elapsedMs >= MATCH.DISCONNECT_PHASE1_DURATION * 1000) {
        state.phase = 2;
        events.push({ type: 'PHASE2_ENTER', playerId });
      }

      if (state.phase === 2 && state.elapsedMs >= MATCH.DISCONNECT_TOTAL_TO_BOT * 1000) {
        state.phase = 3;
        this.takenOver.add(playerId);
        events.push({ type: 'PHASE3_ENTER', playerId });
      }
    }
  }

  private processAfk(events: ReconnectionEvent[]): void {
    const now = Date.now();
    for (const [playerId, afk] of this.afkTracking) {
      if (this.takenOver.has(playerId)) continue;
      if (this.disconnects.has(playerId)) continue;

      const elapsed = now - afk.lastInputTime;

      if (elapsed >= MATCH.AFK_TIMEOUT * 1000) {
        this.takenOver.add(playerId);
        events.push({ type: 'AFK_TAKEOVER', playerId });
        continue;
      }

      if (elapsed >= MATCH.AFK_WARNING * 1000 && !afk.warningSent) {
        afk.warningSent = true;
        events.push({
          type: 'AFK_WARNING',
          playerId,
          remainingSeconds: MATCH.AFK_TIMEOUT - MATCH.AFK_WARNING,
        });
      }
    }
  }
}
