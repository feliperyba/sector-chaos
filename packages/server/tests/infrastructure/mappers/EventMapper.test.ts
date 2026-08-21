import { NetworkChannel } from '@sector-battle/shared';
import type { GameEvent } from '../../../src/domain/events/index.ts';
import { EventMapper } from '../../../src/infrastructure/mappers/EventMapperHandlers.ts';
import {
  toKillFeed,
  toZoneUpdate,
  toMatchPhaseMessage,
  toMatchEndMessage,
  toZoneWarningMessage,
  toSpectatingTransitionMessage,
  toSiegeWallDroppedMessage,
  toSiegeWallWarningMessage,
  toChatMessageMessage,
} from '../../../src/infrastructure/mappers/EventMapperGameHandlers.ts';
import {
  toDamageMessage,
  toWeaponFiredMessage,
} from '../../../src/infrastructure/mappers/EventMapperPlayerHandlers.ts';
import {
  toPowerUpMessage,
  toChestOpenedMessage,
  toDestructibleDestroyedMessage,
} from '../../../src/infrastructure/mappers/EventMapperEntityHandlers.ts';

function makeEvent(overrides: Record<string, unknown> & { type: string }): GameEvent {
  return {
    tick: 10,
    timestamp: Date.now(),
    ...overrides,
  } as GameEvent;
}

