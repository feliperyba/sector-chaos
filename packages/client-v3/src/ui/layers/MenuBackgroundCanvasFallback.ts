/**
 * MenuBackgroundCanvasFallback — the ticket-09 non-WebGL degrade: the Canvas
 * fallback tuning + pure helpers (unit-testable without WebGL) + the
 * createCanvasVignette bake + the extracted Canvas-branch class-method bodies
 * (`bootCanvasFallbackFor` / `updateCanvasAuraFor`). Mechanical extraction from
 * MenuBackground.ts (F8 file-length retirement) — bodies verbatim,
 * `this.→bg.` receiver substitution only (the MapSiegeCascade.ts precedent:
 * the owner exposes the fields these helpers need). The Canvas render output
 * is byte-identical.
 */
import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';
import { computeFlickerMulForKind } from '../../rendering/lighting/TorchFlicker.js';
import {
  TILE_SIZE,
  MENU_MID_SCROLL_FACTOR,
  type MenuDioramaVariantAuraAnchor,
} from './menuDioramaComposition.js';
import { FORE_DEPTH } from './MenuBackgroundBake.js';
import type { MenuBackground } from './MenuBackground.js';

// ─── Canvas fallback tuning (ticket 09 — non-WebGL degrade) ───
//
// The Canvas branch can't run the deferred pipeline (Sobel/HDR/bloom/vignette
// are WebGL-only). It degrades to: the baked backdrop RTs (plain quads) + a
// cheap TorchFlicker-driven campfire aura glow + a radial-gradient vignette
// overlay, with the multi-layer parallax collapsed to a single-plane drift.
// These constants + pure helpers are EXPORTED so the no-black invariant
// (backdrop non-empty, aura alpha always > 0, vignette present) is unit-
// testable without booting WebGL (the LightingPipeline import is WebGL-only
// under jsdom — see `MenuBackground.canvas.test.ts` for the mock seam).

/** Aura cookie texture key (loaded in MainMenuScene.preload). */
export const CANVAS_AURA_TEXTURE_KEY = 'light_01';
/** Aura warm tint — campfire-warm per ticket 09 spec (0xffcc66). */
export const CANVAS_AURA_TINT = 0xffcc66;
/**
 * Deterministic per-boot seed for the Canvas aura's campfire flicker. FIXED so
 * the glow "roars" deterministically (not a random shimmer) — mirrors how the
 * WebGL packer folds the campfire profile via a fixed per-light seed. Any fixed
 * value works; this one is stable across runs.
 */
export const CANVAS_AURA_FLICKER_SEED = 11.7;
/**
 * Aura alpha = BASE + AMP * flickerMul. Base 0.5 + amp 0.2 over the campfire
 * profile (TorchFlicker.ts:129-136, floor ~0.33 / flare ceiling ~1.6) yields an
 * alpha range of ~[0.567, 0.82] — a slow roar that NEVER hits 0 (no-black).
 */
export const CANVAS_AURA_BASE_ALPHA = 0.5;
export const CANVAS_AURA_FLICKER_AMP = 0.2;
/** Aura displayed diameter (px) — matches the WebGL aura radius×2 (640, 02 §4). */
export const CANVAS_AURA_DIAMETER = 640;
/** Aura scale breathing amplitude (subtle fire "swell"; ±~6% around the roar). */
export const CANVAS_AURA_SCALE_AMP = 0.06;
/** Vignette texture key (baked once via scene.textures.createCanvas). */
export const CANVAS_VIGNETTE_TEXTURE_KEY = '__menuCanvasVignette';
/** Vignette effective strength (~0.30 — matches final.frag's vignette feel). */
export const CANVAS_VIGNETTE_STRENGTH = 0.3;
/** Vignette edge color (`DesignTokens.color.nearBlack` — 0x111111, warm-dark). */
export const CANVAS_VIGNETTE_COLOR = DesignTokens.color.nearBlack;
/**
 * Aura depth — above the FORE silhouette (ticket 28 bumped this above
 * FORE_DEPTH so the glow renders in front of the dark frame on Canvas).
 * Still in the backdrop band (< UI 1001).
 */
const CANVAS_AURA_DEPTH = FORE_DEPTH + 1; // 6
/** Vignette depth — above all backdrop + aura + fore, below the UI band (1001+). */
const CANVAS_VIGNETTE_DEPTH = FORE_DEPTH + 2; // 7

