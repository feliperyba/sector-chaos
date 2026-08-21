import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Label } from '../ui/components/Label.js';

const ICON_SIZE = 18;
const TEXT_GAP = DesignTokens.spacing.sm;

/* ═══════════════════════════════════════════════════════════════════════════
 * PILL FLASH TASTE — OWNER RETUNE LIST (juice-pass-1 ticket 03 stretch).
 * The flash treatment for the power-up pills: an activation punch (gained)
 * and an expiry blink (about to run out). Everything is a named constant.
 * ═══════════════════════════════════════════════════════════════════════════ */
/** Activation punch: icon scale overshoot + settle duration (ms). */
const ACTIVATION_PUNCH_SCALE = 1.45;
const ACTIVATION_PUNCH_MS = 260;
/** Activation flash: white tint hold before restoring the accent tint (ms). */
const ACTIVATION_FLASH_MS = 120;
/** Expiry warning: blink when remaining seconds drop under this. */
const EXPIRY_WARN_SECONDS = 3;
/** Expiry blink frequency (Hz). */
const EXPIRY_BLINK_HZ = 2;
/** Expiry blink dimmest alpha. */
const EXPIRY_BLINK_FLOOR = 0.35;

interface StatusPill {
  icon: Phaser.GameObjects.Sprite;
  label: Label;
  visible: boolean;
  /** Accent tint — restored after the activation white-flash. */
  accentColor: number;
  /** True while the expiry blink is driving alpha (cleared on refresh/hide). */
  blinkActive: boolean;
  /**
   * Last formatted countdown string on the label (perf ticket 21, kill-feed
   * pattern): `remaining.toFixed(1)` changes at most 10×/s while update* is
   * called every frame, and every setText re-rasterizes the canvas texture.
   * NOT reset on hide — Phaser Text retains its string across visibility, so
   * a re-show with an unchanged string skips a redundant re-raster with an
   * identical visual.
   */
  lastText: string;
}

/**
 * StatusPills — icon + countdown text for barrier and speed boost.
 * No backing panels. Pure icon + stroked text for minimal screen footprint.
 * Ticket 03 stretch: activation punch + expiry blink (constants above).
 */
export class PowerUpIndicators {
  private scene: Phaser.Scene;
  private barrierPill!: StatusPill;
  private speedPill!: StatusPill;
  /**
   * Container-visible gate. When false both pills are forced off regardless of
   * their per-pill `visible` flag, and updateBarrier/updateSpeedBoost become
   * no-ops. Used by HUDManager.setSpectating to suppress the dead local
   * player's power-up readout during spectate.
   */
  private containerVisible = true;

  constructor(scene: Phaser.Scene, slotY: number, slotStartX: number, slotGap: number) {
    this.scene = scene;
    this.create(scene, slotY, slotStartX, slotGap);
  }

  /**
   * Set the container-level visibility gate. When hidden, any active pills are
   * forced invisible immediately (no tween — the spectator transition handles
   * the polish) and update* become no-ops until re-enabled.
   */
  setVisible(visible: boolean): void {
    if (this.containerVisible === visible) return;
    this.containerVisible = visible;
    if (!visible) {
      // Force both pills off immediately; reset their internal flags so the
      // next showPill (after re-enable) re-animates from alpha 0. Kill any
      // in-flight punch tween + restore scale so nothing sticks mid-pop.
      for (const pill of [this.barrierPill, this.speedPill]) {
        pill.visible = false;
        pill.blinkActive = false;
        this.scene.tweens.killTweensOf(pill.icon);
        pill.icon.setVisible(false).setAlpha(0).setScale(1);
        pill.label.setVisible(false).setAlpha(0);
      }
    }
  }

  private create(scene: Phaser.Scene, slotY: number, slotStartX: number, slotGap: number): void {
    const pillY = slotY - 64 / 2 - DesignTokens.spacing.huge;
    const slot0X = slotStartX;
    const slot1X = slotStartX + 64 + slotGap;

    this.barrierPill = this.createPill(
      scene,
      slot0X,
      pillY,
      'icon_shield',
      DesignTokens.colors.blue,
    );
    this.speedPill = this.createPill(
      scene,
      slot1X,
      pillY,
      'icon_burst',
      DesignTokens.colors.positive,
    );
  }

