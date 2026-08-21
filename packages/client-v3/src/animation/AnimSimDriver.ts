/**
 * AnimSimDriver — client driver of the shared deterministic animation sim.
 *
 * One driver per player. Steps the SAME stepAnimation the server runs, at a
 * fixed 1/60 timestep on a render-time accumulator (the PredictionService
 * pattern), and exposes an interpolated pose for render-rate smoothness.
 *
 * Local player: phases are predicted (startAttack on input, auto-advance for
 * STRIKE/RECOVER — durations are tick-quantized via shared AnimTiming, so
 * they match the server's windup/cooldown windows exactly).
 * Remote players: phases are edge-triggered from synced state/events through
 * the same trigger API; reactions arrive as tick-stamped events and apply the
 * same pure impulse functions the server used.
 */
import {
  AnimPhase,
  AttackType,
  WeaponType,
  createAnimSimState,
  createAnimStepResult,
  getMotionSpec,
  logger,
  onWeaponChanged,
  setAnimPhase,
  startAttack,
  startStagger,
  stepAnimation,
  applyArmImpulses,
  computeAttackerRecoil,
  computeHitFlinch,
  worldToLocalVec,
  resolveAttackType,
  type AnimSimState,
  type AnimStepInput,
  type AnimStepResult,
  type ArmImpulses,
} from '@sector-battle/shared';
import { AnimationState } from '../types.js';
import { lerpResultInto } from './AnimSimLerp.js';
import type { AnimDesyncSnapshot } from './AnimDesync.js';

const FIXED_DT = 1 / 60;
const MAX_CATCHUP_STEPS = 4;
/** Ticks a predicted attack may run before the server must have confirmed it. */
const UNCONFIRMED_ATTACK_GRACE_TICKS = 12;
/** Phase-age divergence (client − server, in ticks) above which a correction
 *  re-bases the phase clock. Matches the existing deadband in applyServerPhase. */
const PHASE_AGE_DEADBAND_TICKS = 2;
/**
 * Maximum number of ticks `applyServerPhase` will advance the client's lagging
 * `simTick` in a single call to re-align with the server tick. Beyond this the
 * client is presumed to have been paused/backgrounded, and we snap rather than
 * run hundreds of catch-up steps. ~1s of catch-up is a safe cap for tab-throttle
 * gaps without stalling the frame.
 */
const MAX_SIMTICK_CATCHUP_TICKS = 60;
/** Corrections larger than this (in ticks) are logged once — they signal real
 *  animation-clock drift (≥100ms), not the normal sub-RTT jitter the deadband
 *  absorbs. Debug-only diagnostic for CROSS-005 animation sync verification. */
const DESYNC_LOG_THRESHOLD_TICKS = 6;

/** Per-frame world-state input for the driver (everything but tick/block). */
export interface DriverFrameInput {
  facingAngle: number;
  bodyX: number;
  bodyY: number;
  /** World velocity in px/s. */
  bodyVelX: number;
  bodyVelY: number;
  isMoving: boolean;
  weaponType: number;
  /** Shared tile-blocking query — same seeded grid as the server. */
  isWorldBlocked?: (x: number, y: number) => boolean;
}

const PHASE_TO_LEGACY: Record<AnimPhase, AnimationState> = {
  [AnimPhase.IDLE]: AnimationState.IDLE,
  [AnimPhase.WALK]: AnimationState.WALK,
  [AnimPhase.WINDUP]: AnimationState.WINDUP,
  [AnimPhase.STRIKE]: AnimationState.ATTACK_IMPACT,
  [AnimPhase.RECOVER]: AnimationState.COOLDOWN,
  [AnimPhase.BLOCK]: AnimationState.BLOCK,
  [AnimPhase.DASH]: AnimationState.DASH,
  [AnimPhase.STAGGER]: AnimationState.STAGGER,
  [AnimPhase.DYING]: AnimationState.DYING,
};

export class AnimSimDriver {
  private state: AnimSimState;
  private simTick = 0;
  private accumulator = 0;
  private prev: AnimStepResult = createAnimStepResult();
  private cur: AnimStepResult = createAnimStepResult();
  private readonly lerpOut: AnimStepResult = createAnimStepResult();
  private readonly stepInput: AnimStepInput = {
    tick: 0,
    facingAngle: 0,
    bodyX: 0,
    bodyY: 0,
    bodyVelX: 0,
    bodyVelY: 0,
    isMoving: false,
    blockHeld: false,
    weaponType: 0,
    isWorldBlocked: undefined,
  };
  private hasCur = false;
  private hasPrev = false;
  private blockHeld = false;
  private blockStartTick = 0;
  private blockConfirmed = false;
  /**
   * Body world positions passed to the last TWO step() calls (cur + prev). The
   * sim steps on a fixed 1/60 accumulator, so at >60Hz it does NOT step every
   * render frame — between steps, sample() INTERPOLATES between the prev and
   * cur poses, each centred on a DIFFERENT body position. The renderer reads
   * poseAnchorX/Y (which lerps these two by the same factor sample() uses) to
   * compute a re-anchor shift (see PlayerRendererUpdate) so arm joints stay
   * attached to the live body during fast movement (teleport-trap interpolation
   * glide). At 60Hz a step runs every frame, prev==cur, and the anchor always
   * equals the live body — the shift is a no-op.
   */
  private curStepBodyX = 0;
  private curStepBodyY = 0;
  private prevStepBodyX = 0;
  private prevStepBodyY = 0;

  // Debug-only desync tracking (CROSS-005). Updated inline in applyServerPhase;
  // read lazily via debugDesync(). See AnimDesyncSnapshot.
  private _lastPhaseAgeDelta = 0;
  private _lastCorrectionTicks = 0;
  private _correctionCount = 0;
  private _correctionGripX = 0;
  private _correctionGripY = 0;
  private _correctionTipX = 0;
  private _correctionTipY = 0;

  constructor(weaponType: number) {
    this.state = createAnimSimState(Math.max(0, weaponType), 0);
  }

  // ── State queries ──

  get phase(): AnimPhase {
    return this.state.phase;
  }

  /** Legacy AnimationState mapping for the juice/VFX layer. */
  get animState(): AnimationState {
    return PHASE_TO_LEGACY[this.state.phase];
  }

  /** Attack type string of the current attack cycle ('' when none). */
  get atkType(): string {
    return this.state.attackType;
  }

  get attackWeaponType(): number {
    return this.state.attackWeaponType;
  }

  get blocking(): boolean {
    return this.blockHeld;
  }

  get phaseProgress(): number {
    return this.hasCur ? this.cur.phaseProgress : 0;
  }

  /**
   * Interpolated body world X the sampled pose is centred on this render frame
   * (lerps prevStepBody → curStepBody by the same factor sample() uses). The
   * renderer subtracts this from the live body to re-anchor the pose.
   */
  get poseAnchorX(): number {
    if (!this.hasPrev) return this.curStepBodyX;
    const t = Math.max(0, Math.min(1, this.accumulator / FIXED_DT));
    return this.prevStepBodyX + (this.curStepBodyX - this.prevStepBodyX) * t;
  }

  /** Interpolated body world Y the sampled pose is centred on (for re-anchor). */
  get poseAnchorY(): number {
    if (!this.hasPrev) return this.curStepBodyY;
    const t = Math.max(0, Math.min(1, this.accumulator / FIXED_DT));
    return this.prevStepBodyY + (this.curStepBodyY - this.prevStepBodyY) * t;
  }

  get deathProgress(): number {
    return this.state.phase === AnimPhase.DYING ? (this.hasCur ? this.cur.phaseProgress : 0) : 0;
  }

  get inAttackCycle(): boolean {
    return (
      this.state.phase === AnimPhase.WINDUP ||
      this.state.phase === AnimPhase.STRIKE ||
      this.state.phase === AnimPhase.RECOVER
    );
  }

