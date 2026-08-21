/**
 * Weapon-break reaction — bot-ai-v2 ticket 09 (DEC-010.7).
 *
 * An active weapon breaking mid-fight is a LOUD event for a human — the
 * swing stops connecting, the HUD flashes — and the human responds
 * immediately and visibly: swap to the spare, grab whatever is on the
 * ground, or disengage. The legacy bot kept swinging FISTS at an armed enemy
 * without any visible acknowledgment.
 *
 * DETECTION (BotSelfState.updateSelfState): the DTO slot sync observes the
 * previously-real ACTIVE weapon leaving the slot (emptied) or its ammo
 * hitting zero in place — the two server-side break shapes
 * (Player.onWeaponBreak). The observation stamps ctx.combat.weaponBrokeTick.
 *
 * REACTION (this module, the executor seam): while the stamp is fresh and
 * unhandled, {@link reactToWeaponBreak} emits the immediate visible response
 *  - a SPARE weapon exists → SWITCH_SLOT right now (bypasses the tactical
 *    switch gate — a forced re-arm is not a mid-fight choice; even the
 *    low-tier mid-fight-switch restriction does not apply to it);
 *  - no spare → a one-tick fighting-withdrawal move (backing off while
 *    facing the enemy) + a selector force-reevaluate — unarmed, DUEL is no
 *    longer valid, so ARM_UP ("grab") or RETREAT (disengage) takes over the
 *    very next selection pass. Under fire the discretion 'supply' trigger
 *    (a fresh weaponBrokeTick IS supply-critical) routes the break-line
 *    retreat.
 *
 * Determinism: pure reads + queued-input factories; the reason-tagged
 * SWITCH feeds the switchByReason telemetry ('weapon-break-switch').
 */

import { WeaponType, angleTo } from '@sector-battle/shared';
import type { QueuedInput } from '../../application/simulation/InputQueue.ts';
import type { BotContext, WeaponSlot } from '../BotContext.ts';
import { makeSwitchSlotInput, makeMoveInput } from '../BotInput.ts';

/** The break stamp is "fresh" (reaction-eligible) for this many ticks. */
export const WEAPON_BREAK_FRESH_TICKS = 45;

/**
 * The break predicate over the active slot's before/after view (used by the
 * self-state sync; exported for its unit seam). `prev`/`next` are the slot's
 * weapon views across one sync — a break is: was a real weapon with uses
 * left, and now is gone/FISTS/or at zero uses of the same type.
 */
export function weaponBrokeBetween(prev: WeaponSlot | null, next: WeaponSlot | null): boolean {
  if (!prev || prev.weaponType === WeaponType.FISTS) return false; // wasn't holding a real weapon
  const prevUsable = prev.ammo > 0 || prev.durability > 0;
  if (!prevUsable) return false; // already dead before the window — no fresh edge
  if (!next || next.weaponType === WeaponType.FISTS) return true; // slot emptied by the break
  if (next.weaponType !== prev.weaponType) return true; // slot replaced (broken out)
  return next.ammo <= 0 && next.durability <= 0; // same weapon, uses exhausted in place
}

/** The reaction seam's structural deps (BotSystem satisfies this). */
export interface WeaponBreakDeps {
  readonly selectors: Map<string, { forceReevaluate(): void }>;
}

/**
 * The EXECUTOR-SEAM reaction (called at the top of executeEngageState).
 * Returns the tick's inputs when a break is being reacted to (the caller
 * returns them as the tick's outputs — the immediate visible response), or
 * null when there is nothing fresh to react to. Marks the stamp handled.
 */
export function reactToWeaponBreak(deps: WeaponBreakDeps, ctx: BotContext): QueuedInput[] | null {
  const c = ctx.combat;
  if (!c) return null;
  const age = ctx.tick - c.weaponBrokeTick;
  if (age < 0 || age > WEAPON_BREAK_FRESH_TICKS) return null;

  // A spare REAL weapon (any other slot with uses left) → immediate swap.
  let spareSlot = -1;
  for (let i = 0; i < ctx.weapons.length; i++) {
    if (i === ctx.activeSlot) continue;
    const w = ctx.weapons[i];
    if (!w || w.weaponType === WeaponType.FISTS) continue;
    if (w.ammo > 0 || w.durability > 0) {
      spareSlot = i;
      break;
    }
  }
  if (spareSlot >= 0) {
    c.weaponBrokeTick = -9999; // handled
    c.bump(c.pendingWeaponBreakReactions, 'switch');
    ctx.lastSwitchSlotTick = ctx.tick;
    return [makeSwitchSlotInput(ctx.playerId, spareSlot, ctx.tick, 'weapon-break-switch')];
  }

  // No spare: the one-tick fighting withdrawal + force the (now-unarmed)
  // re-evaluation toward ARM_UP / RETREAT. Visible immediately.
  c.weaponBrokeTick = -9999; // handled
  c.bump(c.pendingWeaponBreakReactions, 'disengage');
  deps.selectors.get(ctx.playerId)?.forceReevaluate();
  const enemy = ctx.nearestEnemy;
  if (!enemy) return null; // nothing to withdraw from — ARM_UP takes over
  const away = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
  const aim = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
  return [makeMoveInput(ctx.playerId, away, aim, ctx.tick)];
}
