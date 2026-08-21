import { logger, PlayerStatus } from '@sector-battle/shared';
import type { StateCallbacks } from '../../network/StateSync.js';
import type { StateBridgeDeps } from '../ClientStateBridge.js';
import type { PlayerState } from '../../types.js';
import type { PlayerReconciler } from './PlayerReconciler.js';
import type { RemotePlayerInterpolator } from './RemotePlayerInterpolator.js';
import type { PlayerVisualSync } from './PlayerVisualSync.js';
import type { PlayerHealthEffects } from './PlayerHealthEffects.js';

export type PlayerStateCallbacks = Pick<
  StateCallbacks,
  'onPlayerAdd' | 'onPlayerRemove' | 'onPlayerChange'
>;

/**
 * Per-bridge wiring context for the players entity family. The collaborators
 * (reconciler / interpolator / visual-sync / health-effects) are constructed by
 * the bridge and shared per createStateBridge call; `playerNames` is the SAME
 * Map instance the bridge returns in StateBridgeResult (read by the event
 * handlers + PlayerLifecycleController).
 */
export interface PlayerStateHandlerContext {
  deps: StateBridgeDeps;
  playerNames: Map<string, string>;
  reconciler: PlayerReconciler;
  remoteInterpolator: RemotePlayerInterpolator;
  visualSync: PlayerVisualSync;
  healthEffects: PlayerHealthEffects;
}

/**
 * Players family state-sync handlers (ticket 45 — bodies moved verbatim from
 * the bridge's callbacks literal). onPlayerChange is delegation-only: the
 * health-edge/fire-particle logic lives in PlayerHealthEffects, position
 * reconciliation in PlayerReconciler, remote smoothing in
 * RemotePlayerInterpolator, and visual state in PlayerVisualSync.
 */
export function createPlayerStateHandlers(ctx: PlayerStateHandlerContext): PlayerStateCallbacks {
  const { deps, playerNames, reconciler, remoteInterpolator, visualSync, healthEffects } = ctx;
  return {
    onPlayerAdd: (p: PlayerState, key: string) => {
      logger.info(
        `Player added: ${key} at (${p.x}, ${p.y}) phase=${deps.stateSync.value?.getPhase()}`,
      );
      playerNames.set(key, p.name);
      healthEffects.trackPlayerAdd(key, p.health);
      deps.playerRenderer.addPlayer(key, p);
      // Bug 2 (floating arms): a player can arrive ALREADY dead (reconnect-as-
      // spectator, mid-match join with corpses in the snapshot). triggerDeath
      // otherwise only fires from onPlayerChange (status edge) or the KillFeed
      // event — neither runs at add time — so the corpse's driver would stay
      // IDLE, the death fade would never run, and its body + arms would linger
      // at full alpha. ensureDeathFade is idempotent (deathTriggered flag), so
      // a later onPlayerChange for the same corpse is a no-op.
      visualSync.ensureDeathFade(p, key);
      if (key === deps.myId.value) {
        deps.gameState.applySpawnPosition(p.x, p.y);
        deps.hud.updateHealth(p.health, p.maxHealth);
        deps.hud.updateInventory(p);
        deps.cameraService.snapTo(deps.localPos.x, deps.localPos.y);
      }
    },
    onPlayerRemove: (key: string) => {
      deps.playerRenderer.removePlayer(key);
      deps.statusEffects.removePlayer(key);
      remoteInterpolator.removePlayer(key);
      visualSync.removePlayer(key);
      deps.entityRenderer.setPlayerFireDOT(key, false);
      healthEffects.removePlayer(key);
    },
    onPlayerChange: (p: PlayerState, key: string) => {
      playerNames.set(key, p.name);

      const isDead =
        (p.status & (PlayerStatus.DYING | PlayerStatus.DEAD | PlayerStatus.SPECTATING)) !== 0;

      healthEffects.handlePlayerChange(p, key, isDead);

      if (key === deps.myId.value) {
        // Spectate gate: do not repaint the dead local player's stale
        // health/inventory on every state-sync (findings B2 §2 + §4 H5). The
        // reconciler guard below was already !isDead-gated; the HUD repaints
        // were not, so the main HUD was re-driven with stale dead-player data
        // every tick. Gate them symmetrically. HUDManager.setSpectating also
        // backstops this at the method level.
        if (!isDead) {
          deps.hud.updateHealth(p.health, p.maxHealth);
          deps.hud.updateInventory(p);
          reconciler.handleLocalPlayerChange(p);
        }
      } else if (!isDead) {
        remoteInterpolator.handleRemotePlayerChange(key, p.x, p.y, p.velocityX, p.velocityY);
      }
      visualSync.handlePlayerChange(p, key);
    },
  };
}
