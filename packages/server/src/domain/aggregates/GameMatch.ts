import {
  TileType,
  MatchPhase,
  IdGenerator,
  ObjectPool,
  SeededRNG,
  type GameConfig,
  type ZoneState,
  type SpawnPoint,
  type TileColliderData,
} from '@sector-battle/shared';
import { BarrelExplosionManager } from './BarrelExplosionManager.ts';
import { DomainSpatialIndex } from './DomainSpatialIndex.ts';
import { rebuildSpatialIndexAction } from './GameMatchSpatialIndex.ts';
import { initZoneState, initMatchHandlers, buildMatchHandlerDeps } from './GameMatchInit.ts';
import {
  isTileBlocked as isTileBlockedFn,
  getTileAt as getTileAtFn,
  setTileAt as setTileAtFn,
  worldToGrid as worldToGridFn,
} from './GameMatchGrid.ts';
import { movePlayerAction, applyZoneDamageAction } from './GameMatchActions.ts';
import { Position } from '../value-objects/index.ts';
import {
  Player,
  Projectile,
  PowerUp,
  Trap,
  Chest,
  Destructible,
  Exit,
  Explosion,
  WeaponPickup,
  WeaponEntity,
  type DamageResult,
} from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';
import type { EntityMaps } from './GameMatchEntityOps.ts';
import * as EntityOps from './GameMatchEntityOps.ts';
import { createTileEntityIndex, type TileEntityIndex } from './GameMatchTileIndex.ts';
import type { Interactable } from '../types/Interactable.ts';
import type { ICollisionService } from '../services/ICollisionService.ts';
import type { DamagePipeline } from '../services/DamagePipeline.ts';
import type { ThrowHandler } from '../handlers/ThrowHandler.ts';
import type { RangedHandler } from '../handlers/RangedHandler.ts';
import { ChestOpeningHandler } from '../handlers/ChestOpeningHandler.ts';
import type { HydrationResult } from '../services/MapEntityHydrator.ts';
import type { MapResult } from '../services/MapGenerator.ts';
import {
  handleWeaponBreakForMatch,
  dropPlayerWeaponsForMatch,
  dropBoomerangsForDeadPlayerForMatch,
} from './GameMatchWeapons.ts';
import {
  handleTeleportTrapAction,
  triggerBarrelExplosionAction,
  updateExplosionsAction,
  updateProjectilesAction,
  setRangedColliderDataAction,
  destroyDestructibleForMatch,
} from './GameMatchProjectiles.ts';
import type { ProjectileUpdateContext } from './GameMatchProjectileUpdater.ts';
import type {
  ProjectileConvertCallback,
  BoomerangReturnCallback,
} from './GameMatchProjectileUpdater.ts';
import { type MatchServices, type MatchPools } from './createMatchServices.ts';
import { hydrateMatchEntities } from './GameMatchHydration.ts';
import { getMatchStateCached } from './GameMatchState.ts';
import {
  addPlayerAction,
  removePlayerAction,
  hardRemovePlayerForBenchmarkAction,
  getPlayerAction,
  getPlayersAction,
  forEachAlivePlayerAction,
  getAlivePlayerCountAction,
  getPlayersCountAction,
} from './GameMatchPlayers.ts';

