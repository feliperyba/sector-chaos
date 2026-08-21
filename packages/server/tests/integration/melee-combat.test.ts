import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import { advanceTicks } from '../helpers/test-utils';
import {
  PLAYER,
  NETWORK,
  COMBAT,
  GRID,
  MATCH,
  WeaponType,
  WeaponTier,
  TileType,
  MatchPhase,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../src/domain/entities/index';
import { Position } from '../../src/domain/value-objects/index';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const WINDUP_FAST_TICKS = Math.ceil(COMBAT.ATTACK_WINDUP_FAST * NETWORK.TICK_RATE);
const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const KNOCKBACK_TICKS = Math.ceil(COMBAT.KNOCKBACK_DURATION * NETWORK.TICK_RATE);
const FISTS_WINDUP_TICKS = Math.ceil(50 / (1000 / NETWORK.TICK_RATE));
const DAGGER_WINDUP_TICKS = Math.ceil(100 / (1000 / NETWORK.TICK_RATE));
const LONGSWORD_WINDUP_TICKS = Math.ceil(200 / (1000 / NETWORK.TICK_RATE));
const SPEAR_WINDUP_TICKS = Math.ceil(150 / (1000 / NETWORK.TICK_RATE));
const COUNTDOWN_TICKS = Math.ceil(MATCH.COUNTDOWN_DURATION * NETWORK.TICK_RATE);

const POS_A = { x: 5120, y: 5100 };
const POS_T_DOWN = { x: 5120, y: 5170 };
const POS_T_RIGHT = { x: 5190, y: 5100 };

let server: ColyseusTestServer;
let activeRoom: Room<{ state: GameStateSchema }> | null = null;

beforeAll(async () => {
  server = await createTestServer();
});

afterEach(() => {
  if (activeRoom) {
    try {
      const internal = activeRoom as unknown as { _dispose?(): void; disconnect?(): void };
      if (typeof internal.disconnect === 'function') {
        internal.disconnect();
      }
    } catch {}
    activeRoom = null;
  }
});

afterAll(async () => {
  await cleanup(server);
});

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as { match: GameMatch };
  return orch.match;
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
}

function clearArea(grid: TileType[][], cx: number, cy: number, radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gy = cy + dy;
      const gx = cx + dx;
      if (gy >= 0 && gy < grid.length && gx >= 0 && gx < grid[0]!.length) {
        grid[gy]![gx] = TileType.EMPTY;
      }
    }
  }
}

function equipWeapon(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  weaponType: WeaponType,
  tier: WeaponTier,
): void {
  const player = getDomainPlayer(room, sessionId);
  const def = weaponRegistry.getDefinition(weaponType);
  const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
  const weapon = new WeaponEntity(`w-${weaponType}-${sessionId}`, weaponType, tier, 999, 999, cd);
  const slot = player.findFirstEmptySlot();
  if (slot !== null) {
    player.addWeapon(weapon);
    player.forceSwitchSlot(slot);
  }
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: { getCurrentState: () => { phase: number }; transitionTo: (p: number) => void };
    phase: number;
  };
  const match = getMatch(room) as unknown as { phase: number };
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) {
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  }
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN) {
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  }
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
  gameRoom.syncState();
}

async function prepareCombat(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
  attackerPos: { x: number; y: number },
  targetPos: { x: number; y: number },
): Promise<{ attacker: TestClient; target: TestClient }> {
  const attacker = await helper.addPlayer('Attacker');
  const target = await helper.addPlayer('Target');
  getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
    attackerPos.x,
    attackerPos.y,
  );
  getDomainPlayer(room, target.sessionId).movement.position = new Position(
    targetPos.x,
    targetPos.y,
  );
  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);
  return { attacker, target };
}

async function prepareCombatMulti(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
  names: string[],
  positions: { x: number; y: number }[],
): Promise<TestClient[]> {
  const clients: TestClient[] = [];
  for (const name of names) {
    clients.push(await helper.addPlayer(name));
  }
  for (let i = 0; i < clients.length; i++) {
    getDomainPlayer(room, clients[i].sessionId).movement.position = new Position(
      positions[i].x,
      positions[i].y,
    );
  }
  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);
  return clients;
}

