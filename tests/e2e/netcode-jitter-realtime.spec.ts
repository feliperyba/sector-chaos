/**
 * Real-Time Jitter Capture Test
 *
 * Uses DebugBridge's in-loop capture to get actual 60fps netcode data.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Real-Time Jitter Capture', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('[RECON-DBG]') || txt.includes('[JITTER-DBG]') || txt.includes('WALK!')) {
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
    await page.waitForTimeout(1000);
  });

  test('WALL-TO-STOP: Move into wall, stop, capture 60fps data', async ({ page }) => {
    const startCapture = page.evaluate(() => {
      (window as any).__SECTO_DEBUG__.startCapture();
      return true;
    });

    await page.click('canvas', { position: { x: 400, y: 300 } });
    await page.waitForTimeout(200);

    // Move left into wall
    await page.keyboard.down('a');
    await page.waitForTimeout(1000);

    await page.keyboard.up('a');
    await page.waitForTimeout(2000);

    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');

    const stopCapture = page.evaluate(() => {
      const frames = (window as any).__SECTO_DEBUG__.stopCapture();
      console.log(`Captured ${frames.length} frames at 60fps`);
      return frames;
    });

    const frames = await stopCapture;
    console.log(`\n=== WALL-TO-STOP CAPTURE: ${frames.length} frames ===`);

    // Find the wall collision zone
    const wallFrames = frames.filter(f => (f as any).serverDelta > 0.1);
    const walkTriggers = frames.filter(f => (f as any).distSq > 1.0);
    const edgeJitter = frames.filter(f => (f as any).distSq > 0.09 && (f as any).distSq <= 1.0);

    console.log(`Wall collisions: ${wallFrames.length}`);
    console.log(`Walk triggers (distSq>1.0): ${walkTriggers.length}`);
    console.log(`Edge jitter (0.09<distSq<1.0): ${edgeJitter.length}`);

    // Show all wall events with context
    if (wallFrames.length > 0) {
      console.log('\n=== WALL COLLISION EVENTS ===');
      wallFrames.forEach((f: any) => {
        console.log(
          `t=${(f.t - frames[0].t).toFixed(0)}ms pos=(${f.localX.toFixed(2)},${f.localY.toFixed(2)}) vel=(${f.velX.toFixed(3)},${f.velY.toFixed(3)}) speed=${f.speed.toFixed(2)} distSq=${f.distSq.toFixed(4)} predErr=${f.predError.toFixed(4)} serverΔ=${f.serverDelta.toFixed(3)}`
        );
      });
    }

    // Show walk triggers (the flicker symptom)
    if (walkTriggers.length > 0) {
      console.log('\n=== WALK TRIGGERS (flicker symptom) ===');
      walkTriggers.forEach((f: any) => {
        const time = (f.t - frames[0].t).toFixed(0);
        console.log(
          `t=${time}ms WALK! pos=(${f.localX.toFixed(2)},${f.localY.toFixed(2)}) vel=(${f.velX.toFixed(3)},${f.velY.toFixed(3)}) distSq=${f.distSq.toFixed(4)} predErr=${f.predError.toFixed(4)} server=(${f.serverX.toFixed(2)},${f.serverY.toFixed(2)}) seq=${f.seq}`
        );
      });

      const afterMove = walkTriggers.filter(f => {
        const frameTime = f.t - frames[0].t;
        return frameTime > 1500; // 1.5s after movement starts
      });
      console.log(`\nWalk triggers after 1.5s: ${afterMove.length}`);
    }

    // Show significant prediction errors
    const highErrors = frames.filter((f: any) => f.predError > 2.0);
    if (highErrors.length > 0) {
      console.log('\n=== HIGH PREDICTION ERRORS (>2.0px) ===');
      highErrors.slice(0, 20).forEach((f: any) => {
        console.log(
          `t=${(f.t - frames[0].t).toFixed(0)}ms predErr=${f.predError.toFixed(4)} pos=(${f.localX.toFixed(2)},${f.localY.toFixed(2)}) server=(${f.serverX.toFixed(2)},${f.serverY.toFixed(2)}) distSq=${f.distSq.toFixed(4)}`
        );
      });
    }
  });

  test('IDLE-TO-STOP: Stand still, move, stop, observe jitter', async ({ page }) => {
    // First settle
    await page.waitForTimeout(1000);

    const startCapture = page.evaluate(() => {
      (window as any).__SECTO_DEBUG__.startCapture();
      return true;
    });

    // Move
    await page.click('canvas', { position: { x: 400, y: 300 } });
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');
    await page.waitForTimeout(1000);

    const stopCapture = page.evaluate(() => {
      const frames = (window as any).__SECTO_DEBUG__.stopCapture();
      return frames;
    });

    const frames = await stopCapture;
    console.log(`\n=== IDLE-TO-STOP CAPTURE: ${frames.length} frames ===`);

    // Find movement transition
    const movingFrames = frames.filter((f: any) => f.speed > 10);
    const lastMoveIdx = movingFrames.length > 0 ? frames.indexOf(movingFrames[movingFrames.length - 1]) : -1;
    
    console.log(`Last moving frame: ${lastMoveIdx}`);
    
    if (lastMoveIdx >= 0) {
      const postMove = frames.slice(lastMoveIdx + 1);
      const postMoveWalkTriggers = postMove.filter((f: any) => f.distSq > 1.0);
      
      console.log(`\nPost-move behavior (${postMove.length} frames):`);
      console.log(`Walk triggers after move stop: ${postMoveWalkTriggers.length}`);
      
      if (postMoveWalkTriggers.length > 0) {
        console.log('\nPost-move walk triggers:');
        postMoveWalkTriggers.slice(0, 15).forEach((f: any) => {
          const sinceMove = (f.t - frames[lastMoveIdx].t).toFixed(0);
          console.log(`  +${sinceMove}ms distSq=${f.distSq.toFixed(4)} pos=(${f.localX.toFixed(2)},${f.localY.toFixed(2)}) predErr=${f.predError.toFixed(4)}`);
        });
      }
    }

    // Reconciliation events
    const reconEvents = frames.filter((f: any) => f.serverDelta > 0.1);
    console.log(`\nServer reconciliation events: ${reconEvents.length}`);
  });

  test('SMALL-MOVEMENT: Rapid twitch movements', async ({ page }) => {
    const startCapture = page.evaluate(() => {
      (window as any).__SECTO_DEBUG__.startCapture();
      return true;
    });

    await page.click('canvas', { position: { x: 400, y: 300 } });
    
    // Quick twitch movements
    for (let i = 0; i < 5; i++) {
      await page.keyboard.down('w');
      await page.waitForTimeout(100);
      await page.keyboard.up('w');
      await page.waitForTimeout(50);
      
      await page.keyboard.down('d');
      await page.waitForTimeout(100);
      await page.keyboard.up('d');
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(1000);

    const stopCapture = page.evaluate(() => {
      const frames = (window as any).__SECTO_DEBUG__.stopCapture();
      return frames;
    });

    const frames = await stopCapture;
    console.log(`\n=== SMALL-MOVEMENT CAPTURE: ${frames.length} frames ===`);

    // Detect small jitters
    const smallJitters = frames.filter((f: any) => f.distSq > 0.01 && f.distSq <= 0.1);
    const walkTriggers = frames.filter((f: any) => f.distSq > 1.0);
    
    console.log(`Small jitters (0.01<distSq<0.1): ${smallJitters.length}`);
    console.log(`Walk triggers: ${walkTriggers.length}`);

    // Look for patterns in small jitters
    if (smallJitters.length > 0) {
      console.log('\nSmall jitter patterns:');
      const groups: Record<string, number[]> = {};
      
      smallJitters.forEach((f: any) => {
        const roundX = Math.round(f.localX);
        const roundY = Math.round(f.localY);
        const key = `${roundX},${roundY}`;
        
        if (!groups[key]) groups[key] = [];
        groups[key].push(f.distSq);
      });

      Object.entries(groups).slice(0, 10).forEach(([pos, distances]) => {
        const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
        console.log(`  Position ${pos}: avg distSq=${avgDist.toFixed(4)}, ${distances.length} frames`);
      });
    }
  });
});