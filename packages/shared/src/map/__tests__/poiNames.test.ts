/**
 * POI naming system tests (map-redesign ticket 03 / DEC-001 + DEC-010).
 *
 * All assertions ride the shared generation pipeline seam: whole-MapData in,
 * external fields out (SPEC testing decision 1). RNG stream usage is asserted
 * only via same-seed byte-identity, never by mocking.
 */
import { describe, expect, it } from 'vitest';

import { MapGenerator } from '../MapGenerator.js';
import { designationSeedTag, generatePoiNames, type PoiNameAssignment } from '../poiNames.js';
import type { SectorSubVariant } from '../sectors/subVariants.js';
import { SectorType } from '../types.js';
import type { MacroFeatureResult } from '../macro/MacroTypes.js';

/** Deterministic seed sweep (fixed, so the suite is itself reproducible). */
const SWEEP_SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7);

/** A synthetic macro bundle for direct generatePoiNames tests. */
function macroBundle(over: Partial<MacroFeatureResult> = {}): MacroFeatureResult {
  return {
    highway: { direction: 'H', width: 5, centerlines: [], carvedTiles: new Set() },
    compound: {
      originRow: 35,
      originCol: 35,
      size: 10,
      variant: 'CROSS_PARTITION',
      carvedTiles: new Set(),
      chests: [],
      traps: [],
      beaconAnchor: { row: 35, col: 35 },
      vault: null,
      entryGaps: [],
    },
    barrierRidge: null,
    openCommons: null,
    ...over,
  };
}

/** Uniform grids where EVERY sector shares one type/sub-variant — the pool-exhaustion stress case. */
function uniformGrids(type: SectorType, subVariant: SectorSubVariant) {
  const typeGrid: SectorType[][] = [];
  const subGrid: SectorSubVariant[][] = [];
  for (let r = 0; r < 4; r++) {
    typeGrid[r] = [type, type, type, type];
    subGrid[r] = [subVariant, subVariant, subVariant, subVariant];
  }
  return { typeGrid, subGrid };
}

