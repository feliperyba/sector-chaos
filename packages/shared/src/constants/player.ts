/**
 * PLAYER config. Hygiene sweep (ticket 16 / research T03 §6 + T06 C1): 18 keys
 * with zero production readers were deleted (PLAYER_SCALE / WEAPON_SCALE /
 * HAND_SCALE / PLAYER_SOLID_COLLISION / DASH_ALLOWS_ACTIONS /
 * STAGGER_ALLOWS_DASH / DASH_USES_BASE_SPEED / BLOCKING_SPEED_PENALTY / the
 * nine FRESH_SPAWN_* toggles / BOT_AI_TICK_INTERVAL) — every survivor here has
 * at least one non-test consumer. Fresh-spawn gating lives in
 * `PlayerStatusEffects` / `GameSimulationInput` (tick-based, not toggled by
 * these keys); bot tick cadence lives in `BotSystemConstants` (bot-ai-v2 LOD).
 */
export const PLAYER = {
  BASE_SPEED: 430,
  ACCELERATION: 4800,
  DECELERATION: 6400,
  DASH_SPEED_MULTIPLIER: 2.0,
  DASH_DURATION: 0.5,
  DASH_DURATION_TICKS: 30,
  DASH_COOLDOWN: 2.5,
  BASE_HEALTH: 100,
  MAX_HEALTH: 100,
  SPAWN_INVINCIBILITY: 3.0,
  INVENTORY_SIZE: 4,
  HITBOX_WIDTH: 96,
  HITBOX_HEIGHT: 96,
  PICKUP_RADIUS: 72,
} as const;
