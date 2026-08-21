import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';

export type PhaseStateCallbacks = Pick<StateCallbacks, 'onStateChange'>;

/**
 * Phase family state-sync handler (ticket 45 — body moved verbatim from the
 * bridge's callbacks literal). Drives the match-level HUD read model (phase /
 * timer / alive count) from the root-state patch.
 *
 * NOTE (ticket 45 scope): zone updates are NOT part of this table — the zone
 * has no StateCallbacks entry. Zone geometry is synced internally by
 * `StateSync.syncZone` (schema-poll, no client callback) and rendered from
 * `stateSync.getZoneState()`; zone EVENTS go through EventRouter → the
 * ZoneEventHandler module (bridges/event-handlers/).
 */
export function createPhaseStateHandlers(deps: StateBridgeDeps): PhaseStateCallbacks {
  return {
    onStateChange: () => {
      deps.hud.updatePhase(deps.stateSync.value!.getPhase());
      deps.hud.updateTimer(deps.stateSync.value!.getMatchTimer());
      deps.hud.updateAliveCount(deps.stateSync.value!.getPlayersAlive());
    },
  };
}
