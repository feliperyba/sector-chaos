import Phaser from 'phaser';
import { PlayerStatus } from '@sector-battle/shared';
import { DesignTokens } from '../ui/DesignTokens.js';
import { PowerAuraVFX } from './vfx/PowerAuraVFX.js';

interface EffectGroup {
  stagger: Phaser.GameObjects.Arc | null;
  staggerRing: Phaser.GameObjects.Arc | null;
  barrier: Phaser.GameObjects.Arc | null;
  /** Faint inner dome ring — second read of the defensive barrier. */
  barrierInner: Phaser.GameObjects.Arc | null;
  speed: Phaser.GameObjects.Arc | null;
  /** Timestamp when stagger started — drives the activation flash. */
  staggerStartTime: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * AURA RING TASTE — OWNER RETUNE LIST (juice-pass-1 ticket 03).
 * The crisp Arc rings live here; the pooled-sprite shimmer/spin layers live
 * in PowerAuraVFX (which carries its own retune list). Ring numbers only.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Barrier (shield): big, calm, defensive ──
/** Outer defensive ring radius (px). */
const BARRIER_RING_RADIUS = 58;
/** Outer ring stroke width (px). */
const BARRIER_RING_STROKE = 4;
/** Outer ring pulse alpha center + depth (±). */
const BARRIER_RING_ALPHA_BASE = 0.45;
const BARRIER_RING_ALPHA_AMP = 0.15;
/** Outer ring pulse frequency (Hz) — slow = serene/defensive. */
const BARRIER_RING_PULSE_HZ = 2.5;
/** Outer ring radius breathing (± fraction of base scale). */
const BARRIER_RING_BREATH = 0.03;
/** Inner dome ring radius + stroke (px). */
const BARRIER_INNER_RADIUS = 46;
const BARRIER_INNER_STROKE = 2;
/** Inner dome ring alpha center + depth (±), phase-offset from the outer. */
const BARRIER_INNER_ALPHA_BASE = 0.2;
const BARRIER_INNER_ALPHA_AMP = 0.1;

// ── Speed boost: tighter, faster (energetic) ──
/** Ring radius (px) — inside the shield ring for silhouette contrast. */
const SPEED_RING_RADIUS = 50;
/** Ring stroke width (px). */
const SPEED_RING_STROKE = 3;
/** Ring pulse alpha center + depth (±). */
const SPEED_RING_ALPHA_BASE = 0.4;
const SPEED_RING_ALPHA_AMP = 0.15;
/** Ring pulse frequency (Hz) — 2× the shield tempo reads "energized". */
const SPEED_RING_PULSE_HZ = 5;

/** Convert Hz to the sin() angular argument used below. */
const hz = (freq: number, now: number) => (now * Math.PI * 2 * freq) / 1000;

export class StatusEffectRenderer {
  private scene: Phaser.Scene;
  private effects = new Map<string, EffectGroup>();
  /**
   * Pooled-sprite aura layers (shimmer orbit / spin ring / risers / pops).
   * Owns its own SpritePool — see PowerAuraVFX's docblock for why it cannot
   * share EntityRendererVFX's registry-owned pool.
   */
  private aura: PowerAuraVFX;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.aura = new PowerAuraVFX(scene);
  }

  private getOrCreateGroup(key: string): EffectGroup {
    let group = this.effects.get(key);
    if (!group) {
      group = {
        stagger: null,
        staggerRing: null,
        barrier: null,
        barrierInner: null,
        speed: null,
        staggerStartTime: 0,
      };
      this.effects.set(key, group);
    }
    return group;
  }

  updatePlayerStatus(key: string, x: number, y: number, status: number, _delta: number): void {
    const group = this.getOrCreateGroup(key);

    const isAlive = (status & PlayerStatus.ALIVE) !== 0;
    const isStaggered = (status & PlayerStatus.STAGGERED) !== 0;

    if (isAlive && isStaggered) {
      const now = performance.now();

      // Detect stagger activation — flash on first frame
      const wasNull = !group.stagger;
      if (wasNull) {
        group.staggerStartTime = now;
        group.stagger = this.scene.add
          .circle(x, y, 40, DesignTokens.colors.staggerRed, 0.5)
          .setDepth(DesignTokens.depth.statusEffects);
        group.staggerRing = this.scene.add
          .circle(x, y, 48, 0xff3333, 0)
          .setDepth(DesignTokens.depth.statusEffects);
      }

      const sinceStart = now - group.staggerStartTime;
      // Activation flash: bright burst that decays over 250ms
      const flashT = Math.max(0, 1 - sinceStart / 250);
      const flashAlpha = flashT * 0.6;

      // Aggressive 8Hz pulse — high contrast, reads as "stunned/distressed"
      const pulsePhase = Math.sin((now * Math.PI * 2 * 8) / 1000);
      const baseAlpha = 0.35 + 0.25 * pulsePhase;
      const pulseScale = 1.0 + 0.08 * pulsePhase;

      const circle = group.stagger!;
      circle.setPosition(x, y);
      circle.setScale(pulseScale);
      circle.setFillStyle(DesignTokens.colors.staggerRed, baseAlpha + flashAlpha);

      // Expanding ring on activation
      const ring = group.staggerRing!;
      ring.setPosition(x, y);
      if (flashT > 0) {
        const ringR = 40 + (1 - flashT) * 40;
        ring.setRadius(ringR);
        ring.setStrokeStyle(4, 0xff4444, flashT * 0.8);
      } else {
        ring.setStrokeStyle(0, 0xff4444, 0);
      }
    } else {
      if (group.stagger) {
        group.stagger.destroy();
        group.stagger = null;
      }
      if (group.staggerRing) {
        group.staggerRing.destroy();
        group.staggerRing = null;
      }
    }
  }

