import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { UIComponent } from './UIComponent.js';

export type PanelVariant = 'default' | 'bordered' | 'transparent';

export interface PanelConfig {
  width: number;
  height: number;
  variant?: PanelVariant;
}

type NineSliceInset = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

/**
 * Panel frames live in the `ui` multipack atlas. Frame names match the atlas
 * filenames (dash-separated for the border/transparent variants).
 */
const UI_ATLAS = 'ui';
const VARIANT_FRAME: Record<PanelVariant, string> = {
  default: 'panel',
  bordered: 'panel-border',
  transparent: 'panel-transparent',
};

const VARIANT_INSET: Record<PanelVariant, NineSliceInset> = {
  default: DesignTokens.nineSlice.panel,
  bordered: DesignTokens.nineSlice.panelBorder,
  transparent: DesignTokens.nineSlice.panel,
};

/**
 * Face tint per variant (ticket 03 §4 — Panel face had NO setTint today).
 * `default`/`bordered` take the cast-iron face so the surface reads as an
 * "iron field-map" over the lit diorama; `transparent` stays untinted to
 * preserve its translucent quality. Driven by the same `menuBtnSecondary`
 * token as the iron button face for palette coherence.
 */
const VARIANT_TINT: Record<PanelVariant, number | null> = {
  default: DesignTokens.color.menuBtnSecondary as number,
  bordered: DesignTokens.color.menuBtnSecondary as number,
  transparent: null,
};

/**
 * Panel — two-layer NineSlice (shadow + face).
 * Entrance animation: scale 0.8→1 + alpha 0→1 with bounce ease.
 */
export class Panel extends UIComponent {
  private shadow!: Phaser.GameObjects.NineSlice;
  private face!: Phaser.GameObjects.NineSlice;

  constructor(scene: Phaser.Scene, x: number, y: number, config: PanelConfig) {
    super(scene, x, y);
    const variant = config.variant ?? 'default';
    const frame = VARIANT_FRAME[variant];
    const inset = VARIANT_INSET[variant];
    const { width, height } = config;
    const { offset, alpha } = DesignTokens.shadow;

    // Shadow layer
    this.shadow = scene.add.nineslice(
      offset.x,
      offset.y,
      UI_ATLAS,
      frame,
      width,
      height,
      inset.left,
      inset.right,
      inset.top,
      inset.bottom,
    );
    this.shadow.setTint(DesignTokens.shadow.color);
    this.shadow.setAlpha(alpha);
    this.shadow.setOrigin(0.5);
    this.add(this.shadow);

    // Face layer
    this.face = scene.add.nineslice(
      0,
      0,
      UI_ATLAS,
      frame,
      width,
      height,
      inset.left,
      inset.right,
      inset.top,
      inset.bottom,
    );
    this.face.setOrigin(0.5);
    // Ticket 03 §4: tint the face per variant (previously rendered raw atlas
    // pixels). `transparent` is left untinted to keep its translucency.
    const faceTint = VARIANT_TINT[variant];
    if (faceTint !== null) {
      this.face.setTint(faceTint);
    }
    this.add(this.face);
  }

  /** Entrance: scale 0.8→1 + alpha 0→1 with bounce */
  override show(animated = true): void {
    this.setVisible(true);
    if (animated) {
      this.setScale(0.8);
      this.setAlpha(0);
      const tw = this.scene.tweens.add({
        targets: this,
        alpha: 1,
        scale: 1,
        duration: DesignTokens.duration.normal,
        ease: DesignTokens.easing.bounce,
      });
      this.trackTween(tw);
    } else {
      this.setScale(1);
      this.setAlpha(1);
    }
  }

  /** Resize the panel */
  override setSize(width: number, height: number): this {
    this.shadow.setSize(width, height);
    this.face.setSize(width, height);
    return this;
  }
}
