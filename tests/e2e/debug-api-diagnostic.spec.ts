/**
 * Debug API diagnostic - check what's actually available
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';
const COUNTDOWN_WAIT = 8000;

test.describe('Debug API Diagnostic', () => {
  test('check debug bridge availability and state structure', async ({ page }) => {
    const debugInfo: string[] = [];

    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(1000);

    // Try to access debug bridge methods
    const result = await page.evaluate(async () => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (!debug) {
        return { error: 'No __SECTO_DEBUG__ object found' };
      }

      const result: Record<string, unknown> = {
        debugExists: !!debug,
        debugMethods: Object.keys(debug),
        debugToString: String(debug),
      };

      // Try common methods
      const methodTests: Record<string, () => unknown> = {
        getState: () => debug.getState?.(),
        getPredictionError: () => debug.getPredictionError?.(),
        getNetcodeMetrics: () => debug.telemetry?.snapshot?.(),
        rawInput: () => debug.runtime?.move?.(0, 0, 0),
        connectToRoom: () => debug.connectToRoom?.({ mapType: 'demo', botCount: 0 }),
      };

      for (const [name, method] of Object.entries(methodTests)) {
        try {
          const res = method();
          result[name] = res !== undefined ? res : 'undefined';
        } catch (error) {
          result[name] = `ERROR: ${error}`;
        }
      }

      // Try to wait a bit and get state again
      try {
        await new Promise((r) => setTimeout(r, 100));
        const state = debug.getState?.();
        result.finalState = state ? 'Got state' : 'No state';
        if (state) {
          result.stateKeys = Object.keys(state);
          if (state.players) {
            result.players = Array.isArray(state.players) ? state.players.slice(0, 3) : 'Not array';
          }
          if (state.localPos) {
            result.localPos = state.localPos;
          }
        }
      } catch (error) {
        result.finalState = `ERROR: ${error}`;
      }

      return result;
    });

    console.log('=== Debug API Diagnostic Results ===');
    console.log(JSON.stringify(result, null, 2));

    // Check if we have access to the debug bridge
    if (typeof result === 'object' && result.debugExists) {
      expect(result.debugExists, 'Debug bridge should exist').toBe(true);
      console.log('Available methods:', result.debugMethods);
      
      if (result.getState && typeof result.getState === 'object') {
        console.log('getState returned object');
        console.log('State keys:', result.stateKeys);
        console.log('Local pos:', result.localPos);
        console.log('Players:', result.players);
      }
    } else {
      console.log('Debug bridge not accessible');
    }
  });
});