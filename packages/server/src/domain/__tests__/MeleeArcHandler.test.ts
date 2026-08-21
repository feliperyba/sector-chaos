import { describe, it, expect } from 'vitest';
import { MeleeArcHandler } from '../handlers/MeleeArcHandler.ts';
import { Player } from '../entities/Player.ts';
import { Position } from '../value-objects/Position.ts';
import { Direction } from '../value-objects/Direction.ts';
import { COMBAT, type HurtboxEntity } from '@sector-battle/shared';

function createMockPlayer(
  id: string,
  x: number,
  y: number,
  direction: Direction,
  facingAngle?: number,
): Player {
  const player = new Player(id, `player_${id}`, new Position(x, y), {
    baseHealth: 100,
    maxHealth: 100,
    baseSpeed: 200,
    dashSpeedMultiplier: 3,
    dashDuration: 10,
    dashCooldown: 120,
    inventorySize: 4,
    hitboxWidth: 24,
    hitboxHeight: 24,
  });
  player.movement.direction = direction;
  if (facingAngle !== undefined) {
    player.movement.facingAngle = facingAngle;
  }
  return player;
}

function toHurtboxEntities(players: Player[]): HurtboxEntity[] {
  const half = COMBAT.HURTBOX_SIZE / 2;
  return players.map((p) => ({
    id: p.id,
    kind: 'player' as const,
    position: { x: p.movement.position.x, y: p.movement.position.y },
    hurtbox: {
      x: p.movement.position.x - half,
      y: p.movement.position.y - half,
      width: COMBAT.HURTBOX_SIZE,
      height: COMBAT.HURTBOX_SIZE,
    },
  }));
}

describe('MeleeArcHandler', () => {
  const handler = new MeleeArcHandler();

  it('hits entity within arc and range', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 150, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('misses entity behind player (outside arc)', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 50, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('misses entity outside range (hurtbox beyond polygon outer edge)', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 300, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('hits multiple entities in arc', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const t1 = createMockPlayer('p2', 160, 90, Direction.LEFT);
    const t2 = createMockPlayer('p3', 160, 110, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([t1, t2]));

    expect(result.hitEntityIds).toEqual(['p2', 'p3']);
  });

  it('does not hit self', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);

    const result = handler.execute(player, 80, toHurtboxEntities([player]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('does not hit dead entities (filtered by caller)', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 150, 100, Direction.LEFT);
    target.die();

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('hits entity at exact arc edge (45 degrees)', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const range = 70;
    const target = createMockPlayer(
      'p2',
      100 + range * Math.cos(-Math.PI / 4),
      100 + range * Math.sin(-Math.PI / 4),
      Direction.LEFT,
    );

    const result = handler.execute(player, range + 1, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('hits entity at exact range limit', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const range = 80;
    const target = createMockPlayer('p2', 100 + range, 100, Direction.LEFT);

    const result = handler.execute(player, range, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('respects facing direction UP', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.UP, -Math.PI / 2);
    const target = createMockPlayer('p2', 100, 50, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('respects facing direction LEFT', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.LEFT, Math.PI);
    const target = createMockPlayer('p2', 50, 100, Direction.RIGHT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  describe('inner radius and direction', () => {
    it('does not hit target behind player even when close', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const target = createMockPlayer('p2', 70, 100, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([target]));

      expect(result.hitEntityIds).toEqual([]);
    });

    it('hits target at exactly inner radius distance', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const target = createMockPlayer('p2', 100 + COMBAT.ARC_INNER_RADIUS, 100, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([target]));

      expect(result.hitEntityIds).toEqual(['p2']);
    });

    it('hits target just beyond inner radius', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const target = createMockPlayer('p2', 100 + COMBAT.ARC_INNER_RADIUS + 1, 100, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([target]));

      expect(result.hitEntityIds).toEqual(['p2']);
    });
  });

  describe('durability cost', () => {
    it('returns durabilityCost equal to number of entities hit', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const t1 = createMockPlayer('p2', 160, 90, Direction.LEFT);
      const t2 = createMockPlayer('p3', 160, 110, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([t1, t2]));

      expect(result.durabilityCost).toBe(2);
    });

    it('returns zero durabilityCost when no entities hit', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);

      const result = handler.execute(player, 80, []);

      expect(result.durabilityCost).toBe(0);
    });

    it('returns durabilityCost of 1 for single hit', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const target = createMockPlayer('p2', 150, 100, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([target]));

      expect(result.durabilityCost).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('defaults to 0 radians for NaN facingAngle', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      player.movement.facingAngle = NaN;
      const target = createMockPlayer('p2', 150, 100, Direction.LEFT);

      const result = handler.execute(player, 80, toHurtboxEntities([target]));

      expect(result.hitEntityIds).toEqual(['p2']);
    });

    it('returns empty result for zero range', () => {
      const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
      const target = createMockPlayer('p2', 150, 100, Direction.LEFT);

      const result = handler.execute(player, 0, toHurtboxEntities([target]));

      expect(result.hitEntityIds).toEqual([]);
      expect(result.durabilityCost).toBe(0);
    });
  });
});
