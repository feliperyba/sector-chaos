import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup, createRoom, connectClient } from '../helpers/test-server';
import {
  BEACON_INTENSITY_MAX,
  BEACON_RADIUS,
  CITADEL_BEACON_RADIUS,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import { lintValueBand } from '../../src/infrastructure/map/LightingDiscipline.js';

/**
 * Map-redesign ticket 06 (DEC-004) — the one-shot `mapData` payload must
 * carry the server-authored fortress projection (`fortress`: variant,
 * footprint, vault anchor, beacon spec) and the fortress beacon must ride the
 * light placements appended by the SeedMapAdapter, INSIDE the DEC-005 value
 * band (the Citadel vault beacon is the map's strongest static light: at the
 * 2.8 ceiling with a radius beyond every hero beacon). Seed 3 rolls the rare
 * Citadel on the fixed CITD stream — the whole suite is deterministic.
 */
describe('GameRoom mapData payload — fortress + vault beacon (ticket 06)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  interface FortressPayload {
    fortress?: {
      variant: string;
      originRow: number;
      originCol: number;
      size: number;
      vault: { tileX: number; tileY: number } | null;
      beacon: {
        tileX: number;
        tileY: number;
        color: [number, number, number];
        intensity: number;
        radius: number;
      };
    };
    lightPlacements?: LightPlacementTiled[];
    macroPoiNames?: { compound: string | null };
    designation?: string;
  }

  function requestMapData(
    client: Awaited<ReturnType<typeof connectClient>>,
  ): Promise<FortressPayload> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mapData response timed out')), 10_000);
      client.onMessage('mapData', (data) => {
        clearTimeout(timeout);
        resolve(data as FortressPayload);
      });
      client.send('requestMapData');
    });
  }

  it('Citadel seed: payload carries the 14×14 fortress + named Citadel + designation family', async () => {
    const room = await createRoom(server, {
      seed: 3,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'fortress-citadel',
    });
    const client = await connectClient(server, room, { name: 'fortress-probe' });
    const payload = await requestMapData(client);

    const fortress = payload.fortress!;
    expect(fortress).toBeDefined();
    expect(fortress.variant).toBe('CITADEL');
    expect(fortress.size).toBe(14);
    expect(fortress.vault).not.toBeNull();
    // The vault beacon: ceiling intensity, beyond-hero radius, violet color.
    expect(fortress.beacon.intensity).toBe(BEACON_INTENSITY_MAX);
    expect(fortress.beacon.radius).toBe(CITADEL_BEACON_RADIUS);
    expect(fortress.beacon.radius).toBeGreaterThan(BEACON_RADIUS);
    // POI-name integration (DEC-004.1 + DEC-001 fixed vocabulary).
    expect(payload.macroPoiNames!.compound).toBe('The Citadel');
    expect(['CITADEL', 'KEEP']).toContain(payload.designation!.split(' • ')[1]);
  });

  it('Citadel vault beacon rides the light placements as the strongest static light', async () => {
    const room = await createRoom(server, {
      seed: 3,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'fortress-beacon',
    });
    const client = await connectClient(server, room, { name: 'beacon-probe' });
    const payload = await requestMapData(client);
    const placements = payload.lightPlacements!;

    // The fortress beacon is present at the authored anchor with the full spec.
    const fortress = payload.fortress!;
    const beacon = placements.find(
      (p) => p.gridX === fortress.beacon.tileX && p.gridY === fortress.beacon.tileY,
    );
    expect(beacon).toBeDefined();
    expect(beacon!.kind).toBe('beacon');
    expect(beacon!.intensity).toBe(BEACON_INTENSITY_MAX);
    expect(beacon!.radius).toBe(CITADEL_BEACON_RADIUS);

    // DEC-005 value band holds map-wide: no static placement out-values the
    // ceiling (grayscale rule — the data-layer form of the browser check).
    expect(lintValueBand(placements)).toHaveLength(0);
    // And the vault beacon is uniquely the widest light on the map.
    const widest = Math.max(...placements.map((p) => p.radius ?? 0));
    expect(widest).toBe(CITADEL_BEACON_RADIUS);
  });

  it('standard seed: payload carries the fortress beacon at hero radius in the tier band', async () => {
    const room = await createRoom(server, {
      seed: 42,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'fortress-standard',
    });
    const client = await connectClient(server, room, { name: 'std-probe' });
    const payload = await requestMapData(client);

    const fortress = payload.fortress!;
    expect(['CROSS_PARTITION', 'PILLARED_HALL', 'COURTYARD_RING', 'LOOT_ARM', 'CITADEL']).toContain(
      fortress.variant,
    );
    expect(fortress.size).toBe(fortress.variant === 'CITADEL' ? 14 : 10);
    expect(fortress.beacon.radius).toBe(
      fortress.variant === 'CITADEL' ? CITADEL_BEACON_RADIUS : BEACON_RADIUS,
    );
    expect(fortress.beacon.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
    const placements = payload.lightPlacements!;
    expect(
      placements.some(
        (p) => p.gridX === fortress.beacon.tileX && p.gridY === fortress.beacon.tileY,
      ),
    ).toBe(true);
    expect(lintValueBand(placements)).toHaveLength(0);
  });

  it('same seed → identical fortress payload + light placements (deterministic)', async () => {
    const roomA = await createRoom(server, {
      seed: 3,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'fortress-det-a',
    });
    const roomB = await createRoom(server, {
      seed: 3,
      mapType: 'procedural',
      botFillTo: 0,
      matchId: 'fortress-det-b',
    });
    const clientA = await connectClient(server, roomA, { name: 'fdet-a' });
    const clientB = await connectClient(server, roomB, { name: 'fdet-b' });
    const [a, b] = await Promise.all([requestMapData(clientA), requestMapData(clientB)]);
    expect(a.fortress).toEqual(b.fortress);
    expect(JSON.stringify(a.lightPlacements)).toBe(JSON.stringify(b.lightPlacements));
  });

  it('demo room payload omits the fortress (no shared generation)', async () => {
    const room = await createRoom(server, {
      seed: 3,
      mapType: 'demo',
      botFillTo: 0,
      matchId: 'fortress-demo',
    });
    const client = await connectClient(server, room, { name: 'demo-fortress-probe' });
    const payload = await requestMapData(client);
    expect(payload.fortress).toBeUndefined();
  });
});
