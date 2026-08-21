import { WeaponType, PLAYER, EntitySpatialGrid } from '@sector-battle/shared';
import {
  MAX_PLAYERS,
  MAX_ITEMS,
  MAX_DESTRUCTIBLES,
  MAX_TRAPS,
  MAX_PROJECTILES,
  type WorldSnapshotConfig,
  type PlayerDTO,
  type ItemDTO,
  type OpeningChestDTO,
  type DestructibleDTO,
  type TrapDTO,
  type ProjectileDTO,
} from './WorldSnapshotTypes.ts';
import { syncWorldSnapshot } from './WorldSnapshotSync.ts';
import type { ZoneFeed, ZoneView } from './WorldSnapshotZone.ts';

export {
  tierToNumber,
  type WeaponDTO,
  type PlayerDTO,
  type ItemDTO,
  type OpeningChestDTO,
  type DestructibleDTO,
  type TrapDTO,
  type ProjectileDTO,
  type WorldSnapshotConfig,
} from './WorldSnapshotTypes.ts';

/**
 * Per-tick read-only snapshot of the world shared by all bots.
 *
 * NOTE: data fields are intentionally public (not `private`) so the helper
 * functions in `WorldSnapshotSync.ts` (extracted from the original monolithic
 * class) can read/write them. External callers should treat the field surface
 * as internal — the public read API is the forEach / query / getById methods.
 */
export class WorldSnapshot {
  readonly playerEntries: PlayerDTO[];
  readonly playerActive: Int32Array;
  playerActiveCount = 0;
  readonly playerIdToSlot: Map<string, number>;
  readonly playerFreeSlots: Int32Array;
  playerFreeCount = 0;
  playerNextSlot = 0;
  readonly playerSlotTick: Uint32Array;

  readonly itemEntries: ItemDTO[];
  readonly itemActive: Int32Array;
  itemActiveCount = 0;
  readonly itemIdToSlot: Map<string, number>;
  readonly itemFreeSlots: Int32Array;
  itemFreeCount = 0;
  itemNextSlot = 0;
  readonly itemSlotTick: Uint32Array;

  /**
   * Opening chests, rebuilt each sync (every tick — cheap: a single forEach
   * over chests). Sized to MAX_ITEMS as a safe upper bound; in practice only a
   * handful of chests are opening at once. Used by BotPerception to flag
   * looting enemies.
   */
  readonly openingChestEntries: OpeningChestDTO[];
  openingChestCount = 0;
  readonly destructibleEntries: DestructibleDTO[];
  readonly destructibleActive: Int32Array;
  destructibleActiveCount = 0;
  readonly destructibleIdToSlot: Map<string, number>;
  readonly destructibleFreeSlots: Int32Array;
  destructibleFreeCount = 0;
  destructibleNextSlot = 0;
  readonly destructibleSlotTick: Uint32Array;

  readonly trapEntries: TrapDTO[];
  readonly trapActive: Int32Array;
  trapActiveCount = 0;
  readonly trapIdToSlot: Map<string, number>;
  readonly trapFreeSlots: Int32Array;
  trapFreeCount = 0;
  trapNextSlot = 0;
  readonly trapSlotTick: Uint32Array;

  readonly projectileEntries: ProjectileDTO[];
  readonly projectileActive: Int32Array;
  projectileActiveCount = 0;
  readonly projectileIdToSlot: Map<string, number>;
  readonly projectileFreeSlots: Int32Array;
  projectileFreeCount = 0;
  projectileNextSlot = 0;
  readonly projectileSlotTick: Uint32Array;

  itemGrid!: EntitySpatialGrid;
  destructibleGrid!: EntitySpatialGrid;
  trapGrid!: EntitySpatialGrid;
  projectileGrid!: EntitySpatialGrid;
  /**
   * Spatial grid for PLAYERS. Unlike the entity grids above, this was missing
   * historically — every bot's scanWorld did a full O(N) linear scan of all
   * players via forEachActivePlayer. With 63 players that's the dominant O(N²)
   * cost in botAI (every scanning bot × every player). queryPlayers replaces
   * the linear scan with a range query so perception scales with LOCAL player
   * density, not total player count. Built every tick in rebuildWorldGrids.
   */
  playerGrid!: EntitySpatialGrid;

