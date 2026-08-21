import { describe, it, expect } from 'vitest';
import {
  StateMapper,
  type MatchMeta,
  type MatchState,
  type AnimWireFields,
} from '../../../src/infrastructure/mappers/StateMapper.ts';
import {
  Player,
  Projectile,
  PowerUp,
  Trap,
  Chest,
  Destructible,
  Exit,
  Explosion,
} from '../../../src/domain/entities/index.ts';
import { Position, GridCoord } from '../../../src/domain/value-objects/index.ts';
import { PlayerSchema, GameStateSchema } from '../../../src/infrastructure/schemas/index.ts';
import {
  PlayerStatus,
  WeaponTier,
  TrapType,
  ChestRarity,
  WeaponType,
  MatchPhase,
} from '@sector-battle/shared';
import type { ZoneState } from '@sector-battle/shared';

const DEFAULT_PLAYER_CONFIG = {
  baseHealth: 100,
  maxHealth: 100,
  baseSpeed: 200,
  dashSpeedMultiplier: 1.3,
  dashDuration: 10,
  dashCooldown: 120,
  inventorySize: 4,
  hitboxWidth: 28,
  hitboxHeight: 28,
};

const DEFAULT_ZONE: ZoneState = {
  currentPhase: 0,
  centerX: 25,
  centerY: 25,
  targetCenterX: 25,
  targetCenterY: 25,
  isTransitioningCenter: false,
  currentRadius: 50,
  targetRadius: 40,
  shrinkSpeed: 0.5,
  damagePerTick: 1,
  nextShrinkTick: 100,
  phaseStartTime: 0,
  phaseEndTime: 0,
};

const TEST_META: MatchMeta = {
  matchId: 'test-match',
  mapSeed: 42,
  mapWidth: 50,
  mapHeight: 50,
};

/** Zero-state AnimWireFields fixture for tests that don't exercise animation. */
const ZERO_ANIM: AnimWireFields = { phase: 0, phaseStartTick: 0, comboIndex: 0 };

function createEmptyState(overrides?: Partial<MatchState>): MatchState {
  return {
    players: new Map(),
    projectiles: new Map(),
    powerUps: new Map(),
    traps: new Map(),
    chests: new Map(),
    destructibles: new Map(),
    exits: new Map(),
    explosions: new Map(),
    weaponPickups: new Map(),
    destructibleVersion: 0,
    exitVersion: 0,
    tick: 0,
    phase: MatchPhase.WAITING,
    zone: { ...DEFAULT_ZONE },
    lastProcessedInput: 0,
    eliminations: [],
    siegedSectors: [],
    mapSiegeProgress: { northOffset: 0, eastOffset: 0, southOffset: 0, westOffset: 0 },
    ...overrides,
  };
}

function mapFreshState(state: MatchState, meta: MatchMeta): GameStateSchema {
  const schema = new GameStateSchema();
  // No PlayerAnimationSystem in these unit tests — pass a resolver that always
  // returns undefined so `mapDelta` exercises its zero-state fallback path
  // (the projection must still emit phase=0 / phaseStartTick=0 / comboIndex=0).
  StateMapper.mapDelta(state, schema, meta, () => undefined);
  return schema;
}

