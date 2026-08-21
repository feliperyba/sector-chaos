import { describe, it, expect } from 'vitest';
import {
  TileType,
  SectorType,
  type TileSpriteAtlas,
  type TileSpriteDef,
  type MapData,
  type SectorData,
  type HeroLandmark,
} from '@sector-battle/shared';
import { FloorSpriteSelector } from '../FloorSpriteSelector.ts';

function makeAtlas(overrides?: TileSpriteDef[]): TileSpriteAtlas {
  const sprites: TileSpriteDef[] = [
    { id: 0, imagePath: 'wall', tileType: TileType.INDESTRUCTIBLE_WALL, colliders: [] },
    { id: 1, imagePath: 'tile', tileType: TileType.EMPTY, colliders: [] },
    { id: 2, imagePath: 'tiles_center', tileType: TileType.EMPTY, colliders: [] },
    { id: 3, imagePath: 'path_crossing', tileType: TileType.EMPTY, colliders: [] },
    { id: 4, imagePath: 'path', tileType: TileType.EMPTY, colliders: [] },
    { id: 5, imagePath: 'chest', tileType: TileType.CHEST, colliders: [] },
    { id: 6, imagePath: 'wood', tileType: TileType.EMPTY, colliders: [] },
  ];
  if (overrides) {
    for (const o of overrides) {
      const idx = sprites.findIndex((s) => s.id === o.id);
      if (idx >= 0) sprites[idx] = { ...sprites[idx]!, ...o };
      else sprites.push(o);
    }
  }
  return { sprites };
}

function makeMapData(corridorKeys: string[] = []): MapData {
  return {
    seed: 42,
    sectors: [],
    connections: [],
    spawnPoints: [],
    exits: [],
    lootPlacements: [],
    entityPlacements: [],
    trapPlacements: [],
    weather: [],
    globalBounds: { width: 0, height: 0 },
    corridorTiles: new Set(corridorKeys),
    sectorTiers: [],
    hotSector: { row: 0, col: 0 },
    poiNames: [],
    macroPoiNames: { highway: null, compound: null, barrierRidge: null, openCommons: null },
    designation: '',
    landmarks: { heroes: [], minors: [] },
    fortress: null,
    sectorTypes: [],
    identity: { fields: [], gateways: [] },
  };
}

// In a single 20x20 sector, a cell is an edge cell when its local row or col is
// 0 or 19. Interior cells are everything else.
function isEdge(r: number, c: number): boolean {
  return r % 20 === 0 || r % 20 === 19 || c % 20 === 0 || c % 20 === 19;
}

