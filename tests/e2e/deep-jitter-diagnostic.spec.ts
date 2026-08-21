/**
 * Deep jitter diagnostic: track visual position changes frame-by-frame
 * to detect micro-oscillations even when prediction error is zero.
 *
 * This records the player's visual position every 100ms for 5 seconds
 * during idle, then analyzes the position delta variance.
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const GAME_URL = 'http://localhost:8080';

test.describe('Deep Jitter Diagnostic', () => {
  test('track visual position oscillations during idle', async ({ page }) => {
    // Collect ALL console logs
    const logs: string[] = [];
    page.on('console', (msg) => {
      logs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Navigate and enter game
    await page.goto(GAME_URL);
    await page.waitForTimeout(6000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(8000);

    // Focus canvas
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // First: move for 2 seconds to build up state
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');

    // Wait for deceleration
    await page.waitForTimeout(1000);

    // Now sample visual position every 100ms for 5 seconds while IDLE
    const positionData = await page.evaluate(async () => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      if (!gameScene) return { error: 'no GameScene' };

      const bridge = gameScene.debugBridge;
      const state = bridge?.getState();
      const myId = state?.myId;

      if (!myId) return { error: 'no myId' };

      // Helper to get current state snapshot
      const getSnapshot = () => {
        const s = bridge.getState();
        const p = s?.players?.find((pl: any) => pl.id === s.myId);
        // Also get the GameScene's internal visual position
        const visual = gameScene.getVisualPosition?.();
        const localPos = { x: gameScene.localPos?.x, y: gameScene.localPos?.y };
        const localVel = { x: gameScene.localVelocity?.x, y: gameScene.localVelocity?.y };
        const predAcc = gameScene.predictionAccumulator;

        return {
          serverX: p?.x,
          serverY: p?.y,
          serverVx: p?.velocityX,
          serverVy: p?.velocityY,
          localX: localPos.x,
          localY: localPos.y,
          velX: localVel.x,
          velY: localVel.y,
          accValue: typeof predAcc === 'object' ? predAcc.value : predAcc,
          visualX: visual?.x,
          visualY: visual?.y,
          predictionError: bridge.getPredictionError(),
          timestamp: performance.now(),
        };
      };

      // Sample every 50ms for 5 seconds = 100 samples
      const samples: any[] = [];
      for (let i = 0; i < 100; i++) {
        samples.push(getSnapshot());
        await new Promise(r => setTimeout(r, 50));
      }

      return { samples, myId };
    });

    if (positionData.error) {
      console.log('ERROR:', positionData.error);
      // Dump game logs
      logs.filter(l => l.includes('GameScene') || l.includes('error'))
        .forEach(l => console.log(l));
      expect(positionData.error).toBeUndefined();
      return;
    }

    // Analyze position changes
    const samples = positionData.samples;
    console.log(`\n=== POSITION SAMPLES: ${samples.length} over ${((samples[samples.length - 1]?.timestamp - samples[0]?.timestamp) / 1000).toFixed(1)}s ===`);

    // Check if local position changes while idle
    let localPosChanges = 0;
    let visualPosChanges = 0;
    let serverPosChanges = 0;
    let maxLocalDelta = 0;
    let maxVisualDelta = 0;
    let maxServerDelta = 0;
    const localDeltas: number[] = [];
    const visualDeltas: number[] = [];
    const serverDeltas: number[] = [];

    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const curr = samples[i];

      const localDelta = Math.sqrt((curr.localX - prev.localX) ** 2 + (curr.localY - prev.localY) ** 2);
      const visualDelta = Math.sqrt((curr.visualX - prev.visualX) ** 2 + (curr.visualY - prev.visualY) ** 2);
      const serverDelta = Math.sqrt((curr.serverX - prev.serverX) ** 2 + (curr.serverY - prev.serverY) ** 2);

      if (localDelta > 0.01) localPosChanges++;
      if (visualDelta > 0.01) visualPosChanges++;
      if (serverDelta > 0.01) serverPosChanges++;

      maxLocalDelta = Math.max(maxLocalDelta, localDelta);
      maxVisualDelta = Math.max(maxVisualDelta, visualDelta);
      maxServerDelta = Math.max(maxServerDelta, serverDelta);

      localDeltas.push(localDelta);
      visualDeltas.push(visualDelta);
      serverDeltas.push(serverDelta);
    }

    const avgLocalDelta = localDeltas.reduce((a, b) => a + b, 0) / localDeltas.length;
    const avgVisualDelta = visualDeltas.reduce((a, b) => a + b, 0) / visualDeltas.length;
    const avgServerDelta = serverDeltas.reduce((a, b) => a + b, 0) / serverDeltas.length;

    console.log('\n=== POSITION CHANGE ANALYSIS (IDLE) ===');
    console.log(`Local pos changes (>0.01px): ${localPosChanges}/${samples.length - 1} samples`);
    console.log(`Visual pos changes (>0.01px): ${visualPosChanges}/${samples.length - 1} samples`);
    console.log(`Server pos changes (>0.01px): ${serverPosChanges}/${samples.length - 1} samples`);
    console.log(``);
    console.log(`Local  — avg: ${avgLocalDelta.toFixed(4)}px, max: ${maxLocalDelta.toFixed(4)}px`);
    console.log(`Visual — avg: ${avgVisualDelta.toFixed(4)}px, max: ${maxVisualDelta.toFixed(4)}px`);
    console.log(`Server — avg: ${avgServerDelta.toFixed(4)}px, max: ${maxServerDelta.toFixed(4)}px`);

    // Check velocity while idle
    const avgVelX = samples.reduce((s, p) => s + (p.velX || 0), 0) / samples.length;
    const avgVelY = samples.reduce((s, p) => s + (p.velY || 0), 0) / samples.length;
    const avgServerVx = samples.reduce((s, p) => s + (p.serverVx || 0), 0) / samples.length;
    const avgServerVy = samples.reduce((s, p) => s + (p.serverVy || 0), 0) / samples.length;
    console.log(``);
    console.log(`Avg local velocity: (${avgVelX.toFixed(4)}, ${avgVelY.toFixed(4)})`);
    console.log(`Avg server velocity: (${avgServerVx.toFixed(4)}, ${avgServerVy.toFixed(4)})`);

    // Check if prediction accumulator oscillates
    const accValues = samples.map(s => s.accValue);
    const avgAcc = accValues.reduce((a, b) => a + b, 0) / accValues.length;
    const maxAcc = Math.max(...accValues);
    const minAcc = Math.min(...accValues);
    console.log(``);
    console.log(`Prediction accumulator: avg=${avgAcc.toFixed(6)}, min=${minAcc.toFixed(6)}, max=${maxAcc.toFixed(6)}`);
    console.log(`Prediction error: avg=${(samples.reduce((s, p) => s + p.predictionError, 0) / samples.length).toFixed(6)}px`);

    // Print first 10 and last 10 samples for detailed inspection
    console.log('\n=== FIRST 10 SAMPLES ===');
    samples.slice(0, 10).forEach((s, i) => {
      console.log(`[${i}] local=(${s.localX?.toFixed(2)},${s.localY?.toFixed(2)}) visual=(${s.visualX?.toFixed(2)},${s.visualY?.toFixed(2)}) server=(${s.serverX?.toFixed(2)},${s.serverY?.toFixed(2)}) vel=(${s.velX?.toFixed(4)},${s.velY?.toFixed(4)}) acc=${s.accValue?.toFixed(6)}`);
    });

    // Detect oscillation: position goes up then down repeatedly
    let oscillationCount = 0;
    for (let i = 2; i < localDeltas.length; i++) {
      const d1 = localDeltas[i - 2]; // two frames ago
      const d2 = localDeltas[i]; // current
      // If position changed in opposite directions, that's oscillation
      if (i >= 2 && samples[i].localX !== undefined && samples[i-1].localX !== undefined && samples[i-2].localX !== undefined) {
        const dx1 = samples[i-1].localX - samples[i-2].localX;
        const dx2 = samples[i].localX - samples[i-1].localX;
        if (dx1 * dx2 < 0 && (Math.abs(dx1) > 0.01 || Math.abs(dx2) > 0.01)) {
          oscillationCount++;
        }
      }
    }
    console.log(`\nX-axis oscillation events: ${oscillationCount}/${localDeltas.length} samples`);

    // DIAGNOSIS
    console.log('\n=== DIAGNOSIS ===');
    if (localPosChanges > samples.length * 0.5) {
      console.log('⚠️  LOCAL POSITION IS CHANGING WHILE IDLE — prediction is continuously adjusting');
    }
    if (visualPosChanges > samples.length * 0.5) {
      console.log('⚠️  VISUAL POSITION IS CHANGING WHILE IDLE — this would cause walk animation flicker');
    }
    if (maxVisualDelta > 0.5) {
      console.log(`⚠️  LARGE VISUAL JUMP: ${maxVisualDelta.toFixed(4)}px — visible snap`);
    }
    if (Math.abs(avgVelX) > 0.1 || Math.abs(avgVelY) > 0.1) {
      console.log('⚠️  NON-ZERO LOCAL VELOCITY WHILE IDLE — deceleration not reaching zero');
    }
    if (oscillationCount > 10) {
      console.log(`⚠️  OSCILLATION DETECTED: ${oscillationCount} direction reversals in position`);
    }

    await page.screenshot({
      path: path.join('test-results', 'deep-jitter-diagnostic.png'),
    });

    expect(true).toBe(true);
  });
});
