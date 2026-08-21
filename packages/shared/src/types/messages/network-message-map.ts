/**
 * NetworkMessageMap — maps channel string keys to their payload types.
 *
 * Re-exports all discriminated union types so consumers can import
 * channel unions from a single location if desired.
 *
 * In-match channel keys are linked to the `NetworkChannel` enum member
 * values (ticket #09, Step 5) so the wire-string and the type key stay in
 * lockstep — renaming a channel value updates the map key at compile time.
 * Lobby / matchmaking / unicast channels stay as raw string literals
 * (ticket #07 scope — the enum is not extended to cover them yet).
 */

import { NetworkChannel } from '../../enums/NetworkChannel.js';
import type { MatchCancelledMessage } from '../schema-types.js';
import type { DamageChannelMessage, PlayerEliminatedMessage } from './damage-messages.js';
import type { ZoneUpdateChannelMessage } from './zone-messages.js';
import type { PickupChannelMessage } from './pickup-messages.js';
import type { ExplosionChannelMessage } from './explosion-messages.js';
import type { AttackChannelMessage } from './attack-messages.js';
import type {
  MatchStartChannelMessage,
  MatchEndMessage,
  WeaponThrownMessage,
  ChatMessageMessage,
} from './match-messages.js';
import type {
  AfkWarningMessage,
  ErrorMessage,
  SpectatorFollowTargetMessage,
  ReconnectAsSpectatorMessage,
  MapDataMessage,
  PlayerResyncMessage,
  LobbyStateMessage,
  MatchStartingMessage,
  MatchFoundMessage,
  MatchErrorBroadcastMessage,
  MatchmakingFailedMessage,
  QueuePositionMessage,
  ChatErrorMessage,
} from './lobby-messages.js';

export interface NetworkMessageMap {
  // --- In-match channels (keys linked to NetworkChannel enum values) ---
  [NetworkChannel.KILL_FEED]: PlayerEliminatedMessage;
  [NetworkChannel.DAMAGE]: DamageChannelMessage;
  [NetworkChannel.ZONE_UPDATE]: ZoneUpdateChannelMessage;
  [NetworkChannel.PICKUP]: PickupChannelMessage;
  [NetworkChannel.EXPLOSION]: ExplosionChannelMessage;
  [NetworkChannel.ATTACK]: AttackChannelMessage;
  [NetworkChannel.MATCH_START]: MatchStartChannelMessage;
  [NetworkChannel.MATCH_END]: MatchEndMessage;
  [NetworkChannel.THROW]: WeaponThrownMessage;
  [NetworkChannel.CHAT]: ChatMessageMessage;
  [NetworkChannel.ERROR]: ErrorMessage;
  [NetworkChannel.MATCH_CANCELLED]: MatchCancelledMessage;

  // --- Lobby / matchmaking / unicast channels (raw string keys, #07 scope) ---
  AFKWarning: AfkWarningMessage;
  SpectatorFollowTarget: SpectatorFollowTargetMessage;
  ReconnectAsSpectator: ReconnectAsSpectatorMessage;
  mapData: MapDataMessage;
  playerResync: PlayerResyncMessage;
  lobby_state: LobbyStateMessage;
  matchStarting: MatchStartingMessage;
  matchFound: MatchFoundMessage;
  matchError: MatchErrorBroadcastMessage;
  matchmakingFailed: MatchmakingFailedMessage;
  queuePosition: QueuePositionMessage;
  chatError: ChatErrorMessage;
}
