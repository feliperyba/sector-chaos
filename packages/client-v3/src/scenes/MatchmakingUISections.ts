/**
 * MatchmakingUISections — section builders extracted from MatchmakingUI.ts
 * (max-lines cap). Mechanical extraction: statement-identical bodies,
 * `this.tweenTracker` → the `tweenTracker` parameter. Each builder returns
 * the widgets MatchmakingUIRefs needs; local-only decorations stay internal.
 *
 * `createWarTableChrome` moved to `ui/layers/WarTableChrome.ts` (shared with
 * the settings modal) and is re-exported here so MatchmakingUI's import is
 * unchanged.
 */
import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Panel } from '../ui/components/Panel.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';
import { PlayerListWidget } from './PlayerListWidget.js';

export { createWarTableChrome, type WarTableChromeRefs } from '../ui/layers/WarTableChrome.js';

export interface PlayerListSectionRefs {
  playerListPanel: Panel;
  playerListContainer: Phaser.GameObjects.Container;
  playerListWidget: PlayerListWidget;
}

/**
 * The player-list section: §3.1 beveled recessed slot, transparent Panel,
 * pinned container + PlayerListWidget. Bodies verbatim from MatchmakingUI.
 */
export function createPlayerListSection(
  scene: Phaser.Scene,
  tweenTracker: TweenTracker,
  cx: number,
  cy: number,
  panelH: number,
  pad: number,
  innerW: number,
  cursorY: number,
): PlayerListSectionRefs {
  // ------------------------------------------------------------------
  // Player list — §3.1 beveled recessed slot + container + widget
  // ------------------------------------------------------------------

  const listPanelBottom = cy + panelH / 2 - pad;
  const listPanelH = Math.max(200, listPanelBottom - cursorY);
  const listPanelY = cursorY + listPanelH / 2;

  // §3.1 — Beveled recessed slot (doc 23 §2.4/§3.1). Replaces the ticket-16
  // two-Rectangle rim+face with THREE stacked Graphics.fillRoundedRect —
  // outer light edge (brass-tinted 0x4a423a), middle recessed face
  // (surfaceDark 0x222222), inner hairline (0x111111 α0.6). NO blur (Phaser
  // Graphics has no shape-blur — doc 23 §2.4); the bevel is pure edge-color
  // contrast, how real medieval relief reads. Drawn centered at (0,0) on a
  // Graphics positioned at (cx, listPanelY) so the reveal scale tween scales
  // toward the slot center (matches the prior Rectangle origin-0.5 behavior).
  // Entries at sceneUi+2 render on top. Reveal tween mirrors mainPanel.
  const slotW = innerW + DesignTokens.spacing.sm * 2;
  const slotH = listPanelH + DesignTokens.spacing.sm * 2;
  const slotR = 8;
  const listSlot = scene.add.graphics();
  listSlot.setPosition(cx, listPanelY);
  listSlot.setDepth(DesignTokens.depth.sceneUi + 1);
  listSlot.setScrollFactor(0);
  listSlot.fillStyle(0x4a423a, 1); // outer light edge (raised lip).
  listSlot.fillRoundedRect(-slotW / 2, -slotH / 2, slotW, slotH, slotR);
  listSlot.fillStyle(DesignTokens.color.surfaceDark as number, 1); // recessed face.
  listSlot.fillRoundedRect(
    -slotW / 2 + 2,
    -slotH / 2 + 2,
    slotW - 4,
    slotH - 4,
    Math.max(1, slotR - 1),
  );
  listSlot.fillStyle(0x111111, 0.6); // inner hairline (deep groove, pressed read).
  listSlot.fillRoundedRect(
    -slotW / 2 + 4,
    -slotH / 2 + 4,
    slotW - 8,
    slotH - 8,
    Math.max(1, slotR - 2),
  );
  listSlot.setAlpha(0);
  listSlot.setScale(0.85);
  tweenTracker.track(
    scene.tweens.add({
      targets: listSlot,
      alpha: 1,
      scale: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    }),
  );

  const playerListPanel = new Panel(scene, cx, listPanelY, {
    width: innerW,
    height: listPanelH,
    variant: 'transparent',
  });
  playerListPanel.setDepth(DesignTokens.depth.sceneUi + 1);
  playerListPanel.setScrollFactor(0);

  const playerListContainer = scene.add.container(cx, listPanelY);
  playerListContainer.setDepth(DesignTokens.depth.sceneUi + 2);
  // Pin so PlayerListWidget entries (children) stay fixed under parallax drift.
  playerListContainer.setScrollFactor(0);

  const playerListWidget = new PlayerListWidget(
    scene,
    playerListContainer,
    tweenTracker,
    innerW - DesignTokens.spacing.massive,
    listPanelH,
  );

  return { playerListPanel, playerListContainer, playerListWidget };
}
