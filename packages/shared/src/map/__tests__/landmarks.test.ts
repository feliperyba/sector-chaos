import { describe, expect, it } from 'vitest';

import { MapGenerator } from '../MapGenerator.js';
import {
  BEACON_INTENSITY_MAX,
  BEACON_INTENSITY_MIN,
  BEACON_RADIUS,
  BEACON_THEME_LIGHT,
  BEACON_TIER_LIGHT,
  CITADEL_BEACON_RADIUS,
  MINOR_HERO_MIN_CHEB,
  MINOR_LANDMARK_LIGHT,
  MINOR_MINOR_MIN_CHEB,
  assignLandmarks,
  signatureIndexFor,
} from '../landmarks.js';
import {
  LANDMARK_REGISTRY,
  LANDMARK_TYPE_ORDER,
  landmarkCompositionById,
} from '../landmarkRegistry.js';
import { SECTOR_IDENTITY } from '../identitySheets.js';
import { DECOR_BAKE_FRAMES, OBJECT_VISUAL_FRAMES } from '../bakeFrameDiscipline.js';
import { effectiveSectorTier } from '../lootTiers.js';
import { SUB_VARIANTS_BY_TYPE } from '../sectors/subVariants.js';
import { NOUNS_BY_SUB_VARIANT } from '../poiNames.js';
import { SECTOR_TILE_SIZE, TILE_PIXEL_SIZE } from '../constants.js';
import {
  buildCompositeGrid,
  gridBfs,
  findFirstPassable,
  isEmptyTile,
  isTraversable,
} from '../gridUtils.js';
import { SectorType, type MapData } from '../types.js';

/**
 * Landmark system test suite (map-redesign ticket 04 / DEC-002).
 *
 * The "test distributions, not fixtures" layer (SPEC Testing Decision 4):
 * a deterministic seed sweep over whole maps asserts the structural contract
 * — every sector named + landmarked + anchored on a reachable EMPTY tile,
 * adjacent-sector composition uniqueness, rare under-rolling, signature
 * band rotation, junction minors, beacon value bands, and POI-noun
 * alignment. Byte-identity per seed is pinned separately by the golden
 * fixtures + the same-seed identity test.
 */

/** Deterministic sweep seeds (generation-only; a full run is a few seconds). */
const SWEEP_SEEDS: readonly number[] = Array.from({ length: 24 }, (_, i) => 1 + i * 977);
/** Rec.601 luma of a linear RGB triple (the grayscale double-coding check). */
const luma = ([r, g, b]: readonly [number, number, number]): number =>
  0.299 * r + 0.587 * g + 0.114 * b;

function generate(seed: number): MapData {
  return new MapGenerator().generate(seed);
}

/** All hero landmarks of a map, flattened. */
function heroesOf(map: MapData) {
  return map.landmarks.heroes.flat();
}

