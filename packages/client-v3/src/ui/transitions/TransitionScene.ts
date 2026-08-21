import Phaser from 'phaser';
import { SCENE_KEYS, TRANSITION_DURATION } from './TransitionConfig.js';
import { DesignTokens } from '../DesignTokens.js';
// The SINGLE-SOURCE transition shader (ticket 02): the GLSL lives in
// `src/shaders/transition.frag` and is inlined at build time via Vite's `?raw`
// import (same arrangement as the lighting pipeline's shaders — see
// `LightingShaders.ts`). The old runtime fetch of `public/shaders/
// transition.frag` was removed together with its duplicate public copy, so
// shader edits can no longer land in a dead file.
import transitionFrag from '../../shaders/transition.frag?raw';

type TransitionPhase = 'idle' | 'covering' | 'holding' | 'revealing';

interface PendingTransition {
  targetScene: string;
  data?: object;
  scenesToStop?: string[];
}

const AUTO_REVEAL_TIMEOUT = 5000;

/** Standalone texture key the ShaderQuad binds as iChannel0. */
const WATERMARK_TEXTURE_KEY = 'ui_tex_watermark_doodle';
/** Atlas + frame the doodle is extracted from at runtime (single art source). */
const WATERMARK_ATLAS_KEY = 'ui';
const WATERMARK_FRAME_KEY = 'watermark_doodle';

// ── Owner taste knobs (ticket 02 — retune in-browser) ──────────────────────
// The doodle art is BLACK strokes on WHITE paper (1024x1024 `ui` atlas frame),
// so the shader INVERTS the sample: the white paper maps to the near-black
// base color and the black strokes lift toward the graphite doodle tint. Both
// mix endpoints stay low-luminance so the wipe still reads black overall.
/** Cell floor — the near-black base of the wipe (#050506). */
const WATERMARK_BASE_COLOR: readonly [number, number, number] = [0.02, 0.02, 0.024];
/** Doodle stroke tint at full contrast (#262630 — cool graphite on black). */
const WATERMARK_DOODLE_COLOR: readonly [number, number, number] = [0.149, 0.149, 0.188];
/**
 * Doodle tiles across the screen's biggest dimension. 10.0 = phase-locked to
 * the shader's 10-division diamond grid (one doodle tile per wipe cell, no
 * beat pattern between the two grids); 8.0 was the pre-ticket value (bigger,
 * unaligned tiles).
 */
const WATERMARK_TILING = 10.0;
/**
 * Contrast smoothstep window on the inverted sample luminance: paper grain
 * below the floor is crushed to the flat base, stroke cores above the ceiling
 * get the full doodle tint, anti-aliased stroke edges ramp between.
 */
const WATERMARK_CONTRAST_FLOOR = 0.35;
const WATERMARK_CONTRAST_CEIL = 0.85;

export class TransitionScene extends Phaser.Scene {
  private phase: TransitionPhase = 'idle';
  private shader: Phaser.GameObjects.Shader | null = null;
  private inputBlocker!: Phaser.GameObjects.Rectangle;
  private pending: PendingTransition | null = null;
  private revealRequested = false;
  private autoRevealTimer: Phaser.Time.TimerEvent | null = null;
  private progress = 0;
  private elapsedTime = 0;
  private duration = 0;

  constructor() {
    super({ key: SCENE_KEYS.TRANSITION, active: false });
  }

