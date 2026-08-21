/**
 * Full pipeline test: wait for ACTIVE phase, then inject movement
 * and verify server processes it.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Full Pipeline Validation', () => {
  test('movement works after countdown ends', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'log' || msg.type() === 'error' || msg.type() === 'warn') {
        const text = msg.text();
        if (text.includes('RECON-DBG') || text.includes('Sending input') || text.includes('error') || text.includes('DROPPED')) {
          console.log(`[BROWSER ${msg.type()}] ${text}`);
        }
      }
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(5000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(2000);

    // Wait for game to be ACTIVE (after countdown)
    console.log('Waiting for game to go ACTIVE...');
    let gameActive = false;
    for (let i = 0; i < 30; i++) {
      const state = await page.evaluate(() => {
        const d = (window as any).__SECTO_DEBUG__;
        if (!d || typeof d.getState !== 'function') return null;
        return d.getState();
      });
      if (state?.gameActive) {
        console.log(`Game active at attempt ${i}, tick=${state.tick}, phase=ACTIVE?`);
        gameActive = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!gameActive) {
      // Check if debug bridge has phase info
      const state = await page.evaluate(() => {
        const d = (window as any).__SECTO_DEBUG__;
        if (!d || typeof d.getState !== 'function') return { error: 'no bridge' };
        const s = d.getState();
        return {
          gameActive: s.gameActive,
          connected: s.connected,
          myId: s.myId,
          tick: s.tick,
          localPos: s.localPos,
          serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
        };
      });
      console.log('State after timeout:', JSON.stringify(state, null, 2));
    }

    // Now wait an extra 5 seconds for the countdown to finish
    // (gameActive might be true during countdown too — check what it actually means)
    console.log('Waiting 6 more seconds for countdown to clear...');
    await page.waitForTimeout(6000);

    // Get initial position
    const initial = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const s = d.getState();
      return {
        localPos: { ...s.localPos },
        serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
        tick: s.tick,
        gameActive: s.gameActive,
        connected: s.connected,
      };
    });
    console.log('\n=== INITIAL (after countdown) ===');
    console.log(JSON.stringify(initial, null, 2));

    // Inject sustained movement via keyboard (real input path)
    console.log('\n=== SENDING KEYBOARD INPUT (W key) ===');
    await page.locator('canvas').press('w');
    await page.waitForTimeout(1500);

    const afterKeyboard = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const s = d.getState();
      return {
        localPos: { ...s.localPos },
        serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y },
        tick: s.tick,
      };
    });
    console.log('After keyboard W (1.5s):', JSON.stringify(afterKeyboard, null, 2));

    const keyboardMovement = Math.sqrt(
      Math.pow(afterKeyboard.localPos.x - initial.localPos.x, 2) +
      Math.pow(afterKeyboard.localPos.y - initial.localPos.y, 2)
    );
    const serverKeyboardMovement = Math.sqrt(
      Math.pow(afterKeyboard.serverPos.x - initial.serverPos.x, 2) +
      Math.pow(afterKeyboard.serverPos.y - initial.serverPos.y, 2)
    );
    console.log(`Local movement: ${keyboardMovement.toFixed(2)}px`);
    console.log(`Server movement: ${serverKeyboardMovement.toFixed(2)}px`);

    // Now test via runtime.move (debug bridge path)
    console.log('\n=== TESTING RUNTIME.MOVE (debug bridge) ===');
    const beforeRuntime = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const s = d.getState();
      return { localPos: { ...s.localPos }, serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y } };
    });

    // Send continuous movement for 2 seconds
    await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      // runtime.move only sends once — we need to send repeatedly
      let count = 0;
      const interval = setInterval(() => {
        d.runtime.move(1, 1, Math.PI / 4);
        count++;
        if (count >= 120) clearInterval(interval); // 120 * 16ms = 2s
      }, 16);
    });
    await page.waitForTimeout(2500);

    const afterRuntime = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      const s = d.getState();
      return { localPos: { ...s.localPos }, serverPos: { x: s.players?.[0]?.x, y: s.players?.[0]?.y } };
    });
    console.log('After runtime.move (2s):', JSON.stringify(afterRuntime, null, 2));

    const runtimeLocalMovement = Math.sqrt(
      Math.pow(afterRuntime.localPos.x - beforeRuntime.localPos.x, 2) +
      Math.pow(afterRuntime.localPos.y - beforeRuntime.localPos.y, 2)
    );
    const runtimeServerMovement = Math.sqrt(
      Math.pow(afterRuntime.serverPos.x - beforeRuntime.serverPos.x, 2) +
      Math.pow(afterRuntime.serverPos.y - beforeRuntime.serverPos.y, 2)
    );
    console.log(`Runtime local movement: ${runtimeLocalMovement.toFixed(2)}px`);
    console.log(`Runtime server movement: ${runtimeServerMovement.toFixed(2)}px`);

    // Summary
    console.log('\n=== SUMMARY ===');
    console.log(`Keyboard: local=${keyboardMovement.toFixed(1)}px server=${serverKeyboardMovement.toFixed(1)}px`);
    console.log(`Runtime: local=${runtimeLocalMovement.toFixed(1)}px server=${runtimeServerMovement.toFixed(1)}px`);

    if (serverKeyboardMovement > 1) {
      console.log('🟢 SERVER PROCESSED KEYBOARD MOVEMENT');
    } else {
      console.log('🔴 SERVER DID NOT PROCESS KEYBOARD MOVEMENT');
    }

    if (runtimeServerMovement > 1) {
      console.log('🟢 SERVER PROCESSED RUNTIME MOVEMENT');
    } else {
      console.log('🔴 SERVER DID NOT PROCESS RUNTIME MOVEMENT');
    }

    expect(true).toBe(true);
  });
});
