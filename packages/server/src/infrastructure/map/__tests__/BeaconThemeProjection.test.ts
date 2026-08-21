/**
 * Map-polish ticket 04 — beacon theme colors end-to-end at the ADAPTED layer.
 *
 * Ticket 03 keyed the beacon HUE on the sector TYPE (`BEACON_THEME_LIGHT` —
 * hue=theme, value=tier). This suite proves the theme colors survive the
 * server projection UNCHANGED into the FINAL adapted light placements that
 * the golden fixtures pin (SeedMapAdapter: sconce layer + hero/minor beacons
 * + fortress beacon, post hue-discipline enforcement) and that the DEC-005
 * discipline holds over exactly that list:
 *
 *   - membership: every `kind:'beacon'` placement's color is a member of the
 *     authored set — `BEACON_THEME_LIGHT` ∪ the Citadel RARE violet ∪ the
 *     junction minors' neutral-cool marker;
 *   - position→theme: every hero/fortress beacon's grid position falls inside
 *     a sector whose `MapData.sectorTypes` maps to the SAME theme entry
 *     (junction minors are excluded as authored-neutral — a junction node
 *     belongs to four districts; the Citadel vault beacon is the one
 *     sanctioned tier-hue exception, map-wide exactly one);
 *   - discipline: `lintHueDiscipline` + `lintValueBand` return ZERO
 *     violations over the adapted placements.
 *
 * Fixture-derived (no browser): the placements under test are read from the
 * pinned `lights-seed-*.json` goldens themselves — the same pins the
 * byte-identity suite in `LightPlacementsGolden.test.ts` guards — so the
 * hue-discipline assertion "beacon ∈ its district theme" is enforced at the
 * exact layer the golden fixtures pin. The same-seed `MapData` (sectorTypes,
 * landmarks, fortress) is regenerated in-process for the cross-join.
 *
 * Server-authoritative: every color under test was authored by the shared
 * generation into `MapData`; the SeedMapAdapter/LandmarkBeaconPlacer are
 * pure projections (verified here by the one-placement-per-source check).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BEACON_THEME_LIGHT,
  BEACON_TIER_LIGHT,
  MINOR_LANDMARK_LIGHT,
  SECTOR_TILE_SIZE,
  MapGenerator,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import { lintHueDiscipline, lintValueBand } from '../LightingDiscipline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__');

const GOLDEN_SEEDS = [
  { seed: 1, file: 'lights-seed-1.json' },
  { seed: 42, file: 'lights-seed-42.json' },
  { seed: 999, file: 'lights-seed-999.json' },
  { seed: 0xdeadbeef, file: 'lights-seed-3735928559.json' },
] as const;

/** Canonical string key for a linear-RGB color (fixture JSON ↔ table compare). */
function colorKey(color: readonly number[] | number[]): string {
  return JSON.stringify(color);
}

/** The authored beacon color set: theme table + Citadel RARE + minor neutral. */
const AUTHORED_BEACON_COLORS = new Set<string>([
  ...Object.values(BEACON_THEME_LIGHT).map((entry) => colorKey(entry.color)),
  colorKey(BEACON_TIER_LIGHT.RARE.color),
  colorKey(MINOR_LANDMARK_LIGHT.color),
]);

/** One golden-seed scenario: the pinned placements + the same seed's MapData. */
function buildScenario(seed: number, file: string) {
  const placements = JSON.parse(
    readFileSync(join(fixturesDir, file), 'utf-8'),
  ) as LightPlacementTiled[];
  const mapData = new MapGenerator().generate(seed);
  // Index the MapData beacon sources by tile key ("tileX,tileY" === the
  // placement's "gridX,gridY" — LandmarkBeaconPlacer copies them verbatim).
  const heroAt = new Map<string, { row: number; col: number }>();
  mapData.landmarks.heroes.forEach((row, r) => {
    row.forEach((hero, c) => heroAt.set(`${hero.tileX},${hero.tileY}`, { row: r, col: c }));
  });
  const minorAt = new Set<string>(mapData.landmarks.minors.map((m) => `${m.tileX},${m.tileY}`));
  const fortressKey = mapData.fortress
    ? `${mapData.fortress.beacon.tileX},${mapData.fortress.beacon.tileY}`
    : null;
  return { seed, file, placements, mapData, heroAt, minorAt, fortressKey };
}

const scenarios = GOLDEN_SEEDS.map(({ seed, file }) => buildScenario(seed, file));

/** The sector coordinates a placement's grid position falls inside. */
function sectorOf(p: LightPlacementTiled): { row: number; col: number } {
  return {
    row: Math.floor(p.gridY / SECTOR_TILE_SIZE),
    col: Math.floor(p.gridX / SECTOR_TILE_SIZE),
  };
}

