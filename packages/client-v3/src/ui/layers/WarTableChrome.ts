/**
 * WarTableChrome — the shared "Iron War-Table" panel chrome (ticket 30 / doc
 * 23 §4.1), extracted from MatchmakingUISections so other surfaces (the main
 * menu settings modal) can reuse the exact look: opaque cast-iron backing
 * plate + baked soft shadow + bordered Panel + baked iron face + brass
 * hairline + corner brackets, each revealed with the same smooth/backOut tween.
 *
 * The matchmaking behavior is preserved byte-for-byte (default texture keys,
 * scene-root parenting) — new callers opt into `options.parent` (modal usage)
 * and their own `options.textureKeys` (a second panel at a different size MUST
 * NOT reuse the matchmaking CanvasTexture bakes: they are cached by key and
 * would render at the first-baked size).
 */
import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { Panel } from '../components/Panel.js';
import { TweenTracker } from '../animations/TweenTracker.js';
import {
  IRON_FACE_KEY,
  PANEL_SHADOW_KEY,
  bakeIronFace,
  bakePanelShadow,
  drawCornerBracket,
} from '../../scenes/MatchmakingCanvasBake.js';

export interface WarTableChromeRefs {
  mainPanel: Panel;
}

export interface WarTableChromeOptions {
  /**
   * Unique CanvasTexture keys for the iron-face + panel-shadow bakes. REQUIRED
   * when a second war-table panel coexists with matchmaking's (the bakes cache
   * by key — a shared key renders at the first-baked size).
   */
  textureKeys?: { ironFace: string; panelShadow: string };
  /**
   * Parent container — when set, every chrome element is re-parented into it
   * (Phaser Container.add pulls the object off the scene display list), so the
   * whole chrome can be faded/scaled/destroyed as one unit (modal usage).
   * Build positions are then interpreted in the container's local space — pass
   * cx=0, cy=0 with the container already positioned.
   */
  parent?: Phaser.GameObjects.Container;
}

/**
 * The War-Table panel chrome: backing plate, baked soft shadow, main panel,
 * baked iron face, brass hairline + corner brackets. Everything pinned via
 * `setScrollFactor(0)`; reveal tweens (alpha/scale, smooth/backOut) mirror the
 * original inline blocks verbatim.
 */
