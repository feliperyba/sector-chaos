import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { UIComponent } from './UIComponent.js';

export interface CheckboxConfig {
  /** Initial checked state (default false). */
  checked?: boolean;
  /** Box edge in px (default 34). */
  size?: number;
  /** Optional trailing label rendered to the right of the box. */
  label?: string;
}

/** Beveled recessed slot rim (§3.1 family — outer raised lip, brass-tinted). */
const SLOT_LIP_COLOR = 0x4a423a;
/** Brass check mark (menuBtnPrimary — same heraldry as corner brackets). */
const CHECK_COLOR = DesignTokens.color.menuBtnPrimary as number;

/**
 * Checkbox — a war-table-styled toggle: the §3.1 beveled recessed slot (three
 * stacked rounded rects) with a brass check mark polyline when ON, plus an
 * optional trailing label (engraved stroke, matchmaking label family).
 *
 * Emits `checkbox.toggle` with the new value on user clicks only —
 * {@link setChecked} applied programmatically is silent by default.
 */
export class Checkbox extends UIComponent {
  private slot!: Phaser.GameObjects.Graphics;
  private check!: Phaser.GameObjects.Graphics;
  private labelText: Phaser.GameObjects.Text | null = null;
  private checked: boolean;
  private readonly size: number;
  private readonly labelWidth: number;

  constructor(scene: Phaser.Scene, x: number, y: number, config: CheckboxConfig = {}) {
    super(scene, x, y);
    this.checked = config.checked ?? false;
    this.size = config.size ?? 34;

    this.slot = scene.add.graphics();
    this.drawSlot();
    this.add(this.slot);

    this.check = scene.add.graphics();
    this.drawCheck();
    this.check.setVisible(this.checked);
    this.add(this.check);

    if (config.label) {
      this.labelText = scene.add.text(this.size / 2 + DesignTokens.spacing.lg, 0, config.label, {
        fontFamily: DesignTokens.font.family,
        fontSize: `${DesignTokens.font.size.lg}px`,
        color: '#d9c79a', // menuSubtitle parchment cream
        stroke: '#2a2520', // engraved — one step darker than the iron face
        strokeThickness: 3,
      });
      this.labelText.setOrigin(0, 0.5);
      this.add(this.labelText);
    }
    this.labelWidth = this.labelText ? this.labelText.width : 0;

    const hitW = this.size + DesignTokens.spacing.lg + this.labelWidth;
    this.setInteractive(
      new Phaser.Geom.Rectangle(-this.size / 2, -this.size / 2, hitW, this.size),
      Phaser.Geom.Rectangle.Contains,
    );
    this.setScrollFactor(0);

    this.on('pointerover', () => {
      if (this.scene.tweens) {
        this.scene.tweens.add({
          targets: this,
          scaleX: 1.05,
          scaleY: 1.05,
          duration: DesignTokens.duration.fast,
          ease: DesignTokens.easing.snappy,
        });
      }
    });
    this.on('pointerout', () => {
      if (this.scene.tweens) {
        this.scene.tweens.add({
          targets: this,
          scaleX: 1,
          scaleY: 1,
          duration: DesignTokens.duration.quick,
          ease: DesignTokens.easing.snappy,
        });
      }
    });
    this.on('pointerdown', () => {
      this.setChecked(!this.checked, false);
      this.emit('checkbox.toggle', this.checked);
    });
  }

  isChecked(): boolean {
    return this.checked;
  }

  /**
   * Set the checked state. Silent by default (no `checkbox.toggle` emit) so
   * callers can initialize/sync without re-triggering their own handler.
   */
  setChecked(checked: boolean, emit = false): void {
    this.checked = checked;
    this.check.setVisible(checked);
    if (emit) {
      this.emit('checkbox.toggle', this.checked);
    }
  }

  /** §3.1 beveled recessed slot — lip / recessed face / inner groove. */
  private drawSlot(): void {
    const s = this.size;
    const r = Math.max(4, Math.round(s * 0.18));
    this.slot.clear();
    this.slot.fillStyle(SLOT_LIP_COLOR, 1);
    this.slot.fillRoundedRect(-s / 2, -s / 2, s, s, r);
    this.slot.fillStyle(DesignTokens.color.surfaceDark as number, 1);
    this.slot.fillRoundedRect(-s / 2 + 2, -s / 2 + 2, s - 4, s - 4, Math.max(1, r - 1));
    this.slot.fillStyle(0x111111, 0.6);
    this.slot.fillRoundedRect(-s / 2 + 4, -s / 2 + 4, s - 8, s - 8, Math.max(1, r - 2));
  }

  /** Brass check mark — thick stroked polyline, scaled to the box. */
  private drawCheck(): void {
    const k = this.size / 34;
    this.check.clear();
    this.check.lineStyle(Math.max(4, 6 * k), CHECK_COLOR, 1);
    this.check.beginPath();
    this.check.moveTo(-9 * k, 1 * k);
    this.check.lineTo(-3 * k, 7 * k);
    this.check.lineTo(10 * k, -7 * k);
    this.check.strokePath();
  }
}