describe('Landmark registry integrity', () => {
  it('every type has 3–5 compositions with exactly 1–2 RARE entries', () => {
    for (const type of LANDMARK_TYPE_ORDER) {
      const entries = LANDMARK_REGISTRY[type];
      expect(entries.length).toBeGreaterThanOrEqual(3);
      expect(entries.length).toBeLessThanOrEqual(5);
      const rare = entries.filter((e) => e.rarity === 'rare').length;
      expect(rare).toBeGreaterThanOrEqual(1);
      expect(rare).toBeLessThanOrEqual(2);
      // Ids unique map-wide.
      for (const entry of entries) {
        expect(landmarkCompositionById(entry.id)?.id).toBe(entry.id);
      }
    }
    const allIds = LANDMARK_TYPE_ORDER.flatMap((t) => LANDMARK_REGISTRY[t].map((e) => e.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('every composition has a 2–3 tile exclusion radius', () => {
    // Map-polish ticket 29 removed the parts/scale/tint gates with the client
    // composite dressing bake — a composition is placement/naming identity
    // only; the exclusion radius (server decor/light exclusion zone) stays.
    for (const type of LANDMARK_TYPE_ORDER) {
      for (const entry of LANDMARK_REGISTRY[type]) {
        expect(entry.exclusionRadius).toBeGreaterThanOrEqual(2);
        expect(entry.exclusionRadius).toBeLessThanOrEqual(3);
      }
    }
  });

  it('no bake-driven frame is an object-visual frame (map-polish tickets 05+06)', () => {
    // The user's no-baked-objects rule, machine-checked over every
    // bake-driven frame table: objects exist as REAL grid tiles → live server
    // entities (the authored plaza, landmarkPlaza.ts) — never as baked floor
    // pixels; lights as light placements. The deny list is the shared
    // env.tsx-sourced constant `OBJECT_VISUAL_FRAMES` (kept in lockstep with
    // the atlas by the server parity test in TsxAtlasParser.test.ts); the
    // positive side (`DECOR_BAKE_FRAMES`) also spell-checks the tables — a
    // typo'd frame would silently skip in the client bake's
    // `gameAtlas.has` guard. The only bake-driven tables left after the
    // ticket-29 landmark-dressing removal are the gateway frames of
    // `bakeGatewayFrames` (bracket pair + accent — the arch was REMOVED by
    // map-polish ticket 19), so this rule IS the bake wiring audit.
    const check = (table: string, frame: string): void => {
      expect(OBJECT_VISUAL_FRAMES.has(frame), `${table} "${frame}" is object-visual`).toBe(false);
      expect(DECOR_BAKE_FRAMES.has(frame), `${table} "${frame}" is not decor vocabulary`).toBe(
        true,
      );
    };
    for (const type of LANDMARK_TYPE_ORDER) {
      const gw = SECTOR_IDENTITY[type].gateway;
      // Map-polish ticket 19 (owner ruling): NO arch frame — the stairs_down
      // exit/stairs art was removed from corridor midpoints. The empty
      // sentinel draws nothing and is deliberately OUTSIDE the vocabulary;
      // any non-empty restoration must pass `check` like every other frame.
      expect(gw.archFrame, `SECTOR_IDENTITY[${type}].gateway.archFrame (removed, ticket 19)`).toBe(
        '',
      );
      check(`SECTOR_IDENTITY[${type}].gateway.bracketFrame`, gw.bracketFrame);
      check(`SECTOR_IDENTITY[${type}].gateway.accentFrame`, gw.accentFrame);
    }
  });

  it('nounHints cover every sub-variant pool of the type (non-empty, in-vocabulary)', () => {
    // The DATA CONTRACT that guarantees POI-noun alignment with zero
    // fallback: for every (composition, sub-variant) pair the intersection
    // with the sub-variant's noun pool is non-empty. Vocabulary is checked
    // against the REAL pool the naming pass draws from (imported, not
    // duplicated — a pool edit can never silently drift past this gate).
    for (const type of LANDMARK_TYPE_ORDER) {
      for (const entry of LANDMARK_REGISTRY[type]) {
        for (const sub of SUB_VARIANTS_BY_TYPE[type]) {
          const hints = entry.nounHints[sub];
          expect(hints, `${entry.id} × ${sub}`).toBeDefined();
          expect(hints!.length).toBeGreaterThan(0);
          const pool = NOUNS_BY_SUB_VARIANT[sub];
          for (const noun of hints!) {
            expect(pool, `${entry.id} × ${sub}: noun "${noun}"`).toContain(noun);
          }
          expect(pool.some((n) => hints!.includes(n))).toBe(true);
        }
      }
    }
  });
});

describe('Beacon value bands (DEC-005 hierarchy + grayscale double-coding)', () => {
  it('tier colors + intensities: brightest static kind, below the VFX band, value-ordered', () => {
    for (const key of ['HOT', 'WARM', 'COLD', 'RARE'] as const) {
      const light = BEACON_TIER_LIGHT[key];
      // The intensity band [2.45, 2.6] (map-polish ticket 01 moody retune,
      // was [2.6, 2.8]): equal to the brightest static light kinds at the top
      // (campfire/fireplace 2.6) with the widest radius (512 vs their 320 —
      // radius dominance) so the beacon reads as its sector's dominant
      // static light; below the explosion/projectile band (~4) so the
      // player/VFX value band stays supreme (grayscale check).
      expect(light.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
      expect(light.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
      for (const channel of light.color) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // The raw intensity ordering is the value double-coding's spine:
    // HOT (2.6) > RARE (2.55) > WARM (2.5) > COLD (2.45).
    expect(BEACON_TIER_LIGHT.HOT.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.RARE.intensity);
    expect(BEACON_TIER_LIGHT.RARE.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.WARM.intensity);
    expect(BEACON_TIER_LIGHT.WARM.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.COLD.intensity);
    // Grayscale (Rec.601 luma × intensity) ordering — the value
    // double-coding: gold > ember > cool; violet reads between ember and cool.
    const values = {
      hot: luma(BEACON_TIER_LIGHT.HOT.color) * BEACON_TIER_LIGHT.HOT.intensity,
      warm: luma(BEACON_TIER_LIGHT.WARM.color) * BEACON_TIER_LIGHT.WARM.intensity,
      cold: luma(BEACON_TIER_LIGHT.COLD.color) * BEACON_TIER_LIGHT.COLD.intensity,
      rare: luma(BEACON_TIER_LIGHT.RARE.color) * BEACON_TIER_LIGHT.RARE.intensity,
    };
    expect(values.hot).toBeGreaterThan(values.warm);
    expect(values.warm).toBeGreaterThan(values.cold);
    expect(values.hot).toBeGreaterThan(values.rare);
  });

  it('beacon radii: hero at the SPEC ≥512 floor, Citadel wider than every hero', () => {
    // SPEC §7 (docs/design/map-redesign/SPEC.md): beacons are "radius ≥512"
    // — the map-polish ticket-01 retune drops the hero radius to exactly
    // that floor (576 → 512) and keeps the Citadel above it (640 → 576).
    expect(BEACON_RADIUS).toBeGreaterThanOrEqual(512);
    expect(CITADEL_BEACON_RADIUS).toBeGreaterThan(BEACON_RADIUS);
    // The widest static reach stays inside the dark-pocket distance: 576px
    // = 4.5 tiles < DARK_POCKET_LIGHT_DISTANCE (5 tiles, server
    // lightHierarchyConfig) — also asserted server-side against the real
    // constant in LightingDiscipline.test.ts. Beacon reach = 4 tiles (hero).
    expect(CITADEL_BEACON_RADIUS / TILE_PIXEL_SIZE).toBeLessThan(5);
    expect(BEACON_RADIUS / TILE_PIXEL_SIZE).toBeLessThan(5);
  });

  it('every placed beacon honors the radius/intensity band', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      for (const hero of heroesOf(map)) {
        expect(hero.beacon.radius).toBeGreaterThanOrEqual(512);
        expect(hero.beacon.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
        expect(hero.beacon.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
      }
      for (const minor of map.landmarks.minors) {
        expect(minor.light.radius).toBeLessThan(512); // small marker light
        expect(minor.light.intensity).toBeLessThan(BEACON_INTENSITY_MIN);
      }
    }
    // 24-seed generation sweep — explicit timeout (machine-load flake class
    // documented in ticket 06; the ticket-10 fairness pass adds generation cost).
  }, 20_000);
});

describe('Landmark assignment across the seed sweep (structural triad)', () => {
  it('every sector has exactly one hero landmark from its type registry', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const hero = map.landmarks.heroes[row]![col]!;
          expect(hero, `seed ${seed} [${row},${col}]`).toBeDefined();
          const valid = LANDMARK_REGISTRY[map.sectors[row]![col]!.type].map((e) => e.id);
          expect(valid).toContain(hero.compositionId);
          expect(['signature', 'common', 'rare']).toContain(hero.rarity);
        }
      }
    }
  });

  it('adjacent sectors never share a composition', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const id = map.landmarks.heroes[row]![col]!.compositionId;
          if (col > 0) expect(map.landmarks.heroes[row]![col - 1]!.compositionId).not.toBe(id);
          if (row > 0) expect(map.landmarks.heroes[row - 1]![col]!.compositionId).not.toBe(id);
        }
      }
    }
  });

  it('hero anchors sit on EMPTY, non-corridor, reachable tiles (never wall-sealed)', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      const grid = buildCompositeGrid(map.sectors);
      const start = findFirstPassable(grid, isEmptyTile);
      expect(start).not.toBeNull();
      // Reachability uses the TRAVERSABLE predicate (breakables count as
      // open — a pocket behind DESTRUCTIBLE cover is reachable by smashing,
      // matching the server determinism flood). "Wall-sealed" means sealed
      // by INDESTRUCTIBLE walls, which never reopen.
      const { visited } = gridBfs({
        grid,
        startR: start!.r,
        startC: start!.c,
        passable: isTraversable,
      });
      for (const hero of heroesOf(map)) {
        // Anchor is TRAVERSABLE in the final post-entity grid — chosen EMPTY
        // on the pre-entity grid; a chest/barrel may afterwards claim the tile
        // ("loot crowds the landmark", DEC-002) but never an indestructible
        // wall, and the entity stream stays byte-identical (ADR 0035).
        expect(isTraversable(grid[hero.tileY]![hero.tileX]!)).toBe(true);
        // Reachable from the main region — never sealed behind walls.
        // (`visited` is a Uint8Array flood flag: 0/1.)
        expect(visited[hero.tileY * grid.length + hero.tileX]).toBe(1);
        // Not a corridor tile (any sector key at this global position).
        const sRow = Math.floor(hero.tileY / 20);
        const sCol = Math.floor(hero.tileX / 20);
        expect(map.corridorTiles.has(`${sRow},${sCol},${hero.tileY % 20},${hero.tileX % 20}`)).toBe(
          false,
        );
        // Inside its own sector's bounds.
        expect(sRow * 20 <= hero.tileY).toBe(true);
        expect(sCol * 20 <= hero.tileX).toBe(true);
      }
    }
  });

  it('2–3 minor landmarks at junction nodes, never adjacent to a hero', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      const minors = map.landmarks.minors;
      expect(minors.length).toBeGreaterThanOrEqual(2);
      expect(minors.length).toBeLessThanOrEqual(3);
      const heroTiles = heroesOf(map).map((h) => ({ x: h.tileX, y: h.tileY }));
      for (const minor of minors) {
        // A junction node placement: within a sector-side of an interior corner.
        const jr = Math.round(minor.tileY / 20);
        const jc = Math.round(minor.tileX / 20);
        expect(jr).toBeGreaterThanOrEqual(1);
        expect(jr).toBeLessThanOrEqual(3);
        expect(jc).toBeGreaterThanOrEqual(1);
        expect(jc).toBeLessThanOrEqual(3);
        for (const hero of heroTiles) {
          const cheb = Math.max(Math.abs(hero.x - minor.tileX), Math.abs(hero.y - minor.tileY));
          expect(cheb).toBeGreaterThanOrEqual(MINOR_HERO_MIN_CHEB);
        }
      }
      for (let i = 0; i < minors.length; i++) {
        for (let j = i + 1; j < minors.length; j++) {
          const cheb = Math.max(
            Math.abs(minors[i]!.tileX - minors[j]!.tileX),
            Math.abs(minors[i]!.tileY - minors[j]!.tileY),
          );
          expect(cheb).toBeGreaterThanOrEqual(MINOR_MINOR_MIN_CHEB);
        }
      }
    }
  });

  it('POI name noun aligns with the chosen landmark family', () => {
    for (const seed of SWEEP_SEEDS) {
      const map = generate(seed);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const hero = map.landmarks.heroes[row]![col]!;
          const hints =
            landmarkCompositionById(hero.compositionId)?.nounHints[
              map.sectors[row]![col]!.subVariant
            ] ?? [];
          const name = map.poiNames[row]![col]!;
          expect(
            hints.some((noun) => name.includes(noun)),
            `seed ${seed} [${row},${col}] "${name}" vs ${hero.compositionId} hints ${hints.join('/')}`,
          ).toBe(true);
        }
      }
    }
  });

  it('RARE variants are deliberately under-rolled but do appear across the sweep', () => {
    let rareTotal = 0;
    let sectorTotal = 0;
    for (const seed of SWEEP_SEEDS) {
      const heroes = heroesOf(generate(seed));
      rareTotal += heroes.filter((h) => h.rarity === 'rare').length;
      sectorTotal += heroes.length;
    }
    expect(rareTotal).toBeGreaterThan(0); // the event happens...
    expect(rareTotal / sectorTotal).toBeLessThan(0.25); // ...but rarely (<25%).
  });

  it('signature composition rotates across consecutive seed bands (≥60% of pairs)', () => {
    // Exercises the REAL rotation function (not a re-implementation of its
    // formula): one step per band (SEED_BAND_SIZE 4), 40 bands per type.
    let changed = 0;
    let pairs = 0;
    for (const type of LANDMARK_TYPE_ORDER) {
      let prevIdx = signatureIndexFor(0, type);
      for (let band = 1; band < 40; band++) {
        const seed = band * 4; // SEED_BAND_SIZE 4 → one band per step
        const idx = signatureIndexFor(seed, type);
        pairs++;
        if (idx !== prevIdx) changed++;
        prevIdx = idx;
      }
    }
    expect(changed / pairs).toBeGreaterThanOrEqual(0.6);
  });

  it('same seed ⇒ identical landmark assignment (fresh instances)', () => {
    const a = generate(4242);
    const b = generate(4242);
    expect(a.landmarks).toEqual(b.landmarks);
    expect(a.landmarks).not.toBe(b.landmarks);
  });

  it('assignLandmarks is a pure function of its inputs (replay equals pipeline output)', () => {
    // Recompute the assignment from the SAME inputs the pipeline used and
    // require byte-equality with the stored MapData.landmarks. The pipeline
    // runs the pass BEFORE the plaza stamp and entity placement, so the
    // replay first inverts the LATER writers — the plaza stamp (ticket 05:
    // wall/crate tiles, exact audit via getLastPlazaStamps) and the entity
    // tile writes (EntityPlacer is the only writer of CHEST/BARREL tiles) —
    // to reconstruct the pre-plaza pre-entity grids the pass saw. This is
    // also the regression lock for the ADR 0035 contract: the landmark pass
    // must never reserve tiles from the entity placer (which would perturb
    // the entity stream) — entities may claim anchor tiles AFTER assignment
    // ("loot crowds the landmark", DEC-002) and the plaza may frame them
    // AFTER assignment too (ticket 05).
    const gen = new MapGenerator();
    const map = gen.generate(31337);
    const sectors = structuredClone(map.sectors);
    for (const stamp of gen.getLastPlazaStamps()) {
      sectors[stamp.sectorRow]![stamp.sectorCol]!.tiles[stamp.tileRow]![stamp.tileCol] = 0; // EMPTY
    }
    for (const placement of map.entityPlacements) {
      // Only CHEST and BARREL placements write tiles (traps do not).
      if (placement.entityType !== 'CHEST' && placement.entityType !== 'BARREL') continue;
      const sRow = placement.sectorCoord.row;
      const sCol = placement.sectorCoord.col;
      // Positions are global world px at the tile corner; sectors are aligned
      // 20-tile blocks, so the local tile is the modulo.
      const tRow = (placement.position.y / 128) % 20;
      const tCol = (placement.position.x / 128) % 20;
      sectors[sRow]![sCol]!.tiles[tRow]![tCol] = 0; // TileType.EMPTY
    }
    const replay = assignLandmarks(
      map.seed,
      sectors,
      map.sectors.map((row) => row.map((s) => s.type)),
      map.corridorTiles,
      { tiers: map.sectorTiers, hotSector: map.hotSector },
    );
    expect(replay).toEqual(map.landmarks);
  });
});

