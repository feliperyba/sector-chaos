/**
 * SettingsControlsSection — the controls-guide grid for the settings modal:
 * one row per {@link ControlRow}, action label left-aligned, Kenney prompt
 * sprites right-aligned, staggered fade-in reveal. All elements are re-parented
 * into the caller's container (the modal body) — positions passed in that
 * container's local space.
 */
import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { TweenTracker } from '../animations/TweenTracker.js';
import {
  CONTROLS_ATLAS,
  CONTROLS_CAPTION,
  CONTROL_ROW_HEIGHT,
  CONTROL_ROWS,
  PROMPT_GAP,
  PROMPT_SIZE,
} from './SettingsControlsData.js';

/** Engraved label family shared with the matchmaking screen (§3.9). */
const LABEL_COLOR = '#d9c79a'; // menuSubtitle parchment cream
const LABEL_STROKE = '#2a2520'; // one step darker than the iron face

export interface ControlsSectionRefs {
  /** Total height consumed by the grid (rows + caption), for the caller's cursor. */
  height: number;
}

export function createControlsSection(
  scene: Phaser.Scene,
  tweenTracker: TweenTracker,
  parent: Phaser.GameObjects.Container,
  x: number,
  y: number,
  innerW: number,
): ControlsSectionRefs {
  const rowsBottom = y + CONTROL_ROWS.length * CONTROL_ROW_HEIGHT;

  CONTROL_ROWS.forEach((row, i) => {
    const rowY = y + i * CONTROL_ROW_HEIGHT + CONTROL_ROW_HEIGHT / 2;
    const created: Array<Phaser.GameObjects.Image | Phaser.GameObjects.Text> = [];

    // Action label — left-aligned at the section's left edge.
    const label = scene.add.text(x, rowY, row.action, {
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.lg}px`,
      color: LABEL_COLOR,
      stroke: LABEL_STROKE,
      strokeThickness: 3,
    });
    label.setOrigin(0, 0.5);
    parent.add(label);
    created.push(label);

    // Prompt sprites — right-aligned cluster: lay out from the right edge.
    const clusterW = row.frames.length * PROMPT_SIZE + (row.frames.length - 1) * PROMPT_GAP;
    row.frames.forEach((frame, j) => {
      const prompt = scene.add.image(
        x + innerW - clusterW + j * (PROMPT_SIZE + PROMPT_GAP) + PROMPT_SIZE / 2,
        rowY,
        CONTROLS_ATLAS,
        frame,
      );
      prompt.setDisplaySize(PROMPT_SIZE, PROMPT_SIZE);
      parent.add(prompt);
      created.push(prompt);
    });

    // Staggered reveal — same cadence family as the player-list entries.
    created.forEach((t, j) => {
      t.setAlpha(0);
      tweenTracker.track(
        scene.tweens.add({
          targets: t,
          alpha: 1,
          duration: DesignTokens.duration.standard,
          ease: DesignTokens.easing.snappy,
          delay: 240 + i * 70 + j * 40,
        }),
      );
    });
  });

  // Caption — arrow-keys alternative, small + subdued under the last row.
  const caption = scene.add.text(
    x + innerW,
    rowsBottom + DesignTokens.spacing.md,
    CONTROLS_CAPTION,
    {
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.sm}px`,
      color: LABEL_COLOR,
      stroke: LABEL_STROKE,
      strokeThickness: 2,
    },
  );
  caption.setOrigin(1, 0); // right-aligned under the prompt column
  caption.setAlpha(0.75);
  parent.add(caption);

  return {
    height:
      CONTROL_ROWS.length * CONTROL_ROW_HEIGHT +
      DesignTokens.spacing.md +
      DesignTokens.font.size.sm,
  };
}
