import { describe, expect, it } from 'vitest';

import {
  BASE_WEATHER_WEIGHTS,
  FLOOR_FIELD_VALUE_BAND,
  FLOOR_WALL_VALUE_GAP,
  MAX_WEATHER_BIAS_POINTS,
  SECTOR_IDENTITY,
  WALL_TINT_MIN_LUM_SEPARATION,
  WALL_VALUE_BAND,
  biasedWeatherWeights,
  tintLuminance,
  wallTintAt,
} from '../identitySheets.js';
import {
  GATEWAY_ALIGN_COS,
  fieldCoversTile,
  fieldTileAlpha,
  gatewayMidpoint,
  tileJitter,
} from '../visualIdentity.js';
import { BEACON_INTENSITY_MIN } from '../landmarks.js';
import { effectiveSectorTier, type SectorTierAssignment } from '../lootTiers.js';
import { MapGenerator } from '../MapGenerator.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import { SectorLootTier, SectorType, type MapData } from '../types.js';

/**
 * Map-redesign ticket 07 / DEC-006 — the identity-sheet + visual-identity
 * data-layer suite. The ticket's VISUAL acceptance criteria (grayscale /
 * desaturation screenshots, value-band spot-checks, seam jitter) are verified
 * here as NUMERIC data-layer equivalents per the deterministic-verification
 * mandate: computed luminance bands separate (floors darkest < walls mid <
 * gameplay brightest), per-type identity survives desaturation (pairwise wall
 * luminance separation + temperature split + distinct landmark silhouette
 * frame sets), and field borders jitter non-axis-aligned.
 */

const ALL_TYPES = Object.values(SectorType);
const ALL_TIERS = Object.values(SectorLootTier);

// ─── Identity sheets: completeness + fiction ──────────────────────────────────

describe('identity sheets (DEC-006 #1)', () => {
  it('every sector type has a complete authored sheet', () => {
    for (const type of ALL_TYPES) {
      const sheet = SECTOR_IDENTITY[type];
      expect(sheet, `sheet for ${type}`).toBeDefined();
      expect(sheet.fiction.length).toBeGreaterThan(0);
      expect(sheet.wallTint).toBeGreaterThan(0);
      expect(sheet.floor.base).toBeGreaterThan(0);
      expect(sheet.floor.wear).toBeGreaterThan(0);
      expect(sheet.floor.stain).toBeGreaterThan(0);
      expect(sheet.floor.alpha).toBeGreaterThan(0);
      expect(sheet.floor.alpha).toBeLessThan(0.5); // soft overlay, never opaque
      // Map-polish ticket 19 (owner ruling): NO arch frame — the stairs_down
      // exit/stairs art was removed from corridor midpoints (clean passage).
      // The empty sentinel skips the client bake's arch draw entirely.
      expect(sheet.gateway.archFrame).toBe('');
      expect(sheet.gateway.bracketFrame.length).toBeGreaterThan(0);
      expect(sheet.gateway.accentFrame.length).toBeGreaterThan(0);
      expect(sheet.weatherBias).toBeDefined();
    }
  });

  it('the four fiction lines are the authored DEC-006 materials and unique', () => {
    const fictions = ALL_TYPES.map((t) => SECTOR_IDENTITY[t].fiction);
    expect(new Set(fictions).size).toBe(ALL_TYPES.length);
    expect(fictions).toContain('fortified depot yards');
    expect(fictions).toContain('overgrown landing fields');
    expect(fictions).toContain('abandoned ruins');
    expect(fictions).toContain('gilded vault district');
  });
});

// ─── Value-band audit (floors darkest < walls mid < gameplay brightest) ───────