/**
 * The Canvas aura alpha for a given frame time, driven by the campfire
 * TorchFlicker profile (`computeFlickerMulForKind('campfire', ...)`,
 * TorchFlicker.ts:272). Matches the WebGL campfire "roar" as closely as Canvas
 * allows — NOT a dumb tween. Pure + deterministic per (time, seed).
 *
 * `alpha = BASE + AMP * flickerMul`. The campfire profile's product floor is
 * ~0.334 (TorchFlicker.ts:129-136) so alpha floors at ~0.567 — the no-black
 * invariant (the glow is ALWAYS visible, never transparent). `timeMs` is the
 * Phaser `time` arg (ms → s for the flicker math).
 */
export function computeCanvasAuraAlpha(
  timeMs: number,
  seed: number = CANVAS_AURA_FLICKER_SEED,
): number {
  const mul = computeFlickerMulForKind('campfire', { t: timeMs / 1000, seed });
  return CANVAS_AURA_BASE_ALPHA + CANVAS_AURA_FLICKER_AMP * mul;
}

/**
 * The Canvas aura scale multiplier for a given frame time — a subtle breathing
 * (~±6%) that tracks the campfire roar (the glow "swells" on a gust). Pure +
 * deterministic. Multiplied by the base display diameter in `updateCanvasAura`.
 */
export function computeCanvasAuraScaleMul(
  timeMs: number,
  seed: number = CANVAS_AURA_FLICKER_SEED,
): number {
  const mul = computeFlickerMulForKind('campfire', { t: timeMs / 1000, seed });
  return 1 + CANVAS_AURA_SCALE_AMP * (mul - 1);
}

/**
 * The Canvas fallback plan as pure data (no Phaser). Exported so the no-black
 * invariant is unit-testable without booting WebGL (the class imports the
 * WebGL-only LightingPipeline). `bootCanvasFallbackFor` consumes this recipe; the
 * unit tests assert it never describes a black screen.
 */
export interface CanvasFallbackSpec {
  /**
   * Which baked RT layers the Canvas branch keeps visible (no-black base).
   * Ticket 28: grew from 3 (bg/mid/fg) to 5 (far/bg/mid/fg/fore) — all five
   * RTs collapse to MID's scrollFactor (single-plane drift) on Canvas.
   */
  readonly backdropLayerIds: readonly ('far' | 'bg' | 'mid' | 'fg' | 'fore')[];
  /** BG + FG scrollFactors are collapsed to this (== MID → single-plane drift). */
  readonly collapsedScrollFactor: number;
  /** The campfire aura glow config. */
  readonly aura: {
    readonly textureKey: string;
    readonly gridX: number;
    readonly gridY: number;
    readonly tint: number;
    readonly blendMode: 'ADD';
    readonly scrollFactor: number;
    readonly baseAlpha: number;
    readonly flickerAmp: number;
    readonly diameter: number;
  };
  /** The vignette overlay config. */
  readonly vignette: {
    readonly color: number;
    readonly strength: number;
    readonly scrollFactor: number;
  };
}

/**
 * Build the Canvas fallback plan (pure data — no Phaser, no side effects).
 * Describes: keep all 5 backdrop RTs visible (BG grass is the no-black base),
 * collapse their scrollFactors to MID's for a single-plane drift, place the
 * campfire aura glow at the **selected variant's** central-fire / aura anchor
 * (forest-bonfire = col 7.5, row 1.5 per 02 §4) with the warm tint + ADD blend
 * + TorchFlicker-driven alpha, and overlay a nearBlack radial vignette at
 * strength 0.30. See `bootCanvasFallbackFor` for the rationale.
 *
 * Ticket 14: `auraAnchor` is now a parameter (resolved from the variant
 * registry by `MenuBackground.boot`) so the Canvas fallback tracks the rotated
 * variant — pre-ticket-14 this was hardcoded to `CENTRAL_FIRE_COL/ROW`.
 */
export function buildCanvasFallbackSpec(
  auraAnchor: MenuDioramaVariantAuraAnchor,
): CanvasFallbackSpec {
  return {
    backdropLayerIds: ['far', 'bg', 'mid', 'fg', 'fore'],
    collapsedScrollFactor: MENU_MID_SCROLL_FACTOR,
    aura: {
      textureKey: CANVAS_AURA_TEXTURE_KEY,
      gridX: auraAnchor.gridX,
      gridY: auraAnchor.gridY,
      tint: CANVAS_AURA_TINT,
      blendMode: 'ADD',
      scrollFactor: MENU_MID_SCROLL_FACTOR,
      baseAlpha: CANVAS_AURA_BASE_ALPHA,
      flickerAmp: CANVAS_AURA_FLICKER_AMP,
      diameter: CANVAS_AURA_DIAMETER,
    },
    vignette: {
      color: CANVAS_VIGNETTE_COLOR,
      strength: CANVAS_VIGNETTE_STRENGTH,
      scrollFactor: 0,
    },
  };
}

