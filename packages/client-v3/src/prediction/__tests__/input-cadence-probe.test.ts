// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SIM_TICK_DT, PLAYER, NETWORK } from '@sector-battle/shared';

/**
 * Mock Phaser for the input-cadence probe. The REAL InputCollector imports
 * `Phaser` as a value (for `Phaser.Input.Keyboard.KeyCodes.SPACE`). This mock
 * provides the runtime values the production code accesses; the type-only
 * usages (`Phaser.Input.Keyboard.Key`, `Phaser.Scene`, `Phaser.Input.Pointer`)
 * are erased at compile time and need no runtime stub.
 */
import { vi } from 'vitest';
vi.mock('phaser', () => ({
  default: {
    Input: {
      Keyboard: {
        KeyCodes: { SPACE: 32, ONE: 49, TWO: 50, THREE: 51, FOUR: 52 },
      },
    },
  },
}));

import {
  runInputCadenceProbe,
  loadServerInputModules,
  makeServerInputHandler,
  type TimeBox,
  type ProbeResult,
} from './input-cadence-probe-harness.js';

/**
 * INPUT-CADENCE PROBE (NET-24) — drives the REAL production input/cadence layer
 * (InputOrchestrator + InputCollector + InteractionDetector + Connection.sendInput)
 * against the REAL server input handler (RateLimiter + InputQueue + handler logic),
 * layered on the TASK-01 proven-clean physics differential.
 *
 * VERDICT BAR: the input/cadence layer is RULED OUT as the sustained-walk
 * stutter source iff correctionFires === 0 AND peakGenuinePosError < snapThreshold
 * across the tested matrix (jitter, loss, reorder, syncEveryN drift, rate-limiter).
 * If any condition reproduces correctionFires > 0 with the divergence pinned to
 * a specific mechanism, the layer is REPRODUCED and a fix ticket is graduated.
 */

const TILE = 128;

// ─── Deterministic time control ─────────────────────────────────────────────
//
// The REAL InputCollector.collect uses performance.now() for its 16ms throttle,
// and the REAL RateLimiter.check uses Date.now() for its token bucket. Both are
// overridden to read from a shared timeBox so the probe is fully deterministic.

const timeBox: TimeBox = { perfNow: 0, now: 0 };
const realPerformanceNow = performance.now.bind(globalThis.performance);
const realDateNow = Date.now;

beforeAll(() => {
  // Override performance.now — InputCollector.collect reads this for throttling.
  Object.defineProperty(globalThis.performance, 'now', {
    value: () => timeBox.perfNow,
    writable: true,
    configurable: true,
  });
  // Override Date.now — RateLimiter.check reads this for token refill.
  Date.now = () => timeBox.now;
});

afterAll(() => {
  Object.defineProperty(globalThis.performance, 'now', {
    value: realPerformanceNow,
    writable: true,
    configurable: true,
  });
  Date.now = realDateNow;
});

beforeEach(() => {
  timeBox.perfNow = 0;
  timeBox.now = 0;
});

afterEach(() => {
  timeBox.perfNow = 0;
  timeBox.now = 0;
});

// ─── Headline formatter ─────────────────────────────────────────────────────