  updateBarrier(key: string, x: number, y: number, active: boolean): void {
    const group = this.getOrCreateGroup(key);

    if (!active) {
      if (group.barrier) {
        group.barrier.destroy();
        group.barrier = null;
      }
      if (group.barrierInner) {
        group.barrierInner.destroy();
        group.barrierInner = null;
      }
      this.aura.detachBarrier(key);
      return;
    }

    // Activation edge: first create → shimmer on + one-shot pop.
    if (!group.barrier) {
      group.barrier = this.scene.add
        .circle(x, y, BARRIER_RING_RADIUS, DesignTokens.colors.blue, 0)
        .setDepth(DesignTokens.depth.statusEffects);
      group.barrierInner = this.scene.add
        .circle(x, y, BARRIER_INNER_RADIUS, DesignTokens.colors.blue, 0)
        .setDepth(DesignTokens.depth.statusEffects);
      this.aura.attachBarrier(key, x, y);
      this.aura.barrierPop(x, y);
    }

    const now = performance.now();
    const phase = Math.sin(hz(BARRIER_RING_PULSE_HZ, now));
    group.barrier
      .setPosition(x, y)
      .setScale(1 + BARRIER_RING_BREATH * phase)
      .setStrokeStyle(BARRIER_RING_STROKE, DesignTokens.colors.blue, BARRIER_RING_ALPHA_BASE + BARRIER_RING_ALPHA_AMP * phase);
    // Inner dome breathes in counter-phase — the two rings read as one dome.
    group.barrierInner!
      .setPosition(x, y)
      .setStrokeStyle(BARRIER_INNER_STROKE, DesignTokens.colors.blue, BARRIER_INNER_ALPHA_BASE - BARRIER_INNER_ALPHA_AMP * phase);
  }

  updateSpeedBoost(key: string, x: number, y: number, active: boolean): void {
    const group = this.getOrCreateGroup(key);

    if (!active) {
      if (group.speed) {
        group.speed.destroy();
        group.speed = null;
      }
      this.aura.detachSpeed(key);
      return;
    }

    // Activation edge: first create → spin ring + risers on + one-shot pop.
    if (!group.speed) {
      group.speed = this.scene.add
        .circle(x, y, SPEED_RING_RADIUS, DesignTokens.colors.amber, 0)
        .setDepth(DesignTokens.depth.statusEffects);
      this.aura.attachSpeed(key, x, y);
      this.aura.speedPop(x, y);
    }

    const now = performance.now();
    const phase = Math.sin(hz(SPEED_RING_PULSE_HZ, now));
    group.speed
      .setPosition(x, y)
      .setStrokeStyle(SPEED_RING_STROKE, DesignTokens.colors.amber, SPEED_RING_ALPHA_BASE + SPEED_RING_ALPHA_AMP * phase);
  }

  movePlayer(key: string, x: number, y: number): void {
    const group = this.effects.get(key);
    if (!group) return;
    if (group.stagger) group.stagger.setPosition(x, y);
    if (group.staggerRing) group.staggerRing.setPosition(x, y);
    if (group.barrier) group.barrier.setPosition(x, y);
    if (group.barrierInner) group.barrierInner.setPosition(x, y);
    if (group.speed) group.speed.setPosition(x, y);
    // Per-frame aura animation (orbit/spin/rise) rides the position pass so the
    // shimmer keeps moving between state patches.
    this.aura.updateBarrier(key, x, y);
    this.aura.updateSpeed(key, x, y);
  }

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    for (const [key, pos] of positions) {
      this.movePlayer(key, pos.x, pos.y);
    }
  }

  removePlayer(key: string): void {
    this.clearEffects(key);
  }

  destroy(): void {
    for (const key of this.effects.keys()) {
      this.clearEffects(key);
    }
    this.aura.destroy();
  }

  private clearEffects(key: string): void {
    const group = this.effects.get(key);
    if (!group) return;
    if (group.stagger) group.stagger.destroy();
    if (group.staggerRing) group.staggerRing.destroy();
    if (group.barrier) group.barrier.destroy();
    if (group.barrierInner) group.barrierInner.destroy();
    if (group.speed) group.speed.destroy();
    // Auras (pooled sprites) MUST go with the player — the ghost-arms bug class.
    this.aura.removePlayer(key);
    this.effects.delete(key);
  }
}
