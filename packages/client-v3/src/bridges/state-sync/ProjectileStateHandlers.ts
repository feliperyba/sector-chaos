import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type ProjectileStateCallbacks = Pick<
  StateCallbacks,
  'onProjectileAdd' | 'onProjectileRemove' | 'onProjectileChange'
>;

/**
 * Projectiles family state-sync handlers (ticket 45 — bodies moved verbatim
 * from the bridge's callbacks literal).
 */
export function createProjectileStateHandlers(deps: StateBridgeDeps): ProjectileStateCallbacks {
  return {
    onProjectileAdd: (p, key) => {
      deps.entityRenderer.addProjectile(key, p);
    },
    onProjectileRemove: (key) => {
      deps.projectileInterpolator.removeEntity(key);
      deps.entityRenderer.removeProjectile(key);
    },
    onProjectileChange: (p, key) => {
      deps.projectileInterpolator.push(key, p.x, p.y, p.velocityX, p.velocityY);
      deps.entityRenderer.updateProjectileVisuals(key, p);
    },
  };
}
