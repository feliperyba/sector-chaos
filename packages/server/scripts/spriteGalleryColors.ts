/**
 * Colour legend for the sprite-faithful gallery (dev-only).
 *
 * Assigns a visually distinct colour to every sprite imagePath produced by the
 * SeedMapAdapter pipeline, grouped by visual family. This is the KEY difference
 * from the legacy TileType gallery: instead of one colour per structural
 * TileType, we colour by the *resolved sprite art path* so floor biomes,
 * decoration accents, wall variety, and object/entity sprites all become
 * visible. Pure static data — no runtime dependencies.
 *
 * Source of truth for the imagePath list: `tiled/env.tsx` (51 tiles) +
 * `tiled/weapons.tsx`. Path/track sprites are included even though the current
 * pipeline does not emit them, so the legend stays complete for future use.
 */

/** Visual family a sprite belongs to (controls legend grouping + tone). */
export type ColourFamily =
  | 'floor'
  | 'path'
  | 'decoration'
  | 'wall'
  | 'object'
  | 'entity'
  | 'weapon';

/** Human-readable heading for each family, used by the legend. */
export const FAMILY_LABELS: Record<ColourFamily, string> = {
  floor: 'Floor (earthy/neutral)',
  path: 'Path / Track (warm road)',
  decoration: 'Decoration (subtle accent)',
  wall: 'Wall (dark structural)',
  object: 'Object',
  entity: 'Entity',
  weapon: 'Weapon (pink/fuchsia)',
};

/** One resolved sprite → colour entry. */
export interface SpriteColourEntry {
  imagePath: string;
  colour: string;
  family: ColourFamily;
}

/**
 * The complete, ordered colour legend. Grouped by family so the rendered legend
 * reads top-to-bottom as floor → path → decoration → wall → object → entity.
 */
