import type Phaser from 'phaser';

/**
 * On-screen FPS / frame-pacing overlay (C5 diagnosis). Fixed-position DOM div
 * OVER the canvas (pointer-events:none). DOM so it survives scene transitions
 * and costs ~zero render budget.
 *
 * ## Why this measures RENDER rate, not `game.loop.actualFps`
 * The first version read `game.loop.actualFps`, which — under `fps.target:60` —
 * reports the STEP/target rate (60) even when the GPU can only RENDER ~30
 * frames/sec. That made the overlay show a steady "60" while the user felt
 * clear 30fps jank in heavy areas, hiding the real problem. This version times
 * the `postrender` event (fires once per ACTUAL rendered frame) to compute the
 * true visible framerate. That number matches what the eye sees and what the
 * WalkDebugLog `dt` series records.
 *
 * ## Lines
 *  - `render`: true visible FPS, from postrender-to-postrender interval (smoothed).
 *  - `frame`:  the last render-to-render interval (ms).
 *  - `step`:   `game.loop.delta` — the delta PredictionService/Camera receive.
 *  - `jank/s`: rendered frames in the last second whose interval > 20ms.
 *  - `rAF`:    the display's requestAnimationFrame rate, measured independently.
 *
 * If `render ≈ rAF ≈ 60` and `jank/s ≈ 0`, the loop is keeping up and any
 * visible stutter is logic-side. If `render < rAF` (e.g. 30 < 60) or jank/s is
 * high, the client is render/CPU bound in that area.
 *
 * Toggle: auto-ON in DEV; `?fps=0` disables, `?fps=1` forces on (e.g. prod).
 */
const JANK_THRESHOLD_MS = 20;

export class FpsOverlay {
  private el: HTMLDivElement;
  private game: Phaser.Game;
  private lastRender = 0;
  private smoothedFrameMs = 16.7;
  private lastStepMs = 0;
  private jankFrames = 0;
  private jankWindowStart = performance.now();
  private displayedJank = 0;
  private displayedFps = 0;
  private fpsAccum = 0;
  private fpsCount = 0;
  private rafId = 0;
  private lastRaf = performance.now();
  private rafDelta = 16.7;

  constructor(game: Phaser.Game) {
    this.game = game;
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      zIndex: '99999',
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#00ff88',
      background: 'rgba(0,0,0,0.55)',
      padding: '5px 9px',
      borderRadius: '4px',
      pointerEvents: 'none',
      lineHeight: '1.4',
      whiteSpace: 'pre',
      border: '1px solid rgba(0,255,136,0.25)',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.el);

    const rafTick = (): void => {
      const now = performance.now();
      this.rafDelta = now - this.lastRaf;
      this.lastRaf = now;
      this.rafId = requestAnimationFrame(rafTick);
    };
    this.rafId = requestAnimationFrame(rafTick);

    // postrender fires once per ACTUAL rendered frame — the true visible rate.
    game.events.on('postrender', this.onRender, this);
    this.render();
  }

  private onRender = (): void => {
    const now = performance.now();
    const frameMs = this.lastRender > 0 ? now - this.lastRender : 16.7;
    this.lastRender = now;
    // Exponential smoothing of the frame interval (stable readout, ~1s time constant).
    this.smoothedFrameMs = this.smoothedFrameMs * 0.9 + frameMs * 0.1;
    this.lastStepMs = this.game.loop.delta || 0;
    const fps = 1000 / (this.smoothedFrameMs || 16.7);
    this.fpsAccum += fps;
    this.fpsCount++;

    if (frameMs > JANK_THRESHOLD_MS) this.jankFrames++;
    if (now - this.jankWindowStart >= 1000) {
      this.displayedJank = this.jankFrames;
      this.jankFrames = 0;
      this.jankWindowStart = now;
      this.displayedFps = this.fpsCount > 0 ? this.fpsAccum / this.fpsCount : fps;
      this.fpsAccum = 0;
      this.fpsCount = 0;
    }
    this.render();
  };

  private render(): void {
    const rafHz = 1000 / (this.rafDelta || 16.7);
    const fps = this.displayedFps || 1000 / (this.smoothedFrameMs || 16.7);
    this.el.textContent =
      `render ${fps.toFixed(1)} FPS\n` +
      `frame  ${this.smoothedFrameMs.toFixed(1)}ms\n` +
      `step   ${this.lastStepMs.toFixed(1)}ms\n` +
      `jank   ${this.displayedJank}/s\n` +
      `rAF    ${rafHz.toFixed(0)}Hz (${this.rafDelta.toFixed(1)}ms)`;
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.game.events.off('postrender', this.onRender, this);
    this.el.remove();
  }
}
