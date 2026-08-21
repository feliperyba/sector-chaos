import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup, createRoom, connectClient } from '../helpers/test-server';

/**
 * Map-redesign ticket 02 — the one-shot `mapData` payload must carry the
 * server-authored loot-tier pyramid (`sectorTiers`) + per-match hot sector
 * (`hotSector`) so the client minimap can tint sectors and mark the hot
 * sector at match start. Procedural maps carry them; demo-TMX maps (no
 * shared generation) omit them.
 */
describe('GameRoom mapData payload — sector tiers + hot sector (ticket 02)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  function requestMapData(client: Awaited<ReturnType<typeof connectClient>>): Promise<{
    sectorTiers?: string[][];
    hotSector?: { row: number; col: number };
  }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mapData response timed out')), 10_000);
      client.onMessage('mapData', (data) => {
        clearTimeout(timeout);
        resolve(data as { sectorTiers?: string[][]; hotSector?: { row: number; col: number } });
      });
      client.send('requestMapData');
    });
  }

  it('procedural room payload carries sectorTiers + hotSector', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'tier-probe' });
    const payload = await requestMapData(client);

    expect(payload.sectorTiers).toBeDefined();
    expect(payload.sectorTiers).toHaveLength(4);
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const row of payload.sectorTiers!) {
      expect(row).toHaveLength(4);
      for (const tier of row) {
        expect(['HOT', 'WARM', 'COLD']).toContain(tier);
        if (tier === 'HOT') hot++;
        else if (tier === 'WARM') warm++;
        else cold++;
      }
    }
    // Pyramid: HOT 2-3, WARM 8-9, COLD 5 (±1 tolerance for the sweep gate).
    expect(hot).toBeGreaterThanOrEqual(2);
    expect(hot).toBeLessThanOrEqual(3);
    expect(warm).toBeGreaterThanOrEqual(7);
    expect(warm).toBeLessThanOrEqual(9);
    expect(cold).toBeGreaterThanOrEqual(4);
    expect(cold).toBeLessThanOrEqual(6);

    expect(payload.hotSector).toBeDefined();
    const hotSector = payload.hotSector!;
    // Hot sector is a non-central (outer) sector whose base tier is WARM.
    const isOuter =
      hotSector.row === 0 || hotSector.row === 3 || hotSector.col === 0 || hotSector.col === 3;
    expect(isOuter).toBe(true);
    expect(payload.sectorTiers![hotSector.row]![hotSector.col]).toBe('WARM');
  });

  it('same seed → identical tier payload (deterministic per seed)', async () => {
    const roomA = await createRoom(server, {
      seed: 4242,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'tier-det-a',
    });
    const roomB = await createRoom(server, {
      seed: 4242,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'tier-det-b',
    });
    const clientA = await connectClient(server, roomA, { name: 'det-a' });
    const clientB = await connectClient(server, roomB, { name: 'det-b' });
    const [a, b] = await Promise.all([requestMapData(clientA), requestMapData(clientB)]);
    expect(a.sectorTiers).toEqual(b.sectorTiers);
    expect(a.hotSector).toEqual(b.hotSector);
  });

  it('demo room payload omits tier fields (no shared generation)', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'demo', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'demo-probe' });
    const payload = await requestMapData(client);
    expect(payload.sectorTiers).toBeUndefined();
    expect(payload.hotSector).toBeUndefined();
  });
});
