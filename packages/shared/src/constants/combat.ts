import { NETWORK } from './network.js';

export const BARREL = {
  EXPLOSION_RADIUS: 256,
  EXPLOSION_DAMAGE: 50,
  MAX_EXPLOSIONS_PER_RESOLUTION: 20,
  /**
   * Primed-barrel fuse (juice-pass-1 ticket 05, GDD §5.5/§7.15): a barrel
   * that survives a hit is primed and auto-explodes this many milliseconds
   * later. Server-authoritative and tick-based — see FUSE_TICKS, the only
   * form the simulation reads (never wall-clock, so the fast-forward bench
   * virtual clock stays faithful and BENCH_SEED reproducibility holds).
   */
  FUSE_MS: 5000,
  /** FUSE_MS expressed in simulation ticks (NETWORK.TICK_RATE per second). */
  FUSE_TICKS: Math.ceil((5000 * NETWORK.TICK_RATE) / 1000),
} as const;

export const BOOMERANG = {
  RETURN_DURABILITY_COST: 1,
} as const;

export const COLLISION = {
  ARROW_HITBOX_WIDTH: 16,
  THROWN_HITBOX_SIZE: 64,
} as const;

export const COMBAT = {
  KNOCKBACK_FORCE: 2000,
  KNOCKBACK_DECAY: 2000,
  KNOCKBACK_DURATION: 0.2,
  THROW_RANGE: 2000,
  BOUNCE_FACTOR: 0.8,
  MAX_BOUNCES: 8,
  FRIENDLY_FIRE: false,
  ATTACK_RATE_LIMIT: 100,
  THROW_SOURCE_IMMUNITY: 170,
  THROWN_WALL_BOUNCE_DURABILITY: 1,
  ATTACK_WINDUP_FAST: 0.1,
  WEAPON_SWITCH_TIME: 0.15,
  WEAPON_BREAK_STAGGER: 0.33,
  SHIELD_BREAK_STAGGER: 0.5,
  DEATH_ANIMATION_DURATION: 0.5,
  DEATH_CAMERA_ZOOM: 0.3,
  DEATH_CAMERA_ZOOM_FACTOR: 0.7,
  STAGGER_MOVE_SPEED_PENALTY: 0.75,
  ARC_INNER_RADIUS: 48,
  // Hurtbox sizes MUST match the physical colliders, not arbitrary values.
  // Player hurtbox = PLAYER.HITBOX_WIDTH (96) — the player collision box.
  // Destructible hurtbox = GRID.TILE_SIZE (128) — full tile collider.
  HURTBOX_SIZE: 96,
  DESTRUCTIBLE_HURTBOX_SIZE: 128,
  // The new character art is top-heavy (prominent head/face in the upper half
  // of the sprite). The hurtbox stays 96×96 but shifts up by this many px so it
  // favours head/torso coverage over the feet/origin. Applied to both the
  // damage AABB (HurtboxGathering) and the movement hitbox (Player.hitbox) so
  // they stay aligned. Tune by eye against the rendered body.
  HURTBOX_VERTICAL_OFFSET: 10,
  LINE_ATTACK_WIDTH: 20,
  WINDUP_UNCANCELLABLE: true,
  DEAD_BODY_COLLISION: true,
  SHIELD_BLOCKS_ENVIRONMENTAL: false,
  SHIELD_DAMAGE_NEGATION: 1.0,
  THROWN_DURABILITY_ZERO_SHATTER: true,
  LINE_HITS_ALL_IN_WIDTH: true,
  THROWN_FLIGHT_NOT_PICKUPABLE: true,
  SHIELD_THROW_COOLDOWN: 250,
  // Multiplier applied to the weapon's base throw speed to get the actual
  // projectile velocity. Lives here (not hard-coded in ThrowHandler) so the
  // throw tests read one source of truth and balance tweaks are reviewable.
  THROW_SPEED_MULTIPLIER: 1.25,
} as const;
