import { describe, it, expect } from 'vitest';
import { MeleeLineHandler } from '../handlers/MeleeLineHandler.ts';
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

describe('MeleeLineHandler', () => {
  const handler = new MeleeLineHandler();

  it('hits entity on line', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 140, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
    expect(result.durabilityCost).toBe(1);
  });

  it('misses entity off line but in range', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 140, 160, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('misses entity behind player', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const target = createMockPlayer('p2', 40, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('hits entity at range limit', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const range = 80;
    const target = createMockPlayer('p2', 100 + range, 100, Direction.LEFT);

    const result = handler.execute(player, range, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });

  it('hits multiple entities on line', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);
    const t1 = createMockPlayer('p2', 130, 100, Direction.LEFT);
    const t2 = createMockPlayer('p3', 160, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([t1, t2]));

    expect(result.hitEntityIds).toEqual(['p2', 'p3']);
  });

  it('does not hit self', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.RIGHT);

    const result = handler.execute(player, 80, toHurtboxEntities([player]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('returns empty for NONE direction with default facingAngle 0 and target behind', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.NONE);
    const target = createMockPlayer('p2', 40, 100, Direction.LEFT);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual([]);
  });

  it('line extends upward for UP direction', () => {
    const player = createMockPlayer('p1', 100, 100, Direction.UP, -Math.PI / 2);
    const target = createMockPlayer('p2', 100, 60, Direction.DOWN);

    const result = handler.execute(player, 80, toHurtboxEntities([target]));

    expect(result.hitEntityIds).toEqual(['p2']);
  });
});
