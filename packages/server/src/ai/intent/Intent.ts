/**
 * Intent — the abstraction that replaces the legacy single priority cascade.
 *
 * THE PROBLEM THIS SOLVES: the legacy cascade was one global priority order
 * evaluated identically by every bot every tick. There was no concept of
 * opportunity (only threat+proximity), no commitment (transitions happened
 * every tick on minor input flicker), and no per-bot identity (no personality
 * weighting). It was a reflex: perception → action, with no "what am I trying
 * to do?" in between.
 *
 * THE FIX: an Intent is a committed, readable plan. Each tick the bot scores a
 * set of candidate Intents against (world state × personality), commits to one
 * for a hysteresis window, and the Intent's execute() produces the inputs.
 *
 * Commitment is what kills the "wandering back and forth" you flagged: a bot
 * committed to AMBUSH holds its flank plan for 3-4s instead of re-deciding
 * every tick. Personality weighting is what kills "they all feel the same":
 * an Aggressor weights DUEL high and SURVIVE_ZONE-FLEE low; a Survivor inverts.
 *
 * Contract:
 *   - score(ctx): 0..1 viability × personality weight. A hard gate returns 0
 *     (e.g. DUEL returns 0 when no enemy). 1 = maximally attractive.
 *   - commitTicks(ctx): hysteresis. How long to pursue before re-scoring. Some
 *     intents (AMBUSH) commit long; others (DUEL) re-score fast.
 *   - isValid(ctx): hard invalidate. If false, the selector drops the current
 *     intent immediately regardless of commit window (prey died, zone forced).
 *   - execute(ctx): produce the per-tick inputs. Delegates to existing/new
 *     executors (FLEE_ZONE, SEEK_WEAPON, LOOT, ENGAGE, etc.) — this is why we
 *     evolve in place rather than rebuild.
 *
 * Intents map to BotState for execution (the legacy executors still do the
 * movement). Phase 2 wires SURVIVE_ZONE/ARM_UP/DUEL/LOOT/HUNT to existing
 * executors with personality-weighted scoring; Phase 3 adds the new moment-
 * producing intents (HUNT_VULNERABLE, AMBUSH, BARREL_TRAP, CONTEST_LOOT).
 */
import type { BotContext, BotState } from '../BotContext.ts';
import type { QueuedInput } from '../../application/simulation/InputQueue.ts';
import type { PersonalityProfile } from './PersonalityProfile.ts';

export enum IntentId {
  /** Hard survival: outside zone or under siege. Highest priority, ignores commit. */
  SURVIVE_ZONE,
  /** Low HP with a live enemy that isn't kill-secureable — disengage to reset. */
  RETREAT_AND_RESET,
  /** No real weapon — arm up before anything else (after survival). */
  ARM_UP,
  /** Pursue the most vulnerable target (looter, fresh spawn at flag-clear, low-HP,
   *  enemy engaged with someone else). The "they notice me" intent. Phase 3. */
  HUNT_VULNERABLE,
  /** Proactively break a destructible wall to flank a target. Phase 3. */
  AMBUSH,
  /** Detonate a barrel in blast range of an enemy for AoE + chain. Phase 3. */
  BARREL_TRAP,
  /** Race an enemy to a contested high-tier weapon/chest. Phase 3. */
  CONTEST_LOOT,
  /** Standard combat: approach/strafe/attack a chosen enemy. */
  DUEL,
  /** Grab a booster/health/upgrade (barrier, speed, heal, weapon upgrade). */
  LOOT,
  /** No enemy visible, armed — converge on last-known enemy / hotspot / centroid. */
  HUNT,
  /** Idle/explore default. */
  WANDER,
}

