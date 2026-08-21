import { getStateCallbacks } from '@colyseus/sdk';
import type { Room } from '@colyseus/sdk';
import { netLogger as logger } from '@sector-battle/shared';
import type {
  GameRoomStateData,
  PlayerSchemaData,
  ProjectileSchemaData,
  SchemaMap,
  SiegeSectorSchemaData,
  ZoneSchemaData,
} from '@sector-battle/shared';
import type {
  PlayerState,
  ProjectileState,
  DestructibleState,
  ChestState,
  WeaponPickupState,
  TrapState,
  PowerUpState,
  ExplosionState,
  ExitState,
} from '../types.js';
import {
  toPlayerState,
  onlyPositionChangedPlayer,
  toProjectile,
  onlyPositionChangedProjectile,
  toDestructible,
  toChest,
  toWeaponPickup,
  toTrap,
  toPowerUp,
  toExplosion,
  toExit,
} from './SchemaConverters.js';

export interface EntityMaps {
  players: Map<string, PlayerState>;
  projectiles: Map<string, ProjectileState>;
  destructibles: Map<string, DestructibleState>;
  chests: Map<string, ChestState>;
  weaponPickups: Map<string, WeaponPickupState>;
  traps: Map<string, TrapState>;
  powerUps: Map<string, PowerUpState>;
  explosions: Map<string, ExplosionState>;
  exits: Map<string, ExitState>;
}

export type StateCallbacks = {
  onPlayerAdd: (player: PlayerState, key: string) => void;
  onPlayerRemove: (key: string) => void;
  onPlayerChange: (player: PlayerState, key: string) => void;
  onProjectileAdd: (proj: ProjectileState, key: string) => void;
  onProjectileRemove: (key: string) => void;
  onProjectileChange: (proj: ProjectileState, key: string) => void;
  onDestructibleAdd: (d: DestructibleState, key: string) => void;
  onDestructibleRemove: (key: string) => void;
  onDestructibleChange: (d: DestructibleState, key: string) => void;
  onChestAdd: (c: ChestState, key: string) => void;
  onChestRemove: (key: string) => void;
  onChestChange: (c: ChestState, key: string) => void;
  onWeaponPickupAdd: (wp: WeaponPickupState, key: string) => void;
  onWeaponPickupRemove: (key: string) => void;
  onWeaponPickupChange: (wp: WeaponPickupState, key: string) => void;
  onTrapAdd: (t: TrapState, key: string) => void;
  onTrapRemove: (key: string) => void;
  onTrapChange: (t: TrapState, key: string) => void;
  onPowerUpAdd: (p: PowerUpState, key: string) => void;
  onPowerUpRemove: (key: string) => void;
  onPowerUpChange: (p: PowerUpState, key: string) => void;
  onExplosionAdd: (e: ExplosionState, key: string) => void;
  onExplosionRemove: (key: string) => void;
  onExitAdd: (e: ExitState, key: string) => void;
  onExitRemove: (key: string) => void;
  onExitChange: (e: ExitState, key: string) => void;
  onStateChange: (state: GameRoomStateData) => void;
};

export interface ZoneStateQuery {
  centerX: number;
  centerY: number;
  currentRadius: number;
  targetCenterX: number;
  targetCenterY: number;
  targetRadius: number;
  phaseEndTime: number;
  isTransitioningCenter: boolean;
}

export interface SiegedSectorQuery {
  row: number;
  col: number;
}

export class StateSync {
  private entities: EntityMaps = {
    players: new Map(),
    projectiles: new Map(),
    destructibles: new Map(),
    chests: new Map(),
    weaponPickups: new Map(),
    traps: new Map(),
    powerUps: new Map(),
    explosions: new Map(),
    exits: new Map(),
  };
  private callbacks: StateCallbacks;
  private phase = 0;
  /**
   * The local player's sessionId. Set once in `subscribe(room)` from
   * `room.sessionId`; used by `getLastProcessedInput()` to read the LOCAL
   * player's per-player ack from the entities map (ADR-0033 moved the ack to
   * per-player `PlayerSchema.lastProcessedInput`). The previous implementation
   * read `stateArg.lastProcessedInput` — the GLOBAL ack on `GameStateSchema`,
   * which is the max clientTick across ALL players (incl. bots) and is
   * meaningless for the local player's reconciliation buffer accounting.
   */
  private sessionId = '';
  private playersAlive = 0;
  private matchTimer = 0;
  private tick = 0;
  private zoneState: ZoneStateQuery = {
    centerX: 0,
    centerY: 0,
    currentRadius: 0,
    targetCenterX: 0,
    targetCenterY: 0,
    targetRadius: 0,
    phaseEndTime: 0,
    isTransitioningCenter: false,
  };
  private siegedSectors: SiegedSectorQuery[] = [];

