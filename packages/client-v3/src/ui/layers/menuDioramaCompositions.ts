/**
 * menuDioramaCompositions — the per-variant composition builders (7 curated
 * flavour scenes composed via the shared `buildMapLayers` grammar). Mechanical
 * extraction from menuDioramaComposition.ts (F8 file-length retirement) —
 * bodies verbatim, only the module boundary moved. Every builder is PURE →
 * byte-identical across boots.
 *
 * ── Variant builders — 8 evocative flavour scenes (2-tone chiaroscuro) ──────
 *
 * Each variant is a DISTINCT place (LOTR / tavern / battlefield energy). The
 * shared SPINE — floor underlay + border ring + central hearth + a worn path
 * aisle (the lit sightline to the fire) — makes every scene read as a ROOM.
 * Per-variant distinction rides on top: the floor material, the wall aperture
 * (a doorway / breach / sealed door), motivated prop clusters hugging the walls
 * / corners, a per-variant bake-haze tint ("same light, different air"), AND a
 * UNIQUE light rig (see `menuDioramaPlacements.ts` — geometry + fixture kind-mix
 * + crystal locale are all per-variant).
 *
 * The button UI sits at cols 6–9, rows 4–6 — that zone stays a clean stage (no
 * tall props behind the buttons); only the low-weight path aisle (BG, parallax-
 * locked to the floor) may pass through it.
 */
import type { MenuDioramaLayer } from './menuDioramaComposition.js';
import {
  buildMapLayers,
  aisle,
  farTreeLine,
  farDarkWall,
  farRuinedWall,
  MENU_HAZE_COLOR,
} from './menuDioramaGrammar.js';

/**
 * Forest-bonfire — "Elven Glade": a warm campfire clearing. GEOMETRIC side-wall
 * brackets (torches + lanterns mirrored on the side walls) + emerald moss accents
 * mirrored in the mid-side shadow. A centered path + entrance; minimal mirrored
 * plant clusters.
 */
export function buildForestBonfireComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'grass',
    floorAlt: 'grass',
    pillar: 'wall',
    hearth: 'tiles_center',
    hazeColor: MENU_HAZE_COLOR,
    floorDecorations: aisle('path', 3, 7),
    scatter: [
      { frame: 'plants', col: 4, row: 4 },
      { frame: 'plants', col: 11, row: 4 },
      { frame: 'doorway', col: 7, row: 8 },
      { frame: 'doorway', col: 8, row: 8 },
    ],
    far: farTreeLine(),
    fore: 'tree',
  });
}

/**
 * Forest-glade — "Moonlit Grove": a serene, COOL clearing (steel-blue
 * moonlight). GEOMETRIC inner-diamond lanterns (a rhombus) + steel-blue crystal
 * accents. Sparse mirrored greenery; a pale moonlit aisle.
 */
export function buildForestGladeComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'grass',
    floorAlt: 'grass',
    pillar: 'wall',
    hearth: 'tiles_center',
    hazeColor: 0x2a3848, // cool moonlit blue-grey
    floorDecorations: aisle('tiles_decorative', 3, 7),
    scatter: [
      { frame: 'plants', col: 3, row: 4 },
      { frame: 'plants', col: 12, row: 4 },
      { frame: 'plants', col: 5, row: 7 },
      { frame: 'plants', col: 10, row: 7 },
    ],
    far: farTreeLine(),
    fore: 'tree',
  });
}

/**
 * Forest-ruins — "Overgrown Stone": ancient ruins reclaimed by woods. GEOMETRIC
 * quad-corner brackets (torches + braziers at the 4 inner corners) + mossy
 * teal-green crystal accents. Mirrored ruined-stone patches + creeping growth.
 */
export function buildForestRuinsComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'tiles',
    floorAlt: 'tiles_cracked',
    pillar: 'wall_damaged',
    hearth: 'tiles_center',
    hazeColor: 0x3a4030, // mossy green-grey
    floorDecorations: aisle('path', 3, 7),
    scatter: [
      { frame: 'tiles_cracked', col: 2, row: 4 },
      { frame: 'tiles_cracked', col: 13, row: 4 },
      { frame: 'plants', col: 4, row: 6 },
      { frame: 'plants', col: 11, row: 6 },
    ],
    far: farRuinedWall(),
    fore: 'wall_damaged',
  });
}