export function createWarTableChrome(
  scene: Phaser.Scene,
  tweenTracker: TweenTracker,
  cx: number,
  cy: number,
  panelW: number,
  panelH: number,
  options: WarTableChromeOptions = {},
): WarTableChromeRefs {
  const parent = options.parent;
  const ironFaceKey = options.textureKeys?.ironFace ?? IRON_FACE_KEY;
  const panelShadowKey = options.textureKeys?.panelShadow ?? PANEL_SHADOW_KEY;
  // Re-parent helper — Container.add moves the object off the scene display
  // list, so this is a no-op for the scene-root (matchmaking) path.
  const adopt = (obj: Phaser.GameObjects.GameObject): void => {
    if (parent) parent.add(obj);
  };

  // ------------------------------------------------------------------
  // Backing plate — opaque cast-iron rectangle (ticket 16 blaze suppression)
  // ------------------------------------------------------------------

  // Cast-iron α0.92 (NOT pure black — bounded card per GDD 210). Same depth
  // band as mainPanel, created before it so it renders under the face.
  // Reveal tween mirrors mainPanel exactly (alpha/scale, smooth/backOut).
  const backingPlate = scene.add.rectangle(
    cx,
    cy,
    panelW,
    panelH,
    DesignTokens.color.menuBtnSecondary as number,
  );
  backingPlate.setAlpha(0);
  backingPlate.setScale(0.85);
  backingPlate.setDepth(DesignTokens.depth.sceneUi);
  backingPlate.setOrigin(0.5, 0.5);
  backingPlate.setScrollFactor(0);
  adopt(backingPlate);
  tweenTracker.track(
    scene.tweens.add({
      targets: backingPlate,
      alpha: 0.92,
      scale: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    }),
  );

  const mainPanel = new Panel(scene, cx, cy, {
    width: panelW,
    height: panelH,
    variant: 'bordered',
  });
  mainPanel.setDepth(DesignTokens.depth.sceneUi);
  // Pin to screen so the parallax camera-drift doesn't drag the War Table
  // (mirrors MainMenuScene.titleGroup/buttonContainers pinning).
  mainPanel.setScrollFactor(0);
  adopt(mainPanel);
  // Soft cast shadow behind the WHOLE War-Table panel — the depth cue. Baked
  // ONCE via Canvas2D shadowBlur (a real Gaussian halo, the same render path
  // as CSS box-shadow). The opaque panel hides the dense core; only the soft
  // halo bleeding past every edge is visible. (The earlier `light_01` radial
  // puddle was invisible at any size/alpha: that texture is a LIGHT glow whose
  // energy concentrates in the center, which the opaque panel covers — only a
  // near-zero-alpha tail escaped.) A SIBLING behind the backing plate (depth
  // sceneUi-1), NOT a panel child, so nothing can cover the halo; its own
  // reveal tween mirrors the panel's alpha/scale entrance.
  if (
    bakePanelShadow(scene, panelShadowKey, panelW, panelH, {
      blur: 52,
      offsetY: 28,
      color: 'rgba(20,13,8,0.72)',
    })
  ) {
    const panelShadow = scene.add.image(cx, cy, panelShadowKey);
    panelShadow.setDepth(DesignTokens.depth.sceneUi - 1);
    panelShadow.setOrigin(0.5, 0.5);
    panelShadow.setScrollFactor(0);
    panelShadow.setAlpha(0);
    panelShadow.setScale(0.85);
    adopt(panelShadow);
    tweenTracker.track(
      scene.tweens.add({
        targets: panelShadow,
        alpha: 1,
        scale: 1,
        duration: DesignTokens.duration.smooth,
        ease: DesignTokens.easing.backOut,
      }),
    );
  }
  // `variant: 'bordered'` reads the cast-iron face tint via Panel.VARIANT_TINT
  // (ticket 07 wired menuBtnSecondary 0x3a3530).
  mainPanel.setScale(0.85);
  mainPanel.setAlpha(0);
  tweenTracker.track(
    scene.tweens.add({
      targets: mainPanel,
      alpha: 1,
      scale: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    }),
  );

  // ------------------------------------------------------------------
  // §3.8 — Baked iron face (CanvasTexture: radial gradient + noise α0.08)
  // ------------------------------------------------------------------

  // Replaces the flat grey-rectangle read with a forged-metal face. Sized to
  // sit INSIDE the panel-border NineSlice frame (12px inset). Renders ABOVE
  // the Panel face (depth sceneUi, created after mainPanel), BELOW content.
  // Reveal tween mirrors the backing plate. Best-effort: if Canvas2D is
  // unavailable the flat backing plate above still carries the face.
  const ironFaceInset = 12;
  const ironFaceW = Math.max(64, Math.round(panelW - ironFaceInset * 2));
  const ironFaceH = Math.max(64, Math.round(panelH - ironFaceInset * 2));
  if (bakeIronFace(scene, ironFaceKey, ironFaceW, ironFaceH)) {
    const ironFace = scene.add.image(cx, cy, ironFaceKey);
    ironFace.setDisplaySize(panelW - ironFaceInset * 2, panelH - ironFaceInset * 2);
    ironFace.setAlpha(0);
    ironFace.setScale(0.85);
    ironFace.setDepth(DesignTokens.depth.sceneUi);
    ironFace.setOrigin(0.5, 0.5);
    ironFace.setScrollFactor(0);
    adopt(ironFace);
    tweenTracker.track(
      scene.tweens.add({
        targets: ironFace,
        alpha: 0.92,
        scale: 1,
        duration: DesignTokens.duration.smooth,
        ease: DesignTokens.easing.backOut,
      }),
    );
  }

  // ------------------------------------------------------------------
  // §3.4 — Concentric brass hairline inside the NineSlice border
  // ------------------------------------------------------------------

  // One extra strokeRoundedRect in brass (the thin+thick medieval frame
  // cadence — doc 23 §2.9/§3.4). Drawn centered at (0,0) so the reveal scale
  // tween scales toward the panel center. Zero new art.
  const panelHairline = scene.add.graphics();
  panelHairline.setPosition(cx, cy);
  panelHairline.setDepth(DesignTokens.depth.sceneUi + 1);
  panelHairline.setScrollFactor(0);
  panelHairline.lineStyle(2, DesignTokens.color.menuBtnPrimary as number, 0.6);
  panelHairline.strokeRoundedRect(-panelW / 2 + 6, -panelH / 2 + 6, panelW - 12, panelH - 12, 18);
  panelHairline.setAlpha(0);
  panelHairline.setScale(0.85);
  adopt(panelHairline);
  tweenTracker.track(
    scene.tweens.add({
      targets: panelHairline,
      alpha: 1,
      scale: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    }),
  );

  // ------------------------------------------------------------------
  // §3.5 — Four heraldric corner brackets (Graphics L-polygons, brass)
  // ------------------------------------------------------------------

  // Four brass L-clamps at the panel corners (zero new art — doc 23 §3.5).
  // Drawn centered at (0,0); reveal scale tween matches the panel. Depth
  // sceneUi+3 renders them above content (frame clamps on top of the card).
  const cornerBrackets = scene.add.graphics();
  cornerBrackets.setPosition(cx, cy);
  cornerBrackets.setDepth(DesignTokens.depth.sceneUi + 3);
  cornerBrackets.setScrollFactor(0);
  cornerBrackets.fillStyle(DesignTokens.color.menuBtnPrimary as number, 1);
  const bracketArm = 28;
  const bracketThick = 4;
  const bracketInset = 14;
  const halfW = panelW / 2 - bracketInset;
  const halfH = panelH / 2 - bracketInset;
  drawCornerBracket(cornerBrackets, -halfW, -halfH, bracketArm, bracketThick, 1, 1); // TL
  drawCornerBracket(cornerBrackets, halfW, -halfH, bracketArm, bracketThick, -1, 1); // TR
  drawCornerBracket(cornerBrackets, -halfW, halfH, bracketArm, bracketThick, 1, -1); // BL
  drawCornerBracket(cornerBrackets, halfW, halfH, bracketArm, bracketThick, -1, -1); // BR
  cornerBrackets.setAlpha(0);
  cornerBrackets.setScale(0.85);
  adopt(cornerBrackets);
  tweenTracker.track(
    scene.tweens.add({
      targets: cornerBrackets,
      alpha: 1,
      scale: 1,
      duration: DesignTokens.duration.smooth,
      ease: DesignTokens.easing.backOut,
    }),
  );

  return { mainPanel };
}