// ─── Theme-keyed beacon colors (map-polish ticket 03 — hue=theme, value=tier) ──

/**
 * Hue-family clustering MIRRORED from server `LightingDiscipline.hueFamilyOf`
 * (the shared package cannot import server code — keep the two in lockstep;
 * the server suite asserts the original against the same tables).
 */
type HueFamily = 'warm' | 'green' | 'teal' | 'blue' | 'violet';
const FAMILY_BANDS: ReadonlyArray<{ family: HueFamily; lo: number; hi: number }> = [
  { family: 'warm', lo: 0, hi: 60 },
  { family: 'green', lo: 60, hi: 160 },
  { family: 'teal', lo: 160, hi: 210 },
  { family: 'blue', lo: 210, hi: 255 },
  { family: 'violet', lo: 255, hi: 360 },
];
function hueFamilyOf(color: readonly [number, number, number]): HueFamily {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue: number;
  if (delta <= 1e-6) {
    hue = 0; // achromatic — treat as warm (fires are near-white at the core)
  } else if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  for (const band of FAMILY_BANDS) {
    if (hue >= band.lo && hue < band.hi) return band.family;
  }
  return 'warm'; // unreachable (bands cover [0,360))
}

/** The identity-sheet wall tint as an RGB triple (0xRRGGBB → /255 channels). */
function wallTintRGBOf(type: SectorType): [number, number, number] {
  const tint = SECTOR_IDENTITY[type]!.wallTint;
  return [((tint >> 16) & 0xff) / 255, ((tint >> 8) & 0xff) / 255, (tint & 0xff) / 255];
}

