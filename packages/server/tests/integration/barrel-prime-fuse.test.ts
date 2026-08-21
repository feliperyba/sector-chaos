import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { advanceTicks } from '../helpers/test-utils';
import {
  PLAYER,
  NETWORK,
  GRID,
  BARREL,
  TileType,
  MatchPhase,
  weaponRegistry,
  WeaponType,
} from '@sector-battle/shared';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator';
import type { MapSiegeService } from '../../src/domain/services/MapSiegeService';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { Position } from '../../src/domain/value-objects/index';
import { Destructible } from '../../src/domain/entities/Destructible';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const FISTS_WINDUP_TICKS = Math.ceil(50 / (1000 / NETWORK.TICK_RATE));
const FISTS_COOLDOWN_TICKS = Math.ceil(
  weaponRegistry.getDefinition(WeaponType.FISTS).baseStats.cooldown / (1000 / NETWORK.TICK_RATE),
);

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

function clearEntities(match: GameMatch): void {
  const state = match.getState();
  state.traps.clear();
  state.destructibles.clear();
  state.chests.clear();
  state.weaponPickups.clear();
  state.powerUps.clear();
  state.explosions.clear();
  state.projectiles.clear();
}

function tileCenter(gx: number, gy: number): Position {
  return new Position((gx + 0.5) * GRID.TILE_SIZE, (gy + 0.5) * GRID.TILE_SIZE);
}

