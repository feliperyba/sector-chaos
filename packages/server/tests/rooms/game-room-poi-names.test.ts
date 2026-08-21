import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup, createRoom, connectClient } from '../helpers/test-server';

/**
 * Map-redesign ticket 03 (DEC-001 + DEC-010) — the one-shot `mapData`
 * payload must carry the server-authored POI names (`poiNames`,
 * `macroPoiNames`) + map designation (`designation`) so the client can
 * render minimap labels, the enter-banner, kill-feed location tags and the
 * match-start/results designation WITHOUT generating any text client-side.
 * Procedural maps carry them; demo-TMX maps (no shared generation) omit them.
 */
describe('GameRoom mapData payload — POI names + designation (ticket 03)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  interface NamingPayload {
    poiNames?: string[][];
    macroPoiNames?: {
      highway: string | null;
      compound: string | null;
      barrierRidge: string | null;
      openCommons: string | null;
    };
    designation?: string;
  }

  function requestMapData(
    client: Awaited<ReturnType<typeof connectClient>>,
  ): Promise<NamingPayload> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mapData response timed out')), 10_000);
      client.onMessage('mapData', (data) => {
        clearTimeout(timeout);
        resolve(data as NamingPayload);
      });
      client.send('requestMapData');
    });
  }

  it('procedural room payload carries unique poiNames + macroPoiNames + designation', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'name-probe' });
    const payload = await requestMapData(client);

    // 4x4 sector names, unique within the map, non-empty.
    expect(payload.poiNames).toBeDefined();
    expect(payload.poiNames).toHaveLength(4);
    const all: string[] = [];
    for (const row of payload.poiNames!) {
      expect(row).toHaveLength(4);
      for (const name of row) {
        expect(name.length).toBeGreaterThan(0);
        all.push(name);
      }
    }
    expect(new Set(all).size).toBe(16);

    // Macro names: highway + compound always present; at most one flavor feature.
    expect(payload.macroPoiNames).toBeDefined();
    const macro = payload.macroPoiNames!;
    expect(macro.highway).toMatch(/^The /);
    expect(macro.compound).toMatch(/^The /);
    expect(macro.barrierRidge === null || macro.openCommons === null).toBe(true);
    for (const name of [macro.highway, macro.compound, macro.barrierRidge, macro.openCommons]) {
      if (name !== null) {
        expect(all).not.toContain(name);
        all.push(name);
      }
    }
    expect(new Set(all).size).toBe(all.length);

    // Designation: SHAPE • FAMILY • seedTag.
    expect(payload.designation).toMatch(/^[A-Z]+ • [A-Z]+ • [0-9A-Z]{2,3}$/);
  });

  it('same seed → identical naming payload (deterministic per seed)', async () => {
    const roomA = await createRoom(server, {
      seed: 777,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'name-det-a',
    });
    const roomB = await createRoom(server, {
      seed: 777,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'name-det-b',
    });
    const clientA = await connectClient(server, roomA, { name: 'det-a' });
    const clientB = await connectClient(server, roomB, { name: 'det-b' });
    const [a, b] = await Promise.all([requestMapData(clientA), requestMapData(clientB)]);
    expect(a.poiNames).toEqual(b.poiNames);
    expect(a.macroPoiNames).toEqual(b.macroPoiNames);
    expect(a.designation).toBe(b.designation);
  });

  it('different seed → different naming payload (identity varies per map)', async () => {
    const roomA = await createRoom(server, {
      seed: 777,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'name-var-a',
    });
    const roomB = await createRoom(server, {
      seed: 778,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'name-var-b',
    });
    const clientA = await connectClient(server, roomA, { name: 'var-a' });
    const clientB = await connectClient(server, roomB, { name: 'var-b' });
    const [a, b] = await Promise.all([requestMapData(clientA), requestMapData(clientB)]);
    expect(JSON.stringify(a.poiNames)).not.toBe(JSON.stringify(b.poiNames));
  });

  it('demo room payload omits naming fields (no shared generation)', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'demo', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'demo-name-probe' });
    const payload = await requestMapData(client);
    expect(payload.poiNames).toBeUndefined();
    expect(payload.macroPoiNames).toBeUndefined();
    expect(payload.designation).toBeUndefined();
  });
});
