/**
 * Map-redesign ticket 05 / DEC-005 — lighting discipline gate tests.
 *
 * The data-layer equivalents of the ticket's browser/screenshot checks (per
 * the deterministic-map verification directive):
 *   - ≤3 active light hues per sector viewport (lint + enforcement).
 *   - Value band: no static light out-values the player/VFX band — the
 *     numeric form of the "grayscale screenshot of a HOT sector fight"
 *     check: static ≤ STATIC_VALUE_CEILING < PLAYER_VFX_VALUE_FLOOR, plus
 *     the beacon tier value ordering (the grayscale double-coding).
 *   - Dark pockets: pocket tiles are walkable floor (the aura coverage
 *     argument — a player standing there carries their own 640px aura) and
 *     COLD sectors keep the deepest dark.
 *   - On-screen budget: the worst sampled viewport's static count stays far
 *     below the ≤80 client target across a seed sample.
 *   - The full-map report on the real generation pipeline (seed sample):
 *     zero residual violations, pools present, totals within the budget.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEACON_TIER_LIGHT,
  BEACON_THEME_LIGHT,
  BEACON_INTENSITY_MAX,
  BEACON_INTENSITY_MIN,
  BEACON_RADIUS,
  CITADEL_BEACON_RADIUS,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  TileType,
  SectorType,
  effectiveSectorTier,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import { MapGenerator as SharedMapGenerator } from '@sector-battle/shared';
import {
  hueFamilyOf,
  placementHueFamily,
  lintHueDiscipline,
  enforceHueDiscipline,
  lintValueBand,
  resolvedIntensity,
  resolvedRadius,
  findDarkPockets,
} from '../LightingDiscipline.js';
import { DOORWAY_SCONCE_COLOR, DOORWAY_SCONCE_KIND } from '../LightPlacerDoorway.js';
import { buildLightingReport } from '../LightingReportBuilder.js';
import { MAX_MAP_LIGHT_PLACEMENTS } from '../LightPlacer.js';
import {
  DARK_POCKET_LIGHT_DISTANCE,
  MAX_HUE_FAMILIES_PER_SECTOR,
  PLAYER_VFX_VALUE_FLOOR,
  POI_GLOW_LIGHT,
  STATIC_VALUE_CEILING,
} from '../lightHierarchyConfig.js';
import { SeedMapAdapter } from '../SeedMapAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

const SEEDS = [1, 42, 999, 0xdeadbeef] as const;

/** A bare placement factory for lint-level tests. */
function placement(
  gridX: number,
  gridY: number,
  kind: LightPlacementTiled['kind'],
  extra?: Partial<LightPlacementTiled>,
): LightPlacementTiled {
  return { gridX, gridY, kind, rotation: 0, flipH: false, flipV: false, ...extra };
}

// ─── Hue families (#5) ────────────────────────────────────────────────────────

describe('LightingDiscipline — hue families', () => {
  it('clusters the authored palette colors into the expected families', () => {
    // The fire family (flames + warm sconces) is ONE family.
    expect(hueFamilyOf([1.0, 0.55, 0.22])).toBe('warm'); // flame base
    expect(hueFamilyOf(POI_GLOW_LIGHT.color as [number, number, number])).toBe('warm'); // the pool
    // Beacon THEME colors (map-polish ticket 03 — hue=theme, value=tier):
    // the hue keys on the sector TYPE, matching each identity-sheet wall
    // tint's family — GRID steel-blue + the minor marker cluster with the
    // cool family, MAZE violet is its own, OPEN green is the biome band,
    // RICH gold merges with the fire family (one family with the sconces).
    const themeColor = (t: SectorType): [number, number, number] =>
      BEACON_THEME_LIGHT[t].color as [number, number, number];
    expect(hueFamilyOf(themeColor(SectorType.GRID_ARENA))).toBe('blue');
    expect(hueFamilyOf(themeColor(SectorType.OPEN_ARENA))).toBe('green');
    expect(hueFamilyOf(themeColor(SectorType.MAZE))).toBe('violet');
    expect(hueFamilyOf(themeColor(SectorType.RESOURCE_RICH))).toBe('warm');
    // The tier table's RARE violet stays live for the Citadel vault beacon
    // (the one sanctioned tier-hue exception — map-wide there is exactly one).
    expect(hueFamilyOf(BEACON_TIER_LIGHT.RARE.color as [number, number, number])).toBe('violet');
    // Biome crystal hues: emerald green, labyrinth teal, industrial azure
    // blue, spectral violet — four DISTINCT families (the biome identity).
    expect(hueFamilyOf([0.16, 0.44, 0.2])).toBe('green');
    expect(hueFamilyOf([0.16, 0.4, 0.44])).toBe('teal');
    expect(hueFamilyOf([0.18, 0.28, 0.48])).toBe('blue');
    expect(hueFamilyOf([0.3, 0.14, 0.44])).toBe('violet');
    // The minor-landmark neutral-cool marker clusters with the cool family.
    expect(hueFamilyOf([0.72, 0.78, 0.92])).toBe('blue');
  });

  it('placements without a color override resolve their kind default family', () => {
    expect(placementHueFamily(placement(1, 1, 'torch'))).toBe('warm');
    expect(placementHueFamily(placement(1, 1, 'beacon'))).toBe('warm'); // gold default
  });
});

