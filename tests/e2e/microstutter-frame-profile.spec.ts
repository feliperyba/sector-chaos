/**
 * MICROSTUTTER FRAME PROFILE — the deterministic feedback loop for the
 * "uneven / hitching forward motion" symptom reported in `npm run dev`.
 *
 * Why this exists (not the deep-jitter-diagnostic):
 *   - deep-jitter samples IDLE at 50ms setTimeout — cannot measure frame-time
 *     variance (H1: Vite dev overhead) nor motion unevenness during movement.
 *   - This sampler records EVERY rAF frame during SUSTAINED held movement, on
 *     BOTH the dev client (5174) and prod client (8080), so the dev-vs-prod
 *     delta is the signal.
 *
 * What it measures per frame:
 *   - rAF interval (performance.now delta)  → frame-time distribution (H1)
 *   - scene update() CPU duration           → pure JS cost per frame (H1)
 *   - on-screen visual position delta       → motion unevenness (the symptom)
 *   - localPos / predictionError            → rule out netcode snaps (H4)
 *
 * Run against dev:   PROFILE_URL=http://localhost:5174 pnpm exec playwright test microstutter-frame-profile
 * Run against prod:  PROFILE_URL=http://localhost:8080  pnpm exec playwright test microstutter-frame-profile
 */
import { test } from '@playwright/test';

const GAME_URL = process.env.PROFILE_URL || 'http://localhost:5174';
const LABEL = process.env.PROFILE_LABEL || (GAME_URL.includes('5174') ? 'DEV (vite)' : 'PROD (docker)');
const MOVE_HOLD_MS = 6000; // sample window while holding W
const SETTLE_MS = 2500; // wait after game start for spawn/accel ramp