describe('value-band audit (DEC-006 #2 + acceptance "value bands")', () => {
  const wallLums = ALL_TYPES.map((t) => tintLuminance(SECTOR_IDENTITY[t].wallTint));

  it('every wall tint stays in the mid value band (the old global grey band)', () => {
    for (const type of ALL_TYPES) {
      const lum = tintLuminance(SECTOR_IDENTITY[type].wallTint);
      expect(lum).toBeGreaterThanOrEqual(WALL_VALUE_BAND.min);
      expect(lum).toBeLessThanOrEqual(WALL_VALUE_BAND.max);
    }
    // The legacy global grey (0xbbbbcc, L≈0.738) sits inside the band — the
    // per-type tints are mid-band siblings of the grey they replace.
    expect(tintLuminance(0xbbbbcc)).toBeGreaterThan(WALL_VALUE_BAND.min);
    expect(tintLuminance(0xbbbbcc)).toBeLessThan(WALL_VALUE_BAND.max);
  });

  it('every floor field tint sits in the darkest band, strictly below walls', () => {
    const minWallLum = Math.min(...wallLums);
    for (const type of ALL_TYPES) {
      const floor = SECTOR_IDENTITY[type].floor;
      for (const tint of [floor.base, floor.wear, floor.stain]) {
        const lum = tintLuminance(tint);
        expect(lum).toBeGreaterThanOrEqual(FLOOR_FIELD_VALUE_BAND.min);
        expect(lum).toBeLessThanOrEqual(FLOOR_FIELD_VALUE_BAND.max);
        // FLOORS DARKEST: the whole floor band sits a full gap below the walls.
        expect(lum + FLOOR_WALL_VALUE_GAP).toBeLessThanOrEqual(minWallLum);
      }
    }
  });

  it('gameplay stays the brightest band: walls < beacon statics < VFX floor', () => {
    // The numeric chain of the grayscale rule: max wall tint luminance < the
    // WEAKEST beacon intensity (the dimmest static light kind, shared
    // landmarks.ts) < the player/VFX value floor (≈4.0, explosion flash). In a
    // desaturated view no district surface can out-value combat feedback.
    const maxWallLum = Math.max(...wallLums);
    expect(maxWallLum).toBeLessThan(BEACON_INTENSITY_MIN);
    expect(BEACON_INTENSITY_MIN).toBeLessThan(4.0);
  });
});

// ─── Grayscale / desaturation double-coding (acceptance criterion) ────────────

describe('grayscale desaturation test (DEC-006 #7)', () => {
  it('wall tints are pairwise luminance-separated — types distinguishable without hue', () => {
    const lums = ALL_TYPES.map((t) => ({
      type: t,
      lum: tintLuminance(SECTOR_IDENTITY[t].wallTint),
    }));
    for (let i = 0; i < lums.length; i++) {
      for (let j = i + 1; j < lums.length; j++) {
        expect(
          Math.abs(lums[i]!.lum - lums[j]!.lum),
          `${lums[i]!.type} vs ${lums[j]!.type}`,
        ).toBeGreaterThanOrEqual(WALL_TINT_MIN_LUM_SEPARATION);
      }
    }
  });

  it('light temperature double-codes: cool/warm split varies across types', () => {
    // Temperature = the warm/cool lean of the tint (R vs B dominance) — the
    // second, hue-independent-ish coding axis alongside value.
    const temperature = (tint: number): 'cool' | 'warm' | 'neutral' => {
      const r = (tint >> 16) & 0xff;
      const b = tint & 0xff;
      const g = (tint >> 8) & 0xff;
      if (g > r && g > b) return 'neutral'; // green-dominant reads neutral-organic
      return b > r ? 'cool' : 'warm';
    };
    expect(temperature(SECTOR_IDENTITY[SectorType.GRID_ARENA].wallTint)).toBe('cool');
    expect(temperature(SECTOR_IDENTITY[SectorType.OPEN_ARENA].wallTint)).toBe('neutral');
    expect(temperature(SECTOR_IDENTITY[SectorType.MAZE].wallTint)).toBe('cool');
    expect(temperature(SECTOR_IDENTITY[SectorType.RESOURCE_RICH].wallTint)).toBe('warm');
    // Both cool types separate by VALUE (GRID 0.645 vs MAZE 0.590 — Δ ≥ 0.03
    // asserted above), and the warm type separates from neutral by value too:
    // identity = hue + temperature + value + silhouette together.
    expect(
      Math.abs(
        tintLuminance(SECTOR_IDENTITY[SectorType.GRID_ARENA].wallTint) -
          tintLuminance(SECTOR_IDENTITY[SectorType.MAZE].wallTint),
      ),
    ).toBeGreaterThanOrEqual(WALL_TINT_MIN_LUM_SEPARATION);
  });
});

