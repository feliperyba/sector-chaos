import { BARREL, distance } from '@sector-battle/shared';
import type { WorldSnapshot, PlayerDTO } from './WorldSnapshot.ts';
import type { BotContext, EnemyInfo, ItemInfo, DangerInfo, ProjectileInfo } from './BotContext.ts';
import { isBarrel } from './BotDestructibles.ts';
import { recordEnemyPosition, pruneEnemyHistory } from './BotContextEnemyHistory.ts';
import {
  collectOpeningPlayerIds,
  flagLooters,
  flagSpawnPrey,
  deriveEngagement,
  populateHotBarrels,
} from './IntentSignals.ts';

const PERCEPTION_RANGE = 1000;
const ITEM_SCAN_RANGE = 2500;
// Scan hazards far enough to react before entering their lethal range, but no
// further than necessary — the destructible spatial-grid query cost scales
// with range, and at 60+ bots scanning every 3 ticks an oversized range pushes
// the tick budget over 16ms. Barrels chain-explode across
// Scan barrels WIDE so the bot detects them well before entering the avoid
// radius — chain explosions (256px blast, 50 dmg, lethal) need generous reaction
// time. A bot at base speed covers ~17px/tick, so scanning at +200px beyond the
// avoid radius gives ~12 ticks of steering correction. The previous +80px left
// <1 tick to react, causing bots to blunder into barrel blast zones.
// EXPORTED (DEC-006 fix 5): the ONE barrel hazard range, consumed by BOTH the
// full staggered scan below and BotSelfState's per-tick hazard rescan. The
// rescan previously used its own EXPLOSION_RADIUS + 80 (336px), so barrels in
// the 336–456px shell flickered in/out of the danger view between scan cycles.
const BARREL_AVOID_SCAN = BARREL.EXPLOSION_RADIUS + 200;
// Scan traps far enough to react before entering the avoid radius (220px).
const DANGER_SCAN_RANGE = 360;
export const BARREL_SCAN_RANGE = BARREL_AVOID_SCAN;
const PROJECTILE_SCAN_RANGE = 300;
const CHEST_TIER_SENTINEL = 5;

/**
 * Release every object in `arr` back into `pool`, then clear the array.
 * Shared by the full scan and the per-tick hazard rescan so both paths use
 * identical pool choreography (ticket 24).
 */
export function releaseAll<T>(arr: T[], pool: T[]): void {
  for (let i = 0; i < arr.length; i++) pool.push(arr[i]!);
  arr.length = 0;
}

/**
 * Acquire a DangerInfo from `ctx.dangerPool` (allocating one on first use),
 * populate ALL fields, and append it to `ctx.dangers`. The ONE shared acquire
 * path used by both the full scan (`scanWorld`) and the lightweight hazard
 * rescan (`BotSelfState.rescanHazards`) so neither allocates fresh literals
 * per tick. Writes every DangerInfo field — pooled objects never carry stale
 * values between scans.
 */
export function acquireDanger(
  ctx: BotContext,
  x: number,
  y: number,
  type: string,
  dist: number,
): DangerInfo {
  const danger = ctx.dangerPool.pop() ?? ({} as DangerInfo);
  danger.x = x;
  danger.y = y;
  danger.type = type;
  danger.distance = dist;
  ctx.dangers.push(danger);
  return danger;
}

/**
 * Acquire a ProjectileInfo from `ctx.projectilePool` (allocating one on first
 * use), populate ALL fields, and append it to `ctx.projectiles`. See
 * {@link acquireDanger} — the ONE shared acquire path for both scan paths.
 */
export function acquireProjectile(
  ctx: BotContext,
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  dist: number,
): ProjectileInfo {
  const proj = ctx.projectilePool.pop() ?? ({} as ProjectileInfo);
  proj.id = id;
  proj.x = x;
  proj.y = y;
  proj.vx = vx;
  proj.vy = vy;
  proj.distance = dist;
  ctx.projectiles.push(proj);
  return proj;
}

