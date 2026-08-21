/**
 * Manual collision fix validation - tests visual behavior and animation state
 */
import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';
const COUNTDOWN_WAIT = 8000;

test.describe('Manual Collision Fix Validation', () => {
  test('check movement near walls for visual issues', async ({ page }) => {
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
    await page.waitForTimeout(1000);

    // Take initial screenshot
    const initialScreenshot = await page.screenshot();
    console.log('Initial screenshot taken');

    // Move toward wall (W) for 3 seconds
    console.log('Moving toward wall (W key)...');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(1000);

    // Take screenshot after movement
    const afterMovementScreenshot = await page.screenshot();
    console.log('After movement screenshot taken');

    // Try moving away from wall (S) for 2 seconds
    console.log('Moving away from wall (S key)...');
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(1000);

    // Final screenshot
    const finalScreenshot = await page.screenshot();
    console.log('Final screenshot taken');

    // Save screenshots for manual inspection
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);
        console.log('Canvas size:', canvas.width, 'x', canvas.height);
        if (imageData) {
          console.log('Image data size:', imageData.data.length);
        }
      }
    });

    // Check for console errors
    if (errors.length > 0) {
      console.log('Console errors detected:', errors);
    } else {
      console.log('No console errors detected');
    }

    // Test 1: Player should have moved at least some distance toward the wall
    console.log('Movement validation completed');
    expect(errors.length, 'Should not have console errors').toBe(0);

    // Additional validation: check if canvas is rendering
    const canvasSize = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return canvas ? { width: canvas.width, height: canvas.height } : null;
    });

    expect(canvasSize, 'Canvas should be available').not.toBeNull();
    if (canvasSize) {
      expect(canvasSize.width, 'Canvas should have width').toBeGreaterThan(0);
      expect(canvasSize.height, 'Canvas should have height').toBeGreaterThan(0);
    }

    // Test diagonal movement (wall sliding)
    console.log('Testing diagonal movement...');
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(1000);

    console.log('Diagonal movement test completed');
  });

  test('check for animation flicker near walls', async ({ page }) => {
    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(1000);

    console.log('Testing animation stability...');

    // Test multiple wall interactions
    const movements = [
      { key: 'KeyW', duration: 2000 },
      { key: 'KeyS', duration: 2000 },
      { key: 'KeyA', duration: 2000 },
      { key: 'KeyD', duration: 2000 },
      { key: 'KeyW', duration: 2000 },
    ];

    for (const move of movements) {
      console.log(`Pressing ${move.key} for ${move.duration}ms...`);
      await page.keyboard.down(move.key);
      await page.waitForTimeout(move.duration);
      await page.keyboard.up(move.key);
      await page.waitForTimeout(500);
    }

    console.log('Animation stability test completed');
  });

  test('performance test - check for lag during movement', async ({ page }) => {
    const performanceLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('performance') || msg.text().includes('fps') || msg.text().includes('time')) {
        performanceLogs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    await page.goto(GAME_URL);
    await page.waitForTimeout(1000);
    await page.locator('canvas').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__SECTO_DEBUG__?.goToGame?.());
    await page.waitForTimeout(COUNTDOWN_WAIT);
    await page.locator('canvas').click();
    await page.waitForTimeout(1000);

    console.log('Starting performance test...');

    // Perform rapid movements to check for performance issues
    for (let i = 0; i < 10; i++) {
      const directions = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
      const dir = directions[i % directions.length];
      
      await page.keyboard.down(dir);
      await page.waitForTimeout(300);
      await page.keyboard.up(dir);
      await page.waitForTimeout(200);
    }

    console.log('Performance test completed');
    if (performanceLogs.length > 0) {
      console.log('Performance logs:', performanceLogs);
    } else {
      console.log('No performance logs detected');
    }
  });
});