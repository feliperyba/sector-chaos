import { resolve } from 'node:path';
import {
  TileType,
  SeededRNG,
  type EnrichedMapData,
  type GameConfig,
  type SpawnPoint,
  rollWeaponTier,
  rollChestTier,
} from '@sector-battle/shared';
import { MapGenerator, type MapResult } from '../domain/services/MapGenerator.ts';
import { applyWeaponSpawnClearance } from '../domain/services/WeaponSpawnClearance.ts';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';
import { TmxParser } from '../infrastructure/parsers/TmxParser.ts';
import { SeedMapAdapter } from '../infrastructure/map/SeedMapAdapter.js';
import { buildSpawnPoints } from './GameRoomSpawnPoints.ts';

const TILED_DIR = resolve(import.meta.dirname, '../../../../tiled');

export interface MapBuildContext {
  mapResult: MapResult;
  enrichedData: EnrichedMapData;
}

/**
 * Build the MapResult from either a demo TMX map or procedural generation,
 * merge enriched entities (textureKey/weaponType/rotation/flip) back in.
 *
 * Pure mechanical extraction from the original handleOnCreate — bodies
 * verbatim, no logic changes.
 */
export function buildGameMapResult(
  options: { mapType?: string },
  seed: number,
  configMap: GameConfig['map'],
): MapBuildContext {
  // Deterministic RNG for tier rolls — replaces the legacy Math.random() source
  // so a given seed reproduces the same loot-tier placements (weight tables
  // unchanged). Forked from the map seed so it stays independent of any other
  // seed-derived stream.
  const tierRng = new SeededRNG((seed ^ 0x5ece5) >>> 0);
  const useDemoMap = options.mapType === 'demo';
  let mapResult: MapResult;
  let enrichedData: EnrichedMapData;
  if (useDemoMap) {
    const parser = new TmxParser();
    enrichedData = parser.parse(resolve(TILED_DIR, 'demo_map.tmx'));
    mapResult = {
      grid: enrichedData.grid,
      seed: enrichedData.seed,
      spawnPoints: buildSpawnPoints(enrichedData),
      destructiblePlacements: enrichedData.entities.destructibles.map((d) => ({
        gridX: d.gridX,
        gridY: d.gridY,
        tileType: d.tileType,
        textureKey: d.textureKey,
        rotation: d.rotation,
        flipH: d.flipH,
        flipV: d.flipV,
      })),
      chestPlacements: enrichedData.entities.chests.map((c) => ({
        gridX: c.gridX,
        gridY: c.gridY,
        tier: rollChestTier(tierRng),
        textureKey: c.textureKey,
        rotation: c.rotation,
        flipH: c.flipH,
        flipV: c.flipV,
      })),
      trapPlacements: enrichedData.entities.traps.map((t) => ({
        gridX: t.gridX,
        gridY: t.gridY,
        trapType: t.trapType,
        textureKey: t.textureKey,
        rotation: t.rotation,
        flipH: t.flipH,
        flipV: t.flipV,
      })),
      weaponSpawnPlacements: enrichedData.entities.weapons.map((w) => ({
        gridX: w.gridX,
        gridY: w.gridY,
        tier: w.tier ?? rollWeaponTier(tierRng),
        weaponType: w.weaponType,
        textureKey: w.textureKey,
        rotation: w.rotation,
        flipH: w.flipH,
        flipV: w.flipV,
      })),
      exitPlacements: enrichedData.entities.exits.map((e) => ({
        gridX: e.gridX,
        gridY: e.gridY,
        textureKey: e.textureKey,
        rotation: e.rotation,
        flipH: e.flipH,
        flipV: e.flipV,
      })),
      // Map-polish ticket 07: the final placement list rides MapResult into
      // the match hydration (light-prop destructible entities). Demo TMX maps
      // carry no light placements (empty list).
      lightPlacements: enrichedData.entities.lightPlacements,
    };
  } else {
    mapResult = new MapGenerator().generate(seed, configMap);
    const rawMapData = mapResult.rawMapData;
    if (!rawMapData) {
      throw new Error('rawMapData is required for procedural map generation');
    }
    const adapter = new SeedMapAdapter();
    enrichedData = adapter.adapt(rawMapData, seed, TILED_DIR);

    // Merge enriched entities (with correct textureKey/weaponType/rotation/flip)
    // into mapResult, mirroring the demo-map branch. MapGenerator.adapt() has no
    // atlas access so it drops weaponType and hardcodes textureKey=''; SeedMapAdapter
    // resolves the correct sprite keys and weapon types.
    const weaponTierByPos = new Map<
      string,
      (typeof mapResult.weaponSpawnPlacements)[number]['tier']
    >();
    for (const wp of mapResult.weaponSpawnPlacements) {
      weaponTierByPos.set(`${wp.gridX},${wp.gridY}`, wp.tier);
    }
    const chestTierByPos = new Map<string, (typeof mapResult.chestPlacements)[number]['tier']>();
    for (const cp of mapResult.chestPlacements) {
      chestTierByPos.set(`${cp.gridX},${cp.gridY}`, cp.tier);
    }

    mapResult.destructiblePlacements = enrichedData.entities.destructibles.map((d) => ({
      gridX: d.gridX,
      gridY: d.gridY,
      tileType: d.tileType,
      textureKey: d.textureKey,
      rotation: d.rotation,
      flipH: d.flipH,
      flipV: d.flipV,
    }));
    mapResult.weaponSpawnPlacements = enrichedData.entities.weapons.map((w) => ({
      gridX: w.gridX,
      gridY: w.gridY,
      tier: weaponTierByPos.get(`${w.gridX},${w.gridY}`) ?? rollWeaponTier(tierRng),
      weaponType: w.weaponType,
      textureKey: w.textureKey,
      rotation: w.rotation,
      flipH: w.flipH,
      flipV: w.flipV,
    }));
    mapResult.chestPlacements = enrichedData.entities.chests.map((c) => ({
      gridX: c.gridX,
      gridY: c.gridY,
      tier: chestTierByPos.get(`${c.gridX},${c.gridY}`) ?? rollChestTier(tierRng),
      textureKey: c.textureKey,
      rotation: c.rotation,
      flipH: c.flipH,
      flipV: c.flipV,
    }));
    mapResult.trapPlacements = enrichedData.entities.traps.map((t) => ({
      gridX: t.gridX,
      gridY: t.gridY,
      trapType: t.trapType,
      textureKey: t.textureKey,
      rotation: t.rotation,
      flipH: t.flipH,
      flipV: t.flipV,
    }));
    // Map-polish ticket 07: the FINAL (post hue-enforcement) placement list —
    // the exact list the client renders — hydrates as light-prop entities, so
    // a dropped (enforced) crystal never leaves an unbacked light on.
    mapResult.lightPlacements = enrichedData.entities.lightPlacements;
  }
  // Both map paths converge here: no ground weapon hydrates flush against
  // solid cover, so projectiles (arrows AND thrown weapons — one shared
  // collision system) never die inside a weapon's sprite footprint. See
  // WeaponSpawnClearance for the geometry argument.
  applyWeaponSpawnClearance(mapResult);
  return { mapResult, enrichedData };
}

export function createPathfinder(mapGrid: TileType[][], tileWidth: number): Pathfinder {
  const grid = mapGrid.map((row) =>
    row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
  );
  return new Pathfinder(grid, tileWidth, mapGrid);
}

// type-only re-export for back-compat with any code that imports SpawnPoint
// via this module
export type { SpawnPoint };
