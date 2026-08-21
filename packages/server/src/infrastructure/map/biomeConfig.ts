import { SECTOR_TILE_SIZE, SectorType, type MapData } from '@sector-battle/shared';

/**
 * Type-coded Biome configuration for the floor underlay (CONTEXT.md → Biome /
 * Decorative Accent, ADR 0027). Each sector type carries a signature solid-floor
 * base (its "read at a glance" plaza/yard/etc.), a tight in-family variant band
 * ({@link FLOOR_VARIANT_SPECS}, v11), an in-family plaza accent ({@link
 * PLAZA_ACCENT_PATHS}, v11), and a curated set of collider-free EMPTY-type
 * transparent Decorative Accent sprites painted sparsely per sector instance.
 * Everything that can appear inside a sector's floor stays in ONE value/hue
 * family per type, so no sprite combination reads as "does not match". Keeping
 * this config in its own module keeps FloorSpriteSelector lean and makes adding
 * a type's biome a one-entry change.
 */

/**
 * Opaque, full-bleed floor sprites that may be used as the floor base. Excludes
 * transparent/decorative overlays (tiles_decorative, tiles_corner, tiles_cracked,
 * plants, flowers, …) which are meant to be layered on top of a full tile.
 * `wood` is the edge-framing floor; it is reserved for borders, not interiors.
 */
export const SOLID_FLOOR_IMAGE_PATHS = new Set(['tile', 'tiles', 'tiles_center', 'grass', 'wood']);

// --- Type-coded floor palettes (T8 rebalance): 1:1, mutually exclusive ---
// Exactly four solid interior floor sprites exist (tile, tiles, tiles_center,
// grass; `wood` is reserved for edges). With four sector types, each type is
// assigned ONE distinct sprite so the biome reads at a glance in the 4x4 and no
// two types share a floor. The signature character beyond the base sprite is
// carried by each type's Decorative Accent set below. Each set keeps the
// `.length > 0 ? subset : themePool` fallback in FloorSpriteSelector, so a type
// still renders if its sprite is ever absent from the atlas.

/**
 * GridArena's signature Biome floor palette (T8): the clean industrial
 * `tiles_center` plaza — the hard, technical crate-yard floor. Distinct from the
 * other three types. Falls back to the shared pool if absent from the atlas.
 */
export const GRID_ARENA_FLOOR_PATHS = new Set(['tiles_center']);

/**
 * OpenArena's signature Biome floor palette (T8): organic `grass` — the open
 * plaza / landing-field read. Distinct from the other three types. Falls back to
 * the shared pool if absent from the atlas.
 */
export const OPEN_ARENA_FLOOR_PATHS = new Set(['grass']);

/**
 * Maze's signature Biome floor palette (T8): worn stone `tiles` — the abandoned,
 * overgrown-ruins labyrinth floor (overgrowth carried by the Maze accent set
 * below). Distinct from the other three types. Falls back to the shared pool if
 * absent from the atlas.
 */
export const MAZE_FLOOR_PATHS = new Set(['tiles']);

/**
 * ResourceRich's signature Biome floor palette (T8): the polished `tile` ground —
 * the finished, valuable treasure-depot floor. Distinct from the other three
 * types. Falls back to the shared pool if absent from the atlas.
 */
export const RESOURCE_RICH_FLOOR_PATHS = new Set(['tile']);

/**
 * Per-sector-type central plaza accent imagePath (v11 in-family re-key). Each
 * sector's central 4×4 region (local rows/cols 8–11) gets this distinct solid
 * floor sprite as a visual focal point — chosen from the SAME value/hue family
 * as the type's main biome floor so the plaza reads as a deliberately framed
 * dais, never as a foreign slab. Measured families (atlas pixel audit): the
 * gray-tan stone family is `tiles`/`tiles_center`/`tiles_cracked`/
 * `tiles_decorative` (mean RGB ~135–148), the brown family `tile`/`wood`
 * (~104–118), and `grass`/`water` are one green family (~80–95). The pre-v11
 * cross-family keys (MAZE brown-on-gray `tile`, RESOURCE_RICH gray-on-brown
 * `tiles_center`, GRID's near-invisible `tiles`-on-`tiles_center`, OPEN's
 * gray-stone-on-grass) were the loudest "tiles that do not match" swatches.
 * Resolved as an EMPTY-type, collider-free cosmetic; falls back to the sector's
 * main theme floor when the accent sprite is absent from the atlas.
 */