/**
 * The MAIN-MENU light-registry tone inventory (round-2 ticket 15's
 * re-derivation source — the owner's ground truth): client
 * `menuDioramaPlacements.ts` `TONE_BIOME`, the linear-RGB accent the menu
 * pairs with each diorama theme. The menu renders these through its
 * biome-glow crystals at intensity 3.0 / radius 300 (`MENU_CRYSTAL`) — the
 * intensity carries the luminosity over the dim, deliberately desaturated
 * hue (warm fixtures by contrast peak at 1.0 at intensity 1.4–1.75). The
 * beacon cannot copy that convention (its intensity is tier-coded inside the
 * DEC-005 static band [2.45,2.6]), so `BEACON_THEME_LIGHT` keeps the menu
 * tone's hue + saturation and normalizes the peak channel to 1.0 via the
 * uniform scale `c ÷ max(tone)` (uniform scaling preserves HSV hue and
 * saturation EXACTLY — both are channel ratios). Inlined here because the
 * shared package cannot import client code (the FAMILY_BANDS mirror
 * precedent above); keep in lockstep with the menu table.
 */
const MENU_TONE_BY_TYPE: Readonly<Record<SectorType, readonly [number, number, number]>> = {
  [SectorType.GRID_ARENA]: [0.3, 0.4, 0.52], // 'forest-glade' — steel-blue, "serene moonlit grove"
  [SectorType.OPEN_ARENA]: [0.18, 0.45, 0.24], // 'forest-bonfire' — emerald, "glade moss" clearing
  [SectorType.MAZE]: [0.26, 0.16, 0.42], // 'crypt-antechamber' — muted violet, "spectral undead"
  [SectorType.RESOURCE_RICH]: [0.6, 0.52, 0.3], // 'temple-threshold' — ivory-gold, "divine radiance"
};

