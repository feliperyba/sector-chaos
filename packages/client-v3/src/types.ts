import {
  WEAPON_SPRITE_KEYS,
  CHEST_TIER_COLORS as SHARED_CHEST_TIER_COLORS,
  PLAYER_SPRITE_KEYS,
  PLAYER_HAND_SPRITE_KEYS,
  GRID,
} from '@sector-battle/shared';
import type {
  TileVisual,
  TileSpriteAtlas,
  TiledMapLayer,
  PlayerSchemaData,
  WeaponSchemaData,
  ProjectileSchemaData,
  PowerUpSchemaData,
  ExplosionSchemaData,
  WeaponPickupSchemaData,
  DestructibleSchemaData,
  ChestSchemaData,
  TrapSchemaData,
  ExitSchemaData,
  InputMessage,
  MapDataMessage,
} from '@sector-battle/shared';

export type {
  TileVisual,
  TileSpriteAtlas,
  TiledMapLayer,
  PlayerSchemaData,
  WeaponSchemaData,
  ProjectileSchemaData,
  PowerUpSchemaData,
  ExplosionSchemaData,
};

export const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'ws://localhost:2567';
export const TILE_SIZE = GRID.TILE_SIZE;
export const INPUT_SEND_INTERVAL_MS = 16;
/**
 * World-space padding added to the camera's world view when culling remote
 * players (PlayerRenderer) and entity animations (EntityRenderer) — the ONE
 * shared cull margin (perf ticket 21 deduplicated the two former per-file
 * 192 literals; keep both gates on this constant). ~1.5 tiles at 128px/tile;
 * also comfortably covers the victim-recoil + body-lean render offsets
 * (< 40px) and every animated entity extent (pickup/powerup bob ±4px, the
 * powerup ground-glow decal 44px, the sonar ping at PLAYER.PICKUP_RADIUS
 * = 72px), so anything outside the padded rect has NONE of its visuals
 * on-screen and a re-entering object is already fully animated before any
 * pixel shows.
 *
 * FIRE-TRAP OVERLAY EXACT-COVER INVARIANT: the fire-trap overlay paints a
 * 3×3 tile block centered on the trap's tile, i.e. it reaches exactly
 * 1.5 tiles = 192px from the trap's world position in every direction. This
 * margin therefore covers the overlay EXACTLY — but only because the server
 * places traps at exact tile centers (`gridX * tileSize + tileSize / 2`,
 * MapEntityFactory.ts trap placement). If traps ever gain a sub-tile offset,
 * the fire overlay's reach becomes 192 ± offset and this margin must grow
 * accordingly or the overlay edge could pop in without its trap animated.
 */
export const VIEW_CULL_MARGIN_PX = 192;
/** Walk-state hysteresis thresholds in px/s (frame-rate independent). */
export const MOVE_ENTER_THRESHOLD = 60;
export const MOVE_EXIT_THRESHOLD = 18;
/**
 * Errors with vector magnitude ≥ this value snap immediately (no
 * correctionOffset smoothing). Errors below this are smoothed via
 * correctionOffset with exponential decay at ERROR_DECAY_RATE (ADR-0014).
 *
 * Value 16 (not 8): a prior tuning (commit 19331cd) halved this to 8 and
 * sped up decay 6× (rate 60) citing "industry standard (Overwatch/Valorant)".
 * Playtesting at 60Hz patch rate showed visible snapping — corrections of
 * 8-16px (common with even modest prediction drift) hard-snapped instead of
 * gliding. 16px restores the smooth tier for the full drift band while
 * keeping hard-snap for genuine teleports (>16px). See ADR-0014 §"Revised".
 */
export const RENDER_OFFSET_SNAP_THRESHOLD = 16;
/**
 * Exponential decay rate for correctionOffset. Governs how fast the VISUAL
 * smoothing offset (Tier-2) glides to zero after a genuine-but-small
 * reconciliation correction.
 *
 * Value 30: per-tick decay multiplier = exp(-30/60) ≈ 0.607. The offset
 * halves every ~1.14 ticks (~19ms) and is < 5% after 5 ticks (~83ms). This
 * is fast enough that a single genuine correction's visual glide completes
 * within one patch interval at 60Hz, so consecutive corrections don't pile up
 * into a steady-state drag.
 *
 * Why not faster (the prior rate=60 that "vanished in a blink")? At rate=60
 * the per-tick multiplier is 0.368 — corrections vanish in ~2 ticks (~33ms),
 * reading as a hard snap rather than a glide. Rate=30 is the sweet spot:
 * the glide is perceptible as continuous motion but completes before the next
 * patch. Quake 3's `cg_errorDecay` cvar uses a similar time-based decay
 * (~0.5-2s configurable, ~0.55s typical); our rate=30 gives ~100ms effective
 * decay which is tighter but appropriate for our 60Hz patch rate (Q3 ran
 ~20Hz snapshots).
 *
 * Why not slower (the original rate=10)? At 60Hz patch rate, rate=10's
 * per-tick multiplier is 0.847 → steady-state offset under continuous
 * divergence ε = ε/(1-0.847) = ε×6.5. A 5px-per-patch drift produced a
 * permanent 32px backward drag → "sluggish local player" (renderSpd=235 vs
 * BASE_SPEED=430). With the RTT-aware snap threshold (≥16px) absorbing
 * normal drift, the offset only accumulates on RARE genuine
 * corrections, so even rate=10 wouldn't drag — but rate=30 is safer.
 */
