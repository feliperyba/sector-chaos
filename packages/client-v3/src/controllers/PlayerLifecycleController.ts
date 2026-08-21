import type { GameState } from './GameState.js';
import type { ResultsScreen } from '../hud/ResultsScreen.js';
import type { PlacementData } from '../hud/ResultsScreen.js';
import type { DeathScreen } from '../hud/DeathScreen.js';
import type { SpectatorController } from './SpectatorController.js';
import type { InputBuffer } from '../prediction/InputBuffer.js';
import type { CameraService } from '../rendering/CameraService.js';
import type { PlayerRenderer } from '../rendering/PlayerRenderer.js';
import type { HUDManager } from '../hud/HUDManager.js';
import type { StateSync } from '../network/StateSync.js';
import type { StateBridgeResult } from '../bridges/ClientStateBridge.js';

export class PlayerLifecycleController {
  constructor(
    private readonly state: GameState,
    private readonly resultsScreen: ResultsScreen,
    private readonly deathScreen: DeathScreen,
    private readonly spectator: SpectatorController,
    private readonly inputBuffer: InputBuffer,
    private readonly cameraService: CameraService,
    private readonly playerRenderer: PlayerRenderer,
    private readonly hud: HUDManager,
    private readonly stateSync: StateSync,
    private readonly stateBridge: StateBridgeResult,
    private readonly returnToMenu: () => void,
  ) {}

  update(isDead: boolean, myPlayer: { x: number; y: number } | null | undefined): void {
    if (isDead && !this.state.wasDead) {
      this.state.wasDead = true;
      const alive = this.stateSync.getPlayersAlive();
      const matchTimer = this.stateSync.getMatchTimer();
      const placements = this.buildPlacementData();
      // Hide the main HUD's personal widgets immediately on death so the dead
      // local player's health/inventory/dash/power-ups do not bleed through the
      // semi-transparent death-results overlay. Match-state widgets (minimap,
      // kill feed, timer/phase/alive) stay visible (findings B2 §6.2). The
      // spectator HUD is shown when the user clicks SPECTATE (below); until
      // then the personal readout is simply gone.
      this.hud.setSpectating(true);
      this.resultsScreen.show(placements, '', this.returnToMenu, 'death', {
        aliveCount: alive,
        matchTimerMs: matchTimer,
        killCount: this.state.killCount,
        onReturnToTitle: this.returnToMenu,
        onSpectate: () => {
          this.spectator.handleDeath(this.stateSync);
        },
      });
    }

    if (!isDead && this.state.wasDead) {
      this.state.wasDead = false;
      this.state.killCount = 0;
      if (this.resultsScreen?.isVisible) this.resultsScreen.hide();
      if (this.deathScreen?.isVisible) this.deathScreen.hide();
      this.spectator.handleRespawn();
      this.hud.hideSpectatorHUD();
      // Restore the main HUD's personal widgets on respawn (symmetric with the
      // setSpectating(true) call on the death rising edge above).
      this.hud.setSpectating(false);
      this.inputBuffer.clear();
      this.state.localIsDashing = false;
      this.state.localDashRemaining = 0;
      this.cameraService.lerpEnabled = true;
      this.cameraService.zoomRespawn();
      if (!myPlayer) return;
      this.state.applyRespawnPosition(myPlayer.x, myPlayer.y);
      this.cameraService.snapTo(this.state.localPos.x, this.state.localPos.y);
      this.playerRenderer.resetForRespawn(
        this.state.myId,
        this.state.localPos.x,
        this.state.localPos.y,
      );
    }
  }

  private buildPlacementData(): PlacementData[] {
    const entities = this.stateSync.getEntities();
    const players = Array.from(entities.players.values());
    const sorted = players.sort((a, b) => b.kills - a.kills);
    const matchTimer = this.stateSync.getMatchTimer();
    return sorted.map((p, i) => ({
      playerId: p.id,
      placement: i + 1,
      kills: p.kills,
      damageDealt: 0,
      damageTaken: 0,
      survivalTimeMs: matchTimer,
      weaponsUsed: p.weapons.filter((w) => w.weaponType > 0).length,
      itemsCollected: p.items.length,
      name: this.stateBridge.playerNames.get(p.id) ?? p.id.substring(0, 8),
    }));
  }
}
