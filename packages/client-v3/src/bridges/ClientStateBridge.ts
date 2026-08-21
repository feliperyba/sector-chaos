import type { StateCallbacks } from '../network/StateSync.js';
import type { StateSync } from '../network/StateSync.js';
import type { PlayerRenderer } from '../rendering/PlayerRenderer.js';
import type { StatusEffectRenderer } from '../rendering/StatusEffectRenderer.js';
import type { EntityInterpolator } from '../prediction/EntityInterpolator.js';
import type { EntityRenderer } from '../rendering/EntityRenderer.js';
import type { MapRenderer } from '../rendering/MapRenderer.js';
import type { HUDManager } from '../hud/HUDManager.js';
import type { AudioService } from '../audio/AudioService.js';
import type { CameraService } from '../rendering/CameraService.js';
import type { InputBuffer } from '../prediction/InputBuffer.js';
import type { Reconciler } from '../prediction/Reconciler.js';
import type { GameState } from '../controllers/GameState.js';
import type { ReconciliationLog } from '../debug/ReconciliationLog.js';
import { PlayerReconciler } from './state-sync/PlayerReconciler.js';
import { RemotePlayerInterpolator } from './state-sync/RemotePlayerInterpolator.js';
import { PlayerVisualSync } from './state-sync/PlayerVisualSync.js';
import { PlayerHealthEffects } from './state-sync/PlayerHealthEffects.js';
import { createPlayerStateHandlers } from './state-sync/PlayerStateHandlers.js';
import { createProjectileStateHandlers } from './state-sync/ProjectileStateHandlers.js';
import { createDestructibleStateHandlers } from './state-sync/DestructibleStateHandlers.js';
import { createChestPickupStateHandlers } from './state-sync/ChestPickupStateHandlers.js';
import { createTrapStateHandlers } from './state-sync/TrapStateHandlers.js';
import { createExplosionStateHandlers } from './state-sync/ExplosionStateHandlers.js';
import { createExitStateHandlers } from './state-sync/ExitStateHandlers.js';
import { createPhaseStateHandlers } from './state-sync/PhaseStateHandlers.js';

export interface StateBridgeDeps {
  myId: { value: string };
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  rtt: { value: number };
  playerRenderer: PlayerRenderer;
  statusEffects: StatusEffectRenderer;
  interpolator: EntityInterpolator;
  projectileInterpolator: EntityInterpolator;
  entityRenderer: EntityRenderer;
  mapRenderer: MapRenderer;
  hud: HUDManager;
  audio: AudioService;
  cameraService: CameraService;
  stateSync: { value: StateSync | null };
  inputBuffer: InputBuffer;
  reconciler: Reconciler;
  reconciliationLog: { value: ReconciliationLog | undefined };
  correctionOffset: { x: number; y: number };
  isSpectating: { value: boolean };
  /**
   * Owning GameState — passed to PlayerReconciler as the single writer
   * for the reconciliation snap + correctionOffset (10b refactor).
   * Bridge-level callbacks still read/write the field refs above
   * directly; only the reconciler's write has been consolidated.
   */
  gameState: GameState;
}

export interface StateBridgeResult {
  callbacks: StateCallbacks;
  playerNames: Map<string, string>;
  reconciliationLogRef: { value: ReconciliationLog | undefined };
}

/**
 * State-sync bridge (ticket 45): a thin composition root + wiring table. The
 * per-entity handler bodies live in `bridges/state-sync/*StateHandlers.ts`
 * (players / projectiles / destructibles / chests+pickups / traps / explosions
 * / exits / phase); the player family delegates to its collaborators
 * (PlayerReconciler, RemotePlayerInterpolator, PlayerVisualSync, and
 * PlayerHealthEffects for the health-edge/fire-particle logic).
 *
 * The wiring table below maps callback name → module handler in the SAME key
 * order as the pre-split callbacks literal (note onTrap* sits between
 * onWeaponPickup* and onPowerUp*). Key order is behaviorally inert — StateSync
 * consumes the object BY NAME (`cb.onPlayerAdd`, …) inside `subscribe()`, never
 * via key iteration; the behavior-relevant registration order is the sequence
 * of `subscribeCollection` calls in StateSync.subscribe, which is untouched.
 * Every factory call creates fresh closures per bridge (callback identity
 * semantics preserved) and the family-local edge-state maps (prevHealth,
 * trapRevealState) moved into their modules with identical per-bridge lifetime.
 */
