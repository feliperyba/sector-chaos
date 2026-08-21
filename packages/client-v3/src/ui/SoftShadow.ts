import Phaser from 'phaser';

/**
 * Soft UI drop shadows — the depth cue for flat slot-0 decals (title, panels,
 * buttons) that don't participate in the lighting pipeline. Shared by the main
 * menu + matchmaking UI so the depth read is consistent across scenes.
 *
 * Two techniques, both blur-free (no `preFX` precedent in the codebase + WebGL
 * blur unverified here):
 *  - Puddle: a wide+short dark radial (`light_01`) for rectangular elements
 *    (panels, buttons). The radial's gradient gives the soft edge.
 *  - Stacked: N texture-shaped layers at increasing offset + decreasing alpha
 *    for text/logo images baked to a texture — synthesizes a soft edge that
 *    follows the glyph shape.
 *
 * Tinted deep warm (title-stroke family) so the shadow reads as a cast shadow,
 * not a black blob. Light direction is upper-left → shadow lower-right (the
 * standard UI convention). `light_01` MUST be preloaded — MainMenuScene +
 * MatchmakingScene both load it in preload.
 */

/** Deep warm tint for cast shadows (menuTitleStroke family). */
export const SOFT_SHADOW_TINT = 0x140d08;

/** Default puddle shape (wide + short = a soft cast under a rectangle). */
export const SOFT_SHADOW_PUDDLE_DEFAULTS = { alpha: 0.5, w: 1.3, h: 0.7 } as const;

/**
 * Default stacked-shadow layers (offset lower-right + decreasing alpha). The
 * combined core darkens to ~75% — a clear cast shadow, not a faint haze. Kept in
 * sync with MainMenuScene's TITLE_SHADOW_LAYERS so the menu logo + the baked
 * matchmaking title read identically.
 */
export const STACKED_SHADOW_LAYERS = [
  { dx: 3, dy: 6, alpha: 0.5 },
  { dx: 4, dy: 12, alpha: 0.36 },
  { dx: 5, dy: 20, alpha: 0.22 },
] as const;

/**
 * Create a soft cast-shadow puddle (radial) for a rectangular UI element. The
 * sprite is created at (0,0) with origin/tint/alpha/scale set; the CALLER
 * positions it (typically at the element's base, or centered behind) + sets
 * depth/scrollFactor + adds it to a container or the scene. Adding it as the
 * first child of the element's own container makes it follow reveal tweens
 * (scale/alpha) automatically.
 */
export function createSoftShadowPuddle(
  scene: Phaser.Scene,
  width: number,
  height: number,
  opts: { alpha?: number; w?: number; h?: number; tint?: number } = {},
): Phaser.GameObjects.Sprite {
  const {
    alpha = SOFT_SHADOW_PUDDLE_DEFAULTS.alpha,
    w = SOFT_SHADOW_PUDDLE_DEFAULTS.w,
    h = SOFT_SHADOW_PUDDLE_DEFAULTS.h,
    tint = SOFT_SHADOW_TINT,
  } = opts;
  const shadow = scene.add.sprite(0, 0, 'light_01');
  shadow.setOrigin(0.5, 0.5);
  shadow.setTint(tint);
  shadow.setAlpha(alpha);
  shadow.setScale((width * w) / shadow.width, (height * h) / shadow.height);
  return shadow;
}

/**
 * Attach a soft cast-shadow puddle UNDER a button-shaped container — added as
 * the back-most child at the element's base (h/2 + 3px), so it follows the
 * container's reveal tweens automatically. The shared body behind the menu
 * buttons, the matchmaking LEAVE button, and the settings CLOSE button.
 */
export function attachSoftShadowPuddle(
  container: Phaser.GameObjects.Container,
  width: number,
  height: number,
): Phaser.GameObjects.Sprite {
  const puddle = createSoftShadowPuddle(container.scene, width, height);
  puddle.y = height * 0.5 + 3;
  container.add(puddle);
  container.moveTo(puddle, 0);
  return puddle;
}

/**
 * Create stacked texture-shaped shadow sprites for a text/logo image baked to
 * `textureKey`. Returns N sprites positioned at their per-layer `(dx, dy)`
 * offset, tinted + alpha'd — the caller adds them to a container sited at the
 * ELEMENT's origin (so the offsets become screen offsets) + sets the container's
 * depth behind the element. `scale` must match the element's display scale so
 * the shadow hugs the glyph shape.
 */
export function createStackedShadow(
  scene: Phaser.Scene,
  textureKey: string,
  scale: number,
  layers: readonly { dx: number; dy: number; alpha: number }[] = STACKED_SHADOW_LAYERS,
  tint: number = SOFT_SHADOW_TINT,
): Phaser.GameObjects.Sprite[] {
  const out: Phaser.GameObjects.Sprite[] = [];
  for (const layer of layers) {
    const s = scene.add.sprite(layer.dx, layer.dy, textureKey);
    s.setOrigin(0.5, 0.5);
    s.setTint(tint);
    s.setAlpha(layer.alpha);
    s.setScale(scale);
    out.push(s);
  }
  return out;
}
