import Phaser from 'phaser';

/**
 * Frame-rate-independent exponential follow rate (per second). Tuned so the
 * per-frame lerp factor at 60fps matches the previous hardcoded 0.1:
 *   cameraLerpFactor(1/60, FOLLOW_RATE) = 1 - exp(-6.0/60) ≈ 0.0952 ≈ 0.1
 *
 * Because Phaser's camera lerp is applied per-render (`scroll += (target -
 * scroll) * lerp`), a fixed 0.1 glides ~2x faster at 120Hz and ~2x slower at
 * 30Hz. Deriving the per-frame factor from delta (C4a) keeps the 60fps feel
 * while making high/low refresh consistent. See C4-movement-jitter.md Cause A.
 */
export const FOLLOW_RATE = 6.0;

/**
 * Deadzone as a fraction of viewport dimensions. Tightened from 0.25 (C4a): the
 * old 25% band let the player visibly drift within the deadzone, which read as
 * "the camera isn't attached to me". 0.12 keeps a small no-jitter band while
 * feeling attached. Exported so the regression test can pin the tightened range.
 */
export const DEADZONE_RATIO = 0.12;

/**
 * Maximum accepted frame delta (ms). A backgrounded tab or GC pause can deliver
 * a multi-second delta; clamping prevents the punch/zoom/shake springs from
 * blowing out (matches the PredictionService clamp in GameScene.update).
 */
const MAX_DELTA_MS = 50;

/**
 * Compute the frame-rate-independent per-frame lerp factor for exponential
 * smoothing, given a delta (seconds) and a per-second rate. Pure + exported so
 * the regression test can assert the dt-scaling contract without Phaser.
 *
 *   factor = 1 - exp(-rate * dt)
 *
 * At a fixed rate this scales linearly with dt for small values (so 120fps →
 * half the 60fps factor, 30fps → ~1.7x), which is exactly the contract:
 * same perceived smoothing speed regardless of refresh rate.
 */
export function cameraLerpFactor(dtSeconds: number, rate: number = FOLLOW_RATE): number {
  return 1 - Math.exp(-rate * dtSeconds);
}

/**
 * Smooth camera follow via Phaser's built-in startFollow + deadzone + lerp.
 *
 * Architecture (ADR-0019 spectator-snap preserved):
 * - An invisible Zone GameObject is the follow target. Phaser's Camera.preRender
 *   (runs at render time, after scene.update) owns the scrollX/Y lerp toward this
 *   target — deadzone-aware, no hand-rolled scroll lerp. The per-frame lerp
 *   factor is derived from `delta` here in update() (C4a: dt-normalized) so the
 *   follow feel is refresh-rate-independent while the deadzone logic stays in
 *   Phaser.
 * - Deadzone (~12% of viewport): camera stays still while the player is near
 *   screen center, eliminating micro-jitter from sub-pixel target movement.
 *   Tightened from 25% (C4a) so the player doesn't drift within a wide band.
 * - Punch (directional recoil): routed through cam.followOffset with a spring.
 *   The offset shifts where the camera centers relative to the player; Phaser's
 *   follow respects it, so the kick integrates cleanly with the follow lerp.
 * - Shake: Phaser's built-in cam.shake() — matrix-based (translates the camera
 *   matrix in preRender, doesn't touch scrollX), so it never fights the follow.
 * - Zoom: tween-based (unchanged) — zoom doesn't interact with scroll follow.
 *
 * Public API is identical to the previous hand-rolled version, so all callers
 * (event handlers, lifecycle, bridges, GameScene) need zero changes.
 */