  create(): void {
    // Phaser 4 does NOT auto-invoke the Scene's `shutdown` method (only
    // `update` is auto-bound). Bind explicitly so the shader/resize teardown in
    // `shutdown()` below actually runs on scene stop (MainMenuScene +
    // MatchmakingScene bind the same way; GameScene.ts:358 is the reference).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);

    const { width, height } = this.scale;
    this.phase = 'idle';
    this.progress = 0;
    this.elapsedTime = 0;
    this.pending = null;
    this.revealRequested = false;

    // Create the diamond wipe shader. Ticket 14 Canvas fallback: this is a
    // WebGL-only GameObject (`add.shader` → ShaderQuad reads
    // `renderer.renderNodes`, undefined on Canvas → throws on construction).
    // On Canvas we skip the shader entirely — `inputBlocker` below already
    // provides the transition's load-bearing function (a solid cover that
    // hides the scene swap), so transitions work flat-but-functionally. The
    // shader is purely the cosmetic diamond-wipe (loss on Canvas = no wipe
    // animation, NOT a gameplay/visibility change). `this.shader` is null on
    // Canvas and every later use is null-guarded (`if (this.shader)`).
    // Ticket 02: the GLSL comes from the bundled `?raw` import (no shader
    // cache, so no dependency on another scene's preload having run), and the
    // second gate is the watermark texture — the ShaderQuad binds
    // iChannel0 by STANDALONE texture key, which `ensureWatermarkTexture`
    // registers by extracting the `ui`/`watermark_doodle` atlas frame to a
    // canvas texture (an unregistered key silently binds the __MISSING
    // texture — the pre-ticket bug where the doodle never showed).
    const isWebGL = this.game.renderer?.type === Phaser.WEBGL;
    if (isWebGL && this.ensureWatermarkTexture()) {
      this.shader = this.add.shader(
        {
          name: 'TransitionShader',
          fragmentSource: transitionFrag,
          setupUniforms: (setUniform: (name: string, value: unknown) => void) => {
            setUniform('uProgress', this.progress);
            setUniform('uDirection', this.phase === 'revealing' ? 0.0 : 1.0);
            setUniform('uResolution', [width, height]);
            setUniform('uBaseColor', WATERMARK_BASE_COLOR);
            setUniform('uDoodleColor', WATERMARK_DOODLE_COLOR);
            setUniform('uContrastFloor', WATERMARK_CONTRAST_FLOOR);
            setUniform('uContrastCeil', WATERMARK_CONTRAST_CEIL);
            setUniform('uTiling', WATERMARK_TILING);
            setUniform('iChannel0', 0);
            setUniform('uTime', (this.time.now % 60000) / 1000);
          },
        },
        0,
        0,
        width,
        height,
        [WATERMARK_TEXTURE_KEY],
      );
      this.shader.setOrigin(0, 0);
      this.shader.setDepth(DesignTokens.depth.overlay);
      this.shader.setScrollFactor(0);
      this.shader.setVisible(false);
    }

    // Input blocker sits above the shader to eat all pointer events during transition
    this.inputBlocker = this.add.rectangle(
      width / 2,
      height / 2,
      width,
      height,
      DesignTokens.colors.black,
      0,
    );
    this.inputBlocker.setDepth(DesignTokens.depth.top);
    this.inputBlocker.setScrollFactor(0);
    this.inputBlocker.setInteractive();
    this.inputBlocker.setVisible(false);

    this.scale.on('resize', this.handleResize, this);
  }

  /**
   * Register the watermark doodle as a STANDALONE texture the ShaderQuad can
   * bind (ticket 02). The art exists only as the `ui` atlas frame
   * `watermark_doodle` (1024x1024), and `add.shader(channels)` binds
   * standalone texture keys — never atlas frames — so the frame is blitted to
   * an offscreen canvas and registered via `addCanvas` (same route as the
   * menu's `logo_generated` canvas texture; `WeaponShatterVFX` uses the same
   * cutX/Y/Width/Height source-crop for atlas frames).
   *
   * Chosen over extracting a `watermark_doodle.png` build artifact: the
   * runtime extraction always tracks the live atlas (no duplicate binary to
   * drift when the atlas is re-packed), adds no network request, and needs no
   * pipeline step. The canvas is pre-filled WHITE before the blit because the
   * doodle is black-on-white — if the atlas paper ever becomes transparent,
   * the shader's inverted-luminance read stays well-defined.
   *
   * Idempotent and cached for the session (the global TextureManager is shared
   * across scenes; this scene stops/launches per transition). Returns false
   * when the atlas/frame is unavailable (exotic entry paths) — the caller then
   * skips the shader, and the plain-cover Canvas fallback path takes over.
   */
  private ensureWatermarkTexture(): boolean {
    if (this.textures.exists(WATERMARK_TEXTURE_KEY)) return true;

    if (!this.textures.exists(WATERMARK_ATLAS_KEY)) return false;
    const atlas = this.textures.get(WATERMARK_ATLAS_KEY);
    if (!atlas.has(WATERMARK_FRAME_KEY)) return false;

    const frame = atlas.get(WATERMARK_FRAME_KEY);
    const source = frame.texture.getSourceImage() as HTMLImageElement | null;
    if (!source) return false;

    const canvas = document.createElement('canvas');
    canvas.width = frame.cutWidth;
    canvas.height = frame.cutHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The frame lives inside the whole `ui` atlas PNG — source-crop to just
    // this frame's cut region before blitting (otherwise the entire atlas
    // leaks into the pattern).
    ctx.drawImage(
      source,
      frame.cutX,
      frame.cutY,
      frame.cutWidth,
      frame.cutHeight,
      0,
      0,
      frame.cutWidth,
      frame.cutHeight,
    );

    this.textures.addCanvas(WATERMARK_TEXTURE_KEY, canvas);
    return true;
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    if (this.shader) {
      this.shader.setSize(width, height);
    }
    this.inputBlocker.setPosition(width / 2, height / 2);
    this.inputBlocker.setSize(width, height);
  }

