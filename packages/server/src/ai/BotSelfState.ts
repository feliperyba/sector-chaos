/**
 * Per-bot state sync + hazard rescan extracted verbatim from the original
 * BotSystem.ts. Split out of BotTickDriver.ts to keep that file under the
 * 450-line module cap.
 *
 * Each function body is byte-identical to the original method except `this.`
 * → `system.`. Behavior is provably preserved by construction.
 */

import { WeaponType } from '@sector-battle/shared';
import type { PlayerDTO } from './WorldSnapshot.ts';
import type { BotSystem } from './BotSystem.ts';
import type { BotContext } from './BotContext.ts';
import { isBarrel } from './BotDestructibles.ts';
import { weaponBrokeBetween } from './combat/WeaponBreakReaction.ts';
import {
  acquireDanger,
  acquireProjectile,
  releaseAll,
  BARREL_SCAN_RANGE,
} from './BotPerception.ts';

/**
 * Lightweight per-tick hazard rescan (barrels + traps + projectiles only).
 * Runs on the ticks between full staggered perception scans so hazard
 * avoidance is always reactive. Enemy/item data from the last full scan is
 * preserved — only the safety-critical danger list is refreshed.
 *
 * POOL DISCIPLINE (ticket 24): releases the previous cycle's danger/projectile
 * DTOs back into the context pools and re-acquires via the same shared
 * helpers the full scan uses (`acquireDanger`/`acquireProjectile`) — no fresh
 * literals per tick. Clear-then-fill semantics are identical to the full
 * scan's `releaseAll` (never appends to a non-empty array), and no consumer
 * retains a hazard DTO across the cycle (they read scalars within the tick).
 */
export function rescanHazards(system: BotSystem, ctx: BotContext, dto: PlayerDTO): void {
  releaseAll(ctx.dangers, ctx.dangerPool);
  releaseAll(ctx.projectiles, ctx.projectilePool);

  const dangerScan = 360; // matches BotPerception.DANGER_SCAN_RANGE
  // DEC-006 fix 5: the SHARED barrel hazard range (BotPerception's
  // BARREL_SCAN_RANGE, 456px) — the rescan previously used its own tighter
  // EXPLOSION_RADIUS + 80 (336px), so barrels in the 336–456px shell vanished
  // from the danger view on every rescan tick and reappeared on the next full
  // scan (avoidance flicker at the boundary).
  const barrelScan = BARREL_SCAN_RANGE;

  system.worldSnapshot.queryTraps(ctx.x, ctx.y, dangerScan, (tdto) => {
    const dx = tdto.x - ctx.x;
    const dy = tdto.y - ctx.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    acquireDanger(ctx, tdto.x, tdto.y, tdto.type, dist);
  });

  system.worldSnapshot.queryDestructibles(ctx.x, ctx.y, barrelScan, (ddto) => {
    if (!isBarrel(ddto.type)) return;
    const dx = ddto.x - ctx.x;
    const dy = ddto.y - ctx.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    acquireDanger(ctx, ddto.x, ddto.y, 'barrel', dist);
  });

  system.worldSnapshot.queryProjectiles(ctx.x, ctx.y, 300, (pdto) => {
    const dx = pdto.x - ctx.x;
    const dy = pdto.y - ctx.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    acquireProjectile(ctx, pdto.id, pdto.x, pdto.y, pdto.velocityX, pdto.velocityY, dist);
  });
  void dto;
}

