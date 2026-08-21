import { NetworkChannel } from '@sector-battle/shared';
import type {
  PlayerDamagedMessage,
  WeaponFiredMessage,
  WeaponBrokenMessage,
  WeaponThrownMessage,
  WeaponShatteredMessage,
  ShieldBlockedMessage,
  WeaponWallHitMessage,
  ProjectileBouncedMessage,
  ProjectileDestroyedMessage,
} from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import type { BroadcastMessage } from './EventMapperHandlers.ts';

export function toDamageMessage(event: GameEvent): BroadcastMessage<PlayerDamagedMessage> | null {
  if (event.type !== 'PlayerDamaged') return null;

  return {
    channel: NetworkChannel.DAMAGE,
    message: {
      eventType: 'PlayerDamaged',
      playerId: event.playerId,
      damage: event.damage,
      sourceId: event.sourceId,
      sourceType: event.sourceType,
      damageType: event.damageType,
      knockbackX: event.knockbackX,
      knockbackY: event.knockbackY,
      killed: event.killed,
      tick: event.tick,
      x: event.x,
      y: event.y,
    },
  };
}

export function toWeaponFiredMessage(
  event: GameEvent,
): BroadcastMessage<WeaponFiredMessage> | null {
  if (event.type !== 'WeaponFired') return null;

  return {
    channel: NetworkChannel.ATTACK,
    message: {
      playerId: event.playerId,
      weaponType: event.weaponType,
      attackType: event.attackType,
      direction: event.direction,
      tick: event.tick,
      x: event.x,
      y: event.y,
    },
  };
}

export function toWeaponBrokenMessage(
  event: GameEvent,
): BroadcastMessage<WeaponBrokenMessage> | null {
  if (event.type !== 'WeaponBroken') return null;

  return {
    channel: NetworkChannel.DAMAGE,
    message: {
      eventType: 'WeaponBroken',
      playerId: event.playerId,
      weaponType: event.weaponType,
      slotIndex: event.slotIndex,
      x: event.x,
      y: event.y,
      tick: event.tick,
    },
  };
}

export function toWeaponThrownMessage(
  event: GameEvent,
): BroadcastMessage<WeaponThrownMessage> | null {
  if (event.type !== 'WeaponThrown') return null;

  return {
    channel: NetworkChannel.THROW,
    message: {
      eventType: 'WeaponThrown',
      playerId: event.playerId,
      weaponType: event.weaponType,
      weaponSlot: event.weaponSlot,
      x: event.x,
      y: event.y,
      tick: event.tick,
    },
  };
}

export function toWeaponShatteredMessage(
  event: GameEvent,
): BroadcastMessage<WeaponShatteredMessage> | null {
  if (event.type !== 'WeaponShattered') return null;

  return {
    channel: NetworkChannel.ATTACK,
    message: {
      eventType: 'WeaponShattered',
      projectileId: event.projectileId,
      weaponType: event.weaponType,
      x: event.x,
      y: event.y,
      tick: event.tick,
    },
  };
}

export function toShieldBlockedMessage(
  event: GameEvent,
): BroadcastMessage<ShieldBlockedMessage> | null {
  if (event.type !== 'ShieldBlocked') return null;

  return {
    channel: NetworkChannel.DAMAGE,
    message: {
      eventType: 'ShieldBlocked',
      playerId: event.playerId,
      damageType: event.damageType,
      sourceId: event.sourceId,
      x: event.x,
      y: event.y,
      tick: event.tick,
      contactX: event.contactX,
      contactY: event.contactY,
      attackerWeaponType: event.attackerWeaponType,
    },
  };
}

export function toWeaponWallHitMessage(
  event: GameEvent,
): BroadcastMessage<WeaponWallHitMessage> | null {
  if (event.type !== 'WeaponWallHit') return null;

  return {
    channel: NetworkChannel.ATTACK,
    message: {
      eventType: 'WeaponWallHit',
      playerId: event.playerId,
      weaponType: event.weaponType,
      x: event.x,
      y: event.y,
      gridX: event.gridX,
      gridY: event.gridY,
      tick: event.tick,
    },
  };
}

export function toProjectileBouncedMessage(
  event: GameEvent,
): BroadcastMessage<ProjectileBouncedMessage> | null {
  if (event.type !== 'ProjectileBounced') return null;

  return {
    channel: NetworkChannel.ATTACK,
    message: {
      projectileId: event.projectileId,
      x: event.x,
      y: event.y,
      remainingBounces: event.remainingBounces,
      tick: event.tick,
    },
  };
}

export function toProjectileDestroyedMessage(
  event: GameEvent,
): BroadcastMessage<ProjectileDestroyedMessage> | null {
  if (event.type !== 'ProjectileDestroyed') return null;

  return {
    channel: NetworkChannel.ATTACK,
    message: {
      projectileId: event.projectileId,
      x: event.x,
      y: event.y,
      hitTile: event.hitTile,
      tileType: event.tileType,
      gridX: event.gridX,
      gridY: event.gridY,
      tick: event.tick,
    },
  };
}
