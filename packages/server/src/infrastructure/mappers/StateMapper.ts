import {
  PlayerSchema,
  ProjectileSchema,
  PowerUpSchema,
  TrapSchema,
  ChestSchema,
  DestructibleSchema,
  ExitSchema,
  ExplosionSchema,
  ZoneSchema,
  GameStateSchema,
  WeaponSchema,
  WeaponPickupSchema,
} from '../schemas/index.ts';
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
} from '../../domain/entities/index.ts';
import type { GamePowerUpType } from '../../domain/entities/index.ts';
import {
  PowerUpType,
  NETWORK,
  PLAYER,
  BARREL,
  AttackType,
  resolveAttackType,
} from '@sector-battle/shared';
import type { ZoneState } from '@sector-battle/shared';
import {
  StateMapperSync,
  entitySyncRow,
  DESTRUCTIBLE_ROW_GATE,
  EXIT_ROW_GATE,
  type ErasedEntitySyncRow,
} from './StateMapperSync.ts';
import {
  TIER_ORDER,
  CHEST_TIER_ORDER,
  CHEST_STATE_ORDER,
  DESTRUCTIBLE_TYPE_ORDER,
  type MatchMeta,
  type MatchState,
  type AnimWireFields,
  type AnimStateResolver,
} from './StateMapperTypes.ts';

// Public surface stability (#23 type move): re-export everything that used to
// live in this module so historical import paths keep working.
export type {
  MatchMeta,
  MatchState,
  AnimWireFields,
  AnimStateResolver,
} from './StateMapperTypes.ts';
export { TIER_ORDER, CHEST_TIER_ORDER } from './StateMapperTypes.ts';

