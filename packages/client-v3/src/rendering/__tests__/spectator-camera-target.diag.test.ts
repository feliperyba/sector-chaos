/**
 * Diagnostic probe — spectator camera jitter root cause (Bug 1).
 *
 * WHY THIS PROBE EXISTS:
 * In spectator mode the camera target was fed `stateSync.getPlayer(target).x/y`
 * — the RAW authoritative patch position, which only changes at PATCH_RATE
 * (30 Hz → every ~33 ms). Meanwhile the spectated player's SPRITE is driven by
 * `EntityInterpolator.getInterpolatedPosition` (67 ms delay + exponential
 * smoothing + velocity extrapolation) — a smoothly gliding stream. The camera
 * stair-stepped at patch rate on top of a smooth sprite → heavy jitter.
 *
 * This probe drives a REAL EntityInterpolator with a target moving at BASE_SPEED
 * and captures BOTH streams at the render cadence, then asserts the qualitative
 * difference that produces the jitter:
 *   - RAW stream: freezes for ~1 render frame between patches (zero delta), then
 *     jumps a full patch of travel (~14 px) on the patch frame. Stair-step.
 *   - INTERP stream: glides a small steady per-frame delta (~7 px) every frame.
 *
 * The fix routes the camera onto the INTERP stream (PlayerRenderer.
 * getRenderPosition, the same value InterpolationService writes to the sprite's
 * targetX/Y). This probe is the positive control that proves the raw stream is
 * the jitter source and the interp stream is smooth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntityInterpolator } from '../../prediction/EntityInterpolator.js';

const BASE_SPEED = 430; // PLAYER.BASE_SPEED — do not change (business rule).
const PATCH_RATE_HZ = 30; // NETWORK.PATCH_RATE — patches arrive every ~33.3 ms.
const PATCH_INTERVAL_MS = 1000 / PATCH_RATE_HZ;
const RENDER_INTERVAL_MS = 1000 / 60; // 60 Hz render cadence.

describe('Spectator camera target — raw patch stream vs interpolated stream', () => {
  let nowMs = 0;
  let perfSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Control the clock so push() (which stamps performance.now()) and
    // getInterpolatedPosition share one deterministic timeline.
    nowMs = 10_000;
    perfSpy = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => nowMs);
  });
  afterEach(() => perfSpy.mockRestore());

  /**
   * Drive the interpolator for `totalMs` at the render cadence, pushing a patch
   * every PATCH_INTERVAL_MS. Capture both the raw latest-patch position (what
   * stateSync.getPlayer().x returns today) and the interpolated position (what
   * the sprite — and after the fix the camera — consumes).
   */
  function simulate() {
    const interp = new EntityInterpolator();
    const out = { x: 0, y: 0 };
    let patchX = 1000;
    interp.push('target', patchX, 500, BASE_SPEED, 0);

    const rawDeltas: number[] = [];
    const interpDeltas: number[] = [];
    let lastPatchElapsed = 0;
    let lastRaw = patchX;
    let lastInterp = patchX;
    let haveInterp = false;
    const totalMs = 1000;

    for (let elapsed = RENDER_INTERVAL_MS; elapsed <= totalMs; elapsed += RENDER_INTERVAL_MS) {
      nowMs = 10_000 + elapsed;
      // Push a patch at the patch cadence (the target advances one patch of travel).
      if (elapsed - lastPatchElapsed >= PATCH_INTERVAL_MS - 0.5) {
        patchX += BASE_SPEED * (PATCH_INTERVAL_MS / 1000);
        interp.push('target', patchX, 500, BASE_SPEED, 0);
        lastPatchElapsed = elapsed;
      }
      const rawX = patchX; // latest pushed patch x
      const got = interp.getInterpolatedPosition('target', out, nowMs);
      rawDeltas.push(rawX - lastRaw);
      if (got) {
        if (haveInterp) interpDeltas.push(out.x - lastInterp);
        lastInterp = out.x;
        haveInterp = true;
      }
      lastRaw = rawX;
    }
    return { rawDeltas, interpDeltas };
  }

  it('RAW stream stair-steps: freezes between patches, then jumps a full patch', () => {
    const { rawDeltas } = simulate();
    const zeroFrames = rawDeltas.filter((d) => Math.abs(d) < 1e-6).length;
    const maxJump = Math.max(...rawDeltas.map((d) => Math.abs(d)));
    // Patches arrive every ~2 render frames, so ~half the frames sit on the
    // same patch value (zero delta) — the camera FREEZES between patches.
    expect(zeroFrames).toBeGreaterThan(15);
    // On the patch frame the raw target jumps a full patch of travel
    // (BASE_SPEED * patch_dt = 430/30 ≈ 14.33 px). This is the visible stair-step.
    expect(maxJump).toBeGreaterThan(13);
  });

  it('INTERP stream glides: a small steady per-frame delta every frame (no freezes)', () => {
    const { interpDeltas } = simulate();
    const zeroFrames = interpDeltas.filter((d) => Math.abs(d) < 1e-6).length;
    const maxJump = Math.max(...interpDeltas.map((d) => Math.abs(d)));
    const meanDelta = interpDeltas.reduce((a, b) => a + b, 0) / interpDeltas.length;
    // The interpolated output advances EVERY frame (velocity extrapolation +
    // smoothing) — essentially no zero-delta frames.
    expect(zeroFrames).toBeLessThan(3);
    // Per-frame delta is the steady glide (~BASE_SPEED * render_dt ≈ 7.17 px),
    // bounded — no patch-rate jumps.
    expect(meanDelta).toBeGreaterThan(5);
    expect(meanDelta).toBeLessThan(10);
    expect(maxJump).toBeLessThan(12);
  });

  it('RAW jitter dominates: raw max jump is much larger than interp max jump', () => {
    const { rawDeltas, interpDeltas } = simulate();
    const rawMax = Math.max(...rawDeltas.map((d) => Math.abs(d)));
    const interpMax = Math.max(...interpDeltas.map((d) => Math.abs(d)));
    // The raw stream's worst per-frame jump (the stair-step) is markedly larger
    // than the interpolated stream's worst — feeding raw to the camera is the
    // jitter source, feeding interp is smooth.
    expect(rawMax).toBeGreaterThan(interpMax + 2);
  });
});
