import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { UIComponent } from './UIComponent.js';
import { TweenPresets } from '../TweenPresets.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonConfig {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: number;
  height?: number;
  disabled?: boolean;
}

/**
 * Palette B v2 — "Parchment and blood" (ticket 29, BUTTON-ONLY).
 *
 * v2 retune (ticket 29 / doc 21 §4.3) on top of the regenerated `button_square`
 * texture (mean L 37 → 181, see `paste_button_into_atlas.py`). Because the face
 * texture is now bright + beveled, `setTint` multiply lands near the intended
 * color, so:
 *   - primary  #f2e2b3  warm cream parchment  (was #e8d9b0; brighter — clears
 *                                                  AAA ≥4.5 over the vignette)
 *   - danger   #b8331f  forge ember           (was #8b1a1a; brighter)
 *   - secondary #6b4a2b aged oak — KEPT (mood). The deliberately dark face is
 *                  separated from the warm fire-disk floor by the BACKING PLATE
 *                  layer (see `PLATE_*` below), not by a brighter face — exactly
 *                  the Hearthstone/Diablo technique (doc 21 §2/§3c).
 *
 * WHY HARDCODED HERE (not in DesignTokens): `DesignTokens.color.menuBtn*` are
 * the SHARED palette-A tokens — `Panel.ts:45-46` reads `menuBtnSecondary` for
 * its `default`/`bordered` faces, and `MatchmakingUI.ts:203,395` read
 * `menuBtnPrimary` for the divider + swords icon. Editing those tokens would
 * re-tint every panel + the war-table chrome (out of scope — "buttons only").
 * Palette B is a button-specific decision, so it lives here as dedicated
 * tables. This keeps Panel.ts + MatchmakingUI.ts byte-identical (the diff is
 * Button.ts only — no shared-token leak).
 *
 * Hover + pressed states are fresh (the palette-B mock has no `:hover`): each
 * hover tint is a deeper shade within its family. The pressed state reuses the
 * hover tint — the existing `onPress` structure (no tint line) is preserved
 * byte-for-byte; only the hover color values change.
 */
const PALETTE_B_FACE: Record<ButtonVariant, number> = {
  primary: 0xf2e2b3, // warm cream parchment (v2 — brighter, AAA over vignette)
  secondary: 0x6b4a2b, // aged oak (kept — mood; the backing plate carries separation)
  danger: 0xb8331f, // forge ember (v2 — brighter)
};

/** Hover = a deeper shade within each family (reads as "pressed-in / active"). */
const PALETTE_B_HOVER: Record<ButtonVariant, number> = {
  primary: 0xdaca9a, // deeper warm cream
  secondary: 0x5a3e24, // deeper oak
  danger: 0x9c2a18, // deeper forge ember
};

/**
 * Per-variant label color + stroke (palette B makes the label variant-
 * dependent — the prior single hard-coded `#ffffff`/`#000000` could not suit
 * the parchment-face primary, which needs dark ink text).
 *
 * v2 (ticket 29): unchanged VALUES — the regenerated bright texture keeps the
 * same polarity (primary = light face → dark ink label; secondary/danger =
 * dark faces → cream label), and WCAG AAA still holds: primary dark-ink on the
 * cream face clears ≥4.5; cream labels on the oak/ember faces clear ≥4.5.
 *
 * Stroke is deep ink (#1a1208, the palette-B title-stroke family per the
 * mock's `.B .logo` text-shadow) throughout: it lifts the parchment text off
 * the dark oak/red faces and crispens the dark-ink text on the parchment face
 * without a muddy light halo. Thickness is 2 on primary (dark-on-light is
 * already maximal contrast — a thin stroke suffices) and 3 on the dark faces
 * (light-on-dark needs the lift over the lit diorama).
 */
const PALETTE_B_LABEL: Record<
  ButtonVariant,
  { color: string; stroke: string; strokeThickness: number }
> = {
  primary: { color: '#2a1a0a', stroke: '#1a1208', strokeThickness: 2 },
  secondary: { color: '#f2e6c9', stroke: '#1a1208', strokeThickness: 3 },
  danger: { color: '#f2e6c9', stroke: '#1a1208', strokeThickness: 3 },
};

const SIZE_FONT: Record<ButtonSize, number> = {
  sm: DesignTokens.font.size.sm,
  md: DesignTokens.font.size.md,
  lg: DesignTokens.font.size.lg,
};

const SIZE_DIM: Record<ButtonSize, { w: number; h: number }> = {
  sm: { w: 80, h: 32 },
  md: { w: 120, h: 40 },
  lg: { w: 160, h: 48 },
};

const INSET = DesignTokens.nineSlice.buttonSquare;
/** Button face lives in the `ui` multipack atlas as frame `button_square`. */
const UI_ATLAS = 'ui';
const BUTTON_FRAME = 'button_square';

