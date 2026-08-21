export interface MatchmakingEntry {
  playerId: string;
  mmr: number;
  preferences: MatchPreferences;
  enqueuedAt: number;
  phase: MatchmakingPhase;
}

export interface MatchPreferences {
  mapId?: string;
  mode?: string;
}

export type MatchmakingPhase = 'primary' | 'fallback1' | 'fallback2' | 'timeout';

export interface SeatReservation {
  playerId: string;
  roomId: string;
  seatToken: string;
  expiresAt: number;
}
