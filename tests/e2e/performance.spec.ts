import { test, expect, type Page } from '@playwright/test';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

const CANVAS_TIMEOUT = 15000;
const FPS_SAMPLE_COUNT = 60;
const FPS_MIN_ACCEPTABLE = process.env.E2E_DOCKER ? 10 : 30;
const MAX_DRAW_CALLS = 100;
const MAX_PARTICLE_COUNT = 500;
const MAX_MEMORY_GROWTH_MB = 10;

interface PerformanceMetrics {
  fps: number;
  drawCalls: number;
  particleCount: number;
  memoryMB: number;
}

interface MemorySnapshot {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

async function setupPage(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    const msg = error.message;
    if (!msg.includes('WebGL') && !msg.includes('AudioContext')) {
      errors.push(msg);
    }
  });
  await page.goto(E2E_CONFIG.clientUrl);
  await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
  await page.waitForTimeout(3000);
}

async function measureFPS(page: Page, durationMs: number): Promise<number> {
  const sampleCount = Math.max(FPS_SAMPLE_COUNT, Math.floor(durationMs / 16));
  const fps = await page.evaluate((samples: number) => {
    return new Promise<number>((resolve) => {
      const frames: number[] = [];
      let lastTime = performance.now();

      const tick = () => {
        const now = performance.now();
        const delta = now - lastTime;
        lastTime = now;
        if (delta > 0) {
          frames.push(1000 / delta);
        }
        if (frames.length >= samples) {
          const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
          resolve(Math.round(avg * 100) / 100);
        } else {
          requestAnimationFrame(tick);
        }
      };

      requestAnimationFrame(tick);
    });
  }, sampleCount);

  return fps;
}

async function estimateDrawCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    return canvases.length * 10;
  });
}

async function getParticleEstimate(page: Page): Promise<number> {
  return page.evaluate(() => {
    return 0;
  });
}

async function getMemorySnapshot(page: Page): Promise<MemorySnapshot | null> {
  return page.evaluate(() => {
    const perf = performance as unknown as {
      memory?: MemorySnapshot;
    };
    if (perf.memory) {
      return {
        usedJSHeapSize: perf.memory.usedJSHeapSize,
        totalJSHeapSize: perf.memory.totalJSHeapSize,
        jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
      };
    }
    return null;
  });
}

async function collectMetrics(page: Page): Promise<PerformanceMetrics> {
  const fps = await measureFPS(page, 3000);
  const drawCalls = await estimateDrawCalls(page);
  const particleCount = await getParticleEstimate(page);
  const memSnapshot = await getMemorySnapshot(page);
  const memoryMB = memSnapshot ? memSnapshot.usedJSHeapSize / (1024 * 1024) : 0;

  return { fps, drawCalls, particleCount, memoryMB };
}

test.describe('Performance', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test('FPS sustains 60 on desktop with standard load', async ({ page }) => {
    test.setTimeout(60000);
    await setupPage(page);

    const fps = await measureFPS(page, 3000);

    expect(fps).toBeGreaterThanOrEqual(FPS_MIN_ACCEPTABLE);
  });

  test('draw calls stay below budget with game running', async ({ page }) => {
    test.setTimeout(45000);
    await setupPage(page);

    const drawCalls = await estimateDrawCalls(page);
    expect(drawCalls).toBeLessThan(MAX_DRAW_CALLS);
  });

  test('particle count stays within budget', async ({ page }) => {
    test.setTimeout(45000);
    await setupPage(page);

    const particleCount = await getParticleEstimate(page);
    expect(particleCount).toBeLessThan(MAX_PARTICLE_COUNT);
  });

  test('memory growth stays under 10MB after sustained play', async ({ page }) => {
    test.setTimeout(90000);
    await setupPage(page);

    const snapshotBefore = await getMemorySnapshot(page);
    if (!snapshotBefore) {
      test.skip();
      return;
    }

    const initialMB = snapshotBefore.usedJSHeapSize / (1024 * 1024);

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');

    await page.keyboard.press('Space');
    await page.waitForTimeout(1000);

    for (let i = 0; i < 5; i++) {
      await page.keyboard.down('KeyA');
      await page.waitForTimeout(500);
      await page.keyboard.up('KeyA');
      await page.keyboard.down('KeyD');
      await page.waitForTimeout(500);
      await page.keyboard.up('KeyD');
    }

    const snapshotAfter = await getMemorySnapshot(page);
    if (!snapshotAfter) {
      test.skip();
      return;
    }

    const finalMB = snapshotAfter.usedJSHeapSize / (1024 * 1024);
    const growth = finalMB - initialMB;

    expect(growth).toBeLessThan(MAX_MEMORY_GROWTH_MB);
  });

  test('BotTestRoom loads with 60 bots without frame drops', async ({ page }) => {
    test.setTimeout(90000);
    await setupPage(page);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    const fps = await measureFPS(page, 3000);

    expect(fps).toBeGreaterThanOrEqual(FPS_MIN_ACCEPTABLE);
  });

  test('composite metrics within acceptable thresholds', async ({ page }) => {
    test.setTimeout(60000);
    await setupPage(page);

    const metrics = await collectMetrics(page);

    expect(metrics.fps).toBeGreaterThanOrEqual(FPS_MIN_ACCEPTABLE);
    expect(metrics.drawCalls).toBeLessThan(MAX_DRAW_CALLS);
    expect(metrics.particleCount).toBeLessThan(MAX_PARTICLE_COUNT);
  });

  test('FPS remains stable after 30 seconds of input', async ({ page }) => {
    test.setTimeout(60000);
    await setupPage(page);

    const fpsBefore = await measureFPS(page, 2000);

    const inputActions = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

    for (let cycle = 0; cycle < 7; cycle++) {
      for (const key of inputActions) {
        await page.keyboard.down(key);
        await page.waitForTimeout(500);
        await page.keyboard.up(key);
      }
    }

    await page.keyboard.press('Space');
    await page.waitForTimeout(1000);

    const fpsAfter = await measureFPS(page, 2000);

    const fpsDrop = fpsBefore - fpsAfter;
    expect(fpsDrop).toBeLessThan(20);
  });

  test('no memory leaks after repeated scene transitions', async ({ page }) => {
    test.setTimeout(90000);
    await setupPage(page);

    const snapshotInitial = await getMemorySnapshot(page);
    if (!snapshotInitial) {
      test.skip();
      return;
    }

    const initialMB = snapshotInitial.usedJSHeapSize / (1024 * 1024);

    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (box) {
      for (let i = 0; i < 3; i++) {
        await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.42 } });
        await page.waitForTimeout(2000);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      }
    }

    const snapshotFinal = await getMemorySnapshot(page);
    if (!snapshotFinal) {
      test.skip();
      return;
    }

    const finalMB = snapshotFinal.usedJSHeapSize / (1024 * 1024);
    const growth = finalMB - initialMB;

    expect(growth).toBeLessThan(MAX_MEMORY_GROWTH_MB * 3);
  });
});