export const ERROR_DECAY_RATE = 30;
/**
 * The Tier-3 (hard-snap) threshold is RTT-aware: under high latency a fixed
 * 16px cutoff hard-snaps corrections that are perfectly normal drift for that
 * RTT, which reads as a teleport (B4 perf regression H3). This scales the
 * threshold up smoothly with RTT so the smooth (Tier-2) glide tier widens on
 * laggy connections while never narrowing the local (0ms) threshold.
 *
 *   rtt = 0ms   → 16px (RENDER_OFFSET_SNAP_THRESHOLD unchanged)
 *   rtt = 100ms → 24px
 *   rtt = 200ms → 32px
 *   rtt = 600ms+ → 64px (capped)
 *
 * The 1/200 slope doubles the threshold per ~200ms of extra RTT; the 4× cap
 * bounds the smooth tier so genuine teleports (respawns, server-side moves)
 * still hard-snap. Conservative — only widens, never narrows.
 */
export function computeSnapThreshold(rttMs: number): number {
  const factor = Math.min(4, Math.max(1, 1 + rttMs / 200));
  return RENDER_OFFSET_SNAP_THRESHOLD * factor;
}

export { PLAYER_SPRITE_KEYS, PLAYER_HAND_SPRITE_KEYS };
export const WEAPON_SPRITE_MAP: Record<number, string> = WEAPON_SPRITE_KEYS as Record<
  number,
  string
>;
export const CHEST_TIER_COLORS: Record<number, number> = SHARED_CHEST_TIER_COLORS as Record<
  number,
  number
>;
export const PLAYER_COLORS = PLAYER_SPRITE_KEYS.map((k) => k.replace('_character', '')) as string[];

/**
 * Client-side view of the map data wire shape.
 *
 * Collapsed (ticket #09, Step 5): `MapData` is now a direct alias for the
 * shared `MapDataMessage` interface — the single source of truth for the
 * JSON shape broadcast on the `mapData` channel (ADR-0014). The previous
 * hand-mirrored interface was structurally identical but had no compile-time
 * link to the shared shape; this alias makes the link explicit. The shared
 * `MapDataMessage.visualLayers` / `atlas` were widened from `unknown` to
 * `TiledMapLayer[]` / `TileSpriteAtlas` respectively (type-only, no runtime
 * change) so this alias can carry the richer client types without casts. The
 * JSON wire bytes are unchanged.
 */
export type MapData = MapDataMessage;

/**
 * Client-side view of the input wire shape.
 *
 * Collapsed (ticket #08, Step 3): `InputFrame` is now a direct alias for the
 * shared `InputMessage` interface — the single source of truth for the JSON
 * shape sent via `room.send('input', frame)` (ADR-0014). The previous
 * hand-mirrored interface was structurally identical but had no compile-time
 * link to the shared shape; this alias makes the link explicit. The JSON wire
 * bytes are unchanged. All call-sites keep working unchanged because the shape
 * is identical.
 *
 * The drift between the client send and the shared type is pinned by the
 * characterization test at
 * `packages/server/tests/room/handlers/input-wire-shape.test.ts` (ticket #08).
 */
export type InputFrame = InputMessage;

/**
 * Client-side view of a weapon slot. Collapsed (ticket #05, Step 5) to a direct
 * alias for the shared `WeaponSchemaData` interface — the single source of
 * truth mirroring the server `WeaponSchema` `@type()` declarations. Field drift
 * is caught by `packages/server/tests/infrastructure/schema-sync.test.ts`.
 */
export type WeaponState = WeaponSchemaData;

/**
 * Client-side view of the player wire shape.
 *
 * Collapsed (ticket #05, Step 3): `PlayerState` is now a direct alias for the
 * shared `PlayerSchemaData` interface — the single source of truth that mirrors
 * the server `PlayerSchema` `@type()` declarations. The previous hand-mirrored
 * `PlayerState` interface was structurally identical but had no compile-time
 * link to the shared shape; this alias makes the link explicit. All call-sites
 * keep working unchanged.
 *
 * The drift between the server schema and the shared interface is caught by
 * `packages/server/tests/infrastructure/schema-sync.test.ts` (ticket #05 Step 1).
 */