/**
 * Backing-plate layer (ticket 29 / doc 21 §3c). A cream NineSlice, inset 4px
 * larger than the face on every side (renders as a halo/frame peeking out
 * behind the face), α≈0.20. This is the ONLY thing that separates the
 * deliberately dark secondary/danger faces from the warm fire-disk floor — the
 * AAA recipe (Hearthstone/Diablo/BG3) all use a plate/rim, never a bright face
 * for dark variants. Reuses the regenerated `button_square` frame so no new
 * atlas entry is needed (ui.json stays byte-identical).
 */
const PLATE_COLOR = 0xfff4e0; // cream (menuTitleText family)
const PLATE_ALPHA = 0.2;
const PLATE_OUTSET = 4; // px the plate extends BEYOND the face on every side

/**
 * Button-local shadow override (ticket 29 shadow-fix / doc 21 §1d+§4.4). The
 * shared `DesignTokens.shadow` is near-black `0x111111` at α 0.05 (ghost) — a
 * 5%-alpha near-black drop shadow is invisible over the dark vignette, so the
 * face had zero separation on dark backgrounds. We override BOTH values HERE
 * (Button-only — DesignTokens stays byte-identical, so no other shadow consumer
 * is affected): a warmer dark tint `0x1a0e08` (the title-stroke family) reads
 * as a cast shadow rather than a black blob, and α 0.4 finally makes it legible
 * over the vignette corner.
 */
const BUTTON_SHADOW_COLOR = 0x1a0e08; // warm-dark (title-stroke family)
const BUTTON_SHADOW_ALPHA = 0.4;

/**
 * Button — four-layer NineSlice (shadow + plate + face + label).
 * States: normal, hover, pressed, disabled.
 */
export class Button extends UIComponent {
  private shadowLayer!: Phaser.GameObjects.NineSlice;
  private plateLayer!: Phaser.GameObjects.NineSlice;
  private face!: Phaser.GameObjects.NineSlice;
  private label!: Phaser.GameObjects.Text;
  private isDisabled = false;
  private isPressed = false;
  private pressOffset = 3;
  private baseTint: number = DesignTokens.color.paper as number;
  private hoverTint: number = 0;
  private boundOnPointerUpOutside: () => void;

  constructor(scene: Phaser.Scene, x: number, y: number, config: ButtonConfig) {
    super(scene, x, y);
    const variant = config.variant ?? 'secondary';
    const size = config.size ?? 'md';
    const w = config.width ?? SIZE_DIM[size].w;
    const h = config.height ?? SIZE_DIM[size].h;
    this.baseTint = PALETTE_B_FACE[variant];
    this.hoverTint = PALETTE_B_HOVER[variant];

    this.boundOnPointerUpOutside = this.handlePointerUpOutside.bind(this);

    // Shadow (Button-local override — see BUTTON_SHADOW_*; the shared
    // DesignTokens.shadow is near-black @ α0.05 = invisible over the vignette).
    this.shadowLayer = scene.add.nineslice(
      0,
      this.pressOffset,
      UI_ATLAS,
      BUTTON_FRAME,
      w,
      h,
      INSET.left,
      INSET.right,
      INSET.top,
      INSET.bottom,
    );
    this.shadowLayer.setTint(BUTTON_SHADOW_COLOR);
    this.shadowLayer.setAlpha(BUTTON_SHADOW_ALPHA);
    this.shadowLayer.setOrigin(0.5);
    this.add(this.shadowLayer);

    // Backing plate (ticket 29 / doc 21 §3c) — cream halo behind the face,
    // 4px larger on every side. Renders UNDER the face (added before it), so a
    // subtle cream rim peeks out around the face. This is the separation layer
    // for the deliberately dark secondary/danger faces over the warm fire disk.
    this.plateLayer = scene.add.nineslice(
      0,
      0,
      UI_ATLAS,
      BUTTON_FRAME,
      w + PLATE_OUTSET * 2,
      h + PLATE_OUTSET * 2,
      INSET.left,
      INSET.right,
      INSET.top,
      INSET.bottom,
    );
    this.plateLayer.setTint(PLATE_COLOR);
    this.plateLayer.setAlpha(PLATE_ALPHA);
    this.plateLayer.setOrigin(0.5);
    this.add(this.plateLayer);

    // Face
    this.face = scene.add.nineslice(
      0,
      0,
      UI_ATLAS,
      BUTTON_FRAME,
      w,
      h,
      INSET.left,
      INSET.right,
      INSET.top,
      INSET.bottom,
    );
    this.face.setTint(this.baseTint);
    this.face.setOrigin(0.5);
    this.add(this.face);

    // Label — palette-B per-variant color/stroke (ticket 13). Primary = dark
    // ink on parchment; secondary + danger = parchment on dark. See
    // PALETTE_B_LABEL above for the legibility rationale.
    const labelStyle = PALETTE_B_LABEL[variant];
    this.label = scene.add.text(0, 0, config.label, {
      fontFamily: DesignTokens.font.family,
      fontSize: `${SIZE_FONT[size]}px`,
      color: labelStyle.color,
      stroke: labelStyle.stroke,
      strokeThickness: labelStyle.strokeThickness,
      align: 'center',
    });
    this.label.setOrigin(0.5);
    this.add(this.label);

    // Hit area
    this.setInteractive(
      new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
      Phaser.Geom.Rectangle.Contains,
    );

    // Pointer events
    this.on('pointerover', this.onHover, this);
    this.on('pointerout', this.onNormal, this);
    this.on('pointerdown', this.onPress, this);
    this.on('pointerup', this.onRelease, this);
    this.on('pointerupoutside', this.boundOnPointerUpOutside);

    // UI buttons are typically placed in scrollFactor(0) containers but the
    // hit area uses scrollFactor(1) by default, causing clicks to miss when
    // the camera scrolls.  Force scrollFactor(0) so hit area stays in sync
    // with the visual position.
    this.setScrollFactor(0);

    if (config.disabled) {
      this.setDisabled(true);
    }
  }

