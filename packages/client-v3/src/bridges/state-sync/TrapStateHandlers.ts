import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type TrapStateCallbacks = Pick<
  StateCallbacks,
  'onTrapAdd' | 'onTrapRemove' | 'onTrapChange'
>;

/**
 * Traps family state-sync handlers (ticket 45 — bodies moved verbatim from the
 * bridge's callbacks literal). Owns the per-bridge reveal-edge state
 * (`trapRevealState` in the pre-split bridge) that gates the positional
 * trap-reveal SFX.
 */
export function createTrapStateHandlers(deps: StateBridgeDeps): TrapStateCallbacks {
  const trapRevealState = new Map<string, boolean>();
  return {
    onTrapAdd: (t, key) => {
      deps.entityRenderer.addTrap(key, t);
    },
    onTrapRemove: (key) => {
      deps.entityRenderer.removeTrap(key);
      trapRevealState.delete(key);
    },
    onTrapChange: (t, key) => {
      deps.entityRenderer.updateTrap(key, t);
      const wasRevealed = trapRevealState.get(key) ?? false;
      if (t.isRevealed && !wasRevealed) {
        deps.audio.playAt('trap_reveal', t.x, t.y);
      }
      trapRevealState.set(key, t.isRevealed);
    },
  };
}
