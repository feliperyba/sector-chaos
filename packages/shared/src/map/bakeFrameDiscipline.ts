/**
 * No-baked-objects discipline (map-polish ticket 06) — the machine-checked
 * form of the user's rule:
 *
 *   "floor/decoration bake inputs contain NO object-visual tile ids; entities
 *    exist as entities; lights as lights."
 *
 * Everything the client bakes into the STATIC floor/decoration RenderTextures
 * (`bakeGatewayFrames` bracket/accent — the arch was REMOVED by map-polish
 * ticket 19 — and `buildDecorationLayer` accents; the landmark composite
 * dressing bake was REMOVED by map-polish ticket 29: the plaza is the
 * server-composed keep + court floor + beacon light, never baked decor
 * frames) must draw ONLY floor/decor frames: a wall/crate/barrel/coffin/
 * door/trap pixel painted on a walkable tile is a lie the player walks
 * straight through, and it double-renders over the real grid tile → live
 * entity pipeline that already exists for those objects.
 *
 * BOTH constants below are transcribed from the atlas `tiled/env.tsx`
 * (alphabetical = tile id order). The TSX stays the single source of truth:
 * the server parity test (`TsxAtlasParser.test.ts`, "OBJECT_VISUAL_FRAMES
 * parity") parses the real file and asserts the two sets equal the derived
 * { non-EMPTY imagePath } / { EMPTY imagePath } partitions — if the atlas
 * ever gains or re-types a frame, the parity test goes RED until these
 * tables are updated.
 *
 * Pure data, zero imports — safe for every consumer (client bake, shared
 * rule tests, server parity test); importing it changes no RNG stream
 * (ADR 0035).
 */

/**
 * Every `game`-atlas frame whose `env.tsx` TYPE is an OBJECT type — wall,
 * crate, barrel, chest, door, exit or trap (incl. `planks`, a crate type,
 * and `doorway`, an exit type). These frames are DENIED in all bake-driven
 * frame tables: the `SECTOR_IDENTITY[*].gateway` bracket/accent frames (the
 * shared rule test asserts the denial; the `archFrame` slot was emptied by
 * map-polish ticket 19 — no arch at corridor midpoints; the ticket-29 strip
 * removed the landmark-parts/minor-prop frame tables that used to sit here).
 */
export const OBJECT_VISUAL_FRAMES: ReadonlySet<string> = new Set([
  'barrel',
  'barrels',
  'barrels_stacked',
  'campfire',
  'chair',
  'chest',
  'coffin',
  'crate',
  'crate_small',
  'door_closed',
  'door_open',
  'doorway',
  'inner_diagonal',
  'inner_long_diagonal',
  'inner_long_round',
  'inner_round',
  'planks',
  'trap',
  'trap_door',
  'trapdoor_round',
  'trapdoor_square',
  'tree',
  'wall',
  'wall_corner',
  'wall_curve',
  'wall_damaged',
  'wall_demolished',
  'wall_diagonal',
  'wall_edge',
  'wall_half',
  'wall_secret',
  'wall_trap',
]);

/**
 * The complement: every `game`-atlas frame that IS legal bake material —
 * floor/decor visuals (TYPE `EMPTY` or the collider-free decor-overlay
 * frames: paths, plants, water, track, stairs…). Bake-driven frame tables
 * must reference ONLY members of this set; membership doubles as a
 * spell-check (a typo'd frame name would silently skip in the client bake's
 * `gameAtlas.has` guard — the positive assertion catches it in CI instead).
 *
 * Map-polish ticket 19 audit: the corridor-midpoint gateway arch (the only
 * consumer of `stairs_down` in any map bake table) was removed, but
 * `stairs_down` / `stairs_down_detail` STAY in this set — the set is a
 * complete transcription of the atlas's EMPTY-typed partition, byte-pinned
 * by the server parity test (`TsxAtlasParser.test.ts` "DECOR_BAKE_FRAMES
 * exactly equals the EMPTY/decor-overlay imagePaths"), so membership is
 * VOCABULARY, not a placement license; removing a frame here would go red
 * against the atlas until the atlas itself drops the frame.
 */
export const DECOR_BAKE_FRAMES: ReadonlySet<string> = new Set([
  'grass',
  'path',
  'path_crossing',
  'path_curve',
  'plants',
  'puddle',
  'stairs_down',
  'stairs_down_detail',
  'tile',
  'tiles',
  'tiles_center',
  'tiles_corner',
  'tiles_cracked',
  'tiles_decorative',
  'track',
  'track_crossing',
  'track_curve',
  'water',
  'wood',
]);