  currentTick = 0;

  /**
   * Zone read feed (perf-arc ticket 17): the zoneService/siegeWallManager the
   * per-tick sync reads zone state from directly — replaces the retired
   * constructor closure over the wire MatchStateProjector. Null when the
   * snapshot was built without a feed (then `zone` stays null and
   * updateZoneInfo falls back to its neutral map-center ZoneInfo).
   * Collaborator-facing by design (syncZoneView reads it).
   */
  readonly zoneFeed: ZoneFeed | null;
  /**
   * Per-tick zone view, refreshed each sync by syncZoneView (null forever
   * when no feed). Collaborator-facing by design (updateZoneInfo reads it).
   */
  readonly zone: ZoneView | null;
  /** Persistent preview-copy cache written by syncZoneView (the projector's
   *  pc-cache pattern — the view never aliases the service's live preview). */
  readonly zonePreviewCache: { centerX: number; centerY: number; radius: number } = {
    centerX: 0,
    centerY: 0,
    radius: 0,
  };

  /**
   * Global per-tick count of ALIVE BOT players, maintained inline by
   * syncWorldPlayers (incremented right after it writes `dto.isAlive`/
   * `dto.isBot`, using the exact predicate `dto.isAlive && dto.isBot`).
   * Replaces the old second full-player O(N) loop in BotSystem.tick — the
   * player sync pass already touches every player, so the count is a free
   * side effect of it. Consumed by the endgame thresholds (loot/heal
   * relaxation, hunt radius collapse) and the IntentContext.
   */
  aliveBotCount = 0;

  /**
   * Global per-tick count of ALIVE players (bots + humans), maintained inline
   * by syncWorldPlayers (incremented right after it writes `dto.isAlive`,
   * same pattern as aliveBotCount). MATCH-ARC NUMERATOR (bot-ai-v2 ticket 10,
   * DEC-011): with playerActiveCount as the denominator (eliminated players
   * stay soft-registered in the map, so the total is stable over a match),
   * this drives the GDD §14.3 alive-ratio bands — a pure function of alive
   * counts, no RNG, no wall-clock.
   */
  alivePlayerCount = 0;

  playerCapacityWarned = false;
  itemCapacityWarned = false;
  destructibleCapacityWarned = false;
  trapCapacityWarned = false;
  projectileCapacityWarned = false;

  readonly capItems: number;
  readonly capDestructibles: number;
  readonly capTraps: number;
  readonly capProjectiles: number;
  firstSync = true;

