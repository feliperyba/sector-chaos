import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Button } from '../ui/components/Button.js';
import { Label } from '../ui/components/Label.js';
import { Panel } from '../ui/components/Panel.js';
import { ProgressBar } from '../ui/components/ProgressBar.js';
import { MenuBackground } from '../ui/layers/MenuBackground.js';
import { createSoftShadowPuddle, createStackedShadow } from '../ui/SoftShadow.js';
import { TweenTracker } from '../ui/animations/TweenTracker.js';
import { PlayerListWidget } from './PlayerListWidget.js';
// Ticket 30 — local CanvasTexture bake helpers (the one-off helper the ticket
// authorizes: "scope = MatchmakingUI.ts (+ any one-off CanvasTexture helper,
// kept local)"). doc 23 §2.2/§2.3 — Canvas 2D is the bridge for gradient
// techniques Phaser Graphics can't express natively.
import { TITLE_GOLD_KEY, bakeGoldTitle } from './MatchmakingCanvasBake.js';
import { createWarTableChrome, createPlayerListSection } from './MatchmakingUISections.js';

// ---------------------------------------------------------------------------
// Responsive Layout Fractions
// ---------------------------------------------------------------------------

const PANEL_W_FRAC = 0.56;
const PANEL_H_FRAC = 0.74;
const PANEL_W_MAX = 920;
const PANEL_H_MAX = 760;
const PANEL_W_MIN = 680;

const FILL_BAR_H = 14;
const COUNTDOWN_BAR_H = 12;

/** References to all created UI widgets, returned from create(). */
export interface MatchmakingUIRefs {
  menuBackground: MenuBackground;
  mainPanel: Panel;
  playerListPanel: Panel;
  playerListContainer: Phaser.GameObjects.Container;
  titleLabel: Label;
  subtitleLabel: Label;
  statusLabel: Label;
  playerCountLabel: Label;
  fillBar: ProgressBar;
  countdownLabel: Label;
  countdownBar: ProgressBar;
  leaveButton: Button;
  playerListWidget: PlayerListWidget;
}

/** Re-center a Label's inner Text to origin (0.5, 0.5) for centered layout. */
function centerLabel(label: Label): void {
  const text = label.getAt(0) as Phaser.GameObjects.Text;
  text.setOrigin(0.5, 0.5);
}

/**
 * MatchmakingUI — constructs the full Phaser UI layout for the matchmaking
 * screen using the "Iron War-Table Refined" design (ticket 30 / doc 23 §4.1).
 *
 * Same widget inventory + flow as the prior ticket-16 screen — this redesigns
 * the LOOK, not the data/flow. The 8 doc-23 leverage techniques (all
 * Phaser-convertible — no backdrop-filter/border-image/web-font/shape-blur/
 * conic-gradient) are applied:
 *   1. §3.8 baked iron face       — CanvasTexture (radial gradient + noise α0.08)
 *   2. §3.1 beveled recessed slot — 3 stacked Graphics.fillRoundedRect
 *   3. §3.2 brushed-gold title    — CanvasTexture destination-in mask
 *   4. §3.3 two-tone countdown    — 2 stacked Phaser Texts (base + overlay)
 *   5. §3.4 concentric brass hairline — Graphics.strokeRoundedRect
 *   6. §3.5 four corner brackets  — 4 Graphics.fillPoints L-polygons
 *   7. §3.6 ember-glow molten tip — Graphics + tween (tracks fillBar leading edge)
 *   8. §3.9 engraved label depth  — Text stroke tuned 1 step off the face
 *
 * All UI elements are pinned via `setScrollFactor(0)` so the MenuBackground
 * parallax camera-drift doesn't drag the War Table. Reveal animations (panel
 * scale-in `backOut`, divider wipe `expoOut`, button slide-up, player-list
 * staggered fade) are preserved in timing — only the visual tokens they drive
 * change.
 */
export class MatchmakingUI {
  private scene: Phaser.Scene;
  private tweenTracker: TweenTracker;

  constructor(scene: Phaser.Scene, tweenTracker: TweenTracker) {
    this.scene = scene;
    this.tweenTracker = tweenTracker;
  }