  startTransition(targetScene: string, data?: object, scenesToStop?: string[]): void {
    if (this.phase !== 'idle') return;

    this.pending = { targetScene, data, scenesToStop };
    this.revealRequested = false;
    this.phase = 'covering';
    this.progress = 0;
    this.elapsedTime = 0;
    this.duration = TRANSITION_DURATION.COVER;

    this.inputBlocker.setVisible(true);

    if (this.shader) {
      this.shader.setVisible(true);
    }
  }

  private enterHoldPhase(): void {
    this.phase = 'holding';

    if (!this.pending) return;

    const { targetScene, data, scenesToStop } = this.pending;

    // Stop explicitly listed scenes
    if (scenesToStop) {
      for (const key of scenesToStop) {
        if (this.scene.isActive(key)) {
          this.scene.stop(key);
        }
      }
    }

    // Stop ALL other active scenes except the target and ourselves.
    // This prevents the source scene (e.g. MainMenuScene) from being
    // visible during the reveal when the target scene hasn't rendered yet.
    for (const key of Object.values(SCENE_KEYS)) {
      if (key === SCENE_KEYS.TRANSITION || key === targetScene) continue;
      if (scenesToStop?.includes(key)) continue; // already stopped above
      if (this.scene.isActive(key)) {
        this.scene.stop(key);
      }
    }

    this.scene.launch(targetScene, data);
    this.scene.bringToTop(SCENE_KEYS.TRANSITION);

    this.autoRevealTimer = this.time.delayedCall(AUTO_REVEAL_TIMEOUT, () => {
      if (this.phase === 'holding') {
        this.doReveal();
      }
    });

    if (this.revealRequested) {
      this.time.delayedCall(TRANSITION_DURATION.HOLD_BUFFER, () => {
        if (this.phase === 'holding') {
          this.doReveal();
        }
      });
    }
  }

  requestReveal(): void {
    if (this.phase === 'revealing' || this.phase === 'idle') return;

    this.revealRequested = true;

    if (this.phase === 'holding') {
      this.doReveal();
    }
  }

  private doReveal(): void {
    if (this.phase !== 'holding') return;
    this.phase = 'revealing';
    this.progress = 0;
    this.elapsedTime = 0;
    this.duration = TRANSITION_DURATION.REVEAL;

    if (this.autoRevealTimer) {
      this.autoRevealTimer.destroy();
      this.autoRevealTimer = null;
    }
  }

  update(_time: number, delta: number): void {
    if (this.phase === 'idle') return;

    this.elapsedTime += delta;
    this.progress = Math.min(this.elapsedTime / this.duration, 1.0);

    if (this.phase === 'covering' && this.progress >= 1.0) {
      this.enterHoldPhase();
    } else if (this.phase === 'revealing' && this.progress >= 1.0) {
      this.resetToIdle();
    }
  }

  private resetToIdle(): void {
    this.phase = 'idle';
    this.pending = null;
    this.revealRequested = false;
    this.inputBlocker.setVisible(false);

    if (this.shader) {
      this.shader.setVisible(false);
    }
    if (this.autoRevealTimer) {
      this.autoRevealTimer.destroy();
      this.autoRevealTimer = null;
    }
  }

  isTransitioning(): boolean {
    return this.phase !== 'idle';
  }

  shutdown(): void {
    this.resetToIdle();
    if (this.shader) {
      this.shader.destroy();
      this.shader = null;
    }
    this.scale.off('resize', this.handleResize, this);
  }
}
