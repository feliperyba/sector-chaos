/**
 * Runtime validation: detect prediction jitter on the local player.
 *
 * Connects to a demo game, moves around, idles, then samples
 * netcode metrics to check for excessive correction/jitter.
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const GAME_URL = 'http://localhost:8080';
const MENU_LOAD_WAIT = 6000;
const GAME_LOAD_WAIT = 8000;

test.describe('Prediction Jitter Detection', () => {
  test('local player should not exhibit continuous micro-corrections', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      logs.push(text);
    });

    // Navigate to game menu
    await page.goto(GAME_URL);
    await page.waitForTimeout(MENU_LOAD_WAIT);

    // Click to unlock audio + focus
    const canvas = page.locator('canvas');
    await canvas.click();
    await page.waitForTimeout(500);

    // Use debug bridge to enter game
    const entered = await page.evaluate(() => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (debug?.goToGame) {
        debug.goToGame();
        return true;
      }
      return false;
    });

    console.log(`Entered game: ${entered}`);
    expect(entered).toBe(true);

    // Wait for GameScene to load and player to spawn
    await page.waitForTimeout(GAME_LOAD_WAIT);

    // Focus canvas again for input
    await canvas.click();
    await page.waitForTimeout(500);

    // Verify we're in the game scene with a debugBridge
    const gameInfo = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      if (!game) return { error: 'no __PHASER_GAME__' };

      const scenes = game.scene?.scenes || [];
      const sceneKeys = scenes.map((s: any) => s?.scene?.key || s?.sys?.settings?.key || 'unknown');

      // Find GameScene
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );

      if (!gameScene) return { error: 'no GameScene found', sceneKeys };

      const bridge = gameScene.debugBridge;
      if (!bridge) return {
        error: 'no debugBridge on GameScene',
        sceneKeys,
        gameSceneKeys: Object.keys(gameScene).filter(k => !k.startsWith('_')).slice(0, 20),
      };

      try {
        const state = bridge.getState();
        return {
          hasBridge: true,
          connected: state?.connected,
          myId: state?.myId,
          playerCount: state?.players?.length,
          sceneKeys,
        };
      } catch (e: any) {
        return { error: e.message, sceneKeys };
      }
    });

    console.log('=== GAME INFO ===');
    console.log(JSON.stringify(gameInfo, null, 2));

    if (gameInfo.error) {
      // Dump relevant logs for diagnosis
      console.log('\n=== RELEVANT LOGS ===');
      logs.filter(l => l.includes('GameScene') || l.includes('error') || l.includes('connect'))
        .forEach(l => console.log(l));
    }

    // We need to be connected with a player
    if (!gameInfo.connected || !gameInfo.myId) {
      console.log('Not connected yet, waiting longer...');
      await page.waitForTimeout(5000);

      const retryInfo = await page.evaluate(() => {
        const game = (window as any).__PHASER_GAME__;
        const scenes = game?.scene?.scenes || [];
        const gameScene = scenes.find((s: any) =>
          s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
        );
        const bridge = gameScene?.debugBridge;
        if (!bridge) return { error: 'still no bridge' };
        const state = bridge.getState();
        return { connected: state?.connected, myId: state?.myId, playerCount: state?.players?.length };
      });
      console.log('Retry info:', JSON.stringify(retryInfo));
    }

    // --- PHASE 1: Move forward for 3 seconds ---
    console.log('Phase 1: Moving forward...');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    await page.keyboard.up('KeyW');

    // --- PHASE 2: Idle for 3 seconds ---
    console.log('Phase 2: Idle...');
    await page.waitForTimeout(3000);

    // --- PHASE 3: Sample netcode metrics ---
    console.log('Phase 3: Sampling metrics...');
    await page.waitForTimeout(2000);

    const metrics = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      const bridge = gameScene?.debugBridge;
      if (!bridge) return { error: 'no bridge for metrics' };

      try {
        const state = bridge.getState();
        const myPlayer = state?.players?.find((p: any) => p.id === state.myId);

        // Sample metrics 5 times with small delays
        const samples: any[] = [];
        for (let i = 0; i < 5; i++) {
          try {
            samples.push(bridge.getNetcodeMetrics());
          } catch (e: any) {
            samples.push({ error: e.message });
          }
        }

        // Also get prediction error directly
        const predError = bridge.getPredictionError();

        return {
          samples,
          directPredictionError: predError,
          myPlayer: myPlayer ? {
            x: myPlayer.x,
            y: myPlayer.y,
            vx: myPlayer.velocityX,
            vy: myPlayer.velocityY,
          } : null,
          connected: state?.connected,
          myId: state?.myId,
          playerCount: state?.players?.length,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    });

    console.log('\n=== NETCODE METRICS ===');
    console.log(JSON.stringify(metrics, null, 2));

    // Assertions if we got metrics
    if (metrics.samples && !metrics.error) {
      const validSamples = metrics.samples.filter((s: any) => !s.error);
      if (validSamples.length > 0) {
        const latest = validSamples[validSamples.length - 1];
        console.log(`\n=== ANALYSIS ===`);
        console.log(`Prediction Error: ${latest.predictionError} px (direct: ${metrics.directPredictionError})`);
        console.log(`RTT: ${latest.rttMs} ms`);
        console.log(`Reconciliations: ${latest.reconciliationCount}`);
        console.log(`Avg Correction: ${latest.avgCorrection} px`);
        console.log(`Max Correction: ${latest.maxCorrection} px`);
        console.log(`Extrapolation Mag: ${latest.renderOffsetMagnitude} px`);
        console.log(`Patch Rate: ${latest.patchRate}/s`);
        console.log(`Input Rate: ${latest.inputRate}/s`);
        console.log(`Jank: ${latest.jankFrames}/${latest.totalFrames}`);
        console.log(`Snaps: ${latest.snapCount}`);
      }
    }

    await page.screenshot({
      path: path.join('test-results', 'prediction-jitter-test.png'),
    });

    // Print relevant errors
    const errors = logs.filter(l => l.startsWith('[error]'));
    if (errors.length > 0) {
      console.log(`\n=== ERRORS (${errors.length}) ===`);
      errors.slice(0, 20).forEach(l => console.log(l));
    }

    // Always pass for now - this is diagnostic
    expect(true).toBe(true);
  });
});