// ─── Ticket 18 — the fixed doorway tone holds the discipline ──────────────────

describe('LightingDiscipline — ticket-18 doorway tone (one prop, one tone)', () => {
  it('the fixed doorway tone sits in the WARM family (cannot add a 4th family anywhere)', () => {
    // The uniform tone is the menu registry's TONE_WARM warm fire — hue ≈25°,
    // inside the [0°,60°) band shared with every other fire sconce, the POI
    // pools and the RICH gold beacons. A uniform tone can only ever SHRINK a
    // viewport's family set (pre-ticket the doorway layer drew candle/lantern
    // gold + brazier/fireplace variants), so the ≤3-families gate stays safe.
    expect(hueFamilyOf(DOORWAY_SCONCE_COLOR)).toBe('warm');
    expect(
      placementHueFamily(placement(1, 1, DOORWAY_SCONCE_KIND, { color: DOORWAY_SCONCE_COLOR })),
    ).toBe('warm');
  });

  it('the fixed doorway sconce resolves inside the static value band (no override)', () => {
    // Ticket 18 pins the TONE only — radius/intensity stay the torch kind
    // defaults (256px / 1.9), which sit ≤ STATIC_VALUE_CEILING (2.6), so the
    // value-band gate cannot trip on the doorway layer.
    const p = placement(1, 1, DOORWAY_SCONCE_KIND, { color: DOORWAY_SCONCE_COLOR });
    expect(resolvedIntensity(p)).toBeLessThanOrEqual(STATIC_VALUE_CEILING);
    expect(lintValueBand([p])).toHaveLength(0);
  });
});

// ─── ≤3 families per sector viewport — lint + enforcement (#5) ────────────────