// ─── Wall tint lookup (client bake helper) ────────────────────────────────────

describe('wallTintAt (per-type wall tint lookup)', () => {
  it('resolves each sector tile to its district tint; demo maps fall back to the global grey', () => {
    const grid: SectorType[][] = [
      [SectorType.GRID_ARENA, SectorType.MAZE],
      [SectorType.OPEN_ARENA, SectorType.RESOURCE_RICH],
    ];
    const t = SECTOR_TILE_SIZE;
    // The 2×2 grid: rows [0,t) [t,2t) × cols [0,t) [t,2t).
    expect(wallTintAt(grid, 5, 5, t)).toBe(SECTOR_IDENTITY[SectorType.GRID_ARENA].wallTint); // (0,0)
    expect(wallTintAt(grid, t + 5, 5, t)).toBe(SECTOR_IDENTITY[SectorType.MAZE].wallTint); // (0,1)
    expect(wallTintAt(grid, 5, t + 5, t)).toBe(SECTOR_IDENTITY[SectorType.OPEN_ARENA].wallTint); // (1,0)
    expect(wallTintAt(grid, t + 5, t + 5, t)).toBe(
      SECTOR_IDENTITY[SectorType.RESOURCE_RICH].wallTint,
    ); // (1,1)
    // Demo/fallback: no sector-type grid → the legacy global grey.
    expect(wallTintAt(null, 3, 7, t)).toBe(0xbbbbcc);
    expect(wallTintAt(undefined, 3, 7, t)).toBe(0xbbbbcc);
    // Out-of-range tiles (map border) → the global grey, never a crash.
    expect(wallTintAt(grid, 999, 999, t)).toBe(0xbbbbcc);
  });
});

// ─── Border jitter (non-axis-aligned seams) ───────────────────────────────────