export class GameMatch {
  readonly matchId: string;
  readonly mapSeed: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  players: Map<string, Player>;
  barrelExplosionManager: BarrelExplosionManager;
  projectiles: Map<string, Projectile>;
  powerUps: Map<string, PowerUp>;
  traps: Map<string, Trap>;
  chests: Map<string, Chest>;
  destructibles: Map<string, Destructible>;
  weaponPickups: Map<string, WeaponPickup>;
  exits: Map<string, Exit>;
  explosions: Map<string, Explosion>;
  grid: TileType[][];
  spawnPoints: SpawnPoint[];
  nextSpawnIndex = 0;
  nextColorIndex = 0; // round-robin counter for player color (ASSIGNABLE_COLOR_INDICES)
  tick = 0;
  eventCollector = new EventCollector<GameEvent>();
  private phase: MatchPhase;
  private matchTimer: number;
  private zone!: ZoneState;
  idGenerator: IdGenerator;
  readonly config: GameConfig;
  collisionService: ICollisionService;
  damagePipeline: DamagePipeline;
  throwHandler: ThrowHandler;
  rangedHandler: RangedHandler;
  private chestOpeningHandler: ChestOpeningHandler;
  lootRng: SeededRNG;
  projectilePool: ObjectPool<Projectile>;
  explosionPool: ObjectPool<Explosion>;
  projectileMeta: Map<
    string,
    { createdAtTick: number; distanceTraveled: number; embeddedTick: number }
  >;
  /**
   * server-context-copy-elimination: per-match projectile-update context,
   * lazily built once by `updateProjectilesAction`
   * (GameMatchProjectiles.ts) and reused every tick — only the volatile
   * fields (`tick`, the two callbacks) are refreshed per call. Owned by
   * GameMatch (not module scope) so concurrent matches in one process never
   * share it.
   */
  projectileUpdateCtx: ProjectileUpdateContext | null = null;
  colliderData: TileColliderData | null = null;
  private _gridDirty = false;
  /** Maintained alive-player count — see {@linkcode getAlivePlayerCount}. */
  private _aliveCount = 0;
  /** Incremented on trap add/remove; polled to rebuild the trap grid only on change. */
  trapVersion = 0;
  /** ticket 08 — static-row sync-gate counter (audit list: StateMapperSync.StaticRowGate). */
  destructibleVersion = 0;
  /** ticket 08 — exits counterpart (add-only today). */
  exitVersion = 0;
  /** ticket 10 — orphan-sweep dirty gate (audit list: GameSimulationLoot.processDestroyedDestructibles). */
  orphanSweepVersion = 0;
  /** server-chest-cancel-index: player→opening-chest-ids — see GameMatchEntityOps. */
  readonly openingChestsByPlayer: EntityOps.ChestOpeningIndex = new Map();
  readonly tileIndex: TileEntityIndex; // siege-tile-index (ticket 09) — see GameMatchTileIndex.ts
  /**
   * server-domain-spatial-hash: per-tick domain broadphase over alive players
   * + active destructibles, rebuilt once per tick from step2 (post-movement).
   * See {@linkcode DomainSpatialIndex} for the snapshot + determinism
   * contracts (rebuild action: GameMatchSpatialIndex.ts).
   */
  spatialIndex: DomainSpatialIndex | null = null;
  private _maps!: EntityMaps;

  constructor(
    matchId: string,
    config: GameConfig,
    grid: TileType[][],
    spawnPoints: SpawnPoint[],
    services: MatchServices,
    pools: MatchPools,
    lootRng: SeededRNG,
  ) {
    this.matchId = matchId;
    this.config = config;
    this.mapSeed = 0;
    this.mapWidth = grid[0]?.length ?? 0;
    this.mapHeight = grid.length;
    this.grid = grid;
    this.spawnPoints = spawnPoints;
    this.tick = 0;
    this.phase = MatchPhase.WAITING;
    this.matchTimer = 0;
    this.players = new Map();
    this.projectiles = new Map();
    this.powerUps = new Map();
    this.traps = new Map();
    this.chests = new Map();
    this.destructibles = new Map();
    this.weaponPickups = new Map();
    this.exits = new Map();
    this.explosions = new Map();
    this.idGenerator = new IdGenerator('match');
    this.collisionService = services.collisionService;
    this.damagePipeline = services.damagePipeline;
    this.throwHandler = services.throwHandler;
    this.rangedHandler = services.rangedHandler;
    this.lootRng = lootRng;
    this.projectilePool = pools.projectilePool;
    this.explosionPool = pools.explosionPool;
    this.projectileMeta = pools.projectileMeta;
    this.tileIndex = createTileEntityIndex(config.map.tileWidth, config.map.tileHeight);
    this._maps = EntityOps.createEntityMaps(this);
    const handlers = initMatchHandlers(buildMatchHandlerDeps(this, services));
    this.barrelExplosionManager = handlers.barrelExplosionManager;
    this.chestOpeningHandler = handlers.chestOpeningHandler;
    this.zone = initZoneState(this.mapWidth, this.mapHeight);
  }

