import {
  weaponRegistry,
  DURABILITY_BY_TIER,
  WeaponType,
  WeaponTier,
  SeededRNG,
  IdGenerator,
  NETWORK,
} from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { WeaponEntity } from '../../domain/entities/index.ts';
import { PowerUp } from '../../domain/entities/PowerUp.ts';
import type { GamePowerUpType } from '../../domain/entities/PowerUp.ts';
import type { GameEvent } from '../../domain/events/index.ts';
import { Position } from '../../domain/value-objects/index.ts';
import { LootService } from '../../domain/services/LootService.ts';

const POWERUP_TYPE_MAP: Record<string, GamePowerUpType> = {
  health_pack: 'health_pack',
  barrier: 'barrier',
  speed_boost: 'speed_boost',
};

export class DestructibleDamageHandler {
  private lootIdGen: IdGenerator;
  private powerUpIdGen: IdGenerator;
  private lootRng: SeededRNG;
  private lootService: LootService;

  constructor(match: GameMatch) {
    this.lootIdGen = new IdGenerator('loot-melee');
    this.powerUpIdGen = new IdGenerator('pu-melee');
    this.lootRng = new SeededRNG(match.mapSeed || 12345);
    this.lootService = new LootService();
  }

  handleDamage(
    destIds: string[],
    match: GameMatch,
    events: GameEvent[],
    weaponType: WeaponType,
  ): void {
    const state = match.getState();
    const toDestroy: string[] = [];
    const def = weaponRegistry.getDefinition(weaponType);
    const destructibleDamage = def.baseStats.destructibleDamage;

    for (const destId of destIds) {
      const d = state.destructibles.get(destId);
      if (!d || d.isDestroyed) continue;
      const dmgResult = d.takeDamage({
        source: 'melee',
        rawDamage: destructibleDamage,
        currentTick: match.currentTick,
      });
      // ticket 08 — static-row sync gate: this takeDamage may have changed
      // hp/primed (destroyed hits bump again via match.destroyDestructible
      // below; over-bumping only costs one extra projection pass).
      match.destructibleVersion++;
      if (dmgResult.destroyed) {
        toDestroy.push(destId);
      }
    }

    for (const id of toDestroy) {
      const d = state.destructibles.get(id);
      if (!d) continue;

      const pos = { x: d.position.x, y: d.position.y };
      const destType = d.type;

      let lootData: { weaponType: WeaponType; tier: WeaponTier } | null = null;
      if (destType === 'crate') {
        const crateLoot = this.lootService.rollCrateLoot(this.lootRng);
        if (crateLoot && crateLoot.kind === 'weapon') {
          const pool = weaponRegistry.getSpawnableTypes();
          const weaponType = this.lootRng.weightedPick(pool.map((w) => ({ item: w, weight: 1 })));
          lootData = { weaponType, tier: crateLoot.tier };
        } else if (crateLoot && crateLoot.kind === 'powerup') {
          const gameType = POWERUP_TYPE_MAP[crateLoot.powerUpType] ?? 'health_pack';
          const powerUp = PowerUp.create(
            this.powerUpIdGen.next(),
            gameType,
            new Position(pos.x, pos.y),
            match.currentTick,
          );
          match.addPowerUp(powerUp);
        }
      }

      // Map-polish ticket 09 (destruction-loop regression test): NO re-emit
      // here — `destroyDestructibleAction` already emits every event into
      // the match's collector, so this second emit made each melee-destroyed
      // destructible broadcast `DestructibleDestroyed` TWICE. The events are
      // still pushed to the caller's list (the melee sweep's chain).
      const destroyEvents = match.destroyDestructible(id, lootData);
      events.push(...destroyEvents);

      if (destType === 'crate' && lootData) {
        const def = weaponRegistry.getDefinition(lootData.weaponType);
        const tier = lootData.tier;
        const ammo = DURABILITY_BY_TIER[tier];
        const cd = Math.ceil((def?.baseStats?.cooldown ?? 300) / NETWORK.TICK_INTERVAL);
        const pickupId = this.lootIdGen.next();
        const weapon = new WeaponEntity(pickupId, lootData.weaponType, tier, ammo, ammo, cd);
        match.addWeaponPickup(pickupId, weapon, new Position(pos.x, pos.y));
      }
    }
  }
}
