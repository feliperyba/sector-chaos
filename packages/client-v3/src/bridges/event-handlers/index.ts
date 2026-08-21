import Phaser from 'phaser';
import type {
  AttackChannelMessage,
  DamageChannelMessage,
  PlayerEliminatedMessage,
  ExplosionChannelMessage,
  PickupChannelMessage,
  MatchStartChannelMessage,
  MatchEndMessage,
  WeaponThrownMessage,
  ChatMessageMessage,
  SpectatorFollowTargetMessage,
  ZoneUpdateChannelMessage,
} from '@sector-battle/shared';
import type { EventRouterCallbacks } from '../../network/EventRouter.js';
import type { StateSync } from '../../network/StateSync.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { StatusEffectRenderer } from '../../rendering/StatusEffectRenderer.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { DamageNumberRenderer } from '../../rendering/DamageNumberRenderer.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { AudioService } from '../../audio/AudioService.js';
import type { HUDManager } from '../../hud/HUDManager.js';
import type { ResultsScreen } from '../../hud/ResultsScreen.js';
import type { SpectatorController } from '../../controllers/SpectatorController.js';
import type { AttackEventHandler } from './AttackEventHandler.js';
import type { DamageEventHandler } from './DamageEventHandler.js';
import type { KillFeedEventHandler } from './KillFeedEventHandler.js';
import type { ExplosionEventHandler } from './ExplosionEventHandler.js';
import type { PickupEventHandler } from './PickupEventHandler.js';
import type { ZoneEventHandler } from './ZoneEventHandler.js';
import type { MatchEventHandler } from './MatchEventHandler.js';

import { AttackEventHandler as AttackHandler } from './AttackEventHandler.js';
import { DamageEventHandler as DamageHandler } from './DamageEventHandler.js';
import { KillFeedEventHandler as KillFeedHandler } from './KillFeedEventHandler.js';
import { ExplosionEventHandler as ExplosionHandler } from './ExplosionEventHandler.js';
import { PickupEventHandler as PickupHandler } from './PickupEventHandler.js';
import { ZoneEventHandler as ZoneHandler } from './ZoneEventHandler.js';
import { MatchEventHandler as MatchHandler } from './MatchEventHandler.js';
import type { ExplosionLightRegistry } from '../../rendering/lighting/ExplosionLightRegistry.js';
import type { ImpactLightRegistry } from '../../rendering/lighting/ImpactLightRegistry.js';

export interface EventBridgeDeps {
  myId: { value: string };
  localPos: { x: number; y: number };
  playerRenderer: PlayerRenderer;
  statusEffects: StatusEffectRenderer;
  entityRenderer: EntityRenderer;
  damageNumbers: DamageNumberRenderer;
  mapRenderer: MapRenderer;
  cameraService: CameraService;
  audio: AudioService;
  hud: HUDManager;
  stateSync: StateSync;
  scene: Phaser.Scene;
  playerNames: Map<string, string>;
  resultsScreen: { value: ResultsScreen | null };
  spectator: SpectatorController;
  freezeUntil: { value: number };
  returnToMenu: () => void;
  onLocalKill?: () => void;
  /**
   * Map-redesign ticket 03 (DEC-010) — shows the map designation line at
   * match start (phase-banner area). Accepts null/undefined (the phase event
   * can fire before mapData lands — the controller holds it pending).
   * Optional so non-game callers (tests) keep working.
   */
  showDesignation?: (text: string | null | undefined) => void;
  /**
   * Map-redesign ticket 03 (DEC-001) — resolves a world position to the
   * server-authored POI name for kill-feed location tags. Returns undefined
   * when naming data is absent (demo maps). Pure lookup, no text generation.
   */
  locatePoi?: (x: number, y: number) => string | undefined;
  /** Map designation read-through for the results screen (ticket 03). */
  mapDesignation?: { value: string | null };
  /**
   * Map-redesign ticket 03 — fired when the LOCAL player takes damage; the
   * enter-banner reads the timestamp to suppress itself during combat
   * (banner discipline).
   */
  onLocalDamaged?: () => void;
  /**
   * Optional explosion-light registry (ticket 11). When present, the explosion
   * handler registers a brief hot light on every blast. Optional so non-lighting
   * callers (tests) keep working.
   */
  explosionLights?: ExplosionLightRegistry;
  /**
   * Optional impact-light registry (ticket 09 / A3). When present, the damage
   * handler registers a brief flash on PlayerDamaged (melee hit) / ShieldBlocked
   * / WeaponBroken, and the attack handler registers on ProjectileDestroyed
   * (arrow impact). Optional so non-lighting callers (tests) keep working.
   */
  impactLights?: ImpactLightRegistry;
}