  constructor(config?: WorldSnapshotConfig, zoneFeed?: ZoneFeed) {
    const invSize = PLAYER.INVENTORY_SIZE;
    this.capItems = config?.maxItems ?? MAX_ITEMS;
    this.capDestructibles = config?.maxDestructibles ?? MAX_DESTRUCTIBLES;
    this.capTraps = config?.maxTraps ?? MAX_TRAPS;
    this.capProjectiles = config?.maxProjectiles ?? MAX_PROJECTILES;
    this.zoneFeed = zoneFeed ?? null;
    this.zone = zoneFeed
      ? {
          currentPhase: 0,
          centerX: 0,
          centerY: 0,
          targetCenterX: 0,
          targetCenterY: 0,
          currentRadius: 0,
          targetRadius: 0,
          isTransitioningCenter: false,
          msUntilShrink: -1,
          nextPhasePreview: null,
          siegeWallWarnings: [],
        }
      : null;

    this.playerEntries = Array.from({ length: MAX_PLAYERS }, () => ({
      id: '',
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0,
      facingAngle: 0,
      health: 0,
      maxHealth: 0,
      isAlive: false,
      isBot: false,
      weaponCount: 0,
      hasWeapon: false,
      weaponTier: 0,
      weaponType: WeaponType.FISTS,
      activeSlot: 0,
      isFreshSpawn: false,
      freshSpawnExpiryTick: 0,
      barrierActive: false,
      isInWindup: false,
      windupRemaining: 0,
      lastAttackTick: -Infinity,
      weapons: Array.from({ length: invSize }, () => ({
        weaponType: WeaponType.FISTS,
        tier: 0,
        ammo: 0,
        durability: 0,
      })),
    }));
    this.playerActive = new Int32Array(MAX_PLAYERS);
    this.playerIdToSlot = new Map<string, number>();
    this.playerFreeSlots = new Int32Array(MAX_PLAYERS);
    this.playerSlotTick = new Uint32Array(MAX_PLAYERS);

    this.itemEntries = Array.from({ length: this.capItems }, () => ({
      id: '',
      x: 0,
      y: 0,
      type: '',
      tier: 0,
      weaponType: undefined as ItemDTO['weaponType'],
      powerUpType: undefined as ItemDTO['powerUpType'],
    }));
    this.itemActive = new Int32Array(this.capItems);
    this.itemIdToSlot = new Map<string, number>();
    this.itemFreeSlots = new Int32Array(this.capItems);
    this.itemSlotTick = new Uint32Array(this.capItems);

    this.openingChestEntries = Array.from({ length: this.capItems }, () => ({
      id: '',
      openingPlayerId: '',
      x: 0,
      y: 0,
    }));
    this.openingChestCount = 0;
    this.destructibleEntries = Array.from({ length: this.capDestructibles }, () => ({
      id: '',
      x: 0,
      y: 0,
      type: '',
      hp: 0,
      maxHp: 0,
      isDestroyed: false,
    }));
    this.destructibleActive = new Int32Array(this.capDestructibles);
    this.destructibleIdToSlot = new Map<string, number>();
    this.destructibleFreeSlots = new Int32Array(this.capDestructibles);
    this.destructibleSlotTick = new Uint32Array(this.capDestructibles);

    this.trapEntries = Array.from({ length: this.capTraps }, () => ({
      id: '',
      x: 0,
      y: 0,
      type: '',
    }));
    this.trapActive = new Int32Array(this.capTraps);
    this.trapIdToSlot = new Map<string, number>();
    this.trapFreeSlots = new Int32Array(this.capTraps);
    this.trapSlotTick = new Uint32Array(this.capTraps);

    this.projectileEntries = Array.from({ length: this.capProjectiles }, () => ({
      id: '',
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0,
    }));
    this.projectileActive = new Int32Array(this.capProjectiles);
    this.projectileIdToSlot = new Map<string, number>();
    this.projectileFreeSlots = new Int32Array(this.capProjectiles);
    this.projectileSlotTick = new Uint32Array(this.capProjectiles);
  }

  setMapBounds(width: number, height: number): void {
    this.itemGrid = new EntitySpatialGrid(width, height, this.capItems);
    this.destructibleGrid = new EntitySpatialGrid(width, height, this.capDestructibles);
    this.trapGrid = new EntitySpatialGrid(width, height, this.capTraps);
    this.projectileGrid = new EntitySpatialGrid(width, height, this.capProjectiles);
    // MAX_PLAYERS cap — matches the playerEntries array size. Cell size 512
    // matches the entity grids (preserves the original perception sizing).
    this.playerGrid = new EntitySpatialGrid(width, height, MAX_PLAYERS);
  }

  /** Internal — advances the snapshot tick counter (used by sync helpers). */
  bumpTick(): void {
    this.currentTick = (this.currentTick + 1) >>> 0;
  }

  sync(maps: import('../domain/aggregates/GameMatchEntityOps.ts').EntityMaps): void {
    syncWorldSnapshot(this, maps);
  }

