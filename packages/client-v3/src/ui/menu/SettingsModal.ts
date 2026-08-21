import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { Button } from '../components/Button.js';
import { Checkbox } from '../components/Checkbox.js';
import { TweenTracker } from '../animations/TweenTracker.js';
import { createWarTableChrome } from '../layers/WarTableChrome.js';
import { attachSoftShadowPuddle, createStackedShadow } from '../SoftShadow.js';
import { bakeGoldTitle } from '../../scenes/MatchmakingCanvasBake.js';
import { createControlsSection } from './SettingsControlsSection.js';
import { applySoundSetting, loadSettings, saveSettings } from '../../settings/SettingsStore.js';
import type { SharedAudioService } from '../../audio/SharedAudioService.js';

// ---------------------------------------------------------------------------
// Layout constants — the canvas is a FIXED 1920x1080 design space (Scale.FIT
// letterboxes), so these are absolute like every other menu surface.
// ---------------------------------------------------------------------------

const PANEL_W = 860;
const PANEL_H = 912;
const PAD = 44;
const INNER_W = PANEL_W - PAD * 2;

/** CanvasTexture keys — MUST NOT collide with matchmaking's cached bakes. */
const SETTINGS_IRON_FACE_KEY = '__settings_iron_face';
const SETTINGS_PANEL_SHADOW_KEY = '__settings_panel_shadow';
const SETTINGS_TITLE_GOLD_KEY = '__settings_title_gold';

/** Engraved label family shared with the matchmaking screen (§3.9). */
const LABEL_COLOR = '#d9c79a'; // menuSubtitle parchment cream
const LABEL_STROKE = '#2a2520'; // one step darker than the iron face

const CHECKBOX_SIZE = 34;
const CLOSE_BTN_W = 220;
const CLOSE_BTN_H = 52;

/**
 * SettingsModal — the main-menu SETTINGS surface, rendered as a modal over the
 * menu: the SAME "Iron War-Table" chrome as the matchmaking screen (backing
 * plate + baked shadow + iron face + brass hairline + corner brackets, reused
 * via `createWarTableChrome`), hosting:
 *
 *   - SOUND — a master-audio checkbox (Phaser global mute, persisted to
 *     localStorage via SettingsStore; applied at boot in main.ts)
 *   - CONTROLS — the controls guide grid with Kenney input-prompt sprites
 *
 * Structure: a scene-level interactive backdrop (dims + blocks the menu
 * buttons behind — Phaser's topOnly input hands events to the topmost
 * interactive object) + a content container holding the chrome. The backdrop
 * is a SIBLING, not a container child, so the content's scale-in tween can
 * never shrink the dim/block area.
 *
 * Built lazily on first `open()` so the chrome reveal + row stagger play
 * visibly; subsequent opens fade/scale the content. ESC, backdrop click, and
 * the CLOSE button all dismiss.
 */
export class SettingsModal {
  private scene: Phaser.Scene;
  private audio: SharedAudioService;
  private tracker: TweenTracker | null = null;
  private backdrop: Phaser.GameObjects.Rectangle | null = null;
  private content: Phaser.GameObjects.Container | null = null;
  private checkbox: Checkbox | null = null;
  private escHandler = (): void => {
    if (this.visible) this.close();
  };

  private visible = false;
  private built = false;

