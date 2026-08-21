const playwrightPath = '/home/felip/workspace/secto-chaos-neo/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright';
const { chromium } = require(playwrightPath);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[TELEMETRY]')) {
      // silence
    } else {
      console.log('[browser]', text);
    }
  });

  console.log('Connecting to game at localhost:8080...');
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Inject prediction telemetry hook
  const injected = await page.evaluate(() => {
    const scene = window.__game?.scene?.keys?.GameScene;
    if (!scene) return { error: 'GameScene not found', keys: Object.keys(window.__game?.scene?.keys || {}) };

    const originalPush = scene.prediction.push.bind(scene.prediction);
    let pushCount = 0;
    let duplicateSeqCount = 0;
    const seenSequences = new Set();

    scene.prediction.push = function(record) {
      pushCount++;
      const seq = record.frame.sequence;
      if (seenSequences.has(seq)) {
        duplicateSeqCount++;
      }
      seenSequences.add(seq);
      originalPush(record);
    };

    // Track renderOffset magnitude
    let maxOffset = 0;
    let offsetSamples = 0;
    const origGetVisual = scene.getVisualPosition.bind(scene);
    const origUpdate = scene.update.bind(scene);
    scene.update = function(time, delta) {
      const vis = scene.getVisualPosition();
      if (vis) {
        const ox = Math.abs((scene.renderOffset?.x || 0));
        const oy = Math.abs((scene.renderOffset?.y || 0));
        const mag = Math.sqrt(ox*ox + oy*oy);
        if (mag > maxOffset) maxOffset = mag;
        offsetSamples++;
      }
      origUpdate(time, delta);
    };

    window.__pt = {
      getStats: () => ({
        pushCount,
        duplicateSeqCount,
        uniqueSequences: seenSequences.size,
        maxOffset,
        offsetSamples,
      }),
      reset: () => {
        pushCount = 0;
        duplicateSeqCount = 0;
        seenSequences.clear();
        maxOffset = 0;
        offsetSamples = 0;
      }
    };

    return { success: true };
  });

  if (injected.error) {
    console.log('ERROR:', JSON.stringify(injected));
    await browser.close();
    process.exit(1);
  }
  console.log('Telemetry injected. Waiting 5s for full game load...');
  await page.waitForTimeout(5000);

  // Phase 1: Move right for 2s
  console.log('\n=== Phase 1: Movement (hold right 2s) ===');
  await page.evaluate(() => window.__pt?.reset());
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(2000);
  await page.keyboard.up('ArrowRight');

  const p1 = await page.evaluate(() => window.__pt?.getStats());
  console.log('Pushes:', p1.pushCount, 'Unique seqs:', p1.uniqueSequences, 'Duplicates:', p1.duplicateSeqCount);
  console.log('Max renderOffset:', (p1.maxOffset || 0).toFixed(2), 'px');

  // Phase 2: Stop (deceleration — the flicker pattern)
  console.log('\n=== Phase 2: Stop / deceleration (3s) ===');
  await page.evaluate(() => window.__pt?.reset());
  await page.waitForTimeout(3000);

  const p2 = await page.evaluate(() => window.__pt?.getStats());
  console.log('Pushes:', p2.pushCount, 'Unique seqs:', p2.uniqueSequences, 'Duplicates:', p2.duplicateSeqCount);
  console.log('Max renderOffset:', (p2.maxOffset || 0).toFixed(2), 'px');

  // Phase 3: Move-stop-move burst (flicker trigger)
  console.log('\n=== Phase 3: Move-stop-move burst ===');
  await page.evaluate(() => window.__pt?.reset());
  for (let i = 0; i < 5; i++) {
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1000);

  const p3 = await page.evaluate(() => window.__pt?.getStats());
  console.log('Pushes:', p3.pushCount, 'Unique seqs:', p3.uniqueSequences, 'Duplicates:', p3.duplicateSeqCount);
  console.log('Max renderOffset:', (p3.maxOffset || 0).toFixed(2), 'px');

  // Verdict
  console.log('\n========================================');
  console.log('      RUNTIME VALIDATION RESULT');
  console.log('========================================');

  const phases = [p1, p2, p3];
  const totalPushes = phases.reduce((s, p) => s + (p?.pushCount || 0), 0);
  const totalDuplicates = phases.reduce((s, p) => s + (p?.duplicateSeqCount || 0), 0);
  const maxOffset = Math.max(...phases.map(p => p?.maxOffset || 0));

  const seqPass = totalDuplicates === 0;
  const offsetPass = maxOffset < 10;

  console.log('Sequence uniqueness: ' + (seqPass ? 'PASS' : 'FAIL') + ' (duplicates: ' + totalDuplicates + '/' + totalPushes + ')');
  console.log('Max renderOffset: ' + (offsetPass ? 'PASS' : 'WARN') + ' (' + maxOffset.toFixed(2) + 'px)');
  console.log('\nOverall: ' + ((seqPass && offsetPass) ? 'PASSED - Fix is working' : 'NEEDS INVESTIGATION'));

  await browser.close();
  process.exit((seqPass && offsetPass) ? 0 : 1);
})();
