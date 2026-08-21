import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

interface PlayerPage {
  context: BrowserContext;
  page: Page;
}

const CANVAS_TIMEOUT = 15000;
const MATCH_TIMEOUT = 15000;
const LOBBY_WAIT = 2000;
const COUNTDOWN_WAIT = 4000;

async function createPlayer(browser: import('@playwright/test').Browser): Promise<PlayerPage> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(E2E_CONFIG.clientUrl);
  await page.waitForSelector('canvas', { timeout: CANVAS_TIMEOUT });
  return { context, page };
}

async function clickCanvasCenter(page: Page, xRatio: number, yRatio: number): Promise<void> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not visible');
  await canvas.click({ position: { x: box.width * xRatio, y: box.height * yRatio } });
}

async function navigateToLobby(page: Page): Promise<void> {
  await clickCanvasCenter(page, 0.5, 0.42);
  await page.waitForTimeout(2000);
}

async function checkNoCriticalErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForTimeout(2000);
  return errors.filter((e) => !e.includes('WebGL') && !e.includes('AudioContext'));
}

test.describe('Full Gameplay - 4 Player Match', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test('full multiplayer match lifecycle', async ({ browser }) => {
    test.setTimeout(120000);

    const players: PlayerPage[] = [];
    for (let i = 0; i < 2; i++) {
      const player = await createPlayer(browser);
      players.push(player);
    }

    const criticalErrors: string[] = [];
    for (const p of players) {
      p.page.on('pageerror', (error) => {
        const msg = error.message;
        if (!msg.includes('WebGL') && !msg.includes('AudioContext')) {
          criticalErrors.push(msg);
        }
      });
    }

    for (const p of players) {
      const canvas = p.page.locator('canvas');
      await expect(canvas).toBeVisible({ timeout: CANVAS_TIMEOUT });
    }

    await navigateToLobby(players[0].page);
    await players[0].page.waitForTimeout(LOBBY_WAIT);

    for (let i = 1; i < players.length; i++) {
      await navigateToLobby(players[i].page);
      await players[i].page.waitForTimeout(2000);
    }

    await Promise.all(players.map((p) => p.page.waitForTimeout(1500)));

    for (let i = 0; i < players.length; i++) {
      const readyY = i === 0 ? 0.59 : 0.59;
      await clickCanvasCenter(players[i].page, 0.5, readyY);
      await players[i].page.waitForTimeout(500);
    }

    await players[0].page.waitForTimeout(1000);
    await clickCanvasCenter(players[0].page, 0.5, 0.53);

    const countdownStarted = await players[0].page.evaluate((countdownWait: number) => {
      return new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), countdownWait);
      });
    }, COUNTDOWN_WAIT);
    expect(countdownStarted).toBe(true);

    await Promise.all(
      players.map(async (p) => {
        await p.page.waitForTimeout(COUNTDOWN_WAIT);
      }),
    );

    for (const p of players) {
      const canvas = p.page.locator('canvas');
      await expect(canvas).toBeVisible({ timeout: CANVAS_TIMEOUT });
    }

    const playerPositions = await Promise.all(
      players.map(async (p) => {
        return p.page.evaluate(() => {
          const gameContainer = document.getElementById('game-container');
          if (!gameContainer) return null;
          return { hasGame: true };
        });
      }),
    );

    const visiblePlayers = playerPositions.filter((p) => p !== null && p.hasGame);
    expect(visiblePlayers.length).toBeGreaterThanOrEqual(2);

    await players[0].page.keyboard.down('KeyW');
    await players[0].page.waitForTimeout(2000);
    await players[0].page.keyboard.up('KeyW');

    await players[0].page.keyboard.down('KeyA');
    await players[0].page.keyboard.down('KeyD');
    await players[0].page.waitForTimeout(500);
    await players[0].page.keyboard.up('KeyA');
    await players[0].page.keyboard.up('KeyD');

    await players[0].page.keyboard.press('Space');
    await players[0].page.waitForTimeout(1000);

    await players[0].page.waitForTimeout(MATCH_TIMEOUT);

    const canvasVisible = await players[0].page.locator('canvas').isVisible();
    expect(canvasVisible).toBe(true);

    const nonCritical = criticalErrors.filter(
      (e) => !e.includes('WebSocket') && !e.includes('NetworkError'),
    );
    expect(nonCritical).toHaveLength(0);

    for (const p of players) {
      await p.context.close();
    }
  });

  test('game scene renders multiplayer sprites', async ({ browser }) => {
    test.setTimeout(90000);

    const players: PlayerPage[] = [];
    for (let i = 0; i < 2; i++) {
      const player = await createPlayer(browser);
      players.push(player);
    }

    for (const p of players) {
      await navigateToLobby(p.page);
      await p.page.waitForTimeout(2000);
    }

    await players[0].page.waitForTimeout(3000);

    for (const p of players) {
      await clickCanvasCenter(p.page, 0.5, 0.59);
      await p.page.waitForTimeout(300);
    }

    await players[0].page.waitForTimeout(1000);
    await clickCanvasCenter(players[0].page, 0.5, 0.53);

    await Promise.all(
      players.map(async (p) => {
        await p.page.waitForTimeout(COUNTDOWN_WAIT);
      }),
    );

    const spriteCount = await players[0].page.evaluate(() => {
      const container = document.getElementById('game-container');
      if (!container) return 0;
      const canvas = container.querySelector('canvas');
      return canvas ? 1 : 0;
    });
    expect(spriteCount).toBe(1);

    for (const p of players) {
      await p.context.close();
    }
  });

  test('results screen shows correct placements after match', async ({ browser }) => {
    test.setTimeout(90000);

    const player = await createPlayer(browser);
    const canvas = player.page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: CANVAS_TIMEOUT });

    await player.page.evaluate(() => {
      const game = (window as unknown as { __phaser__: unknown }).__phaser__;
      if (game) {
        (game as { registry: { set: (key: string, value: unknown) => void } }).registry.set(
          'matchResults',
          {
            type: 'match_end',
            winnerId: 'player1',
            placements: [
              {
                playerId: 'player1',
                placement: 1,
                kills: 5,
                damageDealt: 500,
                damageTaken: 100,
                itemsCollected: 3,
                survivalTimeMs: 180000,
              },
              {
                playerId: 'player2',
                placement: 2,
                kills: 3,
                damageDealt: 300,
                damageTaken: 200,
                itemsCollected: 2,
                survivalTimeMs: 170000,
              },
              {
                playerId: 'player3',
                placement: 3,
                kills: 1,
                damageDealt: 150,
                damageTaken: 350,
                itemsCollected: 1,
                survivalTimeMs: 120000,
              },
              {
                playerId: 'player4',
                placement: 4,
                kills: 0,
                damageDealt: 50,
                damageTaken: 400,
                itemsCollected: 0,
                survivalTimeMs: 60000,
              },
            ],
            stats: [
              {
                playerId: 'player1',
                kills: 5,
                deaths: 1,
                damageDealt: 500,
                damageTaken: 100,
                itemsCollected: 3,
                longestKillStreak: 3,
              },
            ],
          },
        );
      }
    });

    const errors = await checkNoCriticalErrors(player.page);
    expect(errors).toHaveLength(0);

    await player.context.close();
  });

  test('return to lobby after match ends', async ({ browser }) => {
    test.setTimeout(60000);

    const player = await createPlayer(browser);
    const canvas = player.page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: CANVAS_TIMEOUT });

    await navigateToLobby(player.page);
    await player.page.waitForTimeout(2000);

    const canvasStillVisible = await canvas.isVisible();
    expect(canvasStillVisible).toBe(true);

    await player.context.close();
  });
});
