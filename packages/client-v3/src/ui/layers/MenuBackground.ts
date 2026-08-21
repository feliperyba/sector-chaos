/**
 * MenuBackground — the shared medieval diorama background for the menu screens
 * (ticket 06). Owns the baked curated-scene RT(s) per 02, the `LightingPipeline`
 * boot per 01, the parallax driver per 04, and the 05 (`MenuDioramaLighting`)
 * fire/aura/atmosphere wiring. The Canvas fallback stub keeps the menu from
 * going black on non-WebGL (ticket 09 owns full polish).
 *
 * ── The integration spine (consumes 01 + 02 + 04 + 05) ──
 *
 * Both `MainMenuScene` (06) and `MatchmakingUI` (08) consume THIS module. It
 * is a shared dependency, NOT a copy — 08 calls the same `boot` / `update` /
 * `destroy` lifecycle with a variant flag for any matchmaking-specific crop.
 *
 * ── Lifecycle ──
 *
 *   1. `new MenuBackground()` — stores options only (no Phaser work).
 *   2. `boot(scene)` — bakes the 5 parallax RTs (ticket 28: far/bg/mid/fg/fore),
 *      constructs the `LightingPipeline` (WebGL) or the Canvas fallback sprites,
 *      wires 05's fire/aura/atmosphere. Call ONCE after the scene's atlases are
 *      loaded (MainMenuScene.preload already loads `game` + light cookies via
 *      `loadAtlases`).
 *   3. `update(time, delta)` — per-frame: advance parallax drift →
 *      `menuDiorama.update(time, delta)` → `lighting.update(time/1000)`.
 *      Null-guarded: no-op on Canvas / before boot / after destroy.
 *   4. `destroy()` — tear down the 5 RTs + the pipeline + 05's prop sprites.
 *
 * ── Reuse only (hard constraint — do NOT extend shipped lighting) ──
 *
 * The `LightingPipeline` is constructed + driven via its PUBLIC API only:
 *   - `new LightingPipeline(scene, { tileSize })` (`LightingPipeline.ts:239`).
 *   - `lighting.shutdown()` on tear-down (`LightingPipeline.ts:461`).
 *
 * The 05 module owns ALL fire/prop/atmosphere wiring — `MenuBackground`
 * calls `menuDiorama.boot(scene, lighting, opts)` once + `menuDiorama.update`
 * before `lighting.update` (`update` is currently a retained no-op since the
 * WebGL aura was removed — see `MenuDioramaLighting.update` docstring).
 *
 * ── Parallax / camera drift / Canvas-fallback machinery ──
 *
 * The 5-layer parallax + scrollFactor verification notes, the drift tuning +
 * depth band, and the RT bake live in `MenuBackgroundBake.ts`; the ticket-09
 * Canvas fallback (tuning + pure spec helpers + the vignette bake + the
 * Canvas-branch boot/update bodies) lives in `MenuBackgroundCanvasFallback.ts`
 * (F8 mechanical extraction — behavior-identical).
 *
 * The UI (logo / buttons / fadeOverlay) lives at depth ≥ 500 (slot 0 via
 * `final.frag:162` `mix()`); `MainMenuScene` sets `setScrollFactor(0)` on the
 * title/button containers so the parallax scroll doesn't drag the UI along.
 * The choreographer's `camera.shake()` is a render-time offset independent of
 * `scrollX/Y` → survives the parallax untouched.
 *
 * Cosmetic only (GDD `docs/GDD.md:210` forbids fog of war): the diorama is
 * mood, never a visibility mechanic. The shipped ambient floor
 * `vec3(0.18,0.15,0.12)` (`LightingPipeline.ts:10`) keeps the scene legible.
 */