describe('LightingDiscipline — ≤3 hue families per sector viewport', () => {
  it('a 4-family sector is flagged; a 3-family sector passes', () => {
    // Sector (0,0): fire sconce (warm) + COLD-blue beacon + emerald crystal
    // (green) + violet RARE beacon-in-the-same-sector = 4 families.
    const violating = [
      placement(2, 2, 'torch'),
      placement(5, 5, 'beacon', { color: BEACON_TIER_LIGHT.COLD.color }),
      placement(8, 8, 'biome-glow', { color: [0.16, 0.44, 0.2] }),
      placement(11, 11, 'beacon', { color: BEACON_TIER_LIGHT.RARE.color }),
    ];
    const violations = lintHueDiscipline(violating);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.sectorRow).toBe(0);
    expect(violations[0]!.sectorCol).toBe(0);
    expect(violations[0]!.count).toBe(4);

    // Drop the violet beacon (3 families left: warm/blue/green) → clean.
    expect(lintHueDiscipline(violating.slice(0, 3))).toHaveLength(0);
  });

  it('sectors are bucketed independently (a violation in one sector only)', () => {
    const placements = [
      // Sector (0,0): 4 families → violation.
      placement(2, 2, 'torch'),
      placement(5, 5, 'beacon', { color: BEACON_TIER_LIGHT.COLD.color }),
      placement(8, 8, 'biome-glow', { color: [0.16, 0.44, 0.2] }),
      placement(11, 11, 'beacon', { color: BEACON_TIER_LIGHT.RARE.color }),
      // Sector (0,1): 3 families → clean.
      placement(22, 2, 'torch'),
      placement(25, 5, 'beacon', { color: BEACON_TIER_LIGHT.COLD.color }),
      placement(28, 8, 'biome-glow', { color: [0.16, 0.44, 0.2] }),
    ];
    const violations = lintHueDiscipline(placements);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.sectorCol).toBe(0);
  });

  it('enforcement drops the discretionary CRYSTAL, never a beacon', () => {
    // The classic 4-family corner: warm sconces + cool COLD beacon + emerald
    // crystal + violet RARE marker in one sector. The gate must drop the
    // crystal (the mood accent) and keep every beacon (ticket 04 contract).
    const placements = [
      placement(2, 2, 'torch'),
      placement(2, 6, 'candle'),
      placement(5, 5, 'beacon', { color: BEACON_TIER_LIGHT.COLD.color }),
      placement(8, 8, 'biome-glow', { color: [0.16, 0.44, 0.2] }),
      placement(11, 11, 'beacon', { color: BEACON_TIER_LIGHT.RARE.color }),
    ];
    const { placements: kept, enforcements } = enforceHueDiscipline(placements);
    expect(kept.some((p) => p.kind === 'biome-glow')).toBe(false); // crystal dropped
    expect(kept.filter((p) => p.kind === 'beacon')).toHaveLength(2); // beacons kept
    expect(kept.filter((p) => p.kind === 'torch' || p.kind === 'candle')).toHaveLength(2);
    expect(enforcements).toHaveLength(1);
    expect(enforcements[0]!.droppedKind).toBe('biome-glow');
    expect(enforcements[0]!.sectorRow).toBe(0);
    expect(enforcements[0]!.sectorCol).toBe(0);
    // Post-enforcement the list lints clean.
    expect(lintHueDiscipline(kept)).toHaveLength(0);
  });

  it('enforcement is a no-op on a clean list', () => {
    const clean = [
      placement(2, 2, 'torch'),
      placement(5, 5, 'beacon', { color: BEACON_TIER_LIGHT.HOT.color }),
    ];
    const result = enforceHueDiscipline(clean);
    expect(result.enforcements).toHaveLength(0);
    expect(result.placements).toHaveLength(2);
  });

  it(`the discipline limit is ${MAX_HUE_FAMILIES_PER_SECTOR} (DEC-005 #5)`, () => {
    expect(MAX_HUE_FAMILIES_PER_SECTOR).toBe(3);
  });
});

// ─── Value band (#6) — the grayscale-screenshot equivalent ───────────────────

