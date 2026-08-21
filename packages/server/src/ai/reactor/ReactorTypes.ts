/**
 * Reactor type definitions — bot-ai-v2 ticket 04 (DEC-004/DEC-007).
 *
 * The Reactor is a per-bot PRIORITIZED INTERRUPT LAYER that lives ABOVE
 * executor dispatch: every tick, after perception, it evaluates a fixed
 * condition→reaction priority table and — when a reaction fires — takes over
 * movement/aiming for a bounded window by emitting queued inputs through the
 * existing input factories (BotInput.ts), then returns control to the intent
 * layer. It is NOT a scored intent (DEC-004 Alternatives Considered): it never
 * enters the IntentSelector, bypasses commit windows/hysteresis by
 * construction, and is evaluated in ALL intent states (the three legacy
 * executor under-fire special cases were retired with this module).
 *
 * CONTRACTS (decision log DEC-004 + DEC-007):
 *  - VISIBILITY INVARIANT: every fired reaction MUST emit ≥1 observable queued
 *    input (a MOVE carries both the turn — aimAngle — and the velocity change;
 *    a DASH is optional extra). ReactorActions enforces this by construction:
 *    the MOVE input is unconditional, the DASH conditional. A reaction with no
 *    emitted input fails the suite by construction (the emit path cannot
 *    return an empty array).
 *  - BOUNDED: a reaction window lasts ≤ REACTION_MAX_WINDOW_TICKS (~15) ticks;
 *    no chaining — after a window ends a refractory gap passes before any new
 *    reaction arms, and while a window is active only the priority-1
 *    imminent-death reaction may preempt (GDD §14.4 instant threat-override).
 *    Imminent death is ALSO exempt from the refractory itself (review M3): a
 *    lethal crossing during the gap fires immediately; re-arms stay bounded
 *    by the rising-edge memory instead (continuous exposure never re-fires).
 *  - SUPPRESSION MASKS: while the bot is in its OWN attack windup, the
 *    masked reaction types do not arm/activate (no self-stunlock; the swing is
 *    uncancellable, so reacting mid-swing is wasted motion). Imminent death is
 *    exempt — GDD §14.4: immediate threats bypass everything (movement is
 *    still legal during windup, so the escape MOVE remains observable).
 *  - DETERMINISM: every stochastic draw (ex-Gaussian latency, perpendicular
 *    strafe sign) routes through the per-bot BotRNG. NO unseeded randomness
 *    and NO wall-clock reads anywhere in the reaction path — the benchmark's
 *    same-seed byte-identity contract holds. (The siege-solidify wall-clock
 *    field is deliberately never read; a pending warning on the bot's tile IS
 *    the imminence signal, since solidified walls are pruned from the list.)
 *  - Bots stay players on the input pipeline: reactions emit through the same
 *    queued-input factories as every executor. No direct state mutation.
 */

/** The prioritized reaction set. Array order in REACTION_TYPE_KEYS is the
 *  priority order (index 0 = highest). Never reorder — JSON telemetry keys and
 *  the priority walk follow this order. */
export type ReactionType = 'imminentDeath' | 'projectile' | 'startle' | 'explosion' | 'windup';

/** JSON-stable enumeration order = priority order (see above). */
export const REACTION_TYPE_KEYS: readonly ReactionType[] = [
  'imminentDeath',
  'projectile',
  'startle',
  'explosion',
  'windup',
];

/**
 * One detected reaction cause (the output of a condition check). PURE data —
 * conditions are flag reads off the stimulus scan view + the bot's perception
 * fields (DEC-004 dissent: no spatial queries in the condition list).
 */
export interface ReactionTrigger {
  type: ReactionType;
  /** Tick the CAUSE occurred (the damage tick, the stimulus tick, this tick
   *  for live geometry like an intercepting projectile). Reaction latency is
   *  measured from here (the believability reactionLatency histogram). */
  stimulusTick: number;
  /** World position of the threat (the thing the bot reacts to): the damage
   *  origin estimate, the explosion seat, the winding-up enemy, the incoming
   *  projectile. Null only for imminentDeath (the escape direction is the
   *  zone-safe point, not a threat position). */
  threatX: number | null;
  threatY: number | null;
  /** Unique identity of the CAUSE for dedupe (one reaction per cause): the
   * damage tick, the explosion stimulus key, the projectile id, the windup
   * episode (enemy id + episode tick). Imminent-death re-arms are bounded by
   * the RISING-EDGE memory below (the condition is continuous geometry; the
   * refractory exempts imminent death — review M3). */
  key: string;
  /** The entity the cause is about, where one exists (the winding-up enemy id
   *  — used to re-validate a windup reaction at arm time; the projectile id).
   *  Null when the cause has no subject (explosion, zone, damage edge). */
  subjectId: string | null;
}