import Phaser from 'phaser';
import { LightingPipeline } from '../../rendering/lighting/LightingPipeline.js';
import { MenuDioramaLighting } from './MenuDioramaLighting.js';
import {
  getMenuDioramaComposition,
  getMenuDioramaPlacements,
  getMenuDioramaAuraAnchor,
  pickMenuDioramaVariant,
  TILE_SIZE,
  STAGE_W,
  STAGE_H,
  MENU_CAMERA_NEUTRAL_X,
  MENU_CAMERA_NEUTRAL_Y,
  type MenuDioramaVariantAuraAnchor,
  type MenuDioramaVariantId,
} from './menuDioramaComposition.js';
import {
  bakeLayer,
  FAR_DEPTH,
  BG_DEPTH,
  MID_DEPTH,
  FG_DEPTH,
  FORE_DEPTH,
  IDLE_DRIFT_AMP_X,
  IDLE_DRIFT_AMP_Y,
  IDLE_DRIFT_FREQ_X,
  IDLE_DRIFT_FREQ_Y,
  POINTER_STRENGTH,
  POINTER_SMOOTH,
  VERTICAL_DRIFT_CAP_PX,
} from './MenuBackgroundBake.js';
import { bootCanvasFallbackFor, updateCanvasAuraFor } from './MenuBackgroundCanvasFallback.js';

// Re-export the registry + pure helpers + constants so 08 (MatchmakingUI) and
// tests have a single import surface (`MenuBackground.ts`) for the whole module.
export {
  getMenuDioramaComposition,
  getMenuDioramaPlacements,
  getMenuDioramaAuraAnchor,
  getMenuDioramaVariant,
  getMenuDioramaTitlePalette,
  pickMenuDioramaVariant,
  MENU_DIORAMA_VARIANT_IDS,
  TILE_SIZE,
  STAGE_W,
  STAGE_H,
  MENU_CAMERA_NEUTRAL_X,
  MENU_CAMERA_NEUTRAL_Y,
  MENU_FAR_SCROLL_FACTOR,
  MENU_BG_SCROLL_FACTOR,
  MENU_MID_SCROLL_FACTOR,
  MENU_FG_SCROLL_FACTOR,
  MENU_NEAR_SCROLL_FACTOR,
  MENU_FORE_SCROLL_FACTOR,
  MENU_HAZE_COLOR,
} from './menuDioramaComposition.js';
export type {
  MenuDioramaTileEntry,
  MenuDioramaLayer,
  MenuDioramaVariantId,
  MenuDioramaVariantAuraAnchor,
  MenuDioramaVariant,
  MenuDioramaVariantRng,
  MenuDioramaTitlePalette,
} from './menuDioramaComposition.js';
// F8 extraction re-exports — bakeLayer + the Canvas-fallback public API moved
// to partials; re-exported here so every existing `from './MenuBackground.js'`
// import site (scenes + tests) compiles unchanged.
export { bakeLayer } from './MenuBackgroundBake.js';
export {
  computeCanvasAuraAlpha,
  computeCanvasAuraScaleMul,
  buildCanvasFallbackSpec,
  CANVAS_AURA_TEXTURE_KEY,
  CANVAS_AURA_TINT,
  CANVAS_AURA_FLICKER_SEED,
  CANVAS_AURA_BASE_ALPHA,
  CANVAS_AURA_FLICKER_AMP,
  CANVAS_AURA_DIAMETER,
  CANVAS_AURA_SCALE_AMP,
  CANVAS_VIGNETTE_TEXTURE_KEY,
  CANVAS_VIGNETTE_STRENGTH,
  CANVAS_VIGNETTE_COLOR,
} from './MenuBackgroundCanvasFallback.js';
export type { CanvasFallbackSpec } from './MenuBackgroundCanvasFallback.js';

// ─── Menu-specific lighting tuning (per-instance sobel + specular) ───
//
// The menu runs a SMALL set of hero fixtures (no scatter, no biome-glow), so
// the global sobel/specular (tuned for the dense gameplay scene) reads too flat
// here. These override the LightingPipeline per-instance so the diorama's
// fixtures get real surface relief (sobel) + a visible sheen (specular) without
// touching gameplay's pipeline (which omits both → global defaults 3.3 / 1.0).
// Tunable — nudge up for more relief/sheen, down if it reads noisy/plastic.
const MENU_SOBEL_STRENGTH = 5.5; // global SOBEL_STRENGTH is 3.3
const MENU_SPECULAR_SCALE = 1.5; // global specular scale is 1.0

