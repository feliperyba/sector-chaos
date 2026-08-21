import { SeededRNG } from './rng/SeededRNG.js';
import { avalanche } from './lootTiers.js';
import {
  LANDMARK_REGISTRY,
  LANDMARK_TYPE_ORDER,
  landmarkCompositionById,
  type LandmarkComposition,
} from './landmarkRegistry.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from './constants.js';
import { TileType } from '../enums/TileType.js';
import { SectorType, SectorLootTier, type SectorData } from './types.js';
import type { SectorTierAssignment } from './lootTiers.js';

/**
 * Hero landmarks + beacons + minor landmark nodes (map-redesign ticket 04 /
 * DEC-002 — "guarantee the memorable: reserve landmark slots, the dice choose
 * which and where, never whether"; the ticket-29 strip removed the baked
 * client dressing: the landmark's VISIBLE composition is the server-side
 * beacon keep + court floor + beacon light, never baked decor frames).
 *
 * Every sector reserves EXACTLY ONE hero landmark: the sector's signature
 * gameplay structure — the anchor site each skeleton builder exposes as data
 * (Ring Fortress sanctum, Central Monument plaza, Treasure Vault core, ...)
 * — composed over the grid layers by `landmarkPlaza.ts` (the keep) and
 * `FloorSpriteSelector` (the beacon-anchored court floor). Each hero carries
 * a beacon light placement: theme-colored (the sector TYPE's identity hue,
 * see `BEACON_THEME_LIGHT` — hue=theme, value=tier), slow pulse, radius ≥
 * 512, the brightest static light in its sector. Junction nodes get 2–3
 * minor landmarks per map (a small marker light; the ticket-29 strip removed
 * the baked prop frame + its `propId` draw), never adjacent to a hero.
 * Adjacent sectors never share a composition.
 *
 * Determinism (ADR 0035): ALL draws come from one isolated XOR-salted,
 * avalanche-mixed stream derived from the map seed —
 * `avalanche(seed ^ LANDMARK_SEED_XOR)` — never from the main pipeline RNG,
 * so adding landmarks can never perturb the tile/entity generation streams.
 * Beacon color+intensity are PURE lookups of `(sectorType, tier, rarity)` —
 * zero RNG: re-tuning the theme table (tickets 03/15) changes only the
 * looked-up `beacon.color` values, never a draw. Signature rotation is pure
 * seed arithmetic (no RNG); same seed ⇒ identical assignment.
 */

/**
 * Isolated RNG stream seed XOR constant for the landmark assignment pass
 * ('LNDM' in ASCII hex — same convention as lootTiers' 'TIER'/'HOTS' and
 * poiNames' 'NAME'/'DESG' salts).
 */
const LANDMARK_SEED_XOR = 0x4c4e444d;

/**
 * Seed band size for the signature-variant rotation. The per-type signature
 * composition index is `(seedBand + typeOrdinal) % entries.length` where
 * `seedBand = floor(seed / SEED_BAND_SIZE)`. Band 4 makes consecutive seeds
 * change the signature on ~75% of pairs (the DEC-002 "consecutive seeds
 * rarely repeat" read, mirroring the ≥60% hot-sector rotation gate), rotating
 * in coarse, learnable bands rather than per-seed churn.
 */
const SEED_BAND_SIZE = 4;

/** Weight of the per-map signature variant in the composition draw. */
const SIGNATURE_WEIGHT = 4;
/** Deliberately under-rolled RARE variant weight (common = 1). */
const RARE_WEIGHT = 0.35;
/** Bounded re-draw attempts when the drawn composition conflicts with a neighbor. */
const MAX_PICK_ATTEMPTS = 8;

/**
 * Beacon radius (world px). DEC-005: ≥ 512 (the SPEC §7 "radius ≥512" floor);
 * 512 = 4 tiles at 128px — the moody retune (map-polish ticket 01) pulled it
 * down from 576 so the disk reads as a focused distant destination glow.
 */
export const BEACON_RADIUS = 512;
/**
 * Citadel vault beacon radius (map-redesign ticket 06 / DEC-004.1): wider
 * than every hero beacon (512) so the vault light stays unambiguously the
 * STRONGEST static light on the map by RADIUS DOMINANCE — intensity sits AT
 * the `BEACON_INTENSITY_MAX` ceiling (2.6), preserving the DEC-005 value
 * band (static ≤ 2.6 < player/VFX floor 4).
 */