describe('FloorSpriteSelector', () => {
  const selector = new FloorSpriteSelector();

  it('produces a dense floor layer: every cell gets a sprite, even under non-EMPTY tiles', () => {
    // Walls everywhere must STILL receive a floor underlay (the whole point of the
    // dense underlay — no holes under transparent wall pixels).
    const grid: TileType[][] = [
      [TileType.INDESTRUCTIBLE_WALL, TileType.INDESTRUCTIBLE_WALL],
      [TileType.INDESTRUCTIBLE_WALL, TileType.INDESTRUCTIBLE_WALL],
    ];
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    for (const row of result) {
      for (const cell of row) {
        expect(cell).not.toBeNull();
        expect(cell!.spriteId).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('paints the wood edge floor on sector-border cells', () => {
    // 20x20 grid → one sector. Border cells (local row/col 0 or 19) must be the
    // `wood` edge floor (id 6), interior cells must be the per-sector theme.
    const grid: TileType[][] = Array.from({ length: 20 }, () => Array(20).fill(TileType.EMPTY));
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const cell = result[r]![c]!;
        expect(cell).not.toBeNull();
        if (isEdge(r, c)) {
          expect(cell.spriteId).toBe(6);
        } else {
          expect([1, 2]).toContain(cell.spriteId);
        }
      }
    }
  });

  it('uses one uniform theme sprite for every interior tile within a single sector', () => {
    // 20x20 grid → one sector. Every INTERIOR (non-edge) tile must resolve to the
    // SAME theme spriteId, drawn from {1,2} (wood excluded from the interior pool).
    const grid: TileType[][] = Array.from({ length: 20 }, () => Array(20).fill(TileType.EMPTY));
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    const interiorId = result[1]![1]!.spriteId;
    expect([1, 2]).toContain(interiorId);
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        if (isEdge(r, c)) continue;
        const cell = result[r]![c]!;
        expect(cell).not.toBeNull();
        expect(cell.spriteId).toBe(interiorId);
      }
    }
  });

  it('keeps each sector interior uniform across a multi-sector grid', () => {
    // 40x40 grid → 2x2 sectors. Within each 20x20 sector block every interior
    // floor tile must share the same theme spriteId; edge cells are wood.
    const grid: TileType[][] = Array.from({ length: 40 }, () => Array(40).fill(TileType.EMPTY));
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    for (let sr = 0; sr < 2; sr++) {
      for (let sc = 0; sc < 2; sc++) {
        const baseRow = sr * 20;
        const baseCol = sc * 20;
        // The sector's interior reference tile is local (1,1).
        const sectorId = result[baseRow + 1]![baseCol + 1]!.spriteId;
        expect([1, 2]).toContain(sectorId);
        for (let r = 0; r < 20; r++) {
          for (let c = 0; c < 20; c++) {
            const cell = result[baseRow + r]![baseCol + c]!;
            expect(cell).not.toBeNull();
            if (isEdge(r, c)) {
              expect(cell.spriteId).toBe(6);
            } else {
              expect(cell.spriteId).toBe(sectorId);
            }
          }
        }
      }
    }
  });

  it('falls back to the interior theme on edges when no wood sprite exists', () => {
    // Atlas without `wood` → edge cells must use a theme floor (no null holes).
    const atlas: TileSpriteAtlas = {
      sprites: [
        { id: 0, imagePath: 'wall', tileType: TileType.INDESTRUCTIBLE_WALL, colliders: [] },
        { id: 1, imagePath: 'tile', tileType: TileType.EMPTY, colliders: [] },
        { id: 2, imagePath: 'tiles_center', tileType: TileType.EMPTY, colliders: [] },
      ],
    };
    const grid: TileType[][] = Array.from({ length: 20 }, () => Array(20).fill(TileType.EMPTY));
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    for (const row of result) {
      for (const cell of row) {
        expect(cell).not.toBeNull();
        expect([1, 2]).toContain(cell!.spriteId);
      }
    }
  });

  it('produces deterministic results for the same seed', () => {
    const grid: TileType[][] = Array.from({ length: 40 }, () => Array(40).fill(TileType.EMPTY));
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result1 = selector.select(grid, mapData, atlas, 12345);
    const result2 = selector.select(grid, mapData, atlas, 12345);

    expect(result1).toEqual(result2);
  });

  it('produces different floor layouts for different seeds', () => {
    // Floor selection is per-sector, so divergence must be observed across the
    // full 4x4 arena (80x80 = 16 independent interior-theme picks). Edge cells are
    // identical wood across seeds; the interior theme is what varies. Seeds 1 and 8
    // are a VERIFIED differing pair for this SeededRNG + the 2-floor interior pool.
    const grid: TileType[][] = Array.from({ length: 80 }, () => Array(80).fill(TileType.EMPTY));
    const atlas = makeAtlas();
    const mapData = makeMapData();

    const result1 = selector.select(grid, mapData, atlas, 1);
    const result2 = selector.select(grid, mapData, atlas, 8);

    const same = result1.every((row, r) =>
      row.every((cell, c) => cell?.spriteId === result2[r]?.[c]?.spriteId),
    );
    expect(same).toBe(false);
  });

  it('returns all nulls when atlas has no floor sprites', () => {
    const grid: TileType[][] = [
      [TileType.EMPTY, TileType.EMPTY],
      [TileType.EMPTY, TileType.EMPTY],
    ];
    const atlas: TileSpriteAtlas = {
      sprites: [
        { id: 0, imagePath: 'wall', tileType: TileType.INDESTRUCTIBLE_WALL, colliders: [] },
      ],
    };
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    for (const row of result) {
      for (const cell of row) {
        expect(cell).toBeNull();
      }
    }
  });

  it('excludes non-floor EMPTY sprites (stairs, track) from interior selection', () => {
    // A single interior cell (local 1,1) must pick `tile` (id=2), not stairs/track.
    const atlas: TileSpriteAtlas = {
      sprites: [
        { id: 1, imagePath: 'track', tileType: TileType.EMPTY, colliders: [] },
        { id: 2, imagePath: 'tile', tileType: TileType.EMPTY, colliders: [] },
      ],
    };
    const grid: TileType[][] = Array.from({ length: 20 }, () => Array(20).fill(TileType.EMPTY));
    const mapData = makeMapData();

    const result = selector.select(grid, mapData, atlas, 42);

    expect(result[1]![1]).not.toBeNull();
    expect(result[1]![1]!.spriteId).toBe(2);
  });
});