// ─── Public module API ───

/** Variant for parameterization (ticket 08 reuses this for matchmaking). */
export type MenuBackgroundVariant = 'mainMenu' | 'matchmaking';

export interface MenuBackgroundOptions {
  /**
   * Visual variant. `mainMenu` (default) = full 2048×1152 diorama.
   * `matchmaking` (ticket 08) may crop/reframe — but the SAME module + the
   * SAME composition; 08 plugs its variant here instead of forking.
   */
  variant?: MenuBackgroundVariant;
}

/**
 * Owns the menu's lit medieval diorama: 5 baked parallax RTs (ticket 28:
 * far/bg/mid/fg/fore) + the `LightingPipeline` + 05's fire/aura/atmosphere +
 * the parallax camera driver.
 *
 * Construct → `boot(scene)` → `update(time, delta)` per frame → `destroy()`.
 * The Canvas fallback stub keeps the menu non-black on non-WebGL.
 */
export class MenuBackground {
  private readonly variant: MenuBackgroundVariant;

  /**
   * The diorama variant picked for this boot (ticket 14). Resolved once in
   * `boot` via `pickMenuDioramaVariant()` (random per boot = "rotates every
   * time the player opens the menu"). Stored for diagnostics (`getVariantId`)
   * + read by both the WebGL path + the Canvas fallback so they stay in sync.
   * With one registered variant today this is always `'forest-bonfire'`.
   */
  private variantId: MenuDioramaVariantId | null = null;

  private scene: Phaser.Scene | null = null;
  private booted = false;

  // WebGL path.
  private lighting: LightingPipeline | null = null;
  private menuDiorama: MenuDioramaLighting | null = null;

  // Both paths. Ticket 28: grew from 3 RTs to 5 (far + fore added; the fg RT
  // IS the 'near' RT — same sf 1.3, kept under its legacy name for zero churn).
  // F8: public (not private) so the extracted Canvas-fallback helpers in
  // MenuBackgroundCanvasFallback.ts can read/write them (MapSiegeCascade
  // precedent — `midRT` stays private: only this class touches it).
  farRT: Phaser.GameObjects.RenderTexture | null = null;
  bgRT: Phaser.GameObjects.RenderTexture | null = null;
  private midRT: Phaser.GameObjects.RenderTexture | null = null;
  fgRT: Phaser.GameObjects.RenderTexture | null = null;
  foreRT: Phaser.GameObjects.RenderTexture | null = null;

  // Canvas-fallback glow sprite (only on Canvas). Null on WebGL.
  canvasGlow: Phaser.GameObjects.Sprite | null = null;
  // Canvas-fallback vignette overlay (only on Canvas). Null on WebGL.
  canvasVignette: Phaser.GameObjects.Image | null = null;

  // Drift state.
  private pointerOffsetX = 0;
  private pointerOffsetY = 0;

  constructor(options: MenuBackgroundOptions = {}) {
    this.variant = options.variant ?? 'mainMenu';
  }

