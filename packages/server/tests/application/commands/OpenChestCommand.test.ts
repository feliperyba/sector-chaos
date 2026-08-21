import { ChestRarity } from '@sector-battle/shared';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import type { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import {
  OpenChestCommand,
  type OpenChestInput,
} from '../../../src/application/commands/OpenChestCommand.ts';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';

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

function createMockMatch(overrides?: {
  chests?: Map<string, Chest>;
  player?: Player;
  currentTick?: number;
}) {
  const chests = overrides?.chests ?? new Map<string, Chest>();
  const traps = new Map();
  const powerUps = new Map();
  const players = new Map<string, Player>();

  if (overrides?.player) {
    players.set(overrides.player.id, overrides.player);
  }

  return {
    getState: vi.fn().mockReturnValue({
      chests,
      traps,
      powerUps,
      players,
      bombs: new Map(),
      projectiles: new Map(),
      destructibles: new Map(),
      exits: new Map(),
      explosions: new Map(),
      tick: overrides?.currentTick ?? 0,
      phase: {},
      zone: {
        phases: [],
        totalDuration: 300,
        transitionDuration: 900,
        tickInterval: 60,
        warningTime: 300,
      },
    }),
    getPlayer: vi.fn((id: string) => players.get(id)),
    emitEvent: vi.fn(),
    // server-chest-cancel-index: the registration surface OpenChestCommand writes to.
    openingChestsByPlayer: new Map<string, Set<string>>(),
    currentTick: overrides?.currentTick ?? 0,
  } as unknown as GameMatch;
}

describe('OpenChestCommand', () => {
  it('should open chest when player is in range and chest is closed', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(120, 100), defaultPlayerConfig);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player, currentTick: 5 });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 5 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    expect(chest.state).toBe('opening');
    expect(chest.openingPlayerId).toBe('p1');
  });

  it('should reject when player is out of range', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(300, 100), defaultPlayerConfig);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('out_of_range');
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ChestRejected',
        reason: 'out_of_range',
        chestId: 'chest-1',
        playerId: 'p1',
      }),
    );
  });

  it('should reject when chest is already opening', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    chest.startOpening('p1', 10, new Position(110, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ChestRejected',
        reason: 'already_open',
      }),
    );
  });

  it('should reject when chest is already open', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    chest.startOpening('p1', 10, new Position(110, 100));
    chest.completeOpening({ type: 'sword', tier: ChestRarity.COMMON });
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(match.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ChestRejected',
        reason: 'already_open',
      }),
    );
  });

  it('should OPEN chest even when player inventory is full (chest loot is a ground pickup, not inventory)', () => {
    // Regression: chest loot spawns as a ground pickup on an adjacent tile
    // (ChestOpeningHandler.completeOpening → addWeaponPickup / addPowerUp),
    // never into the player's inventory. Inventory state must NOT gate opening.
    // GDD §11.2 specifies only range + stationary-channel + not-attacking + not-dead.
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    player.addWeapon({ id: 'w1' } as WeaponEntity);
    player.addWeapon({ id: 'w2' } as WeaponEntity);
    player.addWeapon({ id: 'w3' } as WeaponEntity);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    expect(chest.state).toBe('opening');
    expect(chest.openingPlayerId).toBe('p1');
    expect(match.emitEvent).not.toHaveBeenCalled();
  });

  it('should fail when chest not found', () => {
    const player = new Player('p1', 'Alice', new Position(100, 100), defaultPlayerConfig);
    const match = createMockMatch({ player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'nonexistent', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Chest not found');
  });

  it('should fail when player not found', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'nonexistent', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Player not found');
  });

  it('should reject when player is dead', () => {
    const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    player.die();
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Player is dead');
  });

  it('should emit ChestRejectedEvent with correct fields on rejection', () => {
    const chest = Chest.create('chest-1', ChestRarity.RARE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(300, 100), defaultPlayerConfig);
    const chests = new Map([['chest-1', chest]]);
    const match = createMockMatch({ chests, player, currentTick: 42 });
    const command = new OpenChestCommand(match);
    const input: OpenChestInput = { playerId: 'p1', chestId: 'chest-1', tick: 42 };

    command.execute(input);

    expect(match.emitEvent).toHaveBeenCalledTimes(1);
    const event = (match.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('ChestRejected');
    expect(event.tick).toBe(42);
    expect(event.chestId).toBe('chest-1');
    expect(event.playerId).toBe('p1');
    expect(event.reason).toBe('out_of_range');
    expect(event.timestamp).toBeTypeOf('number');
  });
});