/**
 * Bake a radial-gradient vignette into a `CanvasTexture` (once) and return it
 * as a screen-space `Image` overlay (scrollFactor 0 → doesn't drift with the
 * parallax camera). The `final.frag` vignette doesn't run on Canvas (ticket 09
 * §3), so the UI layer supplies one: transparent center → `edgeColor` at the
 * corners (half-diagonal radius so the corners go fully dark), sprite alpha =
 * `strength` (~0.30 → matches the WebGL feel). Drawn ABOVE the backdrop band,
 * BELOW the UI (depth `CANVAS_VIGNETTE_DEPTH`).
 *
 * Mirrors `ArmRenderer.ensureTexture` (`ArmRenderer.ts:36-47`) for the
 * `createCanvas` + `getContext` + `refresh` pattern. Best-effort: returns null
 * if `createCanvas` is unavailable (Canvas2D missing) — the backdrop + aura
 * still render, so no-black holds without the vignette.
 */
function createCanvasVignette(
  scene: Phaser.Scene,
  key: string,
  edgeColor: number,
  strength: number,
): Phaser.GameObjects.Image | null {
  const cam = scene.cameras.main;
  // Viewport-sized; fall back to the GDD desktop viewport (docs/GDD.md:206) if
  // the camera hasn't sized yet. NOTE: not rebuilt on resize — the WebGL
  // pipeline owns resize via LightingResizeHandler; the Canvas fallback is a
  // best-effort degrade (extreme resizes may slightly misframe the vignette —
  // flagged for ticket 10's visual gate).
  const w = cam.width > 0 ? cam.width : 1920;
  const h = cam.height > 0 ? cam.height : 1080;

  // Bake once per texture key (a matchmaking variant re-booting on the same
  // scene reuses the existing texture — createCanvas throws on a duplicate key).
  if (!scene.textures.exists(key)) {
    const canvas = scene.textures.createCanvas(key, w, h);
    if (!canvas) return null; // Canvas2D unavailable — degrade to no vignette.
    const ctx = canvas.getContext();
    const cx = w / 2;
    const cy = h / 2;
    const outer = Math.sqrt(cx * cx + cy * cy); // half-diagonal: corners fully dark.
    const inner = outer * 0.3; // transparent core covers the logo + button row.
    const r = (edgeColor >> 16) & 0xff;
    const g = (edgeColor >> 8) & 0xff;
    const b = edgeColor & 0xff;
    const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},1)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    canvas.refresh();
  }

  // scrollFactor 0 → screen-space (the overlay stays put while the parallax
  // camera drifts the backdrop). Origin (0,0) at screen (0,0) covers the
  // viewport; depth above the backdrop, below the UI.
  const img = scene.add.image(0, 0, key);
  img.setOrigin(0, 0);
  img.setScrollFactor(0);
  img.setDepth(CANVAS_VIGNETTE_DEPTH);
  img.setAlpha(strength);
  return img;
}

/**
 * Canvas fallback (ticket 09). The deferred pipeline can't run on non-WebGL
 * (its ctor throws — `LightingPipeline.ts:158-159`), so this branch degrades
 * the medieval diorama to a cheap, fully-usable, never-black scene:
 *
 *   1. Reduced parallax (ticket 09 §4, extended by ticket 28): collapse ALL
 *      non-MID RT scrollFactors (far + bg + fg + fore) to MID's (1.0) so all
 *      five RTs drift as a single plane. The multi-layer depth read depends
 *      on the deferred lighting (Sobel + HDR + bloom) which doesn't run on
 *      Canvas — the parallax divergence would add blit cost without its
 *      visual payoff. Single-plane drift keeps "life" (the shared
 *      `applyParallaxDrift` camera drift still breathes) at minimum cost.
 *      BG stays in the scene — its grass field is the NO-BLACK base (MID's
 *      tiles are sparse planks/paths/props; without BG the areas around the
 *      clearing would be the scene-clear color = black). The baked haze
 *      pixels on far/bg survive the collapse (ticket 28 — the atmospheric
 *      tint degrades into the single plane rather than vanishing).
 *   2. Cheap aura glow (ticket 09 §2): the `light_01` cookie as a plain
 *      warm-tinted additive sprite at the central-fire anchor (02 §4). No
 *      bloom, but the cookie's radial falloff gives the glow shape. Alpha +
 *      scale are driven per-frame by the campfire TorchFlicker profile
 *      (`updateCanvasAura`, replacing 06's dumb tween) so the Canvas mood
 *      tracks the WebGL campfire "roar" as closely as Canvas allows.
 *   3. Vignette overlay (ticket 09 §3): a radial-gradient dark-edge overlay
 *      (transparent center → nearBlack corners) — `final.frag`'s vignette
 *      doesn't run on Canvas, so the UI layer supplies one (~0.30 strength).
 *
 * No-black guarantee: BG (grass) + MID (clearing) always render; the aura
 * sprite always renders with a TorchFlicker-driven alpha floored at ~0.567
 * (never 0); the vignette is an overlay (alpha 0.30, never fully opaque).
 */
