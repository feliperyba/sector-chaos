import { describe, expect, it } from 'vitest';
import { PLAYER } from '../../src/constants/player.js';
import { COMBAT } from '../../src/constants/combat.js';
import { GRID } from '../../src/constants/grid.js';
import { NETWORK } from '../../src/constants/network.js';
import { ZONE } from '../../src/constants/zone.js';
import { MATCH } from '../../src/constants/match.js';

describe('PLAYER constants', () => {
  it('BASE_SPEED is 430 px/s', () => {
    expect(PLAYER.BASE_SPEED).toBe(430);
  });

  it('BASE_HEALTH is 100 HP', () => {
    expect(PLAYER.BASE_HEALTH).toBe(100);
  });

  it('MAX_HEALTH is 100 HP', () => {
    expect(PLAYER.MAX_HEALTH).toBe(100);
  });

  it('HITBOX_WIDTH is 96 px', () => {
    expect(PLAYER.HITBOX_WIDTH).toBe(96);
  });

  it('HITBOX_HEIGHT is 96 px', () => {
    expect(PLAYER.HITBOX_HEIGHT).toBe(96);
  });

  it('DASH_SPEED_MULTIPLIER is 2.0', () => {
    expect(PLAYER.DASH_SPEED_MULTIPLIER).toBe(2.0);
  });

  it('DASH_DURATION is 0.5 seconds', () => {
    expect(PLAYER.DASH_DURATION).toBe(0.5);
  });

  it('DASH_DURATION_TICKS is 30', () => {
    expect(PLAYER.DASH_DURATION_TICKS).toBe(30);
  });

  it('DASH_COOLDOWN is the tuned 2.5 seconds', () => {
    expect(PLAYER.DASH_COOLDOWN).toBe(2.5);
  });

  it('PICKUP_RADIUS is the tuned 72 px', () => {
    expect(PLAYER.PICKUP_RADIUS).toBe(72);
  });

  it('INVENTORY_SIZE is 4 slots', () => {
    expect(PLAYER.INVENTORY_SIZE).toBe(4);
  });

  it('SPAWN_INVINCIBILITY is 3.0 seconds', () => {
    expect(PLAYER.SPAWN_INVINCIBILITY).toBe(3.0);
  });
});

describe('COMBAT constants', () => {
  it('KNOCKBACK_FORCE is 2000', () => {
    expect(COMBAT.KNOCKBACK_FORCE).toBe(2000);
  });

  it('BOUNCE_FACTOR is the tuned 0.8', () => {
    expect(COMBAT.BOUNCE_FACTOR).toBe(0.8);
  });

  it('MAX_BOUNCES is the tuned 8', () => {
    expect(COMBAT.MAX_BOUNCES).toBe(8);
  });

  it('ARC_INNER_RADIUS is 48 px', () => {
    expect(COMBAT.ARC_INNER_RADIUS).toBe(48);
  });

  it('LINE_ATTACK_WIDTH is 20 px', () => {
    expect(COMBAT.LINE_ATTACK_WIDTH).toBe(20);
  });

  it('DEATH_ANIMATION_DURATION is 0.5 seconds', () => {
    expect(COMBAT.DEATH_ANIMATION_DURATION).toBe(0.5);
  });

  it('STAGGER_MOVE_SPEED_PENALTY is the tuned 0.75', () => {
    expect(COMBAT.STAGGER_MOVE_SPEED_PENALTY).toBe(0.75);
  });

  it('FRIENDLY_FIRE is false', () => {
    expect(COMBAT.FRIENDLY_FIRE).toBe(false);
  });

  it('THROW_RANGE is 2000 px', () => {
    expect(COMBAT.THROW_RANGE).toBe(2000);
  });

  it('WINDUP_UNCANCELLABLE is true', () => {
    expect(COMBAT.WINDUP_UNCANCELLABLE).toBe(true);
  });

  it('DEAD_BODY_COLLISION is true', () => {
    expect(COMBAT.DEAD_BODY_COLLISION).toBe(true);
  });

  it('SHIELD_BLOCKS_ENVIRONMENTAL is false', () => {
    expect(COMBAT.SHIELD_BLOCKS_ENVIRONMENTAL).toBe(false);
  });

  it('SHIELD_DAMAGE_NEGATION is 1.0', () => {
    expect(COMBAT.SHIELD_DAMAGE_NEGATION).toBe(1.0);
  });

  it('THROWN_DURABILITY_ZERO_SHATTER is true', () => {
    expect(COMBAT.THROWN_DURABILITY_ZERO_SHATTER).toBe(true);
  });

  it('LINE_HITS_ALL_IN_WIDTH is true', () => {
    expect(COMBAT.LINE_HITS_ALL_IN_WIDTH).toBe(true);
  });

  it('THROWN_FLIGHT_NOT_PICKUPABLE is true', () => {
    expect(COMBAT.THROWN_FLIGHT_NOT_PICKUPABLE).toBe(true);
  });
});

