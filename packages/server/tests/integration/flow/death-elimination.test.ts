import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../../helpers/game-room-helper';
import {
  PLAYER,
  NETWORK,
  COMBAT,
  GRID,
  WeaponType,
  WeaponTier,
  TileType,
  MatchPhase,
  PlayerStatus,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../../src/room/GameRoom';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../../src/domain/entities/index';
import { Position } from '../../../src/domain/value-objects/index';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const DEATH_ANIM_TICKS = Math.ceil(COMBAT.DEATH_ANIMATION_DURATION * NETWORK.TICK_RATE);
const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const BOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.windupMs / (1000 / 60),
);
const ARROW_PX_PER_TICK = 2000 / NETWORK.TICK_RATE;

const POS_A = { x: 5120, y: 5100 };
const POS_B = { x: 5120, y: 5170 };
const POS_C = { x: 5190, y: 5100 };

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
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

/** Clear both the tile grid AND colliderData visuals — stale sprite refs in
 *  colliderData.visuals cause projectiles to collide with invisible walls. */
function clearAreaAndColliders(
  room: Room<{ state: GameStateSchema }>,
  cx: number,
  cy: number,
  radius: number,
): void {
  const match = getMatch(room);
  const grid = match.getGrid();
  clearArea(grid, cx, cy, radius);
  if (match.colliderData) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gy = cy + dy;
        const gx = cx + dx;
        const row = match.colliderData.visuals[gy];
        if (row) row[gx] = { spriteId: -1, rotation: 0, flipH: false, flipV: false };
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
    setLastStandingThreshold: (n: number) => void;
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
  orch.setLastStandingThreshold(-1);
  gameRoom.syncState();
}

