import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup, createRoom, connectClient } from '../helpers/test-server';
import {
  SECTOR_TILE_SIZE,
  type LightPlacementTiled,
  type SectorType,
  type VisualIdentityAssignment,
} from '@sector-battle/shared';

/**
 * Map-redesign ticket 07 (DEC-006) — the one-shot `mapData` payload must
 * carry the server-authored visual identity (`sectorTypes` — the key for the
 * client's identity-sheet wall tints — and `identity` — floor tint fields +
 * gateway dressing) so the client bakes the district visuals WITHOUT
 * deciding any identity client-side. Procedural maps carry them; demo-TMX
 * maps (no shared generation) omit them.
 *
 * Also pins the gateway sconce-pair budget integration: the pair's LIT
 * member is the existing ticket-05 doorway sconce light (one per corridor
 * aperture, count unchanged — the same-or-lower light budget discipline
 * holds by construction because the light placements are byte-identical to
 * the ticket-05 golden fixtures); the second member is the visual-only
 * bracket baked client-side from `identity.gateways`.
 */
describe('GameRoom mapData payload — visual identity (ticket 07)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  interface IdentityPayload {
    sectorTypes?: SectorType[][];
    identity?: VisualIdentityAssignment;
    lightPlacements?: LightPlacementTiled[];
  }

  function requestMapData(
    client: Awaited<ReturnType<typeof connectClient>>,
  ): Promise<IdentityPayload> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mapData response timed out')), 10_000);
      client.onMessage('mapData', (data) => {
        clearTimeout(timeout);
        resolve(data as IdentityPayload);
      });
      client.send('requestMapData');
    });
  }

  it('procedural room payload carries sectorTypes + identity (fields + gateways)', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'identity-probe' });
    const payload = await requestMapData(client);

    // sectorTypes: 4×4 grid of valid sector types.
    expect(payload.sectorTypes).toBeDefined();
    expect(payload.sectorTypes).toHaveLength(4);
    const validTypes = new Set(['GRID_ARENA', 'OPEN_ARENA', 'MAZE', 'RESOURCE_RICH']);
    for (const row of payload.sectorTypes!) {
      expect(row).toHaveLength(4);
      for (const type of row) expect(validTypes.has(type)).toBe(true);
    }

    // identity: 4×4 field cells (2–3 fields each) + one gateway per connection.
    expect(payload.identity).toBeDefined();
    expect(payload.identity!.fields).toHaveLength(4);
    for (const row of payload.identity!.fields) {
      expect(row).toHaveLength(4);
      for (const fields of row) {
        expect(fields.length).toBeGreaterThanOrEqual(2);
        expect(fields.length).toBeLessThanOrEqual(3);
      }
    }
    // 4×4 grid of orthogonal neighbors ⇒ 24 corridor openings.
    expect(payload.identity!.gateways).toHaveLength(24);

    client.leave();
    await room.dispose?.();
  });

  it('same seed → identical identity payload; different seed → varied fields', async () => {
    const roomA = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const clientA = await connectClient(server, roomA, { name: 'det-a' });
    const payloadA = JSON.stringify((await requestMapData(clientA)).identity);

    const roomB = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const clientB = await connectClient(server, roomB, { name: 'det-b' });
    const payloadB = JSON.stringify((await requestMapData(clientB)).identity);

    const roomC = await createRoom(server, { seed: 43, mapType: 'procedural', botFillTo: 0 });
    const clientC = await connectClient(server, roomC, { name: 'det-c' });
    const payloadC = JSON.stringify((await requestMapData(clientC)).identity);

    expect(payloadA).toBe(payloadB);
    expect(payloadA).not.toBe(payloadC);

    for (const c of [clientA, clientB, clientC]) c.leave();
  });

  it('demo-TMX room payload omits sectorTypes + identity (client falls back)', async () => {
    const room = await createRoom(server, { mapType: 'demo', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'demo-probe' });
    const payload = await requestMapData(client);

    expect(payload.sectorTypes).toBeUndefined();
    expect(payload.identity).toBeUndefined();

    client.leave();
    await room.dispose?.();
  });

  it('every corridor aperture carries the LIT member of its sconce pair (budget-safe)', async () => {
    // The gateway sconce pair: the lit member is the ticket-05 doorway sconce
    // (one per aperture — count unchanged ⇒ same-or-lower totals by
    // construction; the byte-identity of the whole placement list vs the
    // ticket-05 golden fixtures is pinned separately in
    // LightPlacementsGolden.test.ts). Here: every aperture has that sconce
    // within its threshold box.
    const room = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'pair-probe' });
    const payload = await requestMapData(client);
    const sconceKinds = new Set(['torch', 'candle', 'brazier', 'fireplace', 'lantern']);
    const sconces = (payload.lightPlacements ?? []).filter(
      (p) => sconceKinds.has(p.kind) && !(p.kind === 'brazier' && p.intensity === 1.7), // POI pools excluded
    );
    expect(sconces.length).toBeGreaterThan(0);

    for (const gw of payload.identity!.gateways!) {
      // The lit member sits within Chebyshev 2 of the aperture midpoint (the
      // Anchor B threshold box — the same contract the LightHierarchy suite
      // pins for ticket 05).
      const near = sconces.some((p) => {
        // Gateway midpoints may sit at x.5 on the seam; compare against both
        // floor and ceil of the midpoint tile.
        for (const mx of [Math.floor(gw.midX), Math.ceil(gw.midX)]) {
          for (const my of [Math.floor(gw.midY), Math.ceil(gw.midY)]) {
            if (Math.max(Math.abs(p.gridX - mx), Math.abs(p.gridY - my)) <= 2) return true;
          }
        }
        return false;
      });
      expect(
        near,
        `gateway ${gw.sectorA.row},${gw.sectorA.col}↔${gw.sectorB.row},${gw.sectorB.col}`,
      ).toBe(true);
    }

    client.leave();
    await room.dispose?.();
  });

  it('gateway alignment data keys off hero landmarks (entering-shot, where allowed)', async () => {
    const room = await createRoom(server, { seed: 42, mapType: 'procedural', botFillTo: 0 });
    const client = await connectClient(server, room, { name: 'align-probe' });
    const payload = await requestMapData(client);

    // Every gateway carries hero anchors + explicit alignment flags — the
    // client composes the entering-shot accent ONLY from these (no client
    // geometry decisions). Some gateways align across a map, not all
    // ("where the seed allows").
    let aligned = 0;
    for (const gw of payload.identity!.gateways!) {
      expect(gw.heroA).not.toBeNull();
      expect(gw.heroB).not.toBeNull();
      expect(typeof gw.alignedA).toBe('boolean');
      expect(typeof gw.alignedB).toBe('boolean');
      // Hero anchors are global tiles within the map (4×4 sectors of 20).
      for (const hero of [gw.heroA!, gw.heroB!]) {
        expect(hero.x).toBeGreaterThanOrEqual(0);
        expect(hero.x).toBeLessThan(4 * SECTOR_TILE_SIZE);
        expect(hero.y).toBeGreaterThanOrEqual(0);
        expect(hero.y).toBeLessThan(4 * SECTOR_TILE_SIZE);
      }
      if (gw.alignedA) aligned++;
      if (gw.alignedB) aligned++;
    }
    expect(aligned).toBeGreaterThan(0);
    expect(aligned).toBeLessThan(payload.identity!.gateways!.length * 2);

    client.leave();
    await room.dispose?.();
  });
});
