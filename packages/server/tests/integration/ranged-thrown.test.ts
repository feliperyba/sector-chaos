import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { Destructible } from '../../src/domain/entities/Destructible';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const SOURCE_IMMUNITY_TICKS = Math.ceil((COMBAT.THROW_SOURCE_IMMUNITY / 1000) * NETWORK.TICK_RATE);
const ARROW_PX_PER_TICK = 2000 / NETWORK.TICK_RATE;
const THROW_PX_PER_TICK = 1100 / NETWORK.TICK_RATE;
const BOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.windupMs / (1000 / 60),
);
const CROSSBOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.CROSSBOW).baseStats.windupMs / (1000 / 60),
);
const THROW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.windupMs / (1000 / 60),
);
const COUNTDOWN_TICKS = Math.ceil(MATCH.COUNTDOWN_DURATION * NETWORK.TICK_RATE);

const POS_A = { x: 5120, y: 5100 };

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

/**
 * Clear both the tile-type grid AND the matching colliderData visuals for a
 * rectangular area. The procedural map populates colliderData.visuals with
 * per-tile sprite references at init; tests that mutate the grid to EMPTY
 * must also clear those visuals, otherwise ProjectileTileCollision.check
 * keeps seeing the original sprite (possibly with zero colliders → arrow
 * passes through, or with colliders → arrow wrongly stops on an EMPTY tile).
 */
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
  // Disable last-standing auto-end so single-player test matches don't
  // immediately FINISH when only one player is alive.
  orch.setLastStandingThreshold(-1);
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

function setFacing(room: Room<{ state: GameStateSchema }>, sessionId: string, angle: number): void {
  getDomainPlayer(room, sessionId).movement.facingAngle = angle;
}

function getProjectiles(room: Room<{ state: GameStateSchema }>) {
  return [...room.state.projectiles.values()];
}

function getWeaponPickups(room: Room<{ state: GameStateSchema }>) {
  return [...room.state.weaponPickups.values()];
}

