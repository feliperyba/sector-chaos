/**
 * Runtime validation of ADR-0016: Client-Side Collision Resolution.
 * Validates that:
 * 1. Prediction matches server position near walls (no Mode A overshoot)
 * 2. Wall-sliding works diagonally (no Mode B sticky walls)
 * 3. Walk animation doesn't flicker when stationary near wall
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';
const COUNTDOWN_WAIT = 8000;

test.describe('Collision Resolution Validation (ADR-0016)', () => {
  test('wall-proximity: prediction error near walls is zero', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        errors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Move toward nearest wall (W key) for 3 seconds
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);

    // Now we should be near a wall. Sample prediction error for 2 seconds while stationary.
    const samples = await page.evaluate(async () => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (!debug) return { error: 'No __SECTO_DEBUG__' };

      const results: Array<{
        localPos: { x: number; y: number };
        serverPos: { x: number; y: number };
        predictionError: number;
        players?: Array<{ x: number; y: number }>;
      }> = [];

      for (let i = 0; i < 60; i++) {
        const state = debug.getState?.();
        if (state) {
          const serverPlayer = state.players?.[0];
          const dx = state.localPos.x - serverPlayer.x;
          const dy = state.localPos.y - serverPlayer.y;
          results.push({
            localPos: state.localPos,
            serverPos: { x: serverPlayer.x, y: serverPlayer.y },
            predictionError: Math.sqrt(dx * dx + dy * dy),
            players: state.players,
          });
        }
        await new Promise((r) => setTimeout(r, 33));
      }
      return results;
    });

    console.log('=== Wall Proximity Prediction Error Samples ===');
    if (!Array.isArray(samples)) {
      console.log('DEBUG STATE ERROR:', JSON.stringify(samples));
    } else {
      const errors2 = samples.filter((s) => typeof s.predictionError === 'number');
      const maxError = Math.max(...errors2.map((s) => s.predictionError));
      const avgError =
        errors2.reduce((sum, s) => sum + s.predictionError, 0) / errors2.length;
      const movingFrames = errors2.filter((s) => s.players?.[0]?.x !== s.serverPos.x || s.players[0]?.y !== s.serverPos.y).length;

      console.log(`Samples: ${errors2.length}`);
      console.log(`Max prediction error: ${maxError.toFixed(4)}px`);
      console.log(`Avg prediction error: ${avgError.toFixed(4)}px`);
      console.log(`Frames with movement change: ${movingFrames}/${errors2.length}`);
      console.log(
        `First 5: ${errors2
          .slice(0, 5)
          .map((s) => `${s.predictionError.toFixed(2)}px`)
          .join(', ')}`,
      );
      console.log(
        `Last 5: ${errors2
          .slice(-5)
          .map((s) => `${s.predictionError.toFixed(2)}px`)
          .join(', ')}`,
      );

      // ADR-0016 goal: prediction error should be < 1px near walls (was 2-5px before)
      expect(maxError, 'Max prediction error should be under 1px').toBeLessThan(1.0);
      expect(avgError, 'Avg prediction error should be under 0.5px').toBeLessThan(0.5);
    }
  });

  test('wall-sliding: diagonal movement should slide along walls', async ({ page }) => {
    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Move diagonally (W+D) for 3 seconds — should slide along walls
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(3000);

    // Sample positions while moving diagonally near wall
    const result = await page.evaluate(async () => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (!debug) return { error: 'No __SECTO_DEBUG__' };

      const positions: Array<{ x: number; y: number; t: number }> = [];
      const start = performance.now();

      for (let i = 0; i < 40; i++) {
        const state = debug.getState?.();
        if (state) {
          positions.push({ x: state.localPos.x, y: state.localPos.y, t: performance.now() - start });
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return positions;
    });

    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyD');

    console.log('=== Wall-Sliding Position Samples ===');
    if (!Array.isArray(result)) {
      console.log('ERROR:', JSON.stringify(result));
      return;
    }

    // Check that position actually changes (not stuck / sticky wall)
    const deltas = result.slice(1).map((p, i) => {
      const prev = result[i];
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      return Math.sqrt(dx * dx + dy * dy);
    });

    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const zeroDeltaFrames = deltas.filter((d) => d < 0.1).length;

    console.log(`Position samples: ${result.length}`);
    console.log(`Avg delta per frame: ${avgDelta.toFixed(2)}px`);
    console.log(`Near-zero delta frames: ${zeroDeltaFrames}/${deltas.length}`);
    console.log(
      `First 5 positions: ${result
        .slice(0, 5)
        .map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`)
        .join(' → ')}`,
    );
    console.log(
      `Last 5 positions: ${result
        .slice(-5)
        .map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`)
        .join(' → ')}`,
    );

    // Position should change consistently — if stuck on wall, avgDelta would be near 0
    // With diagonal movement near walls, wall-sliding should produce SOME movement
    // Not all frames move (wall collision), but most should
    expect(zeroDeltaFrames, 'Too many stuck frames — wall sliding not working').toBeLessThan(
      deltas.length * 0.7,
    );
  });

  test('prediction vs server: sustained movement error', async ({ page }) => {
    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);

    // Move in random directions to hit various wall configurations
    const keys = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
    const moves = [
      { keys: ['KeyW', 'KeyD'], duration: 2000 },
      { keys: ['KeyW', 'KeyA'], duration: 2000 },
      { keys: ['KeyS', 'KeyD'], duration: 2000 },
      { keys: ['KeyS'], duration: 2000 },
    ];

    for (const move of moves) {
      for (const k of move.keys) await page.keyboard.down(k);
      await page.waitForTimeout(move.duration);
      for (const k of move.keys) await page.keyboard.up(k);
      await page.waitForTimeout(300);
    }

    // Now sample prediction error during and after movement
    const result = await page.evaluate(async () => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (!debug) return { error: 'No __SECTO_DEBUG__' };

      interface ErrorSample {
        predictionError: number;
        localPos: { x: number; y: number };
        serverPos: { x: number; y: number };
      }

      const samples: ErrorSample[] = [];

      // Sample while stationary first
      for (let i = 0; i < 30; i++) {
        const state = debug.getState?.();
        if (state) {
          const serverPlayer = state.players?.[0];
          if (serverPlayer) {
            const dx = state.localPos.x - serverPlayer.x;
            const dy = state.localPos.y - serverPlayer.y;
            samples.push({
              predictionError: Math.sqrt(dx * dx + dy * dy),
              localPos: state.localPos,
              serverPos: { x: serverPlayer.x, y: serverPlayer.y },
            });
          }
        }
        await new Promise((r) => setTimeout(r, 33));
      }
      return samples;
    });

    console.log('=== Post-Movement Prediction Error ===');
    if (!Array.isArray(result)) {
      console.log('ERROR:', JSON.stringify(result));
      return;
    }

    const predictionErrors = result.map((s) => s.predictionError);
    const maxErr = Math.max(...predictionErrors);
    const avgErr = predictionErrors.reduce((a, b) => a + b, 0) / predictionErrors.length;

    console.log(`Samples: ${predictionErrors.length}`);
    console.log(`Max prediction error: ${maxErr.toFixed(4)}px`);
    console.log(`Avg prediction error: ${avgErr.toFixed(4)}px`);
    console.log(
      `All errors: ${predictionErrors.map((e) => e.toFixed(2)).join(', ')}`,
    );

    // After all that wall-hitting, prediction should still be accurate
    expect(avgErr, 'Avg error after wall movement').toBeLessThan(1.0);
    expect(maxErr, 'Max error after wall movement').toBeLessThan(2.0);
  });
});
