const { chromium } = require('/home/felip/.hermes/node/lib/node_modules/playwright');
const fs = require('fs');
const { execSync } = require('child_process');

const GAME_URL = 'http://localhost:8080';
const VIDEO_DIR = '/tmp/secto-ik-demo';
const OUTPUT = '/home/felip/.hermes/cache/videos/secto-ik-animation-demo.mp4';

execSync(
  `rm -rf ${VIDEO_DIR} && mkdir -p ${VIDEO_DIR} && mkdir -p /home/felip/.hermes/cache/videos`,
);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle'],
  });

  const ctx = await browser.newContext({
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();

  page.on('pageerror', (err) => console.log(`[PAGE ERROR] ${err.message}`));

  console.log('[1] Loading game...');
  await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  console.log('[2] Entering game...');
  await page.evaluate(() => window.__SECTO_DEBUG__.goToGame());

  await page.waitForFunction(
    () => {
      try {
        return window.__SECTO_DEBUG__?.runtime?.attack;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 60000 },
  );

  await page.waitForFunction(
    () => {
      try {
        const s = window.__SECTO_DEBUG__.getState();
        return s?.connected && s?.gameActive;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 60000 },
  );

  console.log('[3] Game active!');
  await page.waitForTimeout(2000);

  // Helpers — use CORRECT method names from RuntimeGameController
  const attack = (angle) => page.evaluate((a) => window.__SECTO_DEBUG__.runtime.attack(a), angle);
  const switchW = (slot) =>
    page.evaluate((s) => window.__SECTO_DEBUG__.runtime.switchWeapon(s), slot);
  const move = (dx, dy, aim) =>
    page.evaluate((o) => window.__SECTO_DEBUG__.runtime.move(o.dx, o.dy, o.aim), { dx, dy, aim });
  const moveCont = (dx, dy, aim, ms) =>
    page.evaluate((o) => window.__SECTO_DEBUG__.runtime.moveContinuous(o.dx, o.dy, o.aim, o.ms), {
      dx,
      dy,
      aim,
      ms,
    });
  const pickup = () => page.evaluate(() => window.__SECTO_DEBUG__.runtime.pickup());
  const getW = () => page.evaluate(() => window.__SECTO_DEBUG__.runtime.getWeapons());
  const getState = () => page.evaluate(() => window.__SECTO_DEBUG__.getState());
  const getPos = () => page.evaluate(() => window.__SECTO_DEBUG__.runtime.getPosition());
  const wait = (ms) => page.waitForTimeout(ms);

  const st = await getState();
  console.log(`[4] Players: ${st.players.length}, Pickups: ${st.weaponPickups.length}`);
  console.log(`    My pos: ${st.localPos.x.toFixed(0)}, ${st.localPos.y.toFixed(0)}`);

  // Find nearest weapon pickup
  const findNearestPickup = async () => {
    const s = await getState();
    const me = s.localPos;
    let nearest = null;
    let minDist = Infinity;
    for (const p of s.weaponPickups) {
      const dx = p.x - me.x;
      const dy = p.y - me.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    }
    return nearest ? { ...nearest, dist: minDist } : null;
  };

  // =============================================
  // PART 1: FISTS
  // =============================================
  console.log('[5] === FISTS DEMO ===');
  await move(0, 0, 0);
  await wait(300);

  // Rapid jabs right
  for (let i = 0; i < 6; i++) {
    await attack(0);
    await wait(280);
  }

  // Directional jabs
  for (const a of [0, Math.PI * 0.3, Math.PI * 0.6, Math.PI * 0.9, Math.PI * 1.2]) {
    await attack(a);
    await wait(350);
  }

  // Jab while moving
  await moveCont(1, 0, 0, 1500);
  for (let i = 0; i < 4; i++) {
    await attack(0);
    await wait(300);
  }
  await wait(500);

  // =============================================
  // PART 2: Pick up and demo weapons
  // =============================================
  console.log('[6] === FINDING WEAPONS ===');

  // Move toward nearest pickup and grab it
  for (let attempt = 0; attempt < 8; attempt++) {
    const nearest = await findNearestPickup();
    if (!nearest) {
      console.log('    No more pickups');
      break;
    }

    const me = await getPos();
    const dx = nearest.x - me.x;
    const dy = nearest.y - me.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const aim = Math.atan2(dy, dx);
    console.log(
      `    Pickup at (${nearest.x.toFixed(0)},${nearest.y.toFixed(0)}) dist=${dist.toFixed(0)} type=${nearest.weaponType}`,
    );

    if (dist < 80) {
      await pickup();
      await wait(400);
      const w = await getW();
      const nonFist = w.findIndex((s, i) => i > 0 && s.weaponType !== 0);
      if (nonFist >= 0) {
        console.log(`    Got weapon at slot ${nonFist}! type=${w[nonFist].weaponType}`);
        break;
      }
    } else {
      // Move toward it
      const stepMs = Math.min(dist / 2, 800);
      await moveCont(dx / dist, dy / dist, aim, stepMs);
      await wait(stepMs + 100);
      await pickup();
      await wait(400);

      const w = await getW();
      const nonFist = w.findIndex((s, i) => i > 0 && s.weaponType !== 0);
      if (nonFist >= 0) {
        console.log(`    Got weapon at slot ${nonFist}! type=${w[nonFist].weaponType}`);
        break;
      }
    }
  }

  // Demo whatever weapon we got
  const weapons = await getW();
  for (let slot = 1; slot < weapons.length; slot++) {
    if (!weapons[slot] || weapons[slot].weaponType === 0) continue;

    console.log(`[7] === DEMO SLOT ${slot}: type=${weapons[slot].weaponType} ===`);
    await switchW(slot);
    await wait(500);

    // Face right
    await move(0, 0, 0);
    await wait(200);

    // Normal attacks
    for (let i = 0; i < 5; i++) {
      await attack(0);
      await wait(500);
    }

    // Different angles
    for (let i = 0; i < 6; i++) {
      await attack((i / 6) * Math.PI * 2);
      await wait(450);
    }

    // Quick combo
    for (let i = 0; i < 3; i++) {
      await attack(0);
      await wait(250);
    }

    await wait(600);
  }

  // =============================================
  // PART 3: Try to get more weapons
  // =============================================
  for (let extra = 0; extra < 4; extra++) {
    const nearest = await findNearestPickup();
    if (!nearest) break;

    const me = await getPos();
    const dx = nearest.x - me.x;
    const dy = nearest.y - me.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const aim = Math.atan2(dy, dx);

    if (dist > 80) {
      await moveCont(dx / dist, dy / dist, aim, Math.min(dist / 2, 1000));
      await wait(Math.min(dist / 2, 1000) + 100);
    }
    await pickup();
    await wait(400);
  }

  // Demo all weapon slots
  const finalW = await getW();
  for (let slot = 1; slot < finalW.length; slot++) {
    if (!finalW[slot] || finalW[slot].weaponType === 0) continue;
    if (slot > 1 && finalW[slot].weaponType === finalW[slot - 1]?.weaponType) continue; // skip duplicate types

    console.log(`[8] === DEMO SLOT ${slot}: type=${finalW[slot].weaponType} ===`);
    await switchW(slot);
    await wait(500);

    for (let i = 0; i < 4; i++) {
      await attack(0);
      await wait(500);
    }
    for (let i = 0; i < 4; i++) {
      await attack(i * Math.PI * 0.5);
      await wait(400);
    }

    await wait(400);
  }

  // =============================================
  // PART 4: FISTS FINALE
  // =============================================
  console.log('[9] === FISTS FINALE ===');
  await switchW(0);
  await wait(300);

  for (let i = 0; i < 15; i++) {
    await attack(((i % 3) - 1) * 0.15);
    await wait(180);
  }

  await wait(2000);
  console.log('[10] Done!');

  const videoPath = await page.video().path();
  await page.close();
  await ctx.close();
  await browser.close();
  await new Promise((r) => setTimeout(r, 3000));

  const files = fs.readdirSync(VIDEO_DIR, { recursive: true });
  const webmFile = files.find((f) => typeof f === 'string' && f.endsWith('.webm'));
  if (!webmFile) {
    console.error('No webm!');
    process.exit(1);
  }

  const webmPath = `${VIDEO_DIR}/${webmFile}`;
  console.log(`[11] Converting ${webmPath}`);
  execSync(
    `ffmpeg -y -i "${webmPath}" -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" "${OUTPUT}" 2>&1`,
    { stdio: 'pipe' },
  );

  const stat = fs.statSync(OUTPUT);
  console.log(`[12] Output: ${(stat.size / 1024 / 1024).toFixed(1)}MB -> ${OUTPUT}`);
})();