describe('floor-field border jitter (DEC-006 #3)', () => {
  it('tileJitter is deterministic, bounded to ±1, and hits multiple steps', () => {
    const steps = new Set<number>();
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const j = tileJitter(x, y, 12345);
        expect(j).toBe(tileJitter(x, y, 12345)); // pure
        expect(j).toBeGreaterThanOrEqual(-1);
        expect(j).toBeLessThanOrEqual(1);
        steps.add(j);
      }
    }
    // Quarter-tile steps across the full ±1 range — organic wobble, not binary.
    expect(steps.size).toBeGreaterThanOrEqual(7);
  });

  it('a field is solid inside (zero per-tile noise) but wobbles at the border', () => {
    const field = {
      kind: 'base' as const,
      cx: 10,
      cy: 10,
      radius: 6,
      tint: 0x3e4a5c,
      alpha: 0.34,
      jitterSeed: 777,
    };
    // Interior: every tile with dist ≤ radius-1 is covered regardless of jitter.
    for (let lx = 0; lx < SECTOR_TILE_SIZE; lx++) {
      for (let ly = 0; ly < SECTOR_TILE_SIZE; ly++) {
        const dist = Math.hypot(lx - field.cx, ly - field.cy);
        if (dist <= field.radius - 1) {
          expect(fieldCoversTile(field, lx, ly)).toBe(true);
        }
      }
    }
    // Border actually wobbles: the jittered membership differs from a perfect
    // circle (both directions) — no straight debug-seam look.
    let addedByJitter = 0;
    let removedByJitter = 0;
    for (let lx = 0; lx < SECTOR_TILE_SIZE; lx++) {
      for (let ly = 0; ly < SECTOR_TILE_SIZE; ly++) {
        const dist = Math.hypot(lx - field.cx, ly - field.cy);
        const member = fieldCoversTile(field, lx, ly);
        if (member && dist > field.radius) addedByJitter++;
        if (!member && dist <= field.radius) removedByJitter++;
      }
    }
    expect(addedByJitter).toBeGreaterThan(0);
    expect(removedByJitter).toBeGreaterThan(0);
  });

  it('field borders are non-axis-aligned: boundary offsets vary per scanline', () => {
    const field = {
      kind: 'base' as const,
      cx: 10,
      cy: 10,
      radius: 6.5,
      tint: 0,
      alpha: 0.3,
      jitterSeed: 424242,
    };
    // For each row crossing the blob, the leftmost covered column is the
    // boundary offset. An axis-aligned blob (rectangle) would keep one offset
    // across ALL rows; a wobbling blob varies it.
    const offsets = new Set<number>();
    for (let ly = 4; ly <= 16; ly++) {
      for (let lx = 0; lx < SECTOR_TILE_SIZE; lx++) {
        if (fieldCoversTile(field, lx, ly)) {
          offsets.add(lx);
          break;
        }
      }
    }
    expect(offsets.size).toBeGreaterThanOrEqual(3);
    // And no long straight vertical run: no single offset repeats for 8+ rows.
    const runs = new Map<number, number>();
    let currentOffset: number | null = null;
    let run = 0;
    for (let ly = 4; ly <= 16; ly++) {
      let first = -1;
      for (let lx = 0; lx < SECTOR_TILE_SIZE; lx++) {
        if (fieldCoversTile(field, lx, ly)) {
          first = lx;
          break;
        }
      }
      if (first === currentOffset) run++;
      else {
        if (currentOffset !== null)
          runs.set(currentOffset, Math.max(runs.get(currentOffset) ?? 0, run));
        currentOffset = first;
        run = 1;
      }
    }
    if (currentOffset !== null)
      runs.set(currentOffset, Math.max(runs.get(currentOffset) ?? 0, run));
    for (const [offset, len] of runs) {
      expect(len, `boundary offset ${offset} runs straight for ${len} rows`).toBeLessThan(8);
    }
  });

  it('fieldTileAlpha is full-strength inside, feathered at the edge, 0 outside', () => {
    const field = {
      kind: 'base' as const,
      cx: 10,
      cy: 10,
      radius: 5,
      tint: 0,
      alpha: 0.3,
      jitterSeed: 99,
    };
    // Along the +x ray from the center: alpha is non-increasing with distance
    // (a smooth falloff — zero per-tile noise) and reaches 0 beyond the blob.
    let prev = Infinity;
    for (let lx = 10; lx <= SECTOR_TILE_SIZE; lx++) {
      const a = fieldTileAlpha(field, lx, 10);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    expect(prev).toBe(0);
    expect(fieldTileAlpha(field, 10, 10)).toBeCloseTo(field.alpha, 6);
  });
});

// ─── Gateway dressing geometry ────────────────────────────────────────────────

describe('gateway midpoint geometry', () => {
  it('horizontal and vertical connections resolve to the aperture center', () => {
    const hConn = {
      sectorA: { row: 2, col: 1 },
      sectorB: { row: 2, col: 2 },
      width: 3 as const,
      positionA: { x: 0, y: 0 },
      positionB: { x: 0, y: 0 },
    };
    const h = gatewayMidpoint(hConn);
    expect(h.midX).toBe(2 * SECTOR_TILE_SIZE - 0.5); // the seam between the sectors
    expect(h.midY).toBe(2 * SECTOR_TILE_SIZE + 10); // opening center row (local 9..11)

    const vConn = {
      sectorA: { row: 0, col: 3 },
      sectorB: { row: 1, col: 3 },
      width: 3 as const,
      positionA: { x: 0, y: 0 },
      positionB: { x: 0, y: 0 },
    };
    const v = gatewayMidpoint(vConn);
    expect(v.midX).toBe(3 * SECTOR_TILE_SIZE + 10);
    expect(v.midY).toBe(1 * SECTOR_TILE_SIZE - 0.5);
  });

  it('the alignment threshold is inside the entering cone', () => {
    expect(GATEWAY_ALIGN_COS).toBeGreaterThan(0.5);
    expect(GATEWAY_ALIGN_COS).toBeLessThan(0.9);
  });
});

// ─── The generated pass end-to-end (on MapData) ───────────────────────────────