  constructor(callbacks: StateCallbacks) {
    this.callbacks = callbacks;
  }

  subscribe(room: Room): void {
    this.sessionId = room.sessionId;
    const $ = getStateCallbacks(room);
    // `$(room.state)` is the Colyseus decoder-callback proxy. It behaves like
    // the root state (property access returns the same nested MapSchema /
    // Schema instances the raw state exposes) while additionally injecting
    // `onAdd`/`onRemove`/`onChange` on the collections reached through it.
    // Cast through `unknown` because the SDK's `SchemaCallbackProxy` return
    // shape does not structurally overlap with `GameRoomStateData` even though,
    // at runtime, every field access resolves to the same value as `room.state`.
    const s = $(room.state) as unknown as GameRoomStateData;
    const state = room.state as GameRoomStateData;
    const cb = this.callbacks;
    const e = this.entities;

    // Players: rebuild the full PlayerState (incl. a fresh weapons/items
    // extraction) on every patch. The server reuses the nested WeaponSchema
    // slots and mutates their fields in place, so the weapons ArraySchema's own
    // onChange never fires for an equip/swap — caching converted weapons froze
    // players at spawn loadout (rendered as FISTS while the server used the real weapon).
    this.subscribeCollection<PlayerSchemaData, PlayerState>(
      $,
      s.players,
      toPlayerState,
      e.players,
      'player',
      {
        onAdd: cb.onPlayerAdd,
        onChange: cb.onPlayerChange,
        onRemove: cb.onPlayerRemove,
      },
      undefined,
      undefined,
      // Fast path: most player patches are position-only. Mutate x/y/vx/vy in
      // place on the cached PlayerState instead of rebuilding it (avoids a
      // fresh object + weapons/items arrays per patch). onlyPositionChangedPlayer
      // is exhaustive — any non-position change (health/status/weapon swap/etc.)
      // falls through to the full rebuild below.
      (rawItem, existing) => {
        if (!onlyPositionChangedPlayer(rawItem, existing)) return false;
        existing.x = rawItem.x;
        existing.y = rawItem.y;
        existing.velocityX = rawItem.velocityX;
        existing.velocityY = rawItem.velocityY;
        return true;
      },
    );

    // Fast path (ticket 20): in-flight projectile patches are position-only —
    // x/y/vx/vy change every tick, everything else is structural. Mutate the
    // four kinematic fields in place on the cached ProjectileState instead of
    // allocating a fresh object per projectile per patch (the player fast-path
    // pattern above). onlyPositionChangedProjectile is exhaustive — a bounce
    // decrement, damage change, or weapon/tier swap falls through to the full
    // toProjectile rebuild below.
    this.subscribeCollection<ProjectileSchemaData, ProjectileState>(
      $,
      s.projectiles,
      toProjectile,
      e.projectiles,
      'projectile',
      {
        onAdd: cb.onProjectileAdd,
        onChange: cb.onProjectileChange,
        onRemove: cb.onProjectileRemove,
      },
      undefined,
      undefined,
      (rawItem, existing) => {
        if (!onlyPositionChangedProjectile(rawItem, existing)) return false;
        existing.x = rawItem.x;
        existing.y = rawItem.y;
        existing.velocityX = rawItem.velocityX;
        existing.velocityY = rawItem.velocityY;
        return true;
      },
    );

    this.subscribeCollection(
      $,
      s.destructibles,
      toDestructible,
      e.destructibles,
      'destructible',
      {
        onAdd: cb.onDestructibleAdd,
        onChange: cb.onDestructibleChange,
        onRemove: cb.onDestructibleRemove,
      },
      (_raw, updated, key) => {
        if (updated.isDestroyed || updated.type === 1)
          logger.debug(
            `destructible onChange: key=${key} type=${updated.type} hp=${updated.hp}/${updated.maxHp} isDestroyed=${updated.isDestroyed}`,
          );
      },
      (key) => logger.debug(`destructible onRemove: key=${key}`),
    );

    this.subscribeCollection($, s.chests, toChest, e.chests, 'chest', {
      onAdd: cb.onChestAdd,
      onChange: cb.onChestChange,
      onRemove: cb.onChestRemove,
    });

    this.subscribeCollection($, s.weaponPickups, toWeaponPickup, e.weaponPickups, 'weaponPickup', {
      onAdd: cb.onWeaponPickupAdd,
      onChange: cb.onWeaponPickupChange,
      onRemove: cb.onWeaponPickupRemove,
    });

    this.subscribeCollection($, s.traps, toTrap, e.traps, 'trap', {
      onAdd: cb.onTrapAdd,
      onChange: cb.onTrapChange,
      onRemove: cb.onTrapRemove,
    });

    this.subscribeCollection($, s.powerUps, toPowerUp, e.powerUps, 'powerUp', {
      onAdd: cb.onPowerUpAdd,
      onChange: cb.onPowerUpChange,
      onRemove: cb.onPowerUpRemove,
    });

    // Explosions have no onChange — there is no onExplosionChange callback.
    this.subscribeCollection($, s.explosions, toExplosion, e.explosions, 'explosion', {
      onAdd: cb.onExplosionAdd,
      onRemove: cb.onExplosionRemove,
    });

    this.subscribeCollection($, s.exits, toExit, e.exits, 'exit', {
      onAdd: cb.onExitAdd,
      onChange: cb.onExitChange,
      onRemove: cb.onExitRemove,
    });

    room.onStateChange((stateArg: GameRoomStateData) => {
      this.phase = stateArg.phase ?? 0;
      this.playersAlive = stateArg.playersAlive ?? 0;
      this.matchTimer = stateArg.matchTimer ?? 0;
      this.tick = stateArg.tick ?? 0;
      this.syncZone(stateArg.zone);
      this.syncSiegedSectors(stateArg.siegedSectors);
      this.callbacks.onStateChange(stateArg);
    });

    if (state.zone) {
      const zoneProxy = state.zone;
      this.syncZone(zoneProxy);
      $(zoneProxy).onChange(() => {
        this.syncZone(zoneProxy);
      });
    }

    // Colyseus schema-callbacks API: collection callbacks MUST go through the
    // `$` state-callbacks proxy (`s.siegedSectors`), exactly like the entity
    // collections above. A raw MapSchema has no `.onAdd`/`.onChange` method —
    // `state.siegedSectors.onAdd(...)` throws "onAdd is not a
    // function", which aborted the whole scene setup (and prevented the
    // `mapData` handler from ever being registered → black map).
    const siegedSectors = state.siegedSectors;
    if (siegedSectors) {
      this.syncSiegedSectors(siegedSectors);
      s.siegedSectors.onAdd((sector: SiegeSectorSchemaData) => {
        this.syncSiegedSectors(siegedSectors);
        $(sector).onChange(() => this.syncSiegedSectors(siegedSectors));
      });
      s.siegedSectors.onRemove(() => this.syncSiegedSectors(siegedSectors));
    }
  }

