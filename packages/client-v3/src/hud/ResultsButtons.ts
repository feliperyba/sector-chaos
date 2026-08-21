import type Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Button } from '../ui/components/Button.js';
import type { DeathInfo } from './ResultsScreen.js';

/** Layout constants shared with ResultsScreen. */
export const BUTTON_WIDTH = 220;
export const BUTTON_HEIGHT = 52;
export const BUTTON_GAP = 24;

export interface ButtonsResult {
  returnButton: Button;
  spectateButton: Button | null;
  dismissTimer: Phaser.Time.TimerEvent | null;
}

/**
 * Build the bottom action buttons for the results screen. Mechanical
 * extraction from ResultsScreen.show() — bodies verbatim.
 *
 * - Death mode: "Return to Title" + "Spectate" side by side.
 * - Match-end mode: single centered "Return to Menu" button + 30s auto-dismiss.
 */
export function createResultsButtons(
  scene: Phaser.Scene,
  isDeathMode: boolean,
  deathInfo: DeathInfo | undefined,
  container: Phaser.GameObjects.Container,
  w: number,
  h: number,
  onDismiss: () => void,
  onHide: () => void,
): ButtonsResult {
  if (isDeathMode && deathInfo) {
    const totalButtonWidth = BUTTON_WIDTH * 2 + BUTTON_GAP;
    const btnStartX = w / 2 - totalButtonWidth / 2 + BUTTON_WIDTH / 2;
    const btnY = h / 2 + 280;

    const returnButton = new Button(scene, btnStartX, btnY, {
      label: 'RETURN TO TITLE',
      variant: 'danger',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    returnButton.setDepth(DesignTokens.depth.overlay + 2);
    returnButton.on('button.click', () => {
      deathInfo.onReturnToTitle();
    });
    container.add(returnButton);

    const spectateButton = new Button(scene, btnStartX + BUTTON_WIDTH + BUTTON_GAP, btnY, {
      label: 'SPECTATE',
      variant: 'primary',
      width: BUTTON_WIDTH,
      height: BUTTON_HEIGHT,
    });
    spectateButton.setDepth(DesignTokens.depth.overlay + 2);
    spectateButton.on('button.click', () => {
      onHide();
      deathInfo.onSpectate();
    });
    container.add(spectateButton);

    return { returnButton, spectateButton, dismissTimer: null };
  }

  // Match-end mode: single "RETURN TO MENU" button
  const returnButton = new Button(scene, w / 2, h / 2 + 280, {
    label: 'RETURN TO MENU',
    variant: 'primary',
    width: 240,
    height: 48,
  });
  returnButton.setDepth(DesignTokens.depth.overlay + 2);
  returnButton.on('button.click', () => {
    onDismiss();
  });
  container.add(returnButton);

  // --- Auto-dismiss after 30s ---
  const dismissTimer = scene.time.addEvent({
    delay: 30000,
    callback: () => onDismiss(),
  });

  return { returnButton, spectateButton: null, dismissTimer };
}