export const CITADEL_BEACON_RADIUS = 576;
/**
 * Beacon intensity band [2.45, 2.6] (map-polish ticket 01 moody retune, was
 * [2.6, 2.8]): the beacon stays the BRIGHTEST static light kind on the map —
 * HOT matches the campfire/fireplace peak (2.6) and the wider radius (512 vs
 * their 320) makes the beacon out-deliver every sconce beyond ~1.5 tiles
 * (radius dominance replaces pure value dominance); the whole band stays
 * under the explosion/projectile VFX band (≥ ~4) so the player/VFX value
 * band stays supreme (DEC-005). HOT > RARE > WARM > COLD is the double-coding.
 */
export const BEACON_INTENSITY_MIN = 2.45;
export const BEACON_INTENSITY_MAX = 2.6;

/**
 * Beacon tier light table (linear RGB + intensity). The loot tier is encoded
 * in INTENSITY only (ticket 03: hue=theme, value=tier — HOT > RARE > WARM >
 * COLD is the grayscale double-coding, SPEC user story 34); the tier COLORS
 * stay live only for the Citadel vault beacon (RARE violet; hero/compound
 * beacons hue via {@link BEACON_THEME_LIGHT}).
 */
export const BEACON_TIER_LIGHT: Readonly<
  Record<
    'HOT' | 'WARM' | 'COLD' | 'RARE',
    { color: readonly [number, number, number]; intensity: number }
  >
> = {
  HOT: { color: [1.0, 0.83, 0.4], intensity: 2.6 },
  WARM: { color: [1.0, 0.62, 0.3], intensity: 2.5 },
  COLD: { color: [0.45, 0.65, 1.0], intensity: 2.45 },
  RARE: { color: [0.72, 0.45, 1.0], intensity: 2.55 },
};

/**
 * Beacon THEME light table (ticket 03; TONES re-derived from the MAIN-MENU
 * light registry by round-2 ticket 15 — the owner's ground truth): each color
 * is the menu's `TONE_BIOME` accent for the sector's theme family (client
 * menuDioramaPlacements.ts — linear RGB, deliberately desaturated, paired by
 * the menu with crystal intensity 3.0 so INTENSITY carries the luminosity),
 * VALUE-normalized into the beacon convention by the uniform channel scale
 * `c ÷ max(tone)`: uniform scaling preserves HSV hue + saturation EXACTLY
 * (both are channel ratios) and only lifts the peak channel to 1.0 — the
 * convention every BEACON_TIER_LIGHT color follows — because beacon
 * intensity is tier-coded inside the fixed DEC-005 static band [2.45,2.6]
 * (a menu-style 3.0 would break the band), so the peak carries the value.
 * Derivations inline; the Citadel keeps BEACON_TIER_LIGHT.RARE violet (the
 * sanctioned exception); intensity always comes from the tier table.
 */
export const BEACON_THEME_LIGHT: Readonly<
  Record<SectorType, { color: readonly [number, number, number] }>
> = {
  // menu `TONE_BIOME` tone ÷ max → beacon (hue/sat preserved; wall-tint family):
  [SectorType.GRID_ARENA]: { color: [0.58, 0.77, 1.0] }, // forest-glade steel-blue [0.30,0.40,0.52]÷0.52 — 212.9° blue (tint 211°)
  [SectorType.OPEN_ARENA]: { color: [0.4, 1.0, 0.53] }, // forest-bonfire emerald [0.18,0.45,0.24]÷0.45 — 133.0° green (73° tint, same band)
  [SectorType.MAZE]: { color: [0.62, 0.38, 1.0] }, // crypt-antechamber violet [0.26,0.16,0.42]÷0.42 — 263.2° violet (tint 264°)
  [SectorType.RESOURCE_RICH]: { color: [1.0, 0.87, 0.5] }, // temple-threshold ivory-gold [0.60,0.52,0.30]÷0.60 — 44.4° warm (tint 40°)
};

/** Minor landmark light: small, steady, neutral-cool (a junction marker, not a tier signal). */
export const MINOR_LANDMARK_LIGHT = {
  color: [0.72, 0.78, 0.92] as const,
  radius: 176,
  intensity: 1.0,
};

/** Minimum Chebyshev distance (global tiles) between a minor node and any hero anchor. */
export const MINOR_HERO_MIN_CHEB = 6;
/** Minimum Chebyshev distance between two chosen minor nodes. */
export const MINOR_MINOR_MIN_CHEB = 8;

// ---------------------------------------------------------------------------
// Types (stored on MapData, ride the one-shot mapData payload)
// ---------------------------------------------------------------------------

