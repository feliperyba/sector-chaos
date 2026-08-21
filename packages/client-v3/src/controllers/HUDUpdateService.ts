import { PLAYER } from '@sector-battle/shared';
import type { HUDManager } from '../hud/HUDManager.js';
import type { InteractionDetector } from '../controllers/InteractionDetector.js';
import type { GameState } from './GameState.js';
import type { StateSync } from '../network/StateSync.js';
import type { SpectatorController } from './SpectatorController.js';

export class HUDUpdateService {
  constructor(
    private readonly hud: HUDManager,
    private readonly interactionDetector: InteractionDetector,
    private readonly state: GameState,
    private readonly stateSync: StateSync,
    private readonly spectator: SpectatorController,
  ) {}

  update(delta: number, isDead: boolean): void {
    this.hud.update(performance.now());

    if (this.spectator.isSpectating) {
      // Spectating: show the SPECTATED player's readout (their health/loadout),
      // NOT the dead local player's. Personal-widget repaints (dash/power-ups)
      // are gated off below via the else branch — the per-frame HUDManager gates
      // also backstop this. Findings B2 §2 "Per-frame repaint" + §4 H5.
      if (this.spectator.freeCamera) {
        this.hud.showSpectatorHUD('FREE CAMERA', 0, 0, [], 0);
      } else if (this.spectator.spectateTarget) {
        const target = this.stateSync.getPlayer(this.spectator.spectateTarget);
        if (target) {
          this.hud.showSpectatorHUD(
            target.name || this.spectator.spectateTarget.substring(0, 8),
            target.health,
            target.maxHealth,
            target.weapons ?? [],
            target.activeSlot ?? 0,
            target.barrierActive,
            target.speedBoostActive,
          );
        }
      }
    } else {
      this.hud.hideSpectatorHUD();
      // Personal-widget repaints belong to the LOCAL player only. Drive them
      // here (the not-spectating branch) so the dead local player's stale
      // health/inventory/dash/power-ups are never re-driven during spectate.
      const myPlayer = this.stateSync.getPlayer(this.state.myId);
      if (myPlayer) {
        this.hud.updateDashCooldown(myPlayer.dashCooldown, Math.round(PLAYER.DASH_COOLDOWN * 60));
        const tick = this.stateSync.getTick();
        const barrierRemaining = myPlayer.barrierActive
          ? Math.max(0, (myPlayer.barrierExpiryTick - tick) / 60)
          : 0;
        const speedRemaining = myPlayer.speedBoostActive
          ? Math.max(0, (myPlayer.speedBoostExpiryTick - tick) / 60)
          : 0;
        this.hud.updatePowerUps(
          myPlayer.barrierActive,
          barrierRemaining,
          myPlayer.speedBoostActive,
          speedRemaining,
        );
      }
    }

    this.hud.setInteractionPrompt(isDead ? '' : this.interactionDetector.interactionPrompt);
    this.hud.updatePromptPosition(this.state.localPos.x, this.state.localPos.y);
  }
}
