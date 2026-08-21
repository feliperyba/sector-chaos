import { InputAction } from '../enums/InputAction.js';
import type { InputActionName } from '../types/messages/input-messages.js';

/**
 * Single source of truth mapping client wire-literal action names to the
 * shared {@link InputAction} enum. Extracted from the server's private
 * `CLIENT_ACTION_TO_SHARED` so the encoding lives next to the enum it maps to.
 *
 * The `| undefined` value type is load-bearing: the server is authoritative
 * (ADR-0014) and MUST keep filtering arbitrary client strings at the lookup
 * site — and `=== undefined` alone is NOT sufficient (T12): this is a plain
 * object, so prototype-named keys ('constructor', 'toString', '__proto__')
 * return inherited values instead of undefined; the caller must additionally
 * require an integer InputAction (the guard in `room/handlers/input.ts`).
 * All four `WEAPON_SLOT_N` literals decode to the single `SWITCH_SLOT`
 * action; the slot index is recovered via {@link getSlotFromAction}.
 */
export const INPUT_ACTION_MAP: Record<InputActionName, InputAction | undefined> = {
  ATTACK: InputAction.ATTACK,
  DASH: InputAction.DASH,
  THROW: InputAction.THROW,
  PICKUP: InputAction.PICKUP,
  WEAPON_SLOT_1: InputAction.SWITCH_SLOT,
  WEAPON_SLOT_2: InputAction.SWITCH_SLOT,
  WEAPON_SLOT_3: InputAction.SWITCH_SLOT,
  WEAPON_SLOT_4: InputAction.SWITCH_SLOT,
};

/**
 * Encode a client wire-literal action name into its shared enum value, or
 * `undefined` if the name is not a recognized action (authoritative filtering).
 */
export function encodeInputAction(name: InputActionName): InputAction | undefined {
  return INPUT_ACTION_MAP[name];
}

/**
 * Recover the 0-based inventory slot from a `WEAPON_SLOT_N` action name
 * (slot 1 → index 0). Returns -1 for non-slot actions.
 */
export function getSlotFromAction(name: InputActionName): number {
  if (name.startsWith('WEAPON_SLOT_')) {
    const parsed = parseInt(name.slice('WEAPON_SLOT_'.length), 10);
    return Number.isNaN(parsed) ? -1 : parsed - 1;
  }
  return -1;
}
