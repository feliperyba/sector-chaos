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
import type {
  PlayerSchemaData,
  ProjectileSchemaData,
  DestructibleSchemaData,
  ChestSchemaData,
  WeaponPickupSchemaData,
  TrapSchemaData,
  PowerUpSchemaData,
  ExplosionSchemaData,
  ExitSchemaData,
} from '@sector-battle/shared';

/**
 * Normalize a possibly-Colyseus-ArraySchema collection into a plain array.
 *
 * The client receives nested arrays (`weapons`, `items`) as either
 * `ArraySchema` proxies (have `forEach`/`Symbol.iterator`) or plain arrays,
 * depending on the SDK decode path. Returning a fresh plain array keeps the
 * cached snapshot decoupled from the SDK's mutable proxy (see `StateSync`'s
 * `onChange` re-conversion) and gives downstream callers a stable `Array`
 * surface regardless of the wire container type.
 */
function toArray<T>(source: readonly T[] | null | undefined): T[] {
  if (!source) return [];
  if (typeof (source as { forEach?: unknown }).forEach === 'function') {
    const out: T[] = [];
    (source as unknown as { forEach: (cb: (v: T) => void) => void }).forEach((v) => out.push(v));
    return out;
  }
  if (typeof (source as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return Array.from(source as Iterable<T>);
  }
  return [];
}

export function toProjectile(p: ProjectileSchemaData | null | undefined): ProjectileState {
  if (!p)
    return {
      id: '',
      ownerId: '',
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0,
      damage: 0,
      bounces: 0,
      weaponType: 0,
      tier: 0,
    };
  return {
    id: p.id ?? '',
    ownerId: p.ownerId ?? '',
    x: p.x ?? 0,
    y: p.y ?? 0,
    velocityX: p.velocityX ?? 0,
    velocityY: p.velocityY ?? 0,
    damage: p.damage ?? 0,
    bounces: p.bounces ?? 0,
    weaponType: p.weaponType ?? 0,
    tier: p.tier ?? 0,
  };
}

export function toDestructible(d: DestructibleSchemaData | null | undefined): DestructibleState {
  if (!d)
    return {
      id: '',
      type: 0,
      hp: 0,
      maxHp: 0,
      x: 0,
      y: 0,
      isDestroyed: false,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
      primed: false,
      fuseExpiresAtTick: 0,
    };
  // Juice-pass-1 ticket 05: `primed`/`fuseExpiresAtTick` are on the shared
  // mirror (`DestructibleSchemaData`) and the wire. Normalize to
  // always-present values so downstream consumers never see undefined against
  // a server build predating ticket 05.
  return {
    id: d.id ?? '',
    type: d.type ?? 0,
    hp: d.hp ?? 0,
    maxHp: d.maxHp ?? 0,
    x: d.x ?? 0,
    y: d.y ?? 0,
    isDestroyed: !!d.isDestroyed,
    textureKey: d.textureKey,
    rotation: d.rotation ?? 0,
    flipH: !!d.flipH,
    flipV: !!d.flipV,
    primed: !!d.primed,
    fuseExpiresAtTick: d.fuseExpiresAtTick ?? 0,
  };
}

export function toChest(c: ChestSchemaData | null | undefined): ChestState {
  if (!c)
    return {
      id: '',
      tier: 0,
      x: 0,
      y: 0,
      state: 0,
      openingPlayerId: '',
      openingProgress: 0,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  return {
    id: c.id ?? '',
    tier: c.tier ?? 0,
    x: c.x ?? 0,
    y: c.y ?? 0,
    state: c.state ?? 0,
    openingPlayerId: c.openingPlayerId ?? '',
    openingProgress: c.openingProgress ?? 0,
    textureKey: c.textureKey,
    rotation: c.rotation ?? 0,
    flipH: !!c.flipH,
    flipV: !!c.flipV,
  };
}

export function toWeaponPickup(wp: WeaponPickupSchemaData | null | undefined): WeaponPickupState {
  if (!wp)
    return {
      id: '',
      weaponType: 0,
      tier: 0,
      ammo: 0,
      maxAmmo: 0,
      x: 0,
      y: 0,
      lifetime: 0,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  return {
    id: wp.id ?? '',
    weaponType: wp.weaponType ?? 0,
    tier: wp.tier ?? 0,
    ammo: wp.ammo ?? 0,
    maxAmmo: wp.maxAmmo ?? 0,
    x: wp.x ?? 0,
    y: wp.y ?? 0,
    lifetime: wp.lifetime ?? 0,
    textureKey: wp.textureKey,
    rotation: wp.rotation ?? 0,
    flipH: !!wp.flipH,
    flipV: !!wp.flipV,
  };
}

export function toTrap(t: TrapSchemaData | null | undefined): TrapState {
  if (!t)
    return {
      id: '',
      type: 0,
      x: 0,
      y: 0,
      isRevealed: false,
      cooldownRemaining: 0,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
      fireAreaActive: false,
      fireAreaRemainingMs: 0,
    };
  return {
    id: t.id ?? '',
    type: t.type ?? 0,
    x: t.x ?? 0,
    y: t.y ?? 0,
    isRevealed: !!t.isRevealed,
    cooldownRemaining: t.cooldownRemaining ?? 0,
    textureKey: t.textureKey,
    rotation: t.rotation ?? 0,
    flipH: !!t.flipH,
    flipV: !!t.flipV,
    fireAreaActive: !!t.fireAreaActive,
    fireAreaRemainingMs: t.fireAreaRemainingMs ?? 0,
  };
}

export function toPowerUp(p: PowerUpSchemaData | null | undefined): PowerUpState {
  if (!p) return { id: '', type: 0, x: 0, y: 0, isActive: false };
  return { id: p.id ?? '', type: p.type ?? 0, x: p.x ?? 0, y: p.y ?? 0, isActive: !!p.isActive };
}

export function toExplosion(e: ExplosionSchemaData | null | undefined): ExplosionState {
  if (!e) return { id: '', ownerId: '', x: 0, y: 0, radius: 0, damage: 0 };
  return {
    id: e.id ?? '',
    ownerId: e.ownerId ?? '',
    x: e.x ?? 0,
    y: e.y ?? 0,
    radius: e.radius ?? 0,
    damage: e.damage ?? 0,
  };
}

export function toExit(e: ExitSchemaData | null | undefined): ExitState {
  if (!e)
    return {
      id: '',
      x: 0,
      y: 0,
      gridX: 0,
      gridY: 0,
      sectorIndex: 0,
      active: false,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  return {
    id: e.id ?? '',
    x: e.x ?? 0,
    y: e.y ?? 0,
    gridX: e.gridX ?? 0,
    gridY: e.gridY ?? 0,
    sectorIndex: e.sectorIndex ?? 0,
    active: !!e.active,
    textureKey: e.textureKey,
    rotation: e.rotation ?? 0,
    flipH: !!e.flipH,
    flipV: !!e.flipV,
  };
}

/**
 * Convert a wire `PlayerSchemaData` into the cached client `PlayerState`.
 *
 * Collapsed (ticket #05, Step 4): now that `PlayerState === PlayerSchemaData`
 * (type alias, see `types.ts`), the conversion is a shallow snapshot copy of
 * the wire object plus a normalization of the nested `weapons`/`items` arrays
 * to plain `Array`s (decoupling the cached state from the SDK's mutable
 * `ArraySchema` proxy). All the per-field `?? default` null-coalescing of the
 * previous hand-transcription is gone — `PlayerSchemaData` has no optional
 * fields, and the server's `PlayerSchema` initializes every `@type()` field, so
 * the defaults were not load-bearing.
 *
 * The null/undefined branch returns an empty-shape default for defensive
 * callers; in practice `StateSync.subscribeCollection` always passes the
 * non-null schema instance.
 */
export function toPlayerState(p: PlayerSchemaData | null | undefined): PlayerState {
  if (!p) {
    return {
      id: '',
      name: '',
      color: 0,
      x: 0,
      y: 0,
      direction: 0,
      facingAngle: 0,
      speed: 0,
      velocityX: 0,
      velocityY: 0,
      health: 0,
      maxHealth: 0,
      status: 0,
      kills: 0,
      activeSlot: 0,
      lastDamageTick: 0,
      dashCooldown: 0,
      barrierActive: false,
      isBlocking: false,
      speedBoostActive: false,
      connected: true,
      isBot: false,
      isWindupActive: false,
      windupWeaponType: 0,
      windupAttackType: '',
      animPhase: 0,
      animPhaseStartTick: 0,
      comboIndex: 0,
      barrierExpiryTick: 0,
      speedBoostExpiryTick: 0,
      freshSpawnExpiryTick: 0,
      lastProcessedInput: 0,
      weapons: [],
      items: [],
    };
  }
  return {
    ...p,
    weapons: toArray(p.weapons),
    items: toArray(p.items),
  };
}

/**
 * Returns true when the incoming wire schema differs from the cached
 * `PlayerState` ONLY in its position/velocity fields (x, y, velocityX,
 * velocityY). Used by `StateSync`'s fast path to mutate those four fields in
 * place instead of rebuilding the whole PlayerState (which allocates a fresh
 * object + weapons/items arrays on every patch).
 *
 * Every non-position scalar is compared, plus each weapon slot (length + per-
 * slot fields) and the items array (length + identity). This is exhaustive on
 * purpose: a missed field would leave the cached player visually stale. The
 * player-level `onChange` fires for descendant (weapon slot) mutations too, so
 * equip/swap/health/status changes are detected here and force a full rebuild.
 */
export function onlyPositionChangedPlayer(p: PlayerSchemaData, existing: PlayerState): boolean {
  // Scalars (every field except x, y, velocityX, velocityY).
  if (
    existing.name !== p.name ||
    existing.color !== p.color ||
    existing.direction !== p.direction ||
    existing.facingAngle !== p.facingAngle ||
    existing.speed !== p.speed ||
    existing.health !== p.health ||
    existing.maxHealth !== p.maxHealth ||
    existing.status !== p.status ||
    existing.kills !== p.kills ||
    existing.activeSlot !== p.activeSlot ||
    existing.lastDamageTick !== p.lastDamageTick ||
    existing.dashCooldown !== p.dashCooldown ||
    existing.barrierActive !== p.barrierActive ||
    existing.isBlocking !== p.isBlocking ||
    existing.speedBoostActive !== p.speedBoostActive ||
    existing.connected !== p.connected ||
    existing.isBot !== p.isBot ||
    existing.isWindupActive !== p.isWindupActive ||
    existing.windupWeaponType !== p.windupWeaponType ||
    existing.windupAttackType !== p.windupAttackType ||
    existing.animPhase !== p.animPhase ||
    existing.animPhaseStartTick !== p.animPhaseStartTick ||
    existing.comboIndex !== p.comboIndex ||
    existing.barrierExpiryTick !== p.barrierExpiryTick ||
    existing.speedBoostExpiryTick !== p.speedBoostExpiryTick ||
    existing.freshSpawnExpiryTick !== p.freshSpawnExpiryTick ||
    existing.lastProcessedInput !== p.lastProcessedInput
  ) {
    return false;
  }

  // Weapons: length + per-slot field comparison.
  const srcWeapons = p.weapons;
  const dstWeapons = existing.weapons;
  const srcWLen = srcWeapons?.length ?? 0;
  if (srcWLen !== dstWeapons.length) return false;
  for (let i = 0; i < srcWLen; i++) {
    const sw = srcWeapons![i];
    const dw = dstWeapons[i];
    if (!sw || !dw) return false;
    if (
      sw.id !== dw.id ||
      sw.weaponType !== dw.weaponType ||
      sw.tier !== dw.tier ||
      sw.ammo !== dw.ammo ||
      sw.maxAmmo !== dw.maxAmmo
    ) {
      return false;
    }
  }

  // Items: length + identity (items are string texture keys).
  const srcItems = p.items;
  const dstItems = existing.items;
  const srcILen = srcItems?.length ?? 0;
  if (srcILen !== dstItems.length) return false;
  for (let i = 0; i < srcILen; i++) {
    if (srcItems![i] !== dstItems[i]) return false;
  }

  return true;
}

/**
 * Returns true when the incoming wire schema differs from the cached
 * `ProjectileState` ONLY in its position/velocity fields (x, y, velocityX,
 * velocityY). Used by `StateSync`'s fast path (ticket 20) to mutate those four
 * fields in place instead of allocating a fresh `ProjectileState` per
 * projectile per patch — the player fast-path pattern extended to projectiles.
 * Projectile x/y/vx/vy change every tick, so without this every in-flight
 * projectile cost 1 object alloc + Map.set per 60Hz patch (~1,800 objects/sec
 * at 30 concurrent projectiles).
 *
 * Every non-position scalar is compared, exhaustive on purpose (same contract
 * as `onlyPositionChangedPlayer`): a missed field would leave the cached view
 * stale. Structural changes (a bounce decrement on a wall hit, damage,
 * weaponType/tier) return false and fall through to the full `toProjectile`
 * rebuild.
 */
export function onlyPositionChangedProjectile(
  p: ProjectileSchemaData,
  existing: ProjectileState,
): boolean {
  return (
    existing.id === p.id &&
    existing.ownerId === p.ownerId &&
    existing.damage === p.damage &&
    existing.bounces === p.bounces &&
    existing.weaponType === p.weaponType &&
    existing.tier === p.tier
  );
}
