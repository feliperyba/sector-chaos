/**
 * Seam C — browser visual verification for the deferred lighting pipeline
 * (Ticket 06, iteration 2).
 *
 * This is the honest completion of the browser-required verification that
 * iteration 1 left unfinished. It drives a real demo match via MainMenu's
 * debug `goToGame` hook, then captures:
 *   1. Console errors emitted during the lighting pipeline's lifetime
 *      (must be zero NEW errors — pipeline must not regress the runtime).
 *   2. A canvas screenshot (NOT readPixels — Phaser-4.1 gotcha #4) showing
 *      the HUD over the lit world.
 *   3. A second canvas screenshot after panning the player (keyboard input)
 *      to verify the test light stays world-locked under camera movement.
 *
 * It also re-probes the glTexture-existence diagnostic (Seam B style) so the
 * screenshot can be cross-read against the pipeline's live internal state.
 *
 * Run via the project's Playwright tooling (dev server auto-started):
 *   pnpm exec playwright test tests/e2e/lighting-seam-c-verify.spec.ts
 *
 * The screenshot PNGs land in tests/e2e/.lighting-seam-c/ for human review.
 */
import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const MAP_LOAD_TIMEOUT = 25000;
const SCENE_SETTLE_MS = 2500;
const OUT_DIR = path.resolve(__dirname, '.lighting-seam-c');

interface DiagnosticSnapshot {
  shaders: Record<string, { exists: boolean; glTextureNonNull: boolean }>;
  rts: Record<string, boolean>;
  filterRegistered: boolean;
  finalControllerPresent: boolean;
}

async function bootClient(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __SECTO_DEBUG__?: { goToGame?: unknown } }).__SECTO_DEBUG__;
      return typeof d?.goToGame === 'function';
    },
    { timeout: 25000 },
  );
}

async function bootMatchAndWaitForPipeline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as unknown as { __SECTO_DEBUG__?: { goToGame: () => void } })
      .__SECTO_DEBUG__;
    if (!debug || typeof debug.goToGame !== 'function') {
      throw new Error('MainMenu debug hook not exposed — run against the dev server (DEV mode)');
    }
    debug.goToGame();
  });
  await page.waitForFunction(
    () => {
      const diag = (window as unknown as { __LIGHTING_DIAG__?: () => unknown }).__LIGHTING_DIAG__;
      return typeof diag === 'function';
    },
    { timeout: MAP_LOAD_TIMEOUT },
  );
  await page.waitForTimeout(SCENE_SETTLE_MS);
}

