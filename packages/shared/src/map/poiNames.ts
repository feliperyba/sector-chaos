import { SeededRNG } from './rng/SeededRNG.js';
import { avalanche } from './lootTiers.js';
import { landmarkCompositionById } from './landmarkRegistry.js';
import type { MacroFeatureResult } from './macro/MacroTypes.js';
import type { SectorSubVariant } from './sectors/subVariants.js';
import { SectorType } from './types.js';
import type { HeroLandmark } from './landmarks.js';

/**
 * POI naming system (map-redesign ticket 03 / DEC-001 + DEC-010).
 *
 * Every sector and macro feature gets a generated display name composed
 * deterministically from data-driven name-part pools (prefix × noun ×
 * optional suffix), unique within the map, hinting at gameplay through the
 * sub-variant's noun pool (Vault/Bazaar/Depot = loot; Warren/Labyrinth =
 * maze; Bastion/Lattice = arena). The map designation (e.g.
 * "RINGROAD • SPIRE • 63") derives from the macro rolls: highway
 * orientation × flavor feature × fortress variant family + a short seed tag.
 *
 * Determinism (ADR 0035): ALL draws come from isolated XOR-salted,
 * avalanche-mixed streams derived from the map seed — never from the main
 * pipeline RNG — so adding naming can never perturb tile/entity generation:
 * - Sector + macro names: `avalanche(seed ^ NAME_SEED_XOR)`
 * - Designation family pick: `avalanche(seed ^ DESIG_SEED_XOR)`
 * The seed tag is a pure arithmetic function of the seed (no RNG at all).
 */

/**
 * Isolated RNG stream seed XOR constant for POI name composition ('NAME' in
 * ASCII hex — same convention as lootTiers' 'TIER'/'HOTS' and
 * MacroFeaturePass's 'HIGW'/'COMP'/'FLAV' salts).
 */
const NAME_SEED_XOR = 0x4e414d45;

/**
 * Isolated RNG stream seed XOR constant for the designation's fortress-
 * family word pick ('DESG' in ASCII hex). Separate from NAME_SEED_XOR so
 * the designation is independently reproducible without replaying the name
 * draws.
 */
const DESIG_SEED_XOR = 0x44455347;

/** Probability a name draws the optional suffix word. */
const SUFFIX_CHANCE = 0.35;
/** Bounded re-draw attempts when a composed name collides with a used one. */
const MAX_NAME_ATTEMPTS = 16;

// ---------------------------------------------------------------------------
// Name-part pools (data-driven — tuning never touches algorithms)
// ---------------------------------------------------------------------------

/**
 * Prefix pool per sector type — the type-identity flavor half of the name.
 */
const PREFIXES_BY_TYPE: Record<SectorType, readonly string[]> = {
  [SectorType.GRID_ARENA]: ['Iron', 'Rust', 'Bolt', 'Cinder', 'Scrap', 'Grid', 'Slag', 'Forge'],
  [SectorType.OPEN_ARENA]: ['Sun', 'Dust', 'Wind', 'Ash', 'Ember', 'Gale', 'Frost', 'Salt'],
  [SectorType.MAZE]: ['Hollow', 'Mirk', 'Shroud', 'Veil', 'Grim', 'Dusk', 'Bramble', 'Ashen'],
  [SectorType.RESOURCE_RICH]: [
    'Gilded',
    'Golden',
    'Amber',
    'Opal',
    'Coin',
    'Silk',
    'Crimson',
    'Velvet',
  ],
};

/**
 * Noun pool per sub-variant — the gameplay-hint callout word. Loot sectors
 * say Vault/Bazaar/Cache/Depot, maze sectors say Warren/Labyrinth, arena
 * sectors say Lattice/Bastion (DEC-001 grammar).
 */
