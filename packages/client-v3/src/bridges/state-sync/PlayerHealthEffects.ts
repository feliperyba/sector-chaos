import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { PlayerState } from '../../types.js';
import { hasRecentEventDamage } from '../damageCache.js';

export interface PlayerHealthEffectsDeps {
  entityRenderer: EntityRenderer;
}

/**
 * Health-edge detection + fire-particle spawning for state-sync player patches
 * (ticket 45 — extracted from the bridge's onPlayerChange so the handler body
 * is delegation-only).
 *
 * Distinguishes event-driven damage (melee/projectile — a PlayerDamaged EVENT
 * arrived, see damageCache) from silent damage (fire DoT, zone) that has no
 * event: only a health drop with NO recent event spawns the fire DoT particles,
 * so an event-driven hit doesn't double up with the DamageEventHandler's own
 * hit VFX. Owns the per-player previous-health baseline (`prevHealth` in the
 * pre-split bridge).
 */
export class PlayerHealthEffects {
  private readonly prevHealth = new Map<string, number>();

  constructor(private readonly deps: PlayerHealthEffectsDeps) {}

  /** Seed the baseline at add time (covers players arriving mid-match). */
  trackPlayerAdd(key: string, health: number): void {
    this.prevHealth.set(key, health);
  }

  removePlayer(key: string): void {
    this.prevHealth.delete(key);
  }

  /**
   * Silent-damage edge: health dropped with no recent PlayerDamaged event →
   * spawn fire particles at the player's position. `isDead` is the caller's
   * DYING|DEAD|SPECTATING bitmask result — corpses never spawn fire. Always
   * advances the baseline (dead players' last health must not leak into a
   * respawn's first comparison).
   */
  handlePlayerChange(p: PlayerState, key: string, isDead: boolean): void {
    if (!isDead) {
      const prev = this.prevHealth.get(key);
      if (prev !== undefined && p.health < prev && !hasRecentEventDamage(key)) {
        this.deps.entityRenderer.spawnFireParticles(p.x, p.y);
      }
    }
    this.prevHealth.set(key, p.health);
  }
}
