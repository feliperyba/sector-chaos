import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type ExitStateCallbacks = Pick<
  StateCallbacks,
  'onExitAdd' | 'onExitRemove' | 'onExitChange'
>;

/**
 * Exits family state-sync handlers (ticket 45 — bodies moved verbatim from the
 * bridge's callbacks literal).
 */
export function createExitStateHandlers(deps: StateBridgeDeps): ExitStateCallbacks {
  return {
    onExitAdd: (e, key) => {
      deps.entityRenderer.addExit(key, e);
    },
    onExitRemove: (key) => {
      deps.entityRenderer.removeExit(key);
    },
    onExitChange: (e, key) => {
      deps.entityRenderer.updateExit(key, e);
    },
  };
}