  constructor(scene: Phaser.Scene, audio: SharedAudioService) {
    this.scene = scene;
    this.audio = audio;
    scene.input.keyboard?.on('keydown-ESC', this.escHandler);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  open(): void {
    if (this.visible) return;
    if (!this.built) {
      this.build();
      this.built = true;
      this.visible = true;
      return; // first open: the chrome reveal tweens ARE the entrance
    }
    this.visible = true;
    const backdrop = this.backdrop!;
    const content = this.content!;
    backdrop.setVisible(true);
    backdrop.setAlpha(0);
    content.setVisible(true);
    content.setAlpha(0);
    content.setScale(0.92);
    this.tracker?.track(
      this.scene.tweens.add({
        targets: backdrop,
        alpha: DesignTokens.alpha.modalBg,
        duration: DesignTokens.duration.quick,
        ease: DesignTokens.easing.sineOut,
      }),
    );
    this.tracker?.track(
      this.scene.tweens.add({
        targets: content,
        alpha: 1,
        scale: 1,
        duration: DesignTokens.duration.smooth,
        ease: DesignTokens.easing.backOut,
      }),
    );
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    const backdrop = this.backdrop;
    const content = this.content;
    if (!backdrop || !content) return;
    if (!this.scene.tweens) {
      backdrop.setVisible(false);
      content.setVisible(false);
      return;
    }
    this.scene.tweens.add({
      targets: [backdrop, content],
      alpha: 0,
      duration: DesignTokens.duration.quick,
      ease: DesignTokens.easing.sineOut,
      onComplete: () => {
        backdrop.setVisible(false);
        content.setVisible(false);
      },
    });
  }

  destroy(): void {
    this.scene.input.keyboard?.off('keydown-ESC', this.escHandler);
    this.tracker?.dispose();
    this.tracker = null;
    this.backdrop?.destroy();
    this.backdrop = null;
    this.content?.destroy(true);
    this.content = null;
    this.checkbox = null;
    this.built = false;
    this.visible = false;
  }

  // -----------------------------------------------------------------------
  // Build (once, on first open — content is static apart from the checkbox)
  // -----------------------------------------------------------------------

  private build(): void {
    const scene = this.scene;
    const { width, height } = scene.scale;
    const cx = width / 2;
    const cy = height / 2;
    this.tracker = new TweenTracker(scene);

    // --- Backdrop: full-screen dim + input block. Interactive so the menu
    // buttons behind are not clickable while open; click dismisses.
    this.backdrop = scene.add.rectangle(cx, cy, width, height, DesignTokens.colors.black);
    this.backdrop.setAlpha(0);
    this.backdrop.setDepth(DesignTokens.depth.modal);
    this.backdrop.setScrollFactor(0);
    this.backdrop.setInteractive();
    this.backdrop.on('pointerdown', () => this.close());
    this.tracker.track(
      scene.tweens.add({
        targets: this.backdrop,
        alpha: DesignTokens.alpha.modalBg,
        duration: DesignTokens.duration.quick,
        ease: DesignTokens.easing.sineOut,
      }),
    );

    // --- Content container at screen center; children live in its local
    // space. Holds the War-Table chrome (matchmaking's exact look).
    const content = scene.add.container(cx, cy);
    content.setDepth(DesignTokens.depth.modal + 1);
    content.setScrollFactor(0);
    this.content = content;

    createWarTableChrome(scene, this.tracker, 0, 0, PANEL_W, PANEL_H, {
      textureKeys: { ironFace: SETTINGS_IRON_FACE_KEY, panelShadow: SETTINGS_PANEL_SHADOW_KEY },
      parent: content,
    });

    // --- Content flows downward from the panel top, matchmaking-style.
    const panelTop = -PANEL_H / 2;
    const left = -INNER_W / 2;
    let cursorY = panelTop + PAD + 16;

    // Title — baked brushed-gold decree (matchmaking technique §3.2), with
    // the cream Label as the Canvas2D-unavailable fallback.
    const titleLabel = scene.add.text(0, cursorY, 'SETTINGS', {
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.xxl}px`,
      color: '#fff4e0',
      stroke: '#140d08',
      strokeThickness: 4,
      align: 'center',
    });
    titleLabel.setOrigin(0.5, 0.5);
    content.add(titleLabel);
    const titleW = Math.max(titleLabel.width, 180);
    this.createSwordDecoration(content, -titleW / 2 - DesignTokens.spacing.xxxl, cursorY, false);
    this.createSwordDecoration(content, titleW / 2 + DesignTokens.spacing.xxxl, cursorY, true);
    if (
      bakeGoldTitle(
        scene,
        SETTINGS_TITLE_GOLD_KEY,
        'SETTINGS',
        DesignTokens.font.size.xxl,
        DesignTokens.font.family,
      )
    ) {
      const gold = scene.add.image(0, cursorY, SETTINGS_TITLE_GOLD_KEY);
      gold.setOrigin(0.5, 0.5);
      const shadowCont = scene.add.container(0, cursorY);
      for (const s of createStackedShadow(scene, SETTINGS_TITLE_GOLD_KEY, 1)) {
        shadowCont.add(s);
      }
      content.add(shadowCont);
      content.add(gold);
      titleLabel.setVisible(false);
    }
    cursorY += DesignTokens.font.size.xxl + DesignTokens.spacing.md;

    // Flavor line (Caveat handwriting — the matchmaking subtitle family).
    const flavor = scene.add.text(0, cursorY, 'the forge remembers your choices', {
      fontFamily: DesignTokens.font.flavorFamily,
      fontSize: `${DesignTokens.font.size.lg}px`,
      color: LABEL_COLOR,
      stroke: LABEL_STROKE,
      strokeThickness: 3,
    });
    flavor.setOrigin(0.5, 0.5);
    content.add(flavor);
    cursorY += DesignTokens.font.size.lg + DesignTokens.spacing.xl + DesignTokens.spacing.sm;

    this.createDivider(content, cursorY);
    cursorY += 6 + DesignTokens.spacing.xxl + DesignTokens.spacing.sm;

    // ── SOUND section ──────────────────────────────────────────────────
    this.createSectionHeader(content, left, cursorY, 'SOUND');
    cursorY += DesignTokens.font.size.xl + DesignTokens.spacing.lg;

    this.checkbox = new Checkbox(scene, left + CHECKBOX_SIZE / 2, cursorY + CHECKBOX_SIZE / 2, {
      checked: loadSettings().soundEnabled,
      label: 'SOUND EFFECTS & MUSIC',
    });
    this.checkbox.on('checkbox.toggle', (enabled: boolean) => {
      const settings = loadSettings();
      settings.soundEnabled = enabled;
      saveSettings(settings);
      applySoundSetting(scene.game);
      // Audible confirmation when re-enabling (muting is silent by design).
      if (enabled) this.audio.play('pickup_powerup');
    });
    content.add(this.checkbox);
    cursorY += CHECKBOX_SIZE + DesignTokens.spacing.xxl + DesignTokens.spacing.md;

    this.createDivider(content, cursorY);
    cursorY += 6 + DesignTokens.spacing.xxl + DesignTokens.spacing.sm;

    // ── CONTROLS section ───────────────────────────────────────────────
    this.createSectionHeader(content, left, cursorY, 'CONTROLS');
    cursorY += DesignTokens.font.size.xl + DesignTokens.spacing.lg;

    const section = createControlsSection(scene, this.tracker, content, left, cursorY, INNER_W);
    cursorY += section.height + DesignTokens.spacing.lg;

    // ── CLOSE button ───────────────────────────────────────────────────
    const closeBtnY = Math.min(
      cursorY + CLOSE_BTN_H / 2,
      PANEL_H / 2 - PAD - CLOSE_BTN_H / 2 + DesignTokens.spacing.md,
    );
    const closeButton = new Button(scene, 0, closeBtnY, {
      label: 'CLOSE',
      variant: 'primary',
      width: CLOSE_BTN_W,
      height: CLOSE_BTN_H,
      size: 'lg',
    });
    attachSoftShadowPuddle(closeButton, CLOSE_BTN_W, CLOSE_BTN_H);
    closeButton.on('button.click', () => this.close());
    content.add(closeButton);
  }

  /** Brass hairline divider — same treatment as the matchmaking screen. */
  private createDivider(parent: Phaser.GameObjects.Container, y: number): void {
    const divider = this.scene.add.image(0, y, 'ui', 'divider-fade');
    divider.setDisplaySize(INNER_W, 6);
    divider.setAlpha(0.6);
    divider.setTint(DesignTokens.color.menuBtnPrimary as number);
    divider.setOrigin(0.5, 0.5);
    divider.scaleX = 0;
    this.tracker?.track(
      this.scene.tweens.add({
        targets: divider,
        scaleX: 1,
        duration: DesignTokens.duration.emphasis,
        ease: DesignTokens.easing.expoOut,
        delay: DesignTokens.duration.standard,
      }),
    );
    parent.add(divider);
  }

  /** Engraved section header (SOUND / CONTROLS). */
  private createSectionHeader(
    parent: Phaser.GameObjects.Container,
    x: number,
    y: number,
    text: string,
  ): void {
    const header = this.scene.add.text(x, y, text, {
      fontFamily: DesignTokens.font.family,
      fontSize: `${DesignTokens.font.size.xl}px`,
      color: LABEL_COLOR,
      stroke: LABEL_STROKE,
      strokeThickness: 3,
    });
    header.setOrigin(0, 0.5);
    parent.add(header);
  }

  /** Brass sword filigree flanking the title (matchmaking decoration). */
  private createSwordDecoration(
    parent: Phaser.GameObjects.Container,
    x: number,
    y: number,
    flip: boolean,
  ): void {
    const icon = this.scene.add.image(x, y, 'ui', 'icon_sword');
    icon.setDisplaySize(28, 28);
    icon.setTint(DesignTokens.color.menuBtnPrimary as number);
    icon.setAlpha(0.8);
    icon.setOrigin(0.5, 0.5);
    if (flip) {
      icon.flipX = true;
    }
    parent.add(icon);
  }
}
