import {
  TileType,
  TrapType,
  WeaponType,
  weaponRegistry,
  DURABILITY_BY_TIER,
  IdGenerator,
  SeededRNG,
  NETWORK,
  isLightPropEntityPlacement,
  type GameConfig,
} from '@sector-battle/shared';
import { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { MapResult } from '../../domain/services/MapGenerator.ts';
import { Position, GridCoord } from '../../domain/value-objects/index.ts';
import { Trap, Chest, Destructible, Exit, PowerUp } from '../../domain/entities/index.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import type { DestructibleType } from '../../domain/entities/Destructible.ts';

/**
 * Constructs all map entities (Destructibles, Exits, Chests, Traps,
 * WeaponPickups, PowerUps) from the map-result placement arrays.
 *
 * Extracted from `GameOrchestratorInit` — a pure one-shot factory with no
 * shared state: it reads `mapResult` placement arrays and writes the
 * constructed entities into the {@link GameMatch}. The `entityRng`
 * (constructed from `mapResult.seed ^ 0xcafe_babe`) is built inside
 * {@link populate} so the RNG construction order — and therefore the
 * determinism of trap-type and powerup-type selection — is preserved
 * byte-for-byte.
 */
export class MapEntityFactory {
  /**
   * Populate {@link match} with all entities derived from {@link mapResult}.
   *
   * Reads the destructible / chest / trap / weapon / powerup / exit placement
   * arrays (plus the raw tile grid for leftover walls and exits) and writes
   * the constructed entities into the match. Pure mechanical relocation of
   * the original `populateEntities` free function — body verbatim.
   *
   * @param match     The match aggregate to receive the constructed entities.
   * @param mapResult The map-generator output carrying placements + grid.
   * @param config    The game config (used for tile size + sector geometry).
   */
  populate(match: GameMatch, mapResult: MapResult, config: GameConfig): void {
    const idGen = new IdGenerator('entity');
    const tileSize = config.map.tileWidth;
    const grid = mapResult.grid;
    const trapTypes = [TrapType.SPIKE, TrapType.FIRE, TrapType.TELEPORT];
    const entityRng = new SeededRNG(mapResult.seed ^ 0xcafe_babe);

    const placedPositions = new Set<string>();
    for (const dp of mapResult.destructiblePlacements ?? []) {
      const pos = new Position(
        dp.gridX * tileSize + tileSize / 2,
        dp.gridY * tileSize + tileSize / 2,
      );
      const dtype: DestructibleType =
        dp.tileType === TileType.DESTRUCTIBLE_WALL
          ? 'wall'
          : dp.tileType === TileType.DESTRUCTIBLE_BARREL
            ? 'barrel'
            : dp.tileType === TileType.DESTRUCTIBLE_CRATE
              ? 'crate'
              : 'iron';
      const id = idGen.next();
      match.addDestructible(
        Destructible.create(
          id,
          dtype,
          pos,
          dp.textureKey,
          dp.rotation ?? 0,
          dp.flipH ?? false,
          dp.flipV ?? false,
        ),
      );
      placedPositions.add(`${dp.gridX},${dp.gridY}`);
    }

    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y]!.length; x++) {
        const tile = grid[y]![x]!;
        const key = `${x},${y}`;
        if (placedPositions.has(key)) continue;

        if (tile === TileType.DESTRUCTIBLE_WALL || tile === TileType.INDESTRUCTIBLE_CRATE) {
          const pos = new Position(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2);
          const dtype: DestructibleType = tile === TileType.DESTRUCTIBLE_WALL ? 'wall' : 'iron';
          const id = idGen.next();
          match.addDestructible(Destructible.create(id, dtype, pos));
        } else if (tile === TileType.EXIT) {
          const pos = new Position(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2);
          const id = idGen.next();
          const sectorSize = config.map.sectorSize;
          const sectorCols = Math.floor(config.map.arenaWidth / sectorSize);
          const sectorIndex = Math.floor(y / sectorSize) * sectorCols + Math.floor(x / sectorSize);
          match.addExit(new Exit(id, pos, new GridCoord(x, y), sectorIndex));
        }
      }
    }

    // ── Light-prop destructible entities (map-polish ticket 07) ──────────────
    // Every NON-EXEMPT light placement (route-mid sconce / dark-gap fill /
    // POI glow pool / biome crystal — `isLightPropEntityPlacement` on the
    // `anchor` provenance) hydrates as a `'light'` destructible at its tile,
    // joining `state.destructibles` so the existing spatial-index / melee /
    // thrown / projectile / explosion paths damage it with no bespoke wiring.
    // The exemption set stays baked static data: beacons (kind-identified, no
    // anchor), doorway sconces (`anchor: 'doorway'`), campfires (already
    // backed by their crate entities). NON-SOLID by design: the grid tile
    // stays EMPTY (no walkability/fairness perturbation — the generation-time
    // gates never saw light tiles as solids); destruction's setTileAt(EMPTY)
    // is a no-op. Ids are positional (`dest_light_<row>_<col>`) — placements
    // never share a tile (the placer's global claim set), so the ids are
    // unique and same-seed deterministic. maxHp 1: any single hit smashes
    // the fixture; no loot drop, no explosion (the damage handler's loot
    // branch keys on `type === 'crate'` only).
    if (mapResult.lightPlacements) {
      for (const lp of mapResult.lightPlacements) {
        if (!isLightPropEntityPlacement(lp)) continue;
        const pos = new Position(
          lp.gridX * tileSize + tileSize / 2,
          lp.gridY * tileSize + tileSize / 2,
        );
        const id = `dest_light_${lp.gridY}_${lp.gridX}`;
        match.addDestructible(
          Destructible.create(id, 'light', pos, lp.kind, lp.rotation, lp.flipH, lp.flipV),
        );
      }
    }

    for (const cp of mapResult.chestPlacements) {
      const id = idGen.next();
      const pos = new Position(
        cp.gridX * tileSize + tileSize / 2,
        cp.gridY * tileSize + tileSize / 2,
      );
      match.addChest(
        Chest.create(
          id,
          cp.tier,
          pos,
          cp.textureKey ?? '',
          cp.rotation ?? 0,
          cp.flipH ?? false,
          cp.flipV ?? false,
        ),
      );
    }

    for (const tp of mapResult.trapPlacements) {
      const id = idGen.next();
      const pos = new Position(
        tp.gridX * tileSize + tileSize / 2,
        tp.gridY * tileSize + tileSize / 2,
      );
      const typeIdx = entityRng.nextInt(0, trapTypes.length - 1);
      const trapType = tp.trapType ?? trapTypes[typeIdx]!;
      match.addTrap(
        Trap.create(
          id,
          trapType,
          pos,
          tp.textureKey ?? '',
          tp.rotation ?? 0,
          tp.flipH ?? false,
          tp.flipV ?? false,
        ),
      );
    }

    for (const wp of mapResult.weaponSpawnPlacements) {
      const id = idGen.next();
      const pos = new Position(
        wp.gridX * tileSize + tileSize / 2,
        wp.gridY * tileSize + tileSize / 2,
      );
      const weaponType = wp.weaponType ?? WeaponType.FISTS;
      const definition = weaponRegistry.getDefinition(weaponType);
      const ammo = DURABILITY_BY_TIER[wp.tier] ?? 30;
      const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
      const weapon = new WeaponEntity(id, weaponType, wp.tier, ammo, ammo, cooldownTicks);
      match.addWeaponPickup(
        id,
        weapon,
        pos,
        wp.textureKey ?? '',
        wp.rotation ?? 0,
        wp.flipH ?? false,
        wp.flipV ?? false,
      );
    }

    if (mapResult.powerupPlacements) {
      const powerUpTypes: Array<'health_pack' | 'barrier' | 'speed_boost'> = [
        'health_pack',
        'health_pack',
        'barrier',
        'speed_boost',
      ];
      for (const pp of mapResult.powerupPlacements) {
        const id = idGen.next();
        const pos = new Position(
          pp.gridX * tileSize + tileSize / 2,
          pp.gridY * tileSize + tileSize / 2,
        );
        const type = powerUpTypes[entityRng.nextInt(0, powerUpTypes.length - 1)]!;
        const powerUp = PowerUp.create(id, type, pos, 0);
        match.addPowerUp(powerUp);
      }
    }

    if (mapResult.exitPlacements) {
      for (const ep of mapResult.exitPlacements) {
        const id = idGen.next();
        const pos = new Position(
          ep.gridX * tileSize + tileSize / 2,
          ep.gridY * tileSize + tileSize / 2,
        );
        match.addExit(
          new Exit(
            id,
            pos,
            new GridCoord(ep.gridX, ep.gridY),
            0,
            true,
            ep.textureKey,
            ep.rotation,
            ep.flipH,
            ep.flipV,
          ),
        );
      }
    }
  }
}