  /**
   * Debug-only animation desync snapshot (CROSS-005). Returns the latest
   * client↔server phase-clock divergence and the locally-stepped weapon
   * segment captured at the last correction. Intended for debug tooling /
   * TelemetrySampler polling of the local player's driver; production render
   * code never calls this.
   */
  debugDesync(): AnimDesyncSnapshot {
    return {
      phaseAgeDeltaTicks: this._lastPhaseAgeDelta,
      lastCorrectionTicks: this._lastCorrectionTicks,
      correctionCount: this._correctionCount,
      gripX: this._correctionGripX,
      gripY: this._correctionGripY,
      tipX: this._correctionTipX,
      tipY: this._correctionTipY,
    };
  }

  /** Test-only accessor for the driver's tick counter. */
  get simTickForTest(): number {
    return this.simTick;
  }

  // ── Phase triggers (mirror the server's authoritative transitions) ──

  startAttack(weaponType: number, forceThrown: boolean): boolean {
    if (this.inAttackCycle) return false;
    const attackType = resolveAttackType(weaponType, forceThrown ? AttackType.THROWN : undefined);
    startAttack(this.state, this.simTick, weaponType, attackType);
    return true;
  }

  setBlockHeld(held: boolean): void {
    if (held && !this.blockHeld) this.blockStartTick = this.simTick;
    if (!held) this.blockConfirmed = false;
    this.blockHeld = held;
  }

  /**
   * Level-sync the block state to the server (runs every patch, all players).
   * A locally predicted press gets a grace window before an unconfirmed block
   * is dropped; once confirmed, the server's `false` releases it immediately.
   * Edge-based release alone leaks: a block the server never confirmed (or
   * that ended via weapon switch/throw) has no falling edge and the pose
   * would stay locked in BLOCK forever.
   */
  syncServerBlock(serverBlocking: boolean): void {
    if (serverBlocking) {
      if (!this.blockHeld) this.blockStartTick = this.simTick;
      this.blockHeld = true;
      this.blockConfirmed = true;
      return;
    }
    if (
      this.blockHeld &&
      (this.blockConfirmed || this.simTick - this.blockStartTick > UNCONFIRMED_ATTACK_GRACE_TICKS)
    ) {
      this.blockHeld = false;
      this.blockConfirmed = false;
    }
  }

  triggerDash(): void {
    setAnimPhase(this.state, AnimPhase.DASH, this.simTick);
  }

  triggerStagger(durationTicks: number): void {
    startStagger(this.state, this.simTick, durationTicks);
  }

  triggerDeath(): void {
    setAnimPhase(this.state, AnimPhase.DYING, this.simTick);
  }

  interruptSwing(): void {
    this.state.swingInterrupted = true;
  }

