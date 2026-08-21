import { describe, expect, it } from 'vitest';
import {
  MapGenerator,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  type GatewayDressing,
} from '@sector-battle/shared';
import { gatewayBandTiles, gatewayBracketTiles } from '../MapRendererIdentity.js';

/**
 * Map-redesign ticket 07 — the gateway lerp-band tile enumeration (the pure
 * geometry half of the client identity bake; the RenderTexture draw itself is
 * a one-line projection of these tiles). Axis correctness matters: an
 * h-connection (horizontal neighbors) crosses the X axis, a v-connection
 * crosses Y — a swapped axis would paint the band in the wrong sector
 * entirely.
 *
 * Map-polish ticket 11 — the gateway bracket-pair mounts (the pure geometry
 * half of the re-aligned sconce-pair bake): one bracket beneath EACH of the
 * two real ticket-10 doorway sconce lights, at the band-end tiles of the
 * opening — the same perpendicular geometry the server derives for the light
 * pair (`LightPlacerDoorway.doorwayPairGeometry`), asserted here as data
 * (no browser, no screenshot).
 */

const hGateway: GatewayDressing = {
  sectorA: { row: 0, col: 0 },
  sectorB: { row: 0, col: 1 },
  axis: 'h',
  midX: 1 * SECTOR_TILE_SIZE - 0.5, // seam between cols 0 and 1
  midY: 0 * SECTOR_TILE_SIZE + 10, // opening center row
  tintA: 0x3e4a5c,
  tintB: 0x46523a,
  heroA: null,
  heroB: null,
  alignedA: false,
  alignedB: false,
};

const vGateway: GatewayDressing = {
  sectorA: { row: 1, col: 2 },
  sectorB: { row: 2, col: 2 },
  axis: 'v',
  midX: 2 * SECTOR_TILE_SIZE + 10,
  midY: 2 * SECTOR_TILE_SIZE - 0.5, // seam between rows 1 and 2
  tintA: 0x453f52,
  tintB: 0x5a4a2e,
  heroA: null,
  heroB: null,
  alignedA: false,
  alignedB: false,
};

describe('gatewayBandTiles (ticket 07 lerp-band geometry)', () => {
  it('h-connection band crosses X at the seam and spans the opening on Y', () => {
    const tiles = gatewayBandTiles(hGateway);
    expect(tiles).toHaveLength(5 * 5); // depth 2+2+1 × width 5
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    // Crossing axis (X): 2 tiles into sector A (…,19) + seam + 2 into B (20,21).
    expect([...xs].sort((a, b) => a - b)).toEqual([17, 18, 19, 20, 21]);
    // Width axis (Y): the 3-tile opening (9..11 local) + one shoulder/side.
    expect([...ys].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
    // Lerp parameter monotone along the crossing axis, strictly inside (0,1).
    const row = tiles.filter((t) => t.y === 10).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) expect(row[i]!.t).toBeGreaterThan(row[i - 1]!.t);
    for (const t of row) {
      expect(t.t).toBeGreaterThan(0);
      expect(t.t).toBeLessThan(1);
    }
    // Falloff peaks on the opening centerline and fades at the shoulders.
    expect(row[2]!.falloff).toBeCloseTo(1, 6);
    expect(tiles.find((t) => t.x === 19 && t.y === 8)!.falloff).toBeCloseTo(1 / 3, 6);
  });

  it('v-connection band crosses Y at the seam (axis-symmetric)', () => {
    const tiles = gatewayBandTiles(vGateway);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    // Crossing axis for a v-connection is Y: rows 37..41 around the seam 39.5.
    expect([...ys].sort((a, b) => a - b)).toEqual([37, 38, 39, 40, 41]);
    // Width axis is X: the opening + shoulders around local col 10 (48..52).
    expect([...xs].sort((a, b) => a - b)).toEqual([48, 49, 50, 51, 52]);
  });

  it('every gateway of a generated map yields in-bounds tiles', () => {
    const map = new MapGenerator().generate(42);
    const size = 4 * SECTOR_TILE_SIZE;
    for (const gw of map.identity.gateways) {
      const tiles = gatewayBandTiles(gw);
      expect(tiles).toHaveLength(25);
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(size);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThan(size);
        expect(t.falloff).toBeGreaterThan(0);
      }
    }
  });
});

