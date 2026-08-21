import { describe, it, expect, afterEach } from 'vitest';
import {
  getLightingDevFlags,
  setAtmosphereDevFlag,
  registerLightingDiag,
} from '../LightingDevFlags.js';

/**
 * Ticket 24 — LightingDevFlags Seam A. The typed accessor is the single place
 * the 4+1 `__LIGHTING_*__` globals are read; this pins its read/write shape +
 * the live-flip semantics (each call re-reads `globalThis`). Cosmetic-only
 * (the flags are DEV/harness A/B levers, never gameplay).
 */
describe('LightingDevFlags — typed accessor for the __LIGHTING_*__ globals (ticket 24)', () => {
  const g = globalThis as Record<string, unknown>;

  afterEach(() => {
    // Clean every flag between tests so each starts from the default-off state.
    delete g.__LIGHTING_TEST_LIGHTS__;
    delete g.__LIGHTING_ATMOSPHERE__;
    delete g.__LIGHTING_SHOW__;
    delete g.__LIGHTING_PURE_ADDITIVE__;
    delete g.__LIGHTING_DIAG__;
  });

  it('returns all-undefined when no flag is set (production default)', () => {
    const flags = getLightingDevFlags();
    expect(flags.testLights).toBeUndefined();
    expect(flags.atmosphere).toBeUndefined();
    expect(flags.show).toBeUndefined();
    expect(flags.pureAdditive).toBeUndefined();
    expect(flags.diag).toBeUndefined();
  });

  it('reflects a boolean flag set on globalThis (live read each call)', () => {
    g.__LIGHTING_TEST_LIGHTS__ = true;
    g.__LIGHTING_PURE_ADDITIVE__ = false;
    expect(getLightingDevFlags().testLights).toBe(true);
    expect(getLightingDevFlags().pureAdditive).toBe(false);
    // Live re-read: flipping after the first call is visible on the next.
    g.__LIGHTING_TEST_LIGHTS__ = false;
    expect(getLightingDevFlags().testLights).toBe(false);
  });

  it('reflects the numeric SHOW flag', () => {
    g.__LIGHTING_SHOW__ = 3;
    expect(getLightingDevFlags().show).toBe(3);
  });

  it('setAtmosphereDevFlag writes the __LIGHTING_ATMOSPHERE__ global (readable via accessor)', () => {
    setAtmosphereDevFlag(false);
    expect(getLightingDevFlags().atmosphere).toBe(false);
    expect(g.__LIGHTING_ATMOSPHERE__).toBe(false);
    setAtmosphereDevFlag(true);
    expect(getLightingDevFlags().atmosphere).toBe(true);
  });

  it('registerLightingDiag installs the snapshot function on __LIGHTING_DIAG__', () => {
    const snapshot = () => ({ ok: true });
    registerLightingDiag(snapshot);
    expect(getLightingDevFlags().diag).toBe(snapshot);
    expect((g.__LIGHTING_DIAG__ as () => unknown)()).toEqual({ ok: true });
  });
});
