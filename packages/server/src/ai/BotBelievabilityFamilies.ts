/**
 * BotBelievabilityFamilies — verbatim extraction of the intent-mix family
 * block from BotBelievability.ts (bot-ai-v2 ticket 09, for the
 * module-length gate). BotBelievability.ts re-exports every name, so the
 * historical import path (tests, BotSkillTracker) keeps working.
 */

import { BotState } from './BotContextTypes.ts';

// --- intent-mix families (in sync with the harness IntentDistribution
// buckets + intentFamily classifier — same order, same semantics) ---

export const INTENT_FAMILY_KEYS = [
  'engage',
  'fleeZone',
  'retreat',
  'armUp',
  'loot',
  'hunt',
  'wander',
] as const;

export type IntentFamilyKey = (typeof INTENT_FAMILY_KEYS)[number];

/** Number of family buckets (INTENT_FAMILY_KEYS.length). */
export const INTENT_FAMILY_COUNT = INTENT_FAMILY_KEYS.length;

/** Classify a BotState into the 7-bucket intent-family mix. Mirrors the
 *  harness's IntentId-based intentFamily(): ENGAGE (+DEMOLITION, which the
 *  intent layer enters from combat-adjacent intents) → engage, FLEE_ZONE →
 *  fleeZone, RETREAT → retreat, SEEK_WEAPON → armUp, LOOT → loot, HUNT →
 *  hunt, WANDER → wander. */
export function botStateFamilyIndex(state: BotState): number {
  switch (state) {
    case BotState.ENGAGE:
    case BotState.DEMOLITION:
      return 0;
    case BotState.FLEE_ZONE:
      return 1;
    case BotState.RETREAT:
      return 2;
    case BotState.SEEK_WEAPON:
      return 3;
    case BotState.LOOT:
      return 4;
    case BotState.HUNT:
      return 5;
    case BotState.WANDER:
    default:
      return 6;
  }
}
