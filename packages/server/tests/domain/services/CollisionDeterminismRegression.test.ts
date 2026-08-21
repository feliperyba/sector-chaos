/**
 * Determinism regression net for the Seed Path map adapter.
 *
 * Pins one durable invariant: the same seed always produces byte-identical
 * floor + wall `visualLayers` and grid across independent `adapt()` runs.
 * **Tests only — no production code is exercised beyond its public seams.**
 *
 * Note: this file previously also pinned seed-42 fidelity/collision snapshots
 * (open-side collider placement, "no full-tile fallback" on a specific THIN-H
 * cell, "thin-wall face-only is INTENDED", demo four-corners/perimeter look).
 * Those were retired with the Map Cohesion Revamp: the T0–T8 generator rewrite
 * changed seed-42 output, and free-standing isolated/stub walls now render as
 * full-tile object art (full colliders), so the old collision snapshots no
 * longer describe the system. Determinism is the surviving, still-valuable net.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { MapGenerator as SharedMapGenerator, type EnrichedMapData } from '@sector-battle/shared';
import { SeedMapAdapter } from '../../../src/infrastructure/map/SeedMapAdapter.ts';

// Repo root is 5 levels up from this test file (packages/server/tests/domain/services).
const TILED_DIR = resolve(__dirname, '../../../../../tiled');

const SEED = 42;

const WALL_LAYER = 'map_border_walls';
const FLOOR_LAYER = 'floor';

function adaptSeed(seed: number): EnrichedMapData {
  const gen = new SharedMapGenerator();
  return new SeedMapAdapter().adapt(gen.generate(seed), seed, TILED_DIR);
}

describe('determinism', () => {
  it('emits byte-identical floor + wall visualLayers across two independent adapt() runs', () => {
    const a = adaptSeed(SEED);
    const b = adaptSeed(SEED);

    const floorA = a.visualLayers.find((l) => l.name === FLOOR_LAYER)!;
    const floorB = b.visualLayers.find((l) => l.name === FLOOR_LAYER)!;
    const wallA = a.visualLayers.find((l) => l.name === WALL_LAYER)!;
    const wallB = b.visualLayers.find((l) => l.name === WALL_LAYER)!;

    expect(JSON.stringify(floorB.cells)).toBe(JSON.stringify(floorA.cells));
    expect(JSON.stringify(wallB.cells)).toBe(JSON.stringify(wallA.cells));
    // Grid too, for good measure.
    expect(JSON.stringify(b.grid)).toBe(JSON.stringify(a.grid));
  });
});
