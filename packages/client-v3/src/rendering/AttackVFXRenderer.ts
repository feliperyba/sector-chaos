import Phaser from 'phaser';
import type { AttackVisual } from '../types.js';

/**
 * Handles all attack VFX drawing using Phaser Graphics.
 * Responsible for arc sector polygons, line hitbox rectangles,
 * ranged bow snap animations, thrown projectile trails, and shield pulse rings.
 */
export class AttackVFXRenderer {
  private attacks: AttackVisual[] = [];
  private gfx: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setDepth(20);
  }

  addAttack(visual: AttackVisual): void {
    this.attacks.push(visual);
  }

  drawAttacks(visuals: Map<string, unknown>, now: number): void {
    this.gfx.clear();
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const atk = this.attacks[i]!;
      const elapsed = now - atk.startTime;
      if (elapsed > atk.duration) {
        this.attacks.splice(i, 1);
        continue;
      }
      const t = elapsed / atk.duration;
      const v = visuals.get(atk.playerId);
      if (!v) continue;
      this.drawAttack(atk, atk.fireX, atk.fireY, t);
    }
  }

  destroy(): void {
    this.attacks.length = 0;
    this.gfx.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private drawing methods
  // ---------------------------------------------------------------------------

  private drawAttack(atk: AttackVisual, x: number, y: number, t: number): void {
    const alpha = 1 - t;

    if (atk.type === 'arc' && atk.arcAngle != null) {
      this.drawArcAttack(atk, x, y, t, alpha);
    } else if (atk.type === 'line') {
      this.drawLineAttack(atk, x, y, t, alpha);
    } else if (atk.type === 'ranged') {
      this.drawRangedAttack(atk, x, y, t, alpha);
    } else if (atk.type === 'thrown') {
      this.drawThrownAttack(atk, x, y, t, alpha);
    } else if (atk.type === 'shield') {
      this.drawShieldAttack(t, alpha, x, y);
    }
  }

  private drawArcAttack(atk: AttackVisual, x: number, y: number, t: number, alpha: number): void {
    const halfArc = atk.arcAngle! / 2;
    const outerR = atk.outerRadius;
    const innerR = atk.innerRadius;

    // Impact flash: full sector at t=0, fades quickly
    const flashAlpha = Math.max(0, alpha * (1 - t * 2));
    if (flashAlpha > 0) {
      this.gfx.fillStyle(0xffcc44, flashAlpha * 0.25);
      this.gfx.beginPath();
      // Draw filled sector: inner arc → outer arc
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const a = atk.angle - halfArc + (atk.arcAngle! * i) / steps;
        const px = x + Math.cos(a) * innerR;
        const py = y + Math.sin(a) * innerR;
        if (i === 0) this.gfx.moveTo(px, py);
        else this.gfx.lineTo(px, py);
      }
      for (let i = steps; i >= 0; i--) {
        const a = atk.angle - halfArc + (atk.arcAngle! * i) / steps;
        this.gfx.lineTo(x + Math.cos(a) * outerR, y + Math.sin(a) * outerR);
      }
      this.gfx.closePath();
      this.gfx.fillPath();
    }

    // Sector outline — lingers longer
    const outlineAlpha = alpha * 0.6;
    this.gfx.lineStyle(3, 0xffaa00, outlineAlpha);
    this.gfx.beginPath();
    // Outer arc
    this.gfx.arc(x, y, outerR, atk.angle - halfArc, atk.angle + halfArc, false);
    this.gfx.strokePath();
    // Side lines
    this.gfx.beginPath();
    this.gfx.moveTo(
      x + Math.cos(atk.angle - halfArc) * innerR,
      y + Math.sin(atk.angle - halfArc) * innerR,
    );
    this.gfx.lineTo(
      x + Math.cos(atk.angle - halfArc) * outerR,
      y + Math.sin(atk.angle - halfArc) * outerR,
    );
    this.gfx.moveTo(
      x + Math.cos(atk.angle + halfArc) * innerR,
      y + Math.sin(atk.angle + halfArc) * innerR,
    );
    this.gfx.lineTo(
      x + Math.cos(atk.angle + halfArc) * outerR,
      y + Math.sin(atk.angle + halfArc) * outerR,
    );
    this.gfx.strokePath();

    // Bright tip dot at weapon landing point
    if (t < 0.5) {
      const tipAlpha = (1 - t / 0.5) * alpha;
      this.gfx.fillStyle(0xffcc44, tipAlpha);
      this.gfx.fillCircle(x + Math.cos(atk.angle) * outerR, y + Math.sin(atk.angle) * outerR, 4);
    }
  }

  private drawLineAttack(atk: AttackVisual, x: number, y: number, t: number, alpha: number): void {
    const cosA = Math.cos(atk.angle);
    const sinA = Math.sin(atk.angle);
    const halfW = (atk.lineWidth ?? 20) / 2;
    const startD = atk.innerRadius;
    const endD = atk.outerRadius;

    // Impact flash: full rectangle at t=0
    const flashAlpha = Math.max(0, alpha * (1 - t * 2));
    if (flashAlpha > 0) {
      this.gfx.fillStyle(0xffffff, flashAlpha * 0.2);
      this.gfx.beginPath();
      // 4 corners of the rotated rect
      const perpX = -sinA * halfW;
      const perpY = cosA * halfW;
      this.gfx.moveTo(x + cosA * startD + perpX, y + sinA * startD + perpY);
      this.gfx.lineTo(x + cosA * endD + perpX, y + sinA * endD + perpY);
      this.gfx.lineTo(x + cosA * endD - perpX, y + sinA * endD - perpY);
      this.gfx.lineTo(x + cosA * startD - perpX, y + sinA * startD - perpY);
      this.gfx.closePath();
      this.gfx.fillPath();
    }

    // Center line outline
    const outlineAlpha = alpha * 0.6;
    this.gfx.lineStyle(3, 0xffffff, outlineAlpha);
    this.gfx.beginPath();
    this.gfx.moveTo(x + cosA * startD, y + sinA * startD);
    this.gfx.lineTo(x + cosA * endD, y + sinA * endD);
    this.gfx.strokePath();

    // Side edges (show width)
    this.gfx.lineStyle(2, 0xffffff, outlineAlpha * 0.5);
    const perpX = -sinA * halfW;
    const perpY = cosA * halfW;
    this.gfx.beginPath();
    this.gfx.moveTo(x + cosA * startD + perpX, y + sinA * startD + perpY);
    this.gfx.lineTo(x + cosA * endD + perpX, y + sinA * endD + perpY);
    this.gfx.moveTo(x + cosA * startD - perpX, y + sinA * startD - perpY);
    this.gfx.lineTo(x + cosA * endD - perpX, y + sinA * endD - perpY);
    this.gfx.strokePath();

    // Tip dot
    if (t < 0.5) {
      const tipAlpha = (1 - t / 0.5) * alpha;
      this.gfx.fillStyle(0xffffff, tipAlpha);
      this.gfx.fillCircle(x + cosA * endD, y + sinA * endD, 4);
    }
  }

  private drawRangedAttack(
    atk: AttackVisual,
    x: number,
    y: number,
    t: number,
    alpha: number,
  ): void {
    if (t < 0.4) {
      const snapT = t / 0.4;
      const bowLen = 48;
      const tipX = x + Math.cos(atk.angle) * bowLen * snapT;
      const tipY = y + Math.sin(atk.angle) * bowLen * snapT;
      this.gfx.lineStyle(2, 0xcccccc, alpha * (1 - snapT) * 0.8);
      this.gfx.beginPath();
      this.gfx.moveTo(x, y);
      this.gfx.lineTo(tipX, tipY);
      this.gfx.strokePath();
      if (snapT > 0.3) {
        this.gfx.fillStyle(0xffffff, alpha * 0.6);
        this.gfx.fillCircle(tipX, tipY, 3);
      }
    }
  }

  private drawThrownAttack(
    atk: AttackVisual,
    x: number,
    y: number,
    t: number,
    alpha: number,
  ): void {
    const dist = t * 150;
    const px = x + Math.cos(atk.angle) * dist;
    const py = y + Math.sin(atk.angle) * dist;
    this.gfx.fillStyle(0xff8800, alpha);
    this.gfx.fillCircle(px, py, 5);
    this.gfx.lineStyle(2, 0xff8800, alpha * 0.4);
    this.gfx.beginPath();
    this.gfx.moveTo(px - Math.cos(atk.angle) * 20, py - Math.sin(atk.angle) * 20);
    this.gfx.lineTo(px, py);
    this.gfx.strokePath();
  }

  private drawShieldAttack(t: number, alpha: number, x: number, y: number): void {
    const r = this.lerp(30, 80, this.easeOut(t));
    this.gfx.lineStyle(4, 0x4488ff, alpha * 0.6);
    this.gfx.strokeCircle(x, y, r);
    this.gfx.lineStyle(2, 0x88bbff, alpha * 0.3);
    this.gfx.strokeCircle(x, y, r * 1.3);
  }

  // ---------------------------------------------------------------------------
  // Math helpers (local copies to keep module self-contained)
  // ---------------------------------------------------------------------------

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
  }
}