export const PLAZA_ACCENT_PATHS: Record<SectorType, string> = {
  [SectorType.GRID_ARENA]: 'tiles_decorative', // rosette medallion on clean stone
  [SectorType.OPEN_ARENA]: 'water', // green-family clearing pond on grass
  [SectorType.MAZE]: 'tiles_decorative', // old ceremonial rosette on worn stone
  [SectorType.RESOURCE_RICH]: 'wood', // plank dais on the brown depot floor
};

/**
 * One sector type's floor VARIANT BAND (v11 sector floor cohesion): the single
 * in-family variant sprite sprinkled deterministically through the type's
 * interior floor at `density` (fraction of interior cells). `path: ''` means no
 * band — the type's base floor stays uniform. Variants are the same value/hue
 * family as the base (see {@link PLAZA_ACCENT_PATHS} for the measured
 * families), so the band reads as authored wear/patchwork, not noise.
 */
export interface FloorVariantSpec {
  /** In-family variant imagePath ('' = uniform base floor). */
  path: string;
  /** Fraction of interior cells that resolve to the variant. */
  density: number;
}

/**
 * Per-type floor variant band. GRID_ARENA gets sparse worn spots on its clean
 * industrial floor; MAZE gets heavier wear (the overgrown-ruins read);
 * OPEN_ARENA's organic grass base already reads varied (its character carries
 * via the transparent plants/puddle overlay + water plaza) and RESOURCE_RICH's
 * polished depot stays uniform (character via the wood dais + sparse weeds).
 * Selection is a pure position/seed hash in FloorSpriteSelector — ZERO RNG
 * stream draws (ADR 0035).
 */
export const FLOOR_VARIANT_SPECS: Record<SectorType, FloorVariantSpec> = {
  [SectorType.GRID_ARENA]: { path: 'tiles_cracked', density: 0.06 },
  [SectorType.OPEN_ARENA]: { path: '', density: 0 },
  [SectorType.MAZE]: { path: 'tiles_cracked', density: 0.08 },
  [SectorType.RESOURCE_RICH]: { path: '', density: 0 },
};

/** Isolated RNG salt for GridArena Decorative Accent placement. */
export const GRID_ARENA_ACCENT_SALT = 0x1d2c6f3b;

/** Isolated RNG salt for OpenArena Decorative Accent placement (distinct). */
export const OPEN_ARENA_ACCENT_SALT = 0x7a3e91c5;

/** Isolated RNG salt for Maze Decorative Accent placement (distinct). */
export const MAZE_ACCENT_SALT = 0x2b8f47d1;

/** Isolated RNG salt for ResourceRich Decorative Accent placement (distinct). */
export const RESOURCE_RICH_ACCENT_SALT = 0x4e7d52a9;

/**
 * One sector type's Decorative Accent rule: the ordered accent imagePaths to
 * source (collider-free EMPTY-type sprites only), the fraction of interior cells
 * to accent, and an isolated RNG salt so each type's accent stream is independent
 * (and adding a type never perturbs another type's deterministic placement).
 */
export interface AccentConfig {
  /** The sector type these accents paint onto. */
  type: SectorType;
  /** Ordered accent imagePaths, by preference. */
  paths: readonly string[];
  /** Approximate fraction of a sector's interior cells to accent. */
  density: number;
  /** Isolated seed salt for this type's accent RNG stream. */
  salt: number;
}

/**
 * Per-type Decorative Accent rules (v11 cohesion pass). The overlay draws ONLY
 * genuinely-TRANSPARENT sprites (atlas pixel audit: `plants` ~19% opaque
 * sprigs, `puddle` ~56% opaque pool with transparent rim) — these read as
 * decoration ON the floor. The ~94%-opaque patterned stone full-tiles
 * (`tiles_cracked`, `tiles_decorative`) are NOT scattered here anymore: they
 * now live in the deterministic in-family floor band ({@link
 * FLOOR_VARIANT_SPECS}) and the plaza medallions, where their full-tile art
 * reads as authored flooring. All accents are EMPTY-type, collider-free
 * sprites, so painting them onto the floor layer never changes the tile grid
 * or collision. Each type uses its own salt so the streams are independent
 * and deterministic.
 */