// ── Biome floors (v11 sector floor cohesion): base + in-family band + plaza ──

// Atlas with every type's signature base floor (`tiles_center` GRID / `grass`
// OPEN / `tiles` MAZE / `tile` RICH), `wood` for edges, the in-family variant
// band sprite (`tiles_cracked`), the plaza medallion (`tiles_decorative`), the
// OPEN plaza pond (`water`), and the transparent overlay accent (`puddle`).
// Ids are stable so the contract is assertable. `plants` is deliberately
// ABSENT so RICH's overlay config resolves nothing (type-gating test).
function makeBiomeAtlas(): TileSpriteAtlas {
  return {
    sprites: [
      { id: 10, imagePath: 'tile', tileType: TileType.EMPTY, colliders: [] },
      { id: 11, imagePath: 'grass', tileType: TileType.EMPTY, colliders: [] },
      { id: 12, imagePath: 'tiles', tileType: TileType.EMPTY, colliders: [] },
      { id: 13, imagePath: 'tiles_center', tileType: TileType.EMPTY, colliders: [] },
      { id: 14, imagePath: 'wood', tileType: TileType.EMPTY, colliders: [] },
      { id: 15, imagePath: 'tiles_cracked', tileType: TileType.EMPTY, colliders: [] },
      { id: 16, imagePath: 'tiles_decorative', tileType: TileType.EMPTY, colliders: [] },
      { id: 17, imagePath: 'puddle', tileType: TileType.EMPTY, colliders: [] },
      { id: 18, imagePath: 'water', tileType: TileType.EMPTY, colliders: [] },
    ],
  };
}

function makeSector(type: SectorType): SectorData {
  return {
    type,
    subVariant: 'Classic Lattice',
    tiles: [],
    elevation: null,
    lootSpots: [],
    landmarkAnchor: { x: 10, y: 10 },
    mirrored: false,
    subBlockMask: 0,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    theme: 'default',
  };
}

// One hero landmark anchored at local (10,10) of sector (sr,sc) — the court
// fixture for the beacon-anchored plaza accent (map-polish ticket 29: the
// medallion follows the beacon anchor, never the sector's geometric center).
// Only the anchor tiles drive floor selection (compositionId/beacon unused).
function makeHero(sr: number, sc: number): HeroLandmark {
  return {
    compositionId: 'watch-spire',
    rarity: 'common',
    tileX: sc * 20 + 10,
    tileY: sr * 20 + 10,
    beacon: { color: [1, 1, 1], intensity: 2.5, radius: 512 },
  };
}

