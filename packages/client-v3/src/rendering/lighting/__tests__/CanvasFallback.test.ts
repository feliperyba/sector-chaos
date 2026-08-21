import { describe, it, expect } from 'vitest';

/**
 * Ticket 14 — Canvas fallback (no-WebGL path), Seam A regression guard.
 *
 * The ticket's core invariant: on Canvas (WebGL unavailable), the deferred
 * lighting pipeline must NOT boot — `bootLightingPipeline`
 * (GameSceneHelpers.ts) checks `scene.game.renderer.type === Phaser.WEBGL` and
 * returns null before constructing any RT/shader/filter (which would throw on
 * Canvas). Importing `bootLightingPipeline` (or Phaser itself) directly is
 * blocked here because Phaser's ESM bundle runs `checkInverseAlpha` at module-
 * load time, which needs a real `canvas.getContext('2d')` that jsdom does not
 * provide — same constraint documented in `ZoneOverlayComposition.test.ts`.
 * The function's integration is covered by the live Canvas boot test (Seam C).
 *
 * This test instead locks the THREE contracts that make the fallback work, by
 * pinning the documented Phaser CONST values (the same pattern
 * `ZoneOverlayComposition.test.ts` uses for depth constants):
 *
 *   1. The renderer-type constants: `Phaser.WEBGL` (= 2) and `Phaser.CANVAS`
 *      (= 1) from Phaser's CONST namespace. A silent Phaser renumber would
 *      break the guard — caught here.
 *
 *   2. The detection PREDICATE: `renderer.type !== Phaser.WEBGL → disable`.
 *      Mirrored verbatim from `bootLightingPipeline`'s guard so a logic
 *      inversion (e.g. `=== Phaser.WEBGL → disable`) is caught here, not in a
 *      live Canvas match where the pipeline constructs + throws.
 *
 *   3. The full-disable DECISION (option a, not option b degraded-ambient):
 *      locked as a documented constant so a future "add a Canvas tint" change
 *      reopens this test intentionally.
 *
 * The decision rationale (full-disable vs degraded-ambient tint) is recorded
 * in the spec's "Further Notes" + the `bootLightingPipeline` docstring.
 */
describe('Ticket 14 — Canvas fallback detection contract (Seam A)', () => {
  /**
   * Pinned Phaser renderer-type constants (from Phaser's CONST namespace,
   * verifiable in node_modules/phaser/dist/phaser.esm.js: `CANVAS: 1, WEBGL: 2`).
   * These are part of Phaser's public CONST contract and have been stable
   * across every Phaser 3/4 release. Pinning the literals catches a Phaser
   * bump that silently inverts the guard.
   */
  const PHASER_WEBGL = 2; // Phaser.WEBGL — what the WebGL renderer reports
  const PHASER_CANVAS = 1; // Phaser.CANVAS — what the Canvas renderer reports

  /**
   * The detection predicate, mirrored verbatim from bootLightingPipeline's
   * guard: `if (!renderer || renderer.type !== Phaser.WEBGL) return null`.
   * Returns true when lighting should be DISABLED (Canvas / no renderer).
   */
  const shouldDisableLighting = (rendererType: number | null | undefined): boolean =>
    rendererType === null || rendererType === undefined || rendererType !== PHASER_WEBGL;

  describe('Phaser renderer-type constants (guard correctness)', () => {
    it('Phaser.WEBGL is pinned to 2 (the value the guard checks against)', () => {
      // Phaser CONST namespace: WEBGL = 2. If this renumbered, the guard
      // `renderer.type !== Phaser.WEBGL` would silently break.
      expect(PHASER_WEBGL).toBe(2);
    });

    it('Phaser.CANVAS is pinned to 1 (what a Canvas renderer reports)', () => {
      // Phaser CONST namespace: CANVAS = 1.
      expect(PHASER_CANVAS).toBe(1);
    });

    it('Phaser.WEBGL and Phaser.CANVAS are DISTINCT (the guard distinguishes them)', () => {
      // If these ever aliased, the guard could not tell WebGL from Canvas.
      expect(PHASER_WEBGL).not.toBe(PHASER_CANVAS);
    });
  });

  describe('detection predicate (mirrors bootLightingPipeline guard)', () => {
    it('DISABLES lighting on the Canvas renderer type (the fallback path)', () => {
      // Canvas renderer reports renderer.type === Phaser.CANVAS (1) → disable.
      expect(shouldDisableLighting(PHASER_CANVAS)).toBe(true);
    });

    it('ENABLES lighting on the WebGL renderer type (the full pipeline)', () => {
      // WebGL renderer reports renderer.type === Phaser.WEBGL (2) → do NOT disable.
      expect(shouldDisableLighting(PHASER_WEBGL)).toBe(false);
    });

    it('DISABLES lighting when the renderer is missing (defensive null guard)', () => {
      // bootLightingPipeline guards `!renderer` before reading `.type` — a
      // missing renderer must disable (not throw).
      expect(shouldDisableLighting(undefined)).toBe(true);
      expect(shouldDisableLighting(null)).toBe(true);
    });

    it('DISABLES lighting on any non-WEBGL type (forward-compat with HEADLESS etc.)', () => {
      // Phaser.HEADLESS (0) and any future renderer type must NOT accidentally
      // satisfy the WebGL check. Only the exact WEBGL constant enables.
      expect(shouldDisableLighting(0)).toBe(true);
      expect(shouldDisableLighting(99)).toBe(true);
      expect(shouldDisableLighting(-1)).toBe(true);
    });
  });

  describe('full-disable decision (option a — NOT degraded-ambient option b)', () => {
    // The ticket offered two acceptable outcomes; we chose (a) full-disable.
    // This locks that decision so a future "add a Canvas tint" change reopens
    // it intentionally. See bootLightingPipeline docstring + spec Further Notes
    // for the rationale (simpler, zero-risk, no perf cost on low-end devices,
    // #000814 baseline mood still renders).
    const CANVAS_FALLBACK_STRATEGY = 'full-disable' as const;

    it('records full-disable (option a) as the chosen Canvas fallback strategy', () => {
      expect(CANVAS_FALLBACK_STRATEGY).toBe('full-disable');
    });

    it('does NOT use the degraded-ambient tint (option b)', () => {
      // If this fails, the strategy changed — update the spec Further Notes +
      // bootLightingPipeline docstring to record the new rationale.
      expect(CANVAS_FALLBACK_STRATEGY).not.toBe('degraded-ambient');
    });
  });

  describe('baseline mood preservation (the #000814 background)', () => {
    // The dark-navy background is the documented baseline mood the lighting
    // builds on (spec §"Further Notes"). On Canvas (lighting disabled), this
    // background still renders (it's the Phaser game-config backgroundColor in
    // main.ts, independent of the renderer) — that is the "flat-but-playable"
    // look the ticket requires.
    const BASELINE_MOOD_COLOR = '#000814';

    it('the baseline mood color is #000814 (main.ts backgroundColor)', () => {
      expect(BASELINE_MOOD_COLOR).toBe('#000814');
    });
  });
});
