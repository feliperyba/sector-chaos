/**
 * Lobby, matchmaking, and unicast channel message types.
 *
 * Channels: SpectatorFollowTarget, ReconnectAsSpectator, mapData,
 *           playerResync, AFKWarning, error, lobby_state,
 *           matchStarting, matchFound, matchError,
 *           matchmakingFailed, queuePosition, chatError
 */

import type { TiledMapLayer, TileSpriteAtlas, LightPlacementTiled } from '../../map/tiledTypes.js';
import type { SectorLootTier, SectorType } from '../../map/types.js';
import type { MacroPoiNames } from '../../map/poiNames.js';
import type { LandmarkAssignment } from '../../map/landmarks.js';
import type { VisualIdentityAssignment } from '../../map/visualIdentity.js';

// --- Unicast channels (server → single client) ---

export interface SpectatorFollowTargetMessage {
  targetId: string;
}

export interface ReconnectAsSpectatorMessage {
  reason: 'bot_active' | 'bot_died';
  playerId: string;
  botPlayerId?: string;
}

export interface MapDataMessage {
  grid: number[][];
  width: number;
  height: number;
  tileSize: number;
  seed: number;
  /** Optional enriched visual layers (widened from `unknown` in ticket #09). */
  visualLayers?: TiledMapLayer[];
  /** Optional tile-sprite atlas (widened from `unknown` in ticket #09). */
  atlas?: TileSpriteAtlas;
  /**
   * Deterministic light-prop placements (torches/campfires/etc.). Cosmetic-only.
   * Sent once in this one-shot `mapData` message (NOT per-tick schema — zero
   * ongoing sync cost). See `docs/specs/lighting-system.md` "Wire path".
   */
  lightPlacements?: LightPlacementTiled[];
  /**
   * Seed-authored loot-tier pyramid, one entry per 4x4 sector (map-redesign
   * ticket 02 / DEC-003). Server-authoritative identity data; the client
   * renders the minimap tier tint from it. Absent on demo-TMX maps.
   */
  sectorTiers?: SectorLootTier[][];
  /**
   * Per-match hot sector (one non-central WARM sector upgraded to HOT for
   * this match, rolled from the match seed) — visibly marked on the minimap
   * at match start. Absent on demo-TMX maps.
   */
  hotSector?: { row: number; col: number };
  /**
   * Generated POI display name per sector, one entry per 4x4 sector
   * (map-redesign ticket 03 / DEC-001). Server-authoritative strings — the
   * client renders them (minimap labels, enter-banner, kill-feed location
   * tags) but never generates text. Absent on demo-TMX maps.
   */
  poiNames?: string[][];
  /**
   * Fixed-vocabulary macro-feature display names (present features only;
   * map-redesign ticket 03 / DEC-001). Absent on demo-TMX maps.
   */
  macroPoiNames?: MacroPoiNames;
  /**
   * Map designation, e.g. "RINGROAD • SPIRE • 63" (map-redesign ticket 03 /
   * DEC-010) — shown at match start (phase banner area) and on the results
   * screen. Absent on demo-TMX maps.
   */
  designation?: string;
  /**
   * Hero landmarks + beacons + junction minor landmarks (map-redesign ticket
   * 04 / DEC-002). Server-authoritative: the client bakes the composites
   * into the static layer, draws minimap icons, and reads beacon specs — it
   * never decides landmark identity. The beacon LIGHTS ride the separate
   * `lightPlacements` array (appended by the map enrichment). Absent on
   * demo-TMX maps.
   */
  landmarks?: LandmarkAssignment;
  /**
   * Sector type grid (4×4, map-redesign ticket 07 / DEC-006) — the key the
   * client resolves each district's identity sheet from (wall tint, floor
   * family, gateway frame spec). Server-authoritative; absent on demo-TMX
   * maps (the client falls back to the legacy global wall tint).
   */
  sectorTypes?: SectorType[][];
  /**
   * Visual identity assignment (map-redesign ticket 07 / DEC-006): per-sector
   * floor tint fields (2–3 seeded macro blobs, jittered non-axis borders) +
   * per-connection gateway dressing (lerp band, entering-shot alignment).
   * Server-authoritative; the client BAKES it into the static layers at map
   * load (zero per-frame cost). Absent on demo-TMX maps.
   */
  identity?: VisualIdentityAssignment;
}

export interface PlayerResyncMessage {
  sessionId: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  status: number;
  activeSlot: number;
  inventorySize: number;
}

export interface AfkWarningMessage {
  remainingSeconds: number;
  message: string;
}

export interface ErrorMessage {
  message: string;
}

// --- Lobby & matchmaking channels ---

export interface LobbyStateMessage {
  mapId: string;
  mode: string;
  status: string;
  hostId: string;
  players: ReadonlyArray<{
    sessionId: string;
    name: string;
    color: number;
    ready: boolean;
    isHost: boolean;
  }>;
}

export interface MatchStartingMessage {
  roomId: string;
  seatToken: string;
  mapId: string;
  mode: string;
}

export interface MatchFoundMessage {
  roomId: string;
  seatToken: string;
}

export interface MatchErrorBroadcastMessage {
  message: string;
}

export interface MatchmakingFailedMessage {
  reason: string;
  maxRetries: number;
}

export interface QueuePositionMessage {
  position: number;
  totalQueued: number;
}

export interface ChatErrorMessage {
  reason: string;
}
