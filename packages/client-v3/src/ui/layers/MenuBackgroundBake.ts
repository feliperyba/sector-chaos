/**
 * MenuBackgroundBake — the baked-layer machinery of the menu diorama: the
 * parallax scrollFactor/depth tuning (04 Scheme B / ticket 28 doc 19), the
 * camera drift tuning, and the `bakeLayer` RT bake. Mechanical extraction from
 * MenuBackground.ts (F8 file-length retirement) — bodies verbatim, only the
 * module boundary moved. The render output is byte-identical.
 *
 * ── Parallax — 5-layer Scheme B (ticket 28 / doc 19, verified by code inspection) ──
 *
 * 5 baked RTs at different `scrollFactor`s (far 0.45 / bg 0.70 / mid 1.00 /
 * fg=near 1.30 / fore 1.60), all at depth < 500 so `buildWorldCaptureList`
 * (`LightingAlbedoRtBuilder.ts:280`) captures them into the albedo RT. Per 04 +
 * doc 19: far/bg < 1.0 (slow), **MID = 1.0 (MANDATORY — all light anchors)**,
 * fg/fore > 1.0 (fast). Ticket 28 widened the sf band from 0.6 (0.7↔1.3) to
 * 1.15 (0.45↔1.60), roughly doubling the peak parallax separation. far/bg
 * carry a bake-time haze wash toward the ambient floor (`MENU_HAZE_COLOR`).
 *
 * **scrollFactor verification (load-bearing, per 04):** the shipped pipeline
 * had never been exercised with a captured object at `scrollFactor ≠ 1.0`. The
 * `drawWorldIntoAlbedo` path (`LightingAlbedoRtBuilder.ts:225-235`) routes
 * every captured GameObject through `RenderTextureWebGLRenderer` →
 * `ImageWebGLRenderer` → `TransformerImage`, which at
 * `TransformerImage.js:149-155` applies `camera.scrollX/Y *
 * gameObject.scrollFactorX/Y` via `copyWithScrollFactorFrom`. The same
 * transform pipeline that ships every sf=1.0 sprite honors sf≠1.0 baked RTs.
 * **Scheme B is verified by code inspection — no fallback to Scheme D needed.**
 *
 * The HdrLit shader reconstructs world pos assuming sf=1.0
 * (`LightingPipelineUpdate.ts:106-107`), so world-locked lights stay anchored
 * to the MID layer (where 02 mandates every light-anchor fixture lives). BG +
 * FG parallax around the lights — the desired depth read.
 *
 * ── Camera / drift (per 04 Scheme B parameters) ──
 *
 * The main camera is positioned at the stage-centered neutral **(64, 36)** so
 * the fire (world 1024, 256) lands at screen (960, 220) — directly behind the
 * logo (screen 960, 194). The drift is **both** (per 04 §0 user decision):
 *   - Idle sinusoidal baseline (small amplitude, slow).
 *   - Small pointer-derived offset (input-coupled; smoothed).
 * Vertical drift is capped to ±40px from neutral so the fire stays "behind"
 * the logo, never drifting below it.
 */
import type Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { TILE_SIZE, STAGE_W, STAGE_H, type MenuDioramaLayer } from './menuDioramaComposition.js';

// ─── Drift tuning (04 §2 — idle sinusoidal + small pointer offset) ───

/** Idle drift amplitude (px). Small + slow so the read is "breathing" not swim. */
export const IDLE_DRIFT_AMP_X = 8;
export const IDLE_DRIFT_AMP_Y = 4;
/** Idle drift frequencies (rad/ms) — different X/Y so the motion isn't a loop. */
export const IDLE_DRIFT_FREQ_X = 0.00028;
export const IDLE_DRIFT_FREQ_Y = 0.00041;
/**
 * Pointer parallax strength (0.02 = the pointer offset reaches ~±10px at the
 * viewport edge). Small on purpose — large pointer parallax reads as a bug.
 */
export const POINTER_STRENGTH = 0.02;
/** Smoothing factor for the pointer offset (higher = snappier, lower = dreamier). */
export const POINTER_SMOOTH = 0.08;
/**
 * Vertical drift cap (04 §2: ≤ ~40px). The total vertical drift from idle +
 * pointer combined is clamped to ±CAP from the neutral so the fire never
 * drifts far enough to read as "below" the logo instead of "behind" it.
 */
export const VERTICAL_DRIFT_CAP_PX = 40;

/**
 * Depth band for the baked RTs (ticket 28 / doc 19 §3 — 5-layer parallax).
 *
 * All depths are `< hudBg` (500) so `buildWorldCaptureList`
 * (`LightingAlbedoRtBuilder.ts:304`) captures every layer into the albedo RT.
 * far renders BEHIND bg (negative depth — Phaser honors it); fore at depth 5
 * clears `LIGHT_PROP_DEPTH` (4, `MenuDioramaLighting.ts:266`) so the silhouette
 * renders IN FRONT of the fire/prop sprites (the "looking through" frame), and
 * stays BELOW the additive atmosphere (400, `LightingAtmosphereConfig.ts:108`)
 * so embers drift across the dark frame. bg/mid/fg depths are UNCHANGED from
 * pre-ticket-28 (zero churn to the byte-pinned layers' render order).
 */
