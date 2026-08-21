import { Position } from '../../../src/domain/value-objects/Position.ts';
import { PowerUp } from '../../../src/domain/entities/PowerUp.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import {
  PickupPowerUpCommand,
  type PickupPowerUpInput,
} from '../../../src/application/commands/PickupPowerUpCommand.ts';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { POWERUP, PowerUpType } from '@sector-battle/shared';

const defaultPlayerConfig = {
  baseSpeed: 200,
  dashSpeedMultiplier: 2,
  dashDuration: 10,
  dashCooldown: 60,
  baseHealth: 100,
  maxHealth: 100,
  inventorySize: 4,
  hitboxWidth: 28,
  hitboxHeight: 28,
};

function createMockMatch(player: Player, currentTick = 0) {
  const players = new Map<string, Player>();
  players.set(player.id, player);

  let powerUps = new Map<string, PowerUp>();

  const state = {
    chests: new Map(),
    traps: new Map(),
    get powerUps() {
      return powerUps;
    },
    players,
    bombs: new Map(),
    projectiles: new Map(),
    destructibles: new Map(),
    exits: new Map(),
    explosions: new Map(),
    tick: currentTick,
    phase: {},
    zone: {
      phases: [],
      totalDuration: 300,
      transitionDuration: 900,
      tickInterval: 60,
      warningTime: 300,
    },
  };

  return {
    getState: vi.fn(() => state),
    getPlayer: vi.fn((id: string) => players.get(id)),
    emitEvent: vi.fn(),
    removePowerUpById: vi.fn((id: string) => {
      powerUps.delete(id);
    }),
    currentTick,
    _setPowerUps(map: Map<string, PowerUp>) {
      powerUps = map;
    },
  } as unknown as GameMatch & { _setPowerUps(map: Map<string, PowerUp>): void };
}

describe('PickupPowerUpCommand', () => {
  it('should apply speed boost when player picks up speed power-up', () => {
    const powerUp = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const match = createMockMatch(player, 5);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);
    const input: PickupPowerUpInput = { playerId: 'p1', powerUpId: 'pu-1', tick: 5 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    // Fixture base speed 200 x the tuned SPEED_BOOST_MULTIPLIER (1.75).
    expect(player.movement.speed.value).toBe(200 * POWERUP.SPEED_BOOST_MULTIPLIER);
    expect(powerUp.isActive).toBe(false);
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PowerUpCollected',
        powerUpType: PowerUpType.SPEED_BOOST,
        playerId: 'p1',
      }),
    );
  });

  it('should refresh speed boost when player already has one', () => {
    const powerUp1 = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    const powerUp2 = PowerUp.create('pu-2', 'speed_boost', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const addSpeedSpy = vi.spyOn(player, 'addSpeed');
    const match = createMockMatch(player, 5);
    const command = new PickupPowerUpCommand(match);

    match._setPowerUps(new Map([['pu-1', powerUp1]]));
    const first = command.execute({ playerId: 'p1', powerUpId: 'pu-1', tick: 5 });
    expect(first.success).toBe(true);
    const boostedSpeed = player.movement.speed.value;
    addSpeedSpy.mockClear();

    match._setPowerUps(new Map([['pu-2', powerUp2]]));
    const result = command.execute({ playerId: 'p1', powerUpId: 'pu-2', tick: 6 });

    expect(result.success).toBe(true);
    expect(addSpeedSpy).not.toHaveBeenCalled();
    expect(player.movement.speed.value).toBe(boostedSpeed);
    expect(powerUp2.isActive).toBe(false);
  });

  it('should activate barrier when player picks up barrier power-up', () => {
    const powerUp = PowerUp.create('pu-1', 'barrier', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const match = createMockMatch(player, 5);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);

    const result = command.execute({ playerId: 'p1', powerUpId: 'pu-1', tick: 5 });

    expect(result.success).toBe(true);
    expect(player.statusEffects.barrierActive).toBe(true);
    expect(powerUp.isActive).toBe(false);
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PowerUpCollected',
        powerUpType: PowerUpType.BARRIER,
      }),
    );
  });

  it('should heal player when picking up health_pack', () => {
    const powerUp = PowerUp.create('pu-1', 'health_pack', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    player.takeDamage(40);
    const match = createMockMatch(player, 5);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);

    const result = command.execute({ playerId: 'p1', powerUpId: 'pu-1', tick: 5 });

    expect(result.success).toBe(true);
    expect(player.health.current).toBe(90);
    expect(powerUp.isActive).toBe(false);
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PowerUpCollected',
        powerUpType: PowerUpType.HEALTH_PACK,
      }),
    );
  });

  it('should reject health_pack when player is at full health', () => {
    const powerUp = PowerUp.create('pu-1', 'health_pack', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const match = createMockMatch(player, 5);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);

    const result = command.execute({ playerId: 'p1', powerUpId: 'pu-1', tick: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Already at full health');
    expect(powerUp.isActive).toBe(true);
  });

  it('should fail when power-up is expired (inactive)', () => {
    const powerUp = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    powerUp.deactivate();
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const match = createMockMatch(player);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);
    const input: PickupPowerUpInput = { playerId: 'p1', powerUpId: 'pu-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('PowerUp not active');
  });

  it('should fail when player is out of range', () => {
    const powerUp = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(200, 100), defaultPlayerConfig);
    const match = createMockMatch(player);
    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const command = new PickupPowerUpCommand(match);
    const input: PickupPowerUpInput = { playerId: 'p1', powerUpId: 'pu-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Out of range');
  });

  it('should fail when power-up not found', () => {
    const player = new Player('p1', 'Alice', new Position(100, 100), defaultPlayerConfig);
    const match = createMockMatch(player);
    const command = new PickupPowerUpCommand(match);
    const input: PickupPowerUpInput = { playerId: 'p1', powerUpId: 'nonexistent', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('PowerUp not found');
  });

  it('should clear all effects for player via clearAllEffectsForPlayer', () => {
    const powerUp = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const match = createMockMatch(player, 5);
    const command = new PickupPowerUpCommand(match);

    match._setPowerUps(new Map([['pu-1', powerUp]]));
    const result1 = command.execute({ playerId: 'p1', powerUpId: 'pu-1', tick: 5 });
    expect(result1.success).toBe(true);

    const barrier = PowerUp.create('pu-barrier', 'barrier', new Position(100, 100), 0);
    match._setPowerUps(new Map([['pu-barrier', barrier]]));
    const result2 = command.execute({ playerId: 'p1', powerUpId: 'pu-barrier', tick: 6 });
    expect(result2.success).toBe(true);

    command.clearAllEffectsForPlayer('p1');

    const speedPu = PowerUp.create('pu-speed2', 'speed_boost', new Position(100, 100), 0);
    match._setPowerUps(new Map([['pu-speed2', speedPu]]));
    const result3 = command.execute({ playerId: 'p1', powerUpId: 'pu-speed2', tick: 7 });
    expect(result3.success).toBe(true);
  });
});