export class CameraService {
  private scene: Phaser.Scene;
  private cam: Phaser.Cameras.Scene2D.Camera;
  /** Invisible follow target — Phaser tracks this object's x/y. */
  private followTarget: Phaser.GameObjects.Zone;
  private shakeIntensity = 0;
  private shakeDuration = 0;
  private shakeTime = 0;
  private shakePhaseX = 0;
  private shakePhaseY = 0;
  private activeZoomTween: Phaser.Tweens.Tween | null = null;
  private baseZoom = 1.0;
  lerpEnabled = true;
  /**
   * C5 (walk+camera stutter): when true the camera rigidly centers on the
   * follow target every frame — deadzone cleared, lerp pinned to 1. Used for
   * the LOCAL alive player, whose `visual` position (PredictionService.
   * getVisualPosition = localPos + localVelocity·accumulator + correctionOffset)
   * is already C1-smooth during sustained movement (the substep advance of
   * localPos exactly cancels the accumulator drain), so there is NO micro-jitter
   * for a deadzone to absorb. The previous deadzone + per-frame lerp instead
   * created a limit cycle at the deadzone edge during sustained walk (camera
   * lags → player drifts past the edge → camera catches up → player springs
   * back), felt as a constant-pace few-px rollback ("stutter"/"floaty"); and
   * the lerp's steady-state lag (~v/FOLLOW_RATE ≈ 72px @ 430px/s) was the
   * "floaty" off-center drift itself. Rigid follow pins the player dead-center
   * and tracks the smooth visual exactly at any refresh rate.
   *
   * Spectator (follow(), not followRigid()) keeps the deadzone + dt-normalized
   * lerp — the spectated target is a remote-interpolated entity where a small
   * soft-follow is desirable and no local aiming happens. Default true: the
   * common state is the local alive player; the spectator/death path flips it
   * to false via follow().
   */
  private rigidFollow = true;

  /** Spring state for directional punch (recoil). Decays to (0,0). */
  private punchX = 0;
  private punchY = 0;
  private punchVelX = 0;
  private punchVelY = 0;
  private readonly punchStiffness = 300;