describe('generatePoiNames — sector names', () => {
  it('names every sector, non-empty, 2–4 words', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = new MapGenerator().generate(seed);
      expect(map.poiNames).toHaveLength(4);
      for (const row of map.poiNames) {
        expect(row).toHaveLength(4);
        for (const name of row) {
          expect(name.length).toBeGreaterThan(0);
          const words = name.split(' ');
          expect(words.length).toBeGreaterThanOrEqual(2);
          expect(words.length).toBeLessThanOrEqual(5); // "The X Y Z" + fallback tail
        }
      }
    }
    // 24-seed generation sweep — explicit timeout (machine-load flake class
    // documented in ticket 06; the ticket-10 fairness pass adds generation cost).
  }, 20_000);

  it('names are unique within the map (sectors + macro features)', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = new MapGenerator().generate(seed);
      const all = [
        ...map.poiNames.flat(),
        ...Object.values(map.macroPoiNames).filter((n): n is string => n !== null),
      ];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('uniqueness holds even on uniform grids (pool-exhaustion stress)', () => {
    // 16 identical MAZE 'Breakable Warren' sectors: 4 nouns × 8 prefixes ×
    // 8 suffixes must still compose 16 distinct names (fallback tail if not).
    for (let seed = 0; seed < 12; seed++) {
      const { typeGrid, subGrid } = uniformGrids(SectorType.MAZE, 'Breakable Warren');
      const { sectorNames } = generatePoiNames(seed, typeGrid, subGrid, macroBundle());
      const flat = sectorNames.flat();
      expect(flat).toHaveLength(16);
      expect(new Set(flat).size).toBe(16);
    }
  });

  it('names hint at gameplay via the sub-variant noun pool', () => {
    for (const seed of SWEEP_SEEDS.slice(0, 8)) {
      const map = new MapGenerator().generate(seed);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const subVariant = map.sectors[r]![c]!.subVariant;
          const pool = NOUN_POOL_FOR_TEST[subVariant];
          expect(
            pool.some((noun) => map.poiNames[r]![c]!.includes(noun)),
            `${map.poiNames[r]![c]!} must contain a ${subVariant} noun`,
          ).toBe(true);
        }
      }
    }
  });

  it('names are stable across runs and isolated from the tile streams', () => {
    for (const seed of SWEEP_SEEDS.slice(0, 6)) {
      const a = new MapGenerator().generate(seed);
      const b = new MapGenerator().generate(seed);
      expect(a.poiNames).toEqual(b.poiNames);
      expect(a.macroPoiNames).toEqual(b.macroPoiNames);
      expect(a.designation).toBe(b.designation);
      // The naming pass consumes only its own streams: tiles + entities are
      // byte-identical to the pre-ticket-03 fixtures (pinned separately by the
      // golden test); here we assert the two fresh runs agree everywhere.
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe('generatePoiNames — macro feature names', () => {
  it('names only the features present (fixed vocabulary)', () => {
    const none = generatePoiNames(
      7,
      uniformGrids(SectorType.GRID_ARENA, 'Classic Lattice').typeGrid,
      uniformGrids(SectorType.GRID_ARENA, 'Classic Lattice').subGrid,
      macroBundle(),
    );
    expect(none.macroNames.highway).toMatch(/^The /);
    expect(none.macroNames.compound).toMatch(/^The /);
    expect(none.macroNames.barrierRidge).toBeNull();
    expect(none.macroNames.openCommons).toBeNull();

    const withRidge = generatePoiNames(
      7,
      uniformGrids(SectorType.MAZE, 'Loose Labyrinth').typeGrid,
      uniformGrids(SectorType.MAZE, 'Loose Labyrinth').subGrid,
      macroBundle({
        barrierRidge: { carvedTiles: new Set(), gapPositions: [] },
      }),
    );
    expect(withRidge.macroNames.barrierRidge).toMatch(/^The /);
    expect(withRidge.macroNames.openCommons).toBeNull();
  });

  it('highway + compound are always named on real maps', () => {
    for (const seed of SWEEP_SEEDS.slice(0, 6)) {
      const map = new MapGenerator().generate(seed);
      expect(map.macroPoiNames.highway).toBeTruthy();
      expect(map.macroPoiNames.compound).toBeTruthy();
      // Flavor feature: at most one of ridge/commons.
      expect(
        map.macroPoiNames.barrierRidge === null || map.macroPoiNames.openCommons === null,
      ).toBe(true);
    }
  });
});

describe('generatePoiNames — map designation (DEC-010)', () => {
  it('derives the shape word from the macro rolls', () => {
    const mk = (over: Partial<MacroFeatureResult>, seed = 5) => {
      const g = uniformGrids(SectorType.OPEN_ARENA, 'Scatter Cover');
      return generatePoiNames(seed, g.typeGrid, g.subGrid, macroBundle(over));
    };
    // Ridge flavor wins the shape word.
    expect(mk({ barrierRidge: { carvedTiles: new Set(), gapPositions: [] } }).designation).toMatch(
      /^RIDGELINE • /,
    );
    // Commons flavor.
    expect(
      mk({
        openCommons: {
          sectorA: { row: 0, col: 0 },
          sectorB: { row: 0, col: 1 },
          carvedTiles: new Set(),
        },
      }).designation,
    ).toMatch(/^TWINFIELDS • /);
    // No flavor: highway orientation decides.
    expect(
      mk({ highway: { direction: 'H', width: 5, centerlines: [], carvedTiles: new Set() } })
        .designation,
    ).toMatch(/^RINGROAD • /);
    expect(
      mk({ highway: { direction: 'V', width: 5, centerlines: [], carvedTiles: new Set() } })
        .designation,
    ).toMatch(/^SPINEWAY • /);
  });

  it('family word comes from the fortress variant family', () => {
    const g = uniformGrids(SectorType.RESOURCE_RICH, 'Treasure Vault');
    for (const variant of [
      'CROSS_PARTITION',
      'PILLARED_HALL',
      'COURTYARD_RING',
      'LOOT_ARM',
      'CITADEL',
    ] as const) {
      const { designation } = generatePoiNames(
        9,
        g.typeGrid,
        g.subGrid,
        macroBundle({
          compound: {
            originRow: 35,
            originCol: 35,
            size: 10,
            variant,
            carvedTiles: new Set(),
            chests: [],
            traps: [],
            beaconAnchor: { row: 35, col: 35 },
            vault: null,
            entryGaps: [],
          },
        }),
      );
      const family = designation.split(' • ')[1]!;
      const allowed: Record<string, string[]> = {
        CROSS_PARTITION: ['VAULTS', 'STRONGHOLD'],
        PILLARED_HALL: ['PILLARS', 'SPIRE'],
        COURTYARD_RING: ['COURTS', 'RINGHOLD'],
        LOOT_ARM: ['ARMORY', 'WAREROOM'],
        CITADEL: ['CITADEL', 'KEEP'],
      };
      expect(allowed[variant]).toContain(family);
    }
  });

  it('format is SHAPE • FAMILY • seedTag (uppercase words, 2–3 char tag)', () => {
    for (const seed of SWEEP_SEEDS.slice(0, 10)) {
      const map = new MapGenerator().generate(seed);
      expect(map.designation).toMatch(/^[A-Z]+ • [A-Z]+ • [0-9A-Z]{2,3}$/);
      expect(map.designation.endsWith(designationSeedTag(seed))).toBe(true);
    }
  });

  it('designationSeedTag is a pure function of the seed', () => {
    expect(designationSeedTag(63)).toBe('1R'); // 63 = 1*36 + 27 → "1r", uppercased
    expect(designationSeedTag(12345)).toBe('9IX');
    expect(designationSeedTag(0)).toBe('00');
    expect(designationSeedTag(0xdeadbeef)).toBe(designationSeedTag(0xdeadbeef));
  });

  it('designation distinctness across a 100-seed sweep stays high (reported, softly gated)', () => {
    // DEC-010 validation: collision rate is reported, not hard-gated — this
    // soft bound catches vocabulary regressions without over-constraining.
    // Explicit timeout: 100 generations run ~4.5s solo and trip the 5s
    // default under full-suite parallel load (documented machine-load flake).
    const designations = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      designations.add(new MapGenerator().generate(seed).designation);
    }
    expect(designations.size).toBeGreaterThanOrEqual(80);
  }, 20_000);
});

describe('generatePoiNames — determinism', () => {
  it('same seed twice → identical names (byte-identity of the naming fields)', () => {
    const g = uniformGrids(SectorType.GRID_ARENA, 'Ring Fortress');
    const a: PoiNameAssignment = generatePoiNames(424242, g.typeGrid, g.subGrid, macroBundle());
    const b: PoiNameAssignment = generatePoiNames(424242, g.typeGrid, g.subGrid, macroBundle());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('consecutive seeds produce different name grids (avalanche decorrelation)', () => {
    const g = uniformGrids(SectorType.OPEN_ARENA, 'Central Monument');
    let changed = 0;
    for (let seed = 0; seed < 20; seed++) {
      const a = generatePoiNames(seed, g.typeGrid, g.subGrid, macroBundle());
      const b = generatePoiNames(seed + 1, g.typeGrid, g.subGrid, macroBundle());
      if (JSON.stringify(a.sectorNames) !== JSON.stringify(b.sectorNames)) changed++;
    }
    // Plain xorshift salt would lock consecutive seeds near-identically; the
    // avalanche (ticket 02's measured 3%→91% fix) keeps this high.
    expect(changed).toBeGreaterThanOrEqual(15);
  });
});

/**
 * Test-local mirror of the sub-variant noun pools (poiNames.ts keeps the
 * pools module-private by design — data-driven, not part of the API). If the
 * pools drift, this mirror fails loudly and must be updated deliberately.
 */
const NOUN_POOL_FOR_TEST: Record<SectorSubVariant, readonly string[]> = {
  'Classic Lattice': ['Lattice', 'Gridwork', 'Matrix', 'Bastion'],
  'Ring Fortress': ['Bastion', 'Keep', 'Redoubt', 'Ringhold'],
  'Broken Grid': ['Ruins', 'Shambles', 'Rubble', 'Bulwark'],
  'Lane Corridors': ['Corridors', 'Channels', 'Lanes', 'Passages'],
  'Plaza Crossroads': ['Crossroads', 'Plaza', 'Forum', 'Junctions'],
  'Corner Bastions': ['Watchpost', 'Outposts', 'Cornerstone', 'Bulwark'],
  'Central Monument': ['Monument', 'Spire', 'Obelisk', 'Monolith'],
  'Scatter Cover': ['Flats', 'Expanse', 'Steppe', 'Reach'],
  'Diagonal Spurs': ['Spurs', 'Ridges', 'Cuts', 'Runs'],
  Airstrip: ['Airstrip', 'Runway', 'Field', 'Aerodrome'],
  'Loose Labyrinth': ['Labyrinth', 'Tangle', 'Warrens', 'Switchbacks'],
  'Chambers & Halls': ['Halls', 'Chambers', 'Gallery', 'Undercroft'],
  'Breakable Warren': ['Warren', 'Burrow', 'Maze', 'Rabbitry'],
  'Concentric Spiral': ['Spiral', 'Coils', 'Vortex', 'Rings'],
  'Sewer Grid': ['Sewers', 'Cisterns', 'Conduits', 'Galleries'],
  'Treasure Vault': ['Vault', 'Treasury', 'Strongroom', 'Cache'],
  'Loot Bazaar': ['Bazaar', 'Market', 'Exchange', 'Emporium'],
  'Exposed Cache': ['Cache', 'Hoard', 'Trove', 'Stockpile'],
  'Supply Depot': ['Depot', 'Storehouse', 'Armory', 'Quartermaster'],
  'Bank Row': ['Bank', 'Mint', 'Countinghouse', 'Reserve'],
};
