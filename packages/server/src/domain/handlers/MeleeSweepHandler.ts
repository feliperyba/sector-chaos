/* eslint-disable max-lines -- swing resolution pipeline: sweep→detect→resolve is one atomic chain */
/**
 * MeleeSweepHandler — "animation IS the hitbox" melee resolution.
 *
 * For each active swing, every tick of the strike's live window the attacker's
 * simulated weapon segment (grip→tip from PlayerAnimationSystem) is swept from
 * its previous-tick position to its current one (4 interpolated sub-segments —
 * at ≤ ~240 px/tick tip speed vs 40 px hurtbox radius this cannot tunnel) and
 * tested against:
 *
 *   1. WALLS first — DDA raycast along the blade; a blocking tile interrupts
 *      the swing (WeaponWallHit event + recoil impulse). Wall occlusion is
 *      emergent: the blade physically cannot pass a wall.
 *   2. PLAYER hurtboxes — routed through DamagePipeline at the CONTACT tick,
 *      with sourcePosition = blade contact point, which makes the shield
 *      block arc and knockback direction contact-accurate for free.
 *   3. DESTRUCTIBLES — batched to DestructibleDamageHandler.
 *
 * Each entity is hit at most once per swing (hitSet); strike keyframes flagged
 * `clearsHitSet` re-arm multi-hit weapons (Double Axe return sweep).
 *
 * Cooldown anchoring (lastAttackTick / weapon cooldown) stays at windup
 * completion exactly as the legacy instant path — attack cadence unchanged;
 * only WHERE and WHEN damage lands moves onto the simulated blade.
 *
 * NOTE: `match` / `animationSystem` / `destructibleHandler` are intentionally
 * public so the helper modules MeleeSweepGeometry.ts (pure geometry) and
 * MeleeSweepContact.ts (player/wall contact resolution) — extracted from the
 * original monolithic class — can read them.
 */
import {
  AnimPhase,
  AttackType,
  getMotionSpec,
  type HurtboxEntity,
  type Vec2,
  type WeaponMotionSpec,
} from '@sector-battle/shared';
import type { GameMatch } from '../aggregates/GameMatch.ts';
import type { Player, WeaponEntity } from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';
import type { PlayerAnimationPort, DestructibleDamagePort } from './MeleeSweepPorts.ts';
import { gatherHurtboxEntities } from './HurtboxGathering.ts';
import { sweepContact, sweepContactDestructible } from './MeleeSweepGeometry.ts';
import { resolvePlayerContact, onWallHit } from './MeleeSweepContact.ts';

export interface SwingState {
  playerId: string;
  weapon: WeaponEntity;
  weaponSlot: number;
  attackType: AttackType;
  damage: number;
  knockback: number;
  range: number;
  spec: WeaponMotionSpec;
  startTick: number;
  hitSet: Set<string>;
  /** clearsHitSet keyframe progresses already applied this swing. */
  clearedAt: Set<number>;
  lastProgress: number;
  /** Wall-impact feedback (event + recoil) already fired this swing. */
  wallFeedbackDone: boolean;
}

export class MeleeSweepHandler {
  swings = new Map<string, SwingState>();

  constructor(
    readonly match: GameMatch,
    readonly animationSystem: PlayerAnimationPort,
    readonly destructibleHandler: DestructibleDamagePort,
  ) {}

  /**
   * Begin a swing at windup completion. The strike phase itself is advanced
   * by the shared animation sim; this just registers the combat payload.
   */
  startSwing(
    player: Player,
    weapon: WeaponEntity,
    weaponSlot: number,
    attackType: AttackType,
    damage: number,
    knockback: number,
    range: number,
  ): void {
    this.swings.set(player.id, {
      playerId: player.id,
      weapon,
      weaponSlot,
      attackType,
      damage,
      knockback,
      range,
      spec: getMotionSpec(weapon.type, attackType),
      startTick: this.match.currentTick,
      hitSet: new Set(),
      clearedAt: new Set(),
      lastProgress: 0,
      wallFeedbackDone: false,
    });
  }