describe('gatewayBracketTiles (ticket 11 bracket-mount geometry)', () => {
  /** The bake draws each mount at its tile CENTER — tile units for asserting. */
  const drawPos = (t: { x: number; y: number }) => ({ x: t.x + 0.5, y: t.y + 0.5 });
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  /** The arch draws at the seam center: (midX + 0.5, midY + 0.5) tile units. */
  const archPos = (gw: GatewayDressing) => ({ x: gw.midX + 0.5, y: gw.midY + 0.5 });

  it('h-connection brackets mount beneath both band-end sconce tiles', () => {
    const [a, b] = gatewayBracketTiles(hGateway);
    // Expected band ends (server doorwayPairGeometry over SectorConnector's
    // offsets[0..2] = local rows 9..11 on A's border col): (19, 9) and (19, 11).
    const expected = [
      { x: 19, y: 9 },
      { x: 19, y: 11 },
    ];
    expect([a, b]).toEqual(expected);
    for (const [mount, bandEnd] of [
      [drawPos(a), drawPos(expected[0]!)],
      [drawPos(b), drawPos(expected[1]!)],
    ] as const) {
      // Within half a tile of the expected band-end tile center.
      expect(dist(mount, bandEnd)).toBeLessThanOrEqual(0.5);
    }
    // Symmetric about the aperture axis (the centerline row midY = 10).
    expect(a.x).toBe(b.x);
    expect((a.y + b.y) / 2).toBe(hGateway.midY);
    expect(Math.abs(a.y - hGateway.midY)).toBe(Math.abs(b.y - hGateway.midY));
    // Distinct from the arch position (the seam center) — well beyond it.
    for (const mount of [drawPos(a), drawPos(b)]) {
      expect(dist(mount, archPos(hGateway))).toBeGreaterThanOrEqual(1);
    }
  });

  it('v-connection brackets mount beneath both band-end sconce tiles', () => {
    const [a, b] = gatewayBracketTiles(vGateway);
    // Expected band ends: A's border row 39 (sector row 1), local cols 9/11
    // → global cols 49 and 51.
    const expected = [
      { x: 49, y: 39 },
      { x: 51, y: 39 },
    ];
    expect([a, b]).toEqual(expected);
    for (const [mount, bandEnd] of [
      [drawPos(a), drawPos(expected[0]!)],
      [drawPos(b), drawPos(expected[1]!)],
    ] as const) {
      expect(dist(mount, bandEnd)).toBeLessThanOrEqual(0.5);
    }
    // Symmetric about the aperture axis (the centerline col midX = 50).
    expect(a.y).toBe(b.y);
    expect((a.x + b.x) / 2).toBe(vGateway.midX);
    expect(Math.abs(a.x - vGateway.midX)).toBe(Math.abs(b.x - vGateway.midX));
    for (const mount of [drawPos(a), drawPos(b)]) {
      expect(dist(mount, archPos(vGateway))).toBeGreaterThanOrEqual(1);
    }
  });

  it('every gateway of a generated map mirrors the server band-end derivation', () => {
    const map = new MapGenerator().generate(42);
    const size = 4 * SECTOR_TILE_SIZE;
    // The server rule (LightPlacerDoorway.doorwayPairGeometry), replicated
    // from the CONNECTION record — a drift guard: the client mounts must be
    // exactly the band ends the server derives for the sconce pair.
    for (let i = 0; i < map.connections.length; i++) {
      const conn = map.connections[i]!;
      const gw = map.identity.gateways[i]!;
      const isH = conn.sectorA.row === conn.sectorB.row;
      const baseRow = Math.floor(conn.positionA.y / TILE_PIXEL_SIZE);
      const baseCol = Math.floor(conn.positionA.x / TILE_PIXEL_SIZE);
      const center = (conn.width - 1) / 2;
      const expected = isH
        ? [
            { x: baseCol, y: baseRow + center - 1 },
            { x: baseCol, y: baseRow + center + 1 },
          ]
        : [
            { x: baseCol + center - 1, y: baseRow },
            { x: baseCol + center + 1, y: baseRow },
          ];
      expect(gatewayBracketTiles(gw)).toEqual(expected);
      // Threshold face: both mounts on sector A's border tile (local 19).
      const faceCoord = (m: { x: number; y: number }) => (isH ? m.x : m.y) % SECTOR_TILE_SIZE;
      for (const m of gatewayBracketTiles(gw)) {
        expect(Number.isInteger(m.x)).toBe(true);
        expect(Number.isInteger(m.y)).toBe(true);
        expect(m.x).toBeGreaterThanOrEqual(0);
        expect(m.x).toBeLessThan(size);
        expect(m.y).toBeGreaterThanOrEqual(0);
        expect(m.y).toBeLessThan(size);
        expect(faceCoord(m)).toBe(SECTOR_TILE_SIZE - 1);
      }
    }
  });
});
