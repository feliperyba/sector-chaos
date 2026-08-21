import { UIComponent } from './UIComponent.js';

export interface IconConfig {
  /** Multipack atlas texture key, e.g. `'ui'` or `'game'`. */
  textureKey: string;
  /** Frame name within the atlas (e.g. `'icon_shield'`, `'weapon_sword'`). */
  frame?: string;
  tint?: number;
  size?: number;
}

/**
 * Icon — simple sprite wrapper from game-assets icons.
 * Used in inventory slots, kill feed, power-up indicators.
 */
export class Icon extends UIComponent {
  private sprite!: Phaser.GameObjects.Sprite;
  private currentSize: number;

  constructor(scene: Phaser.Scene, x: number, y: number, config: IconConfig) {
    super(scene, x, y);
    this.currentSize = config.size ?? 32;

    this.sprite = scene.add.sprite(0, 0, config.textureKey, config.frame);
    this.sprite.setDisplaySize(this.currentSize, this.currentSize);
    this.sprite.setOrigin(0.5);
    this.add(this.sprite);

    if (config.tint !== undefined) {
      this.sprite.setTint(config.tint);
    }
  }

  setTexture(textureKey: string, frame?: string): void {
    this.sprite.setTexture(textureKey, frame);
  }

  setTint(tint: number): void {
    this.sprite.setTint(tint);
  }

  setIconSize(size: number): void {
    this.currentSize = size;
    this.sprite.setDisplaySize(size, size);
  }
}
