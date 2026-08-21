/**
 * Runtime netcode validation via Playwright.
 * Connects to the live game, exercises movement, and asserts netcode metrics.
 *
 * Usage: node scripts/validate-netcode.mjs
 *
 * Expects game running at http://localhost:8080 with server at ws://localhost:2567
 */
import { chromium } from 'playwright';

const GAME_URL = 'http://localhost:8080';
const TIMEOUT_MS = 30_000;

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';

const results = [];

function log(symbol, msg) {
  console.log(`${symbol} ${msg}`);
  results.push({ pass: symbol === PASS, warn: symbol === WARN, msg });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Netcode Runtime Validation ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // Collect console messages
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  console.log(`Loading game at ${GAME_URL}...`);
  await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
  log(PASS, 'Game page loaded');

  // Wait for Phaser to initialize and debug bridge to be available
  console.log('Waiting for debug bridge...');
  const debugReady = await page.waitForFunction(
    () => window.__SECTO_DEBUG__ != null,
    { timeout: TIMEOUT_MS },
  ).catch(() => null);

  if (!debugReady) {
    log(FAIL, 'Debug bridge not available — game may not have loaded correctly');
    console.log('Checking page content...');
    const bodyText = await page.textContent('body');
    console.log('Page text (first 500 chars):', bodyText?.slice(0, 500));
    await browser.close();
    process.exit(1);
  }
  log(PASS, 'Debug bridge available on window.__SECTO_DEBUG__');

  // Check game state
  const state = await page.evaluate(() => window.__SECTO_DEBUG__.getState());
  console.log(`\n--- Initial State ---`);
  console.log(`  scene: ${state.scene}`);
  console.log(`  connected: ${state.connected}`);
  console.log(`  gameActive: ${state.gameActive}`);
  console.log(`  myId: ${state.myId || '(not set)'}`);
  console.log(`  tick: ${state.tick}`);
  console.log(`  players: ${state.players.length}`);

  if (!state.connected) {
    log(FAIL, 'Not connected to server');
    await browser.close();
    process.exit(1);
  }
  log(PASS, 'Connected to game server');

  // Wait for game to be active (match started)
  console.log('\nWaiting for game to start...');
  const gameActive = await page.waitForFunction(
    () => window.__SECTO_DEBUG__?.getState()?.gameActive === true,
    { timeout: TIMEOUT_MS },
  ).catch(() => null);

  if (!gameActive) {
    log(WARN, 'Game not active after timeout — may need manual start. Continuing anyway...');
  } else {
    log(PASS, 'Game is active');
  }

  // Simulate movement for 5 seconds to generate netcode traffic
  console.log('\nSimulating movement for 5 seconds...');
  await page.evaluate(() => {
    // Move right continuously
    window.__moveInterval = setInterval(() => {
      const dbg = window.__SECTO_DEBUG__;
      if (dbg) dbg.runtime.move(1, 0, 0);
    }, 16);
  });

  await sleep(5000);

  // Stop movement
  await page.evaluate(() => {
    clearInterval(window.__moveInterval);
  });

  // Wait a moment for final state sync
  await sleep(1000);

  // Gather netcode metrics
  console.log('\n--- Netcode Metrics ---');
  const metrics = await page.evaluate(() => window.__SECTO_DEBUG__.getNetcodeMetrics());

  console.log(`  predictionError: ${metrics.predictionError}px`);
  console.log(`  rttMs: ${metrics.rttMs}ms`);
  console.log(`  patchRate: ${metrics.patchRate}/s`);
  console.log(`  inputRate: ${metrics.inputRate}/s`);
  console.log(`  avgCorrection: ${metrics.avgCorrection}px`);
  console.log(`  maxCorrection: ${metrics.maxCorrection}px`);
  console.log(`  renderOffsetMagnitude: ${metrics.renderOffsetMagnitude}px`);
  console.log(`  reconciliationCount: ${metrics.reconciliationCount}`);
  console.log(`  snapCount: ${metrics.snapCount}`);
  console.log(`  jankFrames: ${metrics.jankFrames}/${metrics.totalFrames}`);
  console.log(`  totalFrames: ${metrics.totalFrames}`);

  // Assertions
  console.log('\n--- Assertions ---');

  // 1. Patch rate should be ~60/s (syncEveryN=1, tickRate=60)
  if (metrics.patchRate >= 50) {
    log(PASS, `Patch rate: ${metrics.patchRate}/s (target: 60/s, min: 50/s)`);
  } else if (metrics.patchRate >= 30) {
    log(WARN, `Patch rate: ${metrics.patchRate}/s (low — may indicate old PATCH_RATE=30)`);
  } else if (metrics.patchRate > 0) {
    log(FAIL, `Patch rate: ${metrics.patchRate}/s (WAY too low)`);
  } else {
    log(WARN, `Patch rate: 0/s — no state patches received (may need longer test)`);
  }

  // 2. Input rate should be reasonable (~60/s)
  if (metrics.inputRate >= 30) {
    log(PASS, `Input rate: ${metrics.inputRate}/s`);
  } else if (metrics.inputRate > 0) {
    log(WARN, `Input rate: ${metrics.inputRate}/s (lower than expected)`);
  } else {
    log(FAIL, `Input rate: 0/s — no inputs sent`);
  }

  // 3. Prediction error should be small (< 10px average)
  if (metrics.predictionError < 5) {
    log(PASS, `Prediction error: ${metrics.predictionError}px (excellent, < 5px)`);
  } else if (metrics.predictionError < 10) {
    log(PASS, `Prediction error: ${metrics.predictionError}px (good, < 10px)`);
  } else if (metrics.predictionError < 20) {
    log(WARN, `Prediction error: ${metrics.predictionError}px (acceptable but high)`);
  } else {
    log(FAIL, `Prediction error: ${metrics.predictionError}px (too high — prediction broken)`);
  }

  // 4. Max correction should be bounded
  if (metrics.maxCorrection < 10) {
    log(PASS, `Max correction: ${metrics.maxCorrection}px (< 10px)`);
  } else if (metrics.maxCorrection < 30) {
    log(WARN, `Max correction: ${metrics.maxCorrection}px (10-30px — some drift)`);
  } else {
    log(FAIL, `Max correction: ${metrics.maxCorrection}px (> 30px — severe prediction drift)`);
  }

  // 5. Render offset should be near zero when working correctly
  if (metrics.renderOffsetMagnitude < 3) {
    log(PASS, `Render offset: ${metrics.renderOffsetMagnitude}px (near zero)`);
  } else if (metrics.renderOffsetMagnitude < 8) {
    log(WARN, `Render offset: ${metrics.renderOffsetMagnitude}px (elevated)`);
  } else {
    log(FAIL, `Render offset: ${metrics.renderOffsetMagnitude}px (too high — visual jitter)`);
  }

  // 6. RTT should be reasonable (localhost should be < 50ms)
  if (metrics.rttMs <= 50) {
    log(PASS, `RTT: ${metrics.rttMs}ms (localhost)`);
  } else if (metrics.rttMs <= 100) {
    log(WARN, `RTT: ${metrics.rttMs}ms (higher than expected for localhost)`);
  } else {
    log(FAIL, `RTT: ${metrics.rttMs}ms (too high for localhost)`);
  }

  // 7. Jank frames should be minimal
  const jankPct = metrics.totalFrames > 0 ? (metrics.jankFrames / metrics.totalFrames * 100) : 0;
  if (jankPct < 5) {
    log(PASS, `Jank frames: ${metrics.jankFrames}/${metrics.totalFrames} (${jankPct.toFixed(1)}%)`);
  } else {
    log(WARN, `Jank frames: ${metrics.jankFrames}/${metrics.totalFrames} (${jankPct.toFixed(1)}%)`);
  }

  // 8. Check for JS errors
  if (consoleErrors.length === 0) {
    log(PASS, 'No console errors');
  } else {
    log(WARN, `${consoleErrors.length} console errors detected`);
    consoleErrors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  }

  // Final position check
  const finalState = await page.evaluate(() => window.__SECTO_DEBUG__.getState());
  console.log(`\n--- Final State ---`);
  console.log(`  localPos: (${finalState.localPos.x.toFixed(1)}, ${finalState.localPos.y.toFixed(1)})`);
  console.log(`  tick: ${finalState.tick}`);
  console.log(`  lastProcessedInput: ${finalState.lastProcessedInput}`);

  // Summary
  console.log('\n=== Summary ===');
  const passes = results.filter((r) => r.pass).length;
  const fails = results.filter((r) => !r.pass && !r.warn).length;
  const warns = results.filter((r) => r.warn).length;
  console.log(`${passes} passed, ${warns} warnings, ${fails} failures`);

  await browser.close();

  if (fails > 0) {
    console.log('\n❌ NETCODE VALIDATION FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ NETCODE VALIDATION PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Validation script error:', err);
  process.exit(1);
});
