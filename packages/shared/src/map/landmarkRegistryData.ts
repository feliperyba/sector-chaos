import type { LandmarkComposition } from './landmarkRegistry.js';

/**
 * The authored composition DATA behind {@link LANDMARK_REGISTRY}
 * (map-redesign ticket 04 / DEC-002; stripped of the bake-time visual fields
 * — per-type `tint`, per-composition `scale`, `parts` — by map-polish ticket
 * 29, per the owner's "remove the baked dressing, compose over the grid
 * layers" ruling; the client composite bake that consumed them is deleted).
 * Split from `landmarkRegistry.ts` for the 500-line file gate — this module
 * is pure data (four per-type arrays of placement/naming identity).
 */

// ---------------------------------------------------------------------------
// Registry (4 entries per type — inside the 3–5 band; 1 RARE each)
// ---------------------------------------------------------------------------

export const GRID_ARENA_COMPOSITIONS: readonly LandmarkComposition[] = [
  {
    id: 'watch-spire',
    family: 'Watch Spire',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Classic Lattice': ['Matrix', 'Bastion'],
      'Ring Fortress': ['Keep', 'Ringhold'],
      'Broken Grid': ['Bulwark'],
      'Lane Corridors': ['Passages'],
      'Plaza Crossroads': ['Crossroads'],
    },
  },
  {
    id: 'antenna-mast',
    family: 'Antenna Mast',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Classic Lattice': ['Lattice', 'Gridwork'],
      'Ring Fortress': ['Redoubt'],
      'Broken Grid': ['Ruins'],
      'Lane Corridors': ['Channels'],
      'Plaza Crossroads': ['Plaza'],
    },
  },
  {
    id: 'signal-cairn',
    family: 'Signal Cairn',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Classic Lattice': ['Bastion'],
      'Ring Fortress': ['Ringhold'],
      'Broken Grid': ['Rubble'],
      'Lane Corridors': ['Lanes'],
      'Plaza Crossroads': ['Forum'],
    },
  },
  {
    id: 'relic-coffin',
    family: 'Relic Coffin',
    rarity: 'rare',
    exclusionRadius: 3,
    nounHints: {
      'Classic Lattice': ['Gridwork', 'Matrix'],
      'Ring Fortress': ['Bastion', 'Keep'],
      'Broken Grid': ['Shambles'],
      'Lane Corridors': ['Corridors'],
      'Plaza Crossroads': ['Junctions'],
    },
  },
];

export const OPEN_ARENA_COMPOSITIONS: readonly LandmarkComposition[] = [
  {
    id: 'landing-cross',
    family: 'Landing Cross',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Corner Bastions': ['Watchpost', 'Outposts'],
      'Central Monument': ['Monument', 'Spire'],
      'Scatter Cover': ['Flats'],
      'Diagonal Spurs': ['Runs'],
      Airstrip: ['Runway'],
    },
  },
  {
    id: 'glider-wreck',
    family: 'Glider Wreck',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Corner Bastions': ['Bulwark'],
      'Central Monument': ['Obelisk'],
      'Scatter Cover': ['Expanse', 'Steppe'],
      'Diagonal Spurs': ['Cuts'],
      Airstrip: ['Airstrip'],
    },
  },
  {
    id: 'harvest-effigy',
    family: 'Harvest Effigy',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Corner Bastions': ['Cornerstone'],
      'Central Monument': ['Monolith'],
      'Scatter Cover': ['Reach'],
      'Diagonal Spurs': ['Spurs'],
      Airstrip: ['Field'],
    },
  },
  {
    id: 'ember-totem',
    family: 'Ember Totem',
    rarity: 'rare',
    exclusionRadius: 3,
    nounHints: {
      'Corner Bastions': ['Outposts'],
      'Central Monument': ['Spire', 'Obelisk'],
      'Scatter Cover': ['Steppe'],
      'Diagonal Spurs': ['Ridges'],
      Airstrip: ['Aerodrome'],
    },
  },
];

export const MAZE_COMPOSITIONS: readonly LandmarkComposition[] = [
  {
    id: 'forgotten-idol',
    family: 'Forgotten Idol',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Loose Labyrinth': ['Labyrinth', 'Tangle'],
      'Chambers & Halls': ['Chambers', 'Undercroft'],
      'Breakable Warren': ['Warren', 'Burrow'],
      'Concentric Spiral': ['Vortex'],
      'Sewer Grid': ['Cisterns'],
    },
  },
  {
    id: 'broken-colonnade',
    family: 'Broken Colonnade',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Loose Labyrinth': ['Warrens'],
      'Chambers & Halls': ['Halls', 'Gallery'],
      'Breakable Warren': ['Maze'],
      'Concentric Spiral': ['Rings'],
      'Sewer Grid': ['Conduits'],
    },
  },
  {
    id: 'rune-arch',
    family: 'Rune Arch',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Loose Labyrinth': ['Switchbacks'],
      'Chambers & Halls': ['Gallery'],
      'Breakable Warren': ['Rabbitry'],
      'Concentric Spiral': ['Spiral'],
      'Sewer Grid': ['Galleries'],
    },
  },
  {
    id: 'sunken-fountain',
    family: 'Sunken Fountain',
    rarity: 'rare',
    exclusionRadius: 3,
    nounHints: {
      'Loose Labyrinth': ['Tangle'],
      'Chambers & Halls': ['Undercroft'],
      'Breakable Warren': ['Burrow'],
      'Concentric Spiral': ['Coils'],
      'Sewer Grid': ['Sewers'],
    },
  },
];

export const RESOURCE_RICH_COMPOSITIONS: readonly LandmarkComposition[] = [
  {
    id: 'gilded-effigy',
    family: 'Gilded Effigy',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Treasure Vault': ['Vault', 'Treasury'],
      'Loot Bazaar': ['Market', 'Exchange'],
      'Exposed Cache': ['Hoard'],
      'Supply Depot': ['Depot', 'Storehouse'],
      'Bank Row': ['Mint'],
    },
  },
  {
    id: 'coin-fountain',
    family: 'Coin Fountain',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Treasure Vault': ['Strongroom'],
      'Loot Bazaar': ['Bazaar'],
      'Exposed Cache': ['Trove', 'Stockpile'],
      'Supply Depot': ['Armory'],
      'Bank Row': ['Countinghouse'],
    },
  },
  {
    id: 'scales-monument',
    family: 'Scales Monument',
    rarity: 'common',
    exclusionRadius: 2,
    nounHints: {
      'Treasure Vault': ['Cache'],
      'Loot Bazaar': ['Emporium'],
      'Exposed Cache': ['Cache'],
      'Supply Depot': ['Quartermaster'],
      'Bank Row': ['Reserve'],
    },
  },
  {
    id: 'aurum-obelisk',
    family: 'Aurum Obelisk',
    rarity: 'rare',
    exclusionRadius: 3,
    nounHints: {
      'Treasure Vault': ['Treasury'],
      'Loot Bazaar': ['Exchange'],
      'Exposed Cache': ['Stockpile'],
      'Supply Depot': ['Storehouse', 'Armory'],
      'Bank Row': ['Bank'],
    },
  },
];