// Re-exported for convenience
export type {
  AttackEventHandler,
  DamageEventHandler,
  KillFeedEventHandler,
  ExplosionEventHandler,
  PickupEventHandler,
  ZoneEventHandler,
  MatchEventHandler,
};

export interface EventHandlers {
  attack: AttackHandler;
  damage: DamageHandler;
  killFeed: KillFeedHandler;
  explosion: ExplosionHandler;
  pickup: PickupHandler;
  zone: ZoneHandler;
  match: MatchHandler;
}

export function createEventHandlers(deps: EventBridgeDeps): EventHandlers {
  return {
    attack: new AttackHandler(
      deps.myId,
      deps.localPos,
      deps.audio,
      deps.entityRenderer,
      deps.mapRenderer,
      deps.playerRenderer,
      deps.cameraService,
      deps.stateSync,
      deps.impactLights,
    ),
    damage: new DamageHandler(
      deps.myId,
      deps.localPos,
      deps.audio,
      deps.cameraService,
      deps.damageNumbers,
      deps.entityRenderer,
      deps.playerRenderer,
      deps.stateSync,
      deps.impactLights,
      deps.onLocalDamaged,
    ),
    killFeed: new KillFeedHandler(
      deps.myId,
      deps.freezeUntil,
      deps.onLocalKill,
      deps.audio,
      deps.cameraService,
      deps.hud,
      deps.playerRenderer,
      deps.statusEffects,
      deps.stateSync,
      deps.locatePoi,
    ),
    explosion: new ExplosionHandler(
      deps.localPos,
      deps.audio,
      deps.cameraService,
      deps.entityRenderer,
      deps.mapRenderer,
      deps.scene,
      deps.explosionLights,
    ),
    pickup: new PickupHandler(
      deps.myId,
      deps.localPos,
      deps.audio,
      deps.cameraService,
      deps.entityRenderer,
      deps.stateSync,
    ),
    zone: new ZoneHandler(
      deps.localPos,
      deps.myId,
      deps.audio,
      deps.cameraService,
      deps.entityRenderer,
      deps.hud,
      deps.scene,
    ),
    match: new MatchHandler(
      deps.myId,
      deps.audio,
      deps.hud,
      deps.stateSync,
      deps.scene,
      deps.playerNames,
      deps.resultsScreen,
      deps.returnToMenu,
      deps.showDesignation,
      deps.mapDesignation,
    ),
  };
}

export function createEventBridge(deps: EventBridgeDeps): EventRouterCallbacks {
  const handlers = createEventHandlers(deps);

  return {
    onAttack: (data: AttackChannelMessage): void => {
      handlers.attack.handle(data);
    },

    onDamage: (data: DamageChannelMessage): void => {
      handlers.damage.handle(data);
    },

    onKillFeed: (data: PlayerEliminatedMessage): void => {
      handlers.killFeed.handle(data);
    },

    onExplosion: (data: ExplosionChannelMessage): void => {
      handlers.explosion.handle(data);
    },

    onPickup: (data: PickupChannelMessage): void => {
      handlers.pickup.handle(data);
    },

    onMatchStart: (data: MatchStartChannelMessage): void => {
      handlers.match.handleMatchStart(data);
    },

    onMatchEnd: (data: MatchEndMessage): void => {
      handlers.match.handleMatchEnd(data);
    },

    onThrow: (data: WeaponThrownMessage): void => {
      // Throw SFX — positional so nearby remote throws are audible.
      // The local thrower is at distance 0 → full volume.
      deps.audio.playAt('hit_melee', data.x, data.y);
      deps.audio.playAt('weapon_drop', data.x, data.y);
      // The weapon has left this player's hand — hide the held sprite now rather
      // than waiting for the next state patch to clear the slot. Closes the 1-RTT
      // window where the per-frame re-arm branch would flash the thrown weapon
      // back onto the hand. (B1 fix)
      deps.playerRenderer.hideWeapon(data.playerId);
    },

    onChat: (_data: ChatMessageMessage): void => {
      // no-op
    },

    onSpectatorFollow: (data: SpectatorFollowTargetMessage): void => {
      if (data?.targetId) {
        deps.spectator.handleSpectatorFollow(data, deps.stateSync);
        deps.hud.setStatusText(`Spectating ${data.targetId.substring(0, 8)}...`, true);
      }
    },

    onZoneUpdate: (data: ZoneUpdateChannelMessage): void => {
      handlers.zone.handle(data);
    },
  };
}
