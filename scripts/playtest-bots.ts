/**
 * Browser playtest via Playwright: loads the client, joins a real server match,
 * and verifies bots are present, moving, and fighting by sampling
 * window.__SECTO_DEBUG__.getState() over time. Captures screenshots as evidence.
 *
 * Run with the Docker stack up (server :2567 healthy, client :8080 up).
 *   npx tsx packages/client-v3/scripts/playtest-bots.ts
 */
import { chromium } from 'playwright';

const CLIENT_URL = process.env.CLIENT_URL ?? 'http://localhost:8080/';

interface DebugPlayer {
  id: string;
  x: number;
  y: number;
  health?: number;
  alive?: boolean;
}
interface DebugState {
  scene: string;
  myId: string | null;
  tick: number;
  players: DebugPlayer[];
  gameActive: boolean;
  connected: boolean;
  mapLoaded: boolean;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));

  console.log(`Loading ${CLIENT_URL} ...`);
  await page.goto(CLIENT_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500); // let main menu assets settle

  await page.screenshot({ path: 'playtest-1-menu.png' });
  console.log('Screenshot: playtest-1-menu.png');

  // Click JOIN to enter matchmaking -> game.
  const joinBtn = page.getByText('JOIN', { exact: true }).first();
  if (await joinBtn.count()) {
    console.log('Clicking JOIN...');
    await joinBtn.click({ timeout: 5000 }).catch(() => {});
  } else {
    // Some builds may render the button inside a container; try clicking at the
    // primary button position via text locator on the canvas-less menu.
    console.log('JOIN text not found; trying button click via role...');
    await page
      .getByRole('button', { name: /join/i })
      .click({ timeout: 5000 })
      .catch(() => {});
  }

  // Wait for the game scene to load and the debug bridge to be exposed. The
  // matchmaking + bot-fill + countdown can take a while.
  console.log('Waiting for game scene + debug bridge (up to 120s)...');
  let inGame = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const dbg = await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      if (!d) return null;
      try {
        return d.getState();
      } catch {
        return null;
      }
    });
    if (dbg && dbg.scene === 'GameScene') {
      inGame = true;
      console.log(
        `  in GameScene: tick=${dbg.tick} players=${dbg.players?.length ?? 0} ` +
          `connected=${dbg.connected} gameActive=${dbg.gameActive} mapLoaded=${dbg.mapLoaded}`,
      );
      if (dbg.players && dbg.players.length > 0) break;
    } else if (dbg) {
      console.log(`  scene=${dbg.scene} (not game yet)`);
    } else {
      console.log(`  debug bridge not ready...`);
    }
  }

  if (!inGame) {
    await page.screenshot({ path: 'playtest-2-notingame.png' });
    console.log('FAILED to reach GameScene. Screenshot: playtest-2-notingame.png');
    console.log('Console errors:', consoleErrors.slice(0, 10));
    await browser.close();
    process.exit(2);
  }

  await page.screenshot({ path: 'playtest-2-game.png' });
  console.log('Screenshot: playtest-2-game.png');

  // Sample player positions over ~12s to verify bots are MOVING (reactive) and
  // count is decreasing (combat happening) or health changing.
  const samples: Array<{ t: string; players: number; avgHP: number; myMoving: boolean }> = [];
  let lastMyPos: { x: number; y: number } | null = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    const st = (await page.evaluate(() => {
      const d = (window as any).__SECTO_DEBUG__;
      return d ? d.getState() : null;
    })) as DebugState | null;
    if (!st) continue;
    const alive = st.players.filter((p) => p.alive !== false);
    const avgHP =
      alive.length > 0 ? alive.reduce((s, p) => s + (p.health ?? 100), 0) / alive.length : 0;
    const me = st.players.find((p) => p.id === st.myId);
    let moving = false;
    if (me) {
      if (lastMyPos) {
        moving = Math.hypot(me.x - lastMyPos.x, me.y - lastMyPos.y) > 2;
      }
      lastMyPos = { x: me.x, y: me.y };
    }
    samples.push({
      t: `+${i + 1}s`,
      players: alive.length,
      avgHP: Math.round(avgHP),
      myMoving: moving,
    });
  }

  console.log('\n=== GAMEPLAY SAMPLE (bots present/moving, combat) ===');
  console.log('time  | alivePlayers | avgHP | localPlayerMoving');
  for (const s of samples) {
    console.log(
      `${s.t.padStart(5)} | ${String(s.players).padStart(12)} | ${String(s.avgHP).padStart(5)} | ${s.myMoving}`,
    );
  }

  await page.screenshot({ path: 'playtest-3-action.png' });
  console.log('\nScreenshot: playtest-3-action.png');

  const firstCount = samples[0]?.players ?? 0;
  const lastCount = samples[samples.length - 1]?.players ?? 0;
  const hpDropped = (samples[0]?.avgHP ?? 100) > (samples[samples.length - 1]?.avgHP ?? 100);
  console.log(
    `\nalive: ${firstCount} -> ${lastCount} (combat happening if decreasing); ` +
      `avgHP trend ${hpDropped ? 'dropping (combat/damage)' : 'stable'}`,
  );

  console.log(`\nConsole errors during playtest (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 15)) console.log('  ' + e.slice(0, 200));

  await browser.close();

  // Exit code reflects whether bots were demonstrably present + reactive.
  const botsPresent = firstCount > 5;
  const reactive =
    samples.filter((s) => s.myMoving).length > 3 || hpDropped || lastCount < firstCount;
  console.log(`\nRESULT: botsPresent=${botsPresent} reactive=${reactive}`);
  process.exit(botsPresent && reactive ? 0 : 3);
}

main().catch((e) => {
  console.error('Playtest failed:', e);
  process.exit(1);
});
