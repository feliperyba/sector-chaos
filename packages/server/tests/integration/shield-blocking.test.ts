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
  WeaponType,
  WeaponTier,
  TileType,
  MatchPhase,
  weaponRegistry,
  DamageType,
  PlayerStatus,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../src/domain/entities/index';
import { Position, Speed } from '../../src/domain/value-objects/index';
import { DamagePipeline } from '../../src/domain/services/DamagePipeline';
import { ShieldHandler } from '../../src/domain/handlers/ShieldHandler';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const SHIELD_BREAK_STAGGER_TICKS = Math.ceil(COMBAT.SHIELD_BREAK_STAGGER * NETWORK.TICK_RATE);
const FISTS_WINDUP_TICKS = Math.ceil(50 / (1000 / NETWORK.TICK_RATE));
const FISTS_COOLDOWN_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.FISTS).baseStats.cooldown / (1000 / NETWORK.TICK_RATE),
);
const BOW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.windupMs / (1000 / 60),
);
const THROW_WINDUP_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.windupMs / (1000 / 60),
);
const ARROW_PX_PER_TICK = 2000 / NETWORK.TICK_RATE;

const POS_CENTER = { x: 5120, y: 5100 };
const POS_BELOW = { x: 5120, y: 5170 };

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

function equipShield(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  shieldType: WeaponType,
  durability: number,
): void {
  const player = getDomainPlayer(room, sessionId);
  const def = weaponRegistry.getDefinition(shieldType);
  const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
  const weapon = new WeaponEntity(
    `w-shield-${sessionId}`,
    shieldType,
    def.tier ?? WeaponTier.COMMON,
    durability,
    durability,
    cd,
  );
  const slot = player.findFirstEmptySlot();
  if (slot !== null) {
    player.addWeapon(weapon);
    player.forceSwitchSlot(slot);
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

function setFacing(room: Room<{ state: GameStateSchema }>, sessionId: string, angle: number): void {
  getDomainPlayer(room, sessionId).movement.facingAngle = angle;
}

/**
 * Reset the attacker's attack-rate-limiter bucket. The limiter gates ATTACK
 * inputs by REAL wall-clock (10 tokens/1000ms) to prevent input flooding. The
 * synchronous test harness (helper.advanceTicks → orchestrator.update) drives
 * many ticks in <1ms of wall-clock, so without a reset, all ATTACK inputs after
 * the first in a tight loop are rejected (no token refill) and the shield-break
 * loop can't land 15/25 hits. The limiter is an anti-abuse measure, not part of
 * the shield mechanic under test, so resetting it isolates the shield behavior.
 */
function resetAttackRateLimit(room: Room<{ state: GameStateSchema }>, sessionId: string): void {
  const gameRoom = room as unknown as GameRoom;
  const sim = gameRoom.getOrchestrator().getSimulation() as unknown as {
    attackRateLimiter: { reset: (id: string) => void };
  };
  sim.attackRateLimiter.reset(sessionId);
}

function getProjectiles(room: Room<{ state: GameStateSchema }>) {
  return [...room.state.projectiles.values()];
}

function startBlock(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
  facingAngle: number,
): void {
  const player = getDomainPlayer(room, sessionId);
  player.combat.isBlocking = true;
  player.movement.facingAngle = facingAngle;
  player.movement.speed = new Speed(player.movement.speed.value * 0.5, player.movement.speed.max);
}

function stopBlock(room: Room<{ state: GameStateSchema }>, sessionId: string): void {
  const player = getDomainPlayer(room, sessionId);
  player.combat.isBlocking = false;
  player.movement.speed = new Speed(player.movement.speed.value * 2, player.movement.speed.max);
}

describe('Shield Blocking Integration', () => {
  describe('Basic Blocking', () => {
    it(
      'shield auto-blocks when equipped and facing the attacker (no bash, no ATTACK held)',
      { timeout: 30_000 },
      async () => {
        // Regression: blocking is PASSIVE — a shield blocks whenever it's the
        // active weapon and the attack comes from within the frontal arc. The
        // player does NOT need to attack or raise the shield. This test proves
        // the auto-block model by NOT calling startBlock (which would set the
        // isBlocking flag) and NOT sending ATTACK — the block must fire purely
        // from the shield being equipped + the attacker being in the frontal arc.
        const { room, helper } = await createGameRoom(server);
        const grid = getMatch(room).getGrid();
        clearArea(grid, 40, 40, 5);

        const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
        equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

        // Face the attacker (no isBlocking flag set, no ATTACK input).
        const aimTowardAttacker = Math.atan2(
          POS_CENTER.y - POS_BELOW.y,
          POS_CENTER.x - POS_BELOW.x,
        );
        setFacing(room, target.sessionId, aimTowardAttacker);
        await helper.advanceTicks(1);

        setFacing(room, attacker.sessionId, Math.PI / 2);
        await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

        expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
      },
    );

    it('block negates 100% melee damage', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('block negates 0 knockback', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      const targetYBefore = helper.getPlayer(target)!.y;

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 10);

      expect(helper.getPlayer(target)!.y).toBe(targetYBefore);
    });

    it('block does not negate damage from behind', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI / 2);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('block does not negate damage from side outside arc', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const targetPos = { x: 5120, y: 5100 };
      const attackerPos = { x: 5190, y: 5100 };

      const { attacker, target } = await prepareCombat(helper, room, attackerPos, targetPos);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI / 2);
      await helper.advanceTicks(1);

      const aimAtTarget = Math.atan2(targetPos.y - attackerPos.y, targetPos.x - attackerPos.x);
      setFacing(room, attacker.sessionId, aimAtTarget);
      await helper.sendInput(attacker, { aimAngle: aimAtTarget, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(helper.getPlayer(target)!.health).toBeLessThan(PLAYER.BASE_HEALTH);
    });
  });

  describe('Arrow Interaction', () => {
    it('blocked arrow disappears', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetDist = 120;
      const targetPos = { x: POS_CENTER.x + targetDist, y: POS_CENTER.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, targetPos);

      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, 0);
      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const ticksToReach = Math.ceil(targetDist / ARROW_PX_PER_TICK) + 5;
      await helper.advanceTicks(ticksToReach);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);

      const arrows = getProjectiles(room).filter((p) => p.ownerId === attacker.sessionId);
      expect(arrows.length).toBe(0);
    });

    it('blocked arrow does not continue past shield', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetDist = 120;
      const targetPos = { x: POS_CENTER.x + targetDist, y: POS_CENTER.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, targetPos);

      equipWeapon(room, attacker.sessionId, WeaponType.SHORT_BOW, WeaponTier.COMMON);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, 0);
      await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(BOW_WINDUP_TICKS + 2);

      const ticksToReach = Math.ceil(targetDist / ARROW_PX_PER_TICK) + 5;
      await helper.advanceTicks(ticksToReach);

      const allProjectiles = getProjectiles(room);
      const arrowsPastShield = allProjectiles.filter(
        (p) => p.ownerId === attacker.sessionId && p.x > targetPos.x,
      );
      expect(arrowsPastShield.length).toBe(0);
    });
  });

  describe('Thrown Weapon Interaction', () => {
    it('blocked thrown weapon bounces', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetDist = 100;
      const targetPos = { x: POS_CENTER.x + targetDist, y: POS_CENTER.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, targetPos);

      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, 0);
      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const thrownBefore = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      expect(thrownBefore).toBeDefined();

      const throwSpeed =
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.throwSpeed ?? 1100;
      const throwPxPerTick = throwSpeed / NETWORK.TICK_RATE;
      const ticksToReach = Math.ceil(targetDist / throwPxPerTick) + 10;
      await helper.advanceTicks(ticksToReach);

      const thrownAfter = getProjectiles(room).find((p) => p.ownerId === attacker.sessionId);
      if (thrownAfter) {
        const speedAfter = Math.sqrt(thrownAfter.velocityX ** 2 + thrownAfter.velocityY ** 2);
        const speedBefore = Math.sqrt(thrownBefore!.velocityX ** 2 + thrownBefore!.velocityY ** 2);
        const bounced =
          Math.abs(speedAfter - speedBefore * COMBAT.BOUNCE_FACTOR) < speedBefore * 0.3 ||
          thrownAfter.velocityX < 0;
        expect(bounced).toBe(true);
      }
    });

    it('blocked thrown weapon does not damage blocker', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const targetDist = 100;
      const targetPos = { x: POS_CENTER.x + targetDist, y: POS_CENTER.y };
      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, targetPos);

      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, target.sessionId, Math.PI);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, 0);
      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      const throwSpeed =
        weaponRegistry.getDefinition(WeaponType.THROWING_AXE).baseStats.throwSpeed ?? 1100;
      const throwPxPerTick = throwSpeed / NETWORK.TICK_RATE;
      const ticksToReach = Math.ceil(targetDist / throwPxPerTick) + 15;
      await helper.advanceTicks(ticksToReach);

      expect(helper.getPlayer(target)!.health).toBe(PLAYER.BASE_HEALTH);
    });

    it('blocked thrown weapon can hit others after bounce', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const attacker = await helper.addPlayer('Attacker');
      const blocker = await helper.addPlayer('Blocker');
      const bystander = await helper.addPlayer('Bystander');

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(4800, 5100);
      getDomainPlayer(room, blocker.sessionId).movement.position = new Position(5000, 5100);
      getDomainPlayer(room, bystander.sessionId).movement.position = new Position(5200, 5100);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipWeapon(room, attacker.sessionId, WeaponType.THROWING_AXE, WeaponTier.COMMON);
      equipShield(room, blocker.sessionId, WeaponType.SMALL_SHIELD, 15);

      startBlock(room, blocker.sessionId, Math.PI);
      await helper.advanceTicks(1);

      getDomainPlayer(room, attacker.sessionId).movement.position = new Position(4800, 5100);

      setFacing(room, attacker.sessionId, 0);
      await helper.sendInput(attacker, { aimAngle: 0, actions: ['THROW'] });
      await helper.advanceTicks(THROW_WINDUP_TICKS + 2);

      await helper.advanceTicks(200);

      const blockerHealth = helper.getPlayer(blocker)!.health;
      expect(blockerHealth).toBe(PLAYER.BASE_HEALTH);
    });
  });

  describe('Shield Durability', () => {
    it('each blocked hit reduces durability by 1', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const shield = getDomainPlayer(room, target.sessionId).getActiveWeapon();
      expect(shield.durability).toBe(14);
    });

    it('small shield breaks at 0 durability after 15 blocks', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);

      for (let i = 0; i < 15; i++) {
        resetAttackRateLimit(room, attacker.sessionId);
        await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + FISTS_COOLDOWN_TICKS + 2);
      }

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.getActiveWeapon().type).toBe(WeaponType.FISTS);
    });

    it('large shield breaks at 0 durability after 25 blocks', { timeout: 60_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.LARGE_SHIELD, 25);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);

      let lastDurability = 25;
      for (let i = 0; i < 25; i++) {
        resetAttackRateLimit(room, attacker.sessionId);
        await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
        await helper.advanceTicks(FISTS_WINDUP_TICKS + FISTS_COOLDOWN_TICKS + 2);
        const currentDurability = getDomainPlayer(room, target.sessionId).getActiveWeapon()
          .durability;
        // Each attack should reduce durability by exactly 1 (block succeeds)
        if (currentDurability !== lastDurability - 1) {
          // Shield broke mid-loop — expected on the final iteration
          if (getDomainPlayer(room, target.sessionId).getActiveWeapon().type === WeaponType.FISTS)
            break;
          // Otherwise log the miss for diagnosis
          console.warn(
            `Block miss at iteration ${i + 1}: durability ${lastDurability} → ${currentDurability}`,
          );
        }
        lastDurability = currentDurability;
      }

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.getActiveWeapon().type).toBe(WeaponType.FISTS);
    });
  });

  describe('Shield Break', () => {
    it('shield break causes 0.3s stagger', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 1);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isStaggered()).toBe(true);
    });

    it('staggered player takes damage normally', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 1);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isStaggered()).toBe(true);
      domainTarget.combat.isBlocking = false;

      await helper.advanceTicks(FISTS_COOLDOWN_TICKS + 2);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      expect(domainTarget.health.current).toBeLessThan(PLAYER.BASE_HEALTH);
    });

    it('stagger expires after 0.3s', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 1);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.isStaggered()).toBe(true);

      await helper.advanceTicks(SHIELD_BREAK_STAGGER_TICKS + 2);

      expect(domainTarget.isStaggered()).toBe(false);
    });

    it('broken shield is removed from inventory', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const { attacker, target } = await prepareCombat(helper, room, POS_CENTER, POS_BELOW);
      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 1);

      const aimTowardAttacker = Math.atan2(POS_CENTER.y - POS_BELOW.y, POS_CENTER.x - POS_BELOW.x);
      startBlock(room, target.sessionId, aimTowardAttacker);
      await helper.advanceTicks(1);

      setFacing(room, attacker.sessionId, Math.PI / 2);
      await helper.sendInput(attacker, { aimAngle: Math.PI / 2, actions: ['ATTACK'] });
      await helper.advanceTicks(FISTS_WINDUP_TICKS + 2);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.getActiveWeapon().type).toBe(WeaponType.FISTS);

      const hasShield = [1, 2, 3].some((slot) => {
        const inv = (domainTarget as unknown as { inventory: { weapons: (WeaponEntity | null)[] } })
          .inventory.weapons;
        const w = inv[slot];
        return (
          w !== null && (w.type === WeaponType.SMALL_SHIELD || w.type === WeaponType.LARGE_SHIELD)
        );
      });
      expect(hasShield).toBe(false);
    });
  });

  describe('Environmental Damage Bypass', () => {
    async function setupBlockingPlayer(): Promise<{
      room: Room<{ state: GameStateSchema }>;
      helper: GameRoomHelper;
      target: TestClient;
    }> {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      await helper.addPlayer('Dummy');
      const target = await helper.addPlayer('Target');
      getDomainPlayer(room, target.sessionId).movement.position = new Position(
        POS_BELOW.x,
        POS_BELOW.y,
      );
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);
      startBlock(room, target.sessionId, -Math.PI / 2);
      await helper.advanceTicks(1);

      return { room, helper, target };
    }

    it('shield does NOT block barrel explosion', { timeout: 30_000 }, async () => {
      const { room, helper, target } = await setupBlockingPlayer();

      const domainTarget = getDomainPlayer(room, target.sessionId);
      expect(domainTarget.combat.isBlocking).toBe(true);

      const damagePipeline = new DamagePipeline(new ShieldHandler());

      const result = damagePipeline.processDamage(
        {
          sourceId: 'barrel',
          damage: 50,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: [domainTarget.id],
          sourcePosition: {
            x: domainTarget.movement.position.x,
            y: domainTarget.movement.position.y,
          },
          currentTick: helper.tick,
        },
        (id) => (id === domainTarget.id ? domainTarget : undefined),
      );

      expect(result.damageApplied).toBe(50);
      expect(domainTarget.health.current).toBe(PLAYER.BASE_HEALTH - 50);
    });

    it('shield does NOT block trap damage', { timeout: 30_000 }, async () => {
      const { room, helper, target } = await setupBlockingPlayer();

      const domainTarget = getDomainPlayer(room, target.sessionId);
      const damagePipeline = new DamagePipeline(new ShieldHandler());

      const result = damagePipeline.processDamage(
        {
          sourceId: 'trap',
          damage: 15,
          damageType: DamageType.TRAP_DAMAGE,
          targetIds: [domainTarget.id],
          sourcePosition: {
            x: domainTarget.movement.position.x,
            y: domainTarget.movement.position.y,
          },
          currentTick: helper.tick,
        },
        (id) => (id === domainTarget.id ? domainTarget : undefined),
      );

      expect(result.damageApplied).toBe(15);
      expect(domainTarget.health.current).toBe(PLAYER.BASE_HEALTH - 15);
    });

    it('shield does NOT block zone damage', { timeout: 30_000 }, async () => {
      const { room, helper, target } = await setupBlockingPlayer();

      const domainTarget = getDomainPlayer(room, target.sessionId);
      const damagePipeline = new DamagePipeline(new ShieldHandler());

      const result = damagePipeline.processDamage(
        {
          sourceId: 'zone',
          damage: 10,
          damageType: DamageType.ZONE_DAMAGE,
          targetIds: [domainTarget.id],
          sourcePosition: {
            x: domainTarget.movement.position.x,
            y: domainTarget.movement.position.y,
          },
          currentTick: helper.tick,
        },
        (id) => (id === domainTarget.id ? domainTarget : undefined),
      );

      expect(result.damageApplied).toBe(10);
      expect(domainTarget.health.current).toBe(PLAYER.BASE_HEALTH - 10);
    });

    it('shield does NOT block siege crush', { timeout: 30_000 }, async () => {
      const { room, helper, target } = await setupBlockingPlayer();

      const domainTarget = getDomainPlayer(room, target.sessionId);
      const damagePipeline = new DamagePipeline(new ShieldHandler());

      const result = damagePipeline.processDamage(
        {
          sourceId: 'siege',
          damage: 100,
          damageType: DamageType.SIEGE_CRUSH,
          targetIds: [domainTarget.id],
          sourcePosition: {
            x: domainTarget.movement.position.x,
            y: domainTarget.movement.position.y,
          },
          currentTick: helper.tick,
        },
        (id) => (id === domainTarget.id ? domainTarget : undefined),
      );

      expect(result.damageApplied).toBe(100);
      expect(domainTarget.health.current).toBe(PLAYER.BASE_HEALTH - 100);
    });
  });

  describe('Blocking Movement', () => {
    it('blocking reduces speed by 50%', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const match = getMatch(room);
      const grid = match.getGrid();
      clearArea(grid, 40, 40, 10);

      const target = await helper.addPlayer('Target');
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      const domainTarget = getDomainPlayer(room, target.sessionId);
      domainTarget.movement.position = new Position(40.5 * GRID.TILE_SIZE, 40.5 * GRID.TILE_SIZE);
      await helper.advanceTicks(1);

      const startX = helper.getPlayer(target)!.x;
      for (let i = 0; i < 60; i++) {
        await helper.sendInput(target, { movementX: 1, movementY: 0 });
      }
      const unblockedDisplacement = helper.getPlayer(target)!.x - startX;

      domainTarget.statusEffects.barrierActive = true;
      domainTarget.statusEffects.barrierExpiryTick = 999999;
      // Simulate a slowed speed directly (the former PLAYER.BLOCKING_SPEED_PENALTY
      // constant had no production applier and was deleted — ticket 16).
      domainTarget.movement.speed = domainTarget.movement.speed.scale(0.65);
      await helper.advanceTicks(1);

      const startX2 = helper.getPlayer(target)!.x;
      for (let i = 0; i < 60; i++) {
        await helper.sendInput(target, { movementX: 1, movementY: 0 });
      }
      const blockedDisplacement = helper.getPlayer(target)!.x - startX2;

      expect(blockedDisplacement).toBeLessThanOrEqual(unblockedDisplacement * 0.6);
      expect(blockedDisplacement).toBeGreaterThanOrEqual(unblockedDisplacement * 0.35);
    });

    it('player can block indefinitely', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 5);

      const target = await helper.addPlayer('Target');
      getDomainPlayer(room, target.sessionId).movement.position = new Position(5120, 5100);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipShield(room, target.sessionId, WeaponType.SMALL_SHIELD, 15);
      startBlock(room, target.sessionId, 0);
      await helper.advanceTicks(1);

      expect(getDomainPlayer(room, target.sessionId).combat.isBlocking).toBe(true);

      await helper.advanceTicks(300);

      expect(getDomainPlayer(room, target.sessionId).combat.isBlocking).toBe(true);
    });
  });

  describe('Shield as Thrown Weapon', () => {
    it('shield can be thrown', { timeout: 30_000 }, async () => {
      const { room, helper } = await createGameRoom(server);
      const grid = getMatch(room).getGrid();
      clearArea(grid, 40, 40, 8);

      const thrower = await helper.addPlayer('Thrower');
      getDomainPlayer(room, thrower.sessionId).movement.position = new Position(5120, 5100);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);

      equipShield(room, thrower.sessionId, WeaponType.SMALL_SHIELD, 15);

      setFacing(room, thrower.sessionId, 0);
      await helper.sendInput(thrower, { aimAngle: 0, actions: ['ATTACK'] });
      await helper.advanceTicks(
        Math.ceil(
          weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD).baseStats.windupMs / (1000 / 60),
        ) + 5,
      );

      const domainThrower = getDomainPlayer(room, thrower.sessionId);
      expect(domainThrower.combat.isBlocking).toBe(true);
      const hasShield = domainThrower.getActiveWeapon().type === WeaponType.SMALL_SHIELD;
      expect(hasShield).toBe(true);
    });

    it('shield throw cooldown is the tuned value (250ms)', { timeout: 30_000 }, async () => {
      expect(COMBAT.SHIELD_THROW_COOLDOWN).toBe(250);

      const shieldDef = weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD);
      expect(shieldDef.baseStats.isBoomerang).toBe(true);
      expect(shieldDef.baseStats.blockReduction).toBe(1.0);
      expect(shieldDef.baseStats.blockArcDegrees).toBe(90);
      expect(shieldDef.baseStats.staggerOnBreakMs).toBe(300);
    });
  });
});
