import type {
  DebugStateSnapshot,
  ConnectRoomOptions,
} from '../../packages/client-v3/src/debug/types.js';
import { expect } from '@playwright/test';

export interface GameTestFixtureOptions {
  page: any;
  serverUrl?: string;
}

export class GameTestFixture {
  private page: any;
  private serverUrl: string;
  private connected = false;
  private connectedAt = 0;

  constructor(options: GameTestFixtureOptions) {
    this.page = options.page;
    this.serverUrl = options.serverUrl || 'http://localhost:2567';
  }

  async start(): Promise<void> {
    await this.page.goto('http://localhost:5174');
    await this.waitForMainScene();
  }

  async stop(): Promise<void> {
    await this.page.close();
  }

  async connectToRoom(options: ConnectRoomOptions): Promise<void> {
    await this.page.evaluate((opts) => {
      window.__SECTO_DEBUG__.connectToRoom(opts);
    }, options);
    this.connected = true;
    this.connectedAt = Date.now();
  }

  async waitForConnection(timeout = 10000): Promise<void> {
    await this.waitForState((state) => state.connected, timeout, 'Connection timeout');
  }

  async getState(): Promise<DebugStateSnapshot> {
    return this.page.evaluate(() => {
      const state = window.__SECTO_DEBUG__.getState();
      return JSON.parse(JSON.stringify(state));
    });
  }

  async waitForState(
    predicate: (state: DebugStateSnapshot) => boolean,
    timeout = 5000,
    timeoutMessage?: string,
  ): Promise<DebugStateSnapshot> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const state = await this.getState();
      if (predicate(state)) {
        return state;
      }
      await this.page.waitForTimeout(50);
    }

    const finalState = await this.getState();
    const errorMsg = timeoutMessage || `State predicate not satisfied within ${timeout}ms`;
    throw new Error(`${errorMsg}\nFinal state: ${JSON.stringify(finalState, null, 2)}`);
  }

  async waitForMapLoad(timeout = 15000): Promise<void> {
    await this.waitForState((state) => state.mapLoaded, timeout, 'Map load timeout');
  }

  async waitForGameStart(timeout = 10000): Promise<void> {
    await this.waitForState((state) => state.gameActive, timeout, 'Game start timeout');
  }

  async move(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    const movementMap = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const { x, y } = movementMap[direction];
    await this.page.evaluate(
      ({ x, y }) => {
        window.__SECTO_DEBUG__.runtime.move(x, y, 0);
      },
      { x, y },
    );
  }

  async moveContinuous(
    direction: 'up' | 'down' | 'left' | 'right',
    durationMs: number,
  ): Promise<void> {
    const movementMap = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const { x, y } = movementMap[direction];
    await this.page.evaluate(
      ({ x, y, durationMs }) => {
        window.__SECTO_DEBUG__.runtime.moveContinuous(x, y, 0, durationMs);
      },
      { x, y, durationMs },
    );
  }

  async attack(aimAngle = 0): Promise<void> {
    await this.page.evaluate((aimAngle) => {
      window.__SECTO_DEBUG__.runtime.attack(aimAngle);
    }, aimAngle);
  }

  async pickup(targetId?: string): Promise<void> {
    await this.page.evaluate((targetId) => {
      window.__SECTO_DEBUG__.runtime.pickup(targetId);
    }, targetId);
  }

  async dash(aimAngle = 0): Promise<void> {
    await this.page.evaluate((aimAngle) => {
      window.__SECTO_DEBUG__.runtime.dash(aimAngle);
    }, aimAngle);
  }

  async goToGame(mapType: 'demo' | 'seeded' = 'demo'): Promise<void> {
    await this.page.evaluate((mapType) => {
      window.__SECTO_DEBUG__.goToGame(mapType);
    }, mapType);
  }

  async getTelemetrySnapshot(): Promise<Record<string, unknown>> {
    return this.page.evaluate(() => {
      return JSON.parse(JSON.stringify(window.__SECTO_DEBUG__.telemetry.snapshot()));
    });
  }

  async getReconciliationLog(count?: number): Promise<Record<string, unknown>[]> {
    return this.page.evaluate((count) => {
      return JSON.parse(JSON.stringify(window.__SECTO_DEBUG__.getReconciliationLog(count)));
    }, count);
  }

  async getSpriteState(playerId: string): Promise<Record<string, unknown> | null> {
    return this.page.evaluate((playerId) => {
      const state = window.__SECTO_DEBUG__.getSpriteState(playerId);
      return state ? JSON.parse(JSON.stringify(state)) : null;
    }, playerId);
  }

  async getPredictionEntries(fromSeq: number, toSeq: number): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(
      ({ fromSeq, toSeq }) => {
        return JSON.parse(
          JSON.stringify(window.__SECTO_DEBUG__.getPredictionEntries(fromSeq, toSeq)),
        );
      },
      { fromSeq, toSeq },
    );
  }

  async assertPlayerMoved(
    initialPos: { x: number; y: number },
    expectedDistance: number,
    tolerance = 50,
  ): Promise<void> {
    const state = await this.getState();
    const distance = Math.sqrt(
      Math.pow(state.localPos.x - initialPos.x, 2) + Math.pow(state.localPos.y - initialPos.y, 2),
    );

    expect(distance).toBeGreaterThanOrEqual(expectedDistance - tolerance);
    expect(distance).toBeLessThanOrEqual(expectedDistance + tolerance);
  }

  async assertPlayerHealth(expected: number, tolerance = 0): Promise<void> {
    const state = await this.getState();
    const player = state.players.find((p) => p.id === state.myId);

    if (!player) {
      throw new Error('Player not found in state');
    }

    expect(Math.abs(player.health - expected)).toBeLessThanOrEqual(tolerance);
  }

  async assertPlayerCount(expected: number): Promise<void> {
    const state = await this.getState();
    expect(state.players.filter((p) => p.connected).length).toBe(expected);
  }

  async assertWeaponPickups(expected: number): Promise<void> {
    const state = await this.getState();
    expect(state.weaponPickups.length).toBe(expected);
  }

  async assertTickProgression(initialTick: number, expectedTicks: number): Promise<void> {
    await this.waitForState(
      (state) => state.tick >= initialTick + expectedTicks,
      10000,
      `Tick progression timeout: expected ${expectedTicks} ticks from ${initialTick}`,
    );
  }

  private async waitForMainScene(): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const d = (window as any).__SECTO_DEBUG__;
        if (!d) return false;
        const sceneKey = typeof d.scene === 'function' ? d.scene() : d.scene_?.scene?.key;
        return sceneKey === 'MainScene';
      },
      { timeout: 5000 },
    );
  }
}