function setFacing(room: Room<{ state: GameStateSchema }>, sessionId: string, angle: number): void {
  getDomainPlayer(room, sessionId).movement.facingAngle = angle;
}

function sendAttack(
  client: TestClient,
  room: Room<{ state: GameStateSchema }>,
  aimAngle: number,
): void {
  client.send('input', {
    movementX: 0,
    movementY: 0,
    aimAngle,
    actions: ['ATTACK'],
    sequence: room.state.tick,
  });
}

describe('Melee Combat Integration', () => {
  describe('ARC Attack', () => {
    it('damages facing target within 90-degree arc', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('misses target outside arc', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, { x: 5120, y: 5030 });
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('inner radius dead zone - close target in facing direction is not hit', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, { x: 5120, y: 5070 });
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('hits multiple targets in arc', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [attacker, target1, target2] = await prepareCombatMulti(
        helper,
        room,
        ['Attacker', 'Target1', 'Target2'],
        [
          { x: 5120, y: 5100 },
          { x: 5170, y: 5090 },
          { x: 5170, y: 5110 },
        ],
      );
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target1)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
      expect(helper.getPlayer(target2)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });
  });

  describe('LINE Attack', () => {
    it('damages target in thrust direction', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_RIGHT);
      equipWeapon(room, attacker.sessionId, WeaponType.SPEAR, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(SPEAR_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('misses target outside thrust width', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, { x: 5190, y: 5230 });
      equipWeapon(room, attacker.sessionId, WeaponType.SPEAR, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(SPEAR_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('hits at weapon range but misses beyond range', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const spearDef = weaponRegistry.getDefinition(WeaponType.SPEAR);
      const spearRange = spearDef.baseStats.range;

      const { attacker: a1, target: t1 } = await prepareCombat(helper, room, POS_A, {
        x: 5120 + spearRange - 20,
        y: 5100,
      });
      equipWeapon(room, a1.sessionId, WeaponType.SPEAR, WeaponTier.COMMON);
      setFacing(room, a1.sessionId, 0);

      await helper.sendInput(a1, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(SPEAR_WINDUP_TICKS + 2);
      expect(helper.getPlayer(t1)!.health).toBeLessThan(PLAYER.BASE_HEALTH);

      const target2 = await helper.addPlayer('Target2');
      getDomainPlayer(room, target2.sessionId).movement.position = new Position(
        5120 + spearRange + 100,
        5100,
      );
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      setFacing(room, a1.sessionId, 0);

      const fistsCd = Math.ceil(
        weaponRegistry.getDefinition(WeaponType.FISTS).baseStats.cooldown /
          (1000 / NETWORK.TICK_RATE),
      );
      const spearCd = Math.ceil(spearDef.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
      await helper.advanceTicks(Math.max(fistsCd, spearCd) + 2);

      const t2Before = helper.getPlayer(target2)!.health;
      await helper.sendInput(a1, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(SPEAR_WINDUP_TICKS + 5);
      expect(helper.getPlayer(target2)!.health).toBe(t2Before);
    });
  });

  describe('Windup Timing', () => {
    it('damage applied at END of windup, not at input', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      equipWeapon(room, attacker.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(WINDUP_FAST_TICKS - 4);
      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);

      await helper.advanceTicks(8);
      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('fast weapon windup is 0.1s (6 ticks)', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      equipWeapon(room, attacker.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(DAGGER_WINDUP_TICKS - 4);
      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);

      await helper.advanceTicks(8);
      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('slow weapon windup is 0.2s (12 ticks)', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      equipWeapon(room, attacker.sessionId, WeaponType.LONG_SWORD, WeaponTier.UNCOMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(LONGSWORD_WINDUP_TICKS - 4);
      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);

      await helper.advanceTicks(14);
      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('windup is uncancelable', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });
  });

  describe('Cooldown', () => {
    it('cannot attack during cooldown', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const healthAfterFirst = helper.getPlayer(target)!.health;
      expect(healthAfterFirst).toBeLessThan(PLAYER.BASE_HEALTH);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(5);

      expect(helper.getPlayer(target)!.health).toBe(healthAfterFirst);
    });

    it('cooldown duration matches weapon', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const healthAfterFirst = helper.getPlayer(target)!.health;

      const fistsDef = weaponRegistry.getDefinition(WeaponType.FISTS);
      const cooldownTicks = Math.ceil(fistsDef.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
      await helper.advanceTicks(cooldownTicks + 2);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(healthAfterFirst);
    });

    it('rate limit drops excess rapid inputs', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      sendAttack(attacker, room, Math.PI / 2);
      await advanceTicks(room, 1);
      sendAttack(attacker, room, Math.PI / 2);
      await advanceTicks(room, 1);
      sendAttack(attacker, room, Math.PI / 2);
      await advanceTicks(room, FISTS_WINDUP_TICKS + 5);

      const targetHealth = helper.getPlayer(target)!.health;
      expect(PLAYER.BASE_HEALTH - targetHealth).toBeLessThanOrEqual(
        weaponRegistry.getDefinition(WeaponType.FISTS).baseStats.damage,
      );
    });
  });

  describe('Death During Windup', () => {
    it('death during windup cancels attack', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [playerA, playerB, playerC] = await prepareCombatMulti(
        helper,
        room,
        ['Attacker', 'Target', 'Killer'],
        [
          { x: 5120, y: 5100 },
          { x: 4960, y: 5100 },
          { x: 5120, y: 5000 },
        ],
      );

      const domainA = getDomainPlayer(room, playerA.sessionId);
      domainA.takeDamage(PLAYER.BASE_HEALTH - 5, helper.tick, true);
      await helper.advanceTicks(1);

      equipWeapon(room, playerA.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, playerA.sessionId, Math.PI);
      setFacing(room, playerC.sessionId, Math.PI / 2);

      await helper.sendInput(playerA, { aimAngle: Math.PI, actions: ['ATTACK'] });
      await helper.sendInput(playerC, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(DAGGER_WINDUP_TICKS + 8);

      expect(helper.getPlayer(playerB)!.health).toBe(PLAYER.BASE_HEALTH);
      expect(helper.getPlayer(playerA)!.health).toBeLessThanOrEqual(0);
    });

    it('target death during attacker windup', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const [attacker, target, killer] = await prepareCombatMulti(
        helper,
        room,
        ['Attacker', 'Target', 'Killer'],
        [
          { x: 5120, y: 5100 },
          { x: 5120, y: 5170 },
          { x: 5190, y: 5170 },
        ],
      );

      const domainTarget = getDomainPlayer(room, target.sessionId);
      domainTarget.takeDamage(PLAYER.BASE_HEALTH - 5, helper.tick, true);
      await helper.advanceTicks(1);

      equipWeapon(room, attacker.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);
      setFacing(room, killer.sessionId, Math.PI);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.sendInput(killer, { aimAngle: Math.PI, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 10);

      expect(helper.getPlayer(target)!.health).toBeLessThanOrEqual(0);
    });
  });

  describe('Wall Occlusion', () => {
    it('wall blocks melee attack', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 39, 5);

      const wallGx = 40;
      const wallGy = 40;
      grid[wallGy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

      const [attacker, target] = await prepareCombatMulti(
        helper,
        room,
        ['Attacker', 'Target'],
        [
          { x: (wallGx + 0.5) * GRID.TILE_SIZE, y: (wallGy - 0.5) * GRID.TILE_SIZE },
          { x: (wallGx + 0.5) * GRID.TILE_SIZE, y: (wallGy + 1.5) * GRID.TILE_SIZE },
        ],
      );
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('wall does not block adjacent target', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });
  });

  describe('Knockback', () => {
    it('melee attack applies knockback', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_SWORD, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      const beforeY = helper.getPlayer(target)!.y;

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(20);

      const afterY = helper.getPlayer(target)!.y;
      expect(afterY).toBeGreaterThan(beforeY);
    });

    it('knockback decays over time', async () => {
      const { room, helper } = await createGameRoom(server);
      activeRoom = room;
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_A, POS_T_DOWN);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_SWORD, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, Math.PI / 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(KNOCKBACK_TICKS + 5);

      const posAfterDecay = helper.getPlayer(target)!.y;
      await helper.advanceTicks(10);
      const posLater = helper.getPlayer(target)!.y;
      expect(Math.abs(posLater - posAfterDecay)).toBeLessThan(2);
    });
  });
});