async function setupTwoPlayers(
  helper: GameRoomHelper,
  room: Room<{ state: GameStateSchema }>,
): Promise<{ attacker: TestClient; target: TestClient }> {
  const attacker = await helper.addPlayer('Attacker');
  const target = await helper.addPlayer('Target');
  getDomainPlayer(room, attacker.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
  getDomainPlayer(room, target.sessionId).movement.position = new Position(POS_B.x, POS_B.y);
  await helper.advanceTicks(1);
  await helper.advanceTicks(SPAWN_INV_TICKS);
  forceActivePhase(room);
  return { attacker, target };
}

function killPlayerDirect(
  room: Room<{ state: GameStateSchema }>,
  targetId: string,
  killerId: string,
  weaponType: WeaponType,
  tick: number,
): void {
  const target = getDomainPlayer(room, targetId);
  target.statusEffects.lastDamageSource = {
    playerId: killerId,
    weaponType: String(weaponType),
    tick,
  };
  target.takeDamage(PLAYER.BASE_HEALTH, tick, true);
}

describe('Death & Elimination Flow', () => {
  describe('Death State Transition', () => {
    it('player dies at HP=0: DYING -> SPECTATING', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(2);
      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isDying()).toBe(true);
      expect(domainTarget.statusEffects.status & PlayerStatus.DYING).toBe(PlayerStatus.DYING);

      await helper.advanceTicks(DEATH_ANIM_TICKS + 2);
      expect(domainTarget.isSpectating()).toBe(true);
      expect(domainTarget.statusEffects.status & PlayerStatus.SPECTATING).toBe(
        PlayerStatus.SPECTATING,
      );
    });

    it('death animation duration is 0.5s (30 ticks)', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);

      await helper.advanceTicks(2);
      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isDying()).toBe(true);
      const dyingTick = domainTarget.statusEffects.deathTick;

      let spectatingTick = -1;
      for (let i = 0; i < DEATH_ANIM_TICKS + 10; i++) {
        await helper.advanceTicks(1);
        if (domainTarget.isSpectating()) {
          spectatingTick = helper.tick;
          break;
        }
      }

      expect(spectatingTick).toBeGreaterThan(dyingTick);
      const duration = spectatingTick - dyingTick;
      expect(duration).toBeGreaterThanOrEqual(DEATH_ANIM_TICKS - 2);
      expect(duration).toBeLessThanOrEqual(DEATH_ANIM_TICKS + 2);
      expect(COMBAT.DEATH_ANIMATION_DURATION).toBe(0.5);
    });
  });

  describe('Weapon Drop on Death', () => {
    it('weapons dropped on death as ground pickups', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      equipWeapon(room, target.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      const pickupsBefore = [...room.state.weaponPickups.values()].length;

      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(2);

      const pickupsAfter = [...room.state.weaponPickups.values()];
      expect(pickupsAfter.length).toBeGreaterThan(pickupsBefore);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
        expect(domainTarget.inventory.weapons[i]).toBeNull();
      }
    });

    it('all inventory weapons dropped', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      equipWeapon(room, target.sessionId, WeaponType.DAGGER, WeaponTier.COMMON);
      equipWeapon(room, target.sessionId, WeaponType.SHORT_SWORD, WeaponTier.COMMON);
      const pickupsBefore = [...room.state.weaponPickups.values()].length;

      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(2);

      const pickupsAfter = [...room.state.weaponPickups.values()];
      expect(pickupsAfter.length - pickupsBefore).toBeGreaterThanOrEqual(2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      for (let i = 1; i < PLAYER.INVENTORY_SIZE; i++) {
        expect(domainTarget.inventory.weapons[i]).toBeNull();
      }
    });
  });

  describe('Kill Feed & Elimination Records', () => {
    it('elimination record created on kill', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 5);

      const records = [...room.state.eliminationRecords.values()];
      expect(records.length).toBeGreaterThanOrEqual(1);

      const record = records.find((r) => r.playerId === target.sessionId);
      expect(record).toBeDefined();
      expect(record!.killerId).toBe(attacker.sessionId);
    });

    it('killer kills counter incremented and record fields correct', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 5);

      const domainAttacker = getDomainPlayer(room, attacker.sessionId);
      expect(domainAttacker.kills).toBe(1);

      const records = [...room.state.eliminationRecords.values()];
      const record = records.find((r) => r.playerId === target.sessionId);
      expect(record).toBeDefined();
      expect(record!.playerId).toBe(target.sessionId);
      expect(record!.killerId).toBe(attacker.sessionId);
      expect(record!.order).toBeGreaterThan(0);
      expect(record!.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Posthumous Kills', () => {
    it('projectiles in flight continue after attacker death', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      // Use clearAreaAndColliders so stale collider visuals don't block arrows.
      clearAreaAndColliders(room, 40, 40, 8);

      const p1 = await helper.addPlayer('Shooter');
      const p2 = await helper.addPlayer('Target');
      const p3 = await helper.addPlayer('Killer');
      getDomainPlayer(room, p1.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
      // Place p2 OFF the arrow's flight path (above, not in line) so the
      // arrow stays in flight after p1 dies. The test verifies projectiles
      // persist after attacker death, not that they hit a target.
      getDomainPlayer(room, p2.sessionId).movement.position = new Position(POS_A.x, POS_A.y - 500);
      getDomainPlayer(room, p3.sessionId).movement.position = new Position(POS_A.x, POS_A.y - 100);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipWeapon(room, p1.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      getDomainPlayer(room, p1.sessionId).movement.facingAngle = 0;

      await helper.sendInput(p1, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const arrow = [...room.state.projectiles.values()].find((p) => p.ownerId === p1.sessionId);
      expect(arrow).toBeDefined();

      getDomainPlayer(room, p1.sessionId).statusEffects.lastDamageSource = {
        playerId: p3.sessionId,
        weaponType: String(WeaponType.FISTS),
        tick: helper.tick,
      };
      getDomainPlayer(room, p1.sessionId).takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      await helper.advanceTicks(5);

      const arrowAfter = [...room.state.projectiles.values()].find(
        (p) => p.ownerId === p1.sessionId,
      );
      expect(arrowAfter).toBeDefined();
    });

    it('posthumous kill credited to dead attacker', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      // clearAreaAndColliders (not plain clearArea): stale sprite colliders in
      // colliderData.visuals destroy arrows mid-flight — see the sibling test
      // above ("projectiles in flight continue after attacker death").
      clearAreaAndColliders(room, 40, 40, 8);

      const p1 = await helper.addPlayer('Shooter');
      const p2 = await helper.addPlayer('Killer');
      const p3 = await helper.addPlayer('Victim');
      getDomainPlayer(room, p1.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
      getDomainPlayer(room, p2.sessionId).movement.position = new Position(POS_A.x, POS_A.y - 100);
      // p3 starts OFF the arrow's flight path (above it, like the sibling
      // test's p2): at exactly +200px on-path, the arrow reaches the victim on
      // the very tick this test asserts "arrow in flight" (spawn at hand+87px,
      // ~34px/tick), which made the assertion a 1-tick coin flip. It is moved
      // onto the path only after the in-flight assertion.
      getDomainPlayer(room, p3.sessionId).movement.position = new Position(
        POS_A.x + 200,
        POS_A.y - 500,
      );
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      const domainP3 = getDomainPlayer(room, p3.sessionId);
      domainP3.takeDamage(PLAYER.BASE_HEALTH - 10, helper.tick, true);
      await helper.advanceTicks(1);

      equipWeapon(room, p1.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      getDomainPlayer(room, p1.sessionId).movement.facingAngle = 0;

      await helper.sendInput(p1, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const arrow = [...room.state.projectiles.values()].find((p) => p.ownerId === p1.sessionId);
      expect(arrow).toBeDefined();

      // Victim onto the flight path now that the arrow is verified in flight.
      getDomainPlayer(room, p3.sessionId).movement.position = new Position(
        POS_A.x + 200,
        POS_A.y,
      );

      getDomainPlayer(room, p1.sessionId).statusEffects.lastDamageSource = {
        playerId: p2.sessionId,
        weaponType: String(WeaponType.FISTS),
        tick: helper.tick,
      };
      getDomainPlayer(room, p1.sessionId).takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);

      const ticksToReach = Math.ceil(200 / ARROW_PX_PER_TICK) + 10;
      await helper.advanceTicks(ticksToReach);

      expect(domainP3.health.current).toBeLessThanOrEqual(0);

      const domainP1 = getDomainPlayer(room, p1.sessionId);
      expect(domainP1.kills).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Dead Body Collision', () => {
    it('dead body retains collision during DYING', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isDying()).toBe(true);
      expect(COMBAT.DEAD_BODY_COLLISION).toBe(true);
      expect(domainTarget.hasDeathCollision(helper.tick)).toBe(true);
    });

    it('dead body collision removed after SPECTATING', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(DEATH_ANIM_TICKS + 5);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isSpectating()).toBe(true);
      expect(domainTarget.hasDeathCollision(helper.tick)).toBe(false);
    });
  });

  describe('Dead Body Removed by Siege Wall', () => {
    it('early SPECTATING when death animation cut short', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      await helper.advanceTicks(2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isDying()).toBe(true);
      expect(domainTarget.hasDeathCollision(helper.tick)).toBe(true);

      domainTarget.completeDeath();

      expect(domainTarget.isSpectating()).toBe(true);
      expect(domainTarget.hasDeathCollision(helper.tick)).toBe(false);
    });
  });

  describe('Spectator Auto-Follow', () => {
    it('spectator auto-follows killer', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await setupTwoPlayers(helper, room);
      killPlayerDirect(room, target.sessionId, attacker.sessionId, WeaponType.DAGGER, helper.tick);
      // Use advanceTicksWithRoom to run the full simulation tick handler,
      // which includes sendSpectatingTransitions (sets spectatorFollowTargets).
      await helper.advanceTicksWithRoom(DEATH_ANIM_TICKS + 5);

      const gameRoom = room as unknown as { spectatorFollowTargets: Map<string, string> };
      expect(gameRoom.spectatorFollowTargets.has(target.sessionId)).toBe(true);
      expect(gameRoom.spectatorFollowTargets.get(target.sessionId)).toBe(attacker.sessionId);
    });

    it('spectator follow target can be switched', async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const p1 = await helper.addPlayer('Player1');
      const p2 = await helper.addPlayer('Player2');
      const p3 = await helper.addPlayer('Player3');
      getDomainPlayer(room, p1.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
      getDomainPlayer(room, p2.sessionId).movement.position = new Position(POS_B.x, POS_B.y);
      getDomainPlayer(room, p3.sessionId).movement.position = new Position(POS_C.x, POS_C.y);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      killPlayerDirect(room, p2.sessionId, p1.sessionId, WeaponType.DAGGER, helper.tick);
      // Use advanceTicksWithRoom to run the full simulation tick handler,
      // which includes sendSpectatingTransitions (sets spectatorFollowTargets).
      await helper.advanceTicksWithRoom(DEATH_ANIM_TICKS + 5);

      const gameRoom = room as unknown as { spectatorFollowTargets: Map<string, string> };
      expect(gameRoom.spectatorFollowTargets.get(p2.sessionId)).toBe(p1.sessionId);

      gameRoom.spectatorFollowTargets.set(p2.sessionId, p3.sessionId);
      expect(gameRoom.spectatorFollowTargets.get(p2.sessionId)).toBe(p3.sessionId);
    });
  });
});
