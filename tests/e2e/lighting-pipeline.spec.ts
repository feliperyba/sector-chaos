/**
 * Seam B — headless Playwright harness for the deferred lighting pipeline.
 *
 * Ports the validated 06-prototype diagnostic harness
 * (`docs/wayfinder/prototypes/06-aaa-lighting/diag.js`) against the REAL
 * running client. Probes RT glTextures + shader existence + screenshot — does
 * NOT use `readPixels` / `game.renderer.snapshot` (Phaser-4.1 gotcha #4: they
 * stall the GPU + can trip CONTEXT_LOST_WEBGL in headless SwiftShader).
 *
 * What this catches:
 *   - A pipeline shader starved by `setVisible(false)` (its glTexture is null).
 *   - A missing RT key (registry mis-registration).
 *   - The Final filter not registered / not wired to the camera.
 *   - A flat output (the canvas still must produce a non-empty PNG).
 *
 * The harness drives a demo match via the MainMenu's debug `goToGame` hook
 * (DEV mode only — run against the dev server). The diagnostic probe prefers
 * the always-on `__LIGHTING_DIAG__` window hook (works in production builds
 * too); falls back to the Phaser scene (dev).
 *
 * Run via the project's Playwright tooling (dev server is auto-started):
 *   pnpm exec playwright test tests/e2e/lighting-pipeline.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const MAP_LOAD_TIMEOUT = 25000;
const SCENE_SETTLE_MS = 4000;

interface DiagnosticSnapshot {
  shaders: Record<string, { exists: boolean; glTextureNonNull: boolean }>;
  rts: Record<string, boolean>;
  filterRegistered: boolean;
  finalControllerPresent: boolean;
}

interface ProbeResult {
  error?: string;
  snapshot?: DiagnosticSnapshot;
}

/** Navigate to the client (Playwright baseURL adapts to dev/docker) + wait for boot. */
async function bootClient(page: Page): Promise<void> {
  await page.goto('/');
  // Wait for the Phaser game to boot AND MainMenu to expose its debug hook.
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __SECTO_DEBUG__?: { goToGame?: unknown } }).__SECTO_DEBUG__;
      return typeof d?.goToGame === 'function';
    },
    { timeout: 25000 },
  );
}

/** Boot a demo match via MainMenu's debug hook + wait for the lighting pipeline to boot. */
async function bootMatchAndWaitForMap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as unknown as { __SECTO_DEBUG__?: { goToGame: () => void } })
      .__SECTO_DEBUG__;
    if (!debug || typeof debug.goToGame !== 'function') {
      throw new Error('MainMenu debug hook not exposed — run against the dev server (DEV mode)');
    }
    debug.goToGame();
  });
  // The GameScene exposes __LIGHTING_DIAG__ once the map loads + the pipeline
  // boots — that's the direct signal we want (more reliable than polling the
  // GameScene debug bridge's getState, which has a different shape).
  await page.waitForFunction(
    () => {
      const diag = (window as unknown as { __LIGHTING_DIAG__?: () => unknown }).__LIGHTING_DIAG__;
      return typeof diag === 'function';
    },
    { timeout: MAP_LOAD_TIMEOUT },
  );
  await page.waitForTimeout(SCENE_SETTLE_MS);
}

test.describe('Lighting pipeline — Seam B (headless RT-existence + screenshot)', () => {
  test('each pipeline shader has a non-null glTexture + each RT key is registered', async ({
    page,
  }) => {
    await bootClient(page);
    await bootMatchAndWaitForMap(page);

    const probe = await page.evaluate((): ProbeResult => {
      const diag = (window as unknown as { __LIGHTING_DIAG__?: () => DiagnosticSnapshot | null })
        .__LIGHTING_DIAG__;
      if (diag) {
        const snapshot = diag();
        if (snapshot) return { snapshot };
        return { error: '__LIGHTING_DIAG__ returned null (pipeline not booted?)' };
      }
      const game = (window as unknown as { __PHASER_GAME__?: Phaser.Game }).__PHASER_GAME__;
      if (!game) return { error: 'no __PHASER_GAME__' };
      const scene = game.scene.getScene('GameScene') as unknown as {
        lighting?: { getDiagnosticSnapshot(): DiagnosticSnapshot };
      };
      if (!scene) return { error: 'no GameScene' };
      if (!scene.lighting) return { error: 'no lighting pipeline (map not loaded?)' };
      return { snapshot: scene.lighting.getDiagnosticSnapshot() };
    });

    expect(probe.error, `Pipeline probe failed: ${probe.error ?? 'ok'}`).toBeUndefined();
    const snapshot = probe.snapshot!;

    // Each pipeline shader must exist with a non-null glTexture.
    // (The setVisible(false)-starvation regression leaves glTexture null —
    // this is the exact technique that caught the bug in the prototype.)
    for (const [name, s] of Object.entries(snapshot.shaders)) {
      expect(s.exists, `shader ${name} should exist`).toBe(true);
      expect(s.glTextureNonNull, `shader ${name} glTexture should be non-null (not starved)`).toBe(
        true,
      );
    }
    for (const [key, present] of Object.entries(snapshot.rts)) {
      expect(present, `RT ${key} should be registered`).toBe(true);
    }
    expect(snapshot.filterRegistered, 'FilterFinal node should be registered').toBe(true);
    expect(snapshot.finalControllerPresent, 'Final controller should be on the camera').toBe(true);
  });

  test('canvas screenshot succeeds (no readPixels — Phaser-4.1 gotcha #4)', async ({ page }) => {
    await bootClient(page);
    await bootMatchAndWaitForMap(page);

    // Screenshot the canvas (NOT readPixels/snapshot). preserveDrawingBuffer
    // is already true in main.ts for this purpose.
    const canvas = page.locator('#game-container canvas').first();
    await expect(canvas).toBeVisible();
    const screenshot = await canvas.screenshot();
    expect(screenshot.length, 'screenshot should be a non-empty PNG').toBeGreaterThan(1024);
  });
});