/** The placed hero landmark for one sector. */
export interface HeroLandmark {
  /** Registry composition id (unique map-wide). */
  compositionId: string;
  /** Resolved rarity class: the per-map signature rotation upgrades one entry. */
  rarity: 'signature' | 'common' | 'rare';
  /** Final anchor tile, GLOBAL tile coords (row-major grid of 80×80). */
  tileX: number;
  tileY: number;
  /** Beacon light spec — the client + server light pipeline consume this verbatim. */
  beacon: {
    color: readonly [number, number, number];
    intensity: number;
    radius: number;
  };
}

/** A minor landmark at a junction node (a small marker light). */
export interface MinorLandmark {
  /** Placement tile, GLOBAL tile coords. */
  tileX: number;
  tileY: number;
  /** Small light spec. */
  light: {
    color: readonly [number, number, number];
    intensity: number;
    radius: number;
  };
}

/** The full landmark pass output, stored on MapData. */
export interface LandmarkAssignment {
  /** Hero landmark per sector (4×4, row-major). */
  heroes: HeroLandmark[][];
  /** 2–3 minor landmarks at junction nodes. */
  minors: MinorLandmark[];
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

/** Corridor-tile key format used by SectorConnector (`sRow,sCol,tRow,tCol`). */
function corridorKey(row: number, col: number, tileRow: number, tileCol: number): string {
  return `${row},${col},${tileRow},${tileCol}`;
}

/**
 * Whether a local sector tile is a valid hero anchor: interior (not the
 * border ring, so never a corridor/border tile) and EMPTY in the FINAL
 * post-refinement sector grid.
 */
function isValidAnchorTile(sector: SectorData, tileRow: number, tileCol: number): boolean {
  if (tileRow < 1 || tileRow > SECTOR_TILE_SIZE - 2) return false;
  if (tileCol < 1 || tileCol > SECTOR_TILE_SIZE - 2) return false;
  return sector.tiles[tileRow]![tileCol] === TileType.EMPTY;
}

/**
 * Resolve the hero anchor for one sector. The authored anchor
 * (`sector.landmarkAnchor`, the signature structure site) wins when it is
 * still a valid interior EMPTY tile in the final grid; otherwise a
 * deterministic ring-spiral relocates to the nearest valid tile (macro
 * features can carve the authored site). Guaranteed to find a tile — sectors
 * pass the ≥35% open-space validator gate, so an interior EMPTY tile always
 * exists.
 */
function resolveAnchor(
  sector: SectorData,
  row: number,
  col: number,
  corridorTiles: Set<string>,
): { tileRow: number; tileCol: number } {
  const authored = sector.landmarkAnchor;
  if (
    authored &&
    isValidAnchorTile(sector, authored.y, authored.x) &&
    !corridorTiles.has(corridorKey(row, col, authored.y, authored.x))
  ) {
    return { tileRow: authored.y, tileCol: authored.x };
  }
  // Deterministic relocation: expanding Chebyshev rings, row-major within a
  // ring. Same seed ⇒ same relocation.
  for (let ring = 0; ring < SECTOR_TILE_SIZE; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // ring members only
        const base = authored ?? { x: SECTOR_TILE_SIZE >> 1, y: SECTOR_TILE_SIZE >> 1 };
        const tr = base.y + dy;
        const tc = base.x + dx;
        if (
          isValidAnchorTile(sector, tr, tc) &&
          !corridorTiles.has(corridorKey(row, col, tr, tc))
        ) {
          return { tileRow: tr, tileCol: tc };
        }
      }
    }
  }
  // Unreachable (open-space gate) — fall back to the sector center regardless.
  return { tileRow: SECTOR_TILE_SIZE >> 1, tileCol: SECTOR_TILE_SIZE >> 1 };
}

// ---------------------------------------------------------------------------
// Composition pick (signature rotation + rarity weights + adjacency dedup)
// ---------------------------------------------------------------------------

/**
 * The per-map signature composition index for a type: rotated by seed band
 * with a per-type ordinal offset so the four types do not rotate in lockstep.
 * Pure arithmetic — no RNG.
 */
export function signatureIndexFor(seed: number, type: SectorType): number {
  const band = Math.floor((seed >>> 0) / SEED_BAND_SIZE);
  const ordinal = LANDMARK_TYPE_ORDER.indexOf(type);
  const count = LANDMARK_REGISTRY[type].length;
  return (band + ordinal) % count;
}

/** Draw weight for one registry entry under this map's signature rotation. */
function weightOf(entry: LandmarkComposition, signatureIndex: number, index: number): number {
  if (index === signatureIndex) return SIGNATURE_WEIGHT;
  return entry.rarity === 'rare' ? RARE_WEIGHT : 1;
}

// ---------------------------------------------------------------------------
// Minor landmark nodes
// ---------------------------------------------------------------------------

