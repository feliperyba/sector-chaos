import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type DestructibleStateCallbacks = Pick<
  StateCallbacks,
  'onDestructibleAdd' | 'onDestructibleRemove' | 'onDestructibleChange'
>;

/**
 * Destructibles family state-sync handlers (ticket 45 — bodies moved verbatim
 * from the bridge's callbacks literal).
 */
export function createDestructibleStateHandlers(deps: StateBridgeDeps): DestructibleStateCallbacks {
  return {
    onDestructibleAdd: (d, key) => {
      deps.entityRenderer.addDestructible(key, d);
    },
    onDestructibleRemove: (key) => {
      // Ticket 08: read the render-ownership flag BEFORE removal — light
      // props are tracked by a sprite-less registry record that the
      // removeDestructible call below deletes.
      const isLightProp = deps.entityRenderer.isLightPropDestructible(key);
      const pos = deps.entityRenderer.getDestructiblePosition(key);
      if (pos) {
        // The dust cloud is deliberately NOT type-gated: a smashed sconce/
        // crystal bursts exactly like a crate (destruction feedback parity).
        deps.entityRenderer.spawnDustCloud(pos.x, pos.y);
        const tileSize = deps.mapRenderer.getTileSize();
        const gridX = Math.floor(pos.x / tileSize);
        const gridY = Math.floor(pos.y / tileSize);
        // Clear the tile from the collision grid too — pose containment and
        // prediction must stop treating the destroyed obstacle as solid.
        // Ticket 08: converted light props are NON-SOLID (ticket 07 hydrates
        // them on EMPTY tiles), so the clear is skipped for them — writing 0
        // over an already-walkable cell is pointless, and the base-RT patch
        // inside clearGridCell would smear a dark rect over the tile's baked
        // floor art (the collision-clear call must not corrupt the grid OR
        // the bake for non-solid props).
        if (!isLightProp) {
          deps.mapRenderer.clearGridCell(gridX, gridY);
        }
        // Campfires AND converted light props (any destructible that
        // motivated a static light placement) must drop their light disk +
        // visible fixture sprite when destroyed. The hook is wired by
        // `bootLightingPipeline` to call both `LightingPipeline
        // .removePlacementAt` + `LightPropRenderer.removeAt`. No-op when the
        // tile never carried a placement / before the pipeline boots.
        // Cosmetic-only — no visibility mechanic. SERVER-AUTHORITATIVE: this
        // fires only from the schema removal callback — the client never
        // decides a light is destroyed on its own.
        deps.gameState.onLightPlacementRemoved?.(gridX, gridY);
      }
      deps.entityRenderer.removeDestructible(key);
    },
    onDestructibleChange: (d, key) => {
      deps.entityRenderer.updateDestructible(key, d);
    },
  };
}