describe('EventMapper', () => {
  it('maps PlayerEliminated to kill_feed channel', () => {
    const event = makeEvent({
      type: 'PlayerEliminated',
      playerId: 'p1',
      playerName: 'Alice',
      killedBy: 'p2',
      placement: 3,
      weapon: 'dagger',
      x: 100,
      y: 200,
    });
    const msg = toKillFeed(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.KILL_FEED);
    expect(msg!.message).toMatchObject({
      playerId: 'p1',
      playerName: 'Alice',
      killedBy: 'p2',
      placement: 3,
      weapon: 'dagger',
      tick: 10,
    });
  });

  it('toKillFeed returns null for wrong event type', () => {
    const event = makeEvent({ type: 'PlayerDamaged' });
    expect(toKillFeed(event)).toBeNull();
  });

  it('maps PlayerDamaged to damage channel', () => {
    const event = makeEvent({
      type: 'PlayerDamaged',
      playerId: 'p1',
      damage: 30,
      sourceId: 'bomb1',
      sourceType: 1,
      knockbackX: 100,
      knockbackY: 0,
      killed: false,
      x: 50,
      y: 60,
    });
    const msg = toDamageMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.DAMAGE);
    expect(msg!.message).toMatchObject({
      playerId: 'p1',
      damage: 30,
      sourceId: 'bomb1',
      killed: false,
    });
  });

  it('maps ZoneDamage to zone_update channel', () => {
    const event = makeEvent({
      type: 'ZoneDamage',
      playersDamaged: [{ playerId: 'p1', damage: 5 }],
    });
    const msg = toZoneUpdate(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expect(msg!.message.playersDamaged).toEqual([{ playerId: 'p1', damage: 5 }]);
  });

  it('maps MatchPhaseChanged to match_start channel', () => {
    const event = makeEvent({
      type: 'MatchPhaseChanged',
      from: 0,
      to: 1,
    });
    const msg = toMatchPhaseMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.MATCH_START);
    expect(msg!.message).toMatchObject({ from: 0, to: 1 });
  });

  it('maps PowerUpCollected to pickup channel', () => {
    const event = makeEvent({
      type: 'PowerUpCollected',
      playerId: 'p1',
      powerUpId: 'pu1',
      powerUpType: 2,
    });
    const msg = toPowerUpMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.PICKUP);
    expect(msg!.message).toMatchObject({
      playerId: 'p1',
      powerUpId: 'pu1',
      powerUpType: 2,
    });
  });

  it('maps ChestOpened to pickup channel', () => {
    const event = makeEvent({
      type: 'ChestOpened',
      chestId: 'c1',
      playerId: 'p1',
      tier: 1,
      lootContents: { type: 'weapon' },
    });
    const msg = toChestOpenedMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.PICKUP);
    expect(msg!.message).toMatchObject({
      chestId: 'c1',
      playerId: 'p1',
      tier: 1,
    });
  });

  it('maps DestructibleDestroyed to explosion channel', () => {
    const event = makeEvent({
      type: 'DestructibleDestroyed',
      id: 'd1',
      position: { x: 192, y: 256 },
      gridX: 3,
      gridY: 4,
      droppedLoot: { type: 'weapon' },
    });
    const msg = toDestructibleDestroyedMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.EXPLOSION);
    expect(msg!.message).toMatchObject({
      id: 'd1',
      gridX: 3,
      gridY: 4,
      x: 192,
      y: 256,
    });
  });

  it('maps WeaponFired to attack channel', () => {
    const event = makeEvent({
      type: 'WeaponFired',
      playerId: 'p1',
      weaponType: 'dagger',
      direction: 1.57,
      x: 10,
      y: 20,
    });
    const msg = toWeaponFiredMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.ATTACK);
    expect(msg!.message).toMatchObject({
      playerId: 'p1',
      weaponType: 'dagger',
      direction: 1.57,
    });
  });

  it('maps MatchEnded to match_end channel', () => {
    const event = makeEvent({
      type: 'MatchEnded',
      winnerId: 'p1',
      placements: [{ playerId: 'p1', placement: 1 }],
    });
    const msg = toMatchEndMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.MATCH_END);
    expect(msg!.message).toMatchObject({
      winnerId: 'p1',
    });
  });

  it('broadcastEvents maps multiple events to messages', () => {
    const events: GameEvent[] = [
      makeEvent({
        type: 'PlayerDamaged',
        playerId: 'p1',
        damage: 10,
        sourceId: 's1',
        sourceType: 0,
        knockbackX: 0,
        knockbackY: 0,
        killed: false,
        damageType: 0,
        x: 0,
        y: 0,
      }),
      makeEvent({
        type: 'WeaponFired',
        playerId: 'p2',
        weaponType: 'bow',
        attackType: 'arc',
        direction: 0,
        x: 0,
        y: 0,
      }),
    ];
    const messages = EventMapper.broadcastEvents(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].channel).toBe(NetworkChannel.DAMAGE);
    expect(messages[1].channel).toBe(NetworkChannel.ATTACK);
  });

  it('broadcastEvents skips unknown event types', () => {
    const events: GameEvent[] = [
      makeEvent({ type: 'UnknownEvent' }),
      makeEvent({
        type: 'PlayerDamaged',
        playerId: 'p1',
        damage: 10,
        sourceId: 's1',
        sourceType: 0,
        knockbackX: 0,
        knockbackY: 0,
        killed: false,
        damageType: 0,
        x: 0,
        y: 0,
      }),
    ];
    const messages = EventMapper.broadcastEvents(events);
    expect(messages).toHaveLength(1);
  });

  it('maps ZoneWarning to zone_update channel', () => {
    const event = makeEvent({
      type: 'ZoneWarning',
      nextPhaseIndex: 2,
      nextCenterX: 100,
      nextCenterY: 200,
      nextRadius: 50,
      transitionStartsInMs: 5000,
    });
    const msg = toZoneWarningMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expect(msg!.message).toMatchObject({
      eventType: 'ZoneWarning',
      nextPhaseIndex: 2,
      nextCenterX: 100,
      nextCenterY: 200,
      nextRadius: 50,
      transitionStartsInMs: 5000,
    });
  });

  it('toZoneWarningMessage returns null for wrong event type', () => {
    const event = makeEvent({ type: 'ZoneDamage' });
    expect(toZoneWarningMessage(event)).toBeNull();
  });

  it('maps SpectatingTransition to match_start channel', () => {
    const event = makeEvent({
      type: 'SpectatingTransition',
      playerId: 'p1',
      killerId: 'p2',
      cameraZoomFactor: 1.5,
      cameraZoomDuration: 2000,
    });
    const msg = toSpectatingTransitionMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.MATCH_START);
    expect(msg!.message).toMatchObject({
      eventType: 'SpectatingTransition',
      playerId: 'p1',
      killerId: 'p2',
      cameraZoomFactor: 1.5,
      cameraZoomDuration: 2000,
    });
  });

  it('toSpectatingTransitionMessage returns null for wrong event type', () => {
    const event = makeEvent({ type: 'MatchPhaseChanged' });
    expect(toSpectatingTransitionMessage(event)).toBeNull();
  });

  it('maps SiegeWallDropped to zone_update channel', () => {
    const event = makeEvent({
      type: 'SiegeWallDropped',
      gridX: 5,
      gridY: 3,
      sectorRow: 1,
      sectorCol: 2,
      ring: 5,
    });
    const msg = toSiegeWallDroppedMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expect(msg!.message).toMatchObject({
      eventType: 'SiegeWallDropped',
      gridX: 5,
      gridY: 3,
      sectorRow: 1,
      sectorCol: 2,
      ring: 5,
    });
  });

  it('toSiegeWallDroppedMessage returns null for wrong event type', () => {
    const event = makeEvent({ type: 'ZoneDamage' });
    expect(toSiegeWallDroppedMessage(event)).toBeNull();
  });

  it('maps SiegeWallWarning to zone_update channel', () => {
    const event = makeEvent({
      type: 'SiegeWallWarning',
      gridX: 5,
      gridY: 3,
      solidifyAt: 3000,
    });
    const msg = toSiegeWallWarningMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.ZONE_UPDATE);
    expect(msg!.message).toMatchObject({
      eventType: 'SiegeWallWarning',
      gridX: 5,
      gridY: 3,
      solidifyAt: 3000,
    });
  });

  it('toSiegeWallWarningMessage returns null for wrong event type', () => {
    const event = makeEvent({ type: 'ZoneDamage' });
    expect(toSiegeWallWarningMessage(event)).toBeNull();
  });

  it('maps ChatMessage to chat channel', () => {
    const event = makeEvent({
      type: 'ChatMessage',
      senderId: 'SYSTEM',
      text: 'Hello world',
    });
    const msg = toChatMessageMessage(event);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe(NetworkChannel.CHAT);
    expect(msg!.message).toMatchObject({
      eventType: 'ChatMessage',
      senderId: 'SYSTEM',
      text: 'Hello world',
    });
  });

  it('toChatMessageMessage returns null for wrong event type', () => {
    const event = makeEvent({ type: 'PlayerDamaged' });
    expect(toChatMessageMessage(event)).toBeNull();
  });
});
