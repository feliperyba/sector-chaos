import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type ChestPickupStateCallbacks = Pick<
  StateCallbacks,
  | 'onChestAdd'
  | 'onChestRemove'
  | 'onChestChange'
  | 'onWeaponPickupAdd'
  | 'onWeaponPickupRemove'
  | 'onWeaponPickupChange'
  | 'onPowerUpAdd'
  | 'onPowerUpRemove'
  | 'onPowerUpChange'
>;

/**
 * Chests / weapon-pickups / power-ups family state-sync handlers (ticket 45 —
 * bodies moved verbatim from the bridge's callbacks literal). The three
 * entities share the same concern (render-registry + collision-grid bookkeeping
 * for loot objects); traps are NOT part of this family (hazard deployables,
 * see TrapStateHandlers).
 */
export function createChestPickupStateHandlers(deps: StateBridgeDeps): ChestPickupStateCallbacks {
  return {
    onChestAdd: (c, key) => {
      deps.entityRenderer.addChest(key, c);
    },
    onChestRemove: (key) => {
      const pos = deps.entityRenderer.getChestPosition(key);
      if (pos) {
        const tileSize = deps.mapRenderer.getTileSize();
        deps.mapRenderer.clearGridCell(Math.floor(pos.x / tileSize), Math.floor(pos.y / tileSize));
      }
      deps.entityRenderer.removeChest(key);
    },
    onChestChange: (c, key) => {
      deps.entityRenderer.updateChest(key, c);
    },
    onWeaponPickupAdd: (wp, key) => {
      deps.entityRenderer.addWeaponPickup(key, wp);
    },
    onWeaponPickupRemove: (key) => {
      deps.entityRenderer.removeWeaponPickup(key);
    },
    onWeaponPickupChange: (wp, key) => {
      deps.entityRenderer.updateWeaponPickup(key, wp);
    },
    onPowerUpAdd: (p, key) => {
      deps.entityRenderer.addPowerUp(key, p);
    },
    onPowerUpRemove: (key) => {
      deps.entityRenderer.removePowerUp(key);
    },
    onPowerUpChange: (p, key) => {
      deps.entityRenderer.updatePowerUp(key, p);
    },
  };
}