  // Generic entity subscriber: onAdd → convert → store → onAdd; onChange (only
  // when provided) goes through the `$` proxy (per-property detection needs it —
  // raw `item.onChange` breaks silently): convert → onChangeExtra → store →
  // onChange; onRemove → onRemoveExtra → delete → onRemove.
  private subscribeCollection<TSchema, TState>(
    $: ReturnType<typeof getStateCallbacks>,
    collection: SchemaMap<TSchema>,
    converter: (schema: TSchema) => TState,
    entityMap: Map<string, TState>,
    label: string,
    cbs: {
      onAdd: (entity: TState, key: string) => void;
      onChange?: (entity: TState, key: string) => void;
      onRemove: (key: string) => void;
    },
    onChangeExtra?: (rawItem: TSchema, converted: TState, key: string) => void,
    onRemoveExtra?: (key: string) => void,
    /**
     * Optional zero-allocation fast path. When provided and it returns true,
     * the cached entity is mutated in place (by the callback) and no fresh
     * object is built. Returning false falls through to the full converter
     * rebuild.
     */
    fastPath?: (rawItem: TSchema, existing: TState) => boolean,
  ): void {
    collection.onAdd((item: TSchema, key: string) => {
      try {
        const converted = converter(item);
        entityMap.set(key, converted);
        cbs.onAdd(converted, key);
        const onChange = cbs.onChange;
        if (!onChange) return;
        $(item).onChange(() => {
          try {
            if (!item) return;
            const existing = entityMap.get(key);
            if (existing && fastPath && fastPath(item, existing)) {
              onChangeExtra?.(item, existing, key);
              onChange(existing, key);
              return;
            }
            const updated = converter(item);
            onChangeExtra?.(item, updated, key);
            entityMap.set(key, updated);
            onChange(updated, key);
          } catch (err) {
            logger.warn(`${label} instance onChange error`, err);
          }
        });
      } catch (err) {
        logger.warn(`${label} onAdd error`, err);
      }
    });
    collection.onRemove((_: TSchema, key: string) => {
      onRemoveExtra?.(key);
      entityMap.delete(key);
      cbs.onRemove(key);
    });
  }

