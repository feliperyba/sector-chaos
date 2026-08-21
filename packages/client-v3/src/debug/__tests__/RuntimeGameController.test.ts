import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeGameController } from '../RuntimeGameController.js';
import type { RuntimeGameControllerDeps } from '../RuntimeGameController.js';
import type { InputFrame, PlayerState } from '../../types.js';
import type { InputCollector } from '../../input/InputCollector.js';

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p1',
    name: 'Test',
    color: 0,
    x: 100,
    y: 200,
    direction: 0,
    facingAngle: 0,
    speed: 0,
    velocityX: 0,
    velocityY: 0,
    health: 80,
    maxHealth: 100,
    status: 0,
    kills: 0,
    activeSlot: 1,
    lastDamageTick: 0,
    dashCooldown: 0,
    barrierActive: false,
    speedBoostActive: false,
    connected: true,
    isBot: false,
    isWindupActive: false,
    windupWeaponType: 0,
    windupAttackType: '',
    animPhase: 0,
    animPhaseStartTick: 0,
    comboIndex: 0,
    barrierExpiryTick: 0,
    speedBoostExpiryTick: 0,
    freshSpawnExpiryTick: 0,
    lastProcessedInput: 0,
    weapons: [{ id: 'w1', weaponType: 1, tier: 1, ammo: 10, maxAmmo: 10 }],
    items: [],
    isBlocking: false,
    ...overrides,
  };
}

function makeInputCollector(): {
  collector: InputCollector;
  injectedFrames: InputFrame[];
  continuousCalls: { frame: InputFrame; durationMs: number }[];
} {
  const injectedFrames: InputFrame[] = [];
  const continuousCalls: { frame: InputFrame; durationMs: number }[] = [];
  const collector = {
    injectFrame: vi.fn((frame: InputFrame) => {
      injectedFrames.push(frame);
    }),
    injectContinuous: vi.fn((frame: InputFrame, durationMs: number) => {
      continuousCalls.push({ frame, durationMs });
    }),
    clearInjection: vi.fn(),
  } as unknown as InputCollector;
  return { collector, injectedFrames, continuousCalls };
}

function makeDeps(
  collectorOverride?: InputCollector,
  overrides: Partial<RuntimeGameControllerDeps> = {},
): RuntimeGameControllerDeps & {
  sentFrames: InputFrame[];
  inputCollector: InputCollector;
  injectedFrames: InputFrame[];
  continuousCalls: { frame: InputFrame; durationMs: number }[];
} {
  let seqCounter = 0;
  const sentFrames: InputFrame[] = [];
  const { collector, injectedFrames, continuousCalls } = makeInputCollector();
  const ic = collectorOverride ?? collector;
  return {
    sendInput: vi.fn((frame: InputFrame) => {
      sentFrames.push(frame);
    }),
    getPlayerState: vi.fn(() => makePlayer()),
    getNextSeq: vi.fn(() => ++seqCounter),
    isConnected: vi.fn(() => true),
    inputCollector: ic,
    getPhase: vi.fn(() => 2),
    ...overrides,
    sentFrames,
    injectedFrames,
    continuousCalls,
  };
}

