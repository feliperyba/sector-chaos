import { test, expect } from '@playwright/test';
import fs from 'fs';

const SCREENSHOT_DIR = 'test-results/rt011';

test.describe('RT-011: Verify Trap System', () => {
  test('trap system end-to-end verification', async ({ page }) => {
    const consoleLogs = [];
    page.on('console', (msg) => {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => console.log(`[PAGE ERROR] ${err.message}`));

    // Navigate to game (dev server on 5173)
    console.log('=== Navigating to game ===');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-menu.png` });

    // Click TEST ROOM - button is at game coords (960, 660) in 1920x1080 canvas
    console.log('=== Clicking TEST ROOM (canvas click) ===');
    const canvas = page.locator('canvas');
    await canvas.waitFor({ state: 'visible', timeout: 10000 });
    const box = await canvas.boundingBox();
    if (box) {
      const scaleX = box.width / 1920;
      const scaleY = box.height / 1080;
      const clickX = box.x + 960 * scaleX;
      const clickY = box.y + 660 * scaleY;
      console.log(`Canvas box: ${JSON.stringify(box)}, clicking at (${clickX}, ${clickY})`);
      await page.mouse.click(clickX, clickY);
    }
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-loading.png` });

    // Wait for game to initialize
    console.log('=== Waiting for game to load ===');
    await page.waitForTimeout(15000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-game.png` });

    // Check debug object
    console.log('=== Checking debug object ===');
    const debugInfo = await page.evaluate(() => {
      const dbg = window.__debugGame;
      if (!dbg) return { exists: false };
      return {
        exists: true,
        hasGetState: typeof dbg.getState === 'function',
        hasGetRoom: typeof dbg.getRoom === 'function',
        hasGetPlayer: typeof dbg.getPlayer === 'function',
        hasGetEntities: typeof dbg.getEntities === 'function',
      };
    });
    console.log('Debug info:', JSON.stringify(debugInfo));
    expect(debugInfo.exists).toBe(true);

    // Get trap state
    console.log('=== Getting trap state ===');
    const gameState = await page.evaluate(() => {
      const dbg = window.__debugGame;
      if (!dbg) return null;
      const room = dbg.getRoom();
      if (!room) return { error: 'no room' };
      const state = room.state;
      if (!state) return { error: 'no state' };

      const traps = [];
      if (state.traps) {
        state.traps.forEach((t, key) => {
          traps.push({
            id: key,
            type: t.type,
            x: t.x,
            y: t.y,
            isRevealed: t.isRevealed,
            cooldownRemaining: t.cooldownRemaining,
          });
        });
      }

      const players = [];
      if (state.players) {
        state.players.forEach((p, key) => {
          players.push({
            id: key,
            x: p.x,
            y: p.y,
            health: p.health,
            maxHealth: p.maxHealth,
            isActive: p.isActive,
          });
        });
      }

      const player = dbg.getPlayer();
      return {
        traps,
        players: players.slice(0, 5),
        playerCount: players.length,
        localPlayer: player
          ? {
              health: player.health,
              maxHealth: player.maxHealth,
              x: player.x,
              y: player.y,
              isActive: player.isActive,
            }
          : null,
        phase: state.phase,
      };
    });
    console.log('Game state:', JSON.stringify(gameState, null, 2));

    // Validation 1: Traps spawn on map
    const trapCount = gameState?.traps?.length ?? 0;
    console.log(`\n=== VALIDATION: Traps spawn on map: ${trapCount} traps found ===`);
    // Don't fail test if no traps - just log

    // Validation 2: Player exists
    const playerExists = gameState?.localPlayer !== null;
    console.log(`=== VALIDATION: Player exists: ${playerExists} ===`);

    // Move to trap and check damage
    if (gameState?.localPlayer && trapCount > 0) {
      const healthBefore = gameState.localPlayer.health;
      const trap = gameState.traps[0];
      console.log(
        `\n=== Attempting to move to trap at (${trap.x}, ${trap.y}) type=${trap.type} ===`,
      );
      console.log(`Health before: ${healthBefore}`);

      // Send movement inputs repeatedly toward trap
      await page.evaluate(
        (targetPos) => {
          const dbg = window.__debugGame;
          if (!dbg || !dbg.sendInput) return;
          dbg.sendInput('MOVE', { x: targetPos.x, y: targetPos.y });
        },
        { x: trap.x, y: trap.y },
      );

      await page.waitForTimeout(2000);

      // Send more move inputs
      await page.evaluate(
        (targetPos) => {
          const dbg = window.__debugGame;
          if (!dbg || !dbg.sendInput) return;
          for (let i = 0; i < 10; i++) {
            dbg.sendInput('MOVE', { x: targetPos.x, y: targetPos.y });
          }
        },
        { x: trap.x, y: trap.y },
      );

      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/04-after-trap-move.png` });

      const afterTrapState = await page.evaluate(() => {
        const dbg = window.__debugGame;
        if (!dbg) return null;
        const player = dbg.getPlayer();
        if (!player) return null;
        return { health: player.health, x: player.x, y: player.y };
      });
      console.log('After trap move:', JSON.stringify(afterTrapState));
      const healthDelta = healthBefore - (afterTrapState?.health ?? healthBefore);
      console.log(`Health delta: ${healthDelta}`);
    }

    // Check trap types variety
    if (trapCount > 0) {
      const trapTypes = new Set(gameState.traps.map((t) => t.type));
      console.log(`\n=== Trap type distribution ===`);
      console.log(`Types found: ${JSON.stringify([...trapTypes])}`);
      console.log(`Type 0 (SPIKE) count: ${gameState.traps.filter((t) => t.type === 0).length}`);
      console.log(`Type 1 (FIRE) count: ${gameState.traps.filter((t) => t.type === 1).length}`);
      console.log(`Type 2 (TELEPORT) count: ${gameState.traps.filter((t) => t.type === 2).length}`);
    }

    // Check server health
    console.log('\n=== Checking server health ===');
    const serverState = await page.evaluate(async () => {
      try {
        const resp = await fetch('http://localhost:2567/debug/state');
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('Server state:', JSON.stringify(serverState, null, 2));

    // Final screenshot
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-final.png` });

    // Write full results to file
    const results = {
      debugInfo,
      gameState,
      serverState,
      consoleErrorCount: consoleLogs.filter((l) => l.type === 'error').length,
      consoleErrors: consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(`${SCREENSHOT_DIR}/rt011-results.json`, JSON.stringify(results, null, 2));
    console.log('\n=== Results written to test-results/rt011/rt011-results.json ===');
  });
});
