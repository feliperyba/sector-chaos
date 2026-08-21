/**
 * LightingDiscipline — the DEC-005 discipline gates for the lighting
 * hierarchy (map-redesign ticket 05), as PURE placement-data checks:
 *
 *   1. **≤3 active light hue families per sector viewport** (#5): a
 *      placement-level lint + enforcement pass (the discretionary biome
 *      crystal is dropped when a sector would exceed the limit — beacons
 *      and minor-landmark lights are never dropped). Violations are
 *      reported so the benchmark generation manifest can log them.
 *   2. **Value-band rule** (#6): no STATIC light may out-value the
 *      player/VFX band — every static's resolved intensity ≤
 *      STATIC_VALUE_CEILING (= the beacon band max, 2.6), strictly below
 *      PLAYER_VFX_VALUE_FLOOR (the explosion-flash band ≈ 4.1). This is
 *      the data-layer equivalent of the ticket's grayscale-screenshot
 *      check: in a grayscale view no static light can out-value the
 *      combat band, so players/attacks stay the most visible things.
 *
 * Also here: the dark-pocket finder (the ticket's data-level aura coverage
 * check — every dark-pocket tile is WALKABLE floor, so a player standing
 * there carries their own always-on 640px aura). The on-screen light-count
 * sampler + the aggregate manifest report live in the `LightingReportBuilder`
 * partial (F8 file-length split).
 * All functions are pure — deterministic functions of their arguments.
 */
