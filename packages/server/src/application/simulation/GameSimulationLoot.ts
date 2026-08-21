import {
  TileType,
  weaponRegistry,
  WeaponType,
  WeaponTier,
  DURABILITY_BY_TIER,
  IdGenerator,
  SeededRNG,
  NETWORK,
} from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import { PowerUp } from '../../domain/entities/PowerUp.ts';
import { Position } from '../../domain/value-objects/index.ts';
import { LootService } from '../../domain/services/LootService.ts';

interface LootHandlerContext {
  match: GameMatch;
  lootService: LootService;
  lootRng: SeededRNG;
  lootIdGen: IdGenerator;
  powerUpIdGen: IdGenerator;
  processedDestructibles: Set<string>;
  /**
   * ticket 10 — last GameMatch.orphanSweepVersion this sweep ran for
   * (-1 forces the first run). Mutated only inside
   * {@linkcode processDestroyedDestructibles}.
   */
  lastOrphanSweepVersion: number;
}

/**
 * Orphan sweep — destroys destructibles whose tile became EMPTY out from
 * under them (any destruction path that clears the tile without deleting
 * every destructible on it), dropping crate loot for non-barrels.
 *
 * ticket 10 — dirty gate. The sweep's outcome can only change when a tile
 * was cleared to EMPTY or a destructible was added, so it runs only when
 * GameMatch.orphanSweepVersion moved since the last run. RAISE-SITE AUDIT
 * (every path that can make a NEW destructible pass the tile === EMPTY
 * test — mirrored on the counter's declaration in GameMatch.ts):
 *
 *   tile → EMPTY writes:
 *   - GameMatch.setTileAt(type === EMPTY) — the funnel for every
 *     destroyDestructibleAction destruction (melee/arrow/thrown hits,
 *     barrel fuse expiry step5, siege destroyEntitiesOnTile, this sweep
 *     itself) and ChestOpeningHandler chest-open completion
 *   - BarrelExplosionManager ray clears (direct grid writes, incl. barrel
 *     chains) — both sites invoke the clearTileColliderVisual wiring,
 *     which bumps (see GameMatchInit.initMatchHandlers)
 *   - MapSiegeCascade writes INDESTRUCTIBLE_WALL only (the opposite
 *     direction — it can only HIDE a potential orphan, which the ungated
 *     sweep could not see either; no raise needed)
 *   destructible adds:
 *   - GameMatch.addDestructible (MapEntityFactory spawns — pre-tick today)
 *   - GameMatch.hydrateEntities (GameMatchHydration direct sets — pre-tick)
 *
 * Skipped ticks are provably no-ops: hp/prime mutations and map deletes can
 * only REMOVE candidates (destroyed entities are skipped and isDestroyed
 * never resets; destructible positions are static), and an EMPTY → non-EMPTY
 * tile change only removes eligibility — so no RNG draw ever shifts. This
 * preserves tick-exact semantics: a wall whose tile clears on tick N raises
 * the version before the next step3 call (same tick if the clear precedes
 * step3, else N+1), which is exactly when the ungated sweep first observed
 * it too. lastOrphanSweepVersion is re-read AFTER the body so the sweep's
 * own destroyDestructible bumps are absorbed and never re-arm the gate.
 */
export function processDestroyedDestructibles(ctx: LootHandlerContext): void {
  const match = ctx.match;
  if (match.orphanSweepVersion === ctx.lastOrphanSweepVersion) return;
  const state = match.getState();
  const destroyedIds: string[] = [];
  // ticket 10 — allocation-free worldToGrid: the same floor-div expression
  // GameMatch.worldToGrid evaluates, written to locals instead of a fresh
  // {gridX, gridY} object per entity per sweep.
  const tileWidth = match.config.map.tileWidth;
  const tileHeight = match.config.map.tileHeight;
  for (const [id, d] of state.destructibles) {
    if (d.isDestroyed || ctx.processedDestructibles.has(id)) continue;
    const gridX = Math.floor(d.position.x / tileWidth);
    const gridY = Math.floor(d.position.y / tileHeight);
    const tile = match.getTileAt(gridX, gridY);
    if (tile === TileType.EMPTY) {
      destroyedIds.push(id);
    }
  }
  for (const id of destroyedIds) {
    if (ctx.processedDestructibles.has(id)) continue;
    ctx.processedDestructibles.add(id);
    const d = state.destructibles.get(id);
    if (!d) continue;
    if (d.type === 'barrel') continue;
    // Map-polish ticket 07/09: NON-SOLID destructibles (today: light-prop
    // fixtures) sit on legitimately EMPTY tiles (never a destructible tile
    // type), so the EMPTY-tile heuristic above would sweep every one of them
    // off the map (with crate loot!) on the first tick. They die ONLY through
    // the real damage pipelines (takeDamage → destroyDestructible). Keyed on
    // the non-solid property, not the type string — future non-solid
    // destructible types inherit the guard for free.
    if (d.nonSolid) continue;
    if (d.type === 'wall') {
      ctx.match.destroyDestructible(id);
      continue;
    }
    const pos = { x: d.position.x, y: d.position.y };
    const crateLoot = ctx.lootService.rollCrateLoot(ctx.lootRng);

    let lootData: { weaponType: WeaponType; tier: WeaponTier } | null = null;

    if (crateLoot && crateLoot.kind === 'weapon') {
      const pool = weaponRegistry.getSpawnableTypes();
      const weaponType = ctx.lootRng.weightedPick(pool.map((w) => ({ item: w, weight: 1 })));
      const definition = weaponRegistry.getDefinition(weaponType);
      const ammo = DURABILITY_BY_TIER[crateLoot.tier];
      const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
      const weapon = new WeaponEntity(
        ctx.lootIdGen.next(),
        weaponType,
        crateLoot.tier,
        ammo,
        ammo,
        cooldownTicks,
      );
      ctx.match.addWeaponPickup(weapon.id, weapon, new Position(pos.x, pos.y));
      lootData = { weaponType, tier: crateLoot.tier };
    } else if (crateLoot && crateLoot.kind === 'powerup') {
      const powerUp = PowerUp.create(
        ctx.powerUpIdGen.next(),
        crateLoot.powerUpType,
        new Position(pos.x, pos.y),
        ctx.match.currentTick,
      );
      ctx.match.addPowerUp(powerUp);
    }

    ctx.match.destroyDestructible(id, lootData);
  }
  ctx.processedDestructibles.clear();
  ctx.lastOrphanSweepVersion = match.orphanSweepVersion;
}

export type { LootHandlerContext };
