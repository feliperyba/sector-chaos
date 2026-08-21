/**
 * Debug API diagnostic - check scene objects and state access
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';
const COUNTDOWN_WAIT = 8000;

test.describe('Scene Object Diagnostic', () => {
  test('check scene objects and state access', async ({ page }) => {
    const debugInfo: string[] = [];

    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(1000);

    // Try to access scene objects
    const result = await page.evaluate(async () => {
      const debug = (window as any).__SECTO_DEBUG__;
      if (!debug) {
        return { error: 'No __SECTO_DEBUG__ object found' };
      }

      const result: Record<string, unknown> = {};

      // Check scene object
      if (debug.scene) {
        const scene = debug.scene;
        result.sceneKeys = Object.keys(scene);
        
        // Look for game objects in scene
        const lookFor = ['game', 'player', 'connection', 'stateSync', 'debugBridge'];
        for (const key of lookFor) {
          result[key] = scene[key] !== undefined ? 'exists' : 'missing';
        }

        // Try to access the game object
        if (scene.game) {
          result.gameType = typeof scene.game;
          result.gameKeys = Object.keys(scene.game).slice(0, 10);
        }

        // Try to access the scene's events or state
        if (scene.events) {
          result.eventKeys = Object.keys(scene.events);
        }

        // Look for debug bridge in scene
        if (scene.debugBridge) {
          const db = scene.debugBridge;
          result.dbMethods = Object.keys(db);
          
          // Try debug bridge methods
          if (db.getState) {
            result.dbState = db.getState();
          }
          if (db.getPredictionError) {
            result.dbPredictionError = db.getPredictionError();
          }
        }
      }

      // Look for global objects
      result.globalKeys = [];
      if (window.game) {
        result.globalKeys.push('game');
        result.gameType = typeof window.game;
      }
      if (window.player) {
        result.globalKeys.push('player');
      }
      if (window.connection) {
        result.globalKeys.push('connection');
      }
      if (window.stateSync) {
        result.globalKeys.push('stateSync');
      }

      return result;
    });

    console.log('=== Scene Object Diagnostic Results ===');
    console.log(JSON.stringify(result, null, 2));

    // Log this info for debugging
    await page.evaluate((data) => {
      console.log('=== Client-side info ===');
      console.log('Scene keys:', data.sceneKeys);
      console.log('Game exists:', data.game !== 'missing');
      console.log('StateSync exists:', data.stateSync !== 'missing');
      console.log('DebugBridge exists:', data.debugBridge !== 'missing');
      if (data.dbState) {
        console.log('Debug state keys:', Object.keys(data.dbState));
      }
    }, { result });
  });

  test('direct console logging', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      logs.push(`[${msg.type()}] ${msg.text()}`);
      console.log(`[${msg.type()}] ${msg.text()}`);
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(1000);

    // Try to log debug bridge info
    await page.evaluate(() => {
      const debug = (window as any).__SECTO_DEBUG__;
      console.log('=== Debug bridge info ===');
      console.log('Debug exists:', !!debug);
      if (debug) {
        console.log('Debug methods:', Object.keys(debug));
      }
      
      const scene = (window as any).__SECTO_DEBUG__?.scene;
      console.log('=== Scene info ===');
      console.log('Scene exists:', !!scene);
      if (scene) {
        console.log('Scene methods:', Object.keys(scene).slice(0, 10));
      }
      
      const game = scene?.game;
      console.log('=== Game info ===');
      console.log('Game exists:', !!game);
      if (game) {
        console.log('Game methods:', Object.keys(game).slice(0, 10));
      }
      
      const stateSync = scene?.game?.stateSync;
      console.log('=== StateSync info ===');
      console.log('StateSync exists:', !!stateSync);
      if (stateSync) {
        console.log('StateSync methods:', Object.keys(stateSync).slice(0, 10));
      }
    });

    await page.waitForTimeout(3000);
    
    console.log('=== Console logs ===');
    console.log(logs.join('\n'));
  });
});