import { describe, it, expect } from 'vitest';
import { DeathResolutionService } from '../../../src/domain/services/DeathResolutionService.ts';
import type { DeathResolutionContext } from '../../../src/domain/services/DeathResolutionService.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { COMBAT, PlayerStatus } from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';
import type { DomainEvent } from '../../../src/domain/events/DomainEvent.ts';

const DEATH_ANIMATION_TICKS = Math.round(COMBAT.DEATH_ANIMATION_DURATION * 60);

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 96,
    hitboxHeight: 96,
    ...overrides,
  };
}

function createPlayer(id: string, name: string = 'Test'): Player {
  const player = new Player(id, name, new Position(100, 100), createDefaultConfig());
  player.spawnTick = -9999;
  return player;
}

function killPlayer(player: Player, tick: number = 0): void {
  player.takeDamage(100, tick, true);
}

function makeDying(player: Player, deathTick: number): void {
  killPlayer(player, deathTick);
  player.dieWithTick(deathTick);
}

function setupContext(players: Map<string, Player>): {
  ctx: DeathResolutionContext;
  events: DomainEvent[];
} {
  const events: DomainEvent[] = [];
  const ctx: DeathResolutionContext = {
    emitEvent: (e) => {
      events.push(e);
    },
    getPlayerName: (id) => players.get(id)?.name ?? '',
    getAliveCount: () => Array.from(players.values()).filter((p) => p.isActive).length,
    hasPlayer: (id) => players.has(id),
    markPlayerDead: () => {},
  };
  return { ctx, events };
}

describe('DeathResolutionService', () => {
  const service = new DeathResolutionService();

  describe('processDeaths — no deaths', () => {
    it('returns empty results when all players alive', () => {
      const p1 = createPlayer('p1');
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 0, new Set(), ctx);

      expect(result.eliminatedPlayerIds).toEqual([]);
      expect(result.spectatingTransitions).toEqual([]);
    });
  });

  describe('processDeaths — player dies (health.isDead, not yet dying)', () => {
    it('enters DYING state and adds to eliminatedPlayerIds', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      const result = service.processDeaths(players, 50, new Set(), ctx);

      expect(result.eliminatedPlayerIds).toEqual(['p1']);
      expect(p1.isDying()).toBe(true);
      expect(p1.statusEffects.deathTick).toBe(50);
      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
    });
  });

  describe('processDeaths — already eliminated player skipped for kill feed', () => {
    it('enters DYING but no PlayerEliminated event emitted', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      const result = service.processDeaths(players, 50, new Set(['p1']), ctx);

      expect(result.eliminatedPlayerIds).toEqual(['p1']);
      expect(p1.isDying()).toBe(true);
      expect(events).toEqual([]);
    });
  });

  describe('processDeaths — dying player completes after animation (30 ticks)', () => {
    it('transitions to SPECTATING after 30 ticks', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(
        players,
        100 + DEATH_ANIMATION_TICKS + 1,
        new Set(),
        ctx,
      );

      expect(result.spectatingTransitions).toEqual([{ playerId: 'p1', killerId: null }]);
      expect(p1.statusEffects.status).toBe(PlayerStatus.SPECTATING);
    });
  });

  describe('processDeaths — dying player NOT complete before 30 ticks', () => {
    it('no spectating transition at 29 ticks elapsed', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 129, new Set(), ctx);

      expect(result.spectatingTransitions).toEqual([]);
      expect(p1.isDying()).toBe(true);
    });
  });

  describe('processDeaths — dying player completes at exactly 30 ticks', () => {
    it('transitions at exactly 30 ticks elapsed', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 100 + DEATH_ANIMATION_TICKS, new Set(), ctx);

      expect(result.spectatingTransitions).toEqual([{ playerId: 'p1', killerId: null }]);
    });
  });

  describe('processDeaths — kill credit: player killed by another player', () => {
    it('PlayerEliminated has killedBy and killerName resolved', () => {
      const attacker = createPlayer('attacker1', 'Attacker');
      const p1 = createPlayer('p1', 'Victim');
      killPlayer(p1, 0);
      p1.statusEffects.lastDamageSource = {
        playerId: 'attacker1',
        weaponType: 'DAGGER',
        tick: 0,
      };
      const players = new Map([
        ['p1', p1],
        ['attacker1', attacker],
      ]);
      const { ctx, events } = setupContext(players);

      service.processDeaths(players, 50, new Set(), ctx);

      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
      expect(killFeed!.killedBy).toBe('attacker1');
      expect(killFeed!.killerName).toBe('Attacker');
    });
  });

  describe('processDeaths — kill credit: zone kill', () => {
    it('cause resolved to zone', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      p1.statusEffects.lastDamageSource = { playerId: 'zone', weaponType: '', tick: 0 };
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      service.processDeaths(players, 50, new Set(), ctx);

      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
      expect(killFeed!.cause).toBe('zone');
    });
  });

  describe('processDeaths — kill credit: self-kill (thrown weapon)', () => {
    it('cause resolved to self_thrown', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      p1.statusEffects.lastDamageSource = {
        playerId: 'p1',
        weaponType: 'THROWING_AXE',
        tick: 0,
      };
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      service.processDeaths(players, 50, new Set(), ctx);

      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
      expect(killFeed!.cause).toBe('self_thrown');
    });
  });

  describe('processDeaths — kill credit: trap damage (attacker not in game)', () => {
    it('cause resolved to trap_damage', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      p1.statusEffects.lastDamageSource = {
        playerId: 'trap_entity',
        weaponType: '',
        tick: 0,
      };
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      service.processDeaths(players, 50, new Set(), ctx);

      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
      expect(killFeed!.cause).toBe('trap_damage');
    });
  });

  describe('processDeaths — kill credit: unknown (no damage source)', () => {
    it('cause resolved to unknown', () => {
      const p1 = createPlayer('p1');
      killPlayer(p1, 0);
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);

      service.processDeaths(players, 50, new Set(), ctx);

      const killFeed = events.find((e) => e.type === 'PlayerEliminated');
      expect(killFeed).toBeDefined();
      expect(killFeed!.cause).toBe('unknown');
    });
  });

  describe('processDeaths — follow target: killer is another player', () => {
    it('returns killer player ID', () => {
      const attacker = createPlayer('attacker1', 'Attacker');
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      p1.statusEffects.lastDamageSource = {
        playerId: 'attacker1',
        weaponType: 'SWORD',
        tick: 99,
      };
      const players = new Map([
        ['p1', p1],
        ['attacker1', attacker],
      ]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 100 + DEATH_ANIMATION_TICKS, new Set(), ctx);

      expect(result.spectatingTransitions).toEqual([{ playerId: 'p1', killerId: 'attacker1' }]);
    });
  });

  describe('processDeaths — follow target: self-kill', () => {
    it('returns null when killer is self', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      p1.statusEffects.lastDamageSource = {
        playerId: 'p1',
        weaponType: 'THROWING_AXE',
        tick: 99,
      };
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 100 + DEATH_ANIMATION_TICKS, new Set(), ctx);

      expect(result.spectatingTransitions).toEqual([{ playerId: 'p1', killerId: null }]);
    });
  });

  describe('processDeaths — follow target: killer not in game', () => {
    it('returns null when killer not in player map', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 100);
      p1.statusEffects.lastDamageSource = {
        playerId: 'disconnected_player',
        weaponType: 'SWORD',
        tick: 99,
      };
      const players = new Map([['p1', p1]]);
      const { ctx } = setupContext(players);

      const result = service.processDeaths(players, 100 + DEATH_ANIMATION_TICKS, new Set(), ctx);

      expect(result.spectatingTransitions).toEqual([{ playerId: 'p1', killerId: null }]);
    });
  });

  describe('processDeaths — SpectatingTransition event emitted', () => {
    it('emits event with correct fields', () => {
      const p1 = createPlayer('p1');
      makeDying(p1, 200);
      const players = new Map([['p1', p1]]);
      const { ctx, events } = setupContext(players);
      const tick = 200 + DEATH_ANIMATION_TICKS;

      service.processDeaths(players, tick, new Set(), ctx);

      const stEvent = events.find((e) => e.type === 'SpectatingTransition');
      expect(stEvent).toBeDefined();
      expect(stEvent!.playerId).toBe('p1');
      expect(stEvent!.killerId).toBeNull();
      expect(stEvent!.cameraZoomFactor).toBe(COMBAT.DEATH_CAMERA_ZOOM_FACTOR);
      expect(stEvent!.cameraZoomDuration).toBe(COMBAT.DEATH_CAMERA_ZOOM);
      expect(stEvent!.tick).toBe(tick);
      expect(typeof stEvent!.timestamp).toBe('number');
    });
  });

  describe('processDeaths — multiple simultaneous deaths', () => {
    it('both players in eliminatedPlayerIds with separate events', () => {
      const p1 = createPlayer('p1', 'Player1');
      const p2 = createPlayer('p2', 'Player2');
      killPlayer(p1, 0);
      killPlayer(p2, 0);
      p1.statusEffects.lastDamageSource = {
        playerId: 'p2',
        weaponType: 'SWORD',
        tick: 0,
      };
      p2.statusEffects.lastDamageSource = {
        playerId: 'p1',
        weaponType: 'DAGGER',
        tick: 0,
      };
      const players = new Map([
        ['p1', p1],
        ['p2', p2],
      ]);
      const { ctx, events } = setupContext(players);

      const result = service.processDeaths(players, 50, new Set(), ctx);

      expect(result.eliminatedPlayerIds).toContain('p1');
      expect(result.eliminatedPlayerIds).toContain('p2');
      expect(result.eliminatedPlayerIds.length).toBe(2);
      const killFeeds = events.filter((e) => e.type === 'PlayerEliminated');
      expect(killFeeds.length).toBe(2);
    });
  });
});
