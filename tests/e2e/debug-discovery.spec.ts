/**
 * Debug Bridge Discovery: Check what debug tools are available
 * and how to properly access them (handling circular references).
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Debug Bridge Discovery', () => {
  test('discover available debug objects and their structure', async ({ page }) => {
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

    // Discover all debug objects
    const debugInfo = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      
      return {
        gameExists: !!game,
        scenesCount: scenes.length,
        sceneKeys: scenes.map((s: any) => s?.scene?.key || s?.sys?.settings?.key),
      };
    });

    console.log('\n=== SCENE INFO ===');
    console.log(JSON.stringify(debugInfo, null, 2));

    // Find debugBridge in each scene without circular reference issues
    const scenes = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      return game?.scene?.scenes || [];
    });

    let debugBridgeFound = false;
    let runtimeFound = false;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneKey = scene?.scene?.key || scene?.sys?.settings?.key;
      
      if (scene?.debugBridge) {
        console.log(`\n=== DEBUG BRIDGE FOUND IN ${sceneKey} ===`);
        debugBridgeFound = true;
        
        // Check available methods safely
        const methods = [];
        for (const key in scene.debugBridge) {
          if (typeof scene.debugBridge[key] === 'function') {
            methods.push(key);
          }
        }
        console.log('Methods:', methods.slice(0, 20)); // Limit output
        
        // Try getState if available
        try {
          const state = scene.debugBridge.getState();
          console.log('State snapshot:', JSON.stringify({
            myId: state.myId,
            tick: state.tick,
            gameActive: state.gameActive,
            connected: state.connected,
          }, null, 2));
        } catch (e) {
          console.log('getState failed:', e);
        }
      }

      if (scene?.runtime) {
        console.log(`\n=== RUNTIME FOUND IN ${sceneKey} ===`);
        runtimeFound = true;
        
        // Check available methods safely
        const methods = [];
        for (const key in scene.runtime) {
          if (typeof scene.runtime[key] === 'function') {
            methods.push(key);
          }
        }
        console.log('Methods:', methods.slice(0, 20)); // Limit output
      }
    }

    if (!debugBridgeFound && !runtimeFound) {
      console.log('\n=== NO DEBUG OBJECTS FOUND ===');
      console.log('Scenes available:', scenes.map((s: any) => s?.scene?.key || s?.sys?.settings?.key));
      return;
    }

    // Try to use debugBridge if found
    if (debugBridgeFound) {
      console.log('\n=== TESTING DEBUG BRIDGE ===');
      try {
        await page.evaluate(() => {
          const scenes = (window as any).__PHASER_GAME__.scene.scenes;
          const gameScene = scenes.find((s: any) => 
            s?.scene?.key === 'GameScene' || s?.sys?.settings?.key === 'GameScene'
          );
          
          if (gameScene?.debugBridge) {
            const bridge = gameScene.debugBridge;
            console.log('Testing getState...');
            const state = bridge.getState();
            console.log('Initial position:', state.localPos);
            
            console.log('Testing runtime.move (replaces rawInput)...');
            bridge.runtime.move(1, 0, 0);
            
            console.log('Testing runtime.move...');
            bridge.runtime.move(1, 1, Math.PI / 4);
            
            return { success: true, myId: state.myId };
          }
          return { success: false };
        });
        
        await page.waitForTimeout(1000);
        
        // Check if position changed
        const result = await page.evaluate(() => {
          const scenes = (window as any).__PHASER_GAME__.scene.scenes;
          const gameScene = scenes.find((s: any) => 
            s?.scene?.key === 'GameScene' || s?.sys?.settings?.key === 'GameScene'
          );
          
          if (gameScene?.debugBridge) {
            const state = gameScene.debugBridge.getState();
            return { 
              localPos: state.localPos,
              players: state.players,
              gameActive: state.gameActive
            };
          }
          return null;
        });
        
        console.log('After inputs:', JSON.stringify(result, null, 2));
        
      } catch (e) {
        console.log('Debug bridge test failed:', e);
      }
    }

    // Alternative: Try to inject input directly through connection
    if (debugBridgeFound) {
      console.log('\n=== TESTING DIRECT INPUT INJECTION ===');
      try {
        await page.evaluate(() => {
          const scenes = (window as any).__PHASER_GAME__.scene.scenes;
          const gameScene = scenes.find((s: any) => 
            s?.scene?.key === 'GameScene' || s?.sys?.settings?.key === 'GameScene'
          );
          
          if (gameScene?.debugBridge?.connection) {
            const connection = gameScene.debugBridge.connection;
            console.log('Testing connection.sendInput...');
            connection.sendInput({
              movementX: 1,
              movementY: 0,
              aimAngle: 0,
              sequence: 400,
              actions: ['W']
            });
          }
        });
        
        await page.waitForTimeout(1000);
        console.log('Direct input sent');
        
      } catch (e) {
        console.log('Direct input test failed:', e);
      }
    }

    expect(debugBridgeFound || runtimeFound).toBe(true);
  });
});