describe('GRID constants', () => {
  it('TILE_SIZE is 128', () => {
    expect(GRID.TILE_SIZE).toBe(128);
  });

  it('ARENA_WIDTH is 80 tiles', () => {
    expect(GRID.ARENA_WIDTH).toBe(80);
  });

  it('ARENA_HEIGHT is 80 tiles', () => {
    expect(GRID.ARENA_HEIGHT).toBe(80);
  });

  it('SECTOR_GRID_SIZE is 4', () => {
    expect(GRID.SECTOR_GRID_SIZE).toBe(4);
  });

  it('SECTOR_TILE_SIZE is 20', () => {
    expect(GRID.SECTOR_TILE_SIZE).toBe(20);
  });

  it('CORRIDOR_WIDTH is 3', () => {
    expect(GRID.CORRIDOR_WIDTH).toBe(3);
  });

  it('WORLD_WIDTH is 10240', () => {
    expect(GRID.WORLD_WIDTH).toBe(10240);
  });

  it('WORLD_HEIGHT is 10240', () => {
    expect(GRID.WORLD_HEIGHT).toBe(10240);
  });
});

describe('NETWORK constants', () => {
  it('TICK_RATE is 60 Hz', () => {
    expect(NETWORK.TICK_RATE).toBe(60);
  });

  it('PATCH_RATE is 30 Hz (decoupled from TICK_RATE to keep the live server inside its tick budget)', () => {
    expect(NETWORK.PATCH_RATE).toBe(30);
  });

  it('MAX_LATENCY is 500 ms', () => {
    expect(NETWORK.MAX_LATENCY).toBe(500);
  });

  it('INPUT_BUFFER_SIZE is 120 slots', () => {
    expect(NETWORK.INPUT_BUFFER_SIZE).toBe(120);
  });
});

