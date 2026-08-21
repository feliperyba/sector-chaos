import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Label } from '../ui/components/Label.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

const ENTRY_HEIGHT = 28;
const ENTRY_PADDING = 12;

/** Minimal player info needed by the list widget. */
export interface PlayerListEntry {
  name: string;
  ready: boolean;
  isHost: boolean;
}

/**
 * PlayerListWidget — manages a scrollable list of player entry labels
 * inside a Phaser Container.
 *
 * Dimensions are now provided by the caller for responsive layout.
 */
export class PlayerListWidget {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private tweenTracker: TweenTracker;
  private listWidth: number;
  private listHeight: number;
  private entries: Label[] = [];

  constructor(
    scene: Phaser.Scene,
    container: Phaser.GameObjects.Container,
    tweenTracker: TweenTracker,
    listWidth: number,
    listHeight: number,
  ) {
    this.scene = scene;
    this.container = container;
    this.tweenTracker = tweenTracker;
    this.listWidth = listWidth;
    this.listHeight = listHeight;
  }

  refresh(players: PlayerListEntry[]): void {
    for (const label of this.entries) {
      label.destroy();
    }
    this.entries = [];

    const maxDisplay = Math.max(
      1,
      Math.floor((this.listHeight - ENTRY_PADDING * 2) / ENTRY_HEIGHT),
    );
    const displayCount = Math.min(players.length, maxDisplay);
    const startY = -this.listHeight / 2 + ENTRY_PADDING + DesignTokens.spacing.sm;

    for (let i = 0; i < displayCount; i++) {
      const p = players[i]!;
      const hostTag = p.isHost ? ' [HOST]' : '';
      const readyTag = p.ready ? ' \u2713' : '';
      const entryText = `${p.name}${hostTag}${readyTag}`;

      const entryLabel = new Label(
        this.scene,
        -this.listWidth / 2 + ENTRY_PADDING,
        startY + i * ENTRY_HEIGHT,
        {
          text: entryText,
          variant: 'body',
          color: p.ready
            ? (DesignTokens.colors.positive as number)
            : (DesignTokens.colors.ink as number),
        },
      );
      entryLabel.setDepth(DesignTokens.depth.sceneUi + 2);
      this.container.add(entryLabel);
      this.entries.push(entryLabel);

      entryLabel.setAlpha(0);
      entryLabel.x += 40;
      const staggerDelay = i * 60;
      const entryTween = this.scene.tweens.add({
        targets: entryLabel,
        alpha: 1,
        x: entryLabel.x - 40,
        duration: DesignTokens.duration.standard,
        ease: DesignTokens.easing.snappy,
        delay: staggerDelay,
      });
      this.tweenTracker.track(entryTween);
    }

    if (players.length > maxDisplay) {
      const remaining = players.length - maxDisplay;
      const botLabel = new Label(
        this.scene,
        -this.listWidth / 2 + ENTRY_PADDING,
        startY + displayCount * ENTRY_HEIGHT,
        {
          text: `... + ${remaining} more`,
          variant: 'caption',
          color: DesignTokens.colors.muted as number,
        },
      );
      botLabel.setDepth(DesignTokens.depth.sceneUi + 2);
      this.container.add(botLabel);
      this.entries.push(botLabel);
    }
  }

  destroy(): void {
    for (const label of this.entries) {
      label.destroy();
    }
    this.entries = [];
  }
}
