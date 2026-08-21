/**
 * Netcode Jitter Runtime Validation
 *
 * Uses DebugBridge to observe prediction/reconciliation in real-time.
 * Tests: idle jitter, sustained movement, stop-after-move transition.
 * Validates: prediction error, reconciliation frequency, walk animation triggers.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';
const COUNTDOWN_WAIT = 8000; // Wait for countdown phase to end

test.describe('Netcode Jitter Runtime Validation', () => {
  test.beforeEach(async ({ page }) => {
    // Collect console logs for analysis
    page.on('console', (msg) => {
      if (msg.text().includes('[RECON-DBG]') || msg.text().includes('[JITTER-DBG]')) {
        console.log(`[BROWSER] ${msg.text()}`);
      }
    });
    await page.goto(GAME_URL);
    // Wait for MainMenuScene's __SECTO_DEBUG__ with goToGame
    await page.waitForFunction(
      () => !!(window as any).__SECTO_DEBUG__ && typeof (window as any).__SECTO_DEBUG__.goToGame === 'function',
      { timeout: 15000 },
    );
    // Transition to game scene via menu debug API
    await page.evaluate(() => (window as any).__SECTO_DEBUG__.goToGame());
    // Wait for GameScene's DebugBridge to replace the menu debug object
    await page.waitForFunction(
      () => !!(window as any).__SECTO_DEBUG__ && typeof (window as any).__SECTO_DEBUG__.getState === 'function',
      { timeout: 15000 },
    );
    // Wait for countdown phase to end
    await page.waitForFunction(
      () => (window as any).__SECTO_DEBUG__.getState().gameActive === true,
      { timeout: 15000 },
    );
    // Extra settle time
    await page.waitForTimeout(500);
  });

  test('IDLE: player standing still should have zero prediction error', async ({ page }) => {
    // Sample netcode metrics for 3 seconds while idle
    const metrics = await page.evaluate(async () => {
      const dbg = (window as any).__SECTO_DEBUG__;
      const samples: any[] = [];
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const state = dbg.getState();
        const netcode = dbg.getNetcodeMetrics();
        samples.push({
          localPos: { ...state.localPos },
          localVel: { ...state.localVelocity },
          serverPos: state.players.find((p: any) => p.id === state.myId) ?? null,
          predictionError: netcode.predictionError,
          reconciliationCount: netcode.reconciliationCount,
          avgCorrection: netcode.avgCorrection,
          maxCorrection: netcode.maxCorrection,
          patchRate: netcode.patchRate,
        });
        await new Promise(r => setTimeout(r, 50));
      }
      return samples;
    });

    // Analyze
    const errors = metrics.map(s => s.predictionError).filter(e => e > 0);
    const maxError = Math.max(...metrics.map(s => s.predictionError));
    const corrections = metrics.filter(s => s.avgCorrection > 0);
    const localPosJitter = metrics.map((s, i, arr) => {
      if (i === 0) return 0;
      return Math.hypot(
        s.localPos.x - arr[i - 1].localPos.x,
        s.localPos.y - arr[i - 1].localPos.y,
      );
    });

    console.log('=== IDLE TEST RESULTS ===');
    console.log(`Samples: ${metrics.length}`);
    console.log(`Max prediction error: ${maxError.toFixed(4)} px`);
    console.log(`Frames with error > 0: ${errors.length}/${metrics.length}`);
    console.log(`Frames with corrections: ${corrections.length}/${metrics.length}`);
    console.log(`Max localPos jitter (frame-to-frame): ${Math.max(...localPosJitter).toFixed(4)} px`);
    console.log(`Avg localPos jitter: ${(localPosJitter.reduce((a, b) => a + b, 0) / localPosJitter.length).toFixed(4)} px`);

    // While idle, prediction error should be minimal (< 0.5px)
    expect(maxError, 'Idle prediction error should be < 0.5px').toBeLessThan(0.5);

    // Local position should be rock-stable while idle
    const maxJitter = Math.max(...localPosJitter);
    expect(maxJitter, 'Idle frame-to-frame jitter should be < 0.3px').toBeLessThan(0.3);
  });

  test('MOVE-THEN-STOP: walk animation should not flicker after releasing keys', async ({ page }) => {
    // Move right for 1 second, then stop, observe 3 seconds post-stop
    const result = await page.evaluate(async () => {
      const dbg = (window as any).__SECTO_DEBUG__;
      const data = {
        duringMove: [] as any[],
        afterStop: [] as any[],
        walkAnimFrames: 0,
        totalFrames: 0,
      };

      // Phase 1: Move for 1 second
      const moveStart = Date.now();
      while (Date.now() - moveStart < 1000) {
        dbg.runtime.move(1, 0, 0);
        const state = dbg.getState();
        data.duringMove.push({
          localPos: { ...state.localPos },
          localVel: { ...state.localVelocity },
          tick: state.tick,
        });
        await new Promise(r => setTimeout(r, 16));
      }

      // Phase 2: Stop — observe for 3 seconds
      const stopStart = Date.now();
      while (Date.now() - stopStart < 3000) {
        const state = dbg.getState();
        const netcode = dbg.getNetcodeMetrics();
        const localVel = { ...state.localVelocity };
        const speed = Math.hypot(localVel.x, localVel.y);

        const prevEntry = data.afterStop.length > 0 ? data.afterStop[data.afterStop.length - 1] : null;
        const dx = prevEntry ? state.localPos.x - prevEntry.localPos.x : 0;
        const dy = prevEntry ? state.localPos.y - prevEntry.localPos.y : 0;
        const distSq = dx * dx + dy * dy;

        data.afterStop.push({
          localPos: { ...state.localPos },
          localVel,
          speed,
          distSq,
          predictionError: netcode.predictionError,
          reconciliationCount: netcode.reconciliationCount,
          tick: state.tick,
        });

        // Count frames where walk animation would trigger
        // MOVE_ENTER_THRESHOLD = 1.0, so distSq > 1.0 = walk trigger
        if (distSq > 1.0) {
          data.walkAnimFrames++;
        }
        data.totalFrames++;

        await new Promise(r => setTimeout(r, 16));
      }

      return data;
    });

    console.log('=== MOVE-THEN-STOP RESULTS ===');
    console.log(`During move: ${result.duringMove.length} samples`);
    console.log(`After stop: ${result.afterStop.length} samples`);
    console.log(`Walk anim triggers after stop: ${result.walkAnimFrames}/${result.totalFrames}`);

    // Show velocity decay
    const velDecay = result.afterStop.slice(0, 30).map((s, i) =>
      `[${i}] speed=${s.speed.toFixed(4)} pos=(${s.localPos.x.toFixed(2)},${s.localPos.y.toFixed(2)}) distSq=${s.distSq.toFixed(4)}`
    );
    console.log('Velocity decay (first 30 frames):');
    velDecay.forEach(v => console.log(v));

    // Show prediction errors after stop
    const postStopErrors = result.afterStop.map(s => s.predictionError);
    const maxPostStopError = Math.max(...postStopErrors);
    console.log(`Max prediction error after stop: ${maxPostStopError.toFixed(4)} px`);

    // Show reconciliation count
    const reconCounts = result.afterStop.map(s => s.reconciliationCount);
    const maxRecon = Math.max(...reconCounts);
    console.log(`Max reconciliation count per window after stop: ${maxRecon}`);

    // CRITICAL: Walk animation should NOT trigger after velocity decays
    // Allow a grace period (first 10 frames ≈ 160ms for velocity decay)
    const postGraceFrames = result.afterStop.slice(10);
    const postGraceWalkTriggers = postGraceFrames.filter(s => s.distSq > 1.0).length;
    console.log(`Walk triggers AFTER grace period: ${postGraceWalkTriggers}/${postGraceFrames.length}`);

    expect(postGraceWalkTriggers, 'Walk anim should not trigger after velocity grace period').toBe(0);
  });

  test('SUSTAINED MOVE: prediction error should stay bounded during continuous movement', async ({ page }) => {
    // Move continuously and sample prediction metrics
    const result = await page.evaluate(async () => {
      const dbg = (window as any).__SECTO_DEBUG__;
      const samples: any[] = [];
      const start = Date.now();

      while (Date.now() - start < 3000) {
        dbg.runtime.move(1, 0.5, 0);
        const state = dbg.getState();
        const netcode = dbg.getNetcodeMetrics();
        samples.push({
          localPos: { ...state.localPos },
          serverPos: state.players.find((p: any) => p.id === state.myId) ?? null,
          predictionError: netcode.predictionError,
          maxCorrection: netcode.maxCorrection,
          reconciliationCount: netcode.reconciliationCount,
        });
        await new Promise(r => setTimeout(r, 50));
      }
      return samples;
    });

    const maxError = Math.max(...result.map(s => s.predictionError));
    const avgError = result.reduce((sum, s) => sum + s.predictionError, 0) / result.length;
    const maxCorr = Math.max(...result.map(s => s.maxCorrection));

    console.log('=== SUSTAINED MOVE RESULTS ===');
    console.log(`Samples: ${result.length}`);
    console.log(`Max prediction error: ${maxError.toFixed(4)} px`);
    console.log(`Avg prediction error: ${avgError.toFixed(4)} px`);
    console.log(`Max correction: ${maxCorr.toFixed(4)} px`);

    // During sustained movement, prediction error should stay bounded
    expect(maxError, 'Sustained move max prediction error < 5px').toBeLessThan(5);
    expect(avgError, 'Sustained move avg prediction error < 2px').toBeLessThan(2);
  });

  test('DIAGNOSTIC: capture full reconciliation data for 5 seconds', async ({ page }) => {
    // First move, then go idle — capture everything
    const result = await page.evaluate(async () => {
      const dbg = (window as any).__SECTO_DEBUG__;
      const frames: any[] = [];

      // Move for 500ms
      const moveStart = Date.now();
      while (Date.now() - moveStart < 500) {
        dbg.runtime.move(1, 0, 0);
        await new Promise(r => setTimeout(r, 16));
      }

      // Now idle for 5 seconds — capture high-frequency data
      const idleStart = Date.now();
      let lastServerX = 0;
      let lastServerY = 0;
      let reconciliationEvents = 0;

      while (Date.now() - idleStart < 5000) {
        const state = dbg.getState();
        const myPlayer = state.players.find((p: any) => p.id === state.myId);
        const serverX = myPlayer?.x ?? 0;
        const serverY = myPlayer?.y ?? 0;

        // Detect server state change
        const serverChanged = (lastServerX !== 0 || lastServerY !== 0) &&
          (serverX !== lastServerX || serverY !== lastServerY);

        if (serverChanged) {
          reconciliationEvents++;
        }
        lastServerX = serverX;
        lastServerY = serverY;

        const speed = Math.hypot(state.localVelocity.x, state.localVelocity.y);
        const dx = frames.length > 0 ? state.localPos.x - frames[frames.length - 1].localPos.x : 0;
        const dy = frames.length > 0 ? state.localPos.y - frames[frames.length - 1].localPos.y : 0;
        const distSq = dx * dx + dy * dy;

        frames.push({
          t: Date.now() - idleStart,
          localPos: { ...state.localPos },
          localVel: { ...state.localVelocity },
          speed,
          serverPos: { x: serverX, y: serverY },
          serverChanged,
          distSq,
          walkTrigger: distSq > 1.0,
          seq: state.lastProcessedInput,
          tick: state.tick,
        });

        await new Promise(r => setTimeout(r, 16)); // ~60fps
      }

      return { frames, reconciliationEvents };
    });

    console.log('=== DIAGNOSTIC RESULTS ===');
    console.log(`Total frames: ${result.frames.length}`);
    console.log(`Reconciliation events: ${result.reconciliationEvents}`);

    // Find frames where walk triggers after initial velocity decay
    const walkTriggers = result.frames.filter(f => f.walkTrigger);
    console.log(`Walk trigger frames: ${walkTriggers.length}/${result.frames.length}`);

    // Show first 10 and last 10 frames
    console.log('\nFirst 15 frames after stop:');
    result.frames.slice(0, 15).forEach(f => {
      console.log(
        `  t=${f.t}ms pos=(${f.localPos.x.toFixed(3)},${f.localPos.y.toFixed(3)}) vel=(${f.localVel.x.toFixed(3)},${f.localVel.y.toFixed(3)}) speed=${f.speed.toFixed(4)} distSq=${f.distSq.toFixed(4)} walk=${f.walkTrigger} serverChanged=${f.serverChanged}`
      );
    });

    // Show any frames with significant distSq after first 200ms
    const lateJitter = result.frames.filter(f => f.t > 200 && f.distSq > 0.5);
    console.log(`\nFrames with distSq > 0.5 after 200ms: ${lateJitter.length}`);
    if (lateJitter.length > 0) {
      lateJitter.slice(0, 10).forEach(f => {
        console.log(
          `  t=${f.t}ms distSq=${f.distSq.toFixed(4)} pos=(${f.localPos.x.toFixed(3)},${f.localPos.y.toFixed(3)}) server=(${f.serverPos.x.toFixed(3)},${f.serverPos.y.toFixed(3)}) walk=${f.walkTrigger}`
        );
      });
    }

    // Show server change events
    const serverChanges = result.frames.filter(f => f.serverChanged);
    console.log(`\nServer state changes: ${serverChanges.length}`);
    if (serverChanges.length > 0) {
      serverChanges.slice(0, 10).forEach(f => {
        console.log(
          `  t=${f.t}ms local=(${f.localPos.x.toFixed(3)},${f.localPos.y.toFixed(3)}) server=(${f.serverPos.x.toFixed(3)},${f.serverPos.y.toFixed(3)}) delta=${Math.hypot(f.localPos.x - f.serverPos.x, f.localPos.y - f.serverPos.y).toFixed(4)}`
        );
      });
    }

    // Expectations
    const postDecayWalkTriggers = result.frames.filter(f => f.t > 200 && f.walkTrigger);
    console.log(`\nWalk triggers after 200ms: ${postDecayWalkTriggers.length}`);
  });
});
