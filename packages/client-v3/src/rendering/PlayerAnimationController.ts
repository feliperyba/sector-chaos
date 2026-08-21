/**
 * PlayerAnimationController — render-only visual flags (hit flash).
 *
 * The animation state machine that used to live here moved into the shared
 * deterministic sim (packages/shared/src/animation/stepAnimation.ts), driven
 * on the client by AnimSimDriver. This controller only tracks render-rate
 * effects that must NOT affect the simulation.
 */

export interface AnimationFlags {
  hitFlashActive: boolean;
  hitFlashExpired: boolean;
}

const HIT_FLASH_MS = 100;

export class PlayerAnimationController {
  private hitFlashTime = 0;
  private readonly _flags: AnimationFlags = { hitFlashActive: false, hitFlashExpired: false };

  triggerHitFlash(now: number): void {
    this.hitFlashTime = now;
  }

  update(now: number): AnimationFlags {
    const hitFlashActive = this.hitFlashTime > 0 && now - this.hitFlashTime < HIT_FLASH_MS;
    let hitFlashExpired = false;
    if (this.hitFlashTime > 0 && !hitFlashActive) {
      this.hitFlashTime = 0;
      hitFlashExpired = true;
    }
    this._flags.hitFlashActive = hitFlashActive;
    this._flags.hitFlashExpired = hitFlashExpired;
    return this._flags;
  }

  reset(): void {
    this.hitFlashTime = 0;
  }
}