  /**
   * Boot the diorama. Bakes the 5 parallax RTs (ticket 28: far/bg/mid/fg/fore;
   * far/bg carry a bake-time haze wash), then either constructs the
   * `LightingPipeline` + wires 05's fire/aura/atmosphere (WebGL), or renders
   * the MID RT plain + a cheap campfire-glow sprite (Canvas fallback stub).
   * Call ONCE after the scene's `game` atlas is loaded (MainMenuScene.preload
   * already calls `loadAtlases(this)`).
   *
   * Idempotent-ish: a second call is a no-op (defensive against a double-boot).
   */
  boot(scene: Phaser.Scene): void {
    if (this.booted) return;
    this.scene = scene;
    this.booted = true;

    // ── Ticket 14: pick the diorama variant for this menu open (random per
    // boot = "rotates every time the player opens the menu"). Resolved ONCE
    // here so both the WebGL path + the Canvas fallback see the SAME variant
    // (consistent branding, in-sync aura anchor). With one registered variant
    // today this is always `'forest-bonfire'` (no visible change). ──
    this.variantId = pickMenuDioramaVariant();
    const composition = getMenuDioramaComposition(this.variantId);
    const placements = getMenuDioramaPlacements(this.variantId);
    const auraAnchor = getMenuDioramaAuraAnchor(this.variantId);

    // Position the camera at the stage-centered neutral on the FIRST frame so
    // the lit diorama is correctly framed before any drift kicks in. The
    // pipeline's albedo-RT camera mirrors this in `update()` per frame.
    scene.cameras.main.setScroll(MENU_CAMERA_NEUTRAL_X, MENU_CAMERA_NEUTRAL_Y);

    // Bake the 5 parallax RTs (ticket 28 / doc 19: far/bg/mid/fg/fore).
    // Pre-ticket-28 this was 3 (bg/mid/fg); far + fore were APPENDED (their
    // bakeLayer calls are the entire production change on the RT side — zero
    // pipeline involvement, verified by code inspection in doc 19 §0).
    // far/bg carry an optional bake-time haze wash (applied inside bakeLayer).
    const far = composition.find((l) => l.id === 'far')!;
    const bg = composition.find((l) => l.id === 'bg')!;
    const mid = composition.find((l) => l.id === 'mid')!;
    const fg = composition.find((l) => l.id === 'fg')!;
    const fore = composition.find((l) => l.id === 'fore')!;
    this.farRT = bakeLayer(scene, far, FAR_DEPTH);
    this.bgRT = bakeLayer(scene, bg, BG_DEPTH);
    this.midRT = bakeLayer(scene, mid, MID_DEPTH);
    this.fgRT = bakeLayer(scene, fg, FG_DEPTH);
    this.foreRT = bakeLayer(scene, fore, FORE_DEPTH);

    // ── WebGL guard (mirrors `GameSceneHelpers.bootLightingPipeline:228-236`):
    // bail to the Canvas fallback BEFORE constructing the pipeline (its ctor
    // throws on Canvas — `LightingPipeline.ts:158-159`). The early-bail keeps
    // the Canvas path zero-risk (ticket 09 polishes the degrade). ──
    const renderer = scene.game.renderer;
    if (!renderer || renderer.type !== Phaser.WEBGL) {
      this.bootCanvasFallback(scene, auraAnchor);
      return;
    }

    // ── WebGL path: construct the pipeline (01's adaptations). ──
    // `worldDepthCutoff` defaults to `DesignTokens.depth.hudBg` (500) — exactly
    // the band we want (the 5 baked RTs at depths −1/0/1/2/5 + LightPropRenderer
    // sprites at depth 4 + atmosphere at depth 400 are all captured; the
    // logo/buttons/overlay at depths 1001/1100 stay on slot 0).
    // NOTE: the logo/buttons are intentionally NOT captured into the albedo.
    // Capturing a flat text decal lit its face uniformly (albedo × light) which
    // read as a tinted WASH on top of the glyph, not as light from behind — the
    // "lit from under" impression is instead given by a warm backlight glow
    // seated behind the title in MainMenuScene (it floats over the pool).
    // Menu-specific sobel + specular: the menu runs a SMALL set of hero fixtures
    // (no scatter, no biome-glow), so the global sobel/specular (tuned for the
    // dense gameplay scene) reads too flat here. Override per-instance — a
    // stronger sobel gives the fixtures/diorama real surface relief, and a >1
    // specular scale makes the albedo-modulated sheen actually visible on them.
    // Gameplay's LightingPipeline omits these (uses the global defaults).
    const lighting = new LightingPipeline(scene, {
      tileSize: TILE_SIZE,
      sobelStrength: MENU_SOBEL_STRENGTH,
      specularScale: MENU_SPECULAR_SCALE,
    });
    this.lighting = lighting;

    // Wire 05's fire/aura/perimeter lights/atmosphere (boot AFTER the RTs +
    // pipeline exist — the prop sprites land on the scene at depth 4 < 500, so
    // the pipeline captures them into the albedo; `setPlacements` +
    // `setWorldBounds` are called inside 05's `boot`). Ticket 14: placements are
    // injected from the variant registry (the aura anchor is resolved separately
    // above for the Canvas fallback only — the WebGL aura was removed).
    this.menuDiorama = new MenuDioramaLighting();
    this.menuDiorama.boot(scene, lighting, {
      tileSize: TILE_SIZE,
      stageW: STAGE_W,
      stageH: STAGE_H,
      placements,
    });
  }

