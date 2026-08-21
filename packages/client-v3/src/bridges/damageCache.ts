/**
 * Shared damage tracking between event-driven and state-driven damage detection.
 *
 * DamageEventHandler marks players when a PlayerDamaged EVENT arrives.
 * ClientStateBridge checks the mark to distinguish event-driven damage
 * (melee, projectile) from silent damage (fire DoT, zone) that has no event.
 */
const recentEventDamage = new Map<string, number>();

export function markEventDamage(playerId: string): void {
  recentEventDamage.set(playerId, performance.now());
}

export function hasRecentEventDamage(playerId: string, thresholdMs = 200): boolean {
  const t = recentEventDamage.get(playerId);
  if (t === undefined) return false;
  if (performance.now() - t > thresholdMs) {
    recentEventDamage.delete(playerId);
    return false;
  }
  return true;
}
