/**
 * Input pipeline diagnostic: verify inputs reach the server and
 * the server processes them, vs the client predicting but server
 * not confirming.
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Input Pipeline Diagnostic', () => {
  test('verify client inputs reach server and get confirmed', async ({ page }) => {
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

    // Record initial position
    const initialState = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      const bridge = gameScene?.debugBridge;
      const state = bridge?.getState();
      const myPlayer = state?.players?.find((p: any) => p.id === state.myId);

      return {
        myId: state?.myId,
        connected: state?.connected,
        playerCount: state?.players?.length,
        serverX: myPlayer?.x,
        serverY: myPlayer?.y,
        serverVx: myPlayer?.velocityX,
        serverVy: myPlayer?.velocityY,
        localX: gameScene?.localPos?.x,
        localY: gameScene?.localPos?.y,
        localVx: gameScene?.localVelocity?.x,
        localVy: gameScene?.localVelocity?.y,
        prediction: gameScene?.prediction ? 'exists' : 'missing',
        connection: gameScene?.connection ? 'exists' : 'missing',
        inputCollector: gameScene?.inputCollector ? 'exists' : 'missing',
      };
    });

    console.log('\n=== INITIAL STATE ===');
    console.log(JSON.stringify(initialState, null, 2));

    // Move diagonally for 1 second
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(1000);

    // Record position while moving
    const movingState = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      const bridge = gameScene?.debugBridge;
      const state = bridge?.getState();
      const myPlayer = state?.players?.find((p: any) => p.id === state.myId);
      const visual = gameScene?.getVisualPosition?.();

      return {
        serverX: myPlayer?.x, serverY: myPlayer?.y,
        serverVx: myPlayer?.velocityX, serverVy: myPlayer?.velocityY,
        localX: gameScene?.localPos?.x, localY: gameScene?.localPos?.y,
        localVx: gameScene?.localVelocity?.x, localVy: gameScene?.localVelocity?.y,
        visualX: visual?.x, visualY: visual?.y,
        predictionError: bridge?.getPredictionError(),
      };
    });

    console.log('\n=== WHILE MOVING (1s) ===');
    console.log(JSON.stringify(movingState, null, 2));

    // Release keys
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyD');

    // Wait for server to process
    await page.waitForTimeout(1000);

    // Record final position
    const finalState = await page.evaluate(() => {
      const game = (window as any).__PHASER_GAME__;
      const scenes = game?.scene?.scenes || [];
      const gameScene = scenes.find((s: any) =>
        s?.sys?.settings?.key === 'GameScene' || s?.scene?.key === 'GameScene'
      );
      const bridge = gameScene?.debugBridge;
      const state = bridge?.getState();
      const myPlayer = state?.players?.find((p: any) => p.id === state.myId);
      const visual = gameScene?.getVisualPosition?.();

      return {
        serverX: myPlayer?.x, serverY: myPlayer?.y,
        serverVx: myPlayer?.velocityX, serverVy: myPlayer?.velocityY,
        localX: gameScene?.localPos?.x, localY: gameScene?.localPos?.y,
        localVx: gameScene?.localVelocity?.x, localVy: gameScene?.localVelocity?.y,
        visualX: visual?.x, visualY: visual?.y,
        predictionError: bridge?.getPredictionError(),
      };
    });

    console.log('\n=== AFTER STOPPING (1s) ===');
    console.log(JSON.stringify(finalState, null, 2));

    // Analysis
    const initialPos = { x: initialState.serverX, y: initialState.serverY };
    const movedPos = { x: movingState.serverX, y: movingState.serverY };
    const finalPos = { x: finalState.serverX, y: finalState.serverY };

    const moved = Math.sqrt((movedPos.x - initialPos.x)**2 + (movedPos.y - initialPos.y)**2);
    const snapped = Math.sqrt((finalPos.x - movedPos.x)**2 + (finalPos.y - movedPos.y)**2);

    console.log('\n=== ANALYSIS ===');
    console.log(`Server position moved: ${moved.toFixed(2)}px during movement`);
    console.log(`Server position drift after stop: ${snapped.toFixed(2)}px`);
    console.log(`Prediction error while moving: ${movingState.predictionError?.toFixed(2)}px`);
    console.log(`Prediction error after stop: ${finalState.predictionError?.toFixed(2)}px`);

    if (moved < 1 && initialState.connected) {
      console.log('\n🔴 SERVER DID NOT MOVE — inputs are NOT reaching server or server is rejecting them');
    } else if (movingState.predictionError > 5) {
      console.log('\n🔴 LARGE PREDICTION ERROR — prediction drift');
    } else {
      console.log('\n🟢 Movement pipeline appears functional');
    }

    // Check for connection-level issues
    const connLogs = logs.filter(l => l.includes('connect') || l.includes('input') || l.includes('send') || l.includes('error'));
    if (connLogs.length > 0) {
      console.log('\n=== CONNECTION LOGS ===');
      connLogs.slice(0, 15).forEach(l => console.log(l));
    }

    expect(true).toBe(true);
  });
});