export type PlayerState = PlayerSchemaData;

/**
 * Client-side view of a projectile. Collapsed (ticket #05, Step 5) to a direct
 * alias for the shared `ProjectileSchemaData` interface. Field drift is caught
 * by `packages/server/tests/infrastructure/schema-sync.test.ts`.
 */
export type ProjectileState = ProjectileSchemaData;

export type WeaponPickupState = WeaponPickupSchemaData;

export type DestructibleState = DestructibleSchemaData;

/**
 * Wire index of the `'light'` destructible type (map-polish tickets 07/08).
 * Mirrors `DESTRUCTIBLE_TYPE_ORDER.light = 4`
 * (`packages/server/src/infrastructure/mappers/StateMapperTypes.ts`) — the
 * schema carries the numeric index, and the render-ownership branch +
 * the removal handler both recognize converted light props by it.
 */
export const DESTRUCTIBLE_TYPE_LIGHT = 4;

/**
 * Wire index of the `'barrel'` destructible type (juice-pass-1 ticket 06).
 * Mirrors `DESTRUCTIBLE_TYPE_ORDER.barrel = 1`
 * (`packages/server/src/infrastructure/mappers/StateMapperTypes.ts`), same
 * discipline as `DESTRUCTIBLE_TYPE_LIGHT` above. The primed-fire visual paths
 * (BarrelFuseVFX + BarrelFuseLightPopulator) recognize barrels by it.
 */
export const DESTRUCTIBLE_TYPE_BARREL = 1;

/**
 * Client-side view of a power-up. Collapsed (ticket #05, Step 5) to a direct
 * alias for the shared `PowerUpSchemaData` interface. Field drift is caught by
 * `packages/server/tests/infrastructure/schema-sync.test.ts`.
 */
export type PowerUpState = PowerUpSchemaData;

export type ChestState = ChestSchemaData;

export type TrapState = TrapSchemaData;

/**
 * Client-side view of an explosion. Collapsed (ticket #05, Step 5) to a direct
 * alias for the shared `ExplosionSchemaData` interface. Field drift is caught by
 * `packages/server/tests/infrastructure/schema-sync.test.ts`.
 */
export type ExplosionState = ExplosionSchemaData;

export type ExitState = ExitSchemaData;

export interface InputRecord {
  frame: InputFrame;
  predictedX: number;
  predictedY: number;
  timestamp: number;
  speed: number;
  dt: number;
  velocityX: number;
  velocityY: number;
  subSteps: number;
  /**
   * Per-substep movement direction X (NET-02 faithful rewind-replay). Entry
   * `[i]` is the normalized dx the prediction actually integrated for substep
   * `i` of this record — including coasted substeps that advanced under
   * `lastInputDirection` before this frame was pushed. Length is always
   * `MAX_SUBSTEPS_PER_RECORD`; entries at indices `>= subSteps` are 0 (unused).
   *
   * The reconciler replays each substep with its recorded direction so the
   * rewind-replay reconstructs the prediction's trajectory exactly at direction
   * transitions (move→stop / stop→move / turn), eliminating the coasting-
   * direction asymmetry (NET-01 Cause 2). Pre-alloc boxed on each pooled record
   * to preserve the zero-alloc hot path (ADR-0026).
   */
  subStepDirsX: Float64Array;
  /** Per-substep movement direction Y (NET-02). See {@link subStepDirsX}. */
  subStepDirsY: Float64Array;
}

export interface AttackVisual {
  id: string;
  playerId: string;
  type: string;
  angle: number;
  startTime: number;
  duration: number;
  range: number;
  arcAngle?: number;
  innerRadius: number;
  outerRadius: number;
  lineWidth?: number;
  fireX: number;
  fireY: number;
}

export interface KillFeedEntry {
  killerName: string;
  victimName: string;
  weaponType: number;
  timestamp: number;
  cause?: string;
  attackType?: string;
  killerId?: string;
  victimIsBot?: boolean;
  killerIsBot?: boolean;
  /**
   * POI location tag (map-redesign ticket 03 / DEC-001) — the server-authored
   * sector name where the elimination happened ("eliminated at The Gilded
   * Vault"). Undefined on demo maps (no naming data).
   */
  location?: string;
}

export enum AnimationState {
  IDLE,
  WALK,
  DASH,
  WINDUP,
  ATTACK_IMPACT,
  COOLDOWN,
  BLOCK,
  STAGGER,
  DYING,
}