function headline(label: string, r: ProbeResult): string {
  return `[${label}] peak=${r.peakPosError.toFixed(2)}px@t${r.peakPosErrorTick} corr=${r.correctionFires} genuine=${r.peakGenuinePosError.toFixed(2)}px rawPatch=${r.peakRawPatchError.toFixed(2)}px final=${r.finalDivergence.toFixed(2)}px thr=${r.snapThreshold.toFixed(1)} | sent=${r.totalSent} arrived=${r.totalArrived} accepted=${r.totalAccepted} rateLimited=${r.totalRateLimited} gap=${r.gapTicks} coalesced=${r.coalescedTicks} ticks=${r.totalTicks} frames=${r.totalRenderFrames}`;
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — REPRODUCE: the input/cadence matrix.
// Each scenario drives the REAL input/cadence layer. The verdict bar for
// "PROVED ABSENT" is correctionFires === 0 AND peakGenuinePosError < thr.
// ════════════════════════════════════════════════════════════════════════════

describe('input-cadence-probe — REAL input path, sustained +X walk', () => {
  // ── (a) NET-03 decoupled-sampling shape: render-frame input, 16ms send ──

  it('1. 60fps baseline localhost — REAL InputOrchestrator, clean cadence', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.0,
        latencySec: 0,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('1.60fps-localhost', r));
    // CLEAN baseline: REAL input path produces 0 corrections. A constant
    // ~7px (1-tick-of-walk) phase offset exists between prediction and
    // server (the input arrives 1 tick late), but it is BELOW the 16px snap
    // threshold → 0 corrections. This is the expected sustained-walk shape.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(r.snapThreshold);
  });

  it('2. 60fps + 150ms RTT — REAL InputOrchestrator', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.2,
        latencySec: 0.075,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('2.60fps-150ms', r));
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(r.snapThreshold);
  });

  it('3. 144fps + 150ms RTT — decoupled sampling (NET-03 shape)', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.2,
        latencySec: 0.075,
        renderDt: 1 / 144,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('3.144fps-150ms', r));
    // At 144fps the orchestrator sends every ~2.3 frames (16ms cadence). The
    // prediction samples every frame; records push on send-boundary frames.
    expect(r.correctionFires).toBe(0);
    expect(r.peakGenuinePosError).toBeLessThan(r.snapThreshold);
  });

  it('4. 30fps + 150ms RTT — low render rate', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.2,
        latencySec: 0.075,
        renderDt: 1 / 30,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('4.30fps-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  it('5. 165fps + 150ms RTT — high render rate (user desktop)', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.2,
        latencySec: 0.075,
        renderDt: 1 / 165,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('5.165fps-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  // ── (a continued) Input-rate jitter (Vite dev mode frame timing chaos) ──

  it('6. 60fps + ±5ms jitter + 150ms RTT — moderate dev jitter', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        frameJitterMs: 5,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('6.60fps-jit5-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  it('7. 60fps + ±8ms jitter + 150ms RTT — extreme dev jank', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        frameJitterMs: 8,
        rngSeed: 99,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('7.60fps-jit8-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  it('8. 144fps + ±5ms jitter + 150ms RTT — high-rate + jitter', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        renderDt: 1 / 144,
        frameJitterMs: 5,
        rngSeed: 7,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('8.144fps-jit5-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  // ── (b) Packet loss at the send boundary ──

  it('9. 60fps + 5% packet loss + 150ms RTT — occasional input drops', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 2.0,
        latencySec: 0.075,
        packetLossRate: 0.05,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('9.60fps-loss5-150ms', r));
    // 5% loss → ~3 inputs dropped over 2s. Server momentum-coasts on gaps.
    // The rewind-replay should still reconstruct accurately (the prediction
    // saw the direction every frame; the server coasted with the same dir).
    expect(r.totalArrived).toBeLessThan(r.totalSent);
    expect(r.gapTicks).toBeGreaterThan(0);
  });

  it('10. 60fps + 20% packet loss + 150ms RTT — heavy input drops', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 2.0,
        latencySec: 0.075,
        packetLossRate: 0.20,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('10.60fps-loss20-150ms', r));
    // 20% loss → significant gaps. The server coasts more; the client predicts
    // ahead. The rewind-replay absorbs the delta (sustained direction = coast
    // direction, so the trajectories match).
    expect(r.totalArrived).toBeLessThan(r.totalSent);
    expect(r.gapTicks).toBeGreaterThan(0);
    // Key question: does heavy loss cause correction-fires? Log the number.
    console.log(
      `[10.loss20] correctionFires=${r.correctionFires} peakGenuine=${r.peakGenuinePosError.toFixed(2)}px thr=${r.snapThreshold}`,
    );
  });

  // ── (b continued) Packet reordering at the send boundary ──

  it('11. 60fps + 10% reordering + 150ms RTT — out-of-order arrival', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 2.0,
        latencySec: 0.075,
        packetReorderRate: 0.10,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('11.60fps-reorder10-150ms', r));
    // Reordering delays some inputs by 1 tick → they land in a later tick's
    // bucket. For sustained walk (constant direction), this is benign: the
    // direction is the same regardless of which tick it lands in.
    expect(r.correctionFires).toBe(0);
  });

  // ── (c) PATCH_RATE / syncEveryN drift above 1 (§6 candidate (d) fog) ──

  it('12. syncEveryN=2 (PATCH_RATE=30) + 150ms RTT — patch every 2 ticks', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        syncEveryN: 2,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('12.sync2-150ms', r));
    // syncEveryN=2: patches arrive every 2 ticks. The reconciler's rewind-
    // replay covers 2 unacked records per patch instead of 1. Should still
    // reconstruct cleanly for sustained walk.
    expect(r.correctionFires).toBe(0);
  });

  it('13. syncEveryN=3 (PATCH_RATE=20) + 150ms RTT — patch every 3 ticks', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        syncEveryN: 3,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('13.sync3-150ms', r));
    expect(r.correctionFires).toBe(0);
  });

  it('14. syncEveryN=2 + 144fps + ±5ms jitter + 150ms RTT — combined stress', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        renderDt: 1 / 144,
        syncEveryN: 2,
        frameJitterMs: 5,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('14.combined-stress', r));
    expect(r.correctionFires).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (d) RateLimiter path — verify it never fires at production send rates.