  /**
   * Canvas fallback (ticket 09) — body extracted to
   * `bootCanvasFallbackFor` (MenuBackgroundCanvasFallback.ts, F8 file-length
   * extraction). See that module for the full degrade rationale (collapsed
   * parallax + TorchFlicker aura glow + vignette + the no-black guarantee).
   */
  private bootCanvasFallback(scene: Phaser.Scene, auraAnchor: MenuDioramaVariantAuraAnchor): void {
    bootCanvasFallbackFor(this, scene, auraAnchor);
  }

  /**
   * Per-frame Canvas-branch aura drive (ticket 09 §2) — body extracted to
   * `updateCanvasAuraFor` (MenuBackgroundCanvasFallback.ts). Null-guarded —
   * safe before boot / after destroy / if the aura cookie was missing at boot.
   */
  private updateCanvasAura(time: number): void {
    updateCanvasAuraFor(this, time);
  }

  /**
   * Per-frame drive. Order matters:
   *   1. Advance parallax drift (camera scroll).
   *   2. `menuDiorama.update(time, delta)` — retained lifecycle hook (currently
   *      a no-op since the WebGL aura was removed; all per-frame light motion —
   *      campfire/support flicker + crystal pulse — now runs inside step 3).
   *   3. `lighting.update(time/1000)` — capture albedo, pack lights, render.
   *
   * Null-guarded: no-op before boot / after destroy / on Canvas (Canvas path
   * has no pipeline to drive; the drift is applied in step 1 so parallax still
   * works on Canvas).
   */
  update(time: number, _delta: number): void {
    if (!this.scene || !this.booted) return;
    this.applyParallaxDrift(time);

    // Retained 05 lifecycle call (no-op post-aura-removal). Kept BEFORE
    // lighting.update so any future per-frame menu-light work lands pre-pack.
    this.menuDiorama?.update(time, _delta);

    // Direct pipeline drive (01 §3 — skip `driveSceneLighting`, it pulls live
    // match state the menu does not have). `time/1000` matches GameScene.
    this.lighting?.update(time / 1000);

    // Canvas-fallback aura drive (ticket 09): the campfire TorchFlicker profile
    // pulses the aura's alpha + scale so the Canvas mood tracks the WebGL
    // campfire "roar" (replaces 06's dumb tween). No-op on WebGL — guarded by
    // isCanvasFallback() (lighting === null on Canvas). This is the ONLY Canvas
    // hook in update; the parallax drift above (applyParallaxDrift) is shared.
    if (this.isCanvasFallback()) {
      this.updateCanvasAura(time);
    }
  }