export interface IntentContext {
  ctx: BotContext;
  profile: PersonalityProfile;
  /** Count of alive bots in the room (room-state vision). Powers endgame
   *  thresholds (heal more eagerly, re-arm more eagerly when few remain). The
   *  legacy cascade used this; the intents need it too. */
  aliveBotCount: number;
  /** True if an enemy is within fight range of the bot's active weapon (×1.4).
   *  Powers the "don't divert to loot mid-fight" gate that the legacy cascade
   *  used to keep combat from being starved by loot detours. */
  enemyInFightRange: boolean;
  /** True if the zone is currently dealing damage to players outside it (i.e.
   *  NOT the harmless Phase-1 drop). The map is a square but the zone is a
   *  circle inscribed in it, so corner-spawned bots are geometrically outside
   *  the zone circle — but Phase 1 deals ZERO damage. Without this
   *  flag, SurviveZoneIntent would preempt SEEK_WEAPON for the entire 120s
   *  drop, trapping corner bots in FLEE_ZONE so they never loot (the "bots
   *  have no objectives / wander" bug). Only flee when the zone is lethal. */
  zoneIsLethal: boolean;
  /** Shared tile-size accessor (the same pathfinder instance every executor
   *  uses; structural, like clampToWalkable's pf param). DEC-006 fix 4: an
   *  intent that plants a demolition target (BARREL_TRAP) must key the grid
   *  through this accessor — not a hardcoded tile size — so it stays correct
   *  if the tile size ever differs. Optional: unit-test ic factories that
   *  never plant demolition targets may omit it. */
  pathfinder?: { getTileSize(): number };
  /** The SAT-collider centroid map (gridKey → real world-space collider
   *  centroid) shared with executeDemolitionState — see BotSystem's
   *  destructibleCentroidMap. DEC-006 fix 4: demolition-planting intents aim
   *  at the REAL collider centroid (the artist-authored polygon is often
   *  off-center; tile-center/DTO-position aim misses ~88% of swings). Optional
   *  for the same reason as {@link pathfinder}. */
  destructibleCentroidMap?: ReadonlyMap<number, { x: number; y: number }>;
  /** The bot's last published stimulus scan view (bot-ai-v2 ticket 09,
   *  DEC-010.3): the fight-density source the engagement-discretion triggers
   *  read (third-party arrival). Optional — unit-test ic factories without
   *  stimulus-dependent intents may omit it. */
  stimulusScan?: import('../stimulus/StimulusScan.ts').StimulusScanView | undefined;
  /** MATCH-ARC STATE (bot-ai-v2 ticket 10, DEC-011): the per-tick GDD §14.3
   *  phase-weight state (band + base multipliers) the combat/looting/
   *  positioning intent families read to shape their scores (see
   *  arc/MatchArc.ts). Shared per tick (one object per BotSystem.tick, same
   *  reference for every bot — the memo's IC-shape guard keys on it).
   *  Optional: absent = the identity mid-band arc (no shaping), the same
   *  optionality pattern as {@link pathfinder}/{@link stimulusScan} —
   *  production (BotTickPhases.runIntentSelection) always sets it, and
   *  unit-test ic factories may omit it to assert pre-arc behavior. */
  arc?: import('../arc/MatchArc.ts').MatchArcState | undefined;
}

/**
 * An Intent is scored + executed against an IntentContext. The interface is
 * deliberately minimal — all the complexity lives in the implementations.
 */
export interface Intent {
  readonly id: IntentId;
  /** 0..1 attractiveness, or 0 to hard-gate out. */
  score(ic: IntentContext): number;
  /** How long to commit before re-scoring (ticks). */
  commitTicks(ic: IntentContext): number;
  /** Hard invalidate — if false, selector drops immediately. */
  isValid(ic: IntentContext): boolean;
  /** Produce per-tick inputs. Returns the BotState for legacy executor dispatch. */
  execute(ic: IntentContext): { inputs: QueuedInput[] | null; nextState: BotState };
}

/** Minimum score delta required for a non-current intent to preempt mid-commit.
 *  Prevents jitter between near-equal scores while allowing real opportunity to
 *  break through. Tunable. */
export const PREEMPT_MARGIN = 0.18;
