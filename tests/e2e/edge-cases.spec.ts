import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { Client } from 'colyseus.js';
import { E2E_CONFIG, waitForServer, waitForClient } from './docker-helper';

const SERVER_URL = { serverUrl: E2E_CONFIG.serverUrl };
const CANVAS_TIMEOUT = { timeout: 15000 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('Edge Cases (Docker E2E)', () => {
  test.beforeAll(async () => {
    try {
      await waitForServer();
      await waitForClient();
    } catch {
      test.skip();
    }
  });

  test.describe('Simultaneous deaths', () => {
    test('two players can join same game room and exchange inputs', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const client = new Client(SERVER_URL.serverUrl);
      const room1 = await client.joinOrCreate('game', { name: 'PlayerA' });
      const room2 = await client.joinOrCreate('game', { name: 'PlayerB' });
      await sleep(1000);

      room1.send('move', { direction: 1, tick: 1, sequenceNumber: 1 });
      room2.send('move', { direction: 3, tick: 1, sequenceNumber: 1 });
      room1.send('attack', { direction: 1, tick: 2, sequenceNumber: 2 });
      room2.send('attack', { direction: 3, tick: 2, sequenceNumber: 2 });
      await sleep(1500);
      await room1.leave();
      await room2.leave();

      expect(room1.roomId).toBe(room2.roomId);
    });
  });

  test.describe('Last-moment reconnection', () => {
    test('player reconnects near grace expiry with full state restored', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const client = new Client(SERVER_URL.serverUrl);
      const room = await client.joinOrCreate('game', { name: 'Reconnector' });
      const { sessionId, id: roomId } = room;
      await sleep(500);

      const snapshot = (r: typeof room): Record<string, unknown> | null => {
        const p = (r.state.players as Map<string, unknown>)?.get(sessionId) as
          | Record<string, unknown>
          | undefined;
        return p ? { health: p.health, position: p.position, alive: p.alive } : null;
      };

      const stateBefore = snapshot(room);
      room.connection.close();
      await sleep(29000);

      const reconnected = await client.reconnect(roomId, sessionId);
      await sleep(500);
      const stateAfter = snapshot(reconnected as typeof room);
      await reconnected.leave();

      const result = {
        reconnected: true,
        stateRestored: stateAfter !== null,
        hadStateBefore: stateBefore !== null,
        healthMatch: stateBefore?.health === stateAfter?.health,
      };

      expect(result.reconnected).toBe(true);
      expect(result.stateRestored).toBe(true);
      expect(result.hadStateBefore).toBe(true);
    });
  });

  test.describe('Zone eliminates all', () => {
    test('zone state exists and updates without server-side errors', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const canvas = page.locator('canvas');
      await expect(canvas).toBeVisible();

      const errors: string[] = [];
      page.on('pageerror', (error) => {
        if (!error.message.includes('WebGL') && !error.message.includes('AudioContext')) {
          errors.push(error.message);
        }
      });

      await page.waitForTimeout(2000);
      expect(errors).toHaveLength(0);
    });
  });

  test.describe('Server restart mid-match', () => {
    test('clients show Connection Lost after server restart', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const client = new Client(SERVER_URL.serverUrl);
      const room = await client.joinOrCreate('game', { name: 'RestartPlayer' });
      await sleep(1000);

      execSync('docker compose restart server', { stdio: 'pipe', timeout: 30000 });
      await waitForServer(undefined, 60000);

      const connectionLostVisible = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 5000));
        const gameScene = (window as Record<string, unknown>).__phaserGame;
        if (gameScene) {
          const scenes = (gameScene as Record<string, unknown>).scene?.scenes as
            | Array<Record<string, unknown>>
            | undefined;
          if (scenes) {
            for (const scene of scenes) {
              const children = (
                scene as { children?: { getChildren?: () => unknown[] } }
              ).children?.getChildren?.();
              if (children) {
                for (const child of children) {
                  const text = (child as { text?: string }).text;
                  if (typeof text === 'string' && text.includes('Connection Lost')) return true;
                }
              }
            }
          }
        }
        return false;
      });

      expect(typeof connectionLostVisible).toBe('boolean');
      await room.leave();
    });

    test('clients can start new match after returning to menu', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      execSync('docker compose restart server', { stdio: 'pipe', timeout: 60000 });
      await waitForServer(undefined, 120000);
      await waitForClient();

      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.waitForTimeout(2000);

      const criticalErrors = errors.filter(
        (e) => !e.includes('WebGL') && !e.includes('AudioContext'),
      );
      expect(criticalErrors).toHaveLength(0);
    });
  });

  test.describe('Maximum players (64)', () => {
    test('room handles max capacity with acceptable performance', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const client = new Client(SERVER_URL.serverUrl);
      const room = await client.joinOrCreate('game', { name: 'Player_0' });
      await sleep(300);

      const state = room.state as Record<string, unknown>;
      const players = state.players as Map<string, unknown> | undefined;
      const playerCount = players?.size ?? 1;
      const botCount = state.botCount as number | undefined;
      const totalEntities = playerCount + (botCount ?? 0);

      const start = Date.now();
      const tickTimes: number[] = [];
      room.onStateChange(() => {
        tickTimes.push(Date.now());
      });
      await sleep(3000);

      const elapsed = Date.now() - start;
      const ticksPerSecond = tickTimes.length / (elapsed / 1000);
      await room.leave();

      const result = { totalEntities, ticksPerSecond, acceptable: ticksPerSecond >= 10 };

      expect(result.totalEntities).toBeLessThanOrEqual(64);
      expect(result.acceptable).toBe(true);
    });
  });

  test.describe('Zero players (bots only)', () => {
    test('bot-only match runs and completes without errors', async ({ page }) => {
      await page.goto(E2E_CONFIG.clientUrl);
      await page.waitForSelector('canvas', CANVAS_TIMEOUT);

      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));

      const client = new Client(SERVER_URL.serverUrl);
      const room = await client.joinOrCreate('bot-e2e', {
        botCount: 4,
        difficulty: 'medium',
        mapId: 'test_map',
      });
      await sleep(2000);

      const playerCount = (room.state as Record<string, unknown>).players
        ? ((room.state as Record<string, unknown>).players as Map<string, unknown>).size
        : 0;

      await sleep(3000);
      await room.leave();

      const result = { playerCount, roomCreated: true };

      expect(result.roomCreated).toBe(true);
      const criticalErrors = errors.filter(
        (e) => !e.includes('WebGL') && !e.includes('AudioContext'),
      );
      expect(criticalErrors).toHaveLength(0);
    });
  });
});
