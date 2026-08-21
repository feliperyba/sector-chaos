/**
 * Explosion rendering — add + remove for transient explosion entities.
 *
 * Ticket #50: the entity record carries NO GameObject. All visuals the player
 * sees are created by the VFX layer (`lifecycle.vfx.explosion.spawn`); the
 * record exists only so the generic lifecycle (removeEntity/destroy) can
 * manage the entity's presence in the registry. The previous placeholder
 * `Graphics` (depth 18, never drawn to) cost an allocation + display-list
 * entry + lighting-albedo-capture scan hit per explosion — and was orphaned
 * whenever the VFX expiry callback fired before the server removed the
 * schema entity (it deletes the registry entry without destroying the sprite).
 */
import type { ExplosionState } from '../types.js';
import type { EntityRendererLifecycle } from './EntityRendererLifecycle.js';

/* ── Explosion ──────────────────────────────────────────── */

export function addExplosion(
  lifecycle: EntityRendererLifecycle,
  key: string,
  e: ExplosionState,
): void {
  if (lifecycle.entities.has(key)) return;
  lifecycle.vfx.explosion.spawn({
    key,
    x: e.x,
    y: e.y,
    radius: e.radius,
    onExpire: () => {
      lifecycle.entities.delete(key);
    },
  });
  lifecycle.entities.set(key, {
    type: 'explosion',
    x: e.x,
    y: e.y,
  });
}

export function removeExplosion(lifecycle: EntityRendererLifecycle, key: string): void {
  lifecycle.vfx.explosion.remove(key);
  lifecycle.removeEntity(key);
}
