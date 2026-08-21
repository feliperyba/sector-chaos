/**
 * Sustained movement jitter diagnostic.
 * Press W, sample positions for 3 seconds while moving.
 * Then release W, sample while decelerating.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Movement Jitter Diagnostic', () => {
  test('track position oscillations during sustained movement', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

    await page.goto(GAME_URL);
    await page.waitForTimeout(6000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(8000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // PHASE 1: Press W and sample while moving (3 seconds)
    await page.keyboard.down('KeyW');

    // Give it 500ms to start moving, then sample
    await page.waitForTimeout(500);

    // Collect 30 snapshots over 1.5 seconds (every 50ms)
    const moveData = await page.evaluate(async () => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      if (!gameScene) return { error: 'no GameScene' };

      const bridge = gameScene.debugBridge;
      if (!bridge) return { error: 'no debugBridge' };

      const getSnapshot = () => {
        const s = bridge.getState();
        const p = s?.players?.find((pl: any) => pl.id === s.myId);
        const visual = gameScene.getVisualPosition?.();
        const localPos = { x: gameScene.localPos?.x, y: gameScene.localPos?.y };
        const localVel = { x: gameScene.localVelocity?.x, y: gameScene.localVelocity?.y };
        const predAcc = gameScene.predictionAccumulator;

        return {
          serverX: p?.x, serverY: p?.y,
          serverVx: p?.velocityX, serverVy: p?.velocityY,
          localX: localPos.x, localY: localPos.y,
          velX: localVel.x, velY: localVel.y,
          accValue: typeof predAcc === 'object' ? predAcc.value : predAcc,
          visualX: visual?.x, visualY: visual?.y,
          predictionError: bridge.getPredictionError(),
          ts: performance.now(),
        };
      };

      const samples: any[] = [];
      for (let i = 0; i < 30; i++) {
        samples.push(getSnapshot());
        await new Promise(r => setTimeout(r, 50));
      }
      return { samples, phase: 'moving' };
    });

    // Release W
    await page.keyboard.up('KeyW');

    // PHASE 2: Sample while decelerating (1.5 seconds)
    await page.waitForTimeout(200);

    const decelData = await page.evaluate(async () => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      const bridge = gameScene?.debugBridge;
      if (!bridge) return { error: 'no bridge' };

      const getSnapshot = () => {
        const s = bridge.getState();
        const p = s?.players?.find((pl: any) => pl.id === s.myId);
        const visual = gameScene.getVisualPosition?.();
        const localPos = { x: gameScene.localPos?.x, y: gameScene.localPos?.y };
        const localVel = { x: gameScene.localVelocity?.x, y: gameScene.localVelocity?.y };
        const predAcc = gameScene.predictionAccumator;

        return {
          serverX: p?.x, serverY: p?.y,
          localX: localPos.x, localY: localPos.y,
          velX: localVel.x, velY: localVel.y,
          visualX: visual?.x, visualY: visual?.y,
          predictionError: bridge.getPredictionError(),
          ts: performance.now(),
        };
      };

      const samples: any[] = [];
      for (let i = 0; i < 30; i++) {
        samples.push(getSnapshot());
        await new Promise(r => setTimeout(r, 50));
      }
      return { samples, phase: 'decelerating' };
    });

    // Analyze both phases
    function analyzePhase(name: string, data: any) {
      if (data.error) {
        console.log(`${name}: ERROR - ${data.error}`);
        return;
      }
      const samples = data.samples;
      console.log(`\n=== ${name.toUpperCase()} (${samples.length} samples, ${((samples[samples.length-1]?.ts - samples[0]?.ts)/1000).toFixed(1)}s) ===`);

      // Velocity stats
      const vels = samples.map(s => Math.sqrt((s.velX || 0)**2 + (s.velY || 0)**2));
      const avgVel = vels.reduce((a,b)=>a+b,0)/vels.length;
      const maxVel = Math.max(...vels);
      const minVel = Math.min(...vels);
      const velVar = vels.reduce((s,v) => s + (v-avgVel)**2, 0) / vels.length;
      console.log(`Velocity: avg=${avgVel.toFixed(2)} range=${(maxVel-minVel).toFixed(2)} variance=${velVar.toFixed(2)}`);

      // Prediction error
      const errors = samples.map(s => s.predictionError);
      const avgErr = errors.reduce((a,b)=>a+b,0)/errors.length;
      const maxErr = Math.max(...errors);
      console.log(`Prediction error: avg=${avgErr.toFixed(4)} max=${maxErr.toFixed(4)}`);

      // Visual delta variance
      const visualDeltas: number[] = [];
      for (let i = 1; i < samples.length; i++) {
        const vd = Math.sqrt((samples[i].visualX - samples[i-1].visualX)**2 + (samples[i].visualY - samples[i-1].visualY)**2);
        visualDeltas.push(vd);
      }
      const avgVD = visualDeltas.reduce((a,b)=>a+b,0)/visualDeltas.length;
      const vdVar = visualDeltas.reduce((s,d) => s + (d-avgVD)**2, 0) / visualDeltas.length;
      console.log(`Visual delta: avg=${avgVD.toFixed(4)} variance=${vdVar.toFixed(6)}`);

      // Oscillation (direction reversals in visual position)
      let oscillation = 0;
      for (let i = 2; i < samples.length; i++) {
        const dx1 = samples[i-1].visualX - samples[i-2].visualX;
        const dx2 = samples[i].visualX - samples[i-1].visualX;
        const dy1 = samples[i-1].visualY - samples[i-2].visualY;
        const dy2 = samples[i].visualY - samples[i-1].visualY;
        if ((dx1*dx2 < 0 || dy1*dy2 < 0) && (Math.abs(dx2) > 0.01 || Math.abs(dy2) > 0.01)) {
          oscillation++;
        }
      }
      console.log(`Oscillation: ${oscillation}/${samples.length-2} direction reversals`);

      // Print sampled positions
      console.log('Positions:');
      for (let i = 0; i < samples.length; i += 5) {
        const s = samples[i];
        console.log(`  [${i.toString().padStart(2)}] vis=(${s.visualX?.toFixed(2)},${s.visualY?.toFixed(2)}) local=(${s.localX?.toFixed(2)},${s.localY?.toFixed(2)}) server=(${s.serverX?.toFixed(2)},${s.serverY?.toFixed(2)}) vel=(${s.velX?.toFixed(2)},${s.velY?.toFixed(2)}) err=${s.predictionError?.toFixed(4)}`);
      }
    }

    analyzePhase('MOVING', moveData);
    analyzePhase('DECELERATING', decelData);

    expect(true).toBe(true);
  });
});
