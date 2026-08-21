/**
 * Spatial-index builders extracted verbatim from the original BotSystem.ts.
 *
 * Each function body is byte-identical to the original method except `this.`
 * → `system.`. Behavior is provably preserved by construction.
 */

import type { DestructibleDTO } from './WorldSnapshot.ts';
import type { BotSystem } from './BotSystem.ts';
import type { Vec2 } from './BotContext.ts';
import { isBarrel, isCrate, packGridKey } from './BotDestructibles.ts';

export function buildDestructibleMap(system: BotSystem): void {
  system.destructibleMap.clear();
  system.destructibleCentroidMap.clear();
  const ts = system.pathfinder.getTileSize();
  // Read the real SAT collider centroids from the collision service so the
  // bot's demolition aim can target the polygon instead of tile-center.
  // Falls back gracefully when no enriched atlas is available (null centroid
  // → aim stays at tile-center, the pre-fix behavior).
  const collision = system.match.getCollisionService();
  system.worldSnapshot.forEachActiveDestructible((dto: DestructibleDTO) => {
    if (dto.isDestroyed) return;
    // Skip unbreakable destructibles (iron, maxHp = Infinity). Without this,
    // bots would wedge against iron walls trying to demolish them forever —
    // takeDamage returns destroyed:false every tick, the liveness check keeps
    // passing (iron never leaves the map), and the bot swings at nothing.
    if (!Number.isFinite(dto.hp)) return;
    const gx = Math.floor(dto.x / ts);
    const gy = Math.floor(dto.y / ts);
    const key = packGridKey(gx, gy);
    const existing = system.destructibleMap.get(key);
    if (existing === undefined || dto.hp < existing) {
      system.destructibleMap.set(key, dto.hp);
    }
    if (!system.destructibleCentroidMap.has(key)) {
      const centroid = collision.getColliderCentroid(gx, gy);
      if (centroid) system.destructibleCentroidMap.set(key, centroid);
    }
  });
}

/**
 * Find the nearest unbroken CRATE within range of (x,y). Crates drop weapons
 * when destroyed, so an unarmed bot with no weapon pickup in sight should
 * seek and break a crate to re-arm. Returns the crate's world position, or
 * null if none in range. Skips barrels (those explode, they don't drop loot).
 */
export function findNearestCrate(
  system: BotSystem,
  x: number,
  y: number,
  range: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = range * range;
  system.worldSnapshot.queryDestructibles(x, y, range, (dto) => {
    if (dto.isDestroyed) return;
    // Only crates drop weapons; barrels explode, walls are structural.
    if (!isCrate(dto.type)) return;
    const dx = dto.x - x;
    const dy = dto.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = { x: dto.x, y: dto.y };
    }
  });
  return best;
}

/**
 * Rebuild the barrel density grid. One pass over all destructibles, binning
 * barrels into an 8×8 grid. Called every 30 ticks (shared across all bots).
 * Non-barrel destructibles are skipped. Destroyed barrels are skipped.
 */
export function buildBarrelDensity(system: BotSystem): void {
  system.barrelDensity.fill(0);
  const cs = system.barrelDensityCellSize;
  if (cs <= 0) return;
  const cols = system.barrelDensityCols;
  system.worldSnapshot.forEachActiveDestructible((dto: DestructibleDTO) => {
    if (dto.isDestroyed) return;
    if (!isBarrel(dto.type)) return;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(dto.x / cs)));
    const cy = Math.min(cols - 1, Math.max(0, Math.floor(dto.y / cs)));
    const idx = cy * cols + cx;
    if (system.barrelDensity[idx]! < 255) system.barrelDensity[idx]!++;
  });
}

/**
 * Returns the barrel density (0-255) for the grid cell containing (x, y).
 * Used by the hotspot-edge stalk scoring (bot-ai-v2 ticket 07) to pick
 * low-density approach angles, and by BotCombat to decide whether to
 * reposition out of barrel-dense areas.
 */
export function getBarrelDensityAt(system: BotSystem, x: number, y: number): number {
  const cs = system.barrelDensityCellSize;
  if (cs <= 0) return 0;
  const cols = system.barrelDensityCols;
  const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cs)));
  const cy = Math.min(cols - 1, Math.max(0, Math.floor(y / cs)));
  return system.barrelDensity[cy * cols + cx] ?? 0;
}

// findBarrelSparseTarget (random barrel-sparse wander-target picker) was
// RETIRED by bot-ai-v2 ticket 07 (DEC-008): wander targets are committed
// macro-goals now, never random cell picks (AUDIT §10c.1). grep-proof.