export const NOUNS_BY_SUB_VARIANT: Record<SectorSubVariant, readonly string[]> = {
  // GRID_ARENA — arena / structure reads
  'Classic Lattice': ['Lattice', 'Gridwork', 'Matrix', 'Bastion'],
  'Ring Fortress': ['Bastion', 'Keep', 'Redoubt', 'Ringhold'],
  'Broken Grid': ['Ruins', 'Shambles', 'Rubble', 'Bulwark'],
  'Lane Corridors': ['Corridors', 'Channels', 'Lanes', 'Passages'],
  'Plaza Crossroads': ['Crossroads', 'Plaza', 'Forum', 'Junctions'],
  // OPEN_ARENA — open-field reads
  'Corner Bastions': ['Watchpost', 'Outposts', 'Cornerstone', 'Bulwark'],
  'Central Monument': ['Monument', 'Spire', 'Obelisk', 'Monolith'],
  'Scatter Cover': ['Flats', 'Expanse', 'Steppe', 'Reach'],
  'Diagonal Spurs': ['Spurs', 'Ridges', 'Cuts', 'Runs'],
  Airstrip: ['Airstrip', 'Runway', 'Field', 'Aerodrome'],
  // MAZE — maze reads (DEC-001: Warren/Labyrinth = maze)
  'Loose Labyrinth': ['Labyrinth', 'Tangle', 'Warrens', 'Switchbacks'],
  'Chambers & Halls': ['Halls', 'Chambers', 'Gallery', 'Undercroft'],
  'Breakable Warren': ['Warren', 'Burrow', 'Maze', 'Rabbitry'],
  'Concentric Spiral': ['Spiral', 'Coils', 'Vortex', 'Rings'],
  'Sewer Grid': ['Sewers', 'Cisterns', 'Conduits', 'Galleries'],
  // RESOURCE_RICH — loot reads (DEC-001: Vault/Bazaar/Depot = loot)
  'Treasure Vault': ['Vault', 'Treasury', 'Strongroom', 'Cache'],
  'Loot Bazaar': ['Bazaar', 'Market', 'Exchange', 'Emporium'],
  'Exposed Cache': ['Cache', 'Hoard', 'Trove', 'Stockpile'],
  'Supply Depot': ['Depot', 'Storehouse', 'Armory', 'Quartermaster'],
  'Bank Row': ['Bank', 'Mint', 'Countinghouse', 'Reserve'],
};

/**
 * Nouns that read best with the definite article ("The Gilded Vault" vs
 * "Ashen Crossing"). Deterministic — membership is fixed data, not a draw.
 */
const ARTICLE_NOUNS: ReadonlySet<string> = new Set([
  'Vault',
  'Treasury',
  'Strongroom',
  'Bazaar',
  'Market',
  'Exchange',
  'Emporium',
  'Depot',
  'Storehouse',
  'Armory',
  'Quartermaster',
  'Warren',
  'Labyrinth',
  'Obelisk',
  'Monolith',
  'Monument',
  'Gallery',
  'Undercroft',
  'Bastion',
  'Keep',
  'Redoubt',
  'Ringhold',
]);

/** Optional suffix pool — a place-type tail word. */
const NAME_SUFFIXES: readonly string[] = [
  'Crossing',
  'Junction',
  'Fields',
  'Row',
  'Gate',
  'Rise',
  'Yard',
  'Reach',
] as const;

/**
 * Fixed macro-feature vocabulary (DEC-001: macro features get
 * fixed-vocabulary names — compound/Citadel/highway/ridge — not free
 * composition).
 */
const HIGHWAY_NAMES: readonly string[] = ['The Ringroad', 'The Thoroughfare', 'The Longcut'];
const COMPOUND_NAMES: readonly string[] = ['The Compound', 'The Bastion', 'The Stockade'];
/**
 * The rare Citadel's fixed name (map-redesign ticket 06 / DEC-004): rarity is
 * the event — the map's signature fortress is simply CALLED what it is. No
 * draw: on Citadel seeds the NAME stream skips the compound pick entirely
 * (documented sanctioned naming change; non-Citadel names are unchanged).
 */
const CITADEL_NAME = 'The Citadel';
const RIDGE_NAMES: readonly string[] = ['The Ridgeline', 'The Serpent Spine', 'The Crooked Spine'];
const COMMONS_NAMES: readonly string[] = ['The Twinfields', 'The Open Commons', 'The Freefield'];

// ---------------------------------------------------------------------------
// Designation vocabulary (DEC-010)
// ---------------------------------------------------------------------------

