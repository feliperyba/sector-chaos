/**
 * Client-side Colyseus schema shape definitions.
 *
 * The server defines Schema classes (PlayerSchema, ProjectileSchema, …) under
 * `packages/server/src/infrastructure/schemas/`. Those classes are decorated
 * with `@type(...)` metadata and serialised over the wire by `@colyseus/schema`.
 * The client receives raw JS objects whose shape mirrors the server class
 * fields exactly, plus the decoder-callback methods injected by the SDK proxy
 * (`onAdd` / `onRemove` / `onChange` on collections, `onChange` on instances).
 *
 * The interfaces below describe those wire shapes so the client network layer
 * can drop its `any` casts. They MUST stay in sync with the server schema
 * classes — every field here has a matching `@type(...)` declaration server
 * side. MapSchema<X> is modelled as `Map<string, X>` (Colyseus only supports
 * string keys) and ArraySchema<X> is modelled as `X[]`.
 *
 * Only the data shapes live here. The decoder-callback surface is captured by
 * `SchemaMap<V>` (which extends `Map<string, V>` with `onAdd`/`onRemove`/
 * `onChange`) so collection access and callback registration can both be
 * expressed without `any`.
 */

// ---------------------------------------------------------------------------
// Decoder-callback surface (mirrors `@colyseus/schema` CollectionCallback)
// ---------------------------------------------------------------------------

/**
 * A Colyseus `MapSchema<V>` collection as received by the client.
 *
 * Combines the standard `Map<string, V>` access surface with the decoder
 * callback methods (`onAdd` / `onRemove` / `onChange`) injected by the SDK's
 * `getStateCallbacks(room)` proxy. The callbacks are only present on
 * collections reached THROUGH that proxy; raw `MapSchema` instances expose
 * only the `Map` surface (calling `onAdd` on them throws at runtime). Both
 * shapes are typed uniformly here — callers must obtain collections via the
 * proxy before registering callbacks, as documented in `StateSync.subscribe`.
 */