export class StateMapper {
  /**
   * Zero-state fallback for the 3 animation wire fields, used when
   * `mapDelta`'s `getAnimState` resolver returns `undefined` for a player
   * (e.g. a freshly spawned player with no `PlayerAnimationSystem` state
   * yet). Matches a freshly constructed `AnimSimState` (AnimPhase.IDLE @
   * tick 0, no combo progress) so the wire never goes stale.
   */
  private static readonly ZERO_ANIM_WIRE_FIELDS: Readonly<AnimWireFields> = Object.freeze({
    phase: 0,
    phaseStartTick: 0,
    comboIndex: 0,
  });
  /**
   * Project a domain `Player` onto its wire `PlayerSchema`.
   *
   * The 3 animation wire fields (`animPhase` / `animPhaseStartTick` /
   * `comboIndex`) are sourced from `animState`, the authoritative projection
   * from `PlayerAnimationSystem`'s `AnimSimState` (#10a). `comboIndex` is
   * masked to uint8 to match the wire shape.
   */
  static playerToSchema(player: Player, schema: PlayerSchema, animState: AnimWireFields): void {
    schema.id = player.id;
    schema.name = player.name;
    schema.color = player.color;
    schema.x = player.movement.position.x;
    schema.y = player.movement.position.y;
    schema.direction = player.movement.direction.value;
    schema.facingAngle = player.movement.facingAngle;
    schema.speed = player.movement.speed.value;
    schema.velocityX = player.movement.velocityX;
    schema.velocityY = player.movement.velocityY;
    schema.health = player.health.current;
    schema.maxHealth = player.health.max;
    schema.status = player.statusEffects.status;
    schema.kills = player.kills;
    schema.activeSlot = player.inventory.activeSlot;
    schema.lastDamageTick = player.statusEffects.lastDamageTick;
    schema.dashCooldown = player.movement.dashCooldownRemaining;
    schema.barrierActive = player.statusEffects.barrierActive;
    // Shield blocking is PASSIVE: a shield blocks whenever it's the active
    // weapon and the player is in a blockable state (not staggered / dashing).
    // The raised-shield visual must reflect that, so the client shows the
    // shield up whenever it would actually block — not only during a bash (the
    // old isBlocking flag was set only on bash execution, leaving the shield
    // visually lowered during passive blocks, which read as "block not
    // working"). Derive the sync flag from equipped-shield + blockable-state.
    // (Fresh-spawn invulnerability also disables blocking but is rare and
    // brief; the visual staying raised during it is harmless.)
    const activeWeapon = player.getActiveWeapon();
    schema.isBlocking =
      resolveAttackType(activeWeapon.type) === AttackType.SHIELD &&
      !player.isStaggered() &&
      !player.movement.isDashing;
    schema.speedBoostActive = player.statusEffects.speedBoostExpiryTick > 0;
    schema.connected = player.connected;
    schema.isBot = player.isBot;
    schema.barrierExpiryTick = player.statusEffects.barrierExpiryTick;
    schema.speedBoostExpiryTick = player.statusEffects.speedBoostExpiryTick;
    schema.freshSpawnExpiryTick = player.statusEffects.freshSpawnExpiryTick;
    schema.lastProcessedInput = player.lastProcessedInput;
    const inWindup = player.combat.isInWindup();
    schema.isWindupActive = inWindup;
    schema.windupWeaponType = inWindup
      ? (player.inventory.weapons[player.combat.windupWeaponSlot]?.type ?? 0)
      : 0;
    schema.windupAttackType = inWindup ? (player.combat.windupAttackType ?? '') : '';
    schema.animPhase = animState.phase;
    schema.animPhaseStartTick = animState.phaseStartTick;
    schema.comboIndex = animState.comboIndex & 0xff;

    const weapons = player.inventory;
    while (schema.weapons.length > PLAYER.INVENTORY_SIZE) {
      schema.weapons.splice(schema.weapons.length - 1, 1);
    }
    for (let i = 0; i < PLAYER.INVENTORY_SIZE; i++) {
      const src = weapons.weapons[i];
      let ws = schema.weapons.at(i);
      if (!ws) {
        ws = new WeaponSchema();
        schema.weapons.push(ws);
      }
      if (src) {
        ws.id = src.id;
        ws.weaponType = src.type;
        ws.tier = TIER_ORDER[src.tier] ?? 0;
        ws.ammo = src.ammo;
        ws.maxAmmo = src.maxAmmo;
      } else {
        ws.id = '';
        ws.weaponType = 0;
        ws.tier = 0;
        ws.ammo = 0;
        ws.maxAmmo = 0;
      }
    }

    while (schema.items.length > player.items.length) {
      schema.items.splice(schema.items.length - 1, 1);
    }
    for (let i = 0; i < player.items.length; i++) {
      if (schema.items.at(i) !== player.items[i]) {
        schema.items[i] = player.items[i]!;
      }
    }
  }

  /**
   * Player sync-row projector (module-stable — zero per-tick allocation).
   * The per-call animation resolver arrives as an argument, threaded through
   * `StateMapperSync.syncMap` from `mapDelta`, instead of being closed over.
   */
  private static projectPlayerWithAnim(
    player: Player,
    schema: PlayerSchema,
    getAnimState: AnimStateResolver,
  ): void {
    const animState = getAnimState(player.id) ?? StateMapper.ZERO_ANIM_WIRE_FIELDS;
    StateMapper.playerToSchema(player, schema, animState);
  }

  static projectileToSchema(projectile: Projectile, schema: ProjectileSchema): void {
    schema.id = projectile.id;
    schema.ownerId = projectile.ownerId;
    schema.x = projectile.position.x;
    schema.y = projectile.position.y;
    schema.velocityX = projectile.velocityX;
    schema.velocityY = projectile.velocityY;
    schema.damage = projectile.damage;
    schema.bounces = projectile.bouncesRemaining;
    schema.weaponType = projectile.weaponType;
    schema.tier = TIER_ORDER[projectile.tier] ?? 0;
  }