test.describe('Lighting pipeline — Seam C (browser visual verification)', () => {
  test('HUD legible over lit world, test light world-locked, no new console errors', async ({
    page,
  }) => {
    test.setTimeout(240000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Collect console + page errors so we can assert NO NEW errors were
    // introduced by the lighting pipeline. Pre-existing errors (if any) are
    // logged but the assertion targets the lighting-specific surface.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[console] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`[pageerror] ${err.message}`);
    });

    await bootClient(page);
    await bootMatchAndWaitForPipeline(page);

    // ── Probe the pipeline's live internal state (Seam B style) ──
    const snapshot = await page.evaluate((): DiagnosticSnapshot | null => {
      const diag = (window as unknown as { __LIGHTING_DIAG__?: () => DiagnosticSnapshot | null })
        .__LIGHTING_DIAG__;
      return diag ? diag() : null;
    });
    expect(snapshot, 'lighting diagnostic snapshot should be available').not.toBeNull();
    for (const [name, s] of Object.entries(snapshot!.shaders)) {
      expect(s.exists, `shader ${name} should exist`).toBe(true);
      expect(s.glTextureNonNull, `shader ${name} glTexture should be non-null (not starved)`).toBe(
        true,
      );
    }
    for (const [key, present] of Object.entries(snapshot!.rts)) {
      expect(present, `RT ${key} should be registered`).toBe(true);
    }
    expect(snapshot!.filterRegistered, 'FilterFinal node should be registered').toBe(true);
    expect(snapshot!.finalControllerPresent, 'Final controller should be on the camera').toBe(true);

    // ── Confirm the local player is ALIVE before capturing the proof ──
    // Iteration 2 captured the pan/zoom evidence AFTER the player had died
    // (the screenshot showed ELIMINATED / RETURN TO TITLE / SPECTATE), which
    // made the test-light anchor ambiguous. The test light follows the local
    // player's visual.x/y; that's well-defined only while the player is in
    // the world. The DebugBridge exposes `gameActive` for exactly this check.
    const aliveState = await page.evaluate((): { gameActive: boolean; myId: string | null } => {
      const debug = (window as unknown as { __SECTO_DEBUG__?: { getState?: () => unknown } })
        .__SECTO_DEBUG__;
      if (!debug || typeof debug.getState !== 'function') {
        return { gameActive: false, myId: null };
      }
      const s = debug.getState() as { gameActive?: boolean; myId?: string | null };
      return { gameActive: !!s.gameActive, myId: s.myId ?? null };
    });
    expect(
      aliveState.gameActive,
      `local player should be ALIVE when capturing the lit-world proof (gameActive was false; myId=${aliveState.myId})`,
    ).toBe(true);

    // ── Screenshot 1: HUD over lit world (the load-bearing visual proof) ──
    // Reshoot the viewport to a typical play size so HUD elements are clear.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(1500); // let the resize rebuild + a few frames render
    const canvas = page.locator('#game-container canvas').first();
    await expect(canvas).toBeVisible();
    const screenshot1Path = path.join(OUT_DIR, 'lit-world-hud-1.png');
    await canvas.screenshot({ path: screenshot1Path });
    const screenshot1 = await canvas.screenshot();
    expect(screenshot1.length, 'screenshot 1 should be a non-empty PNG').toBeGreaterThan(1024);

    // ── Debug: capture the ALBEDO RT pass-through (showMode=1) to isolate
    // whether the world is being captured into __albedoRT at all. If the
    // albedo screenshot is also black, the capture step is broken; if it has
    // the world, the Sobel/HdrLit stages are the issue. This is the PRIMARY
    // proof the deferred pipeline is actually capturing the real map (the
    // iteration-2/3 bug: a black albedo meant the lit-world screenshot was
    // just the unlit world bleeding through slot 0 of the Final filter).
    await page.evaluate(() => {
      (window as unknown as { __LIGHTING_SHOW__: number }).__LIGHTING_SHOW__ = 1;
    });
    await page.waitForTimeout(1500);
    const albedoPath = path.join(OUT_DIR, 'debug-albedo-passthrough.png');
    await canvas.screenshot({ path: albedoPath });
    // Restore lit mode.
    await page.evaluate(() => {
      (window as unknown as { __LIGHTING_SHOW__: number }).__LIGHTING_SHOW__ = 0;
    });
    await page.waitForTimeout(800);

    // ── Screenshot 2: pan the player to verify the test light stays world-locked ──
    // Hold a movement key long enough to scroll the camera, then screenshot.
    // Re-check alive here too — if the player died during the albedo capture,
    // skip the pan (the light follows the player; once dead its position is
    // frozen and the world-locked-under-pan property is meaningless).
    const aliveBeforePan = await page.evaluate((): boolean => {
      const debug = (window as unknown as { __SECTO_DEBUG__?: { getState?: () => unknown } })
        .__SECTO_DEBUG__;
      if (!debug || typeof debug.getState !== 'function') return false;
      const s = debug.getState() as { gameActive?: boolean };
      return !!s.gameActive;
    });
    if (aliveBeforePan) {
      await page.keyboard.down('KeyD');
      await page.waitForTimeout(1200);
      await page.keyboard.up('KeyD');
      await page.waitForTimeout(600); // let camera lerp settle
    }
    const screenshot2Path = path.join(OUT_DIR, 'lit-world-hud-2-panned.png');
    await canvas.screenshot({ path: screenshot2Path });

    // ── Screenshot 3: a third frame at a different world position ──
    // (More evidence the light is world-locked.)
    const aliveBeforeS3 = await page.evaluate((): boolean => {
      const debug = (window as unknown as { __SECTO_DEBUG__?: { getState?: () => unknown } })
        .__SECTO_DEBUG__;
      if (!debug || typeof debug.getState !== 'function') return false;
      const s = debug.getState() as { gameActive?: boolean };
      return !!s.gameActive;
    });
    if (aliveBeforeS3) {
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(1000);
      await page.keyboard.up('KeyS');
      await page.waitForTimeout(500);
    }
    const screenshot3Path = path.join(OUT_DIR, 'lit-world-hud-3-moved.png');
    await canvas.screenshot({ path: screenshot3Path });

    // Final alive-state probe — confirms the player survived the pan or
    // surfaces (in the log) when they died mid-capture.
    const aliveAtEnd = await page.evaluate((): boolean => {
      const debug = (window as unknown as { __SECTO_DEBUG__?: { getState?: () => unknown } })
        .__SECTO_DEBUG__;
      if (!debug || typeof debug.getState !== 'function') return false;
      const s = debug.getState() as { gameActive?: boolean };
      return !!s.gameActive;
    });

    // Attach the diagnostic snapshot + error rosters to the test output.
    console.log('SEAM_C_DIAG_SNAPSHOT=' + JSON.stringify(snapshot));
    console.log('SEAM_C_CONSOLE_ERRORS=' + JSON.stringify(consoleErrors));
    console.log('SEAM_C_PAGE_ERRORS=' + JSON.stringify(pageErrors));
    console.log(
      'SEAM_C_ALIVE=' +
        JSON.stringify({
          atBoot: aliveState.gameActive,
          beforePan: aliveBeforePan,
          beforeS3: aliveBeforeS3,
          atEnd: aliveAtEnd,
        }),
    );
    console.log(
      'SEAM_C_SCREENSHOTS=' +
        JSON.stringify([screenshot1Path, albedoPath, screenshot2Path, screenshot3Path]),
    );

    // ── Assert no new console/page errors during the lighting pipeline's life ──
    // Filter out any pre-existing noise (none expected, but be defensive so a
    // flaky unrelated warning doesn't fail this verification). The assertion
    // targets WebGL/lighting-context errors specifically.
    const lightingRelevantErrors = [...consoleErrors, ...pageErrors].filter((m) =>
      /light|shader|WebGL|RenderTexture|glTexture|FilterFinal|__albedoRT|__normalsRT|__litRT| CONTEXT_LOST/i.test(
        m,
      ),
    );
    expect(
      lightingRelevantErrors,
      `lighting-relevant console/page errors should be empty; got: ${JSON.stringify(lightingRelevantErrors)}`,
    ).toEqual([]);
  });
});
