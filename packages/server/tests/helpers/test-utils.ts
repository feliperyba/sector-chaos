import type { Room } from 'colyseus';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { PlayerSchema } from '../../src/infrastructure/schemas/PlayerSchema.ts';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema.ts';
import type { GameConfig } from '@sector-battle/shared';
import {
  PLAYER,
  GRID,
  NETWORK,
  ZONE,
  MATCH,
  COMBAT,
  MatchPhase,
  WeaponType,
} from '@sector-battle/shared';
import { connectClient } from './test-server.ts';

type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

interface CombatSetupOptions {
  playerPositions: { x: number; y: number }[];
  equipWeapons?: { playerIndex: number; slotIndex: number; weaponType: WeaponType }[];
  configOverrides?: Partial<GameConfig>;
}

interface CombatSetup {
  room: Room<{ state: GameStateSchema }>;
  clients: TestClient[];
  players: PlayerSchema[];
}

export async function advanceTicks(room: Room, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await room.waitForNextSimulationTick();
  }
}

/**
 * Freeze the wall-clock the SERVER's room timers see, following the virtual-
 * clock pattern from the bot benchmark harness. Colyseus's Room.setSimulationInterval
 * ticks its Clock and passes `clock.deltaTime` into the simulation callback, and
 * the Clock computes deltaTime from `Date.now()` deltas (Node has no
 * `window.performance`). With `Date.now` frozen, every real interval fire during
 * awaited setup passes deltaTime=0 into `orchestrator.update(0)` — the TickTimer
 * consumes no time, so the match tick cannot drift no matter how often or how
 * late the interval fires under CI load.
 *
 * Must be installed BEFORE the room is created (the Clock binds `Date.now` at
 * construction). The returned restore function unfreezes it — always call it in
 * a finally block. Timers (`setTimeout`/`setInterval`) are unaffected, so
 * `waitForNextSimulationTick` (a bare setTimeout in @colyseus/testing) and
 * patch delivery keep working while frozen.
 */
export function freezeServerWallClock(): () => void {
  const saved = globalThis.Date.now;
  const frozenAt = saved();
  globalThis.Date.now = () => frozenAt;
  return () => {
    globalThis.Date.now = saved;
  };
}

export async function advanceSeconds(room: Room, seconds: number): Promise<void> {
  const ticks = Math.ceil(seconds * NETWORK.TICK_RATE);
  await advanceTicks(room, ticks);
}

export function createTestConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    player: {
      baseSpeed: PLAYER.BASE_SPEED,
      dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
      dashDuration: PLAYER.DASH_DURATION_TICKS,
      dashCooldown: Math.ceil(PLAYER.DASH_COOLDOWN * NETWORK.TICK_RATE),
      baseHealth: PLAYER.BASE_HEALTH,
      maxHealth: PLAYER.MAX_HEALTH,
      inventorySize: PLAYER.INVENTORY_SIZE,
      hitboxWidth: PLAYER.HITBOX_WIDTH,
      hitboxHeight: PLAYER.HITBOX_HEIGHT,
      ...overrides.player,
    },
    zone: {
      phases: [...ZONE.PHASES],
      totalDuration: ZONE.TOTAL_DURATION,
      transitionDuration: ZONE.ZONE_TRANSITION_DURATION,
      tickInterval: ZONE.ZONE_TICK_INTERVAL,
      warningTime: ZONE.ZONE_WARNING_TIME,
      ...overrides.zone,
    },
    match: {
      targetDuration: Math.ceil(MATCH.TARGET_DURATION * NETWORK.TICK_RATE),
      maxPlayers: MATCH.MAX_PLAYERS,
      minPlayers: MATCH.MIN_PLAYERS,
      countdownDuration: Math.ceil(MATCH.COUNTDOWN_DURATION * NETWORK.TICK_RATE),
      overtimeStart: MATCH.OVERTIME_START,
      lastStandingThreshold: 1,
      ...overrides.match,
    },
    map: {
      tileWidth: GRID.TILE_SIZE,
      tileHeight: GRID.TILE_SIZE,
      arenaWidth: GRID.ARENA_WIDTH,
      arenaHeight: GRID.ARENA_HEIGHT,
      sectorSize: GRID.SECTOR_GRID_SIZE,
      corridorWidth: GRID.CORRIDOR_WIDTH,
      destructibleDensity: 0.3,
      chestDensity: 0.05,
      exitCount: 3,
      ...overrides.map,
    },
    combat: {
      knockbackForce: COMBAT.KNOCKBACK_FORCE,
      knockbackDecay: COMBAT.KNOCKBACK_DECAY,
      throwRange: COMBAT.THROW_RANGE,
      bounceFactor: COMBAT.BOUNCE_FACTOR,
      maxBounces: COMBAT.MAX_BOUNCES,
      friendlyFire: COMBAT.FRIENDLY_FIRE,
      ...overrides.combat,
    },
    network: {
      tickRate: NETWORK.TICK_RATE,
      patchRate: NETWORK.PATCH_RATE,
      maxLatency: NETWORK.MAX_LATENCY,
      inputBufferSize: NETWORK.INPUT_BUFFER_SIZE,
      snapshotInterval: NETWORK.SNAPSHOT_INTERVAL,
      ...overrides.network,
    },
  } satisfies GameConfig;
}

export async function createCombatSetup(
  server: ColyseusTestServer,
  room: Room<{ state: GameStateSchema }>,
  options: CombatSetupOptions = {
    playerPositions: [
      { x: 5120, y: 5100 },
      { x: 5120, y: 5140 },
    ],
  },
): Promise<CombatSetup> {
  const attackerClient = await connectClient(server, room, { name: 'Attacker' });
  const targetClient = await connectClient(server, room, { name: 'Target' });

  await movePlayersToPositions([attackerClient, targetClient], room, options.playerPositions);

  const spawnInvTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
  await advanceTicks(room, spawnInvTicks);

  const players = [...room.state.players.values()];

  if (options.equipWeapons) {
    for (const equip of options.equipWeapons) {
      const player = players[equip.playerIndex];
      if (player) {
        player.weapons[equip.slotIndex] =
          equip.weaponType as unknown as (typeof player.weapons)[number];
      }
    }
  }

  return { room, clients: [attackerClient, targetClient], players };
}

export async function movePlayersToPositions(
  clients: TestClient[],
  room: Room<{ state: GameStateSchema }>,
  positions: { x: number; y: number }[],
  maxSteps: number = 120,
): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    const players = [...room.state.players.values()];
    let allReached = true;
    for (let i = 0; i < Math.min(players.length, positions.length); i++) {
      const dx = positions[i].x - players[i].x;
      const dy = positions[i].y - players[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1.0) {
        allReached = false;
        clients[i].send('input', {
          movementX: dx / dist,
          movementY: dy / dist,
          sequence: step,
        });
      }
    }
    await room.waitForNextSimulationTick();
    if (allReached) break;
  }
}

export function getPlayerState(
  room: Room<{ state: GameStateSchema }>,
  sessionId: string,
): PlayerSchema | undefined {
  return [...room.state.players.values()].find((p) => p.id === sessionId);
}

export async function waitForPhase(
  room: Room<{ state: GameStateSchema }>,
  phase: MatchPhase,
): Promise<void> {
  while (room.state.phase !== phase) {
    await room.waitForNextPatch();
  }
}