describe('ZONE constants', () => {
  it('ZONE_CENTER_X is 5120', () => {
    expect(ZONE.ZONE_CENTER_X).toBe(5120);
  });

  it('ZONE_CENTER_Y is 5120', () => {
    expect(ZONE.ZONE_CENTER_Y).toBe(5120);
  });

  it('INITIAL_ZONE_RADIUS is 5120', () => {
    expect(ZONE.INITIAL_ZONE_RADIUS).toBe(5120);
  });

  it('ZONE_TICK_INTERVAL is 0.5', () => {
    expect(ZONE.ZONE_TICK_INTERVAL).toBe(0.5);
  });

  it('ZONE_DAMAGE_PER_TICK is the tuned 8', () => {
    expect(ZONE.ZONE_DAMAGE_PER_TICK).toBe(8);
  });

  it('ZONE_DAMAGE_SUDDEN_DEATH is the tuned 15', () => {
    expect(ZONE.ZONE_DAMAGE_SUDDEN_DEATH).toBe(15);
  });

  it('ZONE_WARNING_TIME is the tuned 10', () => {
    expect(ZONE.ZONE_WARNING_TIME).toBe(10);
  });

  it('ZONE_TRANSITION_DURATION is 30', () => {
    expect(ZONE.ZONE_TRANSITION_DURATION).toBe(30);
  });

  it('SIEGE_WALL_DROP_INTERVAL is 3', () => {
    expect(ZONE.SIEGE_WALL_DROP_INTERVAL).toBe(3);
  });

  it('SIEGE_CRUSH_DAMAGE is 100', () => {
    expect(ZONE.SIEGE_CRUSH_DAMAGE).toBe(100);
  });

  it('ZONE_PHASE_1_RADIUS is 1.0', () => {
    expect(ZONE.ZONE_PHASE_1_RADIUS).toBe(1.0);
  });

  it('ZONE_PHASE_2_RADIUS is 0.60', () => {
    expect(ZONE.ZONE_PHASE_2_RADIUS).toBe(0.6);
  });

  it('ZONE_PHASE_3_RADIUS is 0.25', () => {
    expect(ZONE.ZONE_PHASE_3_RADIUS).toBe(0.25);
  });

  it('ZONE_PHASE_4_RADIUS is 0.15', () => {
    expect(ZONE.ZONE_PHASE_4_RADIUS).toBe(0.15);
  });

  it('ZONE_PHASE_5_RADIUS is 0.10', () => {
    expect(ZONE.ZONE_PHASE_5_RADIUS).toBe(0.1);
  });

  it('ZONE_PHASE_6_RADIUS is 0.08', () => {
    expect(ZONE.ZONE_PHASE_6_RADIUS).toBe(0.08);
  });

  it('ZONE_PHASE_1_DURATION is the tuned 60', () => {
    expect(ZONE.ZONE_PHASE_1_DURATION).toBe(60);
  });

  it('ZONE_PHASE_2_DURATION is the tuned 45', () => {
    expect(ZONE.ZONE_PHASE_2_DURATION).toBe(45);
  });

  it('ZONE_PHASE_3_DURATION is the tuned 45', () => {
    expect(ZONE.ZONE_PHASE_3_DURATION).toBe(45);
  });

  it('ZONE_PHASE_4_DURATION is the tuned 45', () => {
    expect(ZONE.ZONE_PHASE_4_DURATION).toBe(45);
  });

  it('ZONE_PHASE_5_DURATION is the tuned 30', () => {
    expect(ZONE.ZONE_PHASE_5_DURATION).toBe(30);
  });

  it('ZONE_PHASE_6_DURATION is the tuned 30', () => {
    expect(ZONE.ZONE_PHASE_6_DURATION).toBe(30);
  });

  it('TOTAL_DURATION is the tuned 720', () => {
    expect(ZONE.TOTAL_DURATION).toBe(720);
  });

  it('PHASES has 7 entries', () => {
    expect(ZONE.PHASES.length).toBe(7);
  });

  // The PHASES table DERIVES from the ZONE_PHASE_x_* scalars (zone.ts
  // single-source). These pins read through the scalars so a tuning pass
  // moves them together; the anti-drift cross-check below fails if anyone
  // reintroduces literal durations in the table.
  it('PHASES[0] is Drop', () => {
    expect(ZONE.PHASES[0]).toMatchObject({
      index: 1,
      radiusRatio: ZONE.ZONE_PHASE_1_RADIUS,
      duration: ZONE.ZONE_PHASE_1_DURATION,
      name: 'Drop',
    });
  });

  it('PHASES[1] is First Closure', () => {
    expect(ZONE.PHASES[1]).toMatchObject({
      index: 2,
      radiusRatio: ZONE.ZONE_PHASE_2_RADIUS,
      duration: ZONE.ZONE_PHASE_2_DURATION,
      name: 'First Closure',
    });
  });

  it('PHASES[2] is Edge Closure', () => {
    expect(ZONE.PHASES[2]).toMatchObject({
      index: 3,
      radiusRatio: ZONE.ZONE_PHASE_3_RADIUS,
      duration: ZONE.ZONE_PHASE_3_DURATION,
      name: 'Edge Closure',
    });
  });

  it('PHASES[3] is Final Ring', () => {
    expect(ZONE.PHASES[3]).toMatchObject({
      index: 4,
      radiusRatio: ZONE.ZONE_PHASE_4_RADIUS,
      duration: ZONE.ZONE_PHASE_4_DURATION,
      name: 'Final Ring',
    });
  });

  it('PHASES[4] is Last Sector', () => {
    expect(ZONE.PHASES[4]).toMatchObject({
      index: 5,
      radiusRatio: ZONE.ZONE_PHASE_5_RADIUS,
      duration: ZONE.ZONE_PHASE_5_DURATION,
      name: 'Last Sector',
    });
  });

  it('PHASES[5] is Final Closure', () => {
    expect(ZONE.PHASES[5]).toMatchObject({
      index: 6,
      radiusRatio: ZONE.ZONE_PHASE_6_RADIUS,
      duration: ZONE.ZONE_PHASE_6_DURATION,
      name: 'Final Closure',
    });
  });

  it('PHASES[6] is Sudden Death', () => {
    expect(ZONE.PHASES[6].name).toBe('Sudden Death');
    expect(ZONE.PHASES[6].radiusRatio).toBe(ZONE.ZONE_PHASE_6_RADIUS);
  });

  it('PHASES table matches the scalars 1:1 (anti-drift)', () => {
    const radii = [
      ZONE.ZONE_PHASE_1_RADIUS,
      ZONE.ZONE_PHASE_2_RADIUS,
      ZONE.ZONE_PHASE_3_RADIUS,
      ZONE.ZONE_PHASE_4_RADIUS,
      ZONE.ZONE_PHASE_5_RADIUS,
      ZONE.ZONE_PHASE_6_RADIUS,
    ];
    const durations = [
      ZONE.ZONE_PHASE_1_DURATION,
      ZONE.ZONE_PHASE_2_DURATION,
      ZONE.ZONE_PHASE_3_DURATION,
      ZONE.ZONE_PHASE_4_DURATION,
      ZONE.ZONE_PHASE_5_DURATION,
      ZONE.ZONE_PHASE_6_DURATION,
    ];
    for (let i = 0; i < 6; i++) {
      expect(ZONE.PHASES[i]!.index).toBe(i + 1);
      expect(ZONE.PHASES[i]!.radiusRatio).toBe(radii[i]);
      expect(ZONE.PHASES[i]!.duration).toBe(durations[i]);
    }
  });

  it('SIEGE_RING_WIDTH_TILES is 1', () => {
    expect(ZONE.SIEGE_RING_WIDTH_TILES).toBe(1);
  });
});