describe('Beacon theme projection over the lights goldens (map-polish ticket 04)', () => {
  for (const s of scenarios) {
    describe(`seed ${s.seed}`, () => {
      const beacons = s.placements.filter((p) => p.kind === 'beacon');

      it('every beacon color is a member of the authored set (theme ∪ Citadel RARE ∪ minor neutral)', () => {
        expect(beacons.length).toBeGreaterThanOrEqual(18); // 16 heroes + 2–3 minors + fortress
        for (const p of beacons) {
          expect(p.color, `beacon at ${p.gridX},${p.gridY} carries a color`).toBeDefined();
          expect(
            AUTHORED_BEACON_COLORS.has(colorKey(p.color!)),
            `beacon at ${p.gridX},${p.gridY} color ${colorKey(p.color!)} is authored`,
          ).toBe(true);
        }
      });

      it('every hero beacon wears the theme entry of the sector it stands in', () => {
        let checked = 0;
        for (const p of beacons) {
          const key = `${p.gridX},${p.gridY}`;
          if (!s.heroAt.has(key)) continue;
          const hero = s.heroAt.get(key)!;
          // The position-derived sector IS the hero's own sector (the anchor
          // is an interior sector tile by construction) — assert both, then
          // the theme consistency: sectorTypes at that position maps to a
          // BEACON_THEME_LIGHT entry whose color the placement carries.
          const pos = sectorOf(p);
          expect(pos).toEqual(hero);
          const type = s.mapData.sectorTypes[hero.row]![hero.col]!;
          expect(
            p.color,
            `hero beacon at ${key} (sector ${hero.row},${hero.col} type ${type})`,
          ).toEqual(BEACON_THEME_LIGHT[type].color);
          checked++;
        }
        expect(checked).toBe(16); // one hero per sector, all projected
      });

      it('junction minors carry the authored neutral marker color (excluded from the theme check)', () => {
        for (const p of beacons) {
          if (!s.minorAt.has(`${p.gridX},${p.gridY}`)) continue;
          // Authored-neutral: a junction node belongs to four districts, so
          // the minor marker deliberately speaks NO single theme.
          expect(p.color).toEqual(MINOR_LANDMARK_LIGHT.color);
        }
        // Every minor source has its placement (minors are never dropped).
        expect([...s.minorAt].length).toBeGreaterThanOrEqual(2);
      });

      it('fortress beacon: theme of its own sector on standard compounds, sanctioned RARE violet on Citadel', () => {
        const fortress = s.mapData.fortress;
        expect(fortress, 'procedural golden seeds always carry a fortress').not.toBeNull();
        const placement = beacons.find((p) => `${p.gridX},${p.gridY}` === s.fortressKey);
        expect(placement, 'the fortress beacon placement is projected').toBeDefined();
        if (fortress!.variant === 'CITADEL') {
          // The ONE sanctioned tier-hue exception: the vault beacon stays
          // RARE violet (map-wide exactly one such beacon).
          expect(placement!.color).toEqual(BEACON_TIER_LIGHT.RARE.color);
        } else {
          // Standard compound: the beacon anchor sector's TYPE hue — the
          // position-derived sector maps to the same theme entry.
          const type = s.mapData.sectorTypes[sectorOf(placement!).row]![sectorOf(placement!).col]!;
          expect(placement!.color).toEqual(BEACON_THEME_LIGHT[type].color);
        }
      });

      it('projection completeness — exactly one placement per MapData beacon source, no strays', () => {
        const expected = 16 + s.minorAt.size + (s.mapData.fortress ? 1 : 0); // heroes + minors + fortress
        expect(beacons).toHaveLength(expected);
        // Every beacon maps to exactly one known source (hero/minor/fortress).
        for (const p of beacons) {
          const key = `${p.gridX},${p.gridY}`;
          const isHero = s.heroAt.has(key);
          const isMinor = s.minorAt.has(key);
          const isFortress = key === s.fortressKey;
          const sources = [isHero, isMinor, isFortress].filter(Boolean).length;
          expect(sources, `beacon at ${key} maps to exactly one source`).toBe(1);
        }
      });

      it('lintHueDiscipline + lintValueBand return ZERO violations over the pinned placements', () => {
        // The discipline gates over the FINAL adapted placements — the same
        // list the fixtures pin (post hue-discipline enforcement).
        expect(lintHueDiscipline(s.placements)).toHaveLength(0);
        expect(lintValueBand(s.placements)).toHaveLength(0);
      });
    });
  }
});