// 2x2 sector grid: GridArena top-left, OpenArena top-right, Maze bottom-left,
// ResourceRich bottom-right — every type present exactly once. With
// `withHeroes` (default) every sector carries a hero anchored at local
// (10,10); without, the sectors have no resolvable anchor (the no-medallion
// fallback fixture).
function makeBiomeMapData(seed: number, withHeroes = true): MapData {
  return {
    seed,
    sectors: [
      [makeSector(SectorType.GRID_ARENA), makeSector(SectorType.OPEN_ARENA)],
      [makeSector(SectorType.MAZE), makeSector(SectorType.RESOURCE_RICH)],
    ],
    connections: [],
    spawnPoints: [],
    exits: [],
    lootPlacements: [],
    entityPlacements: [],
    trapPlacements: [],
    weather: [],
    globalBounds: { width: 0, height: 0 },
    corridorTiles: new Set(),
    sectorTiers: [],
    hotSector: { row: 0, col: 0 },
    poiNames: [],
    macroPoiNames: { highway: null, compound: null, barrierRidge: null, openCommons: null },
    designation: '',
    landmarks: {
      heroes: withHeroes
        ? [
            [makeHero(0, 0), makeHero(0, 1)],
            [makeHero(1, 0), makeHero(1, 1)],
          ]
        : [],
      minors: [],
    },
    fortress: null,
    sectorTypes: [],
    identity: { fields: [], gateways: [] },
  };
}

// Per-type v11 floor contracts (see biomeConfig.ts): the interior floor may
// contain ONLY the type's base + its in-family band variant; the plaza 4×4 is
// the type's in-family accent; the wood ring frames every sector.
const INTERIOR_ALLOWED: Record<SectorType, Set<number>> = {
  [SectorType.GRID_ARENA]: new Set([13, 15]), // tiles_center base + tiles_cracked band
  [SectorType.OPEN_ARENA]: new Set([11]), // uniform grass (no band)
  [SectorType.MAZE]: new Set([12, 15]), // tiles base + tiles_cracked band
  [SectorType.RESOURCE_RICH]: new Set([10]), // uniform tile (no band)
};
const PLAZA_EXPECTED: Record<SectorType, number> = {
  [SectorType.GRID_ARENA]: 16, // tiles_decorative medallion
  [SectorType.OPEN_ARENA]: 18, // water pond (green family)
  [SectorType.MAZE]: 16, // tiles_decorative medallion
  [SectorType.RESOURCE_RICH]: 14, // wood plank dais (brown family)
};
const OVERLAY_ACCENT_IDS = new Set([17]); // puddle
const PATTERN_FLOOR_IDS = new Set([15, 16]); // cracked band / decorative medallion