describe('StateMapper', () => {
  describe('playerToSchema', () => {
    it('maps all player fields to schema', () => {
      const player = new Player('p1', 'TestPlayer', new Position(100, 200), DEFAULT_PLAYER_CONFIG);
      const schema = new PlayerSchema();
      StateMapper.playerToSchema(player, schema, ZERO_ANIM);

      expect(schema.id).toBe('p1');
      expect(schema.name).toBe('TestPlayer');
      expect(schema.x).toBe(100);
      expect(schema.y).toBe(200);
      expect(schema.direction).toBe(0);
      expect(schema.speed).toBe(200);
      expect(schema.health).toBe(100);
      expect(schema.maxHealth).toBe(100);
      expect(schema.status & PlayerStatus.INVINCIBLE).toBeTruthy();
    });

    it('maps player after damage', () => {
      const player = new Player('p1', 'Hurt', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      player.spawnTick = -9999;
      player.takeDamage(40, 10);
      const schema = new PlayerSchema();
      StateMapper.playerToSchema(player, schema, ZERO_ANIM);

      expect(schema.health).toBe(60);
      expect(schema.lastDamageTick).toBe(10);
      expect(schema.status & PlayerStatus.ALIVE).toBeTruthy();
    });

    it('maps dead player', () => {
      const player = new Player('p1', 'Dead', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      player.spawnTick = -9999;
      player.takeDamage(100, 5);
      player.die();
      const schema = new PlayerSchema();
      StateMapper.playerToSchema(player, schema, ZERO_ANIM);

      expect(schema.health).toBe(0);
      expect(schema.status & PlayerStatus.SPECTATING).toBeTruthy();
    });

    // Characterization for #10a — pins the 3 animation wire fields
    // (animPhase / animPhaseStartTick / comboIndex) sourced from
    // PlayerAnimationSystem's AnimSimState via the required `animState`
    // projection param. The wire values MUST stay identical across the
    // refactor.
    it('projects animPhase/animPhaseStartTick/comboIndex onto the schema', () => {
      const player = new Player('p1', 'Anim', new Position(0, 0), DEFAULT_PLAYER_CONFIG);
      const animState: AnimWireFields = {
        phase: 4,
        phaseStartTick: 123,
        comboIndex: 200,
      };
      const schema = new PlayerSchema();
      StateMapper.playerToSchema(player, schema, animState);

      expect(schema.animPhase).toBe(4);
      expect(schema.animPhaseStartTick).toBe(123);
      expect(schema.comboIndex).toBe(200);
    });

    // #10a projection path: the 3 wire fields come from animState (the
    // authoritative PlayerAnimationSystem source), and comboIndex is masked
    // to uint8 — matching the legacy mirror write (`state.comboIndex & 0xff`).
    it('masks comboIndex to uint8 when sourcing the 3 anim wire fields from animState', () => {
      const player = new Player('p1', 'Anim', new Position(0, 0), DEFAULT_PLAYER_CONFIG);

      const animState: AnimWireFields = {
        phase: 6,
        phaseStartTick: 999,
        comboIndex: 0x1ff, // masked to 0xff (255) on the wire
      };
      const schema = new PlayerSchema();
      StateMapper.playerToSchema(player, schema, animState);

      expect(schema.animPhase).toBe(6);
      expect(schema.animPhaseStartTick).toBe(999);
      expect(schema.comboIndex).toBe(255);
    });
  });

  describe('mapFullState', () => {
    it('creates complete GameStateSchema from match state', () => {
      const player = new Player('p1', 'Player1', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      const state = createEmptyState({
        players: new Map([['p1', player]]),
        tick: 10,
        phase: MatchPhase.ACTIVE,
      });

      const schema = mapFreshState(state, TEST_META);

      expect(schema.matchId).toBe('test-match');
      expect(schema.mapSeed).toBe(42);
      expect(schema.mapWidth).toBe(50);
      expect(schema.mapHeight).toBe(50);
      expect(schema.tick).toBe(10);
      expect(schema.phase).toBe(MatchPhase.ACTIVE);
      expect(schema.playersAlive).toBe(1);
      expect(schema.players.get('p1')).toBeDefined();
      expect(schema.players.get('p1')!.name).toBe('Player1');
      expect(schema.zone.currentRadius).toBe(50);
      expect(schema.zone.targetRadius).toBe(40);
    });

    it('handles empty collections', () => {
      const state = createEmptyState();
      const schema = mapFreshState(state, TEST_META);

      expect(schema.playersAlive).toBe(0);
      expect(schema.players.size).toBe(0);
      expect(schema.projectiles.size).toBe(0);
      expect(schema.powerUps.size).toBe(0);
      expect(schema.traps.size).toBe(0);
      expect(schema.chests.size).toBe(0);
      expect(schema.destructibles.size).toBe(0);
      expect(schema.exits.size).toBe(0);
      expect(schema.explosions.size).toBe(0);
    });

    it('counts only ALIVE players for playersAlive', () => {
      const alive = new Player('p1', 'Alive', new Position(0, 0), DEFAULT_PLAYER_CONFIG);
      const dead = new Player('p2', 'Dead', new Position(0, 0), DEFAULT_PLAYER_CONFIG);
      dead.spawnTick = -9999;
      dead.takeDamage(100, 1);
      dead.die();

      const state = createEmptyState({
        players: new Map([
          ['p1', alive],
          ['p2', dead],
        ]),
      });
      const schema = mapFreshState(state, TEST_META);

      expect(schema.playersAlive).toBe(1);
      expect(schema.players.size).toBe(2);
    });

    it('maps all entity types', () => {
      const player = new Player('p1', 'Player', new Position(0, 0), DEFAULT_PLAYER_CONFIG);
      const projectile = new Projectile(
        'pr1',
        'p1',
        new Position(10, 10),
        100,
        0,
        25,
        3,
        WeaponType.THROWING_AXE,
        20,
        800,
      );
      const powerUp = PowerUp.create('pu1', 'speed_boost', new Position(64, 64), 0);
      const trap = Trap.create('t1', TrapType.SPIKE, new Position(96, 96));
      const chest = Chest.create('c1', ChestRarity.RARE, new Position(128, 128));
      const destructible = Destructible.create('d1', 'crate', new Position(160, 160));
      const exit = new Exit('e1', new Position(192, 192), new GridCoord(6, 6), 0);
      const explosion = new Explosion('x1', 'p1', new Position(32, 32), 20, 1);

      const state = createEmptyState({
        players: new Map([['p1', player]]),
        projectiles: new Map([['pr1', projectile]]),
        powerUps: new Map([['pu1', powerUp]]),
        traps: new Map([['t1', trap]]),
        chests: new Map([['c1', chest]]),
        destructibles: new Map([['d1', destructible]]),
        exits: new Map([['e1', exit]]),
        explosions: new Map([['x1', explosion]]),
      });

      const schema = mapFreshState(state, TEST_META);

      expect(schema.players.size).toBe(1);
      expect(schema.projectiles.size).toBe(1);
      expect(schema.projectiles.get('pr1')!.velocityX).toBe(100);
      expect(schema.powerUps.size).toBe(1);
      expect(schema.powerUps.get('pu1')!.type).toBe(2);
      expect(schema.traps.size).toBe(1);
      expect(schema.traps.get('t1')!.type).toBe(TrapType.SPIKE);
      expect(schema.chests.size).toBe(1);
      expect(schema.chests.get('c1')!.tier).toBe(1);
      expect(schema.destructibles.size).toBe(1);
      expect(schema.destructibles.get('d1')!.hp).toBe(2);
      expect(schema.exits.size).toBe(1);
      expect(schema.exits.get('e1')!.sectorIndex).toBe(0);
      expect(schema.explosions.size).toBe(1);
      expect(schema.explosions.get('x1')!.damage).toBe(20);
    });
  });

  describe('mapDelta', () => {
    it('updates existing player position in schema', () => {
      const player = new Player('p1', 'Player1', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      const state = createEmptyState({
        players: new Map([['p1', player]]),
      });
      const schema = mapFreshState(state, TEST_META);

      expect(schema.players.get('p1')!.x).toBe(50);
      expect(schema.players.get('p1')!.y).toBe(50);

      player.movement.position = new Position(200, 300);
      state.tick = 5;
      StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

      expect(schema.players.get('p1')!.x).toBe(200);
      expect(schema.players.get('p1')!.y).toBe(300);
      expect(schema.tick).toBe(5);
    });

    it('adds new player to schema', () => {
      const player1 = new Player('p1', 'Player1', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      const state = createEmptyState({
        players: new Map([['p1', player1]]),
      });
      const schema = mapFreshState(state, TEST_META);
      expect(schema.players.size).toBe(1);

      const player2 = new Player('p2', 'Player2', new Position(100, 100), DEFAULT_PLAYER_CONFIG);
      state.players.set('p2', player2);
      StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

      expect(schema.players.size).toBe(2);
      expect(schema.players.get('p2')).toBeDefined();
      expect(schema.players.get('p2')!.name).toBe('Player2');
      expect(schema.players.get('p2')!.x).toBe(100);
      expect(schema.playersAlive).toBe(2);
    });

    it('removes player not in domain state', () => {
      const player1 = new Player('p1', 'Player1', new Position(50, 50), DEFAULT_PLAYER_CONFIG);
      const player2 = new Player('p2', 'Player2', new Position(100, 100), DEFAULT_PLAYER_CONFIG);
      const state = createEmptyState({
        players: new Map([
          ['p1', player1],
          ['p2', player2],
        ]),
      });
      const schema = mapFreshState(state, TEST_META);
      expect(schema.players.size).toBe(2);

      state.players.delete('p2');
      StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

      expect(schema.players.size).toBe(1);
      expect(schema.players.get('p1')).toBeDefined();
      expect(schema.players.get('p2')).toBeUndefined();
      expect(schema.playersAlive).toBe(1);
    });

    it('updates scalar fields (tick, phase, playersAlive)', () => {
      const player = new Player('p1', 'P1', new Position(0, 0), DEFAULT_PLAYER_CONFIG);
      player.spawnTick = -9999;
      const state = createEmptyState({
        players: new Map([['p1', player]]),
      });
      const schema = mapFreshState(state, TEST_META);

      expect(schema.tick).toBe(0);
      expect(schema.phase).toBe(MatchPhase.WAITING);
      expect(schema.playersAlive).toBe(1);

      state.tick = 100;
      state.phase = MatchPhase.ACTIVE;
      player.takeDamage(100, 50);
      player.die();
      StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

      expect(schema.tick).toBe(100);
      expect(schema.phase).toBe(MatchPhase.ACTIVE);
      expect(schema.playersAlive).toBe(0);
      expect(schema.players.get('p1')!.status & PlayerStatus.SPECTATING).toBeTruthy();
    });

    it('syncs zone state changes', () => {
      const state = createEmptyState();
      const schema = mapFreshState(state, TEST_META);

      expect(schema.zone.currentRadius).toBe(50);

      state.zone = {
        ...DEFAULT_ZONE,
        currentPhase: 1,
        currentRadius: 30,
        targetRadius: 20,
        shrinkSpeed: 1.0,
      };
      StateMapper.mapDelta(state, schema, TEST_META, () => undefined);

      expect(schema.zone.phase).toBe(1);
      expect(schema.zone.currentRadius).toBe(30);
      expect(schema.zone.targetRadius).toBe(20);
    });
  });
});
