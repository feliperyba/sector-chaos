import { MapGenerator } from '../../src/map/MapGenerator.js';
import {
  PIPELINE_VERSION,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
} from '../../src/map/constants.js';
import { MapValidator } from '../../src/map/MapValidator.js';
import { getSectorRing } from '../../src/map/gridUtils.js';
import { SectorType } from '../../src/map/types.js';

function deepCloneMapData(mapData: ReturnType<MapGenerator['generate']>): string {
  return JSON.stringify(mapData, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
}

describe('MapGenerator', () => {
  it('PIPELINE_VERSION is defined', () => {
    // v4 (map-polish ticket 01): beacon moody retune — hero radius 576→512,
    // Citadel 640→576, tier intensity band [2.6,2.8]→[2.45,2.6]. Zero RNG
    // draws moved (ADR 0035) — placements identical, only the beacon
    // intensity/radius values differ; goldens re-pinned those fields only.
    // v5 (map-polish ticket 05) + v6 (map-polish ticket 07 — the per-placement
    // `anchor` provenance field on LightPlacementTiled, re-pinning the lights
    // goldens with the anchor key only). Map-polish ticket 09 repaired this
    // stale pin (still 4 after ticket 07's 5→6 bumps).
    // v7 (map-polish ticket 14 — wall composition gate): the zero-RNG
    // WallCompositionPass clears unsanctioned orphan wall stubs / converts
    // orphaned destructible walls to crates; tile rows change on seeds that
    // carried orphans, goldens re-pinned through the sanctioned cascade.
    // v8 (map-polish round-2 ticket 16 — plaza archetype grammar): the
    // 16 plaza layouts collapse into 4 archetypes + a shared crate-pair
    // vocabulary (zero RNG); only plaza tile rows differ + the ticket-05
    // sanctioned cascade, goldens re-pinned.
    // v9 (map-polish round-3 ticket 24 — the beacon keep): the 4-archetype
    // grammar is replaced by ONE authored structure (W/E 5-tile side runs +
    // a 3-tile N bar behind the beacon = a ∩-shaped ruined keep, open south,
    // ≤2 symmetric props at (±1,3) flanking the approach; zero RNG); only
    // plaza tile rows differ + the ticket-05 sanctioned cascade, goldens
    // re-pinned. landmarkPlaza + landmarkPlazaArchetypes merge into one file.
    // v10 (map-polish round-3 ticket 25 — prefab library + smart reuse): the
    // refinement scatter passes are replaced by the deterministic prefab
    // placement pass (10-prefab library, isolated 'PREF' salted stream, art-
    // aware run/corner encoding, paint-gate/conflict-clip/2×2/never-seal
    // guards); stamped-prefab tile rows + the sanctioned cascade, goldens
    // re-pinned.
    // v11 (map-polish round-3 ticket 26 — sector floor cohesion): every sprite
    // inside a sector floor is confined to one value/hue family per type
    // (MAZE `water` dropped, RICH gray-stone accents → transparent `plants`,
    // patterned stone full-tiles moved from random scatter into a pure-hash
    // in-family floor band — GRID 6% / MAZE 8% `tiles_cracked` — and in-family
    // plaza accents); ZERO main-stream RNG draws and MapGenerator untouched ⇒
    // goldens re-pinned byte-identical (verified no-op).
    // v12 (map-polish round-3 ticket 28 — interior structure organization):
    // the skeleton per-cell scatter fill passes (lattice/edge/staggered/
    // diagonal) are removed and the prefab placement pass is promoted to the
    // primary interior composer (mostly-open ≥18/25 window, caps 5/5/3/5);
    // the fill rolls' removal shifts the per-sector sub-block/mirror phases
    // (sanctioned cascade — see the v12 changelog in constants.ts), goldens
    // re-pinned.
    // v13 (map-polish round-4 ticket 29 — beacon plaza over the grid layers):
    // the client composite dressing bake + `MINOR_LANDMARK_PROPS`/
    // `MinorLandmark.propId` are removed; the LNDM-stream TAIL draw (the
    // per-minor prop pick) goes with them — every earlier draw is
    // byte-identical, so the goldens differ ONLY in `landmarks.minors[*]`
    // losing `propId` (see the v13 changelog in constants.ts), re-pinned.
    // v14 (round-5e border-buffer re-clean + thin-run mirror facing), v15
    // (round-6 breach panels + prefab enrichment), v16 (round-7 cohesion —
    // structure-backed chests, framing-first prefab scan, ±2 stamp spacing)
    // and v17 (round-8 run-join guard — stamps never create a 3-cardinal
    // wall junction) each shifted the grid through the sanctioned cascade;
    // see the changelog in constants.ts. (This pin was stale at v13 through
    // the v14-v16 rounds — repaired with v17.)
    expect(PIPELINE_VERSION).toBe(17);
  });

  it('exports correct constants', () => {
    expect(SECTOR_GRID_SIZE).toBe(4);
    expect(SECTOR_TILE_SIZE).toBe(20);
    expect(TILE_PIXEL_SIZE).toBe(128);
  });

  it('produces deterministic output from same seed', () => {
    const gen = new MapGenerator();
    const a = gen.generate(42);
    const gen2 = new MapGenerator();
    const b = gen2.generate(42);
    expect(deepCloneMapData(a)).toBe(deepCloneMapData(b));
  });

  it('different seeds produce different maps', () => {
    const gen = new MapGenerator();
    const a = gen.generate(1);
    const gen2 = new MapGenerator();
    const b = gen2.generate(999);
    expect(deepCloneMapData(a)).not.toBe(deepCloneMapData(b));
  });

  it('generates a 4x4 sector grid', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.sectors.length).toBe(4);
    for (const row of map.sectors) {
      expect(row.length).toBe(4);
    }
  });

  it('each sector has correct bounds', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const sector = map.sectors[row][col];
        expect(sector.bounds.x).toBe(col * 20 * TILE_PIXEL_SIZE);
        expect(sector.bounds.y).toBe(row * 20 * TILE_PIXEL_SIZE);
        expect(sector.bounds.width).toBe(20 * TILE_PIXEL_SIZE);
        expect(sector.bounds.height).toBe(20 * TILE_PIXEL_SIZE);
      }
    }
  });

  it('each sector has 20x20 tiles', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    for (const row of map.sectors) {
      for (const sector of row) {
        expect(sector.tiles.length).toBe(20);
        for (const tileRow of sector.tiles) {
          expect(tileRow.length).toBe(20);
        }
      }
    }
  });

  it('creates exactly 24 sector connections', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.connections.length).toBe(24);
  });

  it('places exits', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.exits.length).toBeGreaterThan(0);
    expect(map.exits.length).toBeLessThanOrEqual(8);
  });

  it('places loot', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.lootPlacements.length).toBeGreaterThan(0);
  });

  it('places spawn points', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.spawnPoints.length).toBeGreaterThan(0);
    for (const sp of map.spawnPoints) {
      expect(sp.sectorCoord.row).toBeGreaterThanOrEqual(0);
      expect(sp.sectorCoord.row).toBeLessThan(4);
      expect(sp.sectorCoord.col).toBeGreaterThanOrEqual(0);
      expect(sp.sectorCoord.col).toBeLessThan(4);
    }
  });

  it('global bounds are correct', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.globalBounds.width).toBe(4 * 20 * TILE_PIXEL_SIZE);
    expect(map.globalBounds.height).toBe(4 * 20 * TILE_PIXEL_SIZE);
  });

  it('generates weather for all sectors', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.weather.length).toBe(16);
    for (const w of map.weather) {
      expect(['NONE', 'LIGHT_RAIN', 'HEAVY_RAIN', 'SNOW', 'STORM']).toContain(w.weatherType);
    }
  });

  describe('center-hot type placement (T3)', () => {
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7 + 3);

    /**
     * Collect the per-sector type grid and split it into the inner 2x2 center
     * zone and the outer 12-sector ring using the shared `getSectorRing` split.
     *
     * @param map - the generated map data
     * @returns the center and outer sector-type lists
     */
    function splitByRing(map: ReturnType<MapGenerator['generate']>): {
      center: SectorType[];
      outer: SectorType[];
    } {
      const center: SectorType[] = [];
      const outer: SectorType[] = [];
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          const type = map.sectors[row][col].type;
          if (getSectorRing(row, col, SECTOR_GRID_SIZE) === 'center') center.push(type);
          else outer.push(type);
        }
      }
      return { center, outer };
    }

    it('every map contains all four sector types', () => {
      const gen = new MapGenerator();
      for (const seed of seeds) {
        const types = new Set(
          gen
            .generate(seed)
            .sectors.flat()
            .map((s) => s.type),
        );
        expect(types).toEqual(
          new Set([
            SectorType.GRID_ARENA,
            SectorType.OPEN_ARENA,
            SectorType.MAZE,
            SectorType.RESOURCE_RICH,
          ]),
        );
      }
    }, 20_000);

    it('center 2x2 always holds >=1 ResourceRich and >=1 GridArena', () => {
      const gen = new MapGenerator();
      for (const seed of seeds) {
        const { center } = splitByRing(gen.generate(seed));
        expect(center.filter((t) => t === SectorType.RESOURCE_RICH).length).toBeGreaterThanOrEqual(
          1,
        );
        expect(center.filter((t) => t === SectorType.GRID_ARENA).length).toBeGreaterThanOrEqual(1);
      }
      // Multi-seed generation sweep — explicit timeout (machine-load flake class
      // documented in ticket 06; the ticket-10 fairness pass adds generation cost).
    }, 20_000);

    it('center trends ResourceRich+GridArena, outer trends OpenArena+Maze', () => {
      const gen = new MapGenerator();
      let centerRrGa = 0;
      let centerTotal = 0;
      let outerOaMz = 0;
      let outerTotal = 0;
      for (const seed of seeds) {
        const { center, outer } = splitByRing(gen.generate(seed));
        centerRrGa += center.filter(
          (t) => t === SectorType.RESOURCE_RICH || t === SectorType.GRID_ARENA,
        ).length;
        centerTotal += center.length;
        outerOaMz += outer.filter(
          (t) => t === SectorType.OPEN_ARENA || t === SectorType.MAZE,
        ).length;
        outerTotal += outer.length;
      }
      // Strong majority, not absolute, so the rare-type tail still appears.
      expect(centerRrGa / centerTotal).toBeGreaterThan(0.7);
      expect(outerOaMz / outerTotal).toBeGreaterThan(0.6);
      // Multi-seed generation sweep — explicit timeout (machine-load flake class
      // documented in ticket 06; the ticket-10 fairness pass adds generation cost).
    }, 20_000);
  });

  describe('5 specific seeds produce valid maps', () => {
    const seeds = [42, 123, 999, 31415, 271828];
    const validator = new MapValidator();

    it.each(seeds)('seed %s produces valid map', (seed) => {
      const gen = new MapGenerator();
      const map = gen.generate(seed);
      const result = validator.validate(map);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('100 random seeds pass rate', () => {
    it('should pass > 95% of random seeds', { timeout: 30000 }, () => {
      const gen = new MapGenerator();
      const validator = new MapValidator();
      let passed = 0;

      for (let seed = 0; seed < 100; seed++) {
        try {
          const map = gen.generate(seed);
          const result = validator.validate(map);
          if (result.valid) passed++;
        } catch {}
      }

      expect(passed).toBeGreaterThan(95);
    });
  });

  it('generate returns a MapData for a given seed', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.seed).toBeGreaterThanOrEqual(42);
  });

  it('generates map in under 250ms', () => {
    const gen = new MapGenerator();
    const start = performance.now();
    gen.generate(42);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });

  it('stores seed in MapData', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(typeof map.seed).toBe('number');
    expect(map.seed).toBeGreaterThanOrEqual(42);
    expect(map.seed).toBeLessThanOrEqual(42 + 10);
  });
});
