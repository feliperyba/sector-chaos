import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import {
  NETWORK,
  PLAYER,
  PlayerStatus,
  WeaponType,
  WeaponTier,
  MatchPhase,
  TileType,
  weaponRegistry,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { WeaponEntity } from '../../src/domain/entities/index';
import { Position } from '../../src/domain/value-objects/index';

/**
 * Regression: projectiles must not hit ground weapons (GDD §6.2.1 — arrows
 * never interact with ground pickups; the same shared collision paths serve
 * arrows and thrown weapons).
 *
 * Covers the two ways this invariant previously broke visually:
 *  1. weapon sprites entered the merged tile-collision atlas WITH colliders
 *     (typed via resolveTileType's hasColliders→INDESTRUCTIBLE_WALL default),
 *     kept inert only by per-consumer grid-EMPTY guards;
 *  2. weapon pickups hydrated flush against solid cover — projectiles died
 *     against that cover at the shared tile boundary, INSIDE the weapon's
 *     rendered sprite footprint (weapons render at 1.3× the 128px tile).
 */
const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const BOW_COOLDOWN_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.SHORT_BOW).baseStats.cooldown / (1000 / 60),
);
/**
 * Min distance (px) between a weapon pickup center and an arrow death point.
 * With axial cover ≥2 tiles out, death points land ≥100px away; 96px is the
 * weapon sprite half-footprint (1.3 render scale) plus the arrow half-width.
 */
const DEATH_CLEARANCE_PX = 96;

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

