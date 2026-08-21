/**
 * BotContext weapon-slot selection — verbatim extraction from BotContext.ts
 * (bot-ai-v2 ticket 08), extended with the scoped-incompetence class gate.
 *
 * The three getBestSlot* bodies moved here byte-identically (`this.` →
 * `ctx.`) to hold the 500-line module gate while BotContext gains the
 * ticket-08 fields (movement signature, restrictions, own-windup, LOS-held,
 * fight-memory view). BotContext keeps thin delegating methods so the
 * executor call sites (ctx.getBestSlotForMatchup(...)) are unchanged.
 *
 * CLASS LOCK (DEC-009.3): every candidate slot is additionally skipped when
 * its weapon's AttackType class is outside the bot's restriction set
 * (botAllowsWeapon) — a low-tier bot's slot picks never land on an
 * out-of-class weapon, so it never CHOOSES to wield one. FISTS always pass;
 * involuntarily acquired out-of-class weapons (chest drops into an empty
 * slot) simply stay unselected, never look broken.
 */

import { AttackType, WeaponType } from '@sector-battle/shared';
import type { BotContext } from './BotContext.ts';
import { getWeaponDestructibleDamage, safeGetWeaponDef } from './BotLoadout.ts';
import { botAllowsWeapon } from './skill/RestrictionTables.ts';

/**
 * Pick the best weapon slot for pure DISTANCE (the legacy heuristic).
 * Verbatim from BotContext.getBestSlotForDistance + the class gate.
 */
export function getBestSlotForDistance(ctx: BotContext, dist: number): number {
  let bestSlot = ctx.activeSlot;
  let bestScore = -Infinity;
  for (let i = 0; i < ctx.weapons.length; i++) {
    const w = ctx.weapons[i]!;
    if (!w || w.weaponType === WeaponType.FISTS) continue;
    if (w.durability <= 0) continue;
    if (!botAllowsWeapon(ctx.restrictions, w.weaponType)) continue;
    const range = ctx.getWeaponRange(w.weaponType);
    let score: number;
    if (dist > range * 1.2) {
      score = range / dist;
    } else if (dist < range * 0.3) {
      score = 0.5;
    } else {
      score = 1.0 + (w.tier + 1) * 0.1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlot = i;
    }
  }
  return bestSlot;
}

/**
 * Pick the best weapon slot for the current MATCHUP (enemy range considered).
 * Verbatim from BotContext.getBestSlotForMatchup + the class gate.
 */
export function getBestSlotForMatchup(ctx: BotContext, dist: number, enemyRange: number): number {
  let bestSlot = ctx.activeSlot;
  let bestScore = -Infinity;
  for (let i = 0; i < ctx.weapons.length; i++) {
    const w = ctx.weapons[i]!;
    if (!w || w.weaponType === WeaponType.FISTS) continue;
    if (w.durability <= 0) continue;
    if (!botAllowsWeapon(ctx.restrictions, w.weaponType)) continue;
    const range = ctx.getWeaponRange(w.weaponType);
    const canHit = dist <= range * 0.88;
    let score: number;
    if (canHit && range > enemyRange + 30) {
      // Outranges enemy AND can hit — dominant. Weight by gap size.
      score = 2.0 + (range - enemyRange) / 400 + (w.tier + 1) * 0.05;
    } else if (canHit) {
      score = 1.0 + (w.tier + 1) * 0.1;
    } else {
      score = (range / dist) * 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlot = i;
    }
  }
  return bestSlot;
}

/**
 * Pick the best weapon slot for breaking a destructible. Verbatim from
 * BotContext.getBestSlotForDestructibles + the class gate (FISTS pass the
 * gate, so a class-locked bot can always fall back to punching walls).
 */
export function getBestSlotForDestructibles(ctx: BotContext): number {
  let bestSlot = ctx.activeSlot;
  let bestScore = -Infinity;
  for (let i = 0; i < ctx.weapons.length; i++) {
    const w = ctx.weapons[i]!;
    if (!w) continue;
    if (w.durability <= 0 && w.weaponType !== WeaponType.FISTS) continue;
    if (!botAllowsWeapon(ctx.restrictions, w.weaponType)) continue;
    const dmg = getWeaponDestructibleDamage(w.weaponType);
    // Primary sort: destructible damage per hit. Secondary: reach fitness —
    // want a weapon that can hit an adjacent tile (range >= ~120).
    let score = dmg;
    const range = ctx.getWeaponRange(w.weaponType);
    if (range < 120) score *= 0.7; // too short to reach the tile reliably
    // Penalize ranged (ammo cost + single-point hit vs arc). Crossbow is the
    // exception (10 dmg) but still wasteful if a Hammer is available.
    const attackType = safeGetWeaponDef(w.weaponType)?.attackType ?? null;
    if (attackType === AttackType.RANGED) score *= 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestSlot = i;
    }
  }
  return bestSlot;
}