export function createStateBridge(deps: StateBridgeDeps): StateBridgeResult {
  const playerNames = new Map<string, string>();

  // Juice-pass-1 ticket 06 — the primed-barrel fire escalates off the SYNCED
  // server tick (same provider PlayerVisualSync builds below; never a client
  // timer). Wired here because the bridge owns the entityRenderer+stateSync
  // pairing (GameSceneSetup sits at its file-length cap).
  deps.entityRenderer.setServerTickProvider(() => deps.stateSync.value?.getTick() ?? 0);

  const reconciler = new PlayerReconciler({
    gameState: deps.gameState,
    rtt: deps.rtt,
    inputBuffer: deps.inputBuffer,
    reconciler: deps.reconciler,
    stateSync: deps.stateSync,
    reconciliationLog: deps.reconciliationLog,
    isSpectating: deps.isSpectating,
  });

  const remoteInterpolator = new RemotePlayerInterpolator(deps.interpolator);

  const visualSync = new PlayerVisualSync({
    myId: deps.myId,
    playerRenderer: deps.playerRenderer,
    statusEffects: deps.statusEffects,
    audio: deps.audio,
    getServerTick: () => deps.stateSync.value?.getTick() ?? 0,
  });

  const healthEffects = new PlayerHealthEffects({ entityRenderer: deps.entityRenderer });

  const playerHandlers = createPlayerStateHandlers({
    deps,
    playerNames,
    reconciler,
    remoteInterpolator,
    visualSync,
    healthEffects,
  });
  const projectileHandlers = createProjectileStateHandlers(deps);
  const destructibleHandlers = createDestructibleStateHandlers(deps);
  const chestPickupHandlers = createChestPickupStateHandlers(deps);
  const trapHandlers = createTrapStateHandlers(deps);
  const explosionHandlers = createExplosionStateHandlers(deps);
  const exitHandlers = createExitStateHandlers(deps);
  const phaseHandlers = createPhaseStateHandlers(deps);

  const callbacks: StateCallbacks = {
    onPlayerAdd: playerHandlers.onPlayerAdd,
    onPlayerRemove: playerHandlers.onPlayerRemove,
    onPlayerChange: playerHandlers.onPlayerChange,
    onProjectileAdd: projectileHandlers.onProjectileAdd,
    onProjectileRemove: projectileHandlers.onProjectileRemove,
    onProjectileChange: projectileHandlers.onProjectileChange,
    onDestructibleAdd: destructibleHandlers.onDestructibleAdd,
    onDestructibleRemove: destructibleHandlers.onDestructibleRemove,
    onDestructibleChange: destructibleHandlers.onDestructibleChange,
    onChestAdd: chestPickupHandlers.onChestAdd,
    onChestRemove: chestPickupHandlers.onChestRemove,
    onChestChange: chestPickupHandlers.onChestChange,
    onWeaponPickupAdd: chestPickupHandlers.onWeaponPickupAdd,
    onWeaponPickupRemove: chestPickupHandlers.onWeaponPickupRemove,
    onWeaponPickupChange: chestPickupHandlers.onWeaponPickupChange,
    onTrapAdd: trapHandlers.onTrapAdd,
    onTrapRemove: trapHandlers.onTrapRemove,
    onTrapChange: trapHandlers.onTrapChange,
    onPowerUpAdd: chestPickupHandlers.onPowerUpAdd,
    onPowerUpRemove: chestPickupHandlers.onPowerUpRemove,
    onPowerUpChange: chestPickupHandlers.onPowerUpChange,
    onExplosionAdd: explosionHandlers.onExplosionAdd,
    onExplosionRemove: explosionHandlers.onExplosionRemove,
    onExitAdd: exitHandlers.onExitAdd,
    onExitRemove: exitHandlers.onExitRemove,
    onExitChange: exitHandlers.onExitChange,
    onStateChange: phaseHandlers.onStateChange,
  };

  return { callbacks, playerNames, reconciliationLogRef: deps.reconciliationLog };
}