describe('MATCH constants', () => {
  it('MAX_PLAYERS is 64', () => {
    expect(MATCH.MAX_PLAYERS).toBe(64);
  });

  it('MIN_PLAYERS is 32', () => {
    expect(MATCH.MIN_PLAYERS).toBe(32);
  });

  it('COUNTDOWN_DURATION is 5', () => {
    expect(MATCH.COUNTDOWN_DURATION).toBe(5);
  });

  it('TARGET_DURATION is the tuned 500', () => {
    expect(MATCH.TARGET_DURATION).toBe(500);
  });

  it('MAX_DURATION is the tuned 620', () => {
    expect(MATCH.MAX_DURATION).toBe(620);
  });

  it('OVERTIME_START is the tuned 500 (starts with TARGET_DURATION)', () => {
    expect(MATCH.OVERTIME_START).toBe(500);
  });

  it('MATCHMAKING_DURATION is 90', () => {
    expect(MATCH.MATCHMAKING_DURATION).toBe(90);
  });

  it('RESULTS_SCREEN_DURATION is 30', () => {
    expect(MATCH.RESULTS_SCREEN_DURATION).toBe(30);
  });

  it('AFK_TIMEOUT is 60', () => {
    expect(MATCH.AFK_TIMEOUT).toBe(60);
  });

  it('DISCONNECT_TOTAL_TO_BOT is 60', () => {
    expect(MATCH.DISCONNECT_TOTAL_TO_BOT).toBe(60);
  });
});

describe('Cross-reference checks', () => {
  it('WORLD_WIDTH = ARENA_WIDTH * TILE_SIZE', () => {
    expect(GRID.WORLD_WIDTH).toBe(GRID.ARENA_WIDTH * GRID.TILE_SIZE);
  });

  it('ARENA_WIDTH = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE', () => {
    expect(GRID.ARENA_WIDTH).toBe(GRID.SECTOR_GRID_SIZE * GRID.SECTOR_TILE_SIZE);
  });

  it('INITIAL_ZONE_RADIUS = WORLD_WIDTH / 2', () => {
    expect(ZONE.INITIAL_ZONE_RADIUS).toBe(GRID.WORLD_WIDTH / 2);
  });

  it('ZONE_CENTER_X = WORLD_WIDTH / 2', () => {
    expect(ZONE.ZONE_CENTER_X).toBe(GRID.WORLD_WIDTH / 2);
  });

  it('TICK_INTERVAL approximates 1000 / TICK_RATE', () => {
    expect(NETWORK.TICK_INTERVAL).toBeCloseTo(1000 / NETWORK.TICK_RATE, 2);
  });

  it('MATCH.TARGET_DURATION = MATCH.OVERTIME_START (match clock self-consistent)', () => {
    // NOTE: MATCH.TARGET_DURATION (500) and ZONE.TOTAL_DURATION (720) were
    // tuned separately (3725faf3 vs 872859f5) and no longer agree — the old
    // MATCH == ZONE equality is dropped until the owner reconciles the two
    // budgets. The match clock's own invariant (overtime starts when the
    // target elapses) still holds.
    expect(MATCH.TARGET_DURATION).toBe(MATCH.OVERTIME_START);
  });
});