export const FAR_DEPTH = DesignTokens.depth.background - 1; // -1 (NEW — distant plane)
export const BG_DEPTH = DesignTokens.depth.background; // 0 (unchanged)
export const MID_DEPTH = DesignTokens.depth.background + 1; // 1 (unchanged — light anchors)
export const FG_DEPTH = DesignTokens.depth.background + 2; // 2 (unchanged — serves as 'near')
export const FORE_DEPTH = DesignTokens.depth.background + 5; // 5 (NEW — clears LIGHT_PROP_DEPTH 4)

// ─── Baking (Phaser side-effect — call once at boot) ───

/**
 * Stamp a layer's tiles into a fresh baked `RenderTexture` and add it to the
 * scene at the given depth + scrollFactor. The RT is stage-sized (2048×1152);
 * the baked content is static so it is NEVER redrawn after boot (resize does
 * NOT rebuild it — only the pipeline's viewport-sized RTs rebuild on resize,
 * via `LightingResizeHandler`).
 *
 * Mirrors `MapRenderer.renderStaticVisualLayers` (`MapRenderer.ts:332-388`):
 * temp sprites stamped via `rt.draw(sprite)`, then destroyed after `rt.render()`.
 */
export function bakeLayer(
  scene: Phaser.Scene,
  layer: MenuDioramaLayer,
  depth: number,
): Phaser.GameObjects.RenderTexture {
  const rt = scene.add.renderTexture(0, 0, STAGE_W, STAGE_H);
  rt.setOrigin(0, 0);
  rt.setDepth(depth);
  rt.setScrollFactor(layer.scrollFactor);

  const temps: Phaser.GameObjects.Sprite[] = [];
  for (const tile of layer.tiles) {
    const px = tile.col * TILE_SIZE + TILE_SIZE / 2;
    const py = tile.row * TILE_SIZE + TILE_SIZE / 2;
    const scale = tile.scale ?? 1;
    const sprite = scene.add.sprite(px, py, 'game', tile.frame).setOrigin(0.5).setScale(scale);
    // Ticket 26: optional per-tile orientation. `rotation` is degrees clockwise
    // (converted to radians — Phaser's `setRotation` is radians; mirrors
    // `MapRenderer.renderStaticVisualLayers` MapRenderer.ts:369 + the sibling
    // `LightPlacementTiled.rotation` consumption in LightPropRenderer.ts:309).
    // `flipH` uses `setFlipX` (decoupled from `setScale`/`setDisplaySize` below —
    // composes at render time). Both are omitted by every existing entry →
    // byte-identical rendering today (no visual change until ticket 27's
    // rotated rug corners).
    if (tile.rotation) sprite.setRotation((tile.rotation * Math.PI) / 180);
    if (tile.flipH) sprite.setFlipX(true);
    // The default sprite size is the source frame's pixel size; for tile-fill
    // frames we want them to occupy exactly TILE_SIZE×TILE_SIZE. Most `game`
    // tiles are already 128×128, but `setDisplaySize` keeps the layout
    // grid-aligned even when the source frame is a different size.
    if (scale === 1) {
      sprite.setDisplaySize(TILE_SIZE, TILE_SIZE);
    }
    temps.push(sprite);
  }

  rt.draw(temps);

  // ── Ticket 28 — bake-time atmospheric haze (doc 19 §2c, REUSE-ONLY). ──
  // A translucent `rt.fill(hazeColor, hazeAlpha)` overlay stamped AFTER the
  // tiles are drawn + BEFORE `rt.render()` flushes the command buffer. The fill
  // uses `source-over` at partial alpha (`DynamicTexture.js:397-401`) → it
  // BLENDS the baked albedo toward the haze color (the ambient floor
  // `MENU_HAZE_COLOR` = 0x473D2E), producing atmospheric perspective (far =
  // desaturated + lifted toward the warm-dark floor) in a single bake step.
  //
  // This is NOT a shader pass — it is a one-shot `rt.fill()` at boot, captured
  // into the albedo exactly as the tiles are. The pipeline sees ordinary
  // albedo; no uniform, no shader branch, no new light kind. `git diff` under
  // `rendering/lighting/` + `shaders/` stays EMPTY (the reuse-only proof).
  //
  // Applied to `far` (α≈0.28) + `bg` (α≈0.12) only — set via the layer's
  // `hazeColor`/`hazeAlpha` fields (omitted on mid/fg/fore → no wash → the
  // light anchors on mid stay clean + the fore silhouette's open center stays
  // transparent). The baked haze pixels SURVIVE the Canvas scrollFactor
  // collapse (`bootCanvasFallback` collapses the scrollFactor, not the baked
  // pixels — the atmospheric read degrades gracefully to single-plane).
  if (layer.hazeColor !== undefined && layer.hazeAlpha && layer.hazeAlpha > 0) {
    rt.fill(layer.hazeColor, layer.hazeAlpha);
  }

  rt.render();

  // Tear down the temp sprites — the RT now holds their rendered output.
  for (const sprite of temps) {
    sprite.destroy();
  }
  return rt;
}
