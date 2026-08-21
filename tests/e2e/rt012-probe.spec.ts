import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

const CANVAS_TIMEOUT = 15000;

async function clickCanvas(page: Page, xRatio: number, yRatio: number): Promise<void> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not visible');
  await canvas.click({ position: { x: box.width * xRatio, y: box.height * yRatio } });
}

test.describe('Probe', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test('probe window objects and lobby flow', async ({ browser }) => {
    test.setTimeout(60000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });

    // Click Play
    await clickCanvas(page, 0.5, 0.42);
    await page.waitForTimeout(3000);

    // Inspect window
    const info = await page.evaluate(() => {
      const keys = Object.getOwnPropertyNames(window).filter(
        (k) =>
          k.startsWith('__') ||
          k.toLowerCase().includes('phaser') ||
          k.toLowerCase().includes('colyseus') ||
          k.toLowerCase().includes('room') ||
          k.toLowerCase().includes('game'),
      );
      const canvas = document.querySelector('canvas');
      const gameContainer = document.getElementById('game-container');
      return {
        specialKeys: keys,
        canvasParentChildren: gameContainer?.children.length,
        canvasAttrs: canvas
          ? Object.keys(canvas).filter((k) => k.startsWith('_') || k.includes('game'))
          : [],
        hasPhaser: typeof (window as any).Phaser !== 'undefined',
      };
    });
    console.log('[PROBE] Window info:', JSON.stringify(info, null, 2));

    // Try importing colyseus module
    const colyseusResult = await page.evaluate(async () => {
      try {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const srcs = scripts.map((s) => s.getAttribute('src'));
        return { scriptSrcs: srcs };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log('[PROBE] Scripts:', JSON.stringify(colyseusResult));

    // Try to access Phaser via internal references
    const phaserCheck = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      // Phaser stores the game in the scene plugin's manager
      // Try to access through the game loop
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');

      return {
        hasWebGL: !!gl,
        renderer: ext ? 'WebGL' : 'none',
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        style: canvas.style.cssText,
      };
    });
    console.log('[PROBE] Canvas:', JSON.stringify(phaserCheck));

    await ctx.close();
  });
});