  /**
   * ALL players: align the attack-cycle phase to the server's authoritative
   * (animPhase, phaseAge) so the displayed blade overlaps the server hitbox.
   * Remote views would lag the swing ~RTT on edge triggers alone; the LOCAL
   * view starts instantly from input prediction and converges here — and an
   * attack the server never confirmed (rejected input) is cancelled, so every
   * client renders the same authoritative animation. Springs are never
   * snapped; only the phase clock is re-based.
   */
  applyServerPhase(
    phaseNum: number,
    ageTicks: number,
    comboIndex: number,
    weaponType: number,
    attackType: string,
    serverTick?: number,
    serverPhaseStartTick?: number,
  ): void {
    // ── simTick catch-up (B4 perf H6) ──
    // The client's simTick must stay aligned with the server's tick in BOTH
    // directions. The prior code only advanced simTick forward (when the client
    // lagged behind), never backward (when the client ran ahead — which happens
    // whenever the server overruns and schema.tick advances slower than the
    // client's wall-clock 60Hz frame loop). That left a positive delta that the
    // rebase absorbed into phaseStartTick, but each rebase snapped the pose
    // (visible jitter) and the delta exceeded the log threshold first. Here we
    // align simTick to the server tick within a deadband in either direction:
    //   • client behind (lag > deadband): advance simTick forward (the original
    //     H6 path — slow frame / hit-stop / tab-throttle recovery).
    //   • client ahead (lag < -deadband): step simTick back toward the server.
    //     This is the fix for the steady +6/+7 drift seen when the server
    //     overruns: the client frame loop outruns the server's tick, the gap
    //     grows positive, and without backward catch-up it accumulates until
    //     the rebase snaps.
    // The phaseStartTick is carried by the same delta so the phase age is
    // preserved during catch-up. Catch-up magnitude is capped to avoid a huge
    // jump (tab-throttle); a large gap still snaps but within a bounded step.
    if (serverTick !== undefined && serverTick > 0) {
      const lag = serverTick - this.simTick;
      if (lag > PHASE_AGE_DEADBAND_TICKS) {
        const advance = Math.min(lag, MAX_SIMTICK_CATCHUP_TICKS);
        this.simTick += advance;
        this.state.phaseStartTick += advance;
        this.blockStartTick += advance;
      } else if (lag < -PHASE_AGE_DEADBAND_TICKS) {
        // Client is ahead of the server — step simTick back. Bound the step so
        // a single correction doesn't reverse more than MAX_SIMTICK_CATCHUP_TICKS
        // (matches the forward bound). phaseStartTick + blockStartTick carry by
        // the same delta so the phase age is preserved (no pose discontinuity
        // from the clock realignment itself).
        const backStep = Math.max(lag, -MAX_SIMTICK_CATCHUP_TICKS);
        this.simTick += backStep;
        this.state.phaseStartTick += backStep;
        this.blockStartTick += backStep;
      }
    }

    const phase = phaseNum as AnimPhase;
    if (phase !== AnimPhase.WINDUP && phase !== AnimPhase.STRIKE && phase !== AnimPhase.RECOVER) {
      // Server is NOT in an attack cycle. A locally predicted attack gets a
      // grace window (input → server → patch round trip); past it, the server
      // rejected the input (cooldown/stagger/death) — cancel the ghost swing.
      if (
        this.inAttackCycle &&
        this.simTick - this.state.phaseStartTick > UNCONFIRMED_ATTACK_GRACE_TICKS
      ) {
        this.state.attackWeaponType = -1;
        this.state.attackType = '';
        setAnimPhase(this.state, AnimPhase.IDLE, this.simTick);
      }
      return;
    }
    if (this.state.phase !== phase) {
      // Adopt the attack context if this client never saw the windup start
      if (this.state.attackWeaponType < 0) {
        const wt = Math.max(0, weaponType);
        this.state.attackWeaponType = wt;
        this.state.attackType = attackType || resolveAttackType(wt);
      }
      // Prefer the server's absolute phase-start tick when available (more
      // accurate than deriving it from ageTicks against a possibly-just-caught-up
      // simTick); fall back to ageTicks for backward compat with callers that
      // don't pass the server tick.
      const startTick =
        serverPhaseStartTick !== undefined && serverPhaseStartTick > 0
          ? serverPhaseStartTick
          : this.simTick - ageTicks;
      setAnimPhase(this.state, phase, startTick);
    } else {
      const localAge = this.simTick - this.state.phaseStartTick;
      const delta = localAge - ageTicks;
      this._lastPhaseAgeDelta = delta;
      if (Math.abs(delta) > PHASE_AGE_DEADBAND_TICKS) {
        this.state.phaseStartTick = this.simTick - ageTicks;
        const mag = Math.abs(delta);
        this._lastCorrectionTicks = mag;
        this._correctionCount++;
        // Snapshot the locally-stepped weapon segment at the drift moment so
        // debug tooling can compare it against the server-implied pose.
        this._correctionGripX = this.cur.grip.x;
        this._correctionGripY = this.cur.grip.y;
        this._correctionTipX = this.cur.tip.x;
        this._correctionTipY = this.cur.tip.y;
        if (mag >= DESYNC_LOG_THRESHOLD_TICKS) {
          logger.warn(
            `[anim] phase-clock drift: ${delta} ticks (weapon=${this.currentWeapon()}) simTick=${this.simTick} serverTick=${serverTick ?? '?'} phaseStart=${this.state.phaseStartTick} serverPhaseStart=${serverPhaseStartTick ?? '?'} ageTicks=${ageTicks}`,
          );
        }
      }
    }
    this.state.comboIndex = comboIndex;
  }

  // ── Reactions (same pure functions the server applies) ──

