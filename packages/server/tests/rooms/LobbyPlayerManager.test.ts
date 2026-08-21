import { describe, it, expect, beforeEach } from 'vitest';
import { LobbyPlayerManager } from '../../src/room/LobbyPlayerManager.ts';
import { LobbyState } from '../../src/room/schema/LobbyState.ts';

describe('LobbyPlayerManager', () => {
  let state: LobbyState;
  let manager: LobbyPlayerManager;

  beforeEach(() => {
    state = new LobbyState();
    manager = new LobbyPlayerManager(state);
  });

  describe('addPlayer', () => {
    it('creates player with default name', () => {
      const player = manager.addPlayer('p1');

      expect(player).toBeDefined();
      expect(player.sessionId).toBe('p1');
      expect(player.name).toMatch(/^Player_\d{4}$/);
      expect(player.color).toBe(0);
      expect(player.ready).toBe(false);
      expect(player.isHost).toBe(false);
      expect(player.mmr).toBe(0);
      expect(state.players.get('p1')).toBe(player);
    });

    it('creates player with custom mmr', () => {
      const player = manager.addPlayer('p1', 1500);
      expect(player.mmr).toBe(1500);
    });

    it('assigns next available color automatically', () => {
      manager.addPlayer('p1');
      const p2 = manager.addPlayer('p2');
      expect(p2.color).toBe(1);
    });
  });

  describe('setName', () => {
    beforeEach(() => {
      manager.addPlayer('p1');
    });

    it('valid name set successfully', () => {
      const result = manager.setName('p1', 'CoolPlayer');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe('CoolPlayer');
      }
      expect(state.players.get('p1')!.name).toBe('CoolPlayer');
    });

    it('rejected when name too short', () => {
      const result = manager.setName('p1', 'ab');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('3');
      }
    });

    it('rejected when name has special characters', () => {
      const result = manager.setName('p1', 'bad name!');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('alphanumeric');
      }
    });

    it('rejected when name too long', () => {
      const result = manager.setName('p1', 'a'.repeat(21));
      expect(result.success).toBe(false);
    });

    it('appends suffix on duplicate name', () => {
      manager.addPlayer('p2');
      manager.setName('p2', 'CoolPlayer');

      const result = manager.setName('p1', 'CoolPlayer');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe('CoolPlayer_2');
      }
    });

    it('returns failure for unknown player', () => {
      const result = manager.setName('unknown', 'TestName');
      expect(result.success).toBe(false);
    });
  });

  describe('setColor', () => {
    beforeEach(() => {
      manager.addPlayer('p1');
    });

    it('color assigned successfully when available', () => {
      const result = manager.setColor('p1', 5);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(5);
      }
      expect(state.players.get('p1')!.color).toBe(5);
    });

    it('rejected when color already taken', () => {
      manager.addPlayer('p2');
      manager.setColor('p2', 3);

      const result = manager.setColor('p1', 3);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('already taken');
      }
    });

    it('rejected when color index out of range', () => {
      const result = manager.setColor('p1', -1);
      expect(result.success).toBe(false);
    });

    it('rejected when color index too high', () => {
      const result = manager.setColor('p1', 64);
      expect(result.success).toBe(false);
    });

    it('releases previous color when setting new one', () => {
      manager.setColor('p1', 2);
      manager.setColor('p1', 5);

      manager.addPlayer('p2');
      const result = manager.setColor('p2', 2);
      expect(result.success).toBe(true);
    });
  });

  describe('releaseColor', () => {
    it('frees color for reuse', () => {
      manager.addPlayer('p1');
      manager.setColor('p1', 5);

      manager.releaseColor('p1');

      expect(state.players.get('p1')!.color).toBe(255);

      manager.addPlayer('p2');
      const result = manager.setColor('p2', 5);
      expect(result.success).toBe(true);
    });
  });

  describe('toggleReady', () => {
    it('blocked without custom name', () => {
      manager.addPlayer('p1');
      manager.setColor('p1', 0);

      const result = manager.toggleReady('p1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('name');
      }
    });

    it('blocked without color', () => {
      manager.addPlayer('p1');
      manager.setName('p1', 'TestPlayer');
      state.players.get('p1')!.color = 255;

      const result = manager.toggleReady('p1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('color');
      }
    });

    it('toggles ready successfully', () => {
      manager.addPlayer('p1');
      manager.setName('p1', 'TestPlayer');
      manager.setColor('p1', 0);

      const result1 = manager.toggleReady('p1');
      expect(result1.success).toBe(true);
      if (result1.success) {
        expect(result1.value).toBe(true);
      }

      const result2 = manager.toggleReady('p1');
      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.value).toBe(false);
      }
    });
  });

  describe('allReady', () => {
    it('returns false when not all ready', () => {
      manager.addPlayer('p1');
      manager.addPlayer('p2');
      manager.setName('p1', 'PlayerA');
      manager.setName('p2', 'PlayerB');
      manager.setColor('p1', 0);
      manager.setColor('p2', 1);

      manager.toggleReady('p1');
      expect(manager.allReady()).toBe(false);
    });

    it('returns true when all ready', () => {
      manager.addPlayer('p1');
      manager.addPlayer('p2');
      manager.setName('p1', 'PlayerA');
      manager.setName('p2', 'PlayerB');
      manager.setColor('p1', 0);
      manager.setColor('p2', 1);

      manager.toggleReady('p1');
      manager.toggleReady('p2');
      expect(manager.allReady()).toBe(true);
    });

    it('returns true with zero players', () => {
      expect(manager.allReady()).toBe(true);
    });
  });

  describe('assignHost', () => {
    it('sets host on player', () => {
      manager.addPlayer('p1');
      manager.assignHost('p1');

      expect(state.players.get('p1')!.isHost).toBe(true);
      expect(state.hostId).toBe('p1');
    });

    it('removes host from previous player', () => {
      manager.addPlayer('p1');
      manager.addPlayer('p2');
      manager.assignHost('p1');
      manager.assignHost('p2');

      expect(state.players.get('p1')!.isHost).toBe(false);
      expect(state.players.get('p2')!.isHost).toBe(true);
      expect(state.hostId).toBe('p2');
    });
  });

  describe('transferHost', () => {
    it('transfers host to another player', () => {
      manager.addPlayer('p1');
      manager.addPlayer('p2');
      manager.assignHost('p1');

      const newHost = manager.transferHost('p1');
      expect(newHost).toBe('p2');
      expect(state.players.get('p2')!.isHost).toBe(true);
      expect(state.hostId).toBe('p2');
    });

    it('returns null when no other players', () => {
      manager.addPlayer('p1');
      manager.assignHost('p1');

      const result = manager.transferHost('p1');
      expect(result).toBeNull();
    });
  });

  describe('addChatMessage', () => {
    beforeEach(() => {
      manager.addPlayer('p1');
      manager.setName('p1', 'Chatter');
    });

    it('adds message to state', () => {
      const result = manager.addChatMessage('p1', 'Hello world');
      expect(result.success).toBe(true);
      expect(state.chatMessages.length).toBe(1);
      expect(state.chatMessages.at(0)).toContain('Chatter: Hello world');
    });

    it('rate limited - rejects rapid messages', () => {
      const result1 = manager.addChatMessage('p1', 'msg1');
      const result2 = manager.addChatMessage('p1', 'msg2');
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.reason).toContain('too quickly');
      }
    });

    it('rejects message exceeding max length', () => {
      const result = manager.addChatMessage('p1', 'a'.repeat(201));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toContain('200');
      }
    });
  });

  describe('getAfkPlayers', () => {
    it('returns inactive players', () => {
      const originalNow = Date.now;
      let currentTime = 100000;
      Date.now = () => currentTime;

      try {
        manager.addPlayer('p1');
        manager.addPlayer('p2');

        currentTime += 100000;

        manager.updateActivity('p1');

        const afk = manager.getAfkPlayers(90000);
        expect(afk).toContain('p2');
        expect(afk).not.toContain('p1');
      } finally {
        Date.now = originalNow;
      }
    });

    it('returns empty array when all active', () => {
      manager.addPlayer('p1');
      manager.updateActivity('p1');

      const afk = manager.getAfkPlayers(90000);
      expect(afk).toEqual([]);
    });
  });

  describe('removePlayer', () => {
    it('removes player from state and cleans up', () => {
      manager.addPlayer('p1');
      manager.setColor('p1', 3);
      manager.removePlayer('p1');

      expect(state.players.get('p1')).toBeUndefined();

      manager.addPlayer('p2');
      const result = manager.setColor('p2', 3);
      expect(result.success).toBe(true);
    });
  });

  describe('isHost', () => {
    it('returns true for host player', () => {
      manager.addPlayer('p1');
      manager.assignHost('p1');
      expect(manager.isHost('p1')).toBe(true);
    });

    it('returns false for non-host player', () => {
      manager.addPlayer('p1');
      expect(manager.isHost('p1')).toBe(false);
    });
  });

  describe('getPlayer', () => {
    it('returns player if exists', () => {
      manager.addPlayer('p1');
      const player = manager.getPlayer('p1');
      expect(player).toBeDefined();
      expect(player!.sessionId).toBe('p1');
    });

    it('returns undefined if not found', () => {
      expect(manager.getPlayer('unknown')).toBeUndefined();
    });
  });
});