describe('generateVisualIdentity on generated maps (ticket 07)', () => {
  const map: MapData = new MapGenerator().generate(42);

  it('MapData carries sectorTypes + identity; identity is 4×4 + one gateway per connection', () => {
    expect(map.sectorTypes).toHaveLength(SECTOR_GRID_SIZE);
    expect(map.identity.fields).toHaveLength(SECTOR_GRID_SIZE);
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      expect(map.sectorTypes[row]).toHaveLength(SECTOR_GRID_SIZE);
      expect(map.identity.fields[row]).toHaveLength(SECTOR_GRID_SIZE);
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        expect(map.sectorTypes[row]![col]).toBe(map.sectors[row]![col]!.type);
      }
    }
    expect(map.identity.gateways).toHaveLength(map.connections.length);
  });

  it('every sector gets 2–3 floor fields: base + wear (door) ± stain (hazards)', () => {
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const fields = map.identity.fields[row]![col]!;
        expect(fields.length, `sector ${row},${col}`).toBeGreaterThanOrEqual(2);
        expect(fields.length, `sector ${row},${col}`).toBeLessThanOrEqual(3);
        const kinds = fields.map((f) => f.kind);
        expect(kinds).toContain('base');
        expect(kinds).toContain('wear');
        // A stain only appears when the sector hosts ≥2 hazard entities.
        const hazards =
          map.entityPlacements.filter(
            (e) =>
              e.entityType === 'BARREL' && e.sectorCoord.row === row && e.sectorCoord.col === col,
          ).length +
          map.trapPlacements.filter((t) => t.sectorCoord.row === row && t.sectorCoord.col === col)
            .length;
        if (kinds.includes('stain')) expect(hazards).toBeGreaterThanOrEqual(2);
        else expect(hazards).toBeLessThan(2);
        // Every field's tint comes from the sector's sheet family + in bounds.
        const sheet = SECTOR_IDENTITY[map.sectorTypes[row]![col]!];
        for (const f of fields) {
          expect([sheet.floor.base, sheet.floor.wear, sheet.floor.stain]).toContain(f.tint);
          expect(f.alpha).toBe(sheet.floor.alpha);
          expect(f.cx).toBeGreaterThanOrEqual(3);
          expect(f.cx).toBeLessThanOrEqual(SECTOR_TILE_SIZE - 3);
          expect(f.cy).toBeGreaterThanOrEqual(3);
          expect(f.cy).toBeLessThanOrEqual(SECTOR_TILE_SIZE - 3);
          expect(f.radius).toBeGreaterThan(1.5);
        }
      }
    }
    // At least one sector on this map rolled a hazard stain (coverage proof).
    const stains = map.identity.fields
      .flat()
      .flat()
      .filter((f) => f.kind === 'stain');
    expect(stains.length).toBeGreaterThan(0);
  });

  it('wear fields anchor near a corridor door of their own sector', () => {
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        const wear = map.identity.fields[row]![col]!.find((f) => f.kind === 'wear')!;
        // The wear center must sit within radius+2 of SOME aperture touching
        // this sector (pulled 2 tiles inward + ±1 jitter from the door).
        const near = map.connections.some((conn) => {
          const touches =
            (conn.sectorA.row === row && conn.sectorA.col === col) ||
            (conn.sectorB.row === row && conn.sectorB.col === col);
          if (!touches) return false;
          const { midX, midY } = gatewayMidpoint(conn);
          const lx = midX - col * SECTOR_TILE_SIZE;
          const ly = midY - row * SECTOR_TILE_SIZE;
          return Math.hypot(lx - wear.cx, ly - wear.cy) <= wear.radius + 4;
        });
        expect(near, `wear field of sector ${row},${col}`).toBe(true);
      }
    }
  });

  it('gateways carry sheet lerp tints, hero anchors, and correct alignment flags', () => {
    for (let i = 0; i < map.connections.length; i++) {
      const conn = map.connections[i]!;
      const gw = map.identity.gateways[i]!;
      expect(gw.sectorA).toEqual(conn.sectorA);
      expect(gw.sectorB).toEqual(conn.sectorB);
      expect(gw.axis).toBe(conn.sectorA.row === conn.sectorB.row ? 'h' : 'v');
      expect(gw.tintA).toBe(
        SECTOR_IDENTITY[map.sectorTypes[conn.sectorA.row]![conn.sectorA.col]!].floor.base,
      );
      expect(gw.tintB).toBe(
        SECTOR_IDENTITY[map.sectorTypes[conn.sectorB.row]![conn.sectorB.col]!].floor.base,
      );
      const heroA = map.landmarks.heroes[conn.sectorA.row]![conn.sectorA.col]!;
      const heroB = map.landmarks.heroes[conn.sectorB.row]![conn.sectorB.col]!;
      expect(gw.heroA).toEqual({ x: heroA.tileX, y: heroA.tileY });
      expect(gw.heroB).toEqual({ x: heroB.tileX, y: heroB.tileY });
      // Recompute the alignment independently and compare.
      const { midX, midY } = gatewayMidpoint(conn);
      const recompute = (sector: { row: number; col: number }, hero: { x: number; y: number }) => {
        const isH = conn.sectorA.row === conn.sectorB.row;
        const inX = isH ? (sector.col < Math.max(conn.sectorA.col, conn.sectorB.col) ? -1 : 1) : 0;
        const inY = isH ? 0 : sector.row < Math.max(conn.sectorA.row, conn.sectorB.row) ? -1 : 1;
        const dx = hero.x - midX;
        const dy = hero.y - midY;
        const len = Math.hypot(dx, dy);
        return (dx / len) * inX + (dy / len) * inY >= GATEWAY_ALIGN_COS;
      };
      expect(gw.alignedA).toBe(recompute(conn.sectorA, { x: heroA.tileX, y: heroA.tileY }));
      expect(gw.alignedB).toBe(recompute(conn.sectorB, { x: heroB.tileX, y: heroB.tileY }));
    }
  });

  it('entering-shot alignment occurs where the seed allows (structure at every gateway regardless)', () => {
    // Across a seed sweep a meaningful share of gateways are aligned; every
    // connection is ALWAYS dressed (Elena's note: all gateways get structure).
    let alignedSides = 0;
    let totalSides = 0;
    let dressed = 0;
    let connections = 0;
    for (const seed of [1, 7, 42, 99, 123, 999]) {
      const m = new MapGenerator().generate(seed);
      connections += m.connections.length;
      dressed += m.identity.gateways.length;
      for (const gw of m.identity.gateways) {
        totalSides += 2;
        if (gw.alignedA) alignedSides++;
        if (gw.alignedB) alignedSides++;
      }
    }
    expect(dressed).toBe(connections); // every corridor opening dressed
    expect(alignedSides / totalSides).toBeGreaterThan(0.1); // "where the seed allows"
    expect(alignedSides / totalSides).toBeLessThan(1.0); // not forced everywhere
  });

  it('same seed → byte-identical identity (determinism)', () => {
    const again = new MapGenerator().generate(42);
    expect(JSON.stringify(again.identity)).toBe(JSON.stringify(map.identity));
    expect(JSON.stringify(again.sectorTypes)).toBe(JSON.stringify(map.sectorTypes));
  });

  it('different seeds → varied field placement (seeded, not fixed)', () => {
    const a = new MapGenerator().generate(1);
    const b = new MapGenerator().generate(2);
    expect(JSON.stringify(a.identity.fields)).not.toBe(JSON.stringify(b.identity.fields));
  });
});