/** Interior junction nodes: corners where four sectors meet (3×3 = 9 nodes). */
function junctionNodes(): Array<{ row: number; col: number }> {
  const nodes: Array<{ row: number; col: number }> = [];
  for (let r = 1; r < SECTOR_GRID_SIZE; r++) {
    for (let c = 1; c < SECTOR_GRID_SIZE; c++) nodes.push({ row: r, col: c });
  }
  return nodes;
}

/**
 * Find the minor-landmark placement tile for one junction node: a
 * deterministic ring-spiral from the junction corner over the global grid,
 * accepting the first interior EMPTY non-corridor tile that clears the
 * hero/minor distance gates. Returns null when no tile clears (node skipped).
 */
function findMinorTile(
  node: { row: number; col: number },
  compositeRow: (r: number) => number[] | undefined,
  corridorTiles: Set<string>,
  heroTiles: Array<{ x: number; y: number }>,
  chosen: Array<{ x: number; y: number }>,
): { x: number; y: number } | null {
  const jr = node.row * SECTOR_TILE_SIZE;
  const jc = node.col * SECTOR_TILE_SIZE;
  const compositeSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
  const cheb = (ax: number, ay: number, bx: number, by: number) =>
    Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  for (let ring = 1; ring <= SECTOR_TILE_SIZE; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const gx = jc + dx;
        const gy = jr + dy;
        if (gx < 1 || gy < 1 || gx >= compositeSize - 1 || gy >= compositeSize - 1) continue;
        const tileRow = compositeRow(gy);
        if (!tileRow || tileRow[gx] !== TileType.EMPTY) continue; // EMPTY only
        // Not a corridor tile (any sector key at this global position).
        const sRow = Math.floor(gy / SECTOR_TILE_SIZE);
        const sCol = Math.floor(gx / SECTOR_TILE_SIZE);
        if (
          corridorTiles.has(corridorKey(sRow, sCol, gy % SECTOR_TILE_SIZE, gx % SECTOR_TILE_SIZE))
        )
          continue;
        if (heroTiles.some((h) => cheb(h.x, h.y, gx, gy) < MINOR_HERO_MIN_CHEB)) continue;
        if (chosen.some((m) => cheb(m.x, m.y, gx, gy) < MINOR_MINOR_MIN_CHEB)) continue;
        return { x: gx, y: gy };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Assign every sector's hero landmark + the junction minor landmarks. Pure
 * function of `(seed, sectors, typeGrid, corridorTiles, tiers)`.
 *
 * Draw order (all on the isolated LNDM stream, row-major over sectors, so the
 * stream is stable under registry edits that keep entry counts): one
 * composition pick per sector (with bounded adjacency re-draws), then the
 * minor-node count + node shuffle. (Ticket 29 removed the stream's TAIL draw —
 * the per-minor prop pick — together with `propId`; every earlier draw is
 * unaffected, the documented tail-draw removal.)
 */
export function assignLandmarks(
  seed: number,
  sectors: SectorData[][],
  typeGrid: SectorType[][],
  corridorTiles: Set<string>,
  tiers: SectorTierAssignment,
): LandmarkAssignment {
  const rng = new SeededRNG(avalanche((seed ^ LANDMARK_SEED_XOR) >>> 0));

  // 1. Hero landmarks — one per sector, row-major.
  const heroes: HeroLandmark[][] = [];
  const heroTiles: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    heroes[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const sector = sectors[row]![col]!;
      const type = typeGrid[row]![col]!;
      const entries = LANDMARK_REGISTRY[type];
      const sigIdx = signatureIndexFor(seed, type);
      const conflicted = (idx: number): boolean => {
        const id = entries[idx]!.id;
        if (col > 0 && heroes[row]![col - 1]!.compositionId === id) return true;
        if (row > 0 && heroes[row - 1]![col]!.compositionId === id) return true;
        return false;
      };
      let picked = rng.weightedPick(
        entries.map((entry, i) => ({
          item: i,
          weight: weightOf(entry, sigIdx, i),
        })),
      );
      for (let attempt = 1; attempt < MAX_PICK_ATTEMPTS && conflicted(picked); attempt++) {
        picked = rng.weightedPick(
          entries.map((entry, i) => ({ item: i, weight: weightOf(entry, sigIdx, i) })),
        );
      }
      if (conflicted(picked)) {
        // Deterministic fallback: signature first, then registry order. The
        // sector grid is bipartite per type (orthogonal adjacency only), so
        // two compositions always suffice — the fallback always resolves.
        const order = [sigIdx, ...entries.map((_, i) => i).filter((i) => i !== sigIdx)];
        picked = order.find((i) => !conflicted(i)) ?? sigIdx;
      }
      const entry = entries[picked]!;
      const anchor = resolveAnchor(sector, row, col, corridorTiles);
      const tileX = col * SECTOR_TILE_SIZE + anchor.tileCol;
      const tileY = row * SECTOR_TILE_SIZE + anchor.tileRow;
      heroTiles.push({ x: tileX, y: tileY });
      // Beacon (hue=theme, value=tier — ticket 03): the sector TYPE's theme
      // color + EFFECTIVE-tier intensity; RARE keeps only the intensity bump.
      const tier: SectorLootTier =
        tiers.hotSector.row === row && tiers.hotSector.col === col
          ? SectorLootTier.HOT
          : tiers.tiers[row]![col]!;
      const tierLight = entry.rarity === 'rare' ? BEACON_TIER_LIGHT.RARE : BEACON_TIER_LIGHT[tier];
      heroes[row]![col] = {
        compositionId: entry.id,
        rarity: picked === sigIdx ? 'signature' : entry.rarity,
        tileX,
        tileY,
        beacon: {
          color: BEACON_THEME_LIGHT[type].color,
          intensity: tierLight.intensity,
          radius: BEACON_RADIUS,
        },
      };
    }
  }

  // 2. Minor landmarks — 2–3 junction nodes, distance-gated from heroes.
  const minorCount = rng.nextInt(2, 3);
  const nodes = rng.shuffle(junctionNodes());
  const minors: MinorLandmark[] = [];
  // Composite-row accessor (lazily built, cached): global row → the concatenated
  // final sector tile row, for EMPTY checks on the post-refinement grids.
  const composite: (number[] | undefined)[] = [];
  const compositeRow = (r: number): number[] | undefined => {
    let cached = composite[r];
    if (cached === undefined) {
      const sRow = Math.floor(r / SECTOR_TILE_SIZE);
      const tRow = r % SECTOR_TILE_SIZE;
      let merged: number[] = [];
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        merged = merged.concat(Array.from(sectors[sRow]![sCol]!.tiles[tRow]!));
      }
      cached = merged;
      composite[r] = cached;
    }
    return cached;
  };
  const chosen: Array<{ x: number; y: number }> = [];
  for (const node of nodes) {
    if (minors.length >= minorCount) break;
    const tile = findMinorTile(node, compositeRow, corridorTiles, heroTiles, chosen);
    if (!tile) continue;
    chosen.push(tile);
    minors.push({
      tileX: tile.x,
      tileY: tile.y,
      light: {
        color: MINOR_LANDMARK_LIGHT.color,
        intensity: MINOR_LANDMARK_LIGHT.intensity,
        radius: MINOR_LANDMARK_LIGHT.radius,
      },
    });
  }

  return { heroes, minors };
}