/** Macro-shape word: highway orientation × flavor feature. */
function designationShape(macro: MacroFeatureResult): string {
  if (macro.barrierRidge) return 'RIDGELINE';
  if (macro.openCommons) return 'TWINFIELDS';
  // No flavor feature — the highway orientation alone names the shape.
  return macro.highway?.direction === 'V' ? 'SPINEWAY' : 'RINGROAD';
}

/** Fortress-family word candidates per compound variant family. */
const DESIGNATION_FAMILY_BY_VARIANT: Record<string, readonly string[]> = {
  CROSS_PARTITION: ['VAULTS', 'STRONGHOLD'],
  PILLARED_HALL: ['PILLARS', 'SPIRE'],
  COURTYARD_RING: ['COURTS', 'RINGHOLD'],
  // Map-redesign ticket 06 (DEC-004.2): the loot-arm template joins the
  // designation vocabulary.
  LOOT_ARM: ['ARMORY', 'WAREROOM'],
  // Map-redesign ticket 06 (DEC-004.1): the rare Citadel's family word.
  CITADEL: ['CITADEL', 'KEEP'],
};

/**
 * Short seed tag: pure arithmetic (no RNG) so the designation is always
 * derivable from the seed alone. Uppercase base36, 2–3 chars ("63", "A27").
 */
