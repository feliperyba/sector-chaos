import type { AudioService } from './AudioService.js';
import type { GameState } from '../controllers/GameState.js';
import type { InputFrame } from '../types.js';

export class AudioTriggerService {
  constructor(
    private readonly audio: AudioService,
    private readonly state: GameState,
  ) {}

  /**
   * NET-03 — footsteps now driven by the LIVE per-frame movement direction
   * (sampled every render frame) rather than the throttled send frame.
   * Footsteps fire continuously while the player is moving (more responsive
   * than the legacy throttle-dependent cadence) and reset the cooldown when
   * the player stops. The caller passes the raw (dirX, dirY) WASD state.
   */
  updateFootsteps(dirX: number, dirY: number, delta: number): void {
    const moveLen = Math.sqrt(dirX * dirX + dirY * dirY);
    if (moveLen > 0) {
      this.state.footstepTimer -= delta;
      if (this.state.footstepTimer <= 0) {
        this.audio.playFootstep();
        this.state.footstepTimer = 350;
      }
    } else {
      this.state.footstepTimer = 0;
    }
  }

  updateWeaponSwitch(currentSlot: number): void {
    if (currentSlot !== this.state.lastActiveSlot && this.state.lastActiveSlot >= 0) {
      this.audio.playWeaponSwitch();
    }
    this.state.lastActiveSlot = currentSlot;
  }

  triggerDash(): void {
    this.audio.playDash();
  }

  checkWindup(
    frame: InputFrame | null,
    activeWeaponType: number,
    myId: string,
    startWindup: (id: string, wt: number, thrown?: boolean) => void,
  ): void {
    if (!frame) return;
    if (frame.actions.includes('THROW')) {
      if (activeWeaponType > 0) startWindup(myId, activeWeaponType, true);
      return;
    }
    if (frame.actions.includes('ATTACK') && !frame.actions.includes('DASH')) {
      if (activeWeaponType >= 0) startWindup(myId, activeWeaponType);
    }
  }
}