  addPlayer(id: string, name: string): Player {
    return addPlayerAction(this, id, name);
  }
  removePlayer(id: string): void {
    removePlayerAction(this, id);
  }
  /** HARD-remove — full contract documented on {@linkcode hardRemovePlayerForBenchmarkAction}. */
  hardRemovePlayerForBenchmark(id: string): void {
    hardRemovePlayerForBenchmarkAction(this, id);
  }
  getPlayer(id: string): Player | undefined {
    return getPlayerAction(this, id);
  }
  getPlayers(): Player[] {
    return getPlayersAction(this);
  }
  get alivePlayerCount(): number {
    return this.getAlivePlayerCount();
  }
  forEachAlivePlayer(callback: (player: Player) => void): void {
    forEachAlivePlayerAction(this, callback);
  }
  /** server-domain-spatial-hash: per-tick broadphase rebuild (see GameMatchSpatialIndex.ts). */
  rebuildSpatialIndex(): DomainSpatialIndex {
    return rebuildSpatialIndexAction(this);
  }
  /**
   * Maintained alive-player count (server-alive-counter). O(1) — replaces the
   * per-call full O(n) players scan that previously ran on every damage event.
   * Updated exclusively at the audited aliveness transitions:
   *   - GameMatchPlayers addPlayerAction / removePlayerAction /
   *     hardRemovePlayerForBenchmarkAction (map membership + soft DEAD write)
   *   - Player.onAlivenessTransition hook, fired by PlayerLifecycle whenever
   *     the ALIVE status bit flips (die / dieWithTick / completeDeath / revive)
   * The full scan remains available as {@linkcode scanAlivePlayerCount} and
   * {@linkcode aliveCountMatchesScan} verifies the two agree (dev/test assert).
   */
  getAlivePlayerCount(): number {
    return this._aliveCount;
  }
  /** Full O(n) scan recount — the pre-counter source of truth, kept for the dev drift assertion. */
  scanAlivePlayerCount(): number {
    return getAlivePlayerCountAction(this);
  }
  /** Dev/test assertion: the maintained counter must equal the full scan. */
  aliveCountMatchesScan(): boolean {
    return this._aliveCount === this.scanAlivePlayerCount();
  }
  /**
   * ONLY for the aliveness-transition chokepoints listed on
   * {@linkcode getAlivePlayerCount}. Not a general-purpose API.
   */
  adjustAliveCount(delta: number): void {
    this._aliveCount += delta;
  }
  get playersCount(): number {
    return getPlayersCountAction(this);
  }

  movePlayer(id: string, newPosition: Position): GameEvent[] {
    return movePlayerAction(this.players, id, newPosition);
  }

  handleTeleportTrap(playerId: string): Position | null {
    return handleTeleportTrapAction(this, playerId);
  }

  triggerBarrelExplosion(
    gridX: number,
    gridY: number,
    _range: number,
    _damage: number,
    sourceOwnerId: string,
    currentTick: number,
  ): GameEvent[] {
    return triggerBarrelExplosionAction(
      this,
      gridX,
      gridY,
      _range,
      _damage,
      sourceOwnerId,
      currentTick,
    );
  }
  updateExplosions(): void {
    updateExplosionsAction(this);
  }

  updateProjectiles(
    dt: number,
    onConvertToPickup?: ProjectileConvertCallback,
    onBoomerangReturn?: BoomerangReturnCallback,
  ): GameEvent[] {
    return updateProjectilesAction(this, dt, onConvertToPickup, onBoomerangReturn);
  }

  setRangedColliderData(data: TileColliderData | null): void {
    setRangedColliderDataAction(this, data);
  }

  addWeaponPickup(
    id: string,
    weapon: WeaponEntity,
    position: Position,
    textureKey?: string,
    rotation?: number,
    flipH?: boolean,
    flipV?: boolean,
  ): void {
    // prettier-ignore
    EntityOps.addWeaponPickup(this._maps, id, weapon, position, this.tick, textureKey, rotation, flipH, flipV);
  }
  removeWeaponPickup(id: string): void {
    EntityOps.removeWeaponPickup(this._maps, id);
  }
  getWeaponPickupAt(x: number, y: number, range: number): WeaponPickup | undefined {
    return EntityOps.getWeaponPickupAt(this._maps, x, y, range);
  }
  getInteractablesInRange(playerPos: Position, range: number): Interactable[] {
    return EntityOps.getInteractablesInRange(this._maps, playerPos, range);
  }
  addProjectile(p: Projectile): void {
    EntityOps.addProjectile(this._maps, p, this.tick);
  }
  removeProjectile(id: string): void {
    EntityOps.removeProjectile(this._maps, id, this.projectilePool);
  }
  addExplosion(e: Explosion): void {
    EntityOps.addExplosion(this._maps, e);
  }
  addPowerUp(p: PowerUp): void {
    EntityOps.addPowerUp(this._maps, p);
  }
  addTrap(t: Trap): void {
    EntityOps.addTrap(this._maps, t);
    this.trapVersion++;
  }
  checkTrapReveals(): void {
    EntityOps.checkTrapReveals(this._maps, this.config.map.tileWidth);
  }
  addChest(c: Chest): void {
    EntityOps.addChest(this._maps, c);
  }
  cancelChestOpeningForPlayer(playerId: string): void {
    EntityOps.cancelChestOpeningForPlayer(this._maps, this.openingChestsByPlayer, playerId);
  }
  addDestructible(d: Destructible): void {
    EntityOps.addDestructible(this._maps, d);
    this.destructibleVersion++;
    this.orphanSweepVersion++; // ticket 10 — a new destructible may land on an EMPTY tile
  }
  addExit(e: Exit): void {
    EntityOps.addExit(this._maps, e);
    this.exitVersion++;
  }

  destroyDestructible(id: string, droppedLoot?: unknown): GameEvent[] {
    const events = destroyDestructibleForMatch(this, id, droppedLoot);
    this.destructibleVersion++;
    return events;
  }