  private static readonly POWER_UP_TYPE_MAP: Record<GamePowerUpType, number> = {
    health_pack: PowerUpType.HEALTH_PACK,
    barrier: PowerUpType.BARRIER,
    speed_boost: PowerUpType.SPEED_BOOST,
  };

  static powerUpToSchema(powerUp: PowerUp, schema: PowerUpSchema): void {
    schema.id = powerUp.id;
    schema.type = StateMapper.POWER_UP_TYPE_MAP[powerUp.type];
    schema.x = powerUp.position.x;
    schema.y = powerUp.position.y;
    schema.isActive = powerUp.isActive;
  }

  static trapToSchema(trap: Trap, schema: TrapSchema): void {
    schema.id = trap.id;
    schema.type = trap.type;
    schema.x = trap.position.x;
    schema.y = trap.position.y;
    schema.isRevealed = trap.isRevealed;
    schema.cooldownRemaining = trap.cooldownRemaining;
    schema.textureKey = trap.textureKey;
    schema.rotation = (trap.rotation * Math.PI) / 180;
    schema.flipH = trap.flipH;
    schema.flipV = trap.flipV;
    schema.fireAreaActive = trap.fireAreaActive;
    schema.fireAreaRemainingMs = (trap.fireAreaRemainingTicks / 60) * 1000;
  }

  static chestToSchema(chest: Chest, schema: ChestSchema): void {
    schema.id = chest.id;
    schema.x = chest.position.x;
    schema.y = chest.position.y;
    schema.tier = CHEST_TIER_ORDER[chest.tier] ?? 0;
    schema.state = CHEST_STATE_ORDER[chest.state];
    schema.openingPlayerId = chest.openingPlayerId ?? '';
    schema.openingProgress = chest.openingProgress;
    schema.textureKey = chest.textureKey;
    schema.rotation = (chest.rotation * Math.PI) / 180;
    schema.flipH = chest.flipH;
    schema.flipV = chest.flipV;
  }

  static destructibleToSchema(destructible: Destructible, schema: DestructibleSchema): void {
    schema.id = destructible.id;
    schema.type = DESTRUCTIBLE_TYPE_ORDER[destructible.type];
    schema.hp = destructible.type === 'iron' ? 255 : Math.min(255, destructible.hp);
    schema.maxHp = destructible.type === 'iron' ? 255 : Math.min(255, destructible.maxHp);
    schema.x = destructible.position.x;
    schema.y = destructible.position.y;
    schema.isDestroyed = destructible.isDestroyed;
    // Juice-pass-1 ticket 05 — primed-barrel fuse (GDD §5.5): live-synced
    // per patch (syncMap re-runs this mapper every sync, the hp/maxHp
    // precedent) so the client can drive the escalating primed fire.
    schema.primed = destructible.primed;
    schema.fuseExpiresAtTick = destructible.fuseExpiresAtTick;
    schema.textureKey = destructible.textureKey;
    schema.rotation = (destructible.rotation * Math.PI) / 180;
    schema.flipH = destructible.flipH;
    schema.flipV = destructible.flipV;
  }

  static exitToSchema(exit: Exit, schema: ExitSchema): void {
    schema.id = exit.id;
    schema.x = exit.position.x;
    schema.y = exit.position.y;
    schema.gridX = exit.gridCoord.x;
    schema.gridY = exit.gridCoord.y;
    schema.sectorIndex = exit.sectorIndex;
    schema.active = exit.active;
    schema.textureKey = exit.textureKey;
    schema.rotation = (exit.rotation * Math.PI) / 180;
    schema.flipH = exit.flipH;
    schema.flipV = exit.flipV;
  }

  static explosionToSchema(explosion: Explosion, schema: ExplosionSchema): void {
    schema.id = explosion.id;
    schema.ownerId = explosion.ownerId;
    schema.x = explosion.position.x;
    schema.y = explosion.position.y;
    schema.radius = BARREL.EXPLOSION_RADIUS;
    schema.damage = explosion.damage;
  }

