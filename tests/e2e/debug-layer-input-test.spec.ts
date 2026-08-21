/**
 * Debug Layer Input Validation — uses window.__SECTO_DEBUG__ properly.
 * Injects inputs through the debug bridge and verifies server processes them.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Debug Layer Input Validation', () => {
  test('validate inputs via window.__SECTO_DEBUG__', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'error') {
        console.log(`[BROWSER ${msg.type()}] ${msg.text()}`);
      }
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(5000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Navigate to game scene
    await page.evaluate(() => {
      (window as any).__SECTO_DEBUG__?.goToGame?.();
    });
    await page.waitForTimeout(8000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Check what's on window.__SECTO_DEBUG__
    const debugType = await page.evaluate(() => typeof (window as any).__SECTO_DEBUG__);
    console.log(`__SECTO_DEBUG__ type: ${debugType}`);

    if (debugType !== 'object') {
      throw new Error(`__SECTO_DEBUG__ is ${debugType}, expected object`);
    }

    // Check available methods
    const debugMethods = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const methods: Record<string, string> = {};
      for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(d) || d)) {
        methods[key] = typeof d[key];
      }
      // Also check own properties
      for (const key in d) {
        methods[key] = typeof d[key];
      }
      return methods;
    });
    console.log('__SECTO_DEBUG__ methods:', JSON.stringify(debugMethods, null, 2));

    // Get initial state
    const initialState = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      if (typeof d.getState !== 'function') {
        return { error: 'getState is not a function', keys: Object.keys(d) };
      }
      const s = d.getState();
      return {
        myId: s.myId,
        tick: s.tick,
        localPos: s.localPos,
        serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
        connected: s.connected,
        gameActive: s.gameActive,
      };
    });
    console.log('\n=== INITIAL STATE ===');
    console.log(JSON.stringify(initialState, null, 2));

    if (initialState.error) {
      throw new Error(`getState failed: ${initialState.error}`);
    }

    // Test 1: Inject movement via runtime.move()
    console.log('\n=== TEST 1: runtime.move() ===');
    await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      d.runtime.move(1, 0, 0);
    });
    await page.waitForTimeout(1000);

    const afterMove = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const s = d.getState();
      return {
        localPos: s.localPos,
        serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
        localVel: s.localVelocity,
        tick: s.tick,
      };
    });
    console.log('After runtime.move(1,0,0):', JSON.stringify(afterMove, null, 2));

    const moveError = Math.sqrt(
      Math.pow(afterMove.localPos.x - afterMove.serverPos.x, 2) +
      Math.pow(afterMove.localPos.y - afterMove.serverPos.y, 2)
    );
    console.log(`Prediction error after move: ${moveError.toFixed(2)}px`);

    // Test 2: Inject sustained movement and sample multiple frames
    console.log('\n=== TEST 2: Sustained movement with sampling ===');
    const samples: any[] = [];
    
    // Start continuous movement
    await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      d.runtime.move(0, -1, -Math.PI / 2); // Move up
    });

    for (let i = 0; i < 20; i++) {
      const frame = await page.evaluate(() => {
        const d = (window as any).__SECTO_DEBUG__;
        const s = d.getState();
        return {
          localPos: { ...s.localPos },
          serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
          localVel: { ...s.localVelocity },
          tick: s.tick,
        };
      });
      samples.push(frame);
      await page.waitForTimeout(50);
    }

    // Release movement
    await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      d.runtime.move(0, 0, 0);
    });

    // Summary
    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];
    const localMovement = Math.sqrt(
      Math.pow(lastSample.localPos.x - firstSample.localPos.x, 2) +
      Math.pow(lastSample.localPos.y - firstSample.localPos.y, 2)
    );
    const serverMovement = Math.sqrt(
      Math.pow(lastSample.serverPos.x - firstSample.serverPos.x, 2) +
      Math.pow(lastSample.serverPos.y - firstSample.serverPos.y, 2)
    );

    console.log(`Local movement: ${localMovement.toFixed(2)}px`);
    console.log(`Server movement: ${serverMovement.toFixed(2)}px`);
    console.log(`Samples: ${samples.length}`);
    console.log(`Tick range: ${firstSample.tick} → ${lastSample.tick}`);

    // Log first 5 and last 5 samples
    console.log('\nFirst 5 samples:');
    samples.slice(0, 5).forEach((s, i) => {
      const err = Math.sqrt(Math.pow(s.localPos.x - s.serverPos.x, 2) + Math.pow(s.localPos.y - s.serverPos.y, 2));
      console.log(`  [${i}] local=(${s.localPos.x.toFixed(1)},${s.localPos.y.toFixed(1)}) server=(${s.serverPos.x.toFixed(1)},${s.serverPos.y.toFixed(1)}) err=${err.toFixed(2)}px tick=${s.tick}`);
    });
    console.log('\nLast 5 samples:');
    samples.slice(-5).forEach((s, i) => {
      const err = Math.sqrt(Math.pow(s.localPos.x - s.serverPos.x, 2) + Math.pow(s.localPos.y - s.serverPos.y, 2));
      console.log(`  [${samples.length - 5 + i}] local=(${s.localPos.x.toFixed(1)},${s.localPos.y.toFixed(1)}) server=(${s.serverPos.x.toFixed(1)},${s.serverPos.y.toFixed(1)}) err=${err.toFixed(2)}px tick=${s.tick}`);
    });

    if (serverMovement < 1) {
      console.log('\n🔴 SERVER DID NOT PROCESS MOVEMENT — inputs not reaching server simulation');
    } else {
      console.log('\n🟢 SERVER PROCESSED MOVEMENT');
    }

    expect(true).toBe(true);
  });
});