export function bootCanvasFallbackFor(
  bg: MenuBackground,
  scene: Phaser.Scene,
  auraAnchor: MenuDioramaVariantAuraAnchor,
): void {
  const spec = buildCanvasFallbackSpec(auraAnchor);

  // ── (1) Reduced parallax: collapse ALL non-MID RTs to MID's scrollFactor. ──
  // Ticket 28: grew from BG+FG to FAR+BG+FG+FORE (every non-MID RT). The
  // multi-layer depth read depends on the deferred lighting (Sobel + HDR +
  // bloom) which doesn't run on Canvas — the parallax divergence would add
  // blit cost without its visual payoff. Single-plane drift keeps "life"
  // (the shared `applyParallaxDrift` camera drift still breathes) at minimum
  // cost. The baked haze pixels on far/bg SURVIVE the collapse (collapsing
  // scrollFactor does not clear baked pixels — the atmospheric-perspective
  // tint degrades gracefully into the single plane). BG stays the no-black
  // base; MID's tiles stay anchored at sf=1.0 (the light-anchor invariant).
  bg.farRT?.setScrollFactor(spec.collapsedScrollFactor);
  bg.bgRT?.setScrollFactor(spec.collapsedScrollFactor);
  bg.fgRT?.setScrollFactor(spec.collapsedScrollFactor);
  bg.foreRT?.setScrollFactor(spec.collapsedScrollFactor);

  // ── (2) Cheap aura glow at the central-fire anchor (02 §4). ──
  const glowX = spec.aura.gridX * TILE_SIZE + TILE_SIZE / 2;
  const glowY = spec.aura.gridY * TILE_SIZE + TILE_SIZE / 2;
  if (scene.textures.exists(spec.aura.textureKey)) {
    const glow = scene.add.sprite(glowX, glowY, spec.aura.textureKey);
    glow.setOrigin(0.5, 0.5);
    glow.setTint(spec.aura.tint);
    glow.setBlendMode(Phaser.BlendModes.ADD);
    glow.setScrollFactor(spec.aura.scrollFactor);
    glow.setDepth(CANVAS_AURA_DEPTH);
    glow.setDisplaySize(spec.aura.diameter, spec.aura.diameter);
    // Seed the first frame (updateCanvasAura drives it from here). The alpha
    // floors at ~0.567 (campfire profile) — never 0 (no-black invariant).
    glow.setAlpha(computeCanvasAuraAlpha(0));
    bg.canvasGlow = glow;
  }

  // ── (3) Vignette overlay (final.frag's vignette doesn't run on Canvas). ──
  // Always created (independent of the aura cookie) — it's mood, not a
  // visibility gate (GDD docs/GDD.md:210 — no fog of war; center stays clear).
  bg.canvasVignette = createCanvasVignette(
    scene,
    CANVAS_VIGNETTE_TEXTURE_KEY,
    spec.vignette.color,
    spec.vignette.strength,
  );
}

/**
 * Per-frame Canvas-branch aura drive (ticket 09 §2). Sets the aura sprite's
 * alpha + display size from the campfire TorchFlicker profile so the glow
 * "roars" in lockstep with the (absent) WebGL campfire light. Replaces 06's
 * dumb tween. Called from `update` only when `isCanvasFallback()` is true
 * (no-op on WebGL). Null-guarded — safe before boot / after destroy / if the
 * aura cookie was missing at boot.
 */
export function updateCanvasAuraFor(bg: MenuBackground, time: number): void {
  const glow = bg.canvasGlow;
  if (!glow) return;
  glow.setAlpha(computeCanvasAuraAlpha(time));
  const breathe = computeCanvasAuraScaleMul(time);
  const d = CANVAS_AURA_DIAMETER * breathe;
  glow.setDisplaySize(d, d);
}
