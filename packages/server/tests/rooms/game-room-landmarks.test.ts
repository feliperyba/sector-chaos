import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup, createRoom } from '../helpers/test-server';
import type { GameRoom } from '../../src/room/GameRoom.ts';
import type { LandmarkAssignment } from '@sector-battle/shared';
import { BEACON_INTENSITY_MIN } from '@sector-battle/shared';

/**
 * Map-redesign ticket 04 (DEC-002) — the one-shot `mapData` payload must
 * carry the server-authored landmark assignment (`landmarks`: 4×4 hero
 * landmarks + junction minors) so the client can bake composites, draw
 * minimap icons and read beacon specs WITHOUT deciding any landmark
 * identity client-side. The beacon LIGHTS themselves ride the same
 * payload's `lightPlacements` (appended by the SeedMapAdapter from this
 * assignment). Procedural maps carry them; demo-TMX maps omit them.
 *
 * These tests drive the REAL room through `createRoom` (full onCreate: map
 * generation → SeedMapAdapter → payload stash) and read the payload via the
 * room's `buildMapDataPayload` — the exact object `requestMapData` sends —
 * without the SDK HTTP hop (which is exercised end-to-end by the docker
 * browser pass).
 */
describe('GameRoom mapData payload — landmarks (ticket 04)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  interface LandmarkPayload {
    landmarks?: LandmarkAssignment;
    lightPlacements?: Array<{
      gridX: number;
      gridY: number;
      kind: string;
      color?: readonly [number, number, number];
      radius?: number;
      intensity?: number;
      pulse?: boolean;
    }>;
  }

  /** The exact payload object a `requestMapData` message sends back. */
  function payloadOf(room: Room): LandmarkPayload {
    return (room as unknown as GameRoom).buildMapDataPayload() as LandmarkPayload;
  }

  async function createGameRoom(seed: number, mapType: 'procedural' | 'demo', matchId: string) {
    return createRoom(server, { seed, mapType, botFillTo: 0, matchId });
  }

  it('procedural room payload carries a 4x4 hero grid + 2–3 minors + beacon lights', async () => {
    const room = await createGameRoom(42, 'procedural', 'landmark-probe');
    const payload = payloadOf(room);

    // 4x4 hero grid, every entry a valid landmark with a beacon spec.
    const landmarks = payload.landmarks;
    expect(landmarks).toBeDefined();
    const heroes = landmarks!.heroes;
    expect(heroes).toHaveLength(4);
    const flat = heroes.flat();
    expect(flat).toHaveLength(16);
    for (const hero of flat) {
      expect(hero.compositionId.length).toBeGreaterThan(0);
      expect(hero.beacon.radius).toBeGreaterThanOrEqual(512);
      expect(hero.beacon.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
      expect(hero.beacon.color).toHaveLength(3);
      expect(hero.tileX).toBeGreaterThanOrEqual(0);
      expect(hero.tileX).toBeLessThan(80);
      expect(hero.tileY).toBeGreaterThanOrEqual(0);
      expect(hero.tileY).toBeLessThan(80);
    }
    // Adjacent sectors never share a composition.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const id = heroes[r]![c]!.compositionId;
        if (c > 0) expect(heroes[r]![c - 1]!.compositionId).not.toBe(id);
        if (r > 0) expect(heroes[r - 1]![c]!.compositionId).not.toBe(id);
      }
    }
    // 2–3 minors.
    expect(landmarks!.minors.length).toBeGreaterThanOrEqual(2);
    expect(landmarks!.minors.length).toBeLessThanOrEqual(3);

    // The beacon lights ride lightPlacements: one per hero (pulsing) + one
    // per minor (steady) + one fortress beacon (ticket 06 / DEC-004 — every
    // compound template carries one; pulsing like the heroes).
    const lights = payload.lightPlacements ?? [];
    const beacons = lights.filter((l) => l.kind === 'beacon');
    expect(beacons.length).toBe(16 + 1 + landmarks!.minors.length);
    let pulsing = 0;
    for (const hero of flat) {
      const light = beacons.find((b) => b.gridX === hero.tileX && b.gridY === hero.tileY);
      expect(light, `beacon light at hero anchor (${hero.tileX},${hero.tileY})`).toBeDefined();
      expect(light!.radius).toBe(hero.beacon.radius);
      expect(light!.intensity).toBe(hero.beacon.intensity);
      expect(light!.color).toEqual(hero.beacon.color);
      if (light!.pulse) pulsing++;
    }
    expect(pulsing).toBe(16); // heroes pulse; minors stay steady.
  });

  it('same seed → identical landmark payload + beacon lights (deterministic per seed)', async () => {
    const roomA = await createGameRoom(777, 'procedural', 'landmark-det-a');
    const roomB = await createGameRoom(777, 'procedural', 'landmark-det-b');
    const a = payloadOf(roomA);
    const b = payloadOf(roomB);
    expect(a.landmarks).toEqual(b.landmarks);
    expect(a.lightPlacements).toEqual(b.lightPlacements);
  });

  it('different seed → different landmark payload (identity varies per map)', async () => {
    const roomA = await createGameRoom(777, 'procedural', 'landmark-var-a');
    const roomB = await createGameRoom(778, 'procedural', 'landmark-var-b');
    const [a, b] = [payloadOf(roomA), payloadOf(roomB)];
    expect(JSON.stringify(a.landmarks)).not.toBe(JSON.stringify(b.landmarks));
  });

  it('demo room payload omits landmark fields (no shared generation)', async () => {
    const room = await createGameRoom(42, 'demo', 'demo-landmark-probe');
    const payload = payloadOf(room);
    expect(payload.landmarks).toBeUndefined();
    // The demo map still gets its (TMX-authored) lights — just no beacons.
    expect((payload.lightPlacements ?? []).some((l) => l.kind === 'beacon')).toBe(false);
  });
});