  static zoneToSchema(zone: ZoneState, schema: ZoneSchema): void {
    schema.phase = zone.currentPhase;
    schema.centerX = zone.centerX;
    schema.centerY = zone.centerY;
    schema.targetCenterX = zone.targetCenterX;
    schema.targetCenterY = zone.targetCenterY;
    schema.isTransitioningCenter = zone.isTransitioningCenter;
    schema.currentRadius = zone.currentRadius;
    schema.targetRadius = zone.targetRadius;
    schema.phaseStartTime = zone.phaseStartTime;
    schema.phaseEndTime = zone.phaseEndTime;
    if (zone.nextPhasePreview) {
      schema.hasNextPhasePreview = true;
      schema.nextPhaseCenterX = zone.nextPhasePreview.centerX;
      schema.nextPhaseCenterY = zone.nextPhasePreview.centerY;
      schema.nextPhaseRadius = zone.nextPhasePreview.radius;
    } else {
      schema.hasNextPhasePreview = false;
      schema.nextPhaseCenterX = 0;
      schema.nextPhaseCenterY = 0;
      schema.nextPhaseRadius = 0;
    }
  }

  static weaponPickupToSchema(pickup: WeaponPickup, schema: WeaponPickupSchema): void {
    schema.id = pickup.id;
    schema.weaponType = pickup.weapon.type;
    schema.tier = TIER_ORDER[pickup.weapon.tier] ?? 0;
    schema.ammo = pickup.weapon.ammo;
    schema.maxAmmo = pickup.weapon.maxAmmo;
    schema.x = pickup.position.x;
    schema.y = pickup.position.y;
    schema.lifetime = pickup.isActive ? 1 : 0;
    schema.textureKey = pickup.textureKey;
    schema.rotation = (pickup.rotation * Math.PI) / 180;
    schema.flipH = pickup.flipH;
    schema.flipV = pickup.flipV;
  }