  create(): MatchmakingUIRefs {
    const scene = this.scene;
    const { width, height } = scene.scale;
    const cx = width / 2;
    const cy = height / 2;

    // ------------------------------------------------------------------
    // Background — the shared lit medieval diorama (ticket 06 MenuBackground)
    // ------------------------------------------------------------------

    // Same diorama + parallax + atmosphere as the main menu (ticket 08).
    // `variant: 'matchmaking'` is the parameterization hook; today it produces
    // the exact same 3 baked RTs + LightingPipeline + fire/aura/atmosphere.
    // Lifecycle: MatchmakingScene.update() drives menuBackground.update per
    // frame; shutdown() calls destroy() — mirrors MainMenuScene (06).
    const menuBackground = new MenuBackground({ variant: 'matchmaking' });
    menuBackground.boot(scene);

    // ------------------------------------------------------------------
    // Responsive panel sizing
    // ------------------------------------------------------------------

    const panelW = Math.max(PANEL_W_MIN, Math.min(width * PANEL_W_FRAC, PANEL_W_MAX));
    const panelH = Math.min(height * PANEL_H_FRAC, PANEL_H_MAX);

    // ------------------------------------------------------------------
    // War-Table panel chrome — backing plate + baked shadow + main panel +
    // baked iron face + brass hairline + corner brackets (section builder in
    // MatchmakingUISections.ts; bodies moved verbatim).
    // ------------------------------------------------------------------

    const { mainPanel } = createWarTableChrome(scene, this.tweenTracker, cx, cy, panelW, panelH);

    // ------------------------------------------------------------------
    // Internal layout — vertical cursor flowing downward from panel top
    // ------------------------------------------------------------------

    const pad = DesignTokens.spacing.massive;
    const innerW = panelW - pad * 2;
    const panelTop = cy - panelH / 2;
    let cursorY = panelTop + pad + DesignTokens.spacing.colossal;

    // ------------------------------------------------------------------
    // Title with sword decorations
    // ------------------------------------------------------------------

    const titleY = cursorY;
    const titleLabel = new Label(scene, cx, titleY, {
      text: 'MATCHMAKING',
      variant: 'title',
      color: DesignTokens.color.menuTitleText as number,
      align: 'center',
    });
    titleLabel.setDepth(DesignTokens.depth.sceneUi + 1);
    titleLabel.setScrollFactor(0);
    centerLabel(titleLabel);

    const titleText = titleLabel.getAt(0) as Phaser.GameObjects.Text;
    const swordOffsetX = titleText.width / 2 + DesignTokens.spacing.xxxl;
    this.createSwordDecoration(cx - swordOffsetX, titleY);
    this.createSwordDecoration(cx + swordOffsetX, titleY, true);

    // §3.2 — Brushed-gold title (CanvasTexture destination-in mask). Bake once
    // + overlay as Image. The titleLabel widget is PRESERVED (returned in refs,
    // drives sword positioning via titleText.width), just hidden — its visual
    // role is taken by the baked gold Image (the flat cream read lifts to
    // "gold-foil decree"). Best-effort: if Canvas2D fails the cream Label stays.
    if (
      bakeGoldTitle(
        scene,
        TITLE_GOLD_KEY,
        'MATCHMAKING',
        DesignTokens.font.size.xxl,
        DesignTokens.font.family,
      )
    ) {
      const titleGold = scene.add.image(cx, titleY, TITLE_GOLD_KEY);
      titleGold.setDepth(DesignTokens.depth.sceneUi + 1);
      titleGold.setOrigin(0.5, 0.5);
      titleGold.setScrollFactor(0);
      // Soft stacked shadow behind the gold title (title-shaped — same
      // technique as the menu logo). A container at the title origin turns the
      // per-layer (dx,dy) offsets into screen offsets; depth sceneUi keeps it
      // behind the title (sceneUi+1). Scale 1 matches titleGold's native size.
      const titleShadowCont = scene.add.container(cx, titleY);
      titleShadowCont.setDepth(DesignTokens.depth.sceneUi);
      titleShadowCont.setScrollFactor(0);
      for (const s of createStackedShadow(scene, TITLE_GOLD_KEY, 1)) {
        titleShadowCont.add(s);
      }
      titleLabel.setVisible(false);
    }

    cursorY += DesignTokens.font.size.xxl + DesignTokens.spacing.lg;

    // ------------------------------------------------------------------
    // Subtitle
    // ------------------------------------------------------------------

    const subtitleY = cursorY;
    const subtitleLabel = new Label(scene, cx, subtitleY, {
      text: 'finding worthy opponents...',
      variant: 'flavor',
      color: DesignTokens.color.menuSubtitle as number,
      align: 'center',
      stroke: true, // ticket 16 legibility pass.
    });
    subtitleLabel.setDepth(DesignTokens.depth.sceneUi + 1);
    subtitleLabel.setScrollFactor(0);
    centerLabel(subtitleLabel);
    // §3.9 — Engraved label depth: re-tune stroke ONE step DARKER than the
    // cast-iron face (#2a2520 on 0x3a3530) → incised read, not pure-black
    // outline (doc 23 §2.5/§3.9). Kit stroke overridden post-construction →
    // Label.ts stays byte-identical.
    (subtitleLabel.getAt(0) as Phaser.GameObjects.Text).setStroke('#2a2520', 3);
    cursorY += DesignTokens.spacing.xxl + DesignTokens.spacing.sm;

    // ------------------------------------------------------------------
    // Divider
    // ------------------------------------------------------------------

    const dividerY = cursorY;
    const divider = scene.add.image(cx, dividerY, 'ui', 'divider-fade');
    divider.setDisplaySize(innerW, 6);
    divider.setAlpha(0.6); // ticket 16: brass rule lifted so the separator reads.
    divider.setTint(DesignTokens.color.menuBtnPrimary as number);
    divider.setDepth(DesignTokens.depth.sceneUi + 1);
    divider.setOrigin(0.5, 0.5);
    divider.setScrollFactor(0);
    divider.scaleX = 0;
    this.tweenTracker.track(
      scene.tweens.add({
        targets: divider,
        scaleX: 1,
        duration: DesignTokens.duration.emphasis,
        ease: DesignTokens.easing.expoOut,
        delay: DesignTokens.duration.standard,
      }),
    );
    cursorY += DesignTokens.spacing.massive + DesignTokens.spacing.xxl;

    // ------------------------------------------------------------------
    // Player count
    // ------------------------------------------------------------------

    const countY = cursorY;
    const playerCountLabel = new Label(scene, cx, countY, {
      text: '0 / 64 players',
      variant: 'subtitle',
      color: DesignTokens.color.menuSubtitle as number,
      align: 'center',
      stroke: true,
    });
    playerCountLabel.setDepth(DesignTokens.depth.sceneUi + 1);
    playerCountLabel.setScrollFactor(0);
    centerLabel(playerCountLabel);
    // §3.9 — engraved stroke (see subtitle above).
    (playerCountLabel.getAt(0) as Phaser.GameObjects.Text).setStroke('#2a2520', 3);
    cursorY += DesignTokens.font.size.xl + DesignTokens.spacing.lg;

    // ------------------------------------------------------------------
    // Fill progress bar (player count / 64) + §3.6 molten pour tip
    // ------------------------------------------------------------------

    const fillBarY = cursorY;
    // Forge-ember fill (`accent` amber) on iron channel (`surfaceDark`).
    const fillBar = new ProgressBar(scene, cx - innerW / 2, fillBarY, {
      width: innerW,
      height: FILL_BAR_H,
      fillColor: DesignTokens.color.accent as number,
      trackColor: DesignTokens.color.surfaceDark as number,
      animated: true,
    });
    fillBar.setDepth(DesignTokens.depth.sceneUi + 1);
    fillBar.setScrollFactor(0);
    fillBar.setRatio(0);

    // §3.6 — Ember-glow "molten pour tip": a brighter 0xffee88 (warmYellow)
    // rounded rect tracking the fill's leading edge each frame (Diablo-IV
    // molten pour — doc 23 §1.4/§3.6). Registered on scene.events.PRE_UPDATE so
    // it syncs with fillBar.ratio WITHOUT touching MatchmakingScene.update()
    // (flow byte-identical). Phaser clears scene.events listeners on SHUTDOWN,
    // so no leak across restarts. Alpha tweened 0.8→1→0.8 yoyo (forge pulse).
    const moltenTip = scene.add.graphics();
    moltenTip.setDepth(DesignTokens.depth.sceneUi + 2);
    moltenTip.setScrollFactor(0);
    const tipState = { alpha: 0.8 };
    const drawMoltenTip = (): void => {
      moltenTip.clear();
      const ratio = fillBar.ratio;
      if (ratio <= 0.001) return;
      const tipX = cx - innerW / 2 + ratio * innerW;
      moltenTip.fillStyle(DesignTokens.color.warmYellow as number, tipState.alpha);
      moltenTip.fillRoundedRect(tipX - 3, fillBarY - FILL_BAR_H / 2 - 1, 6, FILL_BAR_H + 2, 3);
    };
    scene.events.on(Phaser.Scenes.Events.PRE_UPDATE, drawMoltenTip);
    this.tweenTracker.track(
      scene.tweens.add({
        targets: tipState,
        alpha: 1,
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        onUpdate: drawMoltenTip,
      }),
    );

    cursorY += FILL_BAR_H + DesignTokens.spacing.xl + DesignTokens.spacing.md;

    // ------------------------------------------------------------------
    // Status text
    // ------------------------------------------------------------------

    const statusY = cursorY;
    const statusLabel = new Label(scene, cx, statusY, {
      text: 'Searching for players...',
      variant: 'body',
      color: DesignTokens.color.menuSubtitle as number,
      align: 'center',
      stroke: true,
    });
    statusLabel.setDepth(DesignTokens.depth.sceneUi + 1);
    statusLabel.setScrollFactor(0);
    centerLabel(statusLabel);
    // §3.9 — engraved stroke (see subtitle above).
    (statusLabel.getAt(0) as Phaser.GameObjects.Text).setStroke('#2a2520', 3);
    cursorY += DesignTokens.font.size.md + DesignTokens.spacing.xxxl;

    // ------------------------------------------------------------------
    // Countdown label + bar  (§3.3 — two-tone embossed countdown)
    // ------------------------------------------------------------------

    const countdownY = cursorY;
    const countdownLabel = new Label(scene, cx, countdownY, {
      text: '',
      variant: 'title',
      color: DesignTokens.color.menuTitleText as number,
      align: 'center',
    });
    countdownLabel.setDepth(DesignTokens.depth.sceneUi + 1);
    countdownLabel.setScrollFactor(0);
    centerLabel(countdownLabel);

    // §3.3 — Two-tone embossed countdown (doc 23 §2.3 path 2, dynamic-safe).
    // Base Text re-hued cream → mid-gold #c4963e (a §2.3 stop) + deep-ember
    // title stroke #140d08 th4 for relief. A second overlay Text #fde28a α0.5
    // at yOffset -1 = the "brushed ridge" highlight. The overlay is synced by
    // wrapping countdownLabel.setText so the byte-identical flow
    // (countdownLabel.setText from MatchmakingScene) drives BOTH layers —
    // MatchmakingScene stays untouched.
    const countdownBaseText = countdownLabel.getAt(0) as Phaser.GameObjects.Text;
    countdownBaseText.setColor('#c4963e');
    countdownBaseText.setStroke('#140d08', 4);
    const countdownOverlay = scene.add.text(cx, countdownY - 1, '', {
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.xxl}px`,
      color: '#fde28a',
      align: 'center',
    });
    countdownOverlay.setOrigin(0.5, 0.5);
    countdownOverlay.setAlpha(0.5);
    countdownOverlay.setDepth(DesignTokens.depth.sceneUi + 2);
    countdownOverlay.setScrollFactor(0);
    const origSetCountdownText = countdownLabel.setText.bind(countdownLabel);
    countdownLabel.setText = (text: string): void => {
      origSetCountdownText(text);
      countdownOverlay.setText(text);
    };

    const countdownBarY = countdownY + DesignTokens.font.size.xxxl + DesignTokens.spacing.sm;
    const countdownBarW = Math.min(innerW * 0.7, 360);
    const countdownBar = new ProgressBar(scene, cx - countdownBarW / 2, countdownBarY, {
      width: countdownBarW,
      height: COUNTDOWN_BAR_H,
      fillColor: DesignTokens.color.menuTitleText as number,
      trackColor: DesignTokens.color.surfaceDark as number,
      animated: true,
    });
    countdownBar.setDepth(DesignTokens.depth.sceneUi + 1);
    countdownBar.setScrollFactor(0);
    countdownBar.setVisible(false);
    cursorY = countdownBarY + COUNTDOWN_BAR_H + DesignTokens.spacing.massive;

    // ------------------------------------------------------------------
    // Player list — §3.1 beveled recessed slot + container + widget
    // (section builder in MatchmakingUISections.ts; bodies moved verbatim)
    // ------------------------------------------------------------------

    const { playerListPanel, playerListContainer, playerListWidget } = createPlayerListSection(
      scene,
      this.tweenTracker,
      cx,
      cy,
      panelH,
      pad,
      innerW,
      cursorY,
    );

    // ------------------------------------------------------------------
    // Leave button (below panel, danger variant)
    // ------------------------------------------------------------------

    // The `danger` variant cascades to menuBtnDanger (forge-blood 0x9a2a1a) via
    // Button.VARIANT_TINT; Button pins itself via setScrollFactor(0). The
    // slide-up reveal (alpha + y tween, below) is byte-identical.
    const leaveBtnY = cy + panelH / 2 + DesignTokens.spacing.huge + DesignTokens.spacing.md;
    const leaveBtnW = Math.min(width * 0.18, 240);
    const leaveButton = new Button(scene, cx, leaveBtnY, {
      label: 'LEAVE',
      variant: 'danger',
      width: leaveBtnW,
      height: 52,
      size: 'lg',
    });
    leaveButton.setDepth(DesignTokens.depth.sceneUi + 1);
    // Soft cast-shadow puddle under the button (depth — mirrors the menu
    // buttons). Added as the button's back-most child so it follows the slide-up
    // + fade reveal tween below automatically.
    const leaveShadow = createSoftShadowPuddle(scene, leaveBtnW, 52);
    leaveShadow.y = 52 * 0.5 + 3;
    leaveButton.add(leaveShadow);
    leaveButton.moveTo(leaveShadow, 0);
    leaveButton.setAlpha(0);
    leaveButton.y += 20;
    this.tweenTracker.track(
      scene.tweens.add({
        targets: leaveButton,
        alpha: 1,
        y: leaveBtnY,
        duration: DesignTokens.duration.standard,
        ease: DesignTokens.easing.snappy,
        delay: DesignTokens.duration.smooth,
      }),
    );

    return {
      menuBackground,
      mainPanel,
      playerListPanel,
      playerListContainer,
      titleLabel,
      subtitleLabel,
      statusLabel,
      playerCountLabel,
      fillBar,
      countdownLabel,
      countdownBar,
      leaveButton,
      playerListWidget,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Create a decorative sword icon at the given position.
   * Faces right by default; flipped to face left when `flip` is true.
   */
  private createSwordDecoration(x: number, y: number, flip = false): void {
    const icon = this.scene.add.image(x, y, 'ui', 'icon_sword');
    icon.setDisplaySize(28, 28);
    // Brass heraldry (menuBtnPrimary 0xc89456) — bronze sword filigree.
    icon.setTint(DesignTokens.color.menuBtnPrimary as number);
    icon.setAlpha(0.8); // ticket 16: brass heraldry lifted so the swords read.
    icon.setDepth(DesignTokens.depth.sceneUi + 1);
    icon.setOrigin(0.5, 0.5);
    icon.setScrollFactor(0);
    if (flip) {
      icon.flipX = true;
    }
  }

  destroy(): void {
    // Components are Phaser GameObjects — destroyed by scene lifecycle.
  }
}
