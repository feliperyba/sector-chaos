/**
 * Match lifecycle channel message types.
 *
 * Channels: match_start, match_end, throw, chat
 */

// --- match_start channel ---

export interface MatchPhaseChangedMessage {
  eventType?: 'MatchPhaseChanged';
  from: number;
  to: number;
  tick: number;
}

export interface MatchStartedMessage {
  eventType?: 'MatchStarted';
  mapSeed: number;
  playerCount: number;
  tick: number;
  to?: number;
}

export interface SpectatingTransitionMessage {
  eventType: 'SpectatingTransition';
  playerId: string;
  killerId: string;
  cameraZoomFactor: number;
  cameraZoomDuration: number;
  tick: number;
  to?: number;
}

export type MatchStartChannelMessage =
  | MatchPhaseChangedMessage
  | MatchStartedMessage
  | SpectatingTransitionMessage;

// --- match_end channel ---

export interface PlacementData {
  playerId: string;
  placement: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsCollected: number;
  survivalTimeMs: number;
  weaponsUsed: number;
}

export interface MatchEndMessage {
  type: 'match_end';
  winnerId: string;
  placements: readonly PlacementData[];
  stats: readonly unknown[];
}

// --- throw channel ---

export interface WeaponThrownMessage {
  eventType: 'WeaponThrown';
  playerId: string;
  weaponType: number;
  weaponSlot: number;
  x: number;
  y: number;
  tick: number;
}

// --- chat channel ---

export interface ChatMessageMessage {
  eventType: 'ChatMessage';
  senderId: string;
  text: string;
  tick: number;
}