/**
 * Forest-creek — "Forest Stream": a horizontal stream across the lower glade.
 * GEOMETRIC bank-flank lanterns + candles (mirrored on the banks) + teal creek
 * crystals at the water's edge. A dry stone path leads down to the stream.
 */
export function buildForestCreekComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'grass',
    floorAlt: 'grass',
    pillar: 'wall',
    hearth: 'tiles_center',
    hazeColor: 0x2a3a44, // cool wet blue-grey
    floorDecorations: aisle('tile', 3, 6),
    scatter: [
      // The horizontal stream (row 7, cols 4–11) — symmetric about the center.
      { frame: 'water', col: 4, row: 7 },
      { frame: 'water', col: 5, row: 7 },
      { frame: 'water', col: 6, row: 7 },
      { frame: 'water', col: 7, row: 7 },
      { frame: 'water', col: 8, row: 7 },
      { frame: 'water', col: 9, row: 7 },
      { frame: 'water', col: 10, row: 7 },
      { frame: 'water', col: 11, row: 7 },
      { frame: 'plants', col: 3, row: 4 },
      { frame: 'plants', col: 12, row: 4 },
    ],
    far: farTreeLine(),
    fore: 'tree',
  });
}

/**
 * Crypt-antechamber — "Barrow Tomb": a sealed spectral tomb. STRICT bilateral
 * symmetry — a sealed door centered top, coffin rows mirroring L/R, vigil
 * candles + chairs flanking. The one variant where symmetry IS the point.
 */
export function buildCryptAntechamberComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'tiles',
    floorAlt: 'tiles_cracked',
    pillar: 'wall',
    hearth: 'tiles_center',
    hazeColor: 0x2a3038, // cold blue-grey
    floorDecorations: aisle('tiles_decorative', 3, 7),
    scatter: [
      { frame: 'door_closed', col: 7, row: 0 },
      { frame: 'door_closed', col: 8, row: 0 },
      { frame: 'coffin', col: 3, row: 5 },
      { frame: 'coffin', col: 12, row: 5 },
      { frame: 'coffin', col: 3, row: 6 },
      { frame: 'coffin', col: 12, row: 6 },
      { frame: 'chair', col: 2, row: 7 },
      { frame: 'chair', col: 13, row: 7 },
    ],
    far: farDarkWall(),
    fore: 'wall',
  });
}

/**
 * Armory-cache — "Dwarven Forge-hall": an orderly forge. GEOMETRIC wall forge
 * row (4 braziers on the side walls, mirrored upper+lower) + amber rune-glow
 * accents beside the mirrored weapon racks.
 */
export function buildArmoryCacheComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'wood',
    floorAlt: 'wood',
    pillar: 'wall',
    hearth: 'tile',
    hazeColor: 0x4a3520, // warm brown
    floorDecorations: aisle('track', 4, 6),
    scatter: [
      { frame: 'weapon_longsword', col: 2, row: 4 },
      { frame: 'weapon_bow', col: 13, row: 4 },
      { frame: 'chest', col: 3, row: 7 },
      { frame: 'crate', col: 12, row: 7 },
    ],
    far: farRuinedWall(),
    fore: 'wall_damaged',
  });
}

/**
 * Temple-threshold — "Sanctified Threshold": a divine gate. GEOMETRIC gate-frame
 * (braziers flanking the top gate + candles at the bottom, on the central axis)
 * + ivory-gold radiance accents. A grand centered double doorway + mirrored
 * inlays; the architecture is the feature.
 */
export function buildTempleThresholdComposition(): MenuDioramaLayer[] {
  return buildMapLayers({
    floor: 'tiles_decorative',
    floorAlt: 'tiles_cracked',
    pillar: 'wall',
    hearth: 'tiles_center',
    hazeColor: 0x4a3a20, // golden
    floorDecorations: aisle('path', 3, 7),
    scatter: [
      { frame: 'doorway', col: 7, row: 0 },
      { frame: 'door_open', col: 8, row: 0 },
      { frame: 'tiles_corner', col: 4, row: 4 },
      { frame: 'tiles_corner', col: 11, row: 4 },
      { frame: 'plants', col: 3, row: 7 },
      { frame: 'plants', col: 12, row: 7 },
    ],
    far: farRuinedWall(),
    fore: 'wall_damaged',
  });
}