import {
  SECTOR_TILE_SIZE,
  TileType,
  type LightKind,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import {
  DARK_POCKET_LIGHT_DISTANCE,
  DARK_POCKET_MIN_TILES,
  MAX_HUE_FAMILIES_PER_SECTOR,
  STATIC_VALUE_CEILING,
} from './lightHierarchyConfig.js';

// ─── Kind default mirrors (client LightPalette, documented) ───────────────────
//
// The client resolves a placement's realized radius/intensity as
// `p.radius ?? HERO_LIGHT_OVERRIDES[kind]?.radius ?? DEFAULT_HERO_LIGHT.radius`
// (LightPacker.packLights). These mirrors restate that resolution server-side
// for the discipline checks — the light DATA is server-authored, so the gate
// belongs next to the placer. If the client tuning ever changes, update these
// in the same change (the ceiling itself only depends on the beacon band,
// which lives in the shared `landmarks.ts`).

const DEFAULT_LIGHT = { radius: 256, intensity: 1.9 } as const;

/** Resolved per-kind static radius/intensity (client HERO_LIGHT_OVERRIDES mirror). */
const KIND_DEFAULT_LIGHT: Readonly<
  Partial<Record<LightKind, { radius: number; intensity: number }>>
> = {
  torch: { radius: 256, intensity: 1.9 },
  campfire: { radius: 320, intensity: 2.6 },
  candle: { radius: 192, intensity: 1.4 },
  fireplace: { radius: 320, intensity: 2.6 },
  brazier: { radius: 240, intensity: 2.1 },
  lantern: { radius: 140, intensity: 1.3 },
  'biome-glow': { radius: 256, intensity: 1.9 },
  beacon: { radius: 512, intensity: 2.6 },
};

/** Resolved radius (world px) of a placement (per-placement override first). */
export function resolvedRadius(p: LightPlacementTiled): number {
  return p.radius ?? KIND_DEFAULT_LIGHT[p.kind]?.radius ?? DEFAULT_LIGHT.radius;
}

/** Resolved base intensity of a placement (per-placement override first). */
export function resolvedIntensity(p: LightPlacementTiled): number {
  return p.intensity ?? KIND_DEFAULT_LIGHT[p.kind]?.intensity ?? DEFAULT_LIGHT.intensity;
}

/** Default kind colors (client LightPalette mirror) used when a placement carries no `color`. */
const FIRE_COLOR: readonly [number, number, number] = [1.0, 0.55, 0.22];
const KIND_DEFAULT_COLOR: Readonly<Partial<Record<LightKind, readonly [number, number, number]>>> =
  {
    torch: FIRE_COLOR,
    campfire: FIRE_COLOR,
    candle: FIRE_COLOR,
    fireplace: FIRE_COLOR,
    brazier: FIRE_COLOR,
    lantern: FIRE_COLOR,
    'biome-glow': [0.4, 0.6, 1.0],
    beacon: [1.0, 0.83, 0.4],
  };

// ─── Hue families (#5) ────────────────────────────────────────────────────────

/** The hue families a sector viewport may hold (≤ MAX_HUE_FAMILIES_PER_SECTOR). */
export type HueFamily = 'warm' | 'green' | 'teal' | 'blue' | 'violet';

/** Hue-angle band edges (degrees) for family clustering. */
const FAMILY_BANDS: ReadonlyArray<{ family: HueFamily; lo: number; hi: number }> = [
  { family: 'warm', lo: 0, hi: 60 },
  { family: 'green', lo: 60, hi: 160 },
  { family: 'teal', lo: 160, hi: 210 },
  { family: 'blue', lo: 210, hi: 255 },
  { family: 'violet', lo: 255, hi: 360 },
];

/**
 * Cluster a linear-RGB color into a hue family (hue-angle bands). Beacon hues
 * are sector-theme-keyed (map-polish ticket 03, `BEACON_THEME_LIGHT`; degrees
 * per the ticket 15 retune):
 * RESOURCE_RICH ivory-gold (≈44.4°, the warm family shared with the fire),
 * GRID steel-blue (≈212.9°), MAZE violet (≈263.2°, the same color as the
 * Citadel's RARE violet vault beacon), OPEN_ARENA green (≈133.0°). The warm
 * band [0°,60°) covers the whole fire family (flames ≈25°, POI pools ≈34°,
 * RESOURCE_RICH ivory-gold beacons ≈44.4°) so a sector's sconces + POI glow +
 * gold beacon read as ONE family; the cool bands separate the biome crystal
 * hues (emerald≈129° green, teal≈189°, azure≈220° blue, violet ≈272°) and the
 * GRID steel-blue beacon (≈212.9°) / minor-marker (≈222°).
 */
export function hueFamilyOf(color: readonly [number, number, number]): HueFamily {
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

/** The hue family a PLACEMENT reads as (per-placement color override first). */
export function placementHueFamily(p: LightPlacementTiled): HueFamily {
  const color = p.color ?? KIND_DEFAULT_COLOR[p.kind];
  return color ? hueFamilyOf(color) : 'warm';
}

// ─── ≤3 families per sector viewport — lint + enforcement (#5) ────────────────

/** One sector-viewport hue violation (a sector holding >3 active families). */
export interface HueViolation {
  sectorRow: number;
  sectorCol: number;
  families: HueFamily[];
  count: number;
}

/**
 * Lint the placements: for each 20×20 sector viewport, collect the active
 * hue families and report every sector above `MAX_HUE_FAMILIES_PER_SECTOR`.
 * A sector's own beacon/minor/crystal/sconce lights all fall inside its
 * bounds (junction minors sit at sector corners), so the sector bucket IS
 * the "sector viewport" unit.
 */
export function lintHueDiscipline(placements: ReadonlyArray<LightPlacementTiled>): HueViolation[] {
  const perSector = new Map<string, Set<HueFamily>>();
  for (const p of placements) {
    const row = Math.floor(p.gridY / SECTOR_TILE_SIZE);
    const col = Math.floor(p.gridX / SECTOR_TILE_SIZE);
    const key = `${row},${col}`;
    let families = perSector.get(key);
    if (!families) {
      families = new Set();
      perSector.set(key, families);
    }
    families.add(placementHueFamily(p));
  }
  const violations: HueViolation[] = [];
  for (const [key, families] of perSector) {
    if (families.size > MAX_HUE_FAMILIES_PER_SECTOR) {
      const [sectorRow, sectorCol] = key.split(',').map(Number) as [number, number];
      violations.push({
        sectorRow,
        sectorCol,
        families: [...families],
        count: families.size,
      });
    }
  }
  // Deterministic order: row-major over sectors.
  violations.sort((a, b) => a.sectorRow - b.sectorRow || a.sectorCol - b.sectorCol);
  return violations;
}

/** One enforcement action (a discretionary light dropped to hold the ≤3 gate). */
export interface HueEnforcement {
  sectorRow: number;
  sectorCol: number;
  droppedKind: LightKind;
  droppedAt: { gridX: number; gridY: number };
  families: HueFamily[];
}

/**
 * ENFORCE the ≤3-families gate at placement time (DEC-005 #5): for each
 * violating sector, drop the sector's `biome-glow` signature crystal (the
 * discretionary mood accent — the beacon [tier identity, ticket 04: never
 * dropped], the minor-landmark light [identity], the sconce routes
 * [travel] and the POI glow [reward] all outrank it). Without crystals a
 * sector can hold at most {fire-warm, beacon, minor} = 3 families, so one
 * drop per violating sector always resolves; any residual violation (a
 * malformed placement list) is left for the lint to log in the manifest.
 * Deterministic: sectors row-major, drops in placement order.
 */
export function enforceHueDiscipline(placements: ReadonlyArray<LightPlacementTiled>): {
  placements: LightPlacementTiled[];
  enforcements: HueEnforcement[];
} {
  const kept = [...placements];
  const enforcements: HueEnforcement[] = [];
  // Process each violating sector (row-major). An unfixable violation (no
  // discretionary crystal left in that sector — a malformed input list) is
  // skipped so OTHER sectors' enforcements still run; the residual violation
  // is left for `lintHueDiscipline` to log in the manifest.
  const processed = new Set<string>();
  let violations = lintHueDiscipline(kept);
  while (violations.length > 0) {
    const violation = violations[0]!;
    const key = `${violation.sectorRow},${violation.sectorCol}`;
    processed.add(key);
    const idx = kept.findIndex(
      (p) =>
        p.kind === 'biome-glow' &&
        Math.floor(p.gridY / SECTOR_TILE_SIZE) === violation.sectorRow &&
        Math.floor(p.gridX / SECTOR_TILE_SIZE) === violation.sectorCol,
    );
    if (idx !== -1) {
      const dropped = kept.splice(idx, 1)![0]!;
      enforcements.push({
        sectorRow: violation.sectorRow,
        sectorCol: violation.sectorCol,
        droppedKind: dropped.kind,
        droppedAt: { gridX: dropped.gridX, gridY: dropped.gridY },
        families: violation.families,
      });
    }
    violations = lintHueDiscipline(kept).filter(
      (v) => !processed.has(`${v.sectorRow},${v.sectorCol}`),
    );
  }
  return { placements: kept, enforcements };
}

// ─── Value band (#6) ──────────────────────────────────────────────────────────

/** One value-band violation (a static placement out-valuing the ceiling). */
export interface ValueBandViolation {
  gridX: number;
  gridY: number;
  kind: LightKind;
  intensity: number;
  ceiling: number;
}

/**
 * Lint the value band: every STATIC placement's resolved intensity must stay
 * ≤ `STATIC_VALUE_CEILING` (the beacon band max — the brightest static kind
 * by contract) which sits strictly below the player/VFX band floor. The
 * numeric chain `static ≤ 2.6 < 4.0 ≈ explosion flash` is the data-layer
 * form of the ticket's grayscale-screenshot verification.
 */
export function lintValueBand(
  placements: ReadonlyArray<LightPlacementTiled>,
): ValueBandViolation[] {
  const violations: ValueBandViolation[] = [];
  for (const p of placements) {
    const intensity = resolvedIntensity(p);
    if (intensity > STATIC_VALUE_CEILING) {
      violations.push({
        gridX: p.gridX,
        gridY: p.gridY,
        kind: p.kind,
        intensity,
        ceiling: STATIC_VALUE_CEILING,
      });
    }
  }
  return violations;
}

// ─── Dark pockets (the data-level aura coverage check) ───────────────────────

/** A contiguous walkable region with no static light within `DARK_POCKET_LIGHT_DISTANCE`. */
export interface DarkPocket {
  sectorRow: number;
  sectorCol: number;
  size: number;
  /** Every pocket tile is walkable EMPTY floor — a player standing there carries their own 640px aura. */
  tiles: Array<{ gridX: number; gridY: number }>;
}

/**
 * Find the map's deliberate dark pockets: contiguous (4-connected) EMPTY
 * walkable regions whose tiles have NO static light within
 * `DARK_POCKET_LIGHT_DISTANCE` (Manhattan) — i.e. outside every static
 * light's reach. Pockets smaller than `DARK_POCKET_MIN_TILES` are ignored
 * (a 1-tile sliver is not a mood unit).
 *
 * This is the ticket's data-layer verification for "player visibility in
 * dark pockets": darkness is cosmetic-only (no fog-of-war semantics
 * anywhere in the server), and every pocket tile is walkable floor, so any
 * agent crossing it is lit by their own always-on 640px player aura
 * (client `LightPalette.aura`), which the client budget always keeps at
 * the top priority band. Dark = mood and risk, never invisible enemies.
 */
export function findDarkPockets(
  grid: TileType[][],
  placements: ReadonlyArray<LightPlacementTiled>,
): DarkPocket[] {
  const height = grid.length;
  const width = height > 0 ? grid[0]!.length : 0;
  const lit = (r: number, c: number): boolean => {
    for (const p of placements) {
      if (Math.abs(r - p.gridY) + Math.abs(c - p.gridX) <= DARK_POCKET_LIGHT_DISTANCE) return true;
    }
    return false;
  };
  const visited = new Uint8Array(height * width);
  const pockets: DarkPocket[] = [];
  for (let r = 0; r < height; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < width; c++) {
      if (row[c] !== TileType.EMPTY) continue;
      const idx = r * width + c;
      if (visited[idx]) continue;
      if (lit(r, c)) {
        visited[idx] = 1;
        continue;
      }
      // Flood-fill this dark region (4-connected, BFS).
      const tiles: Array<{ gridX: number; gridY: number }> = [];
      const queue: Array<{ r: number; c: number }> = [{ r, c }];
      visited[idx] = 1;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        tiles.push({ gridX: cur.c, gridY: cur.r });
        const neighbors = [
          { r: cur.r - 1, c: cur.c },
          { r: cur.r + 1, c: cur.c },
          { r: cur.r, c: cur.c - 1 },
          { r: cur.r, c: cur.c + 1 },
        ];
        for (const n of neighbors) {
          if (n.r < 0 || n.r >= height || n.c < 0 || n.c >= width) continue;
          const nIdx = n.r * width + n.c;
          if (visited[nIdx]) continue;
          if (grid[n.r]![n.c] !== TileType.EMPTY) continue;
          if (lit(n.r, n.c)) {
            visited[nIdx] = 1; // lit tile borders the pocket but is not part of it
            continue;
          }
          visited[nIdx] = 1;
          queue.push(n);
        }
      }
      if (tiles.length < DARK_POCKET_MIN_TILES) continue;
      const first = tiles[0]!;
      pockets.push({
        sectorRow: Math.floor(first.gridY / SECTOR_TILE_SIZE),
        sectorCol: Math.floor(first.gridX / SECTOR_TILE_SIZE),
        size: tiles.length,
        tiles,
      });
    }
  }
  return pockets;
}