describe('FloorSpriteSelector — Biome floors (v11 cohesion)', () => {
  const selector = new FloorSpriteSelector();
  // 40x40 → 2x2 sectors of 20x20.
  const grid: TileType[][] = Array.from({ length: 40 }, () => Array(40).fill(TileType.EMPTY));
  const mapData = makeBiomeMapData(42);

  it('every interior cell is the sector base or its in-family band variant', () => {
    const result = selector.select(grid, mapData, makeBiomeAtlas(), 42);
    for (let sr = 0; sr < 2; sr++) {
      for (let sc = 0; sc < 2; sc++) {
        const type = mapData.sectors[sr]![sc]!.type;
        const allowed = INTERIOR_ALLOWED[type]!;
        for (let r = 0; r < 20; r++) {
          for (let c = 0; c < 20; c++) {
            if (r === 0 || r === 19 || c === 0 || c === 19) continue;
            if (r >= 8 && r <= 11 && c >= 8 && c <= 11) continue; // court region (9..11; 8..11 superset)
            const id = result[sr * 20 + r]![sc * 20 + c]!.spriteId;
            expect(allowed.has(id)).toBe(true);
          }
        }
      }
    }
  });

  it('the band is a tight minority — base stays the dominant read', () => {
    const result = selector.select(grid, mapData, makeBiomeAtlas(), 42);
    // GRID (6%) and MAZE (8%) carry the tiles_cracked band; both must stay
    // clearly base-dominant so the floor reads cohesive, not scattered.
    for (const [sr, sc] of [
      [0, 0], // GRID_ARENA
      [1, 0], // MAZE
    ] as const) {
      let band = 0;
      let total = 0;
      for (let r = 1; r < 19; r++) {
        for (let c = 1; c < 19; c++) {
          if (r >= 8 && r <= 11 && c >= 8 && c <= 11) continue;
          const id = result[sr * 20 + r]![sc * 20 + c]!.spriteId;
          if (id === 15) band++;
          total++;
        }
      }
      expect(band).toBeGreaterThan(0);
      expect(band / total).toBeLessThan(0.15);
    }
  });

  it('band-disabled types stay 100% uniform (OPEN grass, RICH tile)', () => {
    const result = selector.select(grid, mapData, makeBiomeAtlas(), 42);
    for (const [sr, sc, expected] of [
      [0, 1, 11],
      [1, 1, 10],
    ] as const) {
      for (let r = 1; r < 19; r++) {
        for (let c = 1; c < 19; c++) {
          if (r >= 8 && r <= 11 && c >= 8 && c <= 11) continue;
          expect(result[sr * 20 + r]![sc * 20 + c]!.spriteId).toBe(expected);
        }
      }
    }
  });

  it('the beacon court is the type’s in-family accent sprite (anchored to the hero)', () => {
    // Map-polish ticket 29: the plaza accent paints the keep’s interior court
    // — Chebyshev ≤1 around the ANCHOR (local (10,10) in this fixture →
    // local 9..11) — so the medallion always reads as the beacon’s floor.
    const result = selector.select(grid, mapData, makeBiomeAtlas(), 42);
    for (let sr = 0; sr < 2; sr++) {
      for (let sc = 0; sc < 2; sc++) {
        const expected = PLAZA_EXPECTED[mapData.sectors[sr]![sc]!.type]!;
        for (let r = 9; r <= 11; r++) {
          for (let c = 9; c <= 11; c++) {
            expect(result[sr * 20 + r]![sc * 20 + c]!.spriteId).toBe(expected);
          }
        }
        // The old FIXED sector-center patch is gone: every cell of the former
        // 4×4 (local 8..11) that lies OUTSIDE the court resolves to the
        // sector’s base/band floor, never the accent.
        const outsideCourt: Array<[number, number]> = [
          [8, 8],
          [8, 9],
          [8, 10],
          [8, 11],
          [9, 8],
          [10, 8],
          [11, 8],
        ];
        for (const [r, c] of outsideCourt) {
          expect(result[sr * 20 + r]![sc * 20 + c]!.spriteId).not.toBe(expected);
        }
      }
    }
  });

  it('sectors with no resolvable anchor get no medallion (never the old center patch)', () => {
    const result = selector.select(grid, makeBiomeMapData(42, false), makeBiomeAtlas(), 42);
    for (let sr = 0; sr < 2; sr++) {
      for (let sc = 0; sc < 2; sc++) {
        const allowed = INTERIOR_ALLOWED[mapData.sectors[sr]![sc]!.type]!;
        const accent = PLAZA_EXPECTED[mapData.sectors[sr]![sc]!.type]!;
        for (let r = 1; r < 19; r++) {
          for (let c = 1; c < 19; c++) {
            const id = result[sr * 20 + r]![sc * 20 + c]!.spriteId;
            // Whole interior (including the former plaza region) is base/band.
            expect(allowed.has(id), `local (${r},${c})`).toBe(true);
            if (r >= 8 && r <= 11 && c >= 8 && c <= 11) {
              expect(id).not.toBe(accent);
            }
          }
        }
      }
    }
  });

  it('places transparent overlay accents only inside matching sectors', () => {
    // GRID/OPEN/MAZE overlay sets all resolve `puddle` (17) in this atlas;
    // RICH's set is ['plants'], which is ABSENT — so the RICH sector must
    // receive ZERO overlay accents while the matching sectors paint. That is
    // the type-gate: an accent only ever lands in a sector whose own type's
    // config sources it.
    const overlay = selector.buildDecorationLayer(grid, mapData, makeBiomeAtlas(), 42);
    let accentsInRich = 0;
    let accentsElsewhere = 0;
    for (let r = 0; r < 40; r++) {
      for (let c = 0; c < 40; c++) {
        const id = overlay[r]![c]?.spriteId;
        if (id === undefined || !OVERLAY_ACCENT_IDS.has(id)) continue;
        if (r >= 20 && c >= 20)
          accentsInRich++; // bottom-right = RESOURCE_RICH
        else accentsElsewhere++;
      }
    }
    expect(accentsElsewhere).toBeGreaterThan(0);
    expect(accentsInRich).toBe(0);
  });

  it('patterned stone full-tiles never scatter via the overlay (band/plaza only)', () => {
    // tiles_cracked (15) and tiles_decorative (16) are ~94%-opaque FULL tiles —
    // v11 lets them appear ONLY as the deterministic floor band / plaza
    // medallion, never as randomly scattered overlay accents.
    const overlay = selector.buildDecorationLayer(grid, mapData, makeBiomeAtlas(), 42);
    for (const row of overlay) {
      for (const cell of row) {
        expect(PATTERN_FLOOR_IDS.has(cell?.spriteId ?? -1)).toBe(false);
      }
    }
  });

  it('floor + overlay selection is deterministic for the same seed', () => {
    const a = selector.select(grid, makeBiomeMapData(99), makeBiomeAtlas(), 99);
    const b = selector.select(grid, makeBiomeMapData(99), makeBiomeAtlas(), 99);
    expect(a).toEqual(b);
    const oa = selector.buildDecorationLayer(grid, makeBiomeMapData(99), makeBiomeAtlas(), 99);
    const ob = selector.buildDecorationLayer(grid, makeBiomeMapData(99), makeBiomeAtlas(), 99);
    expect(oa).toEqual(ob);
  });

  it('accents vary per instance (different seeds → different accent layout)', () => {
    const a = selector.buildDecorationLayer(grid, makeBiomeMapData(1), makeBiomeAtlas(), 1);
    const b = selector.buildDecorationLayer(grid, makeBiomeMapData(2), makeBiomeAtlas(), 2);
    const same = a.every((row, r) =>
      row.every((cell, c) => cell?.spriteId === b[r]?.[c]?.spriteId),
    );
    expect(same).toBe(false);
  });

  it('skips band + accents when their sprites are absent (no crash, uniform base)', () => {
    // Atlas with the base floors but NO band/medallion/pond/overlay sprites:
    // interiors resolve to the plain per-type base. (The RICH court is `wood`,
    // which IS a base floor sprite, so its dais survives this fallback — the
    // court region is excluded here and covered by the dedicated court test.)
    const atlas: TileSpriteAtlas = {
      sprites: makeBiomeAtlas().sprites.filter(
        (s) => !PATTERN_FLOOR_IDS.has(s.id) && !OVERLAY_ACCENT_IDS.has(s.id) && s.id !== 18,
      ),
    };
    const result = selector.select(grid, mapData, atlas, 42);
    for (let sr = 0; sr < 2; sr++) {
      for (let sc = 0; sc < 2; sc++) {
        const type = mapData.sectors[sr]![sc]!.type;
        const base = INTERIOR_ALLOWED[type]!;
        for (let r = 1; r < 19; r++) {
          for (let c = 1; c < 19; c++) {
            if (r >= 8 && r <= 11 && c >= 8 && c <= 11) continue; // court region (9..11; 8..11 superset)
            const id = result[sr * 20 + r]![sc * 20 + c]!.spriteId;
            expect(base.has(id)).toBe(true);
          }
        }
      }
    }
  });
});