  private zoomPunchAmount = 0;
  private zoomPunchVel = 0;
  private readonly zoomPunchStiffness = 200;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.cam = scene.cameras.main;
    // Invisible 1x1 zone as the follow target. Zone has no render cost.
    this.followTarget = scene.add.zone(0, 0, 1, 1);
    this.followTarget.setVisible(false);
    // Wire Phaser's built-in follow: deadzone-aware scroll. The lerp factor is
    // set per-frame from `delta` in update() (C4a dt-normalization); pass 0
    // here so the startFollow default never leaks in before the first update.
    this.cam.startFollow(this.followTarget, false, 0, 0);
    this.applyDeadzone();
  }

  /** Set the deadzone rectangle based on current camera dimensions. */
  private applyDeadzone(): void {
    const dzW = this.cam.width * DEADZONE_RATIO;
    const dzH = this.cam.height * DEADZONE_RATIO;
    this.cam.setDeadzone(dzW, dzH);
  }

  follow(x: number, y: number): void {
    // Soft follow (deadzone + dt-normalized lerp) — spectator path. Flips
    // rigidFollow off so update() restores the deadzone. Punch (directional
    // recoil) is routed through cam.followOffset in update() — Phaser reads
    // followOffset fresh at preRender time, so both are combined without
    // frame-ordering dependency between follow() and update().
    this.rigidFollow = false;
    this.followTarget.setPosition(x, y);
  }

  /**
   * Current follow-target world position (what Phaser's camera is tracking).
   * Exposed for walk-stutter instrumentation (C5): for the local alive player
   * this MUST equal the prediction visual position; any divergence means the
   * follow target wasn't set where the sprite is.
   */
  getFollowTarget(): { x: number; y: number } {
    return { x: this.followTarget.x, y: this.followTarget.y };
  }

  /**
   * Rigid center-on-target follow for the LOCAL alive player (no deadzone,
   * lerp=1). See the `rigidFollow` field doc for why the local player must not
   * use the deadzone + lerp path. The follow target is positioned here; the
   * deadzone clear + lerp=1 are applied in update() (idempotent and guarded).
   */
  followRigid(x: number, y: number): void {
    this.rigidFollow = true;
    this.followTarget.setPosition(x, y);
  }

  snapTo(x: number, y: number): void {
    // snapTo is used for local respawn/teleport — re-enter rigid local follow.
    this.rigidFollow = true;
    this.followTarget.setPosition(x, y);
    this.cam.centerOn(x, y);
    this.cam.setZoom(1.0);
    this.baseZoom = 1.0;
    this.punchX = 0;
    this.punchY = 0;
    this.punchVelX = 0;
    this.punchVelY = 0;
    this.cam.followOffset.set(0, 0);
    this.zoomPunchAmount = 0;
    this.zoomPunchVel = 0;
    this.shakeIntensity = 0;
    this.cancelZoomTween();
  }

  shake(intensity: number, duration: number): void {
    // A new shake never weakens one already ringing
    const remaining = this.currentShakeAmplitude();
    if (intensity < remaining) return;
    this.shakeIntensity = intensity;
    this.shakeDuration = duration;
    this.shakeTime = performance.now();
    // Random phase per impact so repeated hits don't look identical
    this.shakePhaseX = Math.random() * Math.PI * 2;
    this.shakePhaseY = Math.random() * Math.PI * 2;
  }

  private currentShakeAmplitude(): number {
    if (this.shakeIntensity <= 0) return 0;
    const elapsed = performance.now() - this.shakeTime;
    if (elapsed >= this.shakeDuration) return 0;
    const t = 1 - elapsed / this.shakeDuration;
    return this.shakeIntensity * t * t * t;
  }

  punch(px: number, py: number): void {
    this.punchVelX += px * 10;
    this.punchVelY += py * 10;
  }

  zoomPunch(pct: number): void {
    this.zoomPunchVel += pct * 5;
  }

  zoomDeath(): void {
    this.animateZoom(0.7, 300);
  }

  zoomRespawn(): void {
    this.animateZoom(1.0, 200);
  }

  zoomTo(zoom: number, duration: number): void {
    this.animateZoom(zoom, duration);
  }

  private animateZoom(targetZoom: number, duration: number): void {
    this.cancelZoomTween();
    const cam = this.cam;
    this.activeZoomTween = this.scene.tweens.add({
      targets: cam,
      zoom: targetZoom,
      duration,
      ease: 'Quad.easeInOut',
      onComplete: () => {
        this.activeZoomTween = null;
        this.baseZoom = targetZoom;
      },
    });
  }

  private cancelZoomTween(): void {
    if (this.activeZoomTween) {
      this.activeZoomTween.stop();
      this.activeZoomTween = null;
    }
  }

  update(delta: number = 16): void {
    // Clamp the incoming delta: a backgrounded tab / GC pause can deliver a
    // multi-second delta that would blow out the punch/zoom/shake springs (and
    // produce a single-frame lerp of ~1.0). Mirrors the PredictionService clamp
    // in GameScene.update. (C4a.)
    const clampedDelta = Math.min(delta, MAX_DELTA_MS);
    const dt = clampedDelta / 1000;

    // Per-frame follow lerp factor derived from delta (C4a dt-normalization).
    // At 60fps this matches the previous hardcoded 0.1; at 120/144Hz it's the
    // same perceived smoothing speed (not 2x faster); at 30Hz it's not laggier.
    // Spectator mode (lerpEnabled=false) snaps instantly to the spectated
    // target — a factor of 1.0 means "fully on target this frame".
    if (this.rigidFollow) {
      // C5: local alive player — rigid center. Clear the deadzone (set in the
      // constructor / restored by the spectator branch) and pin lerp to 1 so
      // Phaser's preRender scrolls the camera exactly onto the follow target
      // every frame. Both writes are guarded so they're no-ops after the first
      // rigid frame; toggling back to spectator restore them via the else branch.
      if (this.cam.deadzone !== null) this.cam.deadzone = null;
      if (this.cam.lerp.x !== 1 || this.cam.lerp.y !== 1) this.cam.setLerp(1, 1);
    } else {
      // Spectator: deadzone + dt-normalized lerp.
      if (this.cam.deadzone === null) this.applyDeadzone();
      const targetLerp = this.lerpEnabled ? cameraLerpFactor(dt) : 1;
      if (this.cam.lerp.x !== targetLerp) this.cam.setLerp(targetLerp, targetLerp);
    }

    // Advance the punch spring and push it to cam.followOffset. Phaser reads
    // followOffset fresh at preRender time (Camera.js:557-558), so directional
    // recoil shifts the camera center relative to the player and springs back
    // as punchX/Y decay — independent of the follow()/update() call order.
    if (
      this.punchStiffness > 0 &&
      (Math.abs(this.punchX) > 0.01 ||
        Math.abs(this.punchY) > 0.01 ||
        Math.abs(this.punchVelX) > 0.01 ||
        Math.abs(this.punchVelY) > 0.01)
    ) {
      const omega = Math.sqrt(this.punchStiffness);
      const dampCoeff = 2 * 0.9 * omega;
      const ax = -this.punchStiffness * this.punchX - dampCoeff * this.punchVelX;
      const ay = -this.punchStiffness * this.punchY - dampCoeff * this.punchVelY;
      this.punchVelX += ax * dt;
      this.punchVelY += ay * dt;
      this.punchX += this.punchVelX * dt;
      this.punchY += this.punchVelY * dt;
    }
    this.cam.followOffset.set(this.punchX, this.punchY);

    // Zoom punch spring (separate from the zoom tween — additive on baseZoom).
    if (
      this.zoomPunchStiffness > 0 &&
      (Math.abs(this.zoomPunchAmount) > 0.001 || Math.abs(this.zoomPunchVel) > 0.001)
    ) {
      const omega = Math.sqrt(this.zoomPunchStiffness);
      const dampCoeff = 2 * 0.9 * omega;
      const acc = -this.zoomPunchStiffness * this.zoomPunchAmount - dampCoeff * this.zoomPunchVel;
      this.zoomPunchVel += acc * dt;
      this.zoomPunchAmount += this.zoomPunchVel * dt;
      this.cam.zoom = this.baseZoom + this.zoomPunchAmount / 100;
    }

    // Shake: apply as additive scroll offset AFTER Phaser's follow has run for
    // this frame's preRender. Because Phaser's follow reads scrollX at the
    // START of preRender (next frame), this frame's shake offset is visible
    // for one frame, then the follow's lerp partially absorbs it — which is
    // the desired behavior (shake decays naturally toward the follow center).
    if (this.shakeIntensity > 0) {
      const elapsed = performance.now() - this.shakeTime;
      if (elapsed < this.shakeDuration) {
        const t = 1 - elapsed / this.shakeDuration;
        const decay = t * t * t;
        // Smooth decaying oscillation (two detuned sines per axis), not
        // per-frame random offsets — white noise reads as jitter, and gets
        // worse the higher the display refresh rate.
        const s = elapsed / 1000;
        const ox =
          Math.sin(s * 2 * Math.PI * 27 + this.shakePhaseX) * 0.7 +
          Math.sin(s * 2 * Math.PI * 41 + this.shakePhaseX * 1.7) * 0.3;
        const oy =
          Math.sin(s * 2 * Math.PI * 31 + this.shakePhaseY) * 0.7 +
          Math.sin(s * 2 * Math.PI * 47 + this.shakePhaseY * 1.7) * 0.3;
        this.cam.scrollX += ox * this.shakeIntensity * decay;
        this.cam.scrollY += oy * this.shakeIntensity * decay;
      } else {
        this.shakeIntensity = 0;
      }
    }
  }
}
