/**
 * BotLoadout.ts — single source of truth for bot weapon/loadout classification.
 *
 * Consolidates two previously-duplicated classification copies:
 *  - the LOOT intent's role-diversity scoring helpers (formerly private to
 *    `intent/intentLoot.ts`) and
 *  - the economy executor's `isWeaponUpgrade` role gate (formerly a private,
 *    differently-named twin in `BotEconomyExecutors.ts`)
 *  ...plus the scattered per-file try/catch `weaponRegistry.getDefinition`
 *  fallback blocks (now one `safeGetWeaponDef`).
 *
 * Consolidation only — no scoring/threshold/decision changes.
 */

import {
  AttackType,
  resolveAttackType,
  weaponRegistry,
  WeaponType,
  type WeaponDefinition,
} from '@sector-battle/shared';
import type { BotContext } from './BotContext.ts';

/**
 * Classify a weapon into a loadout role. A balanced loadout covers both MELEE
 * (close-range arc/line swings + shield bash) and RANGED (bows/crossbows + thrown).
 * A bot holding only one role has a loadout gap — it can't respond to enemies
 * outside its single range band. This drives role-diversity looting: grab a
 * nearby melee weapon when holding only ranged (and vice versa), even at equal
 * tier, so the bot isn't helpless when the fight moves to the wrong range.
 */
export type WeaponRole = 'melee' | 'ranged';

export function weaponRole(weaponType: WeaponType | undefined): WeaponRole | undefined {
  if (weaponType === undefined) return undefined;
  const atk = resolveAttackType(weaponType);
  // THROWN (axes/knives) and RANGED (bows) cover distance; ARC/LINE/SHIELD are melee.
  return atk === AttackType.RANGED || atk === AttackType.THROWN ? 'ranged' : 'melee';
}

/**
 * Does the bot's current loadout already cover the given role? Iterates all
 * non-null, non-FISTS weapons with ammo. A bot with a Bow + Fists has only
 * 'ranged' coverage (Fists are a fallback, not a real melee answer).
 *
 * Per-(bot, tick) cached (perf ticket 27): both roles are derived in one pass
 * the first time either is queried in a tick, then reused — see
 * BotContext.loadoutRoleCache for the soundness argument (the loadout cannot
 * change within a tick). Same result as the uncached existence check: the
 * loop is read-only, so continuing past the first match cannot change the
 * boolean, and both roles are existence checks over the same predicate.
 */
export function loadoutHasRole(ctx: BotContext, role: WeaponRole): boolean {
  const cached = ctx.loadoutRoleCache;
  if (cached && cached.tick === ctx.tick) {
    return role === 'melee' ? cached.melee : cached.ranged;
  }
  let melee = false;
  let ranged = false;
  for (const w of ctx.weapons) {
    if (!w || w.weaponType === WeaponType.FISTS) continue;
    if (w.ammo <= 0) continue;
    const wr = weaponRole(w.weaponType);
    if (wr === 'melee') melee = true;
    else if (wr === 'ranged') ranged = true;
  }
  ctx.loadoutRoleCache = { tick: ctx.tick, melee, ranged };
  return role === 'melee' ? melee : ranged;
}

/**
 * Look up a weapon definition without throwing. Returns null for an unknown
 * type (the registry throws — `WeaponRegistry.getDefinition`, shared/src/weapons/
 * WeaponRegistry.ts:39-45). All game weapon types are minted through the same
 * registry, so the null path is defensive; each caller maps null onto its own
 * pre-consolidation fallback (range 128, damage 0, weightTier 1, early return,
 * ...) exactly as its old try/catch (or lack thereof) did.
 */
export function safeGetWeaponDef(type: WeaponType): WeaponDefinition | null {
  try {
    return weaponRegistry.getDefinition(type);
  } catch {
    return null;
  }
}

/**
 * Destructible damage per hit for a weapon type, with the pre-extraction
 * fallback (1) for unknown types. Pure WeaponType query with no ctx state —
 * moved from the BotContext class (perf ticket 30 line-budget; body verbatim).
 */
export function getWeaponDestructibleDamage(type: WeaponType): number {
  return safeGetWeaponDef(type)?.baseStats.destructibleDamage ?? 1;
}