  applyImpulses(impulses: ArmImpulses): void {
    applyArmImpulses(this.state, impulses);
  }

  /** Victim flinch from a PlayerDamaged event (world knockback vector). */
  applyHitFlinch(kbWorldX: number, kbWorldY: number, facingAngle: number): void {
    const local = worldToLocalVec(facingAngle, kbWorldX, kbWorldY);
    const weightClass = getMotionSpec(this.currentWeapon(), undefined).weightClass;
    applyArmImpulses(this.state, computeHitFlinch(local.x, local.y, weightClass));
  }

  /** Attacker hit-confirm recoil — the weapon "bites" against the swing. */
  applyAttackerRecoil(): void {
    const spec = getMotionSpec(this.currentWeapon(), this.state.attackType || undefined);
    // Swing travels forward in local space — recoil opposes it
    applyArmImpulses(this.state, computeAttackerRecoil(1, 0, spec.reactions));
  }

  // ── Lifecycle ──

  /** Equipped weapon changed (swap/break/throw/pickup) — shared semantics. */
  setWeapon(weaponType: number): void {
    // Blocking cannot survive losing the shield; the server stops the block
    // on slot switch/throw, mirror that here so the BLOCK pose can't stick.
    this.blockHeld = false;
    this.blockConfirmed = false;
    onWeaponChanged(this.state, this.simTick, Math.max(0, weaponType));
  }

  reset(weaponType: number): void {
    this.state = createAnimSimState(Math.max(0, weaponType), this.simTick);
    this.blockHeld = false;
    this.blockConfirmed = false;
    this.hasCur = false;
    this.hasPrev = false;
    this.curStepBodyX = 0;
    this.curStepBodyY = 0;
    this.prevStepBodyX = 0;
    this.prevStepBodyY = 0;
  }

  // ── Stepping ──

  /** Advance the sim on a fixed 1/60 accumulator; dt is render-frame seconds. */
  update(dt: number, input: DriverFrameInput): void {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      this.accumulator -= FIXED_DT;
      this.step(input);
      steps++;
    }
    // Spiral-of-death guard: drop time we can't catch up on
    if (this.accumulator >= FIXED_DT) {
      this.accumulator = this.accumulator % FIXED_DT;
    }
    if (!this.hasCur) this.step(input);
  }

  private step(input: DriverFrameInput): void {
    this.simTick++;
    const tmp = this.prev;
    this.prev = this.cur;
    this.cur = tmp;
    this.stepInput.tick = this.simTick;
    this.stepInput.facingAngle = input.facingAngle;
    this.stepInput.bodyX = input.bodyX;
    this.stepInput.bodyY = input.bodyY;
    this.stepInput.bodyVelX = input.bodyVelX;
    this.stepInput.bodyVelY = input.bodyVelY;
    this.stepInput.isMoving = input.isMoving;
    this.stepInput.blockHeld = this.blockHeld;
    this.stepInput.weaponType = Math.max(0, input.weaponType);
    this.stepInput.isWorldBlocked = input.isWorldBlocked;
    stepAnimation(this.state, this.stepInput, this.cur);
    // Shift body anchors: the old cur's body becomes the new prev's body, and
    // the new cur's body is this step's input. The renderer lerps these by the
    // same factor sample() uses to re-anchor the interpolated pose.
    this.prevStepBodyX = this.curStepBodyX;
    this.prevStepBodyY = this.curStepBodyY;
    this.curStepBodyX = input.bodyX;
    this.curStepBodyY = input.bodyY;
    this.hasPrev = this.hasCur;
    this.hasCur = true;
  }

  /** Interpolated pose for this render frame. */
  sample(): AnimStepResult | null {
    if (!this.hasCur) return null;
    if (!this.hasPrev) return this.cur;
    const t = Math.max(0, Math.min(1, this.accumulator / FIXED_DT));
    lerpResultInto(this.prev, this.cur, t, this.lerpOut);
    return this.lerpOut;
  }

  private currentWeapon(): number {
    return this.state.attackWeaponType >= 0 ? this.state.attackWeaponType : WeaponType.FISTS;
  }
}
