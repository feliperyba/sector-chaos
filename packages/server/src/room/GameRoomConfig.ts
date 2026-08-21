/**
 * Config parsing for GameRoom.
 *
 * Extracted from GameRoomLifecycle — this module owns the runtime-room option
 * schema, the default `GameConfig` value, and the inferred option type. There
 * is exactly one consumer (`handleOnCreate` parses incoming room options
 * against this schema and falls back to {@link DEFAULT_CONFIG}). Mirrors the
 * TestRoom/BotTestRoom config precedent, where each room type carries its own
 * config object.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { PLAYER, COMBAT, ZONE, MATCH, GRID, NETWORK, type GameConfig } from '@sector-battle/shared';

const TPS = NETWORK.TICK_RATE;

/**
 * Zod schema describing the options GameRoom accepts at creation time.
 *
 * All fields are optional; missing values fall back to defaults in
 * {@link handleOnCreate} (matchId timestamp, {@link DEFAULT_CONFIG} for
 * `config`, `4` for `botFillTo`, etc.).
 *
 * `config` is validated as `z.unknown()` at runtime — the caller may pass an
 * externally-built `GameConfig` or omit it; the typed surface in
 * {@link GameRoomOptions} declares it as `GameConfig`.
 */
export const GameRoomOptionsSchema = z.object({
  matchId: z.string().optional(),
  config: z.unknown().optional(),
  botFillTo: z.number().int().min(0).max(128).optional(),
  botDifficulty: z.enum(['easy', 'normal', 'medium', 'hard', 'elite']).optional(),
  averageMmr: z.number().optional(),
  seed: z.number().int().optional(),
  // Ticket 15 — 'seeded' is accepted as a synonym for 'procedural' so the dev
  // preview's client.create({mapType:'seeded'}) is not rejected by zod. The
  // client vocabulary is 'demo' | 'seeded'; the server runs the same procedural
  // branch (MapGenerator → SeedMapAdapter → LightPlacer) for any non-'demo'
  // value (see GameRoomMapBuilder.buildGameMapResult). The production
  // MatchmakingScene path does NOT pass mapType to the server (MatchmakerAPI
  // omits it), so this enum change only affects the dev-direct boot path.
  mapType: z.enum(['procedural', 'demo', 'seeded']).optional(),
});

/**
 * GameRoom creation options.
 *
 * Mirrors {@link GameRoomOptionsSchema} with `config` typed as `GameConfig`
 * (the runtime schema accepts `unknown` so callers can pass an externally
 * built config object that already satisfies `GameConfig`).
 */
export interface GameRoomOptions {
  matchId?: string;
  config?: GameConfig;
  botFillTo?: number;
  botDifficulty?: 'easy' | 'normal' | 'medium' | 'hard' | 'elite';
  averageMmr?: number;
  seed?: number;
  mapType?: 'procedural' | 'demo' | 'seeded';
}

/**
 * Default `GameConfig` for a GameRoom, derived from the shared balance
 * constants. Tick-based durations (dash, cooldown, target, countdown) are
 * converted from seconds to ticks via `NETWORK.TICK_RATE`.
 */
export const DEFAULT_CONFIG: GameConfig = {
  player: {
    baseSpeed: PLAYER.BASE_SPEED,
    dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
    dashDuration: Math.round(PLAYER.DASH_DURATION * TPS),
    dashCooldown: Math.round(PLAYER.DASH_COOLDOWN * TPS),
    baseHealth: PLAYER.BASE_HEALTH,
    maxHealth: PLAYER.MAX_HEALTH,
    inventorySize: PLAYER.INVENTORY_SIZE,
    hitboxWidth: PLAYER.HITBOX_WIDTH,
    hitboxHeight: PLAYER.HITBOX_HEIGHT,
  },
  zone: {
    phases: ZONE.PHASES.map((p) => ({
      index: p.index,
      radiusRatio: p.radiusRatio,
      duration: p.duration,
      name: p.name,
    })),
    totalDuration: ZONE.TOTAL_DURATION,
    transitionDuration: ZONE.ZONE_TRANSITION_DURATION,
    tickInterval: ZONE.ZONE_TICK_INTERVAL,
    warningTime: ZONE.ZONE_WARNING_TIME,
  },
  match: {
    targetDuration: Math.round(MATCH.TARGET_DURATION * TPS),
    maxPlayers: MATCH.MAX_PLAYERS,
    minPlayers: MATCH.MIN_PLAYERS,
    countdownDuration: Math.round(MATCH.COUNTDOWN_DURATION * TPS),
    overtimeStart: MATCH.OVERTIME_START,
    lastStandingThreshold: 1,
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
  },
  combat: {
    knockbackForce: COMBAT.KNOCKBACK_FORCE,
    knockbackDecay: COMBAT.KNOCKBACK_DECAY,
    throwRange: COMBAT.THROW_RANGE,
    bounceFactor: COMBAT.BOUNCE_FACTOR,
    maxBounces: COMBAT.MAX_BOUNCES,
    friendlyFire: COMBAT.FRIENDLY_FIRE,
  },
  network: {
    tickRate: NETWORK.TICK_RATE,
    patchRate: NETWORK.PATCH_RATE,
    maxLatency: NETWORK.MAX_LATENCY,
    inputBufferSize: NETWORK.INPUT_BUFFER_SIZE,
    snapshotInterval: NETWORK.SNAPSHOT_INTERVAL,
  },
};
