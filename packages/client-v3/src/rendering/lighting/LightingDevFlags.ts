/**
 * Typed accessor for the lighting system's `window.__LIGHTING_*__` dev flags.
 *
 * Ticket 24 — was the primitive-obsession + duplicated-code smell: 5 files
 * (`LightingPipeline`, `LightingPipelineUpdate`, `LightingAtmosphere`,
 * `LightingPipelineAtmosphere`, `GameSceneHelpers`) each opened their own
 * `(globalThis as unknown as { __LIGHTING_X__?: T })` cast for the 4+1
 * stringly-keyed globals. This module is the single typed accessor; every
 * site reads through it.
 *
 * The globals themselves are DEV-only runtime flips for the live A/B +
 * Playwright harness (Seam B/C): they're set on `window` from the browser
 * console or the harness driver, never in production code paths except this
 * accessor's reads. All flags are OPTIONAL + default-off (production) — the
 * accessor returns `undefined` for any unset flag, and each caller applies
 * its own default (e.g. `flags.atmosphere !== false` keeps the layer ON).
 */

/**
 * The shape of the lighting dev flags. All fields optional (every flag
 * defaults to "unset" — the production code path). Each field name matches
 * its `__LIGHTING_*__` global key (minus the prefix) for grep-ability.
 */
export interface LightingDevFlags {
  /** `__LIGHTING_TEST_LIGHTS__` — re-enable the tier-1 hardcoded test light. */
  testLights?: boolean;
  /** `__LIGHTING_ATMOSPHERE__` — hide/show the GPU-particle atmosphere layer. */
  atmosphere?: boolean;
  /**
   * `__LIGHTING_SHOW__` — debug show-mode override (0=lit, 1=albedo, 2=normals,
   * 3=lit-pre-tonemap).
   */
  show?: number;
  /**
   * `__LIGHTING_PURE_ADDITIVE__` (ticket 19) — flip to the OLD pure-additive
   * accumulation path (the Diablo III white-blob regression baseline).
   */
  pureAdditive?: boolean;
  /**
   * `__LIGHTING_CAPTURE_COMPARE__` (ticket 51) — run the OLD per-frame
   * full-display-list scan next to the incremental world-capture registry
   * every frame and record divergences (the correctness harness). Dev-only:
   * re-adds the full scan's cost while enabled.
   */
  captureCompare?: boolean;
  /**
   * `__LIGHTING_DIAG__` — registered by `bootLightingPipeline` as a function
   * (NOT a flag the lighting code reads; exposed here only so the type lives
   * in one place). The harness calls `window.__LIGHTING_DIAG__()` for the RT
   * glTexture-existence snapshot.
   */
  diag?: () => unknown;
}

/** The stringly-keyed globals as a single typed record (the runtime shape). */
interface LightingDevGlobals {
  __LIGHTING_TEST_LIGHTS__?: boolean;
  __LIGHTING_ATMOSPHERE__?: boolean;
  __LIGHTING_SHOW__?: number;
  __LIGHTING_PURE_ADDITIVE__?: boolean;
  __LIGHTING_CAPTURE_COMPARE__?: boolean;
  __LIGHTING_DIAG__?: () => unknown;
}

/**
 * Read the lighting dev flags from `globalThis`. Returns a typed snapshot —
 * every field is `undefined` unless the corresponding `__LIGHTING_*__`
 * global has been set on `window`. Pure (no mutation), so safe to call each
 * frame (the runtime flips are read live).
 */
export function getLightingDevFlags(): LightingDevFlags {
  const g = globalThis as unknown as LightingDevGlobals;
  return {
    testLights: g.__LIGHTING_TEST_LIGHTS__,
    atmosphere: g.__LIGHTING_ATMOSPHERE__,
    show: g.__LIGHTING_SHOW__,
    pureAdditive: g.__LIGHTING_PURE_ADDITIVE__,
    captureCompare: g.__LIGHTING_CAPTURE_COMPARE__,
    diag: g.__LIGHTING_DIAG__,
  };
}

/**
 * Set the `__LIGHTING_ATMOSPHERE__` flag (the one writer site, in
 * `LightingPipeline.setAtmosphereEnabled`). Centralized here so the global's
 * stringly key lives in one place; all other flags are read-only from the
 * lighting code's perspective (set externally by the harness/dev console).
 */
export function setAtmosphereDevFlag(enabled: boolean): void {
  (globalThis as unknown as LightingDevGlobals).__LIGHTING_ATMOSPHERE__ = enabled;
}

/**
 * Register the `__LIGHTING_DIAG__` snapshot accessor on `window` (the Seam
 * B/C harness calls `window.__LIGHTING_DIAG__()` for the RT glTexture-existence
 * snapshot). Centralized here so the global's stringly key lives in one place.
 */
export function registerLightingDiag(snapshot: () => unknown): void {
  (globalThis as unknown as LightingDevGlobals).__LIGHTING_DIAG__ = snapshot;
}