  forEachActivePlayer(cb: (dto: PlayerDTO, index: number) => void): void {
    const count = this.playerActiveCount;
    const active = this.playerActive;
    const entries = this.playerEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[active[i]!]!, i);
    }
  }

  /**
   * Range query over active players via the player spatial grid. Returns only
   * players within `range` px of (cx, cy) — O(local density) instead of the
   * O(N) full scan `forEachActivePlayer` does. This is the bot-perception hot
   * path: every scanning bot calls this once per scan, so the linear scan was
   * the dominant O(N²) cost in botAI at 63 players.
   */
  queryPlayers(cx: number, cy: number, range: number, cb: (dto: PlayerDTO) => void): void {
    this.playerGrid?.query(cx, cy, range, (slot) => cb(this.playerEntries[slot]!));
  }

  forEachActiveItem(cb: (dto: ItemDTO, index: number) => void): void {
    const count = this.itemActiveCount;
    const active = this.itemActive;
    const entries = this.itemEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[active[i]!]!, i);
    }
  }

  /**
   * Iterate chests currently being opened (state === 'opening'). Each entry
   * carries the opener's player id — use to flag a looting enemy as vulnerable.
   * Not spatially queried (count is tiny, linear scan is cheaper than a grid).
   */
  forEachOpeningChest(cb: (dto: OpeningChestDTO) => void): void {
    const count = this.openingChestCount;
    const entries = this.openingChestEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[i]!);
    }
  }

  forEachActiveDestructible(cb: (dto: DestructibleDTO, index: number) => void): void {
    const count = this.destructibleActiveCount;
    const active = this.destructibleActive;
    const entries = this.destructibleEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[active[i]!]!, i);
    }
  }

  forEachActiveTrap(cb: (dto: TrapDTO, index: number) => void): void {
    const count = this.trapActiveCount;
    const active = this.trapActive;
    const entries = this.trapEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[active[i]!]!, i);
    }
  }

  forEachActiveProjectile(cb: (dto: ProjectileDTO, index: number) => void): void {
    const count = this.projectileActiveCount;
    const active = this.projectileActive;
    const entries = this.projectileEntries;
    for (let i = 0; i < count; i++) {
      cb(entries[active[i]!]!, i);
    }
  }

  queryItems(cx: number, cy: number, range: number, cb: (dto: ItemDTO) => void): void {
    this.itemGrid?.query(cx, cy, range, (slot) => cb(this.itemEntries[slot]!));
  }

  queryDestructibles(
    cx: number,
    cy: number,
    range: number,
    cb: (dto: DestructibleDTO) => void,
  ): void {
    this.destructibleGrid?.query(cx, cy, range, (slot) => cb(this.destructibleEntries[slot]!));
  }

  queryTraps(cx: number, cy: number, range: number, cb: (dto: TrapDTO) => void): void {
    this.trapGrid?.query(cx, cy, range, (slot) => cb(this.trapEntries[slot]!));
  }

  queryProjectiles(cx: number, cy: number, range: number, cb: (dto: ProjectileDTO) => void): void {
    this.projectileGrid?.query(cx, cy, range, (slot) => cb(this.projectileEntries[slot]!));
  }

  getPlayerById(id: string): PlayerDTO | undefined {
    const slot = this.playerIdToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.playerEntries[slot];
  }

  getItemById(id: string): ItemDTO | undefined {
    const slot = this.itemIdToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.itemEntries[slot];
  }

  getDestructibleById(id: string): DestructibleDTO | undefined {
    const slot = this.destructibleIdToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.destructibleEntries[slot];
  }

  getTrapById(id: string): TrapDTO | undefined {
    const slot = this.trapIdToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.trapEntries[slot];
  }

  getProjectileById(id: string): ProjectileDTO | undefined {
    const slot = this.projectileIdToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.projectileEntries[slot];
  }

  get activePlayerCount(): number {
    return this.playerActiveCount;
  }

  get activeItemCount(): number {
    return this.itemActiveCount;
  }

  get activeDestructibleCount(): number {
    return this.destructibleActiveCount;
  }

  get activeTrapCount(): number {
    return this.trapActiveCount;
  }

  get activeProjectileCount(): number {
    return this.projectileActiveCount;
  }
}