describe('LightingDiscipline — value band (no static out-values the combat band)', () => {
  it('the numeric chain holds: static ceiling < player/VFX floor', () => {
    // The ceiling equals the beacon band max (the brightest static kind) and
    // sits strictly below the explosion-flash band (~4.1) — in a grayscale
    // view no static light can out-value the combat feedback.
    expect(STATIC_VALUE_CEILING).toBe(BEACON_INTENSITY_MAX);
    expect(STATIC_VALUE_CEILING).toBeLessThan(PLAYER_VFX_VALUE_FLOOR);
    expect(PLAYER_VFX_VALUE_FLOOR).toBeLessThanOrEqual(4.1);
  });

  it('the beacon tier value ordering is the grayscale double-coding (HOT > RARE > WARM > COLD)', () => {
    expect(BEACON_TIER_LIGHT.HOT.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.RARE.intensity);
    expect(BEACON_TIER_LIGHT.RARE.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.WARM.intensity);
    expect(BEACON_TIER_LIGHT.WARM.intensity).toBeGreaterThan(BEACON_TIER_LIGHT.COLD.intensity);
    // …and every tier sits inside the [2.45, 2.6] band (map-polish ticket 01
    // moody retune) — the brightest static lights on the map by radius
    // dominance, still under the player/VFX band.
    for (const tier of Object.values(BEACON_TIER_LIGHT)) {
      expect(tier.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
      expect(tier.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
    }
    // The hierarchy value order stays legible: every tier > brazier (2.1) >
    // POI pool (1.7) — destination > road > reward-pool glow.
    expect(BEACON_INTENSITY_MIN).toBeGreaterThan(resolvedIntensity(placement(1, 1, 'brazier')));
    expect(resolvedIntensity(placement(1, 1, 'brazier'))).toBeGreaterThan(POI_GLOW_LIGHT.intensity);
  });

  it('wiring audit: the server mirror agrees with the shared single source of truth', () => {
    // The `KIND_DEFAULT_LIGHT.beacon` mirror (this package's
    // LightingDiscipline.ts), the shared generation constants
    // (`landmarks.ts`), and the client `HERO_LIGHT_OVERRIDES.beacon` fallback
    // (asserted in the client BeaconLandmark suite) must all hold the SAME
    // radius/intensity for the beacon kind — the fallback is what renders
    // when a placement carries no explicit override, so a drift here would
    // desync the discipline gate from the realized light.
    const beacon = placement(1, 1, 'beacon');
    expect(resolvedRadius(beacon)).toBe(BEACON_RADIUS);
    expect(resolvedIntensity(beacon)).toBe(BEACON_INTENSITY_MAX);
  });

  it('dark-pocket reach: DARK_POCKET_LIGHT_DISTANCE still exceeds every beacon radius', () => {
    // Map-polish ticket 01 pulled the beacon radii in (hero 576→512,
    // Citadel 640→576). The pocket finder's light-reach distance (5 tiles,
    // Manhattan) must still sit beyond the WIDEST static light reach so a
    // "dark pocket" tile is genuinely outside every light disk (Citadel 576px
    // = 4.5 tiles < 5; hero 512px = 4 tiles < 5) — no behavior change.
    expect(DARK_POCKET_LIGHT_DISTANCE).toBeGreaterThan(CITADEL_BEACON_RADIUS / TILE_PIXEL_SIZE);
    expect(DARK_POCKET_LIGHT_DISTANCE).toBeGreaterThan(BEACON_RADIUS / TILE_PIXEL_SIZE);
  });

  it('every authored static kind + override resolves at or below the ceiling', () => {
    const kinds: LightPlacementTiled['kind'][] = [
      'torch',
      'campfire',
      'candle',
      'fireplace',
      'brazier',
      'lantern',
      'biome-glow',
      'beacon',
    ];
    for (const kind of kinds) {
      expect(resolvedIntensity(placement(1, 1, kind))).toBeLessThanOrEqual(STATIC_VALUE_CEILING);
    }
    // The ticket-05 authored overrides (the POI pool tune).
    expect(POI_GLOW_LIGHT.intensity).toBeLessThanOrEqual(STATIC_VALUE_CEILING);
    expect(
      resolvedIntensity(placement(1, 1, 'brazier', { intensity: POI_GLOW_LIGHT.intensity })),
    ).toBeLessThanOrEqual(STATIC_VALUE_CEILING);
  });

  it('an out-of-band static intensity is flagged by the lint', () => {
    const violations = lintValueBand([
      placement(1, 1, 'torch', { intensity: 3.4 }), // over the 2.6 ceiling
      placement(4, 4, 'torch'), // 1.9 default — fine
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('torch');
    expect(violations[0]!.intensity).toBe(3.4);
    expect(violations[0]!.ceiling).toBe(STATIC_VALUE_CEILING);
  });
});

// ─── Dark pockets — the data-level aura coverage check ───────────────────────

describe('LightingDiscipline — dark pockets (walkable, aura-covered)', () => {
  it('finds contiguous unlit walkable regions; every pocket tile is walkable floor', () => {
    // 40×20 grid, all EMPTY. One light at (2,2): everything ≥ DARK_POCKET_
    // LIGHT_DISTANCE (5, Manhattan) away is dark.
    const grid: TileType[][] = [];
    for (let r = 0; r < 20; r++) grid.push(new Array<TileType>(40).fill(TileType.EMPTY));
    const pockets = findDarkPockets(grid, [placement(2, 2, 'torch')]);
    expect(pockets.length).toBeGreaterThan(0);
    // The aura-coverage contract: darkness is cosmetic-only — every pocket
    // tile is WALKABLE floor (a player standing there carries their own
    // always-on 640px aura; dark = mood/risk, never invisible agents).
    for (const pocket of pockets) {
      expect(pocket.size).toBeGreaterThanOrEqual(4);
      for (const tile of pocket.tiles) {
        expect(grid[tile.gridY]![tile.gridX]).toBe(TileType.EMPTY);
      }
    }
    // A wall tile is never part of a pocket (not walkable, not lit-concern).
    grid[10]![20] = TileType.INDESTRUCTIBLE_WALL;
    const withWall = findDarkPockets(grid, [placement(2, 2, 'torch')]);
    for (const pocket of withWall) {
      for (const tile of pocket.tiles) {
        expect(grid[tile.gridY]![tile.gridX]).toBe(TileType.EMPTY);
      }
    }
  });

  it('a fully-lit grid has no pockets', () => {
    const grid: TileType[][] = [];
    for (let r = 0; r < 10; r++) grid.push(new Array<TileType>(10).fill(TileType.EMPTY));
    // A torch every 4 tiles lights everything within distance 5.
    const lights: LightPlacementTiled[] = [];
    for (let r = 2; r < 10; r += 4) {
      for (let c = 2; c < 10; c += 4) lights.push(placement(c, r, 'torch'));
    }
    expect(findDarkPockets(grid, lights)).toHaveLength(0);
  });
});

// ─── On-screen budget + the full-map report (the seed-sample checks) ─────────

describe('LightingDiscipline — budget report on the real pipeline (seed sample)', () => {
  const adapterResults = SEEDS.map((seed) => {
    const mapData = new SharedMapGenerator().generate(seed);
    const enriched = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
    const tiers = { tiers: mapData.sectorTiers, hotSector: mapData.hotSector };
    const report = buildLightingReport(
      enriched.entities.lightPlacements,
      enriched.grid,
      enriched.lightingEnforcements ?? [],
      (row, col) => effectiveSectorTier(tiers, row, col),
      mapData.connections,
    );
    return { seed, enriched, report, mapData };
  });

  it('every seed: zero residual hue violations, zero value-band violations', () => {
    for (const { report } of adapterResults) {
      expect(report.hueViolations).toHaveLength(0);
      expect(report.valueBandViolations).toHaveLength(0);
    }
  });

  it('every seed: the POI glow layer exists (pooled, not per chest)', () => {
    for (const { enriched, report } of adapterResults) {
      expect(report.poiGlowPools).toBeGreaterThan(0);
      expect(report.poiGlowPools).toBeLessThanOrEqual(16); // ≤1 accent per sector
      // Pooled: pools ≪ chest count (never per chest).
      expect(enriched.entities.chests.length).toBeGreaterThan(report.poiGlowPools);
    }
  });

  it('every seed: the worst sampled viewport is far below the ≤80 on-screen target', () => {
    for (const { report } of adapterResults) {
      expect(report.viewportSamples).toBeGreaterThan(0);
      expect(report.maxViewportStatics).toBeLessThanOrEqual(80);
      // Headroom for the ~24 dynamic player auras + VFX the client budget
      // trims top-priority-first.
      expect(report.maxViewportStatics).toBeLessThanOrEqual(20);
    }
  });

  it('every seed: dark pockets exist and COLD sectors hold them', () => {
    for (const { report, mapData } of adapterResults) {
      expect(report.darkPockets.count).toBeGreaterThan(0);
      // Every COLD sector (effective tier) has at least one pocket — the
      // DEC-005 dark-pocket mood guarantee (fill REMOVED in cold/outer).
      const coldSectors: Array<[number, number]> = [];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (
            effectiveSectorTier(
              { tiers: mapData.sectorTiers, hotSector: mapData.hotSector },
              r,
              c,
            ) === 'COLD'
          ) {
            coldSectors.push([r, c]);
          }
        }
      }
      expect(coldSectors.length).toBeGreaterThanOrEqual(4); // pyramid: ~5 COLD
      expect(report.darkPockets.coldSectorPockets).toBeGreaterThanOrEqual(coldSectors.length);
      expect(report.darkPockets.sectorsWithPockets).toBeLessThanOrEqual(16);
    }
  });

  it('every seed: total placements within the budget system (≤ cap + beacons)', () => {
    for (const { enriched, report } of adapterResults) {
      const beacons = enriched.entities.lightPlacements.filter((p) => p.kind === 'beacon').length;
      expect(beacons).toBeGreaterThanOrEqual(18); // 16 heroes + 2–3 minors
      expect(report.total).toBe(enriched.entities.lightPlacements.length);
      // The D3 safety ceiling covers the non-beacon layers. Map-polish ticket
      // 10 rebalanced it 80 → 112 to hold the doubled doorway layer (48
      // doorway + worst-observed 16 campfires + 19 discretionary = 83 ≈ 26%
      // slack under 112 — a guard, never a target).
      expect(report.total - beacons).toBeLessThanOrEqual(MAX_MAP_LIGHT_PLACEMENTS);
    }
  });

  it('every seed: doorway sconce pairs are complete + symmetric (ticket 10 addendum audit)', () => {
    // Coordinated pair stepping (ticket-10 ADDENDUM repair): both members
    // take the first ladder rung BOTH can hold (band end → outward →
    // travel-inward), so mirror symmetry and the 2-lights-per-passage
    // guarantee hold together. Counts re-measured after the map-polish
    // ticket-05 cascade (plaza stamping shifts the entity pools the ladder
    // reads; sanctioned re-pin per the repair ruling): seeds 1 (24/0) and
    // 999 (24/0) stay clean; seed 0xdeadbeef's pre-05 exit-blocked aperture
    // (0,1)-(0,2) RECOVERED as a coordinated OUTWARD pair ((39,8)/(39,12))
    // because the entity cascade moved the exit/chair blockers off the rung
    // tiles ⇒ 24/0. Seed 42 picks up the one honestly-asymmetric aperture
    // (0,3)-(1,3): member 0's band end (69,19) is claimed by an EXIT prop
    // and its travel-inward rung (69,18) by a weapon spawn (outward (68,19)
    // is wall) ⇒ no solo rung, survivor torch on member 1's band end (71,19)
    // ⇒ 23/1, audited. Full per-seed aperture evidence lives in
    // LightPlacer.test.ts ("Anchor B doorway sconce PAIRS").
    // Ticket-14 wall-composition cascade: seed 42's honestly-asymmetric
    // aperture (0,3)-(1,3) HEALED (entity cascade moved the EXIT prop +
    // weapon spawn off the rung tiles) ⇒ 24/0 on every standard seed.
    // Ticket-16 (7f6f753e, beacon plaza archetype grammar): seed 1 picked up
    // the one honestly-asymmetric aperture — (0,1)-(0,2) H (axis row 10) ⇒
    // 23/1 (see LightPlacer.test.ts for the full ticket-16 evidence).
    // Ticket-24 (the beacon keep: ONE authored ∩-shaped wall structure
    // around every hero beacon, replacing the 4-archetype grammar)
    // re-measure: seed 1's degraded aperture HEALED (the keep-shifted
    // entity pool moved the EXIT prop off the rung tiles) ⇒ 24/0, while
    // seed 999 picks up the one honestly-asymmetric aperture — (0,2)-(0,3)
    // H (axis row 10): member 0's band end (59,9) is claimed by an EXIT prop
    // (wall_demolished), outward (59,8) is INDESTRUCTIBLE_WALL, travel-
    // inward (58,9) a tree destructible ⇒ no solo rung, survivor torch on
    // member 1's band end (59,11) ⇒ 23/1, re-derived from the seed-999 map
    // data (grid + adapter collections at every rung; the same
    // genuine-degradation class the round-1 ticket-05 repair sanctioned on
    // seed 42).
    // Round-8 run-join-guard cascade (v17): seed 999's ticket-24 degraded
    // aperture (0,2)-(0,3) H HEALED — the re-clipped stamps shifted the
    // entity pools the ladder reads, moving the EXIT prop (wall_demolished)
    // off member 0's band end rungs — the same entity-pool lottery as the
    // ticket-14/24 re-measures ⇒ 24/0 on every standard seed.
    const expectedAsymmetric: Record<number, number> = { 1: 0, 42: 0, 999: 0 };
    expectedAsymmetric[0xdeadbeef] = 0;
    for (const { seed, report, mapData } of adapterResults) {
      expect(report.doorwaySconcePairs).toBe(
        mapData.connections.length - expectedAsymmetric[seed]!,
      );
      expect(report.doorwayAsymmetric).toBe(expectedAsymmetric[seed]!);
    }
  });

  it('same seed ⇒ identical report (determinism)', () => {
    const first = adapterResults[0]!;
    const mapData = new SharedMapGenerator().generate(first.seed);
    const enriched = new SeedMapAdapter().adapt(mapData, first.seed, TILED_DIR);
    const tiers = { tiers: mapData.sectorTiers, hotSector: mapData.hotSector };
    const report = buildLightingReport(
      enriched.entities.lightPlacements,
      enriched.grid,
      enriched.lightingEnforcements ?? [],
      (row, col) => effectiveSectorTier(tiers, row, col),
      mapData.connections,
    );
    expect(JSON.stringify(report)).toBe(JSON.stringify(first.report));
  });
});
