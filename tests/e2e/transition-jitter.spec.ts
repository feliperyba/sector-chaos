/**
 * Move-to-stop transition jitter diagnostic.
 * Move for 2 seconds, release W, then sample at high frequency
 * to catch the exact moment where jitter might trigger isMoving oscillation.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Move-Stop Transition Jitter', () => {
  test('catch isMoving oscillation at move→stop boundary', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      logs.push(text);
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(6000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(8000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Move diagonally for 2 seconds to avoid hitting wall
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2000);

    // Release keys and IMMEDIATELY start sampling
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyD');

    const transitionData = await page.evaluate(async () => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      if (!gameScene) return { error: 'no GameScene' };

      const bridge = gameScene.debugBridge;
      const renderer = gameScene.playerRenderer;

      const getSnapshot = () => {
        const s = bridge.getState();
        const p = s?.players?.find((pl: any) => pl.id === s.myId);
        const visual = gameScene.getVisualPosition?.();
        const predAcc = gameScene.predictionAccumulator;

        // Access the renderer's internal isMoving state for our player
        const myId = s?.myId;
        const vis = renderer?.visuals?.get(myId);

        return {
          serverX: p?.x, serverY: p?.y,
          localX: gameScene.localPos?.x, localY: gameScene.localPos?.y,
          velX: gameScene.localVelocity?.x, velY: gameScene.localVelocity?.y,
          accValue: typeof predAcc === 'object' ? predAcc.value : predAcc,
          visualX: visual?.x, visualY: visual?.y,
          predictionError: bridge.getPredictionError(),
          // Renderer internals
          isMoving: vis?.isMoving,
          targetX: vis?.targetX, targetY: vis?.targetY,
          prevTargetX: vis?.prevTargetX, prevTargetY: vis?.prevTargetY,
          lastMoveTime: vis?.lastMoveTime,
          ts: performance.now(),
        };
      };

      // Sample every 16ms for 2 seconds = 125 samples
      const samples: any[] = [];
      for (let i = 0; i < 125; i++) {
        samples.push(getSnapshot());
        await new Promise(r => setTimeout(r, 16));
      }
      return { samples };
    });

    if (transitionData.error) {
      console.log('ERROR:', transitionData.error);
      logs.filter(l => l.includes('error') || l.includes('GameScene')).forEach(l => console.log(l));
      expect(true).toBe(true);
      return;
    }

    const samples = transitionData.samples;
    console.log(`\n=== TRANSITION SAMPLES: ${samples.length} over ${((samples[samples.length-1]?.ts - samples[0]?.ts)/1000).toFixed(1)}s ===`);

    // Track isMoving transitions
    let movingToStill = 0;
    let stillToMoving = 0;
    let currentMoving = samples[0]?.isMoving;

    for (let i = 1; i < samples.length; i++) {
      if (samples[i].isMoving !== samples[i-1].isMoving) {
        if (samples[i-1].isMoving && !samples[i].isMoving) {
          movingToStill++;
          console.log(`  [${i}] MOVING→STILL at vis=(${samples[i].visualX?.toFixed(2)},${samples[i].visualY?.toFixed(2)}) vel=(${samples[i].velX?.toFixed(2)},${samples[i].velY?.toFixed(2)})`);
        } else {
          stillToMoving++;
          console.log(`  [${i}] STILL→MOVING at vis=(${samples[i].visualX?.toFixed(2)},${samples[i].visualY?.toFixed(2)}) vel=(${samples[i].velX?.toFixed(2)},${samples[i].velY?.toFixed(2)})`);
        }
      }
    }

    console.log(`\nisMoving transitions: STILL→MOVING=${stillToMoving}, MOVING→STILL=${movingToStill}`);

    // Find all samples where isMoving flipped
    const oscillationEvents: number[] = [];
    let lastState = samples[0]?.isMoving;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].isMoving !== lastState) {
        oscillationEvents.push(i);
        lastState = samples[i].isMoving;
      }
    }

    if (oscillationEvents.length > 4) {
      console.log(`🔴 OSCILLATION DETECTED: ${oscillationEvents.length} isMoving flips → walk animation flicker`);
      // Print the oscillation region
      const minIdx = Math.max(0, oscillationEvents[0] - 3);
      const maxIdx = Math.min(samples.length - 1, oscillationEvents[oscillationEvents.length - 1] + 3);
      console.log(`\nOscillation region [${minIdx}..${maxIdx}]:`);
      for (let i = minIdx; i <= maxIdx; i++) {
        const s = samples[i];
        const dx = s.targetX - s.prevTargetX;
        const dy = s.targetY - s.prevTargetY;
        const distSq = dx*dx + dy*dy;
        console.log(`  [${i.toString().padStart(3)}] isMoving=${String(s.isMoving).padStart(5)} target=(${s.targetX?.toFixed(3)},${s.targetY?.toFixed(3)}) prev=(${s.prevTargetX?.toFixed(3)},${s.prevTargetY?.toFixed(3)}) dx=${dx?.toFixed(4)} dy=${dy?.toFixed(4)} distSq=${distSq?.toFixed(6)} vel=(${s.velX?.toFixed(2)},${s.velY?.toFixed(2)}) acc=${s.accValue?.toFixed(6)}`);
      }
    }

    // Print velocity profile around transition
    console.log('\nVelocity profile (first 30 samples):');
    for (let i = 0; i < Math.min(30, samples.length); i++) {
      const s = samples[i];
      const vel = Math.sqrt((s.velX||0)**2 + (s.velY||0)**2);
      console.log(`  [${i.toString().padStart(3)}] isMoving=${String(s.isMoving).padStart(5)} vel=${vel.toFixed(2)} acc=${s.accValue?.toFixed(6)} err=${s.predictionError?.toFixed(4)} vis=(${s.visualX?.toFixed(2)},${s.visualY?.toFixed(2)})`);
    }

    // Print JITTER-DBG logs from renderer
    const jitterLogs = logs.filter(l => l.includes('JITTER-DBG'));
    if (jitterLogs.length > 0) {
      console.log('\n=== JITTER-DBG LOGS (from renderer) ===');
      jitterLogs.slice(0, 20).forEach(l => console.log(l));
    }

    expect(true).toBe(true);
  });
});
