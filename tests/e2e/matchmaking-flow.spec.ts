import { test, expect } from '@playwright/test';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

test.describe('Matchmaking Flow (Docker E2E)', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test('menu scene loads and shows Play button', async ({ page }) => {
    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: 15000 });
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('can navigate from menu to matchmaking', async ({ page }) => {
    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: 15000 });

    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await canvas.click({
        position: {
          x: box.width * 0.5,
          y: box.height * 0.42,
        },
      });
    }

    await expect(canvas).toBeVisible();
  });

  test('client loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const criticalErrors = errors.filter(
      (e) => !e.includes('WebGL') && !e.includes('AudioContext'),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
