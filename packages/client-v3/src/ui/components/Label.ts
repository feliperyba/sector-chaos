import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { UIComponent } from './UIComponent.js';

export type LabelVariant = 'title' | 'subtitle' | 'body' | 'caption' | 'flavor';

export interface LabelConfig {
  text: string;
  variant?: LabelVariant;
  color?: number;
  align?: 'left' | 'center' | 'right';
  wordWrapWidth?: number;
  stroke?: boolean;
}

const VARIANT_STYLE: Record<
  LabelVariant,
  {
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    stroke?: string;
    strokeThickness?: number;
  }
> = {
  title: {
    fontSize: DesignTokens.font.size.xxl,
    fontFamily: DesignTokens.font.family,
    lineHeight: DesignTokens.font.lineHeight.xxl,
    stroke: '#111111',
    strokeThickness: 4,
  },
  subtitle: {
    fontSize: DesignTokens.font.size.xl,
    fontFamily: DesignTokens.font.family,
    lineHeight: DesignTokens.font.lineHeight.xl,
  },
  body: {
    fontSize: DesignTokens.font.size.md,
    fontFamily: DesignTokens.font.family,
    lineHeight: DesignTokens.font.lineHeight.md,
  },
  caption: {
    fontSize: DesignTokens.font.size.sm,
    fontFamily: DesignTokens.font.family,
    lineHeight: DesignTokens.font.lineHeight.sm,
  },
  flavor: {
    fontSize: DesignTokens.font.size.lg,
    fontFamily: DesignTokens.font.flavorFamily,
    lineHeight: DesignTokens.font.lineHeight.lg,
  },
};

/**
 * Label — wraps Phaser Text with DesignTokens font settings.
 * Variants: title, subtitle, body, caption, flavor (handwriting font).
 */
export class Label extends UIComponent {
  private textObject!: Phaser.GameObjects.Text;
  private currentColor: number;

  constructor(scene: Phaser.Scene, x: number, y: number, config: LabelConfig) {
    super(scene, x, y);
    const variant = config.variant ?? 'body';
    const style = VARIANT_STYLE[variant];
    this.currentColor = config.color ?? DesignTokens.color.ink;

    this.textObject = scene.add.text(0, 0, config.text, {
      fontFamily: style.fontFamily,
      fontSize: `${style.fontSize}px`,
      color: `#${this.currentColor.toString(16).padStart(6, '0')}`,
      align: config.align ?? 'left',
      lineSpacing: style.lineHeight - style.fontSize,
      wordWrap: config.wordWrapWidth ? { width: config.wordWrapWidth } : undefined,
      ...(style.stroke
        ? { stroke: style.stroke, strokeThickness: style.strokeThickness ?? 0 }
        : {}),
      ...(config.stroke ? { stroke: '#000000', strokeThickness: 3 } : {}),
    });
    this.textObject.setOrigin(0, 0.5);
    this.add(this.textObject);
  }

  setText(text: string): void {
    this.textObject.setText(text);
  }

  getColor(): number {
    return this.currentColor;
  }

  setColor(color: number): void {
    this.currentColor = color;
    this.textObject.setColor(`#${color.toString(16).padStart(6, '0')}`);
  }
}