const TEST_COLLIDER_SPRITE_ID = 9998;
function registerTestCollider(match: GameMatch, destructible: Destructible): void {
  if (!match.colliderData) return;
  const atlas = match.colliderData.atlas;
  if (!atlas.sprites[TEST_COLLIDER_SPRITE_ID]) {
    atlas.sprites[TEST_COLLIDER_SPRITE_ID] = {
      id: TEST_COLLIDER_SPRITE_ID,
      imagePath: 'test-destructible',
      tileType: TileType.DESTRUCTIBLE_CRATE,
      colliders: [{ type: 'rect', x: 0, y: 0, width: GRID.TILE_SIZE, height: GRID.TILE_SIZE }],
    };
  }
  const gx = Math.floor(destructible.position.x / GRID.TILE_SIZE);
  const gy = Math.floor(destructible.position.y / GRID.TILE_SIZE);
  if (!match.colliderData.visuals[gy]) match.colliderData.visuals[gy] = [];
  match.colliderData.visuals[gy]![gx] = {
    spriteId: TEST_COLLIDER_SPRITE_ID,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
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

async function setupTestRoom() {
  const { room, helper } = await createGameRoom(server);
  const match = getMatch(room);
  const grid = match.getGrid();
  clearArea(grid, 40, 40, 8);
  clearEntities(match);

  const client = await helper.addPlayer('Player1');
  await advanceTicks(room, SPAWN_INV_TICKS);
  forceActivePhase(room);

  return { room, helper, match, grid, client };
}

/** Place a barrel entity + tile + collider at (gx, gy) and register it. */
function placeBarrel(match: GameMatch, id: string, gx: number, gy: number): Destructible {
  const barrel = Destructible.create(id, 'barrel', tileCenter(gx, gy));
  match.addDestructible(barrel);
  match.getGrid()[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
  registerTestCollider(match, barrel);
  return barrel;
}

/**
 * Juice-pass-1 ticket 05 — server-authoritative prime + 5 s fuse + live
 * sync, end-to-end through the real room/orchestrator (GDD §5.5/§7.15,
 * locked by ticket 01's Resolution).
 */
describe('Barrel prime + fuse integration (juice-pass-1 ticket 05)', () => {
  it('melee prime syncs live: DestructibleSchema carries primed + fuseExpiresAtTick', async () => {
    const { room, helper, match, client } = await setupTestRoom();
    const gx = 41;
    const gy = 40;

    getDomainPlayer(room, client.sessionId).movement.position = new Position(
      (gx + 0.5) * GRID.TILE_SIZE - 60,
      (gy + 0.5) * GRID.TILE_SIZE,
    );
    await advanceTicks(room, 1);
    getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;
    const barrel = placeBarrel(match, 'sync-barrel-1', gx, gy);

    await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
    await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

    expect(barrel.isDestroyed).toBe(false);
    expect(barrel.primed).toBe(true);

    const schemaBarrel = room.state.destructibles.get('sync-barrel-1');
    expect(schemaBarrel).toBeDefined();
    expect(schemaBarrel!.primed).toBe(true);
    expect(schemaBarrel!.fuseExpiresAtTick).toBe(barrel.fuseExpiresAtTick);
    expect(schemaBarrel!.fuseExpiresAtTick).toBeGreaterThan(match.currentTick);
  }, 30_000);

  it('second melee hit detonates a primed barrel immediately', async () => {
    const { room, helper, match, grid, client } = await setupTestRoom();
    const gx = 41;
    const gy = 40;

    getDomainPlayer(room, client.sessionId).movement.position = new Position(
      (gx + 0.5) * GRID.TILE_SIZE - 60,
      (gy + 0.5) * GRID.TILE_SIZE,
    );
    await advanceTicks(room, 1);
    getDomainPlayer(room, client.sessionId).movement.facingAngle = 0;
    const barrel = placeBarrel(match, 'detonate-barrel-1', gx, gy);

    // Hit 1 — primes.
    await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
    await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);
    expect(barrel.primed).toBe(true);
    expect(match.getState().destructibles.has('detonate-barrel-1')).toBe(true);

    // Hit 2 — detonates on the spot, exactly as a killing hit always did.
    await helper.advanceTicks(FISTS_COOLDOWN_TICKS);
    await helper.sendInput(client, { aimAngle: 0, actions: ['ATTACK'] });
    await helper.advanceTicks(FISTS_WINDUP_TICKS + 5);

    expect(barrel.isDestroyed).toBe(true);
    expect(match.getState().destructibles.has('detonate-barrel-1')).toBe(false);
    expect(grid[gy]![gx]).toBe(TileType.EMPTY);
    const explosions = [...room.state.explosions.values()];
    expect(explosions.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('fuse expiry auto-explodes at exactly primeTick + FUSE_TICKS, identical to a normal destruction', async () => {
    const { room, helper, match, grid, client } = await setupTestRoom();
    const gx = 42;
    const gy = 40;
    const barrel = placeBarrel(match, 'fuse-barrel-1', gx, gy);

    // Player in the West ray path (2 tiles left of the barrel).
    getDomainPlayer(room, client.sessionId).movement.position = tileCenter(gx - 2, gy);
    await advanceTicks(room, 1);

    // Prime via the takeDamage choke point at a known tick.
    const primeTick = match.currentTick;
    barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: primeTick });
    expect(barrel.primed).toBe(true);
    expect(barrel.fuseExpiresAtTick).toBe(primeTick + BARREL.FUSE_TICKS);

    const healthBefore = helper.getPlayer(client)!.health;

    // One tick BEFORE the expiry tick is processed: still primed, no boom.
    await helper.advanceTicks(BARREL.FUSE_TICKS);
    expect(match.currentTick).toBe(primeTick + BARREL.FUSE_TICKS);
    expect(match.getState().destructibles.has('fuse-barrel-1')).toBe(true);
    expect(grid[gy]![gx]).toBe(TileType.DESTRUCTIBLE_BARREL);

    // The expiry tick itself: auto-explodes through the normal destroy path.
    await helper.advanceTicks(1);

    expect(match.getState().destructibles.has('fuse-barrel-1')).toBe(false);
    expect(grid[gy]![gx]).toBe(TileType.EMPTY);
    const explosions = [...room.state.explosions.values()];
    expect(explosions.length).toBeGreaterThanOrEqual(1);
    // Identical damage profile to a normal barrel explosion: flat 50 to a
    // player on a ray path (spawn invulnerability long over).
    expect(healthBefore - helper.getPlayer(client)!.health).toBeGreaterThanOrEqual(
      BARREL.EXPLOSION_DAMAGE,
    );
  }, 30_000);

  it('fuse expiry explosion is chain-capable: neighbor barrels explode in the same tick', async () => {
    const { room, helper, match } = await setupTestRoom();
    const gx = 42;
    const gy = 40;
    const barrel = placeBarrel(match, 'fuse-chain-src', gx, gy);
    const neighbor = placeBarrel(match, 'fuse-chain-n1', gx + 1, gy);
    const neighbor2 = placeBarrel(match, 'fuse-chain-n2', gx, gy + 1);

    const primeTick = match.currentTick;
    barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: primeTick });

    await helper.advanceTicks(BARREL.FUSE_TICKS + 1);

    expect(match.getState().destructibles.has('fuse-chain-src')).toBe(false);
    expect(match.getState().destructibles.has('fuse-chain-n1')).toBe(false);
    expect(match.getState().destructibles.has('fuse-chain-n2')).toBe(false);
    // 3 chained explosions resolved (source + 2 neighbors).
    const explosions = [...room.state.explosions.values()];
    expect(explosions.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('fuse expiry rays are identical to a normal explosion: blocked by indestructible walls', async () => {
    const { room, helper, match, grid, client } = await setupTestRoom();
    const barrelGx = 38;
    const wallGx = 40;
    const gy = 40;
    const barrel = placeBarrel(match, 'fuse-ray-b', barrelGx, gy);
    grid[gy]![wallGx] = TileType.INDESTRUCTIBLE_WALL;

    // Player just behind the wall's near face (same placement as the normal
    // path's 'DDA raycast stops at indestructible walls' test) — an unblocked
    // ray would reach this tile, the wall must absorb it.
    const wallPos = tileCenter(wallGx, gy);
    getDomainPlayer(room, client.sessionId).movement.position = new Position(
      wallPos.x + 60,
      wallPos.y,
    );
    await helper.advanceTicks(1);

    const primeTick = match.currentTick;
    barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: primeTick });

    await helper.advanceTicks(BARREL.FUSE_TICKS + 1);

    expect(match.getState().destructibles.has('fuse-ray-b')).toBe(false);
    expect(grid[gy]![barrelGx]).toBe(TileType.EMPTY);
    expect(grid[gy]![wallGx]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(helper.getPlayer(client)!.health).toBe(PLAYER.BASE_HEALTH);
  }, 30_000);

  it('fuse expiry respects the cap-20 explosion guard like a normal chain', async () => {
    const { helper, match } = await setupTestRoom();
    const startGx = 35;
    const gy = 40;

    for (let i = 0; i < 25; i++) {
      placeBarrel(match, `fuse-cap-${i}`, startGx + i, gy);
    }

    const primeTick = match.currentTick;
    match
      .getState()
      .destructibles.get('fuse-cap-0')!
      .takeDamage({ source: 'melee', rawDamage: 1, currentTick: primeTick });

    await helper.advanceTicks(BARREL.FUSE_TICKS + 1);

    let destroyedCount = 0;
    for (let i = 0; i < 25; i++) {
      if (!match.getState().destructibles.has(`fuse-cap-${i}`)) destroyedCount++;
    }
    // Same bound the normal chain test uses: cap 20 resolutions + the source.
    expect(destroyedCount).toBeLessThanOrEqual(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION + 1);
  }, 30_000);

  it('a primed barrel engulfed by a siege wall explodes via the existing destroy path', async () => {
    const { room, match, grid } = await setupTestRoom();
    const gx = 42;
    const gy = 40;
    const barrel = placeBarrel(match, 'siege-primed-1', gx, gy);

    // Prime, then let the siege destroy path run on the barrel's tile —
    // production wiring (GameOrchestratorInit) routes
    // MapSiegeService.destroyEntitiesOnTile → match.destroyDestructible →
    // destroyDestructibleAction → resolveExplosion. No new rule.
    barrel.takeDamage({ source: 'melee', rawDamage: 1, currentTick: match.currentTick });
    expect(barrel.primed).toBe(true);

    const orch = (room as unknown as GameRoom).getOrchestrator() as unknown as GameOrchestrator & {
      mapSiegeService: MapSiegeService;
    };
    orch.mapSiegeService.destroyEntitiesOnTile(gx, gy);

    expect(match.getState().destructibles.has('siege-primed-1')).toBe(false);
    expect(match.destructibles.has('siege-primed-1')).toBe(false);
    // The explosion resolved through the normal path (domain explosion
    // entity registered; the tile was already emptied by the destroy path).
    expect(match.explosions.size).toBeGreaterThanOrEqual(1);
    expect(grid[gy]![gx]).toBe(TileType.EMPTY);
  }, 30_000);

  it('a primed barrel hit by another barrel explosion detonates instantly (no fuse wait)', async () => {
    const { helper, match } = await setupTestRoom();
    const gx = 40;
    const gy = 40;
    const source = placeBarrel(match, 'oneshot-src', gx, gy);
    const primed = placeBarrel(match, 'oneshot-primed', gx + 1, gy);

    // Let step2 index the placed entities (the ray walk queries the
    // once-per-tick spatial snapshot — same 1-tick settle the existing
    // chain tests use after placing destructibles).
    await helper.advanceTicks(1);

    primed.takeDamage({ source: 'melee', rawDamage: 1, currentTick: match.currentTick });
    expect(primed.primed).toBe(true);

    // Destroying the source barrel resolves its explosion chain synchronously
    // — the primed neighbor one-shots (50 damage vs 1 HP left), never waiting
    // out its fuse.
    match.destroyDestructible('oneshot-src');

    expect(match.destructibles.has('oneshot-primed')).toBe(false);
    expect(primed.isDestroyed).toBe(true);
  }, 30_000);

  it('all map-spawned barrels start unprimed', async () => {
    const { room } = await createGameRoom(server, { seed: 4242 });
    const match = getMatch(room);

    const barrels = [...match.destructibles.values()].filter((d) => d.type === 'barrel');
    expect(barrels.length).toBeGreaterThan(0);
    for (const barrel of barrels) {
      expect(barrel.primed).toBe(false);
      expect(barrel.fuseExpiresAtTick).toBe(0);
      expect(barrel.hp).toBe(barrel.maxHp);
    }
  }, 30_000);
});
