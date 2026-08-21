import { test, expect } from '@playwright/test';

const GAME_URL = 'http://localhost:8080';

test.describe('Prediction Jitter - RAF Monitor', () => {
  test('monitor isMoving transitions via RAF polling', async ({ page }) => {
    const diagLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[MD]')) {
        diagLogs.push(text);
      }
    });

    await page.goto(GAME_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      if (window.__SECTO_DEBUG__?.goToGame) {
        window.__SECTO_DEBUG__.goToGame();
      }
    });

    await page.waitForFunction(() => {
      const db = window.__SECTO_DEBUG__;
      return db && typeof db.getState === 'function';
    }, { timeout: 15000 });

    await page.waitForFunction(() => {
      const db = window.__SECTO_DEBUG__;
      if (!db) return false;
      const state = db.getState();
      return state.connected && state.myId;
    }, { timeout: 15000 });

    // Inject RAF-based monitor
    await page.evaluate(() => {
      const db = window.__SECTO_DEBUG__!;
      const myId = db.getState().myId;
      let prevSprite = db.getSpriteState(myId);
      let sampleCount = 0;
      let transitions = 0;

      function monitor() {
        sampleCount++;
        const sprite = db.getSpriteState(myId);
        if (!sprite || !prevSprite) {
          prevSprite = sprite;
          requestAnimationFrame(monitor);
          return;
        }

        const dx = sprite.x - prevSprite.x;
        const dy = sprite.y - prevSprite.y;

        // Log transitions
        if (sprite.isMoving !== prevSprite.isMoving) {
          transitions++;
          console.log(`[MD] T#${transitions} s${sampleCount}: isMoving ${prevSprite.isMoving}→${sprite.isMoving} pos=(${sprite.x.toFixed(3)},${sprite.y.toFixed(3)}) Δ(${dx.toFixed(4)},${dy.toFixed(4)}) anim=${sprite.animState}→${sprite.animState}`);
        }

        // Periodic log every 30 samples
        if (sampleCount % 30 === 0) {
          console.log(`[MD] s${sampleCount} pos=(${sprite.x.toFixed(3)},${sprite.y.toFixed(3)}) Δ(${dx.toFixed(4)},${dy.toFixed(4)}) isMoving=${sprite.isMoving} anim=${sprite.animState} transitions=${transitions}`);
        }

        prevSprite = sprite;
        requestAnimationFrame(monitor);
      }

      requestAnimationFrame(monitor);
      console.log('[MD] RAF monitor installed');
    });

    // Phase 1: Stand still 3s
    console.log('Phase 1: Standing still...');
    await page.waitForTimeout(3000);

    // Phase 2: Move W for 2s
    console.log('Phase 2: Moving W...');
    await page.keyboard.down('w');
    await page.waitForTimeout(2000);
    await page.keyboard.up('w');

    // Phase 3: Stand still 3s
    console.log('Phase 3: Standing still...');
    await page.waitForTimeout(3000);

    // Phase 4: Move diagonal for 2s
    console.log('Phase 4: Moving W+D...');
    await page.keyboard.down('w');
    await page.keyboard.down('d');
    await page.waitForTimeout(2000);
    await page.keyboard.up('w');
    await page.keyboard.up('d');

    // Phase 5: Stand still 3s
    console.log('Phase 5: Standing still...');
    await page.waitForTimeout(3000);

    // Print all logs
    console.log(`\n=== ALL LOGS (${diagLogs.length}) ===`);
    diagLogs.forEach(log => console.log(log));

    // Analyze transitions
    const transitionLogs = diagLogs.filter(l => l.includes(' T#'));
    const falseToTrue = transitionLogs.filter(l => l.includes('isMoving false→true'));
    const trueToFalse = transitionLogs.filter(l => l.includes('isMoving true→false'));
    
    // Find false→true with small delta (spurious)
    const spurious = falseToTrue.filter(l => {
      const match = l.match(/Δ\(([ -\d.]+),([ -\d.]+)\)/);
      if (!match) return false;
      return Math.abs(parseFloat(match[1])) < 0.5 && Math.abs(parseFloat(match[2])) < 0.5;
    });

    console.log(`\n=== ANALYSIS ===`);
    console.log(`Total transitions: ${transitionLogs.length}`);
    console.log(`false→true: ${falseToTrue.length}`);
    console.log(`true→false: ${trueToFalse.length}`);
    console.log(`Spurious false→true (< 0.5px delta): ${spurious.length}`);
    if (spurious.length > 0) {
      console.log(`\nSPURIOUS WALK TRIGGERS:`);
      spurious.forEach(l => console.log(`  ${l}`));
    }

    expect(true).toBe(true);
  });
});
