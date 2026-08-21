import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { ASSIGNABLE_COLOR_INDICES } from '@sector-battle/shared';
import { createTestServer } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server?.cleanup();
});

/**
 * Players are assigned a skin color round-robin over ASSIGNABLE_COLOR_INDICES
 * (which excludes `blue`/index 4 until its hand art is fixed). See
 * docs/wayfinder/player-art-and-skins.md.
 */
describe('Player color assignment (round-robin, excl. blue)', () => {
  it('assigns each joining player the next assignable color in order', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'color-order' });

    const clients = [];
    for (let i = 0; i < ASSIGNABLE_COLOR_INDICES.length; i++) {
      clients.push(await helper.addPlayer(`P${i}`));
    }

    clients.forEach((c, i) => {
      const player = helper.getPlayer(c);
      expect(player).toBeDefined();
      // join order maps 1:1 onto ASSIGNABLE_COLOR_INDICES (round-robin, no blue)
      expect(player!.color).toBe(ASSIGNABLE_COLOR_INDICES[i]);
    });
  });

  it('never assigns the blue color index (4)', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'no-blue' });

    // Add more than the 7 assignable colors to also exercise the wrap-around.
    const clients = [];
    for (let i = 0; i < 14; i++) {
      clients.push(await helper.addPlayer(`P${i}`));
    }

    for (const c of clients) {
      const player = helper.getPlayer(c);
      expect(player).toBeDefined();
      expect(player!.color).not.toBe(4); // blue excluded
      // and it must be a valid assignable index
      expect(ASSIGNABLE_COLOR_INDICES).toContain(player!.color);
    }
  });

  it('wraps around after exhausting the assignable colors', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'color-wrap' });

    // Add exactly one full cycle (7) plus one more to exercise the wrap.
    const clients = [];
    for (let i = 0; i <= ASSIGNABLE_COLOR_INDICES.length; i++) {
      clients.push(await helper.addPlayer(`P${i}`));
    }

    const first = helper.getPlayer(clients[0])!;
    const afterCycle = helper.getPlayer(clients[ASSIGNABLE_COLOR_INDICES.length])!;
    // The player after a full cycle should reuse the first assignable color.
    expect(first.color).toBe(ASSIGNABLE_COLOR_INDICES[0]);
    expect(afterCycle.color).toBe(ASSIGNABLE_COLOR_INDICES[0]);
  });
});