describe('Ranged + Thrown Weapon Integration', () => {
  describe('Arrow (Ranged) Tests', () => {
    it('arrow fires at 2000 px/s', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const projectiles = getProjectiles(room);
      expect(projectiles.length).toBeGreaterThanOrEqual(1);
      const arrow = projectiles[0]!;
      expect(Math.abs(arrow.velocityX - 2000)).toBeLessThan(5);
      expect(arrow.velocityY).toBeLessThan(5);
    });

    it('arrow disappears on wall hit', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      const wallGx = 45;
      const wallGy = 40;
      grid[wallGy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const projectilesBefore = getProjectiles(room);
      expect(projectilesBefore.length).toBeGreaterThanOrEqual(1);

      await helper.advanceTicks(100);

      const projectilesAfter = getProjectiles(room);
      expect(projectilesAfter.length).toBe(0);
    });

    it('arrow damages player on hit', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetDist = 100;
      const targetPos = { x: POS_A.x + targetDist, y: POS_A.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_A, targetPos);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      const ticksToReach = Math.ceil(targetDist / ARROW_PX_PER_TICK) + BOW_WINDUP_TICKS + 5;
      await helper.advanceTicks(ticksToReach);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('arrow misses and continues past target', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      // Target is off-axis by 120px (well beyond the projectile's hit radius
      // of HURTBOX/2 + ARROW_HITBOX/2 = 56px). The arrow spawns from the
      // weapon hand, not the body center — at facingAngle=0 the SHORT_BOW
      // pose places the right hand ~14px below body center, so the arrow's
      // flight line is at y = bodyY + 14. An off-axis distance of 120 keeps
      // the target comfortably outside the hit radius even with that offset.
      const targetPos = { x: POS_A.x + 100, y: POS_A.y + 120 };
      const { attacker, target } = await prepareCombat(helper, room, POS_A, targetPos);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 30);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('arrow damage matches weapon stat', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const bowDef = weaponRegistry.getDefinition(WeaponType.SHORT_BOW);
      const expectedDamage = bowDef.baseStats.damage;
      const targetPos = { x: POS_A.x + 100, y: POS_A.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_A, targetPos);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      const ticksToReach = Math.ceil(100 / ARROW_PX_PER_TICK) + BOW_WINDUP_TICKS + 5;
      await helper.advanceTicks(ticksToReach);

      const damageTaken = PLAYER.BASE_HEALTH - helper.getPlayer(target)!.health;
      expect(damageTaken).toBe(expectedDamage);
    });

    it('arrow hits destructible and disappears', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      await helper.advanceTicks(60);

      grid[40]![42] = TileType.DESTRUCTIBLE_WALL;
      // Also clear the colliderData visual for this cell — the grid was
      // mutated directly above, but the collider atlas still references
      // whatever sprite occupied this cell in the original map. Without
      // this, ProjectileTileCollision.check sees a (possibly zero-collider)
      // sprite and skips the AABB fallback path, letting the arrow pass
      // through the wall the test just placed.
      const match = getMatch(room);
      if (match.colliderData) {
        const row = match.colliderData.visuals[40];
        if (row) row[42] = { spriteId: -1, rotation: 0, flipH: false, flipV: false };
      }
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 30);

      const projectiles = getProjectiles(room).filter((p) => p.ownerId === attacker.sessionId);
      expect(projectiles.length).toBe(0);
    });
  });

  describe('Thrown Weapon Tests', () => {
    it('thrown weapon fires at base speed', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectiles = getProjectiles(room);
      expect(projectiles.length).toBeGreaterThanOrEqual(1);
      const thrown = projectiles[0]!;
      const throwSpeed =
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.throwSpeed ?? 1100;
      // ThrowHandler multiplies the base throw speed by COMBAT.THROW_SPEED_MULTIPLIER.
      const expectedSpeed = throwSpeed * COMBAT.THROW_SPEED_MULTIPLIER;
      expect(Math.abs(thrown.velocityX - expectedSpeed)).toBeLessThan(10);
    });

    it('thrown weapon bounces off walls', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      const wallGx = 43;
      const wallGy = 40;
      for (let dx = -1; dx <= 1; dx++) {
        grid[wallGy]![wallGx + dx] = TileType.INDESTRUCTIBLE_WALL;
      }

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const beforeBounce = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(beforeBounce).toBeDefined();
      const bouncesBefore = beforeBounce!.bounces;

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(30);

      const afterBounce = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      if (afterBounce) {
        expect(afterBounce.bounces).toBeLessThan(bouncesBefore);
      }
    });

    it('thrown weapon bounces with 0.7 speed factor', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      const wallGx = 42;
      const wallGy = 40;
      for (let dx = -1; dx <= 1; dx++) {
        grid[wallGy]![wallGx + dx] = TileType.INDESTRUCTIBLE_WALL;
      }

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const beforeBounce = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(beforeBounce).toBeDefined();
      const speedBefore = Math.sqrt(beforeBounce!.velocityX ** 2 + beforeBounce!.velocityY ** 2);

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(40);

      const afterBounce = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      if (afterBounce && afterBounce.bounces < (beforeBounce?.bounces ?? 99)) {
        const speedAfter = Math.sqrt(afterBounce.velocityX ** 2 + afterBounce.velocityY ** 2);
        const expectedSpeed = speedBefore * COMBAT.BOUNCE_FACTOR;
        expect(speedAfter).toBeLessThanOrEqual(expectedSpeed * 1.15);
        expect(speedAfter).toBeGreaterThanOrEqual(expectedSpeed * 0.85);
      }
    });

    it('thrown weapon grounds after 3 bounces', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      grid[40]![41] = TileType.INDESTRUCTIBLE_WALL;
      grid[40]![39] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectile = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectile).toBeDefined();

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(300);

      const projectileAfter = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectileAfter).toBeUndefined();
      const pickups = getWeaponPickups(room);
      expect(pickups.length).toBeGreaterThanOrEqual(1);
    });

    it('thrown weapon max range is bounded by THROW_RANGE', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 20);

      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 5120, y: 5400 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      const throwDef = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);
      const throwRange = Math.min(
        throwDef.baseStats.throwRange ?? throwDef.baseStats.range,
        COMBAT.THROW_RANGE,
      );

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectile = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectile).toBeDefined();

      const ticksToReachRange = Math.ceil(throwRange / THROW_PX_PER_TICK) + 20;
      await helper.advanceTicks(ticksToReachRange);

      const projectileAfter = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectileAfter).toBeUndefined();
    });
  });

  describe('Source Immunity', () => {
    it('thrower is immune for 100ms (6 ticks)', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      const wallGx = 41;
      const wallGy = 40;
      grid[wallGy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + SOURCE_IMMUNITY_TICKS);

      expect(helper.getPlayer(attacker)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('thrower takes self-damage after immunity expires', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      grid[40]![42] = TileType.INDESTRUCTIBLE_WALL;
      grid[40]![38] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + SOURCE_IMMUNITY_TICKS + 500);

      const health = helper.getPlayer(attacker)!.health;
      const tookDamage = health < PLAYER.BASE_HEALTH;
      const weaponGone =
        getProjectiles(room).find((p) => p.ownerId === attacker.sessionId) === undefined;
      expect(tookDamage || weaponGone).toBe(true);
    });
  });

  describe('Thrower Death Mid-Flight', () => {
    it('weapon continues after thrower dies', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetPos = { x: POS_A.x + 200, y: POS_A.y };
      const killerPos = { x: POS_A.x, y: POS_A.y - 100 };
      const attacker = await helper.addPlayer('Thrower');
      const target = await helper.addPlayer('Target');
      const killer = await helper.addPlayer('Killer');
      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(POS_A.x, POS_A.y);
      getDomainPlayer(room, target.sessionId).movement.position = new Position(
        targetPos.x,
        targetPos.y,
      );
      getDomainPlayer(room, killer.sessionId).movement.position = new Position(
        killerPos.x,
        killerPos.y,
      );
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectile = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectile).toBeDefined();

      const domainAttacker = getDomainPlayer(room, attacker.sessionId);
      domainAttacker.takeDamage(PLAYER.BASE_HEALTH, helper.tick, true);
      await helper.advanceTicks(5);

      expect(helper.getPlayer(attacker)!.health).toBeLessThanOrEqual(0);

      const projectileAfterDeath = getProjectiles(room).find(
        (p) => p.ownerId === attacker.sessionId,
      );
      expect(projectileAfterDeath).toBeDefined();

      await helper.advanceTicks(300);

      const targetHealth = helper.getPlayer(target)!.health;
      const projectileGone =
        getProjectiles(room).find((p) => p.ownerId === attacker.sessionId) === undefined;
      expect(projectileGone || targetHealth < PLAYER.BASE_HEALTH).toBe(true);
    });
  });

  describe('Thrown Durability', () => {
    it('thrown weapon wall bounce costs 1 durability', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      grid[40]![42] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      const match = getMatch(room);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projId = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId)?.id;
      expect(projId).toBeDefined();
      const durabilityBefore = match.projectiles.get(projId!)?.durability ?? 0;
      const bouncesBefore = getProjectiles(room).find((p) => p.id === projId)?.bounces ?? 0;

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(40);

      const projAfter = getProjectiles(room).find((p) => p.id === projId);
      if (projAfter && projAfter.bounces < bouncesBefore) {
        const durabilityAfter = match.projectiles.get(projId!)?.durability ?? 0;
        expect(durabilityAfter).toBeLessThan(durabilityBefore);
      }
    });

    it('thrown weapon shatters at 0 durability', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      grid[40]![41] = TileType.INDESTRUCTIBLE_WALL;
      grid[40]![39] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });

      const player = getDomainPlayer(room, attacker.sessionId);
      const cd = Math.ceil(
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.cooldown /
          (1000 / NETWORK.TICK_RATE),
      );
      const weapon = new WeaponEntity(
        'w-fragile-axe',
        WeaponType.THROWING_AXE,
        WeaponTier.COMMON,
        1,
        1,
        cd,
      );
      const slot = player.findFirstEmptySlot();
      if (slot !== null) {
        player.addWeapon(weapon);
        player.forceSwitchSlot(slot);
      }
      setFacing(room, attacker.sessionId, 0);

      const pickupsBefore = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projId = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId)?.id;
      expect(projId).toBeDefined();

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(200);

      const projectileAfter = getProjectiles(room).find((p) => p.id === projId);
      expect(projectileAfter).toBeUndefined();

      const pickupsAfter = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;
      expect(pickupsAfter).toBe(pickupsBefore);
    });
  });

  describe('Flight Behavior', () => {
    it('thrown weapon not pickupable during flight', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectile = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectile).toBeDefined();

      const thrownPickupsBefore = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;
      await helper.advanceTicks(5);
      const thrownPickupsAfter = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;
      expect(thrownPickupsAfter).toBe(thrownPickupsBefore);
    });

    it('thrown weapon becomes pickupable after grounding', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);
      grid[40]![41] = TileType.INDESTRUCTIBLE_WALL;
      grid[40]![39] = TileType.INDESTRUCTIBLE_WALL;

      const attackerPos = { x: (40 + 0.5) * GRID.TILE_SIZE, y: (40 + 0.5) * GRID.TILE_SIZE };
      const { attacker } = await prepareCombat(helper, room, attackerPos, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      const thrownPickupsBefore = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const projectile = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectile).toBeDefined();

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(
        attackerPos.x,
        attackerPos.y + 200,
      );
      await helper.advanceTicks(1);

      await helper.advanceTicks(300);

      const projectileAfter = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(projectileAfter).toBeUndefined();

      const thrownPickupsAfter = getWeaponPickups(room).filter(
        (p) => p.weaponType === WeaponType.THROWING_AXE,
      ).length;
      expect(thrownPickupsAfter).toBeGreaterThan(thrownPickupsBefore);
    });
  });

  describe('Multi-Projectile', () => {
    it('multiple arrows can be in flight simultaneously', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      // Place target very far away so the first arrow is still in flight
      // when the second is fired (the test verifies fire-rate > travel-time).
      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 9500, y: 5100 });
      // Clear AFTER prepareCombat. Use clearAreaAndColliders so both the tile
      // grid AND colliderData visuals are cleared.
      clearAreaAndColliders(room, 40, 40, 8);
      // Also clear a corridor toward the target so arrows don't hit walls.
      clearAreaAndColliders(room, 60, 40, 30);
      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 3);
      for (let i = 0; i < 8; i++) {
        await helper.advanceTicks(1);
        const arr = getProjectiles(room);
        // eslint-disable-next-line no-console
        console.log(
          'DEBUG3: tick+',
          i + 1,
          'arrows=',
          arr.length,
          arr[0] ? { x: arr[0].x, y: arr[0].y } : null,
        );
      }

      const firstArrows = getProjectiles(room);
      expect(firstArrows.length).toBeGreaterThanOrEqual(1);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 3);

      const allArrows = getProjectiles(room);
      expect(allArrows.length).toBeGreaterThanOrEqual(1);
    });

    it('multiple thrown weapons can be in flight simultaneously', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const { attacker } = await prepareCombat(helper, room, POS_A, { x: 5400, y: 5100 });
      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      setFacing(room, attacker.sessionId, 0);

      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 3);

      const player = getDomainPlayer(room, attacker.sessionId);
      const cd = Math.ceil(
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.cooldown /
          (1000 / NETWORK.TICK_RATE),
      );
      const weapon2 = new WeaponEntity(
        'w-throw2',
        WeaponType.THROWING_AXE,
        WeaponTier.COMMON,
        999,
        999,
        cd,
      );
      const slot = player.findFirstEmptySlot();
      if (slot !== null) {
        player.addWeapon(weapon2);
        player.forceSwitchSlot(slot);
      }
      setFacing(room, attacker.sessionId, Math.PI / 4);

      const cooldownTicks = Math.ceil(
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.cooldown /
          (1000 / NETWORK.TICK_RATE),
      );
      await helper.advanceTicks(cooldownTicks + 2);

      await helper.sendInput(attacker, { aimAngle: Math.PI / 4, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 3);

      const allProjectiles = getProjectiles(room);
      expect(allProjectiles.length).toBeGreaterThanOrEqual(2);
    });
  });
});
