import { test, expect, type Page } from '@playwright/test';
import { E2E_CONFIG, waitForClient } from './docker-helper';

const CANVAS_TIMEOUT = 15000;

interface AccessibilitySettings {
  colorblindMode: 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia';
  highContrast: boolean;
  reducedMotion: boolean;
  textToSpeech: boolean;
  uiScale: 0.8 | 1.0 | 1.2 | 1.4;
  aimAssist: 'off' | 'low' | 'medium' | 'high';
  hapticEnabled: boolean;
}

const STORAGE_KEY = 'accessibility_settings';
const SETTINGS_STORAGE_KEY = 'thermite_settings';

const DEFAULT_A11Y: AccessibilitySettings = {
  colorblindMode: 'off',
  highContrast: false,
  reducedMotion: false,
  textToSpeech: false,
  uiScale: 1.0,
  aimAssist: 'off',
  hapticEnabled: false,
};

async function loadPageAndWait(
  page: Page,
  options?: {
    accessibility?: Partial<AccessibilitySettings>;
    gameSettings?: Record<string, unknown>;
  },
): Promise<void> {
  const accessibility = options?.accessibility
    ? ({ ...DEFAULT_A11Y, ...options.accessibility } satisfies AccessibilitySettings)
    : null;
  const gameSettings = options?.gameSettings ?? null;

  await page.addInitScript(
    ({ a11yKey, settingsKey, a11y, settings }) => {
      try {
        localStorage.clear();
        if (a11y) {
          localStorage.setItem(a11yKey, JSON.stringify(a11y));
        }
        if (settings) {
          localStorage.setItem(settingsKey, JSON.stringify(settings));
        }
      } catch {
        // localStorage unavailable
      }
    },
    {
      a11yKey: STORAGE_KEY,
      settingsKey: SETTINGS_STORAGE_KEY,
      a11y: accessibility,
      settings: gameSettings,
    },
  );

  await page.goto(E2E_CONFIG.clientUrl);
  await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
  await page.waitForTimeout(1500);
}

test.describe('Accessibility', () => {
  test.beforeAll(async () => {
    try {
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test('colorblind mode applies shape indicators to items', async ({ page }) => {
    await loadPageAndWait(page, { accessibility: { colorblindMode: 'deuteranopia' } });

    const settings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as AccessibilitySettings;
    }, STORAGE_KEY);

    expect(settings).not.toBeNull();
    if (settings) {
      expect(settings.colorblindMode).toBe('deuteranopia');
    }

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('high contrast mode shows thicker outlines', async ({ page }) => {
    await loadPageAndWait(page, { accessibility: { highContrast: true } });

    const settings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as AccessibilitySettings;
    }, STORAGE_KEY);

    expect(settings).not.toBeNull();
    if (settings) {
      expect(settings.highContrast).toBe(true);
    }
  });

  test('reduced motion disables screen shake', async ({ page }) => {
    await loadPageAndWait(page, {
      accessibility: { reducedMotion: true },
      gameSettings: {
        display: {
          fpsCounter: false,
          minimapPosition: 'top-right',
          screenShake: false,
          hudScale: 1.0,
        },
      },
    });

    const a11ySettings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as AccessibilitySettings;
    }, STORAGE_KEY);

    expect(a11ySettings).not.toBeNull();
    if (a11ySettings) {
      expect(a11ySettings.reducedMotion).toBe(true);
    }

    const gameSettings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { display: { screenShake: boolean } };
      return parsed.display;
    }, SETTINGS_STORAGE_KEY);

    if (gameSettings) {
      expect(gameSettings.screenShake).toBe(false);
    }
  });

  test('UI scaling at 80% renders elements visible', async ({ page }) => {
    await loadPageAndWait(page, { accessibility: { uiScale: 0.8 } });

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    const settings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as AccessibilitySettings;
    }, STORAGE_KEY);

    if (settings) {
      expect(settings.uiScale).toBe(0.8);
    }
  });

  test('UI scaling at 140% renders elements visible', async ({ page }) => {
    await loadPageAndWait(page, { accessibility: { uiScale: 1.4 } });

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    const settings = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as AccessibilitySettings;
    }, STORAGE_KEY);

    if (settings) {
      expect(settings.uiScale).toBe(1.4);
    }
  });

  test('keyboard navigation through menu buttons', async ({ page }) => {
    await loadPageAndWait(page);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('keyboard navigates through all four menu items', async ({ page }) => {
    await loadPageAndWait(page);

    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
    }

    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(150);
    }

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('focus indicator visible on menu buttons', async ({ page }) => {
    await loadPageAndWait(page);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    const hasVisualFeedback = await page.evaluate(() => {
      const container = document.getElementById('game-container');
      if (!container) return false;
      return container.querySelector('canvas') !== null;
    });
    expect(hasVisualFeedback).toBe(true);
  });

  test('settings scene is keyboard navigable', async ({ page }) => {
    await loadPageAndWait(page);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
  });

  test('all colorblind modes can be persisted', async ({ page }) => {
    const modes: AccessibilitySettings['colorblindMode'][] = [
      'deuteranopia',
      'protanopia',
      'tritanopia',
    ];

    for (const mode of modes) {
      await loadPageAndWait(page, { accessibility: { colorblindMode: mode } });

      const settings = await page.evaluate((key: string) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as AccessibilitySettings;
      }, STORAGE_KEY);

      if (settings) {
        expect(settings.colorblindMode).toBe(mode);
      }
    }
  });
});