describe('RuntimeGameController', () => {
  let deps: ReturnType<typeof makeDeps>;
  let ctrl: RuntimeGameController;

  beforeEach(() => {
    deps = makeDeps();
    ctrl = new RuntimeGameController(deps);
  });

  describe('construction', () => {
    it('constructs with deps', () => {
      expect(ctrl).toBeInstanceOf(RuntimeGameController);
    });

    it('getStatus returns initial state', () => {
      expect(ctrl.getStatus()).toEqual({ seq: 0, connected: true });
    });
  });

  describe('sendDirect', () => {
    it('calls sendInput with the frame', () => {
      ctrl.sendDirect({
        movementX: 1,
        movementY: 0,
        aimAngle: 0,
        sequence: 999,
        actions: ['DASH'],
      });
      expect(deps.sendInput).toHaveBeenCalledOnce();
    });

    it('overrides sequence from getNextSeq', () => {
      const sent = ctrl.sendDirect({
        movementX: 0,
        movementY: 0,
        aimAngle: 0,
        sequence: 999,
        actions: [],
      });
      expect(sent.sequence).toBe(1);
    });

    it('returns the sent frame', () => {
      const sent = ctrl.sendDirect({
        movementX: 0.5,
        movementY: -0.5,
        aimAngle: 1.57,
        sequence: 0,
        actions: [],
      });
      expect(sent.movementX).toBe(0.5);
      expect(sent.movementY).toBe(-0.5);
      expect(sent.aimAngle).toBe(1.57);
    });

    it('increments internal seq counter', () => {
      ctrl.sendDirect({ movementX: 0, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ctrl.sendDirect({ movementX: 0, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ctrl.sendDirect({ movementX: 0, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      expect(ctrl.getStatus().seq).toBe(3);
    });
  });

  describe('move', () => {
    it('calls inputCollector.injectFrame with movement', () => {
      ctrl.move(1, 0, 0.5);
      expect(deps.inputCollector.injectFrame).toHaveBeenCalledOnce();
      const frame = deps.injectedFrames[0]!;
      expect(frame.movementX).toBe(1);
      expect(frame.movementY).toBe(0);
      expect(frame.aimAngle).toBe(0.5);
      expect(frame.actions).toEqual([]);
    });

    it('does NOT call sendInput directly', () => {
      ctrl.move(1, 0, 0);
      expect(deps.sendInput).not.toHaveBeenCalled();
    });
  });

  describe('attack', () => {
    it('injects frame with ATTACK action', () => {
      ctrl.attack(1.2);
      const frame = deps.injectedFrames[0]!;
      expect(frame.actions).toEqual(['ATTACK']);
      expect(frame.aimAngle).toBe(1.2);
      expect(frame.movementX).toBe(0);
      expect(frame.movementY).toBe(0);
    });

    it('includes targetId when provided', () => {
      ctrl.attack(0, 'chest-42');
      expect(deps.injectedFrames[0]!.targetId).toBe('chest-42');
    });

    it('omits targetId when not provided', () => {
      ctrl.attack(0);
      expect(deps.injectedFrames[0]!.targetId).toBeUndefined();
    });
  });

  describe('dash', () => {
    it('injects frame with DASH action', () => {
      ctrl.dash(2.0);
      const frame = deps.injectedFrames[0]!;
      expect(frame.actions).toEqual(['DASH']);
      expect(frame.aimAngle).toBe(2.0);
    });

    it('defaults aimAngle to 0', () => {
      ctrl.dash();
      expect(deps.injectedFrames[0]!.aimAngle).toBe(0);
    });
  });

  describe('pickup', () => {
    it('injects frame with PICKUP action', () => {
      ctrl.pickup();
      expect(deps.injectedFrames[0]!.actions).toEqual(['PICKUP']);
    });

    it('includes targetId when provided', () => {
      ctrl.pickup('weapon-7');
      expect(deps.injectedFrames[0]!.targetId).toBe('weapon-7');
    });
  });

  describe('switchWeapon', () => {
    it('injects frame with WEAPON_SLOT_N action', () => {
      ctrl.switchWeapon(3);
      expect(deps.injectedFrames[0]!.actions).toEqual(['WEAPON_SLOT_3']);
    });
  });

  describe('throwWeapon', () => {
    it('injects frame with THROW action', () => {
      ctrl.throwWeapon(1.5);
      const frame = deps.injectedFrames[0]!;
      expect(frame.actions).toEqual(['THROW']);
      expect(frame.aimAngle).toBe(1.5);
    });

    it('defaults aimAngle to 0', () => {
      ctrl.throwWeapon();
      expect(deps.injectedFrames[0]!.aimAngle).toBe(0);
    });
  });

  describe('moveContinuous', () => {
    it('calls inputCollector.injectContinuous with correct args', () => {
      ctrl.moveContinuous(1, 0, 1.5, 500);
      expect(deps.inputCollector.injectContinuous).toHaveBeenCalledOnce();
      expect(deps.continuousCalls[0]!.frame.movementX).toBe(1);
      expect(deps.continuousCalls[0]!.frame.movementY).toBe(0);
      expect(deps.continuousCalls[0]!.frame.aimAngle).toBe(1.5);
      expect(deps.continuousCalls[0]!.durationMs).toBe(500);
    });
  });

  describe('state queries', () => {
    it('getHealth returns player health', () => {
      expect(ctrl.getHealth()).toBe(80);
    });

    it('getHealth returns 0 when no player', () => {
      deps = makeDeps(undefined, { getPlayerState: () => undefined });
      ctrl = new RuntimeGameController(deps);
      expect(ctrl.getHealth()).toBe(0);
    });

    it('getPosition returns player position', () => {
      expect(ctrl.getPosition()).toEqual({ x: 100, y: 200 });
    });

    it('getPosition returns {x:0,y:0} when no player', () => {
      deps = makeDeps(undefined, { getPlayerState: () => undefined });
      ctrl = new RuntimeGameController(deps);
      expect(ctrl.getPosition()).toEqual({ x: 0, y: 0 });
    });

    it('getWeapons returns player weapons', () => {
      const weapons = ctrl.getWeapons();
      expect(weapons).toHaveLength(1);
      expect(weapons[0]!.id).toBe('w1');
    });

    it('getWeapons returns [] when no player', () => {
      deps = makeDeps(undefined, { getPlayerState: () => undefined });
      ctrl = new RuntimeGameController(deps);
      expect(ctrl.getWeapons()).toEqual([]);
    });
  });

  describe('waitFor', () => {
    it('resolves true when predicate immediately passes', async () => {
      const result = await ctrl.waitFor((p) => p.health === 80, 200);
      expect(result).toBe(true);
    });

    it('resolves true after polling', async () => {
      let callCount = 0;
      const deps2 = makeDeps(undefined, {
        getPlayerState: () => {
          callCount++;
          return callCount >= 3 ? makePlayer({ health: 50 }) : makePlayer({ health: 100 });
        },
      });
      const ctrl2 = new RuntimeGameController(deps2);
      const result = await ctrl2.waitFor((p) => p.health === 50, 2000);
      expect(result).toBe(true);
    });

    it('resolves false on timeout', async () => {
      const result = await ctrl.waitFor((p) => p.health > 9000, 100);
      expect(result).toBe(false);
    });

    it('handles undefined player state at start', async () => {
      let returned = false;
      const deps2 = makeDeps(undefined, {
        getPlayerState: () => {
          if (!returned) {
            returned = true;
            return undefined;
          }
          return makePlayer();
        },
      });
      const ctrl2 = new RuntimeGameController(deps2);
      const result = await ctrl2.waitFor(() => true, 2000);
      expect(result).toBe(true);
    });

    it('rejects if player stays undefined for >1s', async () => {
      const deps2 = makeDeps(undefined, { getPlayerState: () => undefined });
      const ctrl2 = new RuntimeGameController(deps2);
      await expect(ctrl2.waitFor(() => true, 3000)).rejects.toThrow('Player not found');
    });
  });

  describe('getStatus', () => {
    it('reflects connection state from deps', () => {
      const deps2 = makeDeps(undefined, { isConnected: () => false });
      const ctrl2 = new RuntimeGameController(deps2);
      expect(ctrl2.getStatus().connected).toBe(false);
    });

    it('updates seq after sendDirect', () => {
      ctrl.sendDirect({ movementX: 0, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      ctrl.sendDirect({ movementX: 0, movementY: 0, aimAngle: 0, sequence: 0, actions: [] });
      expect(ctrl.getStatus().seq).toBe(2);
    });
  });

  describe('getPhase', () => {
    it('returns phase from deps', () => {
      expect(ctrl.getPhase()).toBe(2);
    });

    it('returns different phase when deps changes', () => {
      const deps2 = makeDeps(undefined, { getPhase: () => 0 });
      const ctrl2 = new RuntimeGameController(deps2);
      expect(ctrl2.getPhase()).toBe(0);
    });
  });

  describe('waitForActive', () => {
    it('resolves immediately when phase is already ACTIVE', async () => {
      const result = await ctrl.waitForActive(1000);
      expect(result).toBe(true);
    });

    it('resolves when phase transitions to ACTIVE', async () => {
      let callCount = 0;
      const deps2 = makeDeps(undefined, {
        getPhase: () => {
          callCount++;
          return callCount >= 3 ? 2 : 1;
        },
      });
      const ctrl2 = new RuntimeGameController(deps2);
      const result = await ctrl2.waitForActive(5000);
      expect(result).toBe(true);
    });

    it('resolves for ZONE_SHRINKING (phase >= ACTIVE)', async () => {
      const deps2 = makeDeps(undefined, { getPhase: () => 3 });
      const ctrl2 = new RuntimeGameController(deps2);
      const result = await ctrl2.waitForActive(1000);
      expect(result).toBe(true);
    });

    it('returns false on timeout when phase never reaches ACTIVE', async () => {
      const deps2 = makeDeps(undefined, { getPhase: () => 0 });
      const ctrl2 = new RuntimeGameController(deps2);
      const result = await ctrl2.waitForActive(250);
      expect(result).toBe(false);
    });
  });
});
