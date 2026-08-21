/**
 * BotEconomyGates — verbatim extraction from BotEconomyExecutors.ts
 * (bot-ai-v2 ticket 09, for the module-length gate; same house style as the
 * other partials). Each function body is byte-identical to the original;
 * BotEconomyExecutors re-exports isWeaponUpgrade/isAtDropSite so the
 * historical import path (tests) keeps working.
 *
 * The economy NOMINATION gates: what floor loot a bot may target (upgrade
 * truth + drop-site skip) and which pickups are walk-over vs action-based.
 */

import type { BotContext, ItemInfo } from './BotContext.ts';
import { PICKUP_RADIUS, CHEST_TIER_SENTINEL } from './BotSystemConstants.ts';
import { weaponRole, loadoutHasRole } from './BotLoadout.ts';
import { botAllowsWeapon } from './skill/RestrictionTables.ts';

/**
 * Drop-site blacklist duration (ticks). After a full-inventory bot picks up a
 * weapon, the server drops the swapped-out weapon at the bot's feet. The bot
 * can't learn the dropped weapon's server-minted id, so it blacklists ANY weapon
 * at the pickup position for this duration, breaking the A↔B swap-grab loop.
 */
export const DROP_SITE_BLACKLIST_TICKS = 180; // 3s at 60 ticks/s
/** Distance within which a floor weapon is considered "at the drop site". */
export const DROP_SITE_RADIUS = PICKUP_RADIUS;

/**
 * How long (ms) a FULL-HEALTH bot blacklists a nearby health pack it can't
 * use (the server rejects pickup at full HP — see the gate in the LOOT
 * executor). Expressed in milliseconds because the design intent is a
 * 3-second ignore; converted to ticks via NETWORK.TICK_RATE at use (DEC-006
 * fix 3: this was previously added to tick counters RAW — 3000 TICKS = 50
 * seconds — so a bot that took damage right after blacklisting ignored a
 * pack it needed for ~50s).
 */
export const HEALTH_FULL_BLACKLIST_MS = 3000;

/**
 * Would picking up this floor weapon be a genuine improvement? When the bot's
 * inventory is full, picking up a weapon triggers a swap (the held weapon is
 * dropped at the bot's feet). A swap is only worth it if the floor weapon is
 * strictly better — a tier upgrade, or it fills a melee/ranged role gap that
 * the swapped-out weapon's role is still covered for elsewhere in the loadout.
 * Without this gate, a full-inventory bot picks up an equal-tier weapon of a
 * different role, drops its current role coverage, then immediately re-targets
 * the just-dropped weapon to restore that coverage → infinite swap-grab loop.
 */
export function isWeaponUpgrade(ctx: BotContext, floor: ItemInfo): boolean {
  // SCOPED INCOMPETENCE (DEC-009.3): out-of-class is never an upgrade for a locked bot.
  if (floor.weaponType !== undefined && !botAllowsWeapon(ctx.restrictions, floor.weaponType))
    return false;
  // Tier upgrade is always worth a swap (strictly better weapon).
  const active = ctx.getActiveWeapon();
  if (floor.tier > active.tier) return true;

  // Role-diversity: grabbing a melee when holding only ranged (or vice versa)
  // is worth it ONLY if the bot has an empty slot (no swap) — a swap would
  // drop the active weapon, opening the very role gap the pickup fills.
  // hasEmptySlot: any slot 1+ is null (slot 0 = FISTS, always occupied).
  let hasEmptySlot = false;
  for (let i = 1; i < ctx.weapons.length; i++) {
    if (ctx.weapons[i] === null) {
      hasEmptySlot = true;
      break;
    }
  }
  if (hasEmptySlot && floor.weaponType !== undefined) {
    const floorRole = weaponRole(floor.weaponType);
    if (floorRole !== undefined && !loadoutHasRole(ctx, floorRole)) return true;
  }

  return false;
}

/**
 * Is `item` at the bot's last full-inventory pickup (drop) site? The server
 * drops the swapped weapon at the bot's exact position, so a floor weapon
 * within DROP_SITE_RADIUS of a recent full-inventory pickup is very likely
 * the bot's own drop. Skipping it breaks the swap-grab loop without needing
 * the dropped weapon's unknowable server-minted id.
 */
export function isAtDropSite(ctx: BotContext, item: ItemInfo): boolean {
  if (ctx.tick - ctx.lastFullPickupTick > DROP_SITE_BLACKLIST_TICKS) return false;
  const dx = item.x - ctx.lastFullPickupX;
  const dy = item.y - ctx.lastFullPickupY;
  return dx * dx + dy * dy <= DROP_SITE_RADIUS * DROP_SITE_RADIUS;
}

/**
 * Power-ups (health pack / barrier / speed boost) are WALK-OVER pickups: the
 * server auto-collects them the instant a player's position is within
 * PICKUP_RADIUS (GameSimulationWalkovers.checkPowerUpWalkOverSim). They require
 * NO InputAction.PICKUP — the PICKUP handler has no powerup branch and a
 * PICKUP input for a powerup is a silent no-op. Weapons and chests, by
 * contrast, DO require a PICKUP action (weapon pickup is proximity-honored at
 * PICKUP_RADIUS ignoring targetId; chest-open is a channeled PICKUP).
 *
 * This distinction is load-bearing for the bot: emitting PICKUP at a powerup
 * and stopping (the previous behavior) left the bot parked at ~50-63px emitting
 * useless PICKUPs while the server waited for it to walk the last few pixels
 * into auto-collect range. The bot must instead KEEP MOVING over the powerup.
 */
export function isWalkOverPickup(target: ItemInfo): boolean {
  // Powerups have type 'powerup'; chests also reuse that type but carry the
  // CHEST_TIER_SENTINEL tier and ARE action-based (channeled open), so exclude
  // them. Weapons are a separate type and are action-based.
  return target.type === 'powerup' && target.tier !== CHEST_TIER_SENTINEL;
}
