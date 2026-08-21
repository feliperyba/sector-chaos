import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { UIComponent } from './UIComponent.js';

export interface ProgressBarConfig {
  width: number;
  height?: number;
  fillColor?: number;
  trackColor?: number;
  animated?: boolean;
  gradient?: boolean;
  ghostBar?: boolean;
  flashOnDamage?: boolean;
  lowHealthThreshold?: number;
  segments?: boolean;
  cornerRadius?: number;
}

const GHOST_HOLD_MS = 180;
const GHOST_TWEEN_MS = 500;
const FILL_TWEEN_MS = 80;
const FLASH_THRESHOLD = 0.03;
const FLASH_INITIAL = 0.85;
const FLASH_FADE_MS = 350;
const PULSE_THRESHOLD_DEFAULT = 0.25;

/**
 * ProgressBar — Graphics-drawn rounded bars with ghost trail, flash, pulse, segments.
 *
 * Architecture: setRatio() manages all state + tweens. redraw() is a pure draw
 * function that reads instance vars and renders — it NEVER creates tweens.
 */
export class ProgressBar extends UIComponent {
  private gfx: Phaser.GameObjects.Graphics;
  private _ratio = 0;
  private _displayRatio = 0;
  private ghostRatio = 0;
  private flashAlpha = 0;
  private barWidth: number;
  private barHeight: number;
  private cornerRadius: number;
  private pulseAlpha = 1;
  private isPulsing = false;
  private config: Required<
    Omit<ProgressBarConfig, 'lowHealthThreshold' | 'segments' | 'cornerRadius'>
  > & {
    width: number;
    lowHealthThreshold: number;
    segments: boolean;
    cornerRadius: number;
  };

  constructor(scene: Phaser.Scene, x: number, y: number, config: ProgressBarConfig) {
    super(scene, x, y);
    const h = config.height ?? DesignTokens.spacing.lg;
    this.barWidth = config.width;
    this.barHeight = h;
    this.cornerRadius = config.cornerRadius ?? 4;
    this.config = {
      width: config.width,
      height: h,
      fillColor: config.fillColor ?? DesignTokens.colors.positive,
      trackColor: config.trackColor ?? DesignTokens.colors.nearBlack,
      animated: config.animated ?? true,
      gradient: config.gradient ?? false,
      ghostBar: config.ghostBar ?? false,
      flashOnDamage: config.flashOnDamage ?? false,
      lowHealthThreshold: config.lowHealthThreshold ?? 0,
      segments: config.segments ?? false,
      cornerRadius: this.cornerRadius,
    };

    this.gfx = scene.add.graphics();
    this.gfx.setScrollFactor(0);
    this.add(this.gfx);
  }

  setRatio(ratio: number, animated?: boolean): void {
    const clamped = Phaser.Math.Clamp(ratio, 0, 1);
    const prevRatio = this._displayRatio;
    const dropped = clamped < prevRatio - 0.001;
    this._ratio = clamped;

    // --- Ghost bar: hold at old position, then tween down ---
    if (this.config.ghostBar && dropped) {
      this.ghostRatio = prevRatio;

      const ghostProxy = { v: prevRatio };
      this.scene.tweens.add({
        targets: ghostProxy,
        v: clamped,
        delay: GHOST_HOLD_MS,
        duration: GHOST_TWEEN_MS,
        ease: 'Cubic.easeOut',
        onUpdate: () => {
          this.ghostRatio = ghostProxy.v;
          this.redraw();
        },
        onComplete: () => {
          this.ghostRatio = clamped;
          this.redraw();
        },
      });
    } else if (this.config.ghostBar) {
      this.ghostRatio = clamped;
    }

    // --- Flash on damage ---
    if (this.config.flashOnDamage && dropped && prevRatio - clamped > FLASH_THRESHOLD) {
      this.flashAlpha = FLASH_INITIAL;

      const flashProxy = { a: FLASH_INITIAL };
      this.scene.tweens.add({
        targets: flashProxy,
        a: 0,
        duration: FLASH_FADE_MS,
        ease: 'Sine.easeOut',
        onUpdate: () => {
          this.flashAlpha = flashProxy.a;
          this.redraw();
        },
      });
    }

    // --- Low-health pulse ---
    this.updatePulse(clamped);

    // --- Fill animation ---
    const shouldAnimate = animated ?? this.config.animated;
    if (shouldAnimate) {
      const fillProxy = { v: prevRatio };
      this.scene.tweens.add({
        targets: fillProxy,
        v: clamped,
        duration: FILL_TWEEN_MS,
        ease: 'Quad.easeOut',
        onUpdate: () => {
          this._displayRatio = fillProxy.v;
          this.redraw();
        },
        onComplete: () => {
          this._displayRatio = clamped;
          this.redraw();
        },
      });
    } else {
      this._displayRatio = clamped;
    }

    this.redraw();
  }