/** HSV hue in degrees of a linear-RGB triple (the hueFamilyOf math, un-banded). */
function hueDegreesOf(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta <= 1e-6) return 0;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return hue < 0 ? hue + 360 : hue;
}

/** HSV saturation of a linear-RGB triple (a channel ratio — scale-invariant). */
function saturationOf(color: readonly [number, number, number]): number {
  const max = Math.max(...color);
  const min = Math.min(...color);
  return max <= 1e-6 ? 0 : (max - min) / max;
}

/** The golden-suite seed set — same seeds the whole-MapData fixtures pin. */
const THEME_SEEDS: readonly number[] = [1, 42, 999, 0xdeadbeef];

describe('Beacon theme colors (map-polish ticket 03 — hue=theme, value=tier; tones re-derived from the menu registry by round-2 ticket 15)', () => {
  it('BEACON_THEME_LIGHT tones derive from the menu registry (hue+sat preserved, peak normalized)', () => {
    // Round-2 ticket 15: the MENU registry is the tone AUTHORITY. Each table
    // entry must be its menu `TONE_BIOME` accent with hue + HSV saturation
    // preserved EXACTLY (the uniform `c ÷ max(tone)` scale only touches
    // value) and the peak channel normalized to the beacon convention 1.0
    // (every BEACON_TIER_LIGHT color peaks at 1.0; the beacon intensity band
    // is tier-coded and cannot adopt the menu's crystal 3.0).
    for (const type of LANDMARK_TYPE_ORDER) {
      const beacon = BEACON_THEME_LIGHT[type].color;
      const tone = MENU_TONE_BY_TYPE[type]!;
      // (a) value normalized: the peak channel is exactly 1.0.
      expect(Math.max(...beacon), `${type} peak channel`).toBe(1);
      // (b) hue preserved from the menu tone (±0.5° — 2dp rounding slack).
      expect(Math.abs(hueDegreesOf(beacon) - hueDegreesOf(tone)), `${type} hue`).toBeLessThan(0.5);
      // (c) HSV saturation preserved (a channel ratio — invariant under
      // uniform scaling; ±0.01 for the 2dp rounding of the table entry).
      expect(
        Math.abs(saturationOf(beacon) - saturationOf(tone)),
        `${type} saturation`,
      ).toBeLessThan(0.01);
      // (d) all channels stay inside the linear [0,1] range.
      for (const channel of beacon) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('BEACON_THEME_LIGHT families equal the identity-sheet wall-tint families', () => {
    for (const type of LANDMARK_TYPE_ORDER) {
      const beacon = BEACON_THEME_LIGHT[type].color;
      const wall = wallTintRGBOf(type);
      expect(hueFamilyOf(beacon), `${type}`).toBe(hueFamilyOf(wall));
    }
    // The explicit identity-sheet families — wall-tint hue degrees for
    // reference: GRID 211°, OPEN 73°, MAZE 264°, RICH 40°. The menu-derived
    // beacon tones sit in the SAME families (GRID 212.9° blue, OPEN 133.0°
    // green — inside the same 60–160° band as the 73° sage tint, the menu
    // wins the intra-band angle per ticket 15 — MAZE 263.2° violet, RICH
    // 44.4° warm): no hue-family relationship breaks, so the family
    // expectations carry over UNCHANGED from ticket 03's suite.
    expect(hueFamilyOf(BEACON_THEME_LIGHT[SectorType.GRID_ARENA].color)).toBe('blue');
    expect(hueFamilyOf(BEACON_THEME_LIGHT[SectorType.OPEN_ARENA].color)).toBe('green');
    expect(hueFamilyOf(BEACON_THEME_LIGHT[SectorType.MAZE].color)).toBe('violet');
    expect(hueFamilyOf(BEACON_THEME_LIGHT[SectorType.RESOURCE_RICH].color)).toBe('warm');
  });

  it('every hero beacon wears its sector type theme color + the tier-keyed intensity', () => {
    for (const seed of THEME_SEEDS) {
      const map = generate(seed);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const hero = map.landmarks.heroes[row]![col]!;
          const type = map.sectorTypes[row]![col]!;
          // (a) color is EXACTLY the type's table entry (array equality on
          // the triple — same seed ⇒ deterministic bytes).
          expect(hero.beacon.color, `seed ${seed} [${row},${col}]`).toEqual([
            ...BEACON_THEME_LIGHT[type].color,
          ]);
          // (b) the beacon's hue family equals its identity-sheet wall tint's.
          expect(hueFamilyOf(hero.beacon.color)).toBe(hueFamilyOf(wallTintRGBOf(type)));
          // (c) intensity inside the band AND exactly the tier-keyed value
          // (RARE compositions keep the RARE bump; the violet hue is gone).
          expect(hero.beacon.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
          expect(hero.beacon.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
          const composition = landmarkCompositionById(hero.compositionId)!;
          const tier = effectiveSectorTier(
            { tiers: map.sectorTiers, hotSector: map.hotSector },
            row,
            col,
          );
          const expected =
            composition.rarity === 'rare'
              ? BEACON_TIER_LIGHT.RARE.intensity
              : BEACON_TIER_LIGHT[tier].intensity;
          expect(hero.beacon.intensity, `seed ${seed} [${row},${col}]`).toBe(expected);
          expect(hero.beacon.radius).toBe(BEACON_RADIUS);
        }
      }
    }
  }, 20_000);

  it('fortress beacon: standard compound theme-colored, Citadel stays RARE violet', () => {
    for (const seed of THEME_SEEDS) {
      const map = generate(seed);
      const f = map.fortress!;
      if (f.variant === 'CITADEL') {
        expect(f.beacon.color).toEqual([...BEACON_TIER_LIGHT.RARE.color]);
        expect(f.beacon.intensity).toBe(BEACON_INTENSITY_MAX);
        expect(f.beacon.radius).toBe(CITADEL_BEACON_RADIUS);
      } else {
        const sRow = Math.floor(f.beacon.tileY / SECTOR_TILE_SIZE);
        const sCol = Math.floor(f.beacon.tileX / SECTOR_TILE_SIZE);
        const type = map.sectorTypes[sRow]![sCol]!;
        expect(f.beacon.color, `seed ${seed} ${f.variant}`).toEqual([
          ...BEACON_THEME_LIGHT[type].color,
        ]);
        const tier = effectiveSectorTier(
          { tiers: map.sectorTiers, hotSector: map.hotSector },
          sRow,
          sCol,
        );
        expect(f.beacon.intensity).toBe(BEACON_TIER_LIGHT[tier].intensity);
        expect(f.beacon.radius).toBe(BEACON_RADIUS);
      }
    }
  }, 20_000);

  it('every sector viewport holds ≤3 hue families with the beacon counted', () => {
    // By construction: a sector's families = {its ONE theme family (beacon),
    // the fixed warm fire family (sconces/POI pools), blue (a junction minor
    // marker, if one sits in the sector)} — the full server-side
    // `lintHueDiscipline` over real placements is asserted in the server
    // LightingDiscipline suite; this is the shared data-layer guarantee.
    for (const seed of THEME_SEEDS) {
      const map = generate(seed);
      const families: Array<Set<HueFamily>> = Array.from({ length: 16 }, () => new Set());
      const add = (tileY: number, tileX: number, color: readonly [number, number, number]) => {
        const row = Math.floor(tileY / SECTOR_TILE_SIZE);
        const col = Math.floor(tileX / SECTOR_TILE_SIZE);
        families[row * 4 + col]!.add(hueFamilyOf(color));
      };
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          add(
            map.landmarks.heroes[row]![col]!.tileY,
            map.landmarks.heroes[row]![col]!.tileX,
            map.landmarks.heroes[row]![col]!.beacon.color,
          );
        }
      }
      const f = map.fortress!;
      add(f.beacon.tileY, f.beacon.tileX, f.beacon.color);
      for (const minor of map.landmarks.minors) {
        add(minor.tileY, minor.tileX, MINOR_LANDMARK_LIGHT.color);
      }
      for (let s = 0; s < 16; s++) {
        families[s]!.add('warm'); // the fixed fire family (sconces + POI pools)
        expect(families[s]!.size, `seed ${seed} sector ${s}`).toBeLessThanOrEqual(3);
      }
    }
  }, 20_000);
});
