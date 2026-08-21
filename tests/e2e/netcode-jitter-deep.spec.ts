/**
 * Netcode Jitter Deep Diagnostic
 *
 * Uses REAL keyboard input (WASD) via Playwright + DebugBridge for high-frequency
 * state sampling. This tests the ACTUAL prediction pipeline, not the bypass API.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Netcode Jitter Deep Diagnostic', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('[RECON-DBG]') || txt.includes('[JITTER-DBG]')) {
        console.log(`[CONSOLE] ${txt}`);
      }
    });
    await page.goto(GAME_URL);
    await page.waitForFunction(
      () => !!(window as any).__SECTO_DEBUG__ && typeof (window as any).__SECTO_DEBUG__.goToGame === 'function',
      { timeout: 15000 },
    );
    await page.evaluate(() => (window as any).__SECTO_DEBUG__.goToGame());
    await page.waitForFunction(
      () => !!(window as any).__SECTO_DEBUG__ && typeof (window as any).__SECTO_DEBUG__.getState === 'function',
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => (window as any).__SECTO_DEBUG__.getState().gameActive === true,
      { timeout: 15000 },
    );
    await page.waitForTimeout(500);
  });

  test('IDLE: no prediction jitter when standing still', async ({ page }) => {
    // Inject a high-frequency sampler that runs in the browser
    await page.evaluate(() => {
      (window as any).__JITTER_DATA = [];
      const dbg = (window as any).__SECTO_DEBUG__;
      let lastX = 0;
      let lastY = 0;

      const interval = setInterval(() => {
        const state = dbg.getState();
        const myP = state.players.find((p: any) => p.id === state.myId);
        if (!myP) return;

        const dx = state.localPos.x - lastX;
        const dy = state.localPos.y - lastY;
        const data = (window as any).__JITTER_DATA;
        data.push({
          t: performance.now(),
          localX: state.localPos.x,
          localY: state.localPos.y,
          velX: state.localVelocity.x,
          velY: state.localVelocity.y,
          serverX: myP.x,
          serverY: myP.y,
          dx,
          dy,
          distSq: dx * dx + dy * dy,
          predError: Math.hypot(state.localPos.x - myP.x, state.localPos.y - myP.y),
          seq: state.lastProcessedInput,
        });
        lastX = state.localPos.x;
        lastY = state.localPos.y;

        // Keep bounded
        if (data.length > 600) data.splice(0, 100);
      }, 16); // ~60fps sampling

      (window as any).__JITTER_STOP = () => clearInterval(interval);
    });

    // Wait 3 seconds of idle sampling
    await page.waitForTimeout(3000);

    // Collect data
    const idleData = await page.evaluate(() => {
      (window as any).__JITTER_STOP();
      return (window as any).__JITTER_DATA;
    });

    console.log(`=== IDLE: ${idleData.length} samples over 3s ===`);
    const jitters = idleData.filter(d => d.distSq > 0.001);
    const maxPredError = Math.max(...idleData.map(d => d.predError));
    const maxJitter = Math.max(...idleData.map(d => d.distSq));

    console.log(`Max prediction error: ${maxPredError.toFixed(6)} px`);
    console.log(`Max frame-to-frame jitter (distSq): ${maxJitter.toFixed(6)}`);
    console.log(`Frames with any movement: ${jitters.length}/${idleData.length}`);

    if (jitters.length > 0) {
      console.log('Jitter samples:');
      jitters.slice(0, 20).forEach(d => {
        console.log(`  t=${(d.t - idleData[0].t).toFixed(0)}ms pos=(${d.localX.toFixed(3)},${d.localY.toFixed(3)}) vel=(${d.velX.toFixed(4)},${d.velY.toFixed(4)}) distSq=${d.distSq.toFixed(6)} predErr=${d.predError.toFixed(4)} seq=${d.seq}`);
      });
    }

    expect(maxPredError, 'Idle prediction error < 0.5px').toBeLessThan(0.5);
    expect(maxJitter, 'Idle jitter distSq < 0.01').toBeLessThan(0.01);
  });

  test('MOVE-STOP: keyboard-driven movement then observe jitter', async ({ page }) => {
    // Inject high-frequency sampler
    await page.evaluate(() => {
      (window as any).__JITTER_DATA = [];
      const dbg = (window as any).__SECTO_DEBUG__;
      let lastX = 0;
      let lastY = 0;
      let frameCount = 0;

      // Also hook into the prediction to capture EVERY prediction step
      const origUpdate = dbg.sampleNetcodeFrame?.bind(dbg);

      const interval = setInterval(() => {
        const state = dbg.getState();
        const myP = state.players.find((p: any) => p.id === state.myId);
        if (!myP) return;

        const dx = state.localPos.x - lastX;
        const dy = state.localPos.y - lastY;
        frameCount++;
        const data = (window as any).__JITTER_DATA;
        data.push({
          t: performance.now(),
          frame: frameCount,
          localX: state.localPos.x,
          localY: state.localPos.y,
          velX: state.localVelocity.x,
          velY: state.localVelocity.y,
          speed: Math.hypot(state.localVelocity.x, state.localVelocity.y),
          serverX: myP.x,
          serverY: myP.y,
          dx,
          dy,
          distSq: dx * dx + dy * dy,
          predError: Math.hypot(state.localPos.x - myP.x, state.localPos.y - myP.y),
          seq: state.lastProcessedInput,
          serverDelta: Math.hypot(myP.x - (data.length > 0 ? data[data.length - 1].serverX : myP.x), myP.y - (data.length > 0 ? data[data.length - 1].serverY : myP.y)),
        });
        lastX = state.localPos.x;
        lastY = state.localPos.y;

        if (data.length > 600) data.splice(0, 100);
      }, 16);

      (window as any).__JITTER_STOP = () => clearInterval(interval);
    });

    // Click the game canvas to focus it
    await page.click('canvas', { position: { x: 400, y: 300 } });
    await page.waitForTimeout(200);

    // Move right with D key for 1 second
    await page.keyboard.down('d');
    await page.waitForTimeout(1000);
    await page.keyboard.up('d');

    // Now sample the stop transition for 4 seconds
    await page.waitForTimeout(4000);

    // Collect
    const data = await page.evaluate(() => {
      (window as any).__JITTER_STOP();
      return (window as any).__JITTER_DATA;
    });

    console.log(`\n=== MOVE-STOP: ${data.length} total samples ===`);

    // Find the transition point: where speed drops after being > 0
    const movingFrames = data.filter(d => d.speed > 10);
    const stoppingPoint = movingFrames.length > 0 ? data.indexOf(movingFrames[movingFrames.length - 1]) : 0;
    console.log(`Last moving frame index: ${stoppingPoint}`);

    // Show the transition zone (10 frames before stop, 30 after)
    const transitionStart = Math.max(0, stoppingPoint - 10);
    const transitionEnd = Math.min(data.length, stoppingPoint + 30);
    console.log(`\nTransition zone (frame ${transitionStart}-${transitionEnd}):`);
    data.slice(transitionStart, transitionEnd).forEach(d => {
      const walkTrigger = d.distSq > 1.0 ? 'WALK!' : d.distSq > 0.09 ? 'edge' : 'idle';
      console.log(
        `  f=${d.frame} pos=(${d.localX.toFixed(2)},${d.localY.toFixed(2)}) vel=(${d.velX.toFixed(3)},${d.velY.toFixed(3)}) speed=${d.speed.toFixed(2)} distSq=${d.distSq.toFixed(4)} predErr=${d.predError.toFixed(4)} serverΔ=${d.serverDelta.toFixed(3)} ${walkTrigger}`
      );
    });

    // Post-stop analysis: frames 30+ after stopping point
    const postStopStart = stoppingPoint + 30;
    if (postStopStart < data.length) {
      const postStop = data.slice(postStopStart);
      const postStopWalkTriggers = postStop.filter(d => d.distSq > 1.0);
      const postStopEdgeJitter = postStop.filter(d => d.distSq > 0.09 && d.distSq <= 1.0);
      const maxPostStopError = Math.max(...postStop.map(d => d.predError));

      console.log(`\nPost-stop analysis (after frame ${postStopStart}, ${postStop.length} frames):`);
      console.log(`  Walk anim triggers (distSq>1.0): ${postStopWalkTriggers.length}`);
      console.log(`  Edge jitter (0.09<distSq<1.0): ${postStopEdgeJitter.length}`);
      console.log(`  Max prediction error: ${maxPostStopError.toFixed(4)} px`);

      if (postStopWalkTriggers.length > 0) {
        console.log(`\n  WALK TRIGGERS AFTER STOP:`);
        postStopWalkTriggers.slice(0, 20).forEach(d => {
          console.log(`    f=${d.frame} pos=(${d.localX.toFixed(3)},${d.localY.toFixed(3)}) vel=(${d.velX.toFixed(4)},${d.velY.toFixed(4)}) distSq=${d.distSq.toFixed(4)} server=(${d.serverX.toFixed(3)},${d.serverY.toFixed(3)}) predErr=${d.predError.toFixed(4)}`);
        });
      }

      if (postStopEdgeJitter.length > 0) {
        console.log(`\n  EDGE JITTER (could trigger walk at lower threshold):`);
        postStopEdgeJitter.slice(0, 20).forEach(d => {
          console.log(`    f=${d.frame} pos=(${d.localX.toFixed(3)},${d.localY.toFixed(3)}) vel=(${d.velX.toFixed(4)},${d.velY.toFixed(4)}) distSq=${d.distSq.toFixed(4)} predErr=${d.predError.toFixed(4)}`);
        });
      }
    }

    // Also show full reconciliation log
    console.log('\n=== SERVER STATE CHANGES ===');
    const serverChanges = data.filter(d => d.serverDelta > 0.1);
    console.log(`Server position updates: ${serverChanges.length}`);
    serverChanges.slice(0, 30).forEach(d => {
      console.log(`  f=${d.frame} local=(${d.localX.toFixed(3)},${d.localY.toFixed(3)}) server=(${d.serverX.toFixed(3)},${d.serverY.toFixed(3)}) delta=${d.serverDelta.toFixed(3)} predErr=${d.predError.toFixed(4)}`);
    });
  });

  test('CONTINUOUS: move into wall and observe collision jitter', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__JITTER_DATA = [];
      const dbg = (window as any).__SECTO_DEBUG__;
      let lastX = 0;
      let lastY = 0;
      let frameCount = 0;

      const interval = setInterval(() => {
        const state = dbg.getState();
        const myP = state.players.find((p: any) => p.id === state.myId);
        if (!myP) return;

        const dx = state.localPos.x - lastX;
        const dy = state.localPos.y - lastY;
        frameCount++;
        const data = (window as any).__JITTER_DATA;
        data.push({
          t: performance.now(),
          frame: frameCount,
          localX: state.localPos.x,
          localY: state.localPos.y,
          velX: state.localVelocity.x,
          velY: state.localVelocity.y,
          speed: Math.hypot(state.localVelocity.x, state.localVelocity.y),
          serverX: myP.x,
          serverY: myP.y,
          dx,
          dy,
          distSq: dx * dx + dy * dy,
          predError: Math.hypot(state.localPos.x - myP.x, state.localPos.y - myP.y),
          seq: state.lastProcessedInput,
        });
        lastX = state.localPos.x;
        lastY = state.localPos.y;

        if (data.length > 600) data.splice(0, 100);
      }, 16);

      (window as any).__JITTER_STOP = () => clearInterval(interval);
    });

    await page.click('canvas', { position: { x: 400, y: 300 } });
    await page.waitForTimeout(200);

    // Move LEFT into what should be a wall (spawn is typically at 192,192)
    await page.keyboard.down('a');
    await page.waitForTimeout(2000);
    await page.keyboard.up('a');
    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      (window as any).__JITTER_STOP();
      return (window as any).__JITTER_DATA;
    });

    console.log(`\n=== WALL COLLISION: ${data.length} total samples ===`);

    // Find the phase where player is pressing against the wall
    const movingFrames = data.filter(d => d.speed > 10);
    const wallPhase = movingFrames.length > 0 ? data.indexOf(movingFrames[0]) : 0;
    console.log(`Wall phase starts at frame ${wallPhase}`);

    // Show the wall-sliding phase
    const wallEnd = Math.min(data.length, wallPhase + 120);
    console.log(`\nWall collision phase (frame ${wallPhase}-${wallEnd}):`);
    data.slice(wallPhase, wallEnd).forEach(d => {
      const walkTrigger = d.distSq > 1.0 ? 'WALK!' : d.distSq > 0.09 ? 'edge' : 'idle';
      console.log(
        `  f=${d.frame} pos=(${d.localX.toFixed(2)},${d.localY.toFixed(2)}) vel=(${d.velX.toFixed(3)},${d.velY.toFixed(3)}) speed=${d.speed.toFixed(2)} distSq=${d.distSq.toFixed(4)} predErr=${d.predError.toFixed(4)} ${walkTrigger}`
      );
    });

    // Count walk triggers during wall phase
    const wallData = data.slice(wallPhase, wallEnd);
    const walkDuringWall = wallData.filter(d => d.distSq > 1.0);
    const predErrorsDuringWall = wallData.map(d => d.predError);

    console.log(`\nWall collision summary:`);
    console.log(`  Walk triggers during wall press: ${walkDuringWall.length}/${wallData.length}`);
    console.log(`  Max prediction error at wall: ${Math.max(...predErrorsDuringWall).toFixed(4)} px`);
    console.log(`  Avg prediction error at wall: ${(predErrorsDuringWall.reduce((a, b) => a + b, 0) / predErrorsDuringWall.length).toFixed(4)} px`);
  });
});