  /**
   * Position the main camera at neutral + idle + pointer drift. Vertical drift
   * is capped to ±VERTICAL_DRIFT_CAP_PX from neutral (04 §2) so the fire
   * stays "behind" the logo, never drifting below it.
   *
   * The pointer offset is smoothed (lerp toward target) so quick pointer
   * motion doesn't tear the backdrop. Read via `scene.input.activePointer` —
   * the user accepted the input-coupling trade-off (04 §0).
   */
  private applyParallaxDrift(time: number): void {
    const scene = this.scene;
    if (!scene) return;
    const cam = scene.cameras.main;

    // Idle sinusoidal baseline (small + slow, different X/Y frequencies).
    const idleX = Math.sin(time * IDLE_DRIFT_FREQ_X) * IDLE_DRIFT_AMP_X;
    const idleY = Math.sin(time * IDLE_DRIFT_FREQ_Y) * IDLE_DRIFT_AMP_Y;

    // Pointer offset (input-coupled parallax). Target = pointer displacement
    // from viewport center × POINTER_STRENGTH. Smoothed via lerp so the
    // backdrop doesn't snap on fast pointer motion.
    const pointer = scene.input.activePointer;
    if (pointer && cam.width > 0 && cam.height > 0) {
      const cx = cam.width / 2;
      const cy = cam.height / 2;
      const targetX = (pointer.x - cx) * POINTER_STRENGTH;
      const targetY = (pointer.y - cy) * POINTER_STRENGTH;
      this.pointerOffsetX += (targetX - this.pointerOffsetX) * POINTER_SMOOTH;
      this.pointerOffsetY += (targetY - this.pointerOffsetY) * POINTER_SMOOTH;
    }

    // Vertical drift cap (clamp the combined idle + pointer offset).
    const driftYRaw = idleY + this.pointerOffsetY;
    const driftYClamped = Math.max(
      -VERTICAL_DRIFT_CAP_PX,
      Math.min(VERTICAL_DRIFT_CAP_PX, driftYRaw),
    );

    cam.setScroll(
      MENU_CAMERA_NEUTRAL_X + idleX + this.pointerOffsetX,
      MENU_CAMERA_NEUTRAL_Y + driftYClamped,
    );
  }

  /**
   * Tear down the baked RTs + the pipeline + 05's prop sprites. Best-effort —
   * never throws (mirrors `LightingPipeline.shutdown` +
   * `MenuDioramaLighting.destroy`). Safe to call after a failed/partial boot.
   *
   * The pipeline's resize listener auto-unbinds on scene SHUTDOWN
   * (`LightingResizeHandler.ts:93`), so we don't double-unbind here.
   */
  destroy(): void {
    // 05 first (its prop sprites are scene children; tearing them down
    // explicitly clears the LightPropRenderer's tracked-sprite set).
    this.menuDiorama?.destroy();
    this.menuDiorama = null;

    // Pipeline (RTs / atmosphere / Final filter). Best-effort.
    try {
      this.lighting?.shutdown();
    } catch {
      // best-effort — shutdown errors are logged inside the pipeline.
    }
    this.lighting = null;

    // Canvas fallback glow + vignette.
    if (this.canvasGlow) {
      this.canvasGlow.destroy();
      this.canvasGlow = null;
    }
    if (this.canvasVignette) {
      this.canvasVignette.destroy();
      this.canvasVignette = null;
    }

    // Baked RTs (these are scene children; destroy them explicitly so a
    // re-boot doesn't leak — scene shutdown would also reap them).
    this.farRT?.destroy();
    this.bgRT?.destroy();
    this.midRT?.destroy();
    this.fgRT?.destroy();
    this.foreRT?.destroy();
    this.farRT = null;
    this.bgRT = null;
    this.midRT = null;
    this.fgRT = null;
    this.foreRT = null;

    this.scene = null;
    this.variantId = null;
    this.booted = false;
  }

  // ─── Diagnostics (read-only — exposed for ticket 10's verification pass) ───

  /** The booted pipeline (null on Canvas / before boot / after destroy). */
  getLighting(): LightingPipeline | null {
    return this.lighting;
  }

  /** The active variant (08's matchmaking variant returns its own). */
  getVariant(): MenuBackgroundVariant {
    return this.variant;
  }

  /**
   * The diorama variant id picked for this boot (ticket 14). Null before boot
   * / after destroy. Diagnostic — surfaces which rotated composition/placements
   * are active so a screenshot or log can identify the scene.
   */
  getVariantId(): MenuDioramaVariantId | null {
    return this.variantId;
  }

  /** True when the Canvas fallback is active (no pipeline). */
  isCanvasFallback(): boolean {
    return this.booted && this.lighting === null;
  }
}
