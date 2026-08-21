import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Button } from '../ui/components/Button.js';
import { Label } from '../ui/components/Label.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

const BUTTON_WIDTH = 220;
const BUTTON_HEIGHT = 52;
const BUTTON_GAP = 24;

// ---------------------------------------------------------------------------
// DeathScreen — Overlay shown when a player dies, before entering spectator
// ---------------------------------------------------------------------------

export class DeathScreen {
  private scene: Phaser.Scene;
  private myId: string;
  private container: Phaser.GameObjects.Container;
  private tracker: TweenTracker;

  // --- Component references ---
  private bgOverlay: Phaser.GameObjects.Rectangle | null = null;
  private headerLabel: Label | null = null;
  private subtitleLabel: Label | null = null;
  private killsLabel: Label | null = null;
  private timerLabel: Label | null = null;
  private returnButton: Button | null = null;
  private spectateButton: Button | null = null;

  // --- State ---
  private _visible = false;
  private onReturnToTitle: (() => void) | null = null;
  private onSpectate: (() => void) | null = null;
  private escKey: Phaser.Input.Keyboard.Key | null = null;

  constructor(scene: Phaser.Scene, myId: string) {
    this.scene = scene;
    this.myId = myId;
    this.container = scene.add
      .container(0, 0)
      .setDepth(DesignTokens.depth.overlay)
      .setScrollFactor(0)
      .setVisible(false);
    this.tracker = new TweenTracker(scene);
    if (scene.input.keyboard) {
      this.escKey = scene.input.keyboard.addKey('ESC');
    }
  }

  get isVisible(): boolean {
    return this._visible;
  }

  // -----------------------------------------------------------------------
  // Show
  // -----------------------------------------------------------------------

  show(
    aliveCount: number,
    matchTimerMs: number,
    killCount: number,
    onReturnToTitle: () => void,
    onSpectate: () => void,
  ): void {
    this.clear();
    this.onReturnToTitle = onReturnToTitle;
    this.onSpectate = onSpectate;
    this._visible = true;

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const cx = w / 2;
    const cy = h / 2;

    // --- Dark overlay ---
    this.bgOverlay = this.scene.add.rectangle(
      cx,
      cy,
      w,
      h,
      DesignTokens.colors.black,
      DesignTokens.alpha.semiOverlay,
    );
    this.container.add(this.bgOverlay);

    // --- Header: "ELIMINATED" ---
    this.headerLabel = new Label(this.scene, cx, cy - 100, {
      text: 'ELIMINATED',
      variant: 'title',
      color: DesignTokens.colors.gold,
      align: 'center',
    });
    this.headerLabel.setDepth(DesignTokens.depth.overlay + 1);
    const ht = this.headerLabel.getAt(0) as Phaser.GameObjects.Text;
    ht.setOrigin(0.5, 0.5);
    this.container.add(this.headerLabel);

    // --- Entrance animation for header: scale 0 → 1.2 → 1.0 ---
    this.headerLabel.setScale(0);
    const headerTween1 = this.scene.tweens.add({
      targets: this.headerLabel,
      scaleX: { from: 0, to: 1.2 },
      scaleY: { from: 0, to: 1.2 },
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
      onComplete: () => {
        const headerTween2 = this.scene.tweens.add({
          targets: this.headerLabel,
          scaleX: 1,
          scaleY: 1,
          duration: DesignTokens.duration.standard,
          ease: DesignTokens.easing.sineInOut,
        });
        this.tracker.track(headerTween2);
      },
    });
    this.tracker.track(headerTween1);

    // --- Subtitle: "#X remaining" ---
    this.subtitleLabel = new Label(this.scene, cx, cy - 55, {
      text: `#${aliveCount} remaining`,
      variant: 'subtitle',
      color: DesignTokens.colors.lighterGray,
      align: 'center',
      stroke: true,
    });
    this.subtitleLabel.setDepth(DesignTokens.depth.overlay + 1);
    const st = this.subtitleLabel.getAt(0) as Phaser.GameObjects.Text;
    st.setOrigin(0.5, 0.5);
    this.container.add(this.subtitleLabel);

    // --- Kill count ---
    this.killsLabel = new Label(this.scene, cx, cy - 15, {
      text: `Kills: ${killCount}`,
      variant: 'body',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    this.killsLabel.setDepth(DesignTokens.depth.overlay + 1);
    const kt = this.killsLabel.getAt(0) as Phaser.GameObjects.Text;
    kt.setOrigin(0.5, 0.5);
    this.container.add(this.killsLabel);

    // --- Match time ---
    this.timerLabel = new Label(this.scene, cx, cy + 15, {
      text: `Match Time: ${this.formatTime(matchTimerMs)}`,
      variant: 'body',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    this.timerLabel.setDepth(DesignTokens.depth.overlay + 1);
    const tt = this.timerLabel.getAt(0) as Phaser.GameObjects.Text;
    tt.setOrigin(0.5, 0.5);
    this.container.add(this.timerLabel);

    // --- Buttons side by side ---
    const totalButtonWidth = BUTTON_WIDTH * 2 + BUTTON_GAP;
    const btnStartX = cx - totalButtonWidth / 2 + BUTTON_WIDTH / 2;
    const btnY = cy + 80;

    // "RETURN TO TITLE" (danger variant) — left button
    this.returnButton = new Button(this.scene, btnStartX, btnY, {
      label: 'RETURN TO TITLE',
      variant: 'danger',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    this.returnButton.setDepth(DesignTokens.depth.overlay + 2);
    this.returnButton.on('button.click', () => {
      this.dismiss('return');
    });
    this.container.add(this.returnButton);

    // "SPECTATE" (primary variant) — right button
    this.spectateButton = new Button(this.scene, btnStartX + BUTTON_WIDTH + BUTTON_GAP, btnY, {
      label: 'SPECTATE',
      variant: 'primary',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    this.spectateButton.setDepth(DesignTokens.depth.overlay + 2);
    this.spectateButton.on('button.click', () => {
      this.dismiss('spectate');
    });
    this.container.add(this.spectateButton);

    // --- Fade in container ---
    this.container.setAlpha(0);
    this.container.setVisible(true);
    const fadeIn = this.scene.tweens.add({
      targets: this.container,
      alpha: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.sineOut,
    });
    this.tracker.track(fadeIn);
  }

  // -----------------------------------------------------------------------
  // Hide / Update / Destroy
  // -----------------------------------------------------------------------

  hide(): void {
    this._visible = false;
    this.container.setVisible(false);
    this.clear();
  }

  update(_delta: number): void {
    if (!this._visible) return;
    if (this.escKey && Phaser.Input.Keyboard.JustDown(this.escKey)) {
      this.dismiss('spectate');
    }
  }

  destroy(): void {
    this.tracker.dispose();
    this.clear();
    this.container.destroy();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private dismiss(action: 'return' | 'spectate'): void {
    const cb = action === 'return' ? this.onReturnToTitle : this.onSpectate;
    this.hide();
    cb?.();
  }

  private formatTime(seconds: number): string {
    const totalSec = Math.floor(seconds);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  private clear(): void {
    this.container.removeAll(true);
    this.bgOverlay = null;
    this.headerLabel = null;
    this.subtitleLabel = null;
    this.killsLabel = null;
    this.timerLabel = null;
    this.returnButton = null;
    this.spectateButton = null;
    this.onReturnToTitle = null;
    this.onSpectate = null;
  }
}