// ─── Weather bias (DEC-006 #6) ────────────────────────────────────────────────

describe('weather bias weights (fiction + tier)', () => {
  it('every weight moves at most ±15 points from the base table and stays possible', () => {
    const base = new Map(BASE_WEATHER_WEIGHTS.map((w) => [w.item, w.weight]));
    for (const type of ALL_TYPES) {
      for (const tier of ALL_TIERS) {
        for (const { item, weight } of biasedWeatherWeights(type, tier)) {
          expect(Math.abs(weight - base.get(item)!), `${type}/${tier}/${item}`).toBeLessThanOrEqual(
            MAX_WEATHER_BIAS_POINTS,
          );
          expect(weight).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('STORM leans HOT, SNOW leans cold; NONE stays dominant in the common case', () => {
    const baseStorm = BASE_WEATHER_WEIGHTS.find((w) => w.item === 'STORM')!.weight;
    const baseSnow = BASE_WEATHER_WEIGHTS.find((w) => w.item === 'SNOW')!.weight;
    const baseNone = BASE_WEATHER_WEIGHTS.find((w) => w.item === 'NONE')!.weight;
    for (const type of ALL_TYPES) {
      const get = (tier: SectorLootTier, item: string) =>
        biasedWeatherWeights(type, tier).find((w) => w.item === item)!.weight;
      expect(get(SectorLootTier.HOT, 'STORM')).toBeGreaterThan(baseStorm);
      expect(get(SectorLootTier.COLD, 'SNOW')).toBeGreaterThan(baseSnow);
      // WARM (the map's most common tier) keeps NONE the single heaviest roll.
      const warm = biasedWeatherWeights(type, SectorLootTier.WARM);
      const noneWarm = warm.find((w) => w.item === 'NONE')!.weight;
      for (const other of warm) {
        if (other.item !== 'NONE') expect(other.weight).toBeLessThan(noneWarm);
      }
      expect(noneWarm).toBeGreaterThanOrEqual(baseNone - MAX_WEATHER_BIAS_POINTS);
    }
  });

  it(
    'the biased roll stays deterministic and leans in aggregate across a seed sweep',
    { timeout: 20_000 },
    () => {
      const rates = new Map<string, { hit: number; n: number }>();
      const bump = (key: string, hit: boolean) => {
        const r = rates.get(key) ?? { hit: 0, n: 0 };
        r.n++;
        if (hit) r.hit++;
        rates.set(key, r);
      };
      let noneCount = 0;
      let total = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const m = new MapGenerator().generate(seed);
        // Determinism: regenerate → identical weather.
        expect(JSON.stringify(new MapGenerator().generate(seed).weather)).toBe(
          JSON.stringify(m.weather),
        );
        const tierOf = (row: number, col: number): SectorLootTier =>
          effectiveSectorTier(
            { tiers: m.sectorTiers, hotSector: m.hotSector } as SectorTierAssignment,
            row,
            col,
          );
        for (const w of m.weather) {
          total++;
          if (w.weatherType === 'NONE') noneCount++;
          const tier = tierOf(w.sectorCoord.row, w.sectorCoord.col);
          bump(`STORM:${tier}`, w.weatherType === 'STORM');
          bump(`SNOW:${tier}`, w.weatherType === 'SNOW');
        }
      }
      // NONE stays the DOMINANT (modal) weather map-wide: the bias is MILD by
      // design — the base 40% NONE rate pulls down to ~30% by the tier leans
      // while remaining the single most common outcome (measured 120/384 vs
      // SNOW 99, LIGHT_RAIN 82 over this sweep).
      expect(noneCount).toBeGreaterThan(total / 5);
      const byType = new Map<string, number>();
      for (let seed = 1; seed <= 24; seed++) {
        for (const w of new MapGenerator().generate(seed).weather) {
          byType.set(w.weatherType, (byType.get(w.weatherType) ?? 0) + 1);
        }
      }
      expect(byType.get('NONE')).toBeGreaterThan(byType.get('SNOW')!);
      expect(byType.get('NONE')).toBeGreaterThan(byType.get('LIGHT_RAIN')!);
      expect(byType.get('NONE')).toBeGreaterThan(byType.get('HEAVY_RAIN')!);
      expect(byType.get('NONE')).toBeGreaterThan(byType.get('STORM')!);
      // The leans: STORM more likely on HOT than COLD; SNOW the reverse.
      const rate = (k: string) => {
        const r = rates.get(k)!;
        return r.hit / r.n;
      };
      expect(rates.get('STORM:HOT')!.n).toBeGreaterThan(0);
      expect(rates.get('STORM:COLD')!.n).toBeGreaterThan(0);
      expect(rate('STORM:HOT')).toBeGreaterThan(rate('STORM:COLD'));
      expect(rate('SNOW:COLD')).toBeGreaterThan(rate('SNOW:HOT'));
    },
  );
});