  private createPill(
    scene: Phaser.Scene,
    x: number,
    y: number,
    iconFrame: string,
    accentColor: number,
  ): StatusPill {
    const icon = scene.add.sprite(x - 12, y, 'ui', iconFrame);
    icon.setDisplaySize(ICON_SIZE, ICON_SIZE);
    icon.setTint(accentColor);
    icon.setDepth(DesignTokens.depth.hudContent);
    icon.setScrollFactor(0);
    icon.setVisible(false);

    const label = new Label(scene, x + TEXT_GAP, y, {
      text: '',
      variant: 'caption',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    label.setDepth(DesignTokens.depth.hudContent + 1);
    label.setScrollFactor(0);
    label.setVisible(false);
    const lt = label.getAt(0) as Phaser.GameObjects.Text;
    lt.setOrigin(0, 0.5);

    return { icon, label, visible: false, accentColor, blinkActive: false, lastText: '' };
  }

  getEntranceElements(): Phaser.GameObjects.GameObject[] {
    return [
      this.barrierPill.icon,
      this.barrierPill.label,
      this.speedPill.icon,
      this.speedPill.label,
    ];
  }

  private showPill(pill: StatusPill): void {
    // Container gate: when the parent HUD hides us (spectate mode), never show.
    if (!this.containerVisible) return;
    if (pill.visible) return;
    pill.visible = true;
    pill.blinkActive = false;
    pill.icon.setVisible(true);
    pill.label.setVisible(true);
    pill.icon.setAlpha(0);
    pill.label.setAlpha(0);
    pill.icon.setScale(1);

    this.scene.tweens.add({
      targets: [pill.icon, pill.label],
      alpha: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    });

    // Activation punch: scale overshoot + white tint flash — "you got one".
    pill.icon.setScale(ACTIVATION_PUNCH_SCALE);
    pill.icon.setTint(DesignTokens.colors.white);
    this.scene.tweens.add({
      targets: pill.icon,
      scale: 1,
      duration: ACTIVATION_PUNCH_MS,
      ease: DesignTokens.easing.backOut,
    });
    this.scene.time.delayedCall(ACTIVATION_FLASH_MS, () => {
      // Restore the accent tint unless the pill was force-hidden meanwhile
      // (its tint is irrelevant while invisible, but keep it consistent).
      pill.icon.setTint(pill.accentColor);
    });
  }

  private hidePill(pill: StatusPill): void {
    if (!pill.visible) return;
    pill.visible = false;
    pill.blinkActive = false;
    this.scene.tweens.add({
      targets: [pill.icon, pill.label],
      alpha: 0,
      duration: DesignTokens.duration.normal,
      ease: DesignTokens.easing.snappy,
      onComplete: () => {
        pill.icon.setVisible(false);
        pill.label.setVisible(false);
        pill.icon.setTint(pill.accentColor);
      },
    });
  }

  /**
   * Expiry blink: when `remaining` drops under EXPIRY_WARN_SECONDS, pulse the
   * pill's alpha; restore full alpha once (and stop touching it) above the
   * threshold so the entrance tween is never fought.
   */
  private applyExpiryBlink(pill: StatusPill, remaining: number): void {
    if (!pill.visible) return;
    if (remaining > EXPIRY_WARN_SECONDS) {
      if (pill.blinkActive) {
        pill.blinkActive = false;
        pill.icon.setAlpha(1);
        pill.label.setAlpha(1);
      }
      return;
    }
    pill.blinkActive = true;
    const now = performance.now();
    const phase = 0.5 + 0.5 * Math.sin((now * Math.PI * 2 * EXPIRY_BLINK_HZ) / 1000);
    const alpha = EXPIRY_BLINK_FLOOR + (1 - EXPIRY_BLINK_FLOOR) * phase;
    pill.icon.setAlpha(alpha);
    pill.label.setAlpha(alpha);
  }

  updateBarrier(remaining: number, _max: number): void {
    this.showPill(this.barrierPill);
    // Perf ticket 21: setText only when the formatted string changes — the
    // blink/punch visuals below still run every frame.
    const text = `${remaining.toFixed(1)}s`;
    if (text !== this.barrierPill.lastText) {
      this.barrierPill.lastText = text;
      this.barrierPill.label.setText(text);
    }
    this.applyExpiryBlink(this.barrierPill, remaining);
  }

  hideBarrier(): void {
    this.hidePill(this.barrierPill);
  }

  updateSpeedBoost(remaining: number, _max: number): void {
    this.showPill(this.speedPill);
    // Perf ticket 21: setText only when the formatted string changes — the
    // blink/punch visuals below still run every frame.
    const text = `${remaining.toFixed(1)}s`;
    if (text !== this.speedPill.lastText) {
      this.speedPill.lastText = text;
      this.speedPill.label.setText(text);
    }
    this.applyExpiryBlink(this.speedPill, remaining);
  }

  hideSpeedBoost(): void {
    this.hidePill(this.speedPill);
  }

  destroy(): void {
    this.barrierPill.icon.destroy();
    this.barrierPill.label.destroy();
    this.speedPill.icon.destroy();
    this.speedPill.label.destroy();
  }
}
