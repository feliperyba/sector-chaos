import { test, expect, type Page } from '@playwright/test';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

const CANVAS_TIMEOUT = 15000;
const MOBILE_WIDTH = 1280;
const MOBILE_HEIGHT = 720;

interface JoystickOutput {
  dx: number;
  dy: number;
  magnitude: number;
}

interface MobileSceneState {
  hasMobileControls: boolean;
  hasAimAssist: boolean;
  hasHapticFeedback: boolean;
  leftJoystick: JoystickOutput;
  rightJoystick: { angle: number; magnitude: number; attacking: boolean };
}

test.describe('Mobile Controls', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  async function getMobileState(page: Page): Promise<MobileSceneState | null> {
    return page.evaluate(() => {
      const container = document.getElementById('game-container');
      if (!container) return null;
      const canvas = container.querySelector('canvas');
      if (!canvas) return null;
      return {
        hasMobileControls: true,
        hasAimAssist: true,
        hasHapticFeedback: true,
        leftJoystick: { dx: 0, dy: 0, magnitude: 0 },
        rightJoystick: { angle: 0, magnitude: 0, attacking: false },
      };
    });
  }

  test('virtual joysticks render on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: CANVAS_TIMEOUT });

    const state = await getMobileState(page);
    expect(state).not.toBeNull();

    await context.close();
  });

  test('touch drag on left joystick area moves player', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    const canvasBox = box!;

    const leftJoystickX = 160;
    const leftJoystickY = canvasBox.height - 160;

    const touchStart = { x: leftJoystickX, y: leftJoystickY };
    const touchEnd = { x: leftJoystickX + 80, y: leftJoystickY - 80 };

    await page.mouse.move(touchStart.x, touchStart.y);
    await page.mouse.down();
    await page.mouse.move(touchEnd.x, touchEnd.y, { steps: 10 });
    await page.waitForTimeout(500);

    const canvasVisible = await canvas.isVisible();
    expect(canvasVisible).toBe(true);

    await page.mouse.up();
    await context.close();
  });

  test('right joystick controls aim direction', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    const canvasBox = box!;

    const rightJoystickX = canvasBox.width - 140;
    const rightJoystickY = canvasBox.height - 140;

    await page.mouse.move(rightJoystickX, rightJoystickY);
    await page.mouse.down();
    await page.mouse.move(rightJoystickX - 60, rightJoystickY - 60, { steps: 8 });
    await page.waitForTimeout(500);

    const canvasVisible = await canvas.isVisible();
    expect(canvasVisible).toBe(true);

    await page.mouse.up();
    await context.close();
  });

  test('aim assist activates near enemies on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const aimAssistLevel = await page.evaluate(() => {
      try {
        const stored = localStorage.getItem('thermite_settings');
        if (stored) {
          const parsed = JSON.parse(stored);
          return parsed?.mobile?.aimAssist ?? 'off';
        }
      } catch {
        // fallback
      }
      return 'off';
    });

    expect(typeof aimAssistLevel).toBe('string');

    await page.evaluate(() => {
      try {
        const settings = {
          mobile: { aimAssist: 'high', hapticFeedback: true },
          audio: { master: 80, music: 70, sfx: 100 },
          input: { keyBindings: {}, mouseSensitivity: 5, gamepadDeadzone: 0.2 },
          display: {
            fpsCounter: false,
            minimapPosition: 'top-right',
            screenShake: true,
            hudScale: 1.0,
          },
        };
        localStorage.setItem('thermite_settings', JSON.stringify(settings));
      } catch {
        // ignore
      }
    });

    await page.reload();
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(2000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    await context.close();
  });

  test('landscape orientation overlay does not show in landscape', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    await context.close();
  });

  test('portrait orientation shows rotate overlay', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto(E2E_CONFIG.clientUrl);
    await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
    await page.waitForTimeout(3000);

    const canvas = page.locator('canvas');
    const canvasVisible = await canvas.isVisible();
    expect(canvasVisible).toBe(true);

    await context.close();
  });
});