// ---------------------------------------------------------------------------
// Reserved-tile helpers (server-side decor/light exclusion)
// ---------------------------------------------------------------------------

/**
 * Collect every tile the landmark system reserves: each hero anchor's
 * decor-free exclusion zone (Chebyshev `exclusionRadius`, clipped to the
 * sector interior so it can never touch a border/corridor tile) + the anchor
 * itself + the minor placement tiles. Keys are global `"row,col"` — the same
 * format `SeedMapAdapter.buildOccupiedTileSet` and the light placer use, so
 * sconce/crystal placements and decorative accents avoid the landmark zone.
 * Entity/loot/spawn placement is NOT affected (GDD §5.3.1/§5.6 preserved).
 */
export function collectLandmarkReservedTiles(landmarks: LandmarkAssignment): Set<string> {
  const reserved = new Set<string>();
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const hero = landmarks.heroes[row]?.[col];
      if (!hero) continue;
      const composition = landmarkCompositionById(hero.compositionId);
      const radius = composition?.exclusionRadius ?? 2;
      const baseRow = row * SECTOR_TILE_SIZE;
      const baseCol = col * SECTOR_TILE_SIZE;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const tr = hero.tileY - baseRow + dy;
          const tc = hero.tileX - baseCol + dx;
          // Clip to the sector interior (local 1..18): the zone can never
          // swallow a border/corridor tile.
          if (tr < 1 || tr > SECTOR_TILE_SIZE - 2) continue;
          if (tc < 1 || tc > SECTOR_TILE_SIZE - 2) continue;
          reserved.add(`${baseRow + tr},${baseCol + tc}`);
        }
      }
    }
  }
  for (const minor of landmarks.minors) {
    reserved.add(`${minor.tileY},${minor.tileX}`);
  }
  return reserved;
}