function equipBow(room: Room<{ state: GameStateSchema }>, sessionId: string): void {
  const player = getDomainPlayer(room, sessionId);
  const def = weaponRegistry.getDefinition(WeaponType.SHORT_BOW);
  const cd = Math.ceil(def.baseStats.cooldown / (1000 / NETWORK.TICK_RATE));
  const weapon = new WeaponEntity(
    `w-bow-${sessionId}`,
    WeaponType.SHORT_BOW,
    WeaponTier.COMMON,
    9999,
    9999,
    cd,
  );
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
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.WAITING) {
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

function isWalkableTile(t: TileType | undefined): boolean {
  return t === TileType.EMPTY || t === TileType.EXIT;
}

describe('projectiles vs ground weapons', () => {
  it(
    'weapon pickups hydrate with axial clearance from solid cover',
    { timeout: 60_000 },
    async () => {
      const { room } = await createGameRoom(server);
      const match = getMatch(room);
      const grid = match.getGrid();

      for (const wp of match.weaponPickups.values()) {
        const gx = Math.floor(wp.position.x / match.config.map.tileWidth);
        const gy = Math.floor(wp.position.y / match.config.map.tileHeight);
        expect(
          isWalkableTile(grid[gy]?.[gx]),
          `weapon ${wp.id} hydrates on a solid tile (${gx},${gy})`,
        ).toBe(true);
        for (const [dx, dy] of [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ]) {
          expect(
            isWalkableTile(grid[gy + dy]?.[gx + dx]),
            `weapon ${wp.id} at (${gx},${gy}) is flush against solid cover at (${gx + dx},${gy + dy})`,
          ).toBe(true);
        }
      }
    },
  );

  it(
    'weapon sprites carry no colliders in the merged collision atlas (both maps)',
    { timeout: 60_000 },
    async () => {
      for (const mapType of ['procedural', 'demo'] as const) {
        const { room } = await createGameRoom(server, { mapType });
        const match = getMatch(room);
        const data = match.colliderData;
        if (!data) continue;
        for (const wp of match.weaponPickups.values()) {
          const gx = Math.floor(wp.position.x / match.config.map.tileWidth);
          const gy = Math.floor(wp.position.y / match.config.map.tileHeight);
          const visual = data.visuals[gy]?.[gx];
          if (!visual || visual.spriteId < 0) continue;
          const sprite = data.atlas.sprites[visual.spriteId];
          expect(
            sprite?.colliders.length ?? 0,
            `${mapType}: weapon ${wp.id} sprite (${sprite?.imagePath}) carries collision geometry`,
          ).toBe(0);
        }
      }
    },
  );

  it(
    'an arrow fired through any real map weapon pickup passes it',
    { timeout: 120_000 },
    async () => {
      const { room, helper } = await createGameRoom(server);
      const attacker = await helper.addPlayer('Attacker');
      const player = getDomainPlayer(room, attacker.sessionId);
      await helper.advanceTicks(1);
      await helper.advanceTicks(SPAWN_INV_TICKS);
      forceActivePhase(room);
      equipBow(room, attacker.sessionId);

      const match = getMatch(room);
      const pickups = [...match.weaponPickups.values()];

      for (let i = 0; i < pickups.length; i++) {
        const wp = pickups[i]!;
        // Map traps (spikes/fire) grind the teleporting shooter down — keep
        // them alive so every shot actually fires.
        player.health = player.health.heal(PLAYER.BASE_HEALTH);
        player.movement.position = new Position(wp.position.x - 360, wp.position.y - 14);
        player.movement.facingAngle = 0;
        await helper.advanceTicks(2);

        await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });

        // Wait for the arrow to spawn (windup), tolerating a dropped input by
        // retrying once after the full cooldown.
        // Fire and trace. Trap teleports cancel windups and the ATTACK rate
        // limit (100ms) can swallow an early retry, so re-send the ATTACK
        // input periodically until a projectile actually spawns.
        let fired = false;
        let nextSendAt = 0;
        for (let t = 0; t < 200 && !fired; t++) {
          player.statusEffects.clearStatus(PlayerStatus.STAGGERED);
          if (t % 10 === 0) player.health = player.health.heal(PLAYER.BASE_HEALTH);
          // Trap teleports can displace the shooter or leave a stale windup
          // that swallows the re-sent ATTACK — re-pin both before firing.
          const drift =
            Math.abs(player.movement.position.x - (wp.position.x - 360)) +
            Math.abs(player.movement.position.y - (wp.position.y - 14));
          if (t === nextSendAt) {
            if (drift > 200) {
              player.movement.position = new Position(wp.position.x - 360, wp.position.y - 14);
              player.movement.facingAngle = 0;
            }
            player.combat.clearWindup();
            await helper.sendInput(attacker, { aimAngle: 0, actions: ['ATTACK'] });
            nextSendAt = t + 15;
          }
          await helper.advanceTicks(1);
          fired = [...room.state.projectiles.values()].some(
            (p) => p.ownerId === attacker.sessionId,
          );
        }
        expect(
          fired,
          `arrow never fired at weapon ${wp.id} (pickup #${i}) — player active=${player.isActive} dead=${player.health.isDead} staggered=${player.statusEffects.isStaggered()} drift=${drift}`,
        ).toBe(true);

        // Trace until the arrow dies; lastAliveX is at most one tick (33px)
        // behind the true death point.
        let lastAliveX = Number.NaN;
        for (let t = 0; t < 90; t++) {
          const live = [...room.state.projectiles.values()].filter(
            (p) => p.ownerId === attacker.sessionId,
          );
          if (live.length === 0) break;
          lastAliveX = live[0]!.x;
          if (t % 10 === 0) player.health = player.health.heal(PLAYER.BASE_HEALTH);
          await helper.advanceTicks(1);
        }
        expect(Number.isNaN(lastAliveX), `arrow at weapon ${wp.id} (pickup #${i}) never died`).toBe(
          false,
        );
        expect(
          Math.abs(lastAliveX - wp.position.x),
          `arrow died at ${lastAliveX - wp.position.x}px from weapon ${wp.id} (pickup #${i}) — hit the weapon`,
        ).toBeGreaterThanOrEqual(DEATH_CLEARANCE_PX);

        await helper.advanceTicks(BOW_COOLDOWN_TICKS + 5);
      }
    },
  );
});