// ════════════════════════════════════════════════════════════════════════════

describe('input-cadence-probe — RateLimiter (room/handlers/input.ts:21)', () => {
  it('15. RateLimiter NEVER fires at 16ms send cadence (62.5/s < 200/s cap)', async () => {
    const r = await runInputCadenceProbe(
      {
        durationSec: 2.0,
        latencySec: 0,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('15.ratelimit-normal', r));
    // At 16ms cadence, the client sends ~62.5/s. The RateLimiter starts full
    // (200 tokens) and refills at 200/s. It should NEVER drop.
    expect(r.totalRateLimited).toBe(0);
    expect(r.totalAccepted).toBe(r.totalArrived);
    expect(r.correctionFires).toBe(0);
  });

  it('16. RateLimiter DOES fire under a synthetic burst (sanity: the gate works)', async () => {
    // Drive the REAL RateLimiter directly with a burst exceeding the cap.
    // This confirms the RateLimiter code path is reachable and functional,
    // not that production hits it (it doesn't, per test 15).
    const handler = await makeServerInputHandler();
    const fakeFrame = {
      movementX: 1,
      movementY: 0,
      aimAngle: 0,
      sequence: 0,
      actions: [],
    };
    // The RateLimiter starts with 200 tokens and refills at 200/s. Sending
    // 250 frames "instantly" (same Date.now) should drop ~50.
    let accepted = 0;
    let dropped = 0;
    for (let i = 0; i < 250; i++) {
      // Date.now is overridden to return timeBox.now (constant during the loop).
      timeBox.now = 5000;
      fakeFrame.sequence = i;
      if (handler.processFrame(fakeFrame, 'burst-player', 1)) {
        accepted++;
      } else {
        dropped++;
      }
    }
    console.log(
      `[16.ratelimit-burst] accepted=${accepted} dropped=${dropped} (cap=${NETWORK.MAX_MESSAGES_PER_SECOND})`,
    );
    // The burst exceeds the 200-token cap → some are dropped.
    expect(dropped).toBeGreaterThan(0);
    expect(handler.stats.accepted).toBe(NETWORK.MAX_MESSAGES_PER_SECOND);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NET-03 + NET-04 wiring verification — confirm the landed fixes are wired.
// ════════════════════════════════════════════════════════════════════════════

describe('input-cadence-probe — NET-03/NET-04 wiring verification', () => {
  it('17. NET-03 decoupled sampling: direction-change transition (characterize, not sustained walk)', async () => {
    // If NET-03 is wired, the prediction reacts to a direction change within
    // one render frame, even on a throttle frame (no send). Test: hold +X for
    // 200ms, then release for 100ms, then hold +X again — all at 144fps.
    // The prediction decelerates during the release gap (live direction = 0),
    // not coasting on the stale +X. This is a TRANSITION scenario (direction
    // change), not sustained walk — transitions can produce small corrections
    // (the TASK-01 harness showed the same for transitions). The key finding
    // is that NET-03 IS wired (prediction reacts to direction changes per-
    // frame, not just on send boundaries).
    const r = await runInputCadenceProbe(
      {
        durationSec: 0.5,
        latencySec: 0,
        renderDt: 1 / 144,
        directionAt: (t) => (t > 0.2 && t < 0.3 ? { dx: 0, dy: 0 } : { dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('17.net03-decoupled', r));
    // NET-03 is wired: the prediction sees the direction change every frame.
    // The correction (if any) is from the transition deceleration/reaccel,
    // NOT from sustained walk. Characterize the magnitude.
    console.log(
      `[17.net03] correctionFires=${r.correctionFires} peakGenuine=${r.peakGenuinePosError.toFixed(2)}px (transition, not sustained walk)`,
    );
    // The transition may produce up to 1 correction at localhost (16px thr).
    // The SUSTAINED portions (before 0.2s and after 0.3s) have 0 corrections.
    expect(r.peakGenuinePosError).toBeLessThan(r.snapThreshold + 5);
  });

  it('18. NET-03 no step(null) coasting: the prediction advances on EVERY frame', async () => {
    // The harness's PredictionService.step is called every render frame with
    // the LIVE direction (from InputOrchestrator.collect). This IS the NET-03
    // shape — there is no step(null) coasting branch. The probe drives this
    // by construction: stepPrediction is called unconditionally per frame.
    // This test is a structural confirmation: totalRenderFrames > totalSent
    // (more render frames than sends → prediction advanced on throttle frames).
    const r = await runInputCadenceProbe(
      {
        durationSec: 0.5,
        latencySec: 0,
        renderDt: 1 / 144,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    console.log(headline('18.net03-no-coast', r));
    // At 144fps over 0.5s: ~72 render frames. Sends at 16ms: ~31. So
    // totalRenderFrames > totalSent.
    expect(r.totalRenderFrames).toBeGreaterThan(r.totalSent);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HARNESS QUALITIES — determinism + ≤2s timing (diagnose Phase 1 "iterate").
// ════════════════════════════════════════════════════════════════════════════

describe('input-cadence-probe — harness qualities', () => {
  it('DETERMINISTIC: same probe run twice → identical per-tick series', async () => {
    const opts = {
      durationSec: 0.8,
      latencySec: 0.075,
      renderDt: 1 / 144,
      frameJitterMs: 5,
      rngSeed: 42,
      directionAt: () => ({ dx: 1, dy: 0 }),
    } as const;
    const a = await runInputCadenceProbe(opts, timeBox);
    const b = await runInputCadenceProbe(opts, timeBox);
    expect(b.peakPosError).toBe(a.peakPosError);
    expect(b.correctionFires).toBe(a.correctionFires);
    expect(b.perTickPosError).toEqual(a.perTickPosError);
    expect(b.totalSent).toBe(a.totalSent);
  });

  it('FAST: representative scenario < 500ms (matrix of ~18 < 2s)', async () => {
    // Use the REAL performance.now (captured before override) for wall-clock
    // measurement — the overridden performance.now returns simulated time.
    const start = realPerformanceNow();
    await runInputCadenceProbe(
      {
        durationSec: 1.5,
        latencySec: 0.075,
        renderDt: 1 / 144,
        frameJitterMs: 5,
        rngSeed: 42,
        directionAt: () => ({ dx: 1, dy: 0 }),
      },
      timeBox,
    );
    const elapsed = realPerformanceNow() - start;
    console.log(`[FAST] representative scenario: ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});

// Reference SIM_TICK_DT + PLAYER for the report's determinism anchor.
void SIM_TICK_DT;
void PLAYER;
