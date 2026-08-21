import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Button } from '../ui/components/Button.js';
import { Label } from '../ui/components/Label.js';
import { Panel } from '../ui/components/Panel.js';

/**
 * ErrorOverlay — modal error overlay with message and OK button.
 * Extracted from MatchmakingScene for SRP.
 */
export class ErrorOverlay {
  private scene: Phaser.Scene;
  private overlay: Phaser.GameObjects.Rectangle | null = null;
  private panel: Panel | null = null;
  private label: Label | null = null;
  private button: Button | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  show(message: string, onDismiss: () => void): void {
    if (this.panel) return; // already showing

    const { width, height } = this.scene.scale;
    const panelW = Math.min(width * 0.32, 540);
    const panelH = Math.min(height * 0.22, 240);
    const wordWrap = panelW - DesignTokens.spacing.massive;

    // Dark overlay background
    this.overlay = this.scene.add.rectangle(
      width / 2,
      height / 2,
      width,
      height,
      DesignTokens.colors.black,
      DesignTokens.alpha.modalBg,
    );
    this.overlay.setDepth(DesignTokens.depth.overlay);
    this.overlay.setScrollFactor(0);

    // Error panel
    this.panel = new Panel(this.scene, width / 2, height / 2, {
      width: panelW,
      height: panelH,
      variant: 'bordered',
    });
    this.panel.setDepth(DesignTokens.depth.overlay + 1);

    // Error label
    this.label = new Label(this.scene, width / 2, height / 2 - DesignTokens.spacing.xl, {
      text: message,
      variant: 'body',
      color: DesignTokens.colors.destructive as number,
      align: 'center',
      wordWrapWidth: wordWrap,
    });
    this.label.setDepth(DesignTokens.depth.overlay + 2);
    const errTextObj = this.label.getAt(0) as Phaser.GameObjects.Text;
    errTextObj.setOrigin(0.5, 0.5);

    // OK button
    const btnW = Math.min(panelW * 0.34, 180);
    this.button = new Button(this.scene, width / 2, height / 2 + panelH * 0.25, {
      label: 'OK',
      variant: 'primary',
      width: btnW,
      height: 48,
      size: 'lg',
    });
    this.button.setDepth(DesignTokens.depth.overlay + 2);
    this.button.on('button.click', () => {
      onDismiss();
    });
  }

  hide(): void {
    if (this.button) {
      this.button.destroy();
      this.button = null;
    }
    if (this.label) {
      this.label.destroy();
      this.label = null;
    }
    if (this.panel) {
      this.panel.destroy();
      this.panel = null;
    }
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
  }

  destroy(): void {
    this.hide();
  }
}
