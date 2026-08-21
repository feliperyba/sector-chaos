/**
 * Golden refactor-stability baseline for ticket #23.
 *
 * This is the ACTUAL determinism lock for the MapGenerator 2-way extraction
 * (SectorDistributor + MapBorder). The existing "produces deterministic output
 * from same seed" test (tests/map/MapGenerator.test.ts) is an idempotency check
 * — it compares two fresh POST-refactor instances, so a deterministic RNG fork
 * sails through it (both instances shift identically). This golden test instead
 * pins whole-`MapData` output for 4 fixed seeds to PRE-refactor serialized
 * bytes committed as `.json` fixtures. If any extraction step breaks behavior
 * (e.g. SectorDistributor forks an isolated RNG, shifting every downstream
 * draw), the byte-identity assertion here goes RED.
 *
 * Fixtures live in `./__fixtures__/seed-<N>.json` and were generated on `main`
 * (commit c8fc97f) BEFORE the refactor branch started, via the
 * `deepCloneMapData` serializer (JSON.stringify with a Uint8Array -> Array.from
 * replacer). Seeds: {1, 42, 999, 0xdeadbeef} — small seed, test-suite default,
 * large seed, high-bit-pattern seed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MapGenerator } from '../MapGenerator.js';
import type { MapData } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');

/**
 * Serialize a `MapData` to a canonical JSON string, expanding `Uint8Array`
 * rows to plain arrays so the output is JSON-serializable and diffable.
 * Mirrors the serializer used to generate the fixtures (and the one in
 * tests/map/MapGenerator.test.ts:12-14).
 *
 * @param mapData - the generated map to serialize
 * @returns canonical JSON string with Uint8Array rows as plain arrays
 */
function deepCloneMapData(mapData: MapData): string {
  return JSON.stringify(mapData, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
}

/**
 * Load a golden fixture and return it re-stringified, so the comparison is
 * canonical on both sides (parse + restringify tolerates incidental
 * whitespace/formatting differences in the committed fixture).
 *
 * @param filename - fixture filename under `__fixtures__/`
 * @returns the canonical JSON string of the fixture
 */
function loadGolden(filename: string): string {
  const raw = readFileSync(join(fixturesDir, filename), 'utf-8');
  return JSON.stringify(JSON.parse(raw));
}

describe('MapGenerator golden refactor-stability baseline (#23)', () => {
  it('seed 1 produces byte-identical output to pre-refactor golden', () => {
    const map = new MapGenerator().generate(1);
    expect(deepCloneMapData(map)).toBe(loadGolden('seed-1.json'));
  });

  it('seed 42 produces byte-identical output to pre-refactor golden', () => {
    const map = new MapGenerator().generate(42);
    expect(deepCloneMapData(map)).toBe(loadGolden('seed-42.json'));
  });

  it('seed 999 produces byte-identical output to pre-refactor golden', () => {
    const map = new MapGenerator().generate(999);
    expect(deepCloneMapData(map)).toBe(loadGolden('seed-999.json'));
  });

  it('seed 0xdeadbeef produces byte-identical output to pre-refactor golden', () => {
    const map = new MapGenerator().generate(0xdeadbeef);
    expect(deepCloneMapData(map)).toBe(loadGolden('seed-3735928559.json'));
  });
});
