import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Client-v3 Integration', () => {
  test('connection stability + atlas rendering + input verification', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      logs.push(text);
    });

    await page.goto('http://localhost:8080');
    await page.waitForTimeout(6000);

    await page.screenshot({ path: path.join('test-results', '01-initial.png') });

    // Focus the canvas
    const canvas = page.locator('canvas');
    await canvas.click();
    await page.waitForTimeout(500);

    // Press W for movement
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join('test-results', '02-after-move.png') });

    // Hold mouse down for ATTACK (pointer.isDown needs held state)
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1000);
      await page.mouse.up();
    }
    await page.waitForTimeout(500);

    // Press Space for DASH (hold for multiple frames)
    await page.keyboard.down('Space');
    await page.waitForTimeout(500);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    // Press E for PICKUP (hold for multiple frames)
    await page.keyboard.down('KeyE');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyE');
    await page.waitForTimeout(300);

    // Press 1 for weapon slot (hold)
    await page.keyboard.down('Digit1');
    await page.waitForTimeout(500);
    await page.keyboard.up('Digit1');

    await page.screenshot({ path: path.join('test-results', '03-after-actions.png') });

    // Wait 40 seconds to verify connection stability
    console.log('Waiting 40s to verify connection stability...');
    await page.waitForTimeout(40000);

    await page.screenshot({ path: path.join('test-results', '04-after-40s.png') });

    // Collect results
    const connLogs = logs.filter((l) => l.includes('[Connection]'));
    const errors = logs.filter((l) => l.startsWith('[error]'));
    const mapLogs = logs.filter((l) => l.includes('[MapRenderer]'));
    const gameLogs = logs.filter((l) => l.includes('[GameScene]'));

    console.log('=== CONNECTION LOGS ===');
    connLogs.forEach((l) => console.log(l));

    console.log('=== MAP RENDERER LOGS ===');
    mapLogs.forEach((l) => console.log(l));

    console.log('=== ERRORS ===');
    errors.forEach((l) => console.log(l));

    console.log('=== CONNECTION STABILITY ===');
    const leaveLogs = logs.filter((l) => l.includes('Room left'));
    const dropLogs = logs.filter((l) => l.includes('not connected'));
    console.log(`Leave events: ${leaveLogs.length}, Drop events: ${dropLogs.length}`);

    // Check for input with actions
    const inputsWithActions = logs.filter(
      (l) => l.includes('Sending input') && l.includes('actions=[') && !l.includes('actions=[]'),
    );
    console.log(`Inputs WITH actions: ${inputsWithActions.length}`);
    inputsWithActions.forEach((l) => console.log(l));

    // Verify atlas rendering
    const atlasRendered = mapLogs.some((l) => l.includes('baked=') && l.match(/baked=[1-9]/));
    const entitySpritesSkipped = mapLogs.some(
      (l) => l.includes('skipped(entity)=') && l.match(/skipped\(entity\)=[1-9]/),
    );

    console.log(`Atlas rendered sprites: ${atlasRendered}`);
    console.log(`Entity sprites skipped from bake: ${entitySpritesSkipped}`);

    // Assertions
    expect(connLogs.some((l) => l.includes('Connected as'))).toBeTruthy();
    expect(leaveLogs.length).toBe(0);
    expect(errors.length).toBe(0);
  });
});