  getEntities(): EntityMaps {
    return this.entities;
  }
  getPhase(): number {
    return this.phase;
  }
  /**
   * Return the LOCAL player's per-player `lastProcessedInput` (ADR-0033). The
   * ack lives on `PlayerSchema.lastProcessedInput` and is synced per-player by
   * `StateMapper.playerToSchema` — reading the global `GameStateSchema`
   * counter (max clientTick across ALL players, incl. bots) gave a value
   * meaningless for the local reconciliation buffer. Falls back to 0 until the
   * local player's schema entry has been received.
   */
  getLastProcessedInput(): number {
    return this.entities.players.get(this.sessionId)?.lastProcessedInput ?? 0;
  }
  getPlayersAlive(): number {
    return this.playersAlive;
  }
  getMatchTimer(): number {
    return this.matchTimer;
  }
  getTick(): number {
    return this.tick;
  }
  getPlayer(id: string): PlayerState | undefined {
    return this.entities.players.get(id);
  }

  /**
   * The live destructibles map (server-authoritative schema state; destroyed
   * entities are deleted server-side, so presence == alive). Ticket 08: read
   * ONCE at map load by the late-join light-placement cull
   * (`cullDestroyedLightPlacements`) — a late joiner must not see lights whose
   * backing entities died before it joined. Read-only view — callers must not
   * mutate the schema-synced map.
   */
  getDestructibles(): ReadonlyMap<string, DestructibleState> {
    return this.entities.destructibles;
  }

  getZoneState(): ZoneStateQuery {
    return this.zoneState;
  }

  getSiegedSectors(): SiegedSectorQuery[] {
    return this.siegedSectors;
  }

  private syncZone(zone: ZoneSchemaData | null | undefined): void {
    if (!zone) return;
    this.zoneState = {
      centerX: zone.centerX ?? 0,
      centerY: zone.centerY ?? 0,
      currentRadius: zone.currentRadius ?? 0,
      targetCenterX: zone.targetCenterX ?? 0,
      targetCenterY: zone.targetCenterY ?? 0,
      targetRadius: zone.targetRadius ?? 0,
      phaseEndTime: zone.phaseEndTime ?? 0,
      isTransitioningCenter: zone.isTransitioningCenter ?? false,
    };
  }

  private syncSiegedSectors(sieged: SchemaMap<SiegeSectorSchemaData> | null | undefined): void {
    if (!sieged) {
      this.siegedSectors = [];
      return;
    }
    const sectors: SiegedSectorQuery[] = [];
    sieged.forEach((s: SiegeSectorSchemaData) => {
      if (s.active) {
        sectors.push({ row: s.row, col: s.col });
      }
    });
    this.siegedSectors = sectors;
  }
}