  private handlePointerUpOutside(): void {
    if (!this.isPressed) return;
    this.isPressed = false;
    this.face.y = 0;
    this.shadowLayer.setAlpha(BUTTON_SHADOW_ALPHA);
  }

  private onHover(): void {
    if (this.isDisabled) return;
    // Palette-B hover (ticket 13): per-variant deeper shade within each family
    // (parchment → deeper parchment, oak → deeper oak, red → dried red). Reads
    // as a "pressed-in / active" state. Pressed (onPress) inherits this tint —
    // its structure (y-offset + shadow alpha) is byte-identical to before.
    this.face.setTint(this.hoverTint);
    this.scene.tweens.add({
      targets: this.face,
      scaleX: TweenPresets.buttonHover.scaleX,
      scaleY: TweenPresets.buttonHover.scaleY,
      duration: TweenPresets.buttonHover.duration,
      ease: TweenPresets.buttonHover.ease,
    });
    this.emit('button.hover', true);
  }

  private onNormal(): void {
    if (this.isDisabled) return;
    this.face.setTint(this.baseTint);
    this.scene.tweens.add({
      targets: this.face,
      scaleX: TweenPresets.buttonReset.scaleX,
      scaleY: TweenPresets.buttonReset.scaleY,
      y: 0,
      duration: TweenPresets.buttonReset.duration,
      ease: TweenPresets.buttonReset.ease,
    });
    this.emit('button.hover', false);
  }

  private onPress(): void {
    if (this.isDisabled) return;
    this.isPressed = true;
    this.scene.tweens.add({
      targets: this.face,
      scaleX: TweenPresets.buttonPress.scaleX,
      scaleY: TweenPresets.buttonPress.scaleY,
      duration: TweenPresets.buttonPress.duration,
      ease: TweenPresets.buttonPress.ease,
    });
    this.face.y = this.pressOffset;
    this.shadowLayer.setAlpha(0);
    this.emit('button.press');
  }

  private onRelease(): void {
    if (!this.isPressed || this.isDisabled) return;
    this.isPressed = false;
    this.shadowLayer.setAlpha(BUTTON_SHADOW_ALPHA);
    this.emit('button.click');
    if (!this.scene || !this.scene.tweens) return;
    this.scene.tweens.add({
      targets: this.face,
      scaleX: TweenPresets.buttonRelease.scaleX,
      scaleY: TweenPresets.buttonRelease.scaleY,
      y: 0,
      duration: TweenPresets.buttonRelease.duration,
      ease: TweenPresets.buttonRelease.ease,
    });
  }

  setDisabled(disabled: boolean): void {
    this.isDisabled = disabled;
    if (disabled) {
      this.face.setTint(DesignTokens.color.muted);
      this.setAlpha(0.4);
      this.disableInteractive();
    } else {
      this.face.setTint(this.baseTint);
      this.setAlpha(1);
      this.setInteractive(
        new Phaser.Geom.Rectangle(
          -this.face.width / 2,
          -this.face.height / 2,
          this.face.width,
          this.face.height,
        ),
        Phaser.Geom.Rectangle.Contains,
      );
    }
  }

  setLabel(text: string): void {
    this.label.setText(text);
  }

  override destroy(fromScene?: boolean): void {
    this.off('pointerupoutside', this.boundOnPointerUpOutside);
    super.destroy(fromScene);
  }

  /** Expose internal game objects for animation / choreography access. */
  getContent(): { face: Phaser.GameObjects.NineSlice; label: Phaser.GameObjects.Text } {
    return { face: this.face, label: this.label };
  }
}