export function designationSeedTag(seed: number): string {
  return (seed % 46656).toString(36).toUpperCase().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Display names for the macro features present on a map (null = absent). */
export interface MacroPoiNames {
  highway: string | null;
  compound: string | null;
  barrierRidge: string | null;
  openCommons: string | null;
}

/** The full naming pass output, stored on MapData. */
export interface PoiNameAssignment {
  /** Generated display name per sector (4×4, row-major). */
  sectorNames: string[][];
  /** Fixed-vocabulary macro-feature names (present features only). */
  macroNames: MacroPoiNames;
  /** Map designation, e.g. "RINGROAD • SPIRE • 63" (DEC-010). */
  designation: string;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Compass disambiguator for the (vanishingly rare) exhausted-collision fallback. */
function compassOf(row: number, col: number, grid: number): string {
  const lat = row < grid / 2 - 0.5 ? 'N' : row > grid / 2 - 0.5 ? 'S' : '';
  const lon = col < grid / 2 - 0.5 ? 'W' : col > grid / 2 - 0.5 ? 'E' : '';
  return `${lat}${lon}` || 'C';
}

/**
 * Compose one candidate name from the pools. `prefix × noun` with the
 * definite article for article-nouns and an optional suffix tail.
 */
function composeName(
  rng: SeededRNG,
  prefixes: readonly string[],
  nouns: readonly string[],
): string {
  const prefix = prefixes[rng.nextInt(0, prefixes.length - 1)]!;
  const noun = nouns[rng.nextInt(0, nouns.length - 1)]!;
  const useSuffix = rng.nextFloat() < SUFFIX_CHANCE;
  const suffix = useSuffix ? NAME_SUFFIXES[rng.nextInt(0, NAME_SUFFIXES.length - 1)]! : null;
  const head = ARTICLE_NOUNS.has(noun) ? `The ${prefix} ${noun}` : `${prefix} ${noun}`;
  return suffix ? `${head} ${suffix}` : head;
}

/** Pick a fixed-vocabulary macro name, joining the map-wide uniqueness set. */
function pickMacroName(rng: SeededRNG, pool: readonly string[], used: Set<string>): string {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = pool[rng.nextInt(0, pool.length - 1)]!;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Pools are disjoint per feature — a collision means a sector already took
  // the exact string; disambiguate deterministically by pool index.
  const fallback = `${pool[0]!} ${used.size}`;
  used.add(fallback);
  return fallback;
}

/**
 * Restrict a sector's noun pool to the chosen landmark family's alignment
 * hints (map-redesign ticket 04 / DEC-002 — "the landmark identity links into
 * the POI name"). The registry data guarantees the intersection is non-empty
 * for every (composition, sub-variant) pair; the full-pool fallback is
 * defensive only.
 */
function alignedNounPool(
  nouns: readonly string[],
  hero: HeroLandmark | undefined,
  subVariant: SectorSubVariant,
): readonly string[] {
  if (!hero) return nouns;
  const hints = landmarkCompositionById(hero.compositionId)?.nounHints[subVariant];
  if (!hints || hints.length === 0) return nouns;
  const aligned = nouns.filter((n) => hints.includes(n));
  return aligned.length > 0 ? aligned : nouns;
}

/**
 * Generate every POI name + the map designation. Pure function of
 * `(seed, typeGrid, subVariantGrid, macro)` — draws ONLY from the isolated
 * NAME/DESG streams documented above, so the main pipeline RNG is untouched
 * and same seed ⇒ identical names (ADR 0035).
 *
 * `landmarkHeroes` (map-redesign ticket 04) restricts each sector's noun draw
 * to the chosen landmark family's hints (noun alignment). It does NOT change
 * the draw COUNT — one noun draw per sector, same call shape — only the pool
 * bounds, so the NAME stream stays structurally stable.
 */
export function generatePoiNames(
  seed: number,
  typeGrid: SectorType[][],
  subVariantGrid: SectorSubVariant[][],
  macro: MacroFeatureResult,
  landmarkHeroes?: HeroLandmark[][],
): PoiNameAssignment {
  const rng = new SeededRNG(avalanche((seed ^ NAME_SEED_XOR) >>> 0));
  const used = new Set<string>();
  const rows = typeGrid.length;

  // 1. Sector names — row-major, each unique within the map.
  const sectorNames: string[][] = [];
  for (let row = 0; row < rows; row++) {
    sectorNames[row] = [];
    const cols = typeGrid[row]!.length;
    for (let col = 0; col < cols; col++) {
      const prefixes = PREFIXES_BY_TYPE[typeGrid[row]![col]!];
      const nouns = alignedNounPool(
        NOUNS_BY_SUB_VARIANT[subVariantGrid[row]![col]!],
        landmarkHeroes?.[row]?.[col],
        subVariantGrid[row]![col]!,
      );
      let name = composeName(rng, prefixes, nouns);
      for (let attempt = 1; attempt < MAX_NAME_ATTEMPTS && used.has(name); attempt++) {
        name = composeName(rng, prefixes, nouns);
      }
      if (used.has(name)) {
        // Bounded fallback: pool collision after all retries (pathological
        // same-type/sub-variant grids). Compass, then coordinates — both
        // deterministic and guaranteed distinct per sector.
        name = `${name} ${compassOf(row, col, rows)}`;
        if (used.has(name)) name = `${name} ${row}-${col}`;
      }
      used.add(name);
      sectorNames[row]![col] = name;
    }
  }

  // 2. Macro-feature names — fixed vocabulary, drawn after sectors so the
  //    sector draws are stable even if the macro pools are edited. The rare
  //    Citadel is NAMED, not drawn (ticket 06: 'The Citadel' is fixed
  //    vocabulary; the NAME stream skips the pick on Citadel seeds). NB: the
  //    property evaluation order (highway → compound → ridge → commons) IS
  //    the draw order — keep it.
  const pickCompoundName = (compound: NonNullable<MacroFeatureResult['compound']>): string => {
    if (compound.variant === 'CITADEL') {
      used.add(CITADEL_NAME);
      return CITADEL_NAME;
    }
    return pickMacroName(rng, COMPOUND_NAMES, used);
  };
  const macroNames: MacroPoiNames = {
    highway: macro.highway ? pickMacroName(rng, HIGHWAY_NAMES, used) : null,
    compound: macro.compound ? pickCompoundName(macro.compound) : null,
    barrierRidge: macro.barrierRidge ? pickMacroName(rng, RIDGE_NAMES, used) : null,
    openCommons: macro.openCommons ? pickMacroName(rng, COMMONS_NAMES, used) : null,
  };

  // 3. Designation — `<SHAPE> • <FAMILY> • <SEEDTAG>` (DEC-010). The shape
  //    and tag are pure macro/seed functions; the family word is one pick
  //    from the fortress variant's candidates on the isolated DESG stream.
  const desigRng = new SeededRNG(avalanche((seed ^ DESIG_SEED_XOR) >>> 0));
  const familyPool = DESIGNATION_FAMILY_BY_VARIANT[macro.compound?.variant ?? 'CROSS_PARTITION']!;
  const family = familyPool[desigRng.nextInt(0, familyPool.length - 1)]!;
  const designation = `${designationShape(macro)} • ${family} • ${designationSeedTag(seed)}`;

  return { sectorNames, macroNames, designation };
}