test.describe(`Microstutter frame profile — ${LABEL}`, () => {
  test('per-frame frame-time + visual displacement during sustained movement', async ({ page }) => {
    test.setTimeout(90000);
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(GAME_URL);
    // Let the bundle + main scene boot. Vite dev serves on first request (no
    // pre-bundle for some deps), so dev needs longer here than prod — the
    // difference itself is a signal.
    await page.waitForTimeout(7000);
    await page.locator('canvas').click();
    await page.waitForTimeout(400);

    // Boot into a real GameScene (creates a server room → exercises real
    // input → prediction → visual path, NOT the runtime controller which
    // bypasses prediction per ADR-0034).
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.('demo'));
    await page.waitForFunction(
      () => {
        const d = (window as any).__SECTO_DEBUG__;
        const state = d?.getState?.();
        return state?.gameActive && state?.mapLoaded;
      },
      { timeout: 30000 },
    );
    await page.waitForTimeout(SETTLE_MS);
    await page.locator('canvas').click();
    await page.waitForTimeout(300);

    // Install the per-frame sampler. Patches scene.update once to also record
    // CPU duration, then runs a rAF loop for MOVE_HOLD_MS recording everything.
    const profile = await page.evaluate(async (holdMs: number) => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find(
        (s: any) => s?.scene?.key === 'GameScene' || s?.sys?.settings?.key === 'GameScene',
      );
      if (!gameScene) return { error: 'no GameScene' };
      const bridge = gameScene.debugBridge || (window as any).__SECTO_DEBUG__;
      if (!bridge) return { error: 'no debugBridge' };

      // --- Patch scene.update to record CPU duration (idempotent) ---
      if (!(gameScene as any).__profilePatched) {
        const origUpdate = gameScene.update?.bind(gameScene);
        (gameScene as any).__profilePatched = true;
        if (typeof origUpdate === 'function') {
          gameScene.update = function (...args: unknown[]) {
            const t0 = performance.now();
            const r = origUpdate(...args);
            (gameScene as any).__lastUpdateMs = performance.now() - t0;
            return r;
          };
        }
      }

      // --- Snapshot of ground-truth visual + sim state ---
      const snap = () => {
        const lp = bridge.localPos || gameScene.localPos;
        const lv = bridge.localVelocity || gameScene.localVelocity;
        // Visual = what's drawn. Prefer the prediction service's interpolated
        // output; fall back to localPos if unavailable.
        let vx: number | undefined;
        let vy: number | undefined;
        try {
          const v =
            gameScene.getVisualPosition?.() ??
            gameScene.predictionService?.getVisualPosition?.() ??
            gameScene.predictionController?.getVisualPosition?.();
          if (v) {
            vx = v.x;
            vy = v.y;
          }
        } catch {
          /* leave undefined */
        }
        if (vx === undefined) {
          vx = lp?.x;
          vy = lp?.y;
        }
        return {
          t: performance.now(),
          updateMs: (gameScene as any).__lastUpdateMs ?? 0,
          localX: lp?.x ?? 0,
          localY: lp?.y ?? 0,
          velX: lv?.x ?? 0,
          velY: lv?.y ?? 0,
          visualX: vx ?? 0,
          visualY: vy ?? 0,
          predErr: bridge.getPredictionError?.() ?? 0,
          reconErrors: bridge.getState?.().reconciliationErrors ?? 0,
        };
      };

      const samples: ReturnType<typeof snap>[] = [];
      const start = performance.now();
      return new Promise((resolve) => {
        const tick = () => {
          samples.push(snap());
          if (performance.now() - start >= holdMs) {
            resolve({ samples, fps: game.loop?.fps, gameTargetFps: game.loop?.targetFps });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, MOVE_HOLD_MS);

    if ((profile as any).error) {
      console.log('PROFILE ERROR:', (profile as any).error);
      console.log('console errors:', consoleErrors.slice(0, 10));
      throw new Error((profile as any).error);
    }

    // Send analysis back into the page to keep the test log clean + reuse math.
    const report = await page.evaluate((p: any) => {
      const s = p.samples as any[];
      const n = s.length;
      const dts: number[] = [];
      const ups: number[] = [];
      const visDeltas: number[] = [];
      const visX: number[] = [];
      const predErrs: number[] = [];
      let backwardVisual = 0;
      let maxBackward = 0;

      for (let i = 1; i < n; i++) {
        const a = s[i - 1];
        const b = s[i];
        dts.push(b.t - a.t);
        ups.push(b.updateMs);
        const dvx = b.visualX - a.visualX;
        const dvy = b.visualY - a.visualY;
        const dmag = Math.hypot(dvx, dvy);
        visDeltas.push(dmag);
        visX.push(dvx);
        // net forward distance magnitude (along dominant axis)
        if (dvx < -0.05 || dvy < -0.05) {
          // only count as backward if the dominant component reversed
          if (Math.abs(dvx) > Math.abs(dvy) && dvx < -0.05) {
            backwardVisual++;
            maxBackward = Math.max(maxBackward, -dvx);
          }
        }
        predErrs.push(b.predErr);
      }

      const pct = (arr: number[], q: number) => {
        const sorted = [...arr].sort((x, y) => x - y);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      };
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const std = (arr: number[]) => {
        const m = mean(arr);
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
      };

      const frameMean = mean(dts);
      const visMean = mean(visDeltas);
      const visStd = std(visDeltas);
      const totalDist = visDeltas.reduce((a, b) => a + b, 0);

      // Pearson correlation between frame dt and the FOLLOWING frame's visual
      // delta. If r>0.4, long frames cause small displacement then catch-up
      // → confirms frame-time-driven uneven motion (H1/H2).
      const corr = (() => {
        const xs = dts.slice(0, -1);
        const ys = visDeltas.slice(1);
        const mx = mean(xs);
        const my = mean(ys);
        let num = 0;
        let dx = 0;
        let dy = 0;
        for (let i = 0; i < xs.length; i++) {
          num += (xs[i] - mx) * (ys[i] - my);
          dx += (xs[i] - mx) ** 2;
          dy += (ys[i] - my) ** 2;
        }
        return num / Math.sqrt(dx * dy || 1);
      })();

      // Count "stutter frames": visual delta < 40% of mean (a visible hitch).
      const stutterThreshold = visMean * 0.4;
      const stutterFrames = visDeltas.filter((d) => d < stutterThreshold).length;

      return {
        label: p.label,
        samples: n,
        durationSec: ((s[n - 1].t - s[0].t) / 1000).toFixed(2),
        totalVisualDistPx: totalDist.toFixed(1),
        avgVisualSpeedPxSec: (totalDist / ((s[n - 1].t - s[0].t) / 1000)).toFixed(1),
        frameMs: {
          mean: frameMean.toFixed(2),
          p50: pct(dts, 0.5).toFixed(2),
          p90: pct(dts, 0.9).toFixed(2),
          p99: pct(dts, 0.99).toFixed(2),
          max: Math.max(...dts).toFixed(2),
          over20ms: dts.filter((d) => d > 20).length,
          over33ms: dts.filter((d) => d > 33).length,
        },
        updateCpuMs: {
          mean: mean(ups).toFixed(2),
          p90: pct(ups, 0.9).toFixed(2),
          p99: pct(ups, 0.99).toFixed(2),
          max: Math.max(...ups).toFixed(2),
        },
        visualDeltaPx: {
          mean: visMean.toFixed(3),
          std: visStd.toFixed(3),
          cv: (visStd / (visMean || 1)).toFixed(3),
          stutterFrames,
          stutterPct: ((stutterFrames / visDeltas.length) * 100).toFixed(1),
        },
        frameDt_vs_nextVisualDelta_correlation: corr.toFixed(3),
        backwardVisualJumps: backwardVisual,
        maxBackwardJumpPx: maxBackward.toFixed(3),
        predictionError: {
          mean: mean(predErrs).toFixed(3),
          max: Math.max(...predErrs).toFixed(3),
        },
        finalReconErrors: s[n - 1].reconErrors,
        gameLoopFps: p.fps,
      };
    }, profile);

    console.log(`\n=== MICROSTUTTER PROFILE: ${LABEL} (${GAME_URL}) ===`);
    console.log(JSON.stringify(report, null, 2));
    if (consoleErrors.length) {
      console.log(`\nconsole errors (${consoleErrors.length}):`, consoleErrors.slice(0, 5));
    }
  });
});