  /**
   * Project the match state delta onto the wire `GameStateSchema`.
   *
   * `getAnimState` resolves each player's authoritative animation fields
   * (`AnimWireFields`) for the 3 animation wire projections; the lookup is
   * keyed by playerId. The resolver MAY return `undefined` for a freshly
   * spawned player with no sim state yet — in that case the projection falls
   * back to a zero-state default (`{ phase: 0, phaseStartTick: 0, comboIndex: 0 }`)
   * so the wire never goes stale. The default corresponds to `AnimPhase.IDLE`
   * at tick 0 with no combo progress, which is identical to a freshly
   * constructed `AnimSimState`.
   */
  static mapDelta(
    state: MatchState,
    schema: GameStateSchema,
    meta: MatchMeta,
    getAnimState: AnimStateResolver,
  ): void {
    schema.matchId = meta.matchId;
    schema.mapSeed = meta.mapSeed;
    schema.mapWidth = meta.mapWidth;
    schema.mapHeight = meta.mapHeight;
    schema.tick = state.tick;
    schema.phase = state.phase;
    schema.timestamp = Date.now();
    schema.matchTimerSeconds = Math.floor((state.tick * NETWORK.TICK_INTERVAL) / 1000);
    schema.lastProcessedInput = state.lastProcessedInput;

    let alive = 0;
    for (const player of state.players.values()) {
      if (player.isActive) alive++;
    }
    schema.playersAlive = alive;

    // Table-driven entity sync (#23): one row per synced entity type, in the
    // same order as the former imperative cascade. All row members (map
    // accessors, factories, projectors) are module-stable constants — the
    // loop allocates nothing per sync tick. Static rows (destructibles,
    // exits) additionally carry a ticket-08 version gate: the whole mirror
    // walk is skipped while the kind's domain counter is unchanged since the
    // last projection — wire-identical, see `StaticRowGate`.
    const rows = StateMapper.ENTITY_SYNC_ROWS;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const gate = row.gate;
      if (gate) {
        const version = gate.version(state);
        if (version !== gate.lastProjected(schema)) {
          StateMapperSync.syncMap(
            row.domainMap(state),
            row.schemaMap(schema),
            row.create,
            row.project,
            getAnimState,
          );
          gate.setLastProjected(schema, version);
        }
        continue;
      }
      StateMapperSync.syncMap(
        row.domainMap(state),
        row.schemaMap(schema),
        row.create,
        row.project,
        getAnimState,
      );
    }
    StateMapperSync.syncEliminations(state.eliminations, schema.eliminationRecords);
    StateMapperSync.syncSiegeSectors(state.siegedSectors, schema.siegedSectors);
    StateMapperSync.syncMapSiegeProgress(state.mapSiegeProgress, schema.mapSiegeProgress);
    StateMapper.zoneToSchema(state.zone, schema.zone);
  }

  /**
   * The entity sync table (#23): one row per synced entity type. Adding a new
   * synced entity type is one `entitySyncRow(...)` entry here — `mapDelta`
   * loops over this table instead of calling `syncMap` imperatively per type.
   * Row order mirrors the former cascade exactly (it defines the wire map
   * sync order). Everything reachable from this table is constructed once at
   * module load: the accessor/factory/projector references are stable, so a
   * sync tick allocates no closures. Only the player row's projector consumes
   * the threaded `getAnimState` context; the rest ignore it.
   */
  private static readonly ENTITY_SYNC_ROWS: readonly ErasedEntitySyncRow[] = [
    entitySyncRow<Player, PlayerSchema>({
      domainMap: (state) => state.players,
      schemaMap: (schema) => schema.players,
      create: () => new PlayerSchema(),
      project: StateMapper.projectPlayerWithAnim,
    }),
    entitySyncRow<Projectile, ProjectileSchema>({
      domainMap: (state) => state.projectiles,
      schemaMap: (schema) => schema.projectiles,
      create: () => new ProjectileSchema(),
      project: StateMapper.projectileToSchema,
    }),
    entitySyncRow<PowerUp, PowerUpSchema>({
      domainMap: (state) => state.powerUps,
      schemaMap: (schema) => schema.powerUps,
      create: () => new PowerUpSchema(),
      project: StateMapper.powerUpToSchema,
    }),
    entitySyncRow<Trap, TrapSchema>({
      domainMap: (state) => state.traps,
      schemaMap: (schema) => schema.traps,
      create: () => new TrapSchema(),
      project: StateMapper.trapToSchema,
    }),
    entitySyncRow<Chest, ChestSchema>({
      domainMap: (state) => state.chests,
      schemaMap: (schema) => schema.chests,
      create: () => new ChestSchema(),
      project: StateMapper.chestToSchema,
    }),
    entitySyncRow<Destructible, DestructibleSchema>({
      domainMap: (state) => state.destructibles,
      schemaMap: (schema) => schema.destructibles,
      create: () => new DestructibleSchema(),
      project: StateMapper.destructibleToSchema,
      gate: DESTRUCTIBLE_ROW_GATE,
    }),
    entitySyncRow<Exit, ExitSchema>({
      domainMap: (state) => state.exits,
      schemaMap: (schema) => schema.exits,
      create: () => new ExitSchema(),
      project: StateMapper.exitToSchema,
      gate: EXIT_ROW_GATE,
    }),
    entitySyncRow<Explosion, ExplosionSchema>({
      domainMap: (state) => state.explosions,
      schemaMap: (schema) => schema.explosions,
      create: () => new ExplosionSchema(),
      project: StateMapper.explosionToSchema,
    }),
    entitySyncRow<WeaponPickup, WeaponPickupSchema>({
      domainMap: (state) => state.weaponPickups,
      schemaMap: (schema) => schema.weaponPickups,
      create: () => new WeaponPickupSchema(),
      project: StateMapper.weaponPickupToSchema,
    }),
  ];
}
