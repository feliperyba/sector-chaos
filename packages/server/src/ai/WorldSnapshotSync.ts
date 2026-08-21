import { WeaponType, logger } from '@sector-battle/shared';
import type { EntityMaps } from '../domain/aggregates/GameMatchEntityOps.ts';
import { tierToNumber } from './WorldSnapshotTypes.ts';
import type { WorldSnapshot } from './WorldSnapshot.ts';
import { syncZoneView } from './WorldSnapshotZone.ts';

/**
 * Sync helpers for WorldSnapshot. Pure mechanical extraction from the original
 * monolithic class — bodies verbatim, `this.→instance.` only.
 */

export function syncWorldSnapshot(snapshot: WorldSnapshot, maps: EntityMaps): void {
  snapshot.bumpTick();
  const tick = snapshot.currentTick;

  // Zone view FIRST (perf-arc ticket 17): ~12 scalar copies from the feed's
  // zoneService/siegeWallManager — the always-on cost that retired the
  // per-tick full-state projection the old zoneDataGetter closure paid.
  syncZoneView(snapshot);

  syncWorldPlayers(snapshot, maps.players);
  syncWorldItems(snapshot, maps.weaponPickups, maps.powerUps, maps.chests);
  if (snapshot.firstSync || tick % 5 === 0) {
    snapshot.firstSync = false;
    syncWorldDestructibles(snapshot, maps.destructibles);
    syncWorldTraps(snapshot, maps.traps);
  }
  syncWorldProjectiles(snapshot, maps.projectiles);
  rebuildWorldGrids(snapshot, tick);
}

export function rebuildWorldGrids(snapshot: WorldSnapshot, tick: number): void {
  // Player grid — rebuilt every tick (players move continuously). This is the
  // O(N) per-tick investment that buys O(local-density) perception per bot
  // instead of O(N). Without it, every bot's scanWorld linear-scans all players.
  const plg = snapshot.playerGrid;
  if (plg) {
    plg.clear();
    const entries = snapshot.playerEntries;
    const active = snapshot.playerActive;
    for (let i = 0; i < snapshot.playerActiveCount; i++) {
      const slot = active[i]!;
      const dto = entries[slot]!;
      // Only index ALIVE players — dead/spectating players are filtered in
      // scanWorld anyway, so indexing them just bloats the query results.
      if (dto.isAlive) plg.insert(slot, dto.x, dto.y);
    }
  }
  const ig = snapshot.itemGrid;
  if (ig) {
    ig.clear();
    const entries = snapshot.itemEntries;
    const active = snapshot.itemActive;
    for (let i = 0; i < snapshot.itemActiveCount; i++) {
      const slot = active[i]!;
      const dto = entries[slot]!;
      ig.insert(slot, dto.x, dto.y);
    }
  }
  const pg = snapshot.projectileGrid;
  if (pg) {
    pg.clear();
    const entries = snapshot.projectileEntries;
    const active = snapshot.projectileActive;
    for (let i = 0; i < snapshot.projectileActiveCount; i++) {
      const slot = active[i]!;
      const dto = entries[slot]!;
      pg.insert(slot, dto.x, dto.y);
    }
  }
  if (tick % 5 === 0) {
    const dg = snapshot.destructibleGrid;
    if (dg) {
      dg.clear();
      const entries = snapshot.destructibleEntries;
      const active = snapshot.destructibleActive;
      for (let i = 0; i < snapshot.destructibleActiveCount; i++) {
        const slot = active[i]!;
        const dto = entries[slot]!;
        dg.insert(slot, dto.x, dto.y);
      }
    }
    const tg = snapshot.trapGrid;
    if (tg) {
      tg.clear();
      const entries = snapshot.trapEntries;
      const active = snapshot.trapActive;
      for (let i = 0; i < snapshot.trapActiveCount; i++) {
        const slot = active[i]!;
        const dto = entries[slot]!;
        tg.insert(slot, dto.x, dto.y);
      }
    }
  }
}

