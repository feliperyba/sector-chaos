/**
 * PlayerAnimationSystem — server-side driver of the shared animation sim.
 *
 * Steps every (alive or dying) player's AnimSimState once per tick as
 * simulation step 2.5 (after movement, before melee resolution) so the swept
 * melee hitbox reads this tick's pose. The client runs the IDENTICAL shared
 * stepAnimation for prediction/remotes; the schema syncs (animPhase,
 * animPhaseStartTick, comboIndex) as the authoritative phase reference.
 */
import {
  AnimPhase,
  WeaponType,
  createAnimSimState,
  createAnimStepResult,
  onWeaponChanged,
  setAnimPhase,
  startAttack,
  startStagger,
  stepAnimation,
  applyArmImpulses,
  type AnimSimState,
  type AnimStepInput,
  type ArmImpulses,
  type TickSegments,
  type Vec2,
} from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { Player } from '../../domain/entities/index.ts';

const MOVE_SPEED_THRESHOLD = 1;

export class PlayerAnimationSystem {
  private states = new Map<string, AnimSimState>();
  private frames = new Map<string, TickSegments>();
  private lastWeapon = new Map<string, number>();

  /**
   * Scratch AnimStepInput reused across every player in stepAll —
   * stepAnimation consumes it strictly synchronously (reads scalar fields,
   * copies them into its own scratch; never retains the object or any
   * reference from it), so one instance serves the whole loop. The
   * loop-invariant fields (tick, isWorldBlocked) are written once per
   * stepAll call; everything else is overwritten per player before the call.
   */
  private stepInput: AnimStepInput = {
    tick: 0,
    facingAngle: 0,
    bodyX: 0,
    bodyY: 0,
    bodyVelX: 0,
    bodyVelY: 0,
    isMoving: false,
    blockHeld: false,
    weaponType: 0,
  };

  constructor(private match: GameMatch) {}

  /** Combat accepted an attack — enter WINDUP this tick (both sides do this). */
  onAttackStarted(playerId: string, weaponType: number, attackType: string): void {
    const player = this.match.getPlayer(playerId);
    if (!player) return;
    const state = this.getOrCreate(playerId, player);
    startAttack(state, this.match.currentTick, weaponType, attackType);
  }

  /** Swing hit a wall or was blocked — STRIKE exits to RECOVER next step. */
  interruptSwing(playerId: string): void {
    const state = this.states.get(playerId);
    if (state) state.swingInterrupted = true;
  }

  /** Apply a deterministic reaction impulse (local aim space). */
  applyImpulses(playerId: string, impulses: ArmImpulses): void {
    const state = this.states.get(playerId);
    if (state) applyArmImpulses(state, impulses);
  }

  getState(playerId: string): AnimSimState | undefined {
    return this.states.get(playerId);
  }

  /** This tick's pose frame (stepped segments) for combat/spawn queries. */
  getFrame(playerId: string): TickSegments | undefined {
    return this.frames.get(playerId);
  }

  /** World position of the weapon-side hand (projectile spawn point). */
  getHandWorld(playerId: string): Vec2 | null {
    const frame = this.frames.get(playerId);
    return frame ? frame.result.rightArm.hand : null;
  }

  /** Simulation step 2.5 — advance every player's pose one tick. */
  stepAll(tick: number): void {
    // Solidity query for pose containment — SAT collider metadata first
    // (same shapes the body collides with), full-tile grid as fallback.
    // The client mirrors this via MapRenderer.isWalkable.
    const grid = this.match.getGrid();
    const collision = this.match.getCollisionService();
    const isWorldBlocked = (x: number, y: number): boolean => collision.isPointBlocked(x, y, grid);

    // Loop-invariant input fields — written once per stepAll call.
    const input = this.stepInput;
    input.tick = tick;
    input.isWorldBlocked = isWorldBlocked;

    for (const [playerId, player] of this.match.getState().players) {
      const dying = player.isDying();
      if (!player.isActive && !dying) {
        // Fully dead/spectating — drop sim state
        if (this.states.has(playerId)) {
          this.states.delete(playerId);
          this.frames.delete(playerId);
          this.lastWeapon.delete(playerId);
        }
        continue;
      }

      const state = this.getOrCreate(playerId, player);

      // Weapon change (swap/break/throw/pickup) — shared reset semantics
      const weaponType = this.activeWeaponType(player);
      const lastWeapon = this.lastWeapon.get(playerId);
      if (lastWeapon !== undefined && lastWeapon !== weaponType) {
        onWeaponChanged(state, tick, weaponType);
      }
      this.lastWeapon.set(playerId, weaponType);

      // Authoritative status overrides (game logic owns these transitions)
      if (dying) {
        if (state.phase !== AnimPhase.DYING) setAnimPhase(state, AnimPhase.DYING, tick);
      } else if (player.isStaggered()) {
        if (state.phase !== AnimPhase.STAGGER) {
          startStagger(state, tick, Math.max(1, player.statusEffects.staggerRemaining));
        }
      } else if (player.movement.isDashing) {
        if (state.phase !== AnimPhase.DASH) setAnimPhase(state, AnimPhase.DASH, tick);
      }

      // Capture prev strike segment BEFORE stepping (sweep pairs prev+cur)
      // Reuse the frame object across ticks to avoid per-tick allocation.
      let frame = this.frames.get(playerId);
      if (!frame) {
        frame = {
          prevGrip: { x: 0, y: 0 },
          prevTip: { x: 0, y: 0 },
          hasPrev: false,
          result: createAnimStepResult(),
        };
      }

      frame.hasPrev = state.hasPrevSegment;
      frame.prevGrip.x = state.prevGrip.x;
      frame.prevGrip.y = state.prevGrip.y;
      frame.prevTip.x = state.prevTip.x;
      frame.prevTip.y = state.prevTip.y;

      // ACTUAL velocity magnitude — NOT player.movement.speed.value. That
      // Speed field is the movement CAP (base speed / dash multiplier /
      // speed-boost scaling), while this is the instantaneous resolved
      // velocity: they differ whenever velocity is below the cap (idle ticks,
      // acceleration/deceleration ramps), so substituting it would flip
      // isMoving for every idle player. Keep the sqrt.
      const speed = Math.sqrt(
        player.movement.velocityX * player.movement.velocityX +
          player.movement.velocityY * player.movement.velocityY,
      );

      input.facingAngle = player.movement.facingAngle;
      input.bodyX = player.movement.position.x;
      input.bodyY = player.movement.position.y;
      input.bodyVelX = player.movement.velocityX;
      input.bodyVelY = player.movement.velocityY;
      input.isMoving = speed > MOVE_SPEED_THRESHOLD;
      input.blockHeld = player.combat.isBlocking;
      input.weaponType = weaponType;

      stepAnimation(state, input, frame.result);

      this.frames.set(playerId, frame);
    }
  }

  cleanupPlayer(playerId: string): void {
    this.states.delete(playerId);
    this.frames.delete(playerId);
    this.lastWeapon.delete(playerId);
  }

  private activeWeaponType(player: Player): number {
    return player.getActiveWeapon()?.type ?? WeaponType.FISTS;
  }

  private getOrCreate(playerId: string, player: Player): AnimSimState {
    let state = this.states.get(playerId);
    if (!state) {
      state = createAnimSimState(this.activeWeaponType(player), this.match.currentTick);
      this.states.set(playerId, state);
    }
    return state;
  }
}