/** A reaction that has been detected and is waiting out its ex-Gaussian
 *  latency before activating (the human "saw it, processing" gap). */
export interface PendingReaction {
  type: ReactionType;
  /** Tick the reaction ACTIVATES (stimulusTick + drawn latency). */
  armAtTick: number;
  stimulusTick: number;
  threatX: number | null;
  threatY: number | null;
  /** For windup re-validation at arm time: the enemy id whose windup started
   *  this reaction (null for non-windup types). */
  windupEnemyId: string | null;
}

/** The currently active (owning) reaction window. */
export interface ActiveReaction {
  type: ReactionType;
  /** First tick this tick owns inputs (activation tick). */
  startTick: number;
  /** Exclusive end tick: while ctx.tick < untilTick the reaction owns the
   *  tick. startTick + window ≤ startTick + REACTION_MAX_WINDOW_TICKS. */
  untilTick: number;
  stimulusTick: number;
  /** Threat basis snapshot at activation (null for imminentDeath). */
  threatX: number | null;
  threatY: number | null;
  /** Committed perpendicular strafe sign (±1) for perp-style movement. */
  perpSign: number;
  /** True until the first owned tick has emitted (gates the one-shot DASH). */
  emittedFirstTick: boolean;
}

/**
 * Per-bot Reactor blackboard. One instance per bot, owned by the BotReactor
 * (keyed by playerId — same lifecycle pairing as the stimulus router states).
 * Nothing here lives on BotContext on purpose: the reaction layer is a
 * self-contained module with its own state, exactly like the stimulus queues.
 */
export interface ReactorBotState {
  /** Latency-armed reaction waiting to activate (at most one). */
  pending: PendingReaction | null;
  /** The reaction currently owning ticks (null when control is with the
   *  intent layer/executor). */
  active: ActiveReaction | null;
  /** No new reaction arms before this tick (post-window refractory — the
   *  "no chaining" bound). Set at activation: window end + refractory. */
  refractoryUntilTick: number;
  // --- per-channel dedupe memory (bounded) ---
  /** Last ctx.lastDamageTick value a startle reaction consumed (-9999 never). */
  lastReactedDamageTick: number;
  /** Explosion stimulus keys already reacted to (bounded by queue cap + decay:
   *  pruned when the matching stimulus leaves the scan view). */
  reactedExplosionKeys: Set<string>;
  /** Projectile ids already reacted to (pruned each tick to the ids present
   *  in ctx.projectiles — reacted projectiles leave perception within
   *  ~30 ticks of passing). */
  reactedProjectiles: Set<string>;
  /** enemyId → tick of the last windup reaction on that enemy. A windup
   *  episode is ≤ ~20 ticks, so a per-enemy cooldown longer than the longest
   *  windup guarantees ONE reaction per episode. Pruned lazily. */
  windupReactTicks: Map<string, number>;
  /** Rising-edge memory for the lethal-zone half of imminent death: the
   *  reaction fires when the bot CROSSES outside a damaging zone (one reflex
   *  spike), not every tick it remains outside — steady-state fleeing is the
   *  SURVIVE_ZONE intent's job (pathfinding beats a straight-line panic).
   *  Written by the reactor on EVERY tick (runReactionTick's finally) and
   *  read by the detector as the PREVIOUS tick's exposure (review M3 — it
   *  may not freeze during a window, or a re-entry's next crossing would be
   *  swallowed). */
  wasOutsideLethalZone: boolean;
  // --- startle confusion / accuracy penalty (DEC-007) ---
  /** While ctx.tick < this, the intent selector must NOT switch intents
   *  (startle confusion window — includes the reaction window plus a short
   *  tail so the freeze is observable after the flinch). */
  confusedUntilTick: number;
  /** Tick the startle accuracy penalty ends (penalty decays linearly to 0
   *  across [penaltyStartTick, penaltyUntilTick]). */
  startlePenaltyStartTick: number;
  startlePenaltyUntilTick: number;
}

export function createReactorBotState(): ReactorBotState {
  return {
    pending: null,
    active: null,
    refractoryUntilTick: -1,
    lastReactedDamageTick: -9999,
    reactedExplosionKeys: new Set<string>(),
    reactedProjectiles: new Set<string>(),
    windupReactTicks: new Map<string, number>(),
    wasOutsideLethalZone: false,
    confusedUntilTick: -1,
    startlePenaltyStartTick: -1,
    startlePenaltyUntilTick: -1,
  };
}
