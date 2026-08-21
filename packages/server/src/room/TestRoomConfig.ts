import { PLAYER, COMBAT, ZONE, MATCH, GRID, NETWORK, type GameConfig } from '@sector-battle/shared';

const TPS = NETWORK.TICK_RATE;

export const TEST_CONFIG: GameConfig = {
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
    minPlayers: 1,
    countdownDuration: Math.round(MATCH.COUNTDOWN_DURATION * TPS),
    overtimeStart: MATCH.OVERTIME_START,
    lastStandingThreshold: 0,
  },
  map: {
    tileWidth: GRID.TILE_SIZE,
    tileHeight: GRID.TILE_SIZE,
    arenaWidth: 22,
    arenaHeight: 22,
    sectorSize: 4,
    corridorWidth: 3,
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