  hasActiveSwing(playerId: string): boolean {
    return this.swings.has(playerId);
  }

  /** Called once per simulation tick (step 3), after the animation step. */
  tick(tick: number): void {
    if (this.swings.size === 0) return;

    const finished: string[] = [];
    for (const swing of this.swings.values()) {
      if (!this.processSwing(swing, tick)) {
        finished.push(swing.playerId);
      }
    }
    for (const id of finished) {
      this.swings.delete(id);
    }
  }

  cleanupPlayer(playerId: string): void {
    this.swings.delete(playerId);
  }

  /** Returns false when the swing is over and should be removed. */
  private processSwing(swing: SwingState, tick: number): boolean {
    const player = this.match.getPlayer(swing.playerId);
    if (!player || !player.isActive) return false;

    const animState = this.animationSystem.getState(swing.playerId);
    const frame = this.animationSystem.getFrame(swing.playerId);
    if (!animState || !frame) return false;

    // Swing lives only while the sim is in STRIKE. Give the anim one tick of
    // grace to enter STRIKE (windup completes at step 8, anim advances at the
    // next tick's step 2.5).
    if (animState.phase !== AnimPhase.STRIKE) {
      return tick - swing.startTick <= 1;
    }

    const strikeTicks = Math.max(1, swing.spec.strike.ticks);
    const progress = Math.min(1, (tick - animState.phaseStartTick) / strikeTicks);

    // Multi-hit: clear the hit set when crossing a clearsHitSet keyframe
    for (const kf of swing.spec.strike.keyframes) {
      if (!kf.clearsHitSet || swing.clearedAt.has(kf.progress)) continue;
      if (swing.lastProgress < kf.progress && progress >= kf.progress) {
        swing.hitSet.clear();
        swing.clearedAt.add(kf.progress);
      }
    }
    swing.lastProgress = progress;

    const { activeFrom, activeTo } = swing.spec.strike;
    if (progress < activeFrom) return true;
    if (progress > activeTo) return false;

    const grip = frame.result.grip;
    const tip = frame.result.tip;

    // ── 1. Sweep prev→cur segments against hit/hurt boxes FIRST.
    // The blade is already wall-clamped by the sim, so anything the segment
    // touches is legitimately reachable — no occlusion test needed.
    const candidates = gatherHurtboxEntities(this.match, player, swing.range);

    const prevGrip = frame.hasPrev ? frame.prevGrip : grip;
    const prevTip = frame.hasPrev ? frame.prevTip : tip;

    const hitPlayers: { entity: HurtboxEntity; contact: Vec2 }[] = [];
    const hitDestructibles: string[] = [];

    for (const entity of candidates.entities) {
      if (swing.hitSet.has(entity.id)) continue;

      let contact: Vec2 | null;
      if (
        entity.kind === 'destructible' &&
        entity.gridX !== undefined &&
        entity.gridY !== undefined
      ) {
        contact = sweepContactDestructible(
          prevGrip,
          prevTip,
          grip,
          tip,
          entity.gridX,
          entity.gridY,
          swing.spec.bladeRadius,
          this.match.getCollisionService(),
        );
        // Map-polish ticket 07: NON-SOLID destructibles (light-prop
        // fixtures) sit on EMPTY tiles with NO enriched tile collider — the
        // tile-collider test above can never fire for them. Fall back to the
        // entity hurtbox, the exact box the arc/line melee paths and the
        // thrown/arrow entity scans already use, so a blade smashes the
        // fixture. Solid destructibles never set `nonSolid`; their contact
        // geometry is unchanged.
        if (!contact && entity.nonSolid) {
          contact = sweepContact(
            prevGrip,
            prevTip,
            grip,
            tip,
            entity.hurtbox,
            swing.spec.bladeRadius,
          );
        }
      } else {
        contact = sweepContact(
          prevGrip,
          prevTip,
          grip,
          tip,
          entity.hurtbox,
          swing.spec.bladeRadius,
        );
      }
      if (!contact) continue;

      swing.hitSet.add(entity.id);
      if (entity.kind === 'player') {
        hitPlayers.push({ entity, contact });
      } else {
        hitDestructibles.push(entity.id);
      }
    }

    let interrupted = false;

    for (const { entity, contact } of hitPlayers) {
      const blocked = resolvePlayerContact(
        this,
        swing,
        player,
        entity.id,
        contact,
        tip,
        prevTip,
        tick,
      );
      this.consumeDurability(swing, player);
      if (swing.weapon.isBroken) {
        interrupted = true;
        break;
      }
      if (blocked) {
        // Heavy clash — the swing stops on the guard
        interrupted = true;
        break;
      }
    }

    if (!interrupted && hitDestructibles.length > 0) {
      const events: GameEvent[] = [];
      this.destructibleHandler.handleDamage(
        hitDestructibles,
        this.match,
        events,
        swing.weapon.type,
      );
      // GDD §6.2.3: durability is consumed ONLY for entities (player, crate,
      // barrel, chest). Walls cost 0 durability — hitting a wall or empty
      // space is free. Skip wall-type destructibles when charging durability.
      for (const destId of hitDestructibles) {
        const d = this.match.getState().destructibles.get(destId);
        if (d && d.type === 'wall') continue;
        this.consumeDurability(swing, player);
        if (swing.weapon.isBroken) {
          interrupted = true;
          break;
        }
      }
    }

    // ── 2. Wall contact from the sim. The blade is already physically
    // clamped (it cannot pass walls), so walls NEVER cancel the swing —
    // arena combat happens beside walls constantly. A destructible tile in
    // the blade's path takes damage; deep solid contact fires ONE impact
    // feedback (WeaponWallHit event + recoil) per swing.
    if (!interrupted && frame.result.wallContact) {
      const gridX = Math.floor(frame.result.wallContactX / this.match.tileWidth);
      const gridY = Math.floor(frame.result.wallContactY / this.match.tileWidth);

      const destructibleId = this.findDestructibleAt(gridX, gridY);
      if (destructibleId && !swing.hitSet.has(destructibleId)) {
        swing.hitSet.add(destructibleId);
        const events: GameEvent[] = [];
        this.destructibleHandler.handleDamage(
          [destructibleId],
          this.match,
          events,
          swing.weapon.type,
        );
        // GDD §6.2.3: walls cost 0 durability. Only charge if not a wall.
        const wallDest = this.match.getState().destructibles.get(destructibleId);
        if (!wallDest || wallDest.type !== 'wall') {
          this.consumeDurability(swing, player);
          if (swing.weapon.isBroken) interrupted = true;
        }
      }

      const impactThreshold = Math.max(20, swing.spec.bladeLength * 0.35);
      if (
        !interrupted &&
        !swing.wallFeedbackDone &&
        !destructibleId &&
        frame.result.wallPenetration >= impactThreshold
      ) {
        swing.wallFeedbackDone = true;
        onWallHit(
          this,
          swing,
          player,
          {
            x: frame.result.wallContactX,
            y: frame.result.wallContactY,
            gridX,
            gridY,
          },
          grip,
          tip,
          frame.hasPrev ? frame.prevTip : null,
          tick,
        );
      }
    }

    if (interrupted) {
      this.animationSystem.interruptSwing(swing.playerId);
      return false;
    }

    return true;
  }

  /** Active destructible occupying the given grid cell, if any. */
  private findDestructibleAt(gridX: number, gridY: number): string | null {
    const tileSize = this.match.tileWidth;
    for (const [id, d] of this.match.getState().destructibles) {
      if (!d.isActive) continue;
      if (
        Math.floor(d.position.x / tileSize) === gridX &&
        Math.floor(d.position.y / tileSize) === gridY
      ) {
        return id;
      }
    }
    return null;
  }

  private consumeDurability(swing: SwingState, player: Player): void {
    swing.weapon.consumeDurability(1);
    if (swing.weapon.isBroken) {
      this.match.handleWeaponBreak(player.id, swing.weaponSlot);
    }
  }
}