export function scanWorld(ctx: BotContext, snapshot: WorldSnapshot, _selfDto: PlayerDTO): void {
  // Release the previous scan's DTOs back to their pools, then clear. Pooled
  // objects are never retained across scans — consumers read within this tick.
  releaseAll(ctx.enemies, ctx.enemyPool);
  releaseAll(ctx.items, ctx.itemPool);
  releaseAll(ctx.dangers, ctx.dangerPool);
  releaseAll(ctx.projectiles, ctx.projectilePool);
  ctx.hotBarrels.length = 0;
  ctx.nearestEnemy = null;
  ctx.nearestWeapon = null;
  ctx.nearestHealth = null;
  ctx.nearestChest = null;
  ctx.nearestBarrier = null;
  ctx.nearestSpeedBoost = null;

  // Capture fresh-spawn expiry per enemy id so IntentSignals.flagSpawnPrey can
  // compute ticks-until-vulnerable. Built during the player scan, used after.
  const spawnExpiry = ctx.spawnExpiryMap;
  spawnExpiry.clear();

  // Player perception via the spatial grid (range query) instead of a full
  // linear scan of all players. This was the dominant O(N²) cost in botAI:
  // every scanning bot × all N players. queryPlayers returns only candidates
  // in cells overlapping PERCEPTION_RANGE, so the iteration scales with LOCAL
  // density. The per-player distance check below is the precise filter (the
  // grid is cell-aligned, not radius-exact). Dead players are not indexed
  // (rebuildWorldGrids skips them), so the isAlive check is a backstop.
  snapshot.queryPlayers(ctx.x, ctx.y, PERCEPTION_RANGE, (dto) => {
    if (dto.id === ctx.playerId) return;
    if (!dto.isAlive) return;
    // NOTE: fresh-spawn players are NO LONGER filtered out. They were previously
    // invisible to bots — the single most vulnerable moment in the game (the
    // instant spawn invuln clears: full HP but fists-only, no i-frames) was
    // structurally un-seeable. Now they're perceived but tagged isFreshSpawn +
    // spawnInvulnTicksLeft so an intent can time an attack to flag-clear.
    // dist is STORED into EnemyInfo.distance (a real-pixel value consumed by
    // targeting/intents), so this is a value-storing site: keep the sqrt form
    // (shared distance()), not distanceSq (ticket 06 rule).
    const dist = distance(ctx.x, ctx.y, dto.x, dto.y);
    if (dist > PERCEPTION_RANGE) return;

    const enemy = ctx.enemyPool.pop() ?? ({} as EnemyInfo);
    enemy.id = dto.id;
    enemy.x = dto.x;
    enemy.y = dto.y;
    enemy.vx = dto.velocityX;
    enemy.vy = dto.velocityY;
    enemy.distance = dist;
    enemy.health = dto.health;
    enemy.maxHealth = dto.maxHealth;
    enemy.weaponType = dto.weaponType;
    enemy.weaponTier = dto.weaponTier;
    enemy.isInWindup = dto.isInWindup;
    enemy.windupRemaining = dto.windupRemaining;
    enemy.lastAttackTick = dto.lastAttackTick;
    enemy.facingAngle = dto.facingAngle;
    enemy.barrierActive = dto.barrierActive;
    enemy.isFreshSpawn = dto.isFreshSpawn;
    enemy.spawnInvulnTicksLeft = 0;
    enemy.isLooting = false;
    enemy.engagedTargetId = null;
    ctx.enemies.push(enemy);
    if (dto.isFreshSpawn && dto.freshSpawnExpiryTick > 0) {
      spawnExpiry.set(dto.id, dto.freshSpawnExpiryTick);
    }
    recordEnemyPosition(ctx, enemy.id, enemy.x, enemy.y, enemy.vx, enemy.vy, ctx.tick);
    // Track the most recent enemy sighting so HUNT can chase it after losing
    // sight — keeps armed bots pressing the attack instead of wandering.
    // Only count non-fresh-spawn sightings toward HUNT memory: a fresh spawn
    // is invulnerable, chasing it now wastes time. The spawn-prey intent
    // handles fresh spawns separately.
    if (!dto.isFreshSpawn) {
      ctx.lastSeenEnemyX = enemy.x;
      ctx.lastSeenEnemyY = enemy.y;
      ctx.lastSeenEnemyTick = ctx.tick;
    }
  });

  snapshot.queryItems(ctx.x, ctx.y, ITEM_SCAN_RANGE, (dto) => {
    const dist = distance(ctx.x, ctx.y, dto.x, dto.y); // stored below — keep sqrt
    const item = ctx.itemPool.pop() ?? ({} as ItemInfo);
    item.id = dto.id;
    item.x = dto.x;
    item.y = dto.y;
    item.distance = dist;
    item.type = dto.type;
    item.tier = dto.tier;
    item.weaponType = dto.weaponType;
    item.powerUpType = dto.powerUpType;
    ctx.items.push(item);
  });

  snapshot.queryTraps(ctx.x, ctx.y, DANGER_SCAN_RANGE, (dto) => {
    const dist = distance(ctx.x, ctx.y, dto.x, dto.y); // stored below — keep sqrt
    acquireDanger(ctx, dto.x, dto.y, dto.type, dist);
  });

  snapshot.queryDestructibles(ctx.x, ctx.y, BARREL_SCAN_RANGE, (dto) => {
    if (!isBarrel(dto.type)) return;
    const dist = distance(ctx.x, ctx.y, dto.x, dto.y); // stored below — keep sqrt
    acquireDanger(ctx, dto.x, dto.y, 'barrel', dist);
  });

  snapshot.queryProjectiles(ctx.x, ctx.y, PROJECTILE_SCAN_RANGE, (dto) => {
    const dist = distance(ctx.x, ctx.y, dto.x, dto.y); // stored below — keep sqrt
    acquireProjectile(ctx, dto.id, dto.x, dto.y, dto.velocityX, dto.velocityY, dist);
  });

  // --- Intent signals: turn raw perception into "moment" flags. ---
  // These populate the new EnemyInfo fields (isLooting, spawnInvulnTicksLeft,
  // engagedTargetId) and ctx.hotBarrels. Cheap (linear scans over a small
  // enemy list) and the foundation of every reactive intent.
  flagSpawnPrey(ctx, ctx.tick, spawnExpiry);
  const openingIds = collectOpeningPlayerIds((cb) => snapshot.forEachOpeningChest(cb));
  flagLooters(ctx, openingIds);
  deriveEngagement(ctx);
  // Hot barrels: barrels in blast range of any enemy. Pass a barrel-only
  // iterator (the destructible query already filtered to barrels above, but
  // populateHotBarrels needs its own scan over the barrel positions we
  // collected in ctx.dangers, which is the cheapest source).
  populateHotBarrels(ctx, (cb) => {
    for (const d of ctx.dangers) {
      if (isBarrel(d.type)) cb({ x: d.x, y: d.y });
    }
  });

  let nearestEnemyDist = Infinity;
  for (const e of ctx.enemies) {
    // nearestEnemy drives the default ENGAGE/HUNT decision. Skip enemies that
    // cannot currently be damaged (fresh-spawn invuln or barrier) so the bot
    // doesn't try to duel an invulnerable target. Spawn-prey and barrier-wait
    // intents handle those via the dedicated signals instead.
    if (e.barrierActive) continue;
    if (e.isFreshSpawn && e.spawnInvulnTicksLeft > 6) continue; // invuln > ~0.1s
    if (e.distance < nearestEnemyDist) {
      nearestEnemyDist = e.distance;
      ctx.nearestEnemy = e;
    }
  }

  let nearestWeaponDist = Infinity;
  let nearestHealthDist = Infinity;
  let nearestChestDist = Infinity;
  let nearestBarrierDist = Infinity;
  let nearestSpeedBoostDist = Infinity;
  for (const item of ctx.items) {
    if (item.type === 'weapon' && item.distance < nearestWeaponDist) {
      nearestWeaponDist = item.distance;
      ctx.nearestWeapon = item;
    }
    if (item.powerUpType === 'health_pack' && item.distance < nearestHealthDist) {
      nearestHealthDist = item.distance;
      ctx.nearestHealth = item;
    }
    if (item.powerUpType === 'barrier' && item.distance < nearestBarrierDist) {
      nearestBarrierDist = item.distance;
      ctx.nearestBarrier = item;
    }
    if (item.powerUpType === 'speed_boost' && item.distance < nearestSpeedBoostDist) {
      nearestSpeedBoostDist = item.distance;
      ctx.nearestSpeedBoost = item;
    }
    if (item.tier === CHEST_TIER_SENTINEL && item.distance < nearestChestDist) {
      nearestChestDist = item.distance;
      ctx.nearestChest = item;
    }
  }

  // History-map bound (perf ticket 28): runs AFTER all recordEnemyPosition
  // pushes and after ctx.nearestEnemy was recomputed, so both eviction
  // exemptions (ctx.targetId, ctx.nearestEnemy.id) are current. See
  // BotContext.pruneEnemyHistory for the reader-audit proof.
  pruneEnemyHistory(ctx);

  // RECENT-DAMAGE FEED (bot-ai-v2 ticket 09, DEC-010.6): per-scan health
  // drops accumulate as the per-enemy damage events behind the restored GDD
  // §14.8 recentDamage targeting term. Runs after the enemy list is final;
  // null-tolerates literal-cast test contexts without `combat`.
  ctx.combat?.recentDamage.noteScan(ctx.enemies, ctx.tick);
}
