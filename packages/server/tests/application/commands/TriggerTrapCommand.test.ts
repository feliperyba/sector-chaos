import { TRAP, TrapType } from '@sector-battle/shared';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { Trap, type TrapEffect } from '../../../src/domain/entities/Trap.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import {
  TriggerTrapCommand,
  type TriggerTrapInput,
} from '../../../src/application/commands/TriggerTrapCommand.ts';
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
  traps?: Map<string, Trap>;
  player?: Player;
  currentTick?: number;
}) {
  const traps = overrides?.traps ?? new Map<string, Trap>();
  const chests = new Map();
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
      grid: Array.from({ length: 80 }, () => Array(80).fill(0)),
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
    movePlayer: vi.fn(),
    handleTeleportTrap: vi.fn().mockReturnValue(new Position(3200, 3200)),
    currentTick: overrides?.currentTick ?? 0,
    worldToGrid: vi.fn().mockReturnValue({ gridX: 0, gridY: 0 }),
    getPlayers: vi.fn().mockReturnValue(overrides?.player ? [overrides.player] : []),
    getGrid: vi.fn().mockReturnValue(Array.from({ length: 80 }, () => Array(80).fill(0))),
    getCollisionService: vi.fn().mockReturnValue(null),
    getDamagePipeline: vi.fn().mockReturnValue({
      processDamage: vi.fn((_ctx: unknown, playerLookup: (id: string) => Player) => {
        const player = playerLookup(overrides?.player?.id ?? '');
        if (player) {
          return player.takeDamage(0, 0);
        }
        return { events: [], killed: false, damageApplied: 0 };
      }),
    }),
  } as unknown as GameMatch;
}

describe('TriggerTrapCommand', () => {
  it('should trigger spike trap and create damage effect with stun', () => {
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 10 });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'p1', trapId: 'trap-1', tick: 10 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    const event = (match.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('TrapTriggered');
    expect(event.trapType).toBe(TrapType.SPIKE);
    const damageEffect = event.effects.find((e: TrapEffect) => e.type === 'damage');
    expect(damageEffect).toBeDefined();
    expect(damageEffect.amount).toBe(TRAP.SPIKE_DAMAGE);
    expect(damageEffect.stunDuration).toBe(TRAP.SPIKE_STUN_DURATION);
    expect(damageEffect.targetId).toBe('p1');
  });

  it('should trigger fire trap and activate fire area', () => {
    const trap = Trap.create('trap-1', TrapType.FIRE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 10 });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'p1', trapId: 'trap-1', tick: 10 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    expect(trap.fireAreaActive).toBe(true);
    expect(trap.fireAreaRemainingTicks).toBe(300);
    const event = (match.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('TrapTriggered');
    expect(event.trapType).toBe(TrapType.FIRE);
  });

  it('should trigger teleport trap and create teleport effect', () => {
    const trap = Trap.create('trap-1', TrapType.TELEPORT, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 10 });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'p1', trapId: 'trap-1', tick: 10 };

    const result = command.execute(input);

    expect(result.success).toBe(true);
    const event = (match.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const teleportEffect = event.effects.find((e: TrapEffect) => e.type === 'teleport');
    expect(teleportEffect).toBeDefined();
    expect(teleportEffect.destination).toEqual({ x: 3200, y: 3200 });
    expect(teleportEffect.targetId).toBe('p1');
    expect(teleportEffect.type).toBe('teleport');
    expect(match.movePlayer).toHaveBeenCalledWith('p1', expect.any(Position));
  });

  it('should fail when spike trap is consumed', () => {
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 10 });
    const command = new TriggerTrapCommand(match);

    command.execute({ playerId: 'p1', trapId: 'trap-1', tick: 10 });

    const result = command.execute({ playerId: 'p1', trapId: 'trap-1', tick: 11 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Trap on cooldown');
  });

  it('should fail when player is out of range', () => {
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(300, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'p1', trapId: 'trap-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Out of range');
  });

  it('should fail when trap not found', () => {
    const player = new Player('p1', 'Alice', new Position(100, 100), defaultPlayerConfig);
    const match = createMockMatch({ player });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'p1', trapId: 'nonexistent', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Trap not found');
  });

  it('should fail when player not found', () => {
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps });
    const command = new TriggerTrapCommand(match);
    const input: TriggerTrapInput = { playerId: 'nonexistent', trapId: 'trap-1', tick: 0 };

    const result = command.execute(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Player not found');
  });

  it('should fail when fire trap is consumed (one-time use)', () => {
    const trap = Trap.create('trap-1', TrapType.FIRE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 10 });
    const command = new TriggerTrapCommand(match);

    command.execute({ playerId: 'p1', trapId: 'trap-1', tick: 10 });

    const result = command.execute({ playerId: 'p1', trapId: 'trap-1', tick: 11 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Trap on cooldown');
  });

  it('should tick fire DOT damage at 5 HP per 1-second interval', () => {
    const trap = Trap.create('trap-1', TrapType.FIRE, new Position(100, 100));
    const player = new Player('p1', 'Alice', new Position(110, 100), defaultPlayerConfig);
    const traps = new Map([['trap-1', trap]]);
    const match = createMockMatch({ traps, player, currentTick: 0 });
    const command = new TriggerTrapCommand(match);

    command.execute({ playerId: 'p1', trapId: 'trap-1', tick: 0 });

    const processDamage = (match.getDamagePipeline() as { processDamage: ReturnType<typeof vi.fn> })
      .processDamage;
    const callsBefore = processDamage.mock.calls.length;

    for (let i = 1; i <= 59; i++) {
      command.tickFireAreas(i);
    }
    expect(processDamage.mock.calls.length).toBe(callsBefore);

    command.tickFireAreas(60);
    expect(processDamage.mock.calls.length).toBe(callsBefore + 1);
    expect(processDamage.mock.calls[callsBefore][0].damage).toBe(5);
  });
});