export function updateSelfState(system: BotSystem, ctx: BotContext, dto: PlayerDTO): void {
  ctx.x = dto.x;
  ctx.y = dto.y;
  ctx.vx = dto.velocityX;
  ctx.vy = dto.velocityY;
  ctx.facingAngle = dto.facingAngle;
  // Detect damage taken this tick (health dropped, excluding healing which
  // raises it). This drives the "react to being shot" polish — a bot that
  // takes a hit while looting/navigating should flinch/seek cover, not
  // continue obliviously. Barrier negates damage so don't trigger under it.
  // PROGRESS-MASK FIX (bot-ai-v2 ticket 06, DEC-005.3): taking damage NO
  // LONGER bumps lastProgressTick — a wedged bot being chip-damaged read as
  // "making progress" and was never relocated. Progress is now ONLY
  // displacement-toward-goal (anti-stall windows), completed pickups (below)
  // and kills (StimulusRouter noteKillScored).
  if (ctx.prevHealth > 0 && dto.health < ctx.prevHealth - 1 && !dto.barrierActive) {
    ctx.lastDamageTick = ctx.tick;
    // DAMAGE-DIRECTION ATTRIBUTION RETIRED (bot-ai-v2 ticket 05, DEC-003):
    // this used to copy ctx.nearestEnemy's position into lastDamageFrom* —
    // the audited misattribution (wrong whenever the shooter isn't the
    // nearest visible enemy, AUDIT §3.3.1). The believed origin is now the
    // damage-direction BELIEF written by the stimulus router's damage
    // delivery (BeliefUpdate.writeDamageDirectionBelief →
    // ctx.lastDamageBelief*), an estimated position built from the knockback
    // direction + per-bot RNG spread — never the attacker's true coordinates.
  }
  // PICKUP-SUCCESS DETECTION: health increased (heal), weapon count increased
  // (weapon/chest), or barrier just activated (barrier pickup). A successful
  // pickup PROVES the bot can reach loot in its current area — so clear the
  // LOOT suspension. Without this, a bot that grabbed a weapon would stay
  // suspended from LOOT for the full window and miss an adjacent free heal.
  const healed = ctx.prevHealth > 0 && dto.health > ctx.prevHealth + 1;
  // Count non-null weapons in ctx.weapons (now slot-indexed with nulls for
  // empty slots) to compare against the DTO's weaponCount for pickup-success
  // detection. Previously ctx.weapons was compacted so .length was the count;
  // now it's always INVENTORY_SIZE. Counted loop (ticket 25) — identical sum
  // to the old `.reduce` closure (initial 0, +1 per truthy slot) without
  // allocating a closure per bot per tick.
  let currentWeaponCount = 0;
  for (let i = 0; i < ctx.weapons.length; i++) {
    if (ctx.weapons[i]) currentWeaponCount++;
  }
  const gainedWeapon = dto.weaponCount > currentWeaponCount;
  const gainedBarrier = dto.barrierActive && !ctx.selfBarrierActive;
  if (healed || gainedWeapon || gainedBarrier) {
    ctx.lastProgressTick = ctx.tick;
    const sel = system.selectors.get(ctx.playerId);
    if (sel) sel.clearSuspensions();
    ctx.stallEpicenterTick = -9999; // success — no longer relocating from a stall
  }
  ctx.prevHealth = dto.health;
  ctx.health = dto.health;
  ctx.maxHealth = dto.maxHealth;
  // WEAPON-BREAK CAPTURE (bot-ai-v2 ticket 09, DEC-010.7): snapshot the slot
  // the bot was HOLDING (pre-refresh activeSlot, pre-sync contents) — after
  // the DTO sync below, that same slot's view tells us whether the held
  // weapon broke (emptied / exhausted in place). Watching the HELD slot (not
  // the incoming activeSlot) keeps slot switches from reading as breaks: a
  // switched-away weapon still sits intact in its slot.
  const breakSlot = ctx.activeSlot;
  const prevHeldView = ctx.weapons[breakSlot] ? { ...ctx.weapons[breakSlot]! } : null;
  ctx.activeSlot = dto.activeSlot;
  ctx.isFreshSpawn = dto.isFreshSpawn;
  ctx.selfBarrierActive = dto.barrierActive;
  // Own-windup sync (bot-ai-v2 ticket 08, DEC-009.3): the dash-cancel
  // restriction gate reads this (botCanDashDuringOwnWindup). The server
  // permits DASH during own windup (only stagger/dash-lock block it), so the
  // executor-side gate is what makes low tiers never cancel their swings.
  ctx.isInOwnWindup = dto.isInWindup;

  // Sync ctx.weapons SLOT-INDEXED (length = full inventory size, null for
  // empty slots) so ctx.weapons[ctx.activeSlot] returns the held weapon. The
  // DTO now writes each weapon at its real slot index (WorldSnapshotSync);
  // empty slots are marked FISTS/0 — slot 0 is the immutable FISTS slot, so any
  // FISTS-type entry in slot >0 is an empty slot. This replaces the previous
  // compacted rebuild (which dropped nulls and broke activeSlot indexing).
  //
  // IN-PLACE SLOT SYNC (ticket 25): slot objects are long-lived and mutated in
  // place instead of being re-pushed as fresh literals every tick (4 slots ×
  // 63 bots ≈ 252 objects/tick + array churn). A per-field dirty check skips
  // ALL writes when nothing changed. The dirty check compares EVERY field
  // downstream consumers read — weaponType, tier, durability, ammo, which is
  // the complete WeaponSlot interface (BotContextTypes.ts) — on EVERY occupied
  // slot, so a durability/ammo decrement, tier change, or weapon swap always
  // registers (a count-only comparison would silently miss those).
  //
  // The slot-indexed-with-nulls invariant (BotContext.ts weapons doc) is
  // preserved exactly: array length tracks dto.weapons.length, empty slots
  // hold null, and freed slots are nulled in place — never compacted — so
  // ctx.weapons[ctx.activeSlot] (getActiveWeapon) and getBestSlot* indices
  // keep pointing at real server slots. No consumer holds slot-object
  // identity (only `=== null` occupancy checks) or mutates the slot objects,
  // so reuse is safe.
  const weapons = ctx.weapons;
  const dtoWeapons = dto.weapons;
  for (let i = 0; i < dtoWeapons.length; i++) {
    const wdto = dtoWeapons[i];
    // Slot 0 is always FISTS (immutable). Other slots with FISTS type (or a
    // missing DTO entry) are empty. Same occupancy rule as the old rebuild.
    const isEmpty = !wdto || (i > 0 && wdto.weaponType === WeaponType.FISTS);
    const cur = weapons[i];
    if (isEmpty) {
      // Write null when the slot held an object (freed this tick) or is past
      // the array's end (never initialized). The out-of-bounds write extends
      // the array densely so trailing empty slots exist for length-based
      // consumers (e.g. isWeaponUpgrade's hasEmptySlot scan); the exact-dto
      // length is guaranteed by the trim after the loop.
      if (cur !== null) weapons[i] = null;
      continue;
    }
    if (
      cur &&
      cur.weaponType === wdto.weaponType &&
      cur.tier === wdto.tier &&
      cur.durability === wdto.durability &&
      cur.ammo === wdto.ammo
    ) {
      continue; // clean slot — zero writes on the unchanged path
    }
    if (cur) {
      cur.weaponType = wdto.weaponType;
      cur.tier = wdto.tier;
      cur.durability = wdto.durability;
      cur.ammo = wdto.ammo;
    } else {
      weapons[i] = {
        weaponType: wdto.weaponType,
        tier: wdto.tier,
        durability: wdto.durability,
        ammo: wdto.ammo,
      };
    }
  }
  // Exact length parity with the old rebuild-from-empty (which always ended
  // at dto.weapons.length). Only ever trims; INVENTORY_SIZE is constant.
  if (weapons.length > dtoWeapons.length) weapons.length = dtoWeapons.length;
  // WEAPON-BREAK STAMP (bot-ai-v2 ticket 09, DEC-010.7): the held slot's
  // post-sync view vs the pre-sync snapshot — a fresh break stamps the tick
  // the executor seam (WeaponBreakReaction.reactToWeaponBreak) reacts to.
  if (ctx.combat && weaponBrokeBetween(prevHeldView, ctx.weapons[breakSlot] ?? null)) {
    ctx.combat.weaponBrokeTick = ctx.tick;
  }
}