  get ratio(): number {
    return this._ratio;
  }

  /** Pure draw — reads instance vars, renders. NEVER creates tweens. */
  private redraw(): void {
    const w = this.barWidth;
    const h = this.barHeight;
    const r = Math.min(this.cornerRadius, h / 2);
    const fillW = this._displayRatio * w;
    const ghostW = this.ghostRatio * w;
    const y = -h / 2;

    this.gfx.clear();

    // Track
    this.gfx.fillStyle(this.config.trackColor, 0.85);
    this.gfx.fillRoundedRect(0, y, w, h, r);

    // Ghost trail (only visible when ghost is ahead of fill)
    if (this.config.ghostBar && this.ghostRatio > this._displayRatio + 0.001) {
      this.gfx.fillStyle(0xffffff, 0.5);
      this.gfx.fillRoundedRect(0, y, ghostW, h, r);
      this.gfx.fillStyle(0xff6666, 0.4);
      this.gfx.fillRect(Math.max(0, ghostW - 3), y, 3, h);
    }

    // Fill
    if (fillW > 0.5) {
      const fillColor = this.config.gradient
        ? this.gradientColor(this._displayRatio)
        : this.config.fillColor;
      this.gfx.fillStyle(fillColor, this.pulseAlpha);
      this.gfx.fillRoundedRect(0, y, fillW, h, r);
    }

    // Flash overlay
    if (this.flashAlpha > 0.01) {
      this.gfx.fillStyle(0xffffff, this.flashAlpha);
      this.gfx.fillRoundedRect(0, y, fillW, h, r);
    }

    // Segment ticks
    if (this.config.segments) {
      this.gfx.lineStyle(1, 0x000000, 0.25);
      for (let i = 1; i < 4; i++) {
        const sx = (i / 4) * w;
        this.gfx.lineBetween(sx, y + 1, sx, y + h - 1);
      }
    }

    // Border
    this.gfx.lineStyle(2, 0x333344, 0.9);
    this.gfx.strokeRoundedRect(0, y, w, h, r);
  }

  private updatePulse(ratio: number): void {
    const threshold = this.config.lowHealthThreshold || PULSE_THRESHOLD_DEFAULT;
    const shouldPulse = this.config.lowHealthThreshold > 0 && ratio < threshold && ratio > 0;

    if (shouldPulse && !this.isPulsing) {
      this.isPulsing = true;
      const pulseProxy = { a: 1 };
      this.scene.tweens.add({
        targets: pulseProxy,
        a: 0.5,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        onUpdate: () => {
          this.pulseAlpha = pulseProxy.a;
          this.redraw();
        },
      });
    } else if (!shouldPulse && this.isPulsing) {
      this.isPulsing = false;
      this.pulseAlpha = 1;
    }
  }

  private gradientColor(r: number): number {
    const red = r < 0.5 ? 0xff : Math.round(0xff * (1 - (r - 0.5) * 2));
    const green = r < 0.5 ? Math.round(0xff * r * 2) : 0xff;
    return (red << 16) | (green << 8);
  }
}