export function syncWorldPlayers(snapshot: WorldSnapshot, players: EntityMaps['players']): void {
  snapshot.playerActiveCount = 0;
  // Alive-bot count is reset here and incremented inline during the pass —
  // this REPLACES the old second full-player loop in BotSystem.tick. Same
  // predicate as the old loop (`dto.isAlive && dto.isBot`), evaluated at the
  // same per-player moment (the two flag assignments below), over the same
  // player set (every player appended to `active` below; capacity-overflow
  // players returned before the flags are written were invisible to the old
  // forEachActivePlayer loop too).
  snapshot.aliveBotCount = 0;
  // MATCH-ARC numerator (bot-ai-v2 ticket 10, DEC-011): count ALIVE players
  // (bots + humans) inline — the GDD §14.3 alive-ratio source. Same pattern
  // as the alive-bot fold below: read from the flag assigned directly above,
  // so the counted value is identical by construction to a post-sync scan.
  snapshot.alivePlayerCount = 0;
  const tick = snapshot.currentTick;
  const entries = snapshot.playerEntries;
  const active = snapshot.playerActive;
  const idToSlot = snapshot.playerIdToSlot;
  const slotTick = snapshot.playerSlotTick;
  const freeSlots = snapshot.playerFreeSlots;

  players.forEach((player, id) => {
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.playerFreeCount > 0) {
        slot = freeSlots[--snapshot.playerFreeCount]!;
      } else if (snapshot.playerNextSlot < entries.length) {
        slot = snapshot.playerNextSlot++;
      } else {
        if (!snapshot.playerCapacityWarned) {
          snapshot.playerCapacityWarned = true;
          logger.warn('WorldSnapshot: player capacity exceeded, skipping additional players');
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = player.movement.position.x;
    dto.y = player.movement.position.y;
    dto.velocityX = player.movement.velocityX;
    dto.velocityY = player.movement.velocityY;
    dto.facingAngle = player.movement.facingAngle;
    dto.health = player.health.current;
    dto.maxHealth = player.health.max;
    dto.isAlive = player.isActive;
    dto.isBot = player.isBot;
    // Folded count (was a separate forEachActivePlayer loop in BotSystem.tick):
    // exact same predicate `dto.isAlive && dto.isBot`, read from the two flags
    // assigned directly above — so the counted value is identical by
    // construction to the old post-sync recount.
    if (dto.isAlive && dto.isBot) snapshot.aliveBotCount++;
    if (dto.isAlive) snapshot.alivePlayerCount++;
    dto.activeSlot = player.inventory.activeSlot;
    dto.isFreshSpawn = player.isFreshSpawn();
    dto.freshSpawnExpiryTick = player.isFreshSpawn()
      ? player.statusEffects.freshSpawnExpiryTick
      : 0;
    dto.barrierActive = player.statusEffects.barrierActive;
    dto.isInWindup = player.combat.isInWindup();
    dto.windupRemaining = player.combat.windupRemaining;
    dto.lastAttackTick = player.combat.lastAttackTick;

    // Write each weapon at its actual SLOT INDEX (not compacted sequentially).
    // The bot's ctx.weapons must be slot-indexed so ctx.weapons[ctx.activeSlot]
    // returns the actually-held weapon — compacting (dropping null slots) broke
    // getActiveWeapon (FISTS fallback when holding a real weapon in slot 2/3)
    // and SWITCH_SLOT (targeted null server slots). weaponCount stays the count
    // of non-null weapons (used for pickup-success detection and hasWeapon).
    let weaponCount = 0;
    const weapons = dto.weapons;
    const invWeapons = player.inventory.weapons;
    for (let slotIdx = 0; slotIdx < weapons.length; slotIdx++) {
      const wdto = weapons[slotIdx]!;
      const w = slotIdx < invWeapons.length ? invWeapons[slotIdx] : null;
      if (!w) {
        // Empty slot — mark as FISTS/0 so the consumer can treat it as null.
        // (The bot rebuilds its ctx.weapons with null for these via the
        // weaponCount-vs-slot-index check in updateSelfState.)
        wdto.weaponType = WeaponType.FISTS;
        wdto.tier = 0;
        wdto.ammo = 0;
        wdto.durability = 0;
        continue;
      }
      wdto.weaponType = w.type;
      wdto.tier = tierToNumber(w.tier);
      wdto.ammo = w.ammo;
      wdto.durability = w.ammo;
      weaponCount++;
    }
    dto.weaponCount = weaponCount;
    dto.hasWeapon = weaponCount > 1;

    const activeWeapon = player.getActiveWeapon();
    dto.weaponTier = activeWeapon ? tierToNumber(activeWeapon.tier) : 0;
    dto.weaponType = activeWeapon ? activeWeapon.type : WeaponType.FISTS;

    active[snapshot.playerActiveCount++] = slot;
  });

  idToSlot.forEach((slot, id) => {
    if (slotTick[slot] !== tick) {
      idToSlot.delete(id);
      freeSlots[snapshot.playerFreeCount++] = slot;
    }
  });
}

export function syncWorldItems(
  snapshot: WorldSnapshot,
  weaponPickups: EntityMaps['weaponPickups'],
  powerUps: EntityMaps['powerUps'],
  chests: EntityMaps['chests'],
): void {
  snapshot.itemActiveCount = 0;
  const tick = snapshot.currentTick;
  const entries = snapshot.itemEntries;
  const active = snapshot.itemActive;
  const idToSlot = snapshot.itemIdToSlot;
  const slotTick = snapshot.itemSlotTick;
  const freeSlots = snapshot.itemFreeSlots;

  // Rebuild opening-chest list: a chest in 'opening' state means its opener
  // is committed and vulnerable. Cheap — one forEach, typically 0-2 entries.
  // Done every sync (every tick) because opening state is short-lived and
  // must be fresh for perception to catch looters in the act.
  let openingCount = 0;
  const openingEntries = snapshot.openingChestEntries;
  const openingCap = openingEntries.length;
  chests.forEach((chest, id) => {
    if (chest.state !== 'opening') return;
    if (!chest.openingPlayerId) return;
    if (openingCount >= openingCap) return;
    const o = openingEntries[openingCount++]!;
    o.id = id;
    o.openingPlayerId = chest.openingPlayerId;
    o.x = chest.position.x;
    o.y = chest.position.y;
  });
  snapshot.openingChestCount = openingCount;

  weaponPickups.forEach((wp, id) => {
    if (!wp.isActive) return;
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.itemFreeCount > 0) {
        slot = freeSlots[--snapshot.itemFreeCount]!;
      } else if (snapshot.itemNextSlot < entries.length) {
        slot = snapshot.itemNextSlot++;
      } else {
        if (!snapshot.itemCapacityWarned) {
          snapshot.itemCapacityWarned = true;
          logger.warn('WorldSnapshot: item capacity exceeded, skipping additional items');
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = wp.position.x;
    dto.y = wp.position.y;
    dto.type = 'weapon';
    dto.tier = tierToNumber(wp.weapon.tier);
    // Surface the floor weapon's type so bots can evaluate loadout fit, not
    // just tier (e.g. grab a melee weapon when only holding a bow).
    dto.weaponType = wp.weapon.type;
    dto.powerUpType = undefined;

    active[snapshot.itemActiveCount++] = slot;
  });

  powerUps.forEach((pu, id) => {
    if (!pu.isActive) return;
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.itemFreeCount > 0) {
        slot = freeSlots[--snapshot.itemFreeCount]!;
      } else if (snapshot.itemNextSlot < entries.length) {
        slot = snapshot.itemNextSlot++;
      } else {
        if (!snapshot.itemCapacityWarned) {
          snapshot.itemCapacityWarned = true;
          logger.warn('WorldSnapshot: item capacity exceeded, skipping additional items');
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = pu.position.x;
    dto.y = pu.position.y;
    dto.type = 'powerup';
    dto.tier = 0;
    dto.weaponType = undefined;
    dto.powerUpType = pu.type;

    active[snapshot.itemActiveCount++] = slot;
  });

  chests.forEach((chest, id) => {
    if (chest.state !== 'closed') return;
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.itemFreeCount > 0) {
        slot = freeSlots[--snapshot.itemFreeCount]!;
      } else if (snapshot.itemNextSlot < entries.length) {
        slot = snapshot.itemNextSlot++;
      } else {
        if (!snapshot.itemCapacityWarned) {
          snapshot.itemCapacityWarned = true;
          logger.warn('WorldSnapshot: item capacity exceeded, skipping additional items');
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = chest.position.x;
    dto.y = chest.position.y;
    dto.type = 'powerup';
    dto.tier = 5;
    dto.weaponType = undefined;
    dto.powerUpType = undefined;

    active[snapshot.itemActiveCount++] = slot;
  });

  idToSlot.forEach((slot, id) => {
    if (slotTick[slot] !== tick) {
      idToSlot.delete(id);
      freeSlots[snapshot.itemFreeCount++] = slot;
    }
  });
}

export function syncWorldDestructibles(
  snapshot: WorldSnapshot,
  destructibles: EntityMaps['destructibles'],
): void {
  snapshot.destructibleActiveCount = 0;
  const tick = snapshot.currentTick;
  const entries = snapshot.destructibleEntries;
  const active = snapshot.destructibleActive;
  const idToSlot = snapshot.destructibleIdToSlot;
  const slotTick = snapshot.destructibleSlotTick;
  const freeSlots = snapshot.destructibleFreeSlots;

  destructibles.forEach((d, id) => {
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.destructibleFreeCount > 0) {
        slot = freeSlots[--snapshot.destructibleFreeCount]!;
      } else if (snapshot.destructibleNextSlot < entries.length) {
        slot = snapshot.destructibleNextSlot++;
      } else {
        if (!snapshot.destructibleCapacityWarned) {
          snapshot.destructibleCapacityWarned = true;
          logger.warn(
            'WorldSnapshot: destructible capacity exceeded, skipping additional destructibles',
          );
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = d.position.x;
    dto.y = d.position.y;
    dto.type = d.type;
    dto.hp = d.hp;
    dto.maxHp = d.maxHp;
    dto.isDestroyed = d.isDestroyed;

    active[snapshot.destructibleActiveCount++] = slot;
  });

  idToSlot.forEach((slot, id) => {
    if (slotTick[slot] !== tick) {
      idToSlot.delete(id);
      freeSlots[snapshot.destructibleFreeCount++] = slot;
    }
  });
}

export function syncWorldTraps(snapshot: WorldSnapshot, traps: EntityMaps['traps']): void {
  snapshot.trapActiveCount = 0;
  const tick = snapshot.currentTick;
  const entries = snapshot.trapEntries;
  const active = snapshot.trapActive;
  const idToSlot = snapshot.trapIdToSlot;
  const slotTick = snapshot.trapSlotTick;
  const freeSlots = snapshot.trapFreeSlots;

  traps.forEach((t, id) => {
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.trapFreeCount > 0) {
        slot = freeSlots[--snapshot.trapFreeCount]!;
      } else if (snapshot.trapNextSlot < entries.length) {
        slot = snapshot.trapNextSlot++;
      } else {
        if (!snapshot.trapCapacityWarned) {
          snapshot.trapCapacityWarned = true;
          logger.warn('WorldSnapshot: trap capacity exceeded, skipping additional traps');
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = t.position.x;
    dto.y = t.position.y;
    dto.type = String(t.type);

    active[snapshot.trapActiveCount++] = slot;
  });

  idToSlot.forEach((slot, id) => {
    if (slotTick[slot] !== tick) {
      idToSlot.delete(id);
      freeSlots[snapshot.trapFreeCount++] = slot;
    }
  });
}

export function syncWorldProjectiles(
  snapshot: WorldSnapshot,
  projectiles: EntityMaps['projectiles'],
): void {
  snapshot.projectileActiveCount = 0;
  const tick = snapshot.currentTick;
  const entries = snapshot.projectileEntries;
  const active = snapshot.projectileActive;
  const idToSlot = snapshot.projectileIdToSlot;
  const slotTick = snapshot.projectileSlotTick;
  const freeSlots = snapshot.projectileFreeSlots;

  projectiles.forEach((p, id) => {
    let slot = idToSlot.get(id);
    if (slot === undefined) {
      if (snapshot.projectileFreeCount > 0) {
        slot = freeSlots[--snapshot.projectileFreeCount]!;
      } else if (snapshot.projectileNextSlot < entries.length) {
        slot = snapshot.projectileNextSlot++;
      } else {
        if (!snapshot.projectileCapacityWarned) {
          snapshot.projectileCapacityWarned = true;
          logger.warn(
            'WorldSnapshot: projectile capacity exceeded, skipping additional projectiles',
          );
        }
        return;
      }
      idToSlot.set(id, slot);
    }
    slotTick[slot] = tick;

    const dto = entries[slot]!;
    dto.id = id;
    dto.x = p.position.x;
    dto.y = p.position.y;
    dto.velocityX = p.velocityX;
    dto.velocityY = p.velocityY;

    active[snapshot.projectileActiveCount++] = slot;
  });

  idToSlot.forEach((slot, id) => {
    if (slotTick[slot] !== tick) {
      idToSlot.delete(id);
      freeSlots[snapshot.projectileFreeCount++] = slot;
    }
  });
}
