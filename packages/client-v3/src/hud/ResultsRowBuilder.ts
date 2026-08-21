import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Label } from '../ui/components/Label.js';
import type { TweenTracker } from '../ui/animations/TweenTracker.js';

/**
 * Results-table row construction + entrance animations. Mechanical extraction
 * from ResultsScreen.ts — bodies verbatim, pure functions / scene-scoped
 * helpers (no `this`).
 */

export const COL_WIDTHS = [40, 300, 100, 120, 120, 120, 100];
export const TABLE_WIDTH = 900;
export const ROW_HEIGHT = 28;
export const MAX_VISIBLE = 15;

export function createResultsRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  texts: string[],
  bgColor: number,
  bgAlpha: number,
  textColor: number,
): Phaser.GameObjects.Container {
  const row = scene.add.container(x, y);
  row.add(
    scene.add.rectangle(TABLE_WIDTH / 2, ROW_HEIGHT / 2, TABLE_WIDTH, ROW_HEIGHT, bgColor, bgAlpha),
  );
  let cx = 0;
  for (let i = 0; i < texts.length; i++) {
    const colLabel = new Label(scene, cx + DesignTokens.spacing.sm, ROW_HEIGHT / 2, {
      text: texts[i] ?? '',
      variant: 'body',
      color: textColor,
      stroke: true,
    });
    const colText = colLabel.getAt(0) as Phaser.GameObjects.Text;
    colText.setOrigin(0, 0.5);
    row.add(colLabel);
    cx += COL_WIDTHS[i] ?? 0;
  }
  return row;
}

export function formatResultsTime(seconds: number): string {
  const totalSec = Math.floor(seconds);
  return `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
}

/**
 * Pop-in entrance animation: scale 0 → 1.2 (backOut) → 1 (sineInOut). Used for
 * the header / winner / subtitle labels on the results screen.
 *
 * Mechanical extraction from ResultsScreen.show() — bodies verbatim.
 */
export function playPopInAnimation(
  scene: Phaser.Scene,
  tracker: TweenTracker,
  target: Phaser.GameObjects.Text | Phaser.GameObjects.Container,
  getActive: () => boolean,
): void {
  target.setScale(0);
  tracker.track(
    scene.tweens.add({
      targets: target,
      scaleX: { from: 0, to: 1.2 },
      scaleY: { from: 0, to: 1.2 },
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
      onComplete: () => {
        if (!scene || !scene.tweens || !getActive()) return;
        tracker.track(
          scene.tweens.add({
            targets: target,
            scaleX: 1,
            scaleY: 1,
            duration: DesignTokens.duration.standard,
            ease: DesignTokens.easing.sineInOut,
          }),
        );
      },
    }),
  );
}