export interface SchemaMap<V> extends Map<string, V> {
  onAdd(callback: (item: V, key: string) => void, immediate?: boolean): () => void;
  onRemove(callback: (item: V, key: string) => void): () => void;
  onChange(callback: (item: V, key: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Per-schema data shapes (mirror server `@type(...)` declarations verbatim)
// ---------------------------------------------------------------------------

/** Wire shape for `WeaponSchema` (server: WeaponSchema.ts). */
export interface WeaponSchemaData {
  id: string;
  weaponType: number;
  tier: number;
  ammo: number;
  maxAmmo: number;
}

/** Wire shape for `PlayerSchema` (server: PlayerSchema.ts). */
export interface PlayerSchemaData {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  direction: number;
  facingAngle: number;
  speed: number;
  velocityX: number;
  velocityY: number;
  health: number;
  maxHealth: number;
  status: number;
  kills: number;
  activeSlot: number;
  lastDamageTick: number;
  dashCooldown: number;
  barrierActive: boolean;
  isBlocking: boolean;
  speedBoostActive: boolean;
  connected: boolean;
  isBot: boolean;
  isWindupActive: boolean;
  windupWeaponType: number;
  windupAttackType: string;
  animPhase: number;
  animPhaseStartTick: number;
  comboIndex: number;
  barrierExpiryTick: number;
  speedBoostExpiryTick: number;
  freshSpawnExpiryTick: number;
  lastProcessedInput: number;
  /** Server `ArraySchema<WeaponSchema>` → modelled as a plain array. */
  weapons: WeaponSchemaData[];
  /** Server `ArraySchema<string>` → modelled as a plain string array. */
  items: string[];
}

/** Wire shape for `ProjectileSchema` (server: ProjectileSchema.ts). */
export interface ProjectileSchemaData {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  damage: number;
  bounces: number;
  weaponType: number;
  tier: number;
}

/** Wire shape for `DestructibleSchema` (server: DestructibleSchema.ts). */
export interface DestructibleSchemaData {
  id: string;
  type: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  isDestroyed: boolean;
  /** Juice-pass-1 ticket 05 — primed-barrel fuse (barrels only, live-synced). */
  primed: boolean;
  /** ABSOLUTE game tick the fuse detonates (`BARREL.FUSE_TICKS` after prime). */
  fuseExpiresAtTick: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/** Wire shape for `ChestSchema` (server: ChestSchema.ts). */
export interface ChestSchemaData {
  id: string;
  tier: number;
  x: number;
  y: number;
  state: number;
  openingPlayerId: string;
  openingProgress: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/** Wire shape for `EliminationRecordSchema` (server: EliminationRecordSchema.ts). */
export interface EliminationRecordSchemaData {
  order: number;
  playerId: string;
  killerId: string;
  weaponType: number;
  timestamp: number;
}

/** Wire shape for `ExitSchema` (server: ExitSchema.ts). */
export interface ExitSchemaData {
  id: string;
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  sectorIndex: number;
  active: boolean;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/** Wire shape for `ExplosionSchema` (server: ExplosionSchema.ts). */
export interface ExplosionSchemaData {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  radius: number;
  damage: number;
}

/** Wire shape for `PowerUpSchema` (server: PowerUpSchema.ts). */
export interface PowerUpSchemaData {
  id: string;
  type: number;
  x: number;
  y: number;
  isActive: boolean;
}

/** Wire shape for `TrapSchema` (server: TrapSchema.ts). */
export interface TrapSchemaData {
  id: string;
  type: number;
  x: number;
  y: number;
  isRevealed: boolean;
  cooldownRemaining: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  fireAreaActive: boolean;
  fireAreaRemainingMs: number;
}

/** Wire shape for `WeaponPickupSchema` (server: WeaponPickupSchema.ts). */
export interface WeaponPickupSchemaData {
  id: string;
  weaponType: number;
  tier: number;
  ammo: number;
  maxAmmo: number;
  x: number;
  y: number;
  lifetime: number;
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

/** Wire shape for `SiegeSectorSchema` (server: SiegeSchema.ts). */
export interface SiegeSectorSchemaData {
  row: number;
  col: number;
  active: boolean;
}

/** Wire shape for `MapSiegeProgressSchema` (server: SiegeSchema.ts). */
export interface MapSiegeProgressSchemaData {
  northOffset: number;
  eastOffset: number;
  southOffset: number;
  westOffset: number;
}

/** Wire shape for `ZoneSchema` (server: ZoneSchema.ts). */
export interface ZoneSchemaData {
  centerX: number;
  centerY: number;
  targetCenterX: number;
  targetCenterY: number;
  isTransitioningCenter: boolean;
  currentRadius: number;
  targetRadius: number;
  phase: number;
  phaseStartTime: number;
  phaseEndTime: number;
  hasNextPhasePreview: boolean;
  nextPhaseCenterX: number;
  nextPhaseCenterY: number;
  nextPhaseRadius: number;
}

// ---------------------------------------------------------------------------
// Root room state
// ---------------------------------------------------------------------------

/**
 * Wire shape for `GameStateSchema` (server: GameStateSchema.ts) — the root
 * state object exposed via `room.state`. Collection fields are typed as
 * `SchemaMap<X>` so callers can both iterate (Map API) and register decoder
 * callbacks (`onAdd`/`onRemove`/`onChange`) on the same value, provided they
 * reach it through `getStateCallbacks(room)` first.
 */
export interface GameRoomStateData {
  matchId: string;
  phase: number;
  tick: number;
  timestamp: number;
  mapSeed: number;
  mapWidth: number;
  mapHeight: number;
  playersAlive: number;
  matchTimer: number;
  lastProcessedInput: number;
  players: SchemaMap<PlayerSchemaData>;
  projectiles: SchemaMap<ProjectileSchemaData>;
  powerUps: SchemaMap<PowerUpSchemaData>;
  traps: SchemaMap<TrapSchemaData>;
  chests: SchemaMap<ChestSchemaData>;
  destructibles: SchemaMap<DestructibleSchemaData>;
  exits: SchemaMap<ExitSchemaData>;
  explosions: SchemaMap<ExplosionSchemaData>;
  zone: ZoneSchemaData;
  eliminationRecords: SchemaMap<EliminationRecordSchemaData>;
  weaponPickups: SchemaMap<WeaponPickupSchemaData>;
  siegedSectors: SchemaMap<SiegeSectorSchemaData>;
  mapSiegeProgress: MapSiegeProgressSchemaData;
}

// ---------------------------------------------------------------------------
// Client-bound message payloads not already in ./messages/
// ---------------------------------------------------------------------------

/**
 * Payload of the `matchCancelled` channel — broadcast by the server when a
 * match is aborted (e.g. all players disconnected). See
 * `GameRoomLifecycle.ts:ctx.broadcast('matchCancelled', { reason: ... })`.
 */
export interface MatchCancelledMessage {
  reason: string;
}