  findDestructibleAtTile(gx: number, gy: number): string | null {
    return EntityOps.findDestructibleAtTile(this._maps, gx, gy);
  }
  findChestAtTile(gx: number, gy: number): string | null {
    return EntityOps.findChestAtTile(this._maps, gx, gy);
  }
  findWeaponPickupAtTile(gx: number, gy: number): string | null {
    return EntityOps.findWeaponPickupAtTile(this._maps, gx, gy);
  }
  findPowerUpAtTile(gx: number, gy: number): string | null {
    return EntityOps.findPowerUpAtTile(this._maps, gx, gy);
  }
  findTrapAtTile(gx: number, gy: number): string | null {
    return EntityOps.findTrapAtTile(this._maps, gx, gy);
  }
  removeChestById(id: string): void {
    EntityOps.removeChestById(this._maps, this.openingChestsByPlayer, id);
  }
  removeWeaponPickupById(id: string): void {
    EntityOps.removeWeaponPickupById(this._maps, id);
  }
  removePowerUpById(id: string): void {
    EntityOps.removePowerUpById(this._maps, id);
  }
  removeTrapById(id: string): void {
    EntityOps.removeTrapById(this._maps, id);
    this.trapVersion++;
  }
  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }
  emitEvent(event: GameEvent): void {
    this.eventCollector.emit(event);
  }

  isTileBlocked(gridX: number, gridY: number): boolean {
    return isTileBlockedFn(this.grid, gridX, gridY);
  }
  getTileAt(gridX: number, gridY: number): TileType {
    return getTileAtFn(this.grid, gridX, gridY);
  }
  setTileAt(gridX: number, gridY: number, type: TileType): void {
    setTileAtFn(this.grid, gridX, gridY, type, this.colliderData, this.collisionService);
    if (type === TileType.EMPTY) this.orphanSweepVersion++; // ticket 10 — cleared tile can orphan a destructible
    this._gridDirty = true;
  }
  getGrid(): TileType[][] {
    return this.grid;
  }
  markGridDirty(): void {
    this._gridDirty = true;
  }
  consumeGridDirty(): boolean {
    const d = this._gridDirty;
    this._gridDirty = false;
    return d;
  }
  getDestructibles(): Map<string, Destructible> {
    return EntityOps.getDestructibles(this._maps);
  }
  worldToGrid(worldX: number, worldY: number): { gridX: number; gridY: number } {
    return worldToGridFn(this.config.map.tileWidth, this.config.map.tileHeight, worldX, worldY);
  }
  advanceTick(): void {
    this.tick++;
    this.matchTimer++;
  }
  nextId(): string {
    return this.idGenerator.next();
  }
  get currentTick(): number {
    return this.tick;
  }
  get currentPhase(): MatchPhase {
    return this.phase;
  }
  setPhase(phase: MatchPhase): void {
    this.phase = phase;
  }

  applyZoneDamage(playerId: string, amount: number): DamageResult {
    return applyZoneDamageAction(this.players, this.damagePipeline, this.tick, playerId, amount);
  }
  get matchTime(): number {
    return this.matchTimer;
  }

  getState() {
    return getMatchStateCached(
      this,
      this._maps,
      this.tick,
      this.phase,
      this.zone,
      this.grid,
      this.matchTimer,
    );
  }
  getCollisionService(): ICollisionService {
    return this.collisionService;
  }
  getDamagePipeline(): DamagePipeline {
    return this.damagePipeline;
  }
  get tileWidth(): number {
    return this.config.map.tileWidth;
  }
  getActiveTraps(): Trap[] {
    return EntityOps.getActiveTraps(this._maps);
  }
  getChests(): Chest[] {
    return EntityOps.getChests(this._maps);
  }
  removeChest(id: string): void {
    EntityOps.removeChest(this._maps, this.openingChestsByPlayer, id);
  }
  step8_TickChestOpenings(dt: number): void {
    this.chestOpeningHandler.tickOpenings(dt);
  }

  handleWeaponBreak(playerId: string, slotIndex: number): GameEvent[] {
    return handleWeaponBreakForMatch(this, playerId, slotIndex);
  }
  dropPlayerWeapons(playerId: string): void {
    dropPlayerWeaponsForMatch(this, playerId);
  }
  dropBoomerangsForDeadPlayer(playerId: string): void {
    dropBoomerangsForDeadPlayerForMatch(this, playerId);
  }
  hydrateEntities(mapResult: MapResult): HydrationResult {
    this.destructibleVersion++;
    this.orphanSweepVersion++; // ticket 10 — hydrated destructibles may land on EMPTY tiles
    return hydrateMatchEntities(this._maps, mapResult, this.config.map.tileWidth, this.mapSeed);
  }
}