export const ACCENT_CONFIGS: readonly AccentConfig[] = [
  {
    // GridArena: the odd wet patch on the industrial floor (teal pool on clean
    // stone). The worn-spot character moved into the floor band
    // (tiles_cracked @ 0.06).
    type: SectorType.GRID_ARENA,
    paths: ['puddle'],
    density: 0.02,
    salt: GRID_ARENA_ACCENT_SALT,
  },
  {
    // OpenArena: organic plaza scatter — `plants`, `puddle` (no stairs are
    // placed: the `stairs_down_detail` landing was removed with the ticket-19
    // path cleanup). All EMPTY-type, collider-free.
    type: SectorType.OPEN_ARENA,
    paths: ['plants', 'puddle'],
    density: 0.04,
    salt: OPEN_ARENA_ACCENT_SALT,
  },
  {
    // Maze: the overgrown-ruins read — creeping `plants` and rain `puddle`s on
    // the worn stone (no stairs are placed: the `stairs_down` stairwells were
    // removed with the ticket-19 path cleanup). The stone wear
    // (`tiles_cracked`) moved into the heavier floor band (0.08), and the
    // opaque green `water` tile was DROPPED (v11): it is a ~89%-opaque
    // grass-family full tile that read as random mismatched green tiles on
    // the gray stone floor.
    type: SectorType.MAZE,
    paths: ['plants', 'puddle'],
    density: 0.04,
    salt: MAZE_ACCENT_SALT,
  },
  {
    // ResourceRich: sparse weeds poking through the worn vault floor. The
    // gray-stone accents (`tiles_decorative`/`tiles_corner`/`tiles_cracked`)
    // were DROPPED (v11): all three are gray-tan stone full/fragment tiles
    // that clashed hue+value with the brown `tile` base floor. The valuable
    // read now carries via the wood dais plaza + the uniform polished base.
    type: SectorType.RESOURCE_RICH,
    paths: ['plants'],
    density: 0.02,
    salt: RESOURCE_RICH_ACCENT_SALT,
  },
];

// ---------------------------------------------------------------------------
// Beacon-anchored court floor (map-polish ticket 29) — WHERE the plaza accent
// paints. Kept here (the medallion plumbing next to the PLAZA_ACCENT_PATHS
// data) so FloorSpriteSelector stays under the 500-line file gate.
// ---------------------------------------------------------------------------

/**
 * Collect each sector's beacon anchor (global tile) from the server-authored
 * landmark assignment (`mapData.landmarks.heroes`). A hero whose anchor does
 * not lie inside its own sector's interior with room for the full court
 * (local 2..17) is treated as unresolvable — that sector falls back to NO
 * medallion (never the old fixed sector-center patch). Pure projection of the
 * landmark assignment, zero RNG (ADR 0035).
 */
export function resolveBeaconCourtAnchors(
  mapData: MapData,
  sectorsPerSide: number,
): Map<string, { x: number; y: number }> {
  const anchors = new Map<string, { x: number; y: number }>();
  const heroes = mapData.landmarks.heroes;
  const innerMax = SECTOR_TILE_SIZE - 3; // interior bound for a full 3×3 court
  for (let row = 0; row < sectorsPerSide && row < heroes.length; row++) {
    const sectorRow = heroes[row] ?? [];
    for (let col = 0; col < sectorsPerSide && col < sectorRow.length; col++) {
      const hero = sectorRow[col];
      if (!hero) continue;
      const localX = hero.tileX - col * SECTOR_TILE_SIZE;
      const localY = hero.tileY - row * SECTOR_TILE_SIZE;
      if (localX < 2 || localX > innerMax || localY < 2 || localY > innerMax) continue;
      anchors.set(`${row},${col}`, { x: hero.tileX, y: hero.tileY });
    }
  }
  return anchors;
}

/**
 * The beacon court tile test: Chebyshev ≤1 around the anchor plus the south
 * approach axis tile (0,+1) — the ticket's formula, implemented literally.
 * The (0,+1) disjunct is contained in the Chebyshev ball, so the union is
 * exactly the keep's 3×3 interior court — the patch the keep's south approach
 * axis enters through. The keep's walls sit on the Chebyshev-2 ring, outside
 * the court; floor under a wall is irrelevant anyway (walls overdraw), so
 * painting the court into the floor layer is always safe.
 */
export function isBeaconCourtTile(dx: number, dy: number): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) <= 1 || (dx === 0 && dy === 1);
}
