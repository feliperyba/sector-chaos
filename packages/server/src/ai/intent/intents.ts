/**
 * Phase-2 Intent implementations — orchestrator + public API.
 *
 * These replace the legacy priority cascade but carry forward ALL of its
 * tactical nuance — the survival gating, the combat-override that breaks
 * endgame stalls, the booster economy, the endgame heal/re-arm thresholds.
 * Personality weights layer ON TOP of that correctness: two bots in the same
 * situation still make the same survival decision, but a more aggressive bot
 * fights where a cautious one retreats.
 *
 * They map to legacy BotState executors via intentIdToBotState() — the actual
 * movement/attack code in BotSystem stays untouched in Phase 2 (evolve in place).
 *
 * WHY each intent exists + what it preserves from the legacy cascade is
 * documented on each class. Phase 3 adds the new moment-producing intents
 * (HUNT_VULNERABLE, AMBUSH, BARREL_TRAP, CONTEST_LOOT).
 *
 * The intent class implementations live in focused partial modules:
 *   - intentHelpers    shared helper predicates (zone distance, HP ratio, siege)
 *   - intentSurvival   SurviveZone, RetreatAndReset, ArmUp, Hunt
 *   - intentEngage     HuntVulnerable, BarrelTrap, ContestLoot, Duel
 *   - intentLoot       Loot, Wander
 */
import { BotState } from '../BotContext.ts';
import { IntentId, type Intent } from './Intent.ts';
import {
  SurviveZoneIntent,
  RetreatAndResetIntent,
  ArmUpIntent,
  HuntIntent,
} from './intentSurvival.ts';
import {
  HuntVulnerableIntent,
  BarrelTrapIntent,
  ContestLootIntent,
  DuelIntent,
} from './intentEngage.ts';
import { LootIntent, WanderIntent } from './intentLoot.ts';

/** Build the intent set. Phase-3 moment intents (HUNT_VULNERABLE, BARREL_TRAP,
 *  CONTEST_LOOT) are included. AMBUSH (proactive wall-flank) is deferred — it
 *  needs a dedicated flank-planning executor, lower priority than the others. */
export function buildPhase2Intents(): Intent[] {
  return [
    new SurviveZoneIntent(),
    new RetreatAndResetIntent(),
    new ArmUpIntent(),
    new BarrelTrapIntent(),
    new HuntVulnerableIntent(),
    new ContestLootIntent(),
    new DuelIntent(),
    new LootIntent(),
    new HuntIntent(),
    new WanderIntent(),
  ];
}

/** Map an IntentId to the legacy BotState for executor dispatch. */
export function intentIdToBotState(id: IntentId): BotState {
  switch (id) {
    case IntentId.SURVIVE_ZONE:
      return BotState.FLEE_ZONE;
    case IntentId.RETREAT_AND_RESET:
      return BotState.RETREAT;
    case IntentId.ARM_UP:
      return BotState.SEEK_WEAPON;
    case IntentId.HUNT_VULNERABLE:
    case IntentId.AMBUSH:
    case IntentId.BARREL_TRAP:
    case IntentId.CONTEST_LOOT:
    case IntentId.DUEL:
      return BotState.ENGAGE;
    case IntentId.LOOT:
      return BotState.LOOT;
    case IntentId.HUNT:
      return BotState.HUNT;
    case IntentId.WANDER:
    default:
      return BotState.WANDER;
  }
}

/**
 * Map the CURRENT executor's BotState back to the intent family that drives
 * it, for goal-suspension on stall. Used by the anti-stall logic: when an
 * executor detects a stall, it suspends the intent family that would re-route
 * to it, so the selector falls through to a DIFFERENT goal.
 *
 * LOOT → LOOT (the dominant stall source — bots target unreachable items).
 * SEEK_WEAPON → ARM_UP (unarmed bot stalled toward a weapon it can't reach).
 * ENGAGE → DUEL (stuck chasing an enemy through unbreakable geometry).
 * HUNT → HUNT (stalled toward a dead hotspot — suspend so it picks a new one).
 * WANDER/RETREAT/FLEE_ZONE → WANDER (no meaningful suspension — these are
 *   fallback/survival states).
 *
 * NOTE: this returns a single "family" IntentId, not the exact one — when an
 * executor stalls, suspending the family stops the selector from re-routing
 * to any intent that would dispatch to the same executor. SURVIVE_ZONE is
 * never suspended (IntentSelector.suspend guards it).
 */
export function botStateToIntentFamily(state: BotState): IntentId {
  switch (state) {
    case BotState.LOOT:
      return IntentId.LOOT;
    case BotState.SEEK_WEAPON:
      return IntentId.ARM_UP;
    case BotState.ENGAGE:
      return IntentId.DUEL;
    case BotState.HUNT:
      return IntentId.HUNT;
    case BotState.RETREAT:
      return IntentId.RETREAT_AND_RESET;
    case BotState.FLEE_ZONE:
    case BotState.WANDER:
    default:
      return IntentId.WANDER;
  }
}
