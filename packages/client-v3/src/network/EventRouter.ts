import { NetworkChannel } from '@sector-battle/shared';
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

export interface EventRouterCallbacks {
  onAttack: (data: AttackChannelMessage) => void;
  onDamage: (data: DamageChannelMessage) => void;
  onKillFeed: (data: PlayerEliminatedMessage) => void;
  onExplosion: (data: ExplosionChannelMessage) => void;
  onPickup: (data: PickupChannelMessage) => void;
  onMatchStart: (data: MatchStartChannelMessage) => void;
  onMatchEnd: (data: MatchEndMessage) => void;
  onThrow: (data: WeaponThrownMessage) => void;
  onChat: (data: ChatMessageMessage) => void;
  onSpectatorFollow: (data: SpectatorFollowTargetMessage) => void;
  onZoneUpdate: (data: ZoneUpdateChannelMessage) => void;
}

export class EventRouter {
  private callbacks: EventRouterCallbacks;

  constructor(callbacks: EventRouterCallbacks) {
    this.callbacks = callbacks;
  }

  register(connection: {
    onMessage<T = unknown>(channel: string, cb: (data: T) => void): void;
  }): void {
    connection.onMessage(NetworkChannel.ATTACK, (data: AttackChannelMessage) => {
      this.callbacks.onAttack(data);
    });
    connection.onMessage(NetworkChannel.DAMAGE, (data: DamageChannelMessage) => {
      this.callbacks.onDamage(data);
    });
    connection.onMessage(NetworkChannel.KILL_FEED, (data: PlayerEliminatedMessage) => {
      this.callbacks.onKillFeed(data);
    });
    connection.onMessage(NetworkChannel.EXPLOSION, (data: ExplosionChannelMessage) => {
      this.callbacks.onExplosion(data);
    });
    connection.onMessage(NetworkChannel.PICKUP, (data: PickupChannelMessage) => {
      this.callbacks.onPickup(data);
    });
    connection.onMessage(NetworkChannel.MATCH_START, (data: MatchStartChannelMessage) => {
      this.callbacks.onMatchStart(data);
    });
    connection.onMessage(NetworkChannel.MATCH_END, (data: MatchEndMessage) => {
      this.callbacks.onMatchEnd(data);
    });
    connection.onMessage(NetworkChannel.THROW, (data: WeaponThrownMessage) => {
      this.callbacks.onThrow(data);
    });
    connection.onMessage(NetworkChannel.CHAT, (data: ChatMessageMessage) => {
      this.callbacks.onChat(data);
    });
    connection.onMessage(NetworkChannel.ZONE_UPDATE, (data: ZoneUpdateChannelMessage) => {
      this.callbacks.onZoneUpdate(data);
    });
    connection.onMessage(
      NetworkChannel.SPECTATOR_FOLLOW_TARGET,
      (data: SpectatorFollowTargetMessage) => {
        this.callbacks.onSpectatorFollow(data);
      },
    );
  }
}
