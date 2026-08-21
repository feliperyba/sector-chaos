import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Button } from '../ui/components/Button.js';
import { Label } from '../ui/components/Label.js';
import { Panel } from '../ui/components/Panel.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

// Panel must fit the two side-by-side buttons (2*220 + 24 = 464) plus padding.
const PANEL_WIDTH = 500;
const PANEL_HEIGHT = 220;
const BUTTON_WIDTH = 220;
const BUTTON_HEIGHT = 52;
const BUTTON_GAP = 24;

// ---------------------------------------------------------------------------
// LeaveGameMenu — Pause-style popup to leave the match at any moment (ESC).
//
// Mirrors the DeathScreen/ResultsScreen container-based overlay pattern:
// container at depth.overlay (1100), setScrollFactor(0), hidden until show().
// A single ESC key is owned by GameScene, which routes the press to show()/hide()
// here (priority: leaveMenu > results/death > spectate). The menu does NOT read
// ESC itself — the scene owns the single key and the priority resolution so
// exactly one consumer acts per press.
// ---------------------------------------------------------------------------

export class LeaveGameMenu {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private tracker: TweenTracker;

  private bgOverlay!: Phaser.GameObjects.Rectangle;
  private panel!: Panel;
  private headerLabel!: Label;
  private hintLabel!: Label;
  private leaveButton!: Button;
  private resumeButton!: Button;

  private _visible = false;
  private readonly onLeave: () => void;
  private escKey: Phaser.Input.Keyboard.Key | null = null;

  constructor(scene: Phaser.Scene, onLeave: () => void) {
    this.scene = scene;
    this.onLeave = onLeave;
    this.container = scene.add
      .container(0, 0)
      .setDepth(DesignTokens.depth.overlay)
      .setScrollFactor(0)
      .setVisible(false);
    this.tracker = new TweenTracker(scene);
    if (scene.input.keyboard) {
      this.escKey = scene.input.keyboard.addKey('ESC');
    }
    this.build();
  }

  /**
   * Per-frame ESC router — the single owner of the scene ESC key. Priority:
   *   1. menu already open → hide it (resume)
   *   2. results/death overlay open → let that overlay consume ESC (no-op here)
   *   3. otherwise → open the menu
   * JustDown is true for the whole frame but each branch guards on its own
   * visibility, so exactly one path acts per press.
   */
  handleEsc(resultsOrDeathVisible: boolean): void {
    if (!this.escKey || !Phaser.Input.Keyboard.JustDown(this.escKey)) return;
    if (this._visible) {
      this.hide();
    } else if (!resultsOrDeathVisible) {
      this.show();
    }
  }

  get isVisible(): boolean {
    return this._visible;
  }

  // -----------------------------------------------------------------------
  // Build (once — content is static)
  // -----------------------------------------------------------------------

  private build(): void {
    const { width, height } = this.scene.scale;
    const cx = width / 2;
    const cy = height / 2;

    // --- Dimmed full-screen backdrop (game faintly visible behind) ---
    this.bgOverlay = this.scene.add.rectangle(
      cx,
      cy,
      width,
      height,
      DesignTokens.colors.black,
      DesignTokens.alpha.modalBg,
    );
    this.container.add(this.bgOverlay);

    // --- Centered bordered panel ---
    this.panel = new Panel(this.scene, cx, cy, {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      variant: 'bordered',
    });
    this.panel.setDepth(DesignTokens.depth.overlay + 1);
    this.container.add(this.panel);

    // --- Header: "LEAVE GAME?" ---
    this.headerLabel = new Label(this.scene, cx, cy - 34, {
      text: 'LEAVE GAME?',
      variant: 'title',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    this.headerLabel.setDepth(DesignTokens.depth.overlay + 2);
    const ht = this.headerLabel.getAt(0) as Phaser.GameObjects.Text;
    ht.setOrigin(0.5, 0.5);
    this.container.add(this.headerLabel);

    // --- Hint line ---
    this.hintLabel = new Label(this.scene, cx, cy - 4, {
      text: 'You will disconnect from the match.',
      variant: 'body',
      color: DesignTokens.colors.lighterGray,
      align: 'center',
      stroke: true,
    });
    this.hintLabel.setDepth(DesignTokens.depth.overlay + 2);
    const hintT = this.hintLabel.getAt(0) as Phaser.GameObjects.Text;
    hintT.setOrigin(0.5, 0.5);
    this.container.add(this.hintLabel);

    // --- Buttons side by side ---
    const totalButtonWidth = BUTTON_WIDTH * 2 + BUTTON_GAP;
    const btnStartX = cx - totalButtonWidth / 2 + BUTTON_WIDTH / 2;
    const btnY = cy + 50;

    // "LEAVE GAME" (danger) — left
    this.leaveButton = new Button(this.scene, btnStartX, btnY, {
      label: 'LEAVE GAME',
      variant: 'danger',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    this.leaveButton.setDepth(DesignTokens.depth.overlay + 2);
    this.leaveButton.on('button.click', () => {
      this.hide();
      this.onLeave();
    });
    this.container.add(this.leaveButton);

    // "RESUME" (primary) — right
    this.resumeButton = new Button(this.scene, btnStartX + BUTTON_WIDTH + BUTTON_GAP, btnY, {
      label: 'RESUME',
      variant: 'primary',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    this.resumeButton.setDepth(DesignTokens.depth.overlay + 2);
    this.resumeButton.on('button.click', () => {
      this.hide();
    });
    this.container.add(this.resumeButton);
  }

  // -----------------------------------------------------------------------
  // Show / Hide / Destroy
  // -----------------------------------------------------------------------

  show(): void {
    if (this._visible) return;
    this._visible = true;
    this.container.setAlpha(0);
    this.container.setVisible(true);
    const fadeIn = this.scene.tweens.add({
      targets: this.container,
      alpha: 1,
      duration: DesignTokens.duration.quick,
      ease: DesignTokens.easing.sineOut,
    });
    this.tracker.track(fadeIn);
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    this.container.setVisible(false);
  }

  destroy(): void {
    this.tracker.dispose();
    this.container.removeAll(true);
    this.container.destroy();
  }
}