export const SPRITE_COLOURS: SpriteColourEntry[] = [
  // ── Floor (earthy/neutral tones) ──────────────────────────────────────────
  { imagePath: 'grass', colour: '#4a7c3a', family: 'floor' },
  { imagePath: 'tile', colour: '#7d7460', family: 'floor' },
  { imagePath: 'tiles', colour: '#8d8779', family: 'floor' },
  { imagePath: 'tiles_center', colour: '#b6ad9c', family: 'floor' },
  { imagePath: 'wood', colour: '#6b4f2a', family: 'floor' },

  // ── Path / Track (warm road tones) ────────────────────────────────────────
  { imagePath: 'path', colour: '#a8895a', family: 'path' },
  { imagePath: 'path_crossing', colour: '#c4a86e', family: 'path' },
  { imagePath: 'path_curve', colour: '#b89763', family: 'path' },
  { imagePath: 'track', colour: '#7c5d3a', family: 'path' },
  { imagePath: 'track_crossing', colour: '#8d6c46', family: 'path' },
  { imagePath: 'track_curve', colour: '#826040', family: 'path' },

  // ── Decoration (subtle accent tones) ──────────────────────────────────────
  { imagePath: 'plants', colour: '#5fa84f', family: 'decoration' },
  { imagePath: 'puddle', colour: '#4a7ad6', family: 'decoration' },
  { imagePath: 'tiles_cracked', colour: '#6b5f4a', family: 'decoration' },
  { imagePath: 'tiles_decorative', colour: '#a89ab0', family: 'decoration' },
  { imagePath: 'tiles_corner', colour: '#9a8e74', family: 'decoration' },

  // ── Wall (dark structural; indestructible blue-gray vs destructible brown) ─
  // Indestructible (INDESTRUCTIBLE_WALL / INDESTRUCTIBLE_CRATE)
  { imagePath: 'wall', colour: '#1e2838', family: 'wall' },
  { imagePath: 'wall_corner', colour: '#26324f', family: 'wall' },
  { imagePath: 'wall_diagonal', colour: '#2c3a5a', family: 'wall' },
  { imagePath: 'inner_round', colour: '#324066', family: 'wall' },
  { imagePath: 'inner_diagonal', colour: '#344066', family: 'wall' },
  { imagePath: 'inner_long_round', colour: '#384872', family: 'wall' },
  { imagePath: 'inner_long_diagonal', colour: '#3e4f7c', family: 'wall' },
  // Destructible (DESTRUCTIBLE_WALL)
  { imagePath: 'wall_curve', colour: '#4a2e22', family: 'wall' },
  { imagePath: 'wall_damaged', colour: '#5a3a28', family: 'wall' },
  { imagePath: 'wall_secret', colour: '#3e2820', family: 'wall' },
  { imagePath: 'wall_half', colour: '#5e4030', family: 'wall' },
  { imagePath: 'wall_edge', colour: '#503426', family: 'wall' },

  // ── Object (distinguishable object colours) ───────────────────────────────
  { imagePath: 'coffin', colour: '#4a3a5c', family: 'object' },
  { imagePath: 'crate_small', colour: '#7a7066', family: 'object' },
  { imagePath: 'crate', colour: '#9a6b3a', family: 'object' },
  { imagePath: 'tree', colour: '#2f5e2a', family: 'object' },
  { imagePath: 'planks', colour: '#7a5a32', family: 'object' },
  { imagePath: 'barrel', colour: '#c4633a', family: 'object' },
  { imagePath: 'barrels', colour: '#b8542e', family: 'object' },
  { imagePath: 'barrels_stacked', colour: '#a84a26', family: 'object' },
  { imagePath: 'campfire', colour: '#e8742a', family: 'object' },
  { imagePath: 'chair', colour: '#8a7a5a', family: 'object' },
  { imagePath: 'chest', colour: '#e8c84a', family: 'object' },

  // ── Entity (distinct) ─────────────────────────────────────────────────────
  { imagePath: 'trap', colour: '#c0303a', family: 'entity' },
  { imagePath: 'trap_door', colour: '#7a3ac0', family: 'entity' },
  { imagePath: 'trapdoor_round', colour: '#d04020', family: 'entity' },
  { imagePath: 'trapdoor_square', colour: '#e05030', family: 'entity' },
  { imagePath: 'wall_trap', colour: '#a02030', family: 'entity' },
  { imagePath: 'door_closed', colour: '#5a3a1a', family: 'entity' },
  { imagePath: 'door_open', colour: '#4ad6e8', family: 'entity' },
  { imagePath: 'doorway', colour: '#3aa8b8', family: 'entity' },
  { imagePath: 'wall_demolished', colour: '#50404a', family: 'entity' },

  // ── Weapon (pink/fuchsia) ─────────────────────────────────────────────────
  { imagePath: 'shield_curved', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'shield_straight', colour: '#ff70f2', family: 'weapon' },
  { imagePath: 'weapon_axe', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_axe_blades', colour: '#ff66f0', family: 'weapon' },
  { imagePath: 'weapon_axe_double', colour: '#ff70f0', family: 'weapon' },
  { imagePath: 'weapon_axe_large', colour: '#ff7af0', family: 'weapon' },
  { imagePath: 'weapon_bow', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_bow_arrow', colour: '#ff66f0', family: 'weapon' },
  { imagePath: 'weapon_dagger', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_hammer', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_longsword', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_pole', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_spear', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_staff', colour: '#ff5cf0', family: 'weapon' },
  { imagePath: 'weapon_sword', colour: '#ff5cf0', family: 'weapon' },
];

/** Colour used when a cell has no resolved sprite (void / out of bounds). */
export const VOID_COLOUR = '#0a0e14';

/** Colour used for an unknown imagePath that is not in the legend. */
export const FALLBACK_COLOUR = '#ff00ff';

/** Base colour for any weapon_/shield_ imagePath not explicitly listed. */
export const WEAPON_COLOUR = '#ff5cf0';
const WEAPON_PREFIXES = ['weapon_', 'shield_'];

// Precomputed O(1) lookup from the legend array.
const COLOUR_BY_PATH = new Map<string, string>(SPRITE_COLOURS.map((e) => [e.imagePath, e.colour]));

/**
 * Resolve a colour for a sprite imagePath. Falls back to the weapon-family
 * colour for unknown weapon_/shield_ paths, then to {@link FALLBACK_COLOUR}.
 *
 * @param imagePath - the sprite imagePath from the atlas
 * @returns the hex colour for the cell
 */
export function colourForImagePath(imagePath: string): string {
  const known = COLOUR_BY_PATH.get(imagePath);
  if (known) return known;
  if (WEAPON_PREFIXES.some((p) => imagePath.startsWith(p))) return WEAPON_COLOUR;
  return FALLBACK_COLOUR;
}

/**
 * The ordered list of families as they should appear in the legend.
 */
export const FAMILY_ORDER: ColourFamily[] = [
  'floor',
  'path',
  'decoration',
  'wall',
  'object',
  'entity',
  'weapon',
];
