/**
 * Per-tick bot coordination blackboard (ticket 35).
 *
 * BotSystem previously carried this state as permanent mutable class fields,
 * implicitly reset at the top of `tick()` (`resetCombatCoordinator` zeroed
 * convergingCount and cleared huntersPerTarget/claimedItems; updateZoneInfo
 * rewrote zoneIsLethal in place). A fresh TickBlackboard is now constructed
 * once per tick in BotSystem.tick() — the reset becomes a construction — and
 * passed explicitly down through the phase functions to every executor that
 * reads or writes coordination state, making that dependency visible in the
 * signature instead of a `system.<field>` reach-in.
 *
 * CROSS-BOT SEQUENTIAL SEMANTICS (load-bearing): exactly ONE instance is
 * built per tick, BEFORE the per-bot loop, and passed by reference to each
 * bot's tickBot in `bots` map order. Bots are processed sequentially, so a
 * later bot sees the writes earlier bots made this tick — hunter counts
 * increment as hunters claim, item claims accumulate, convergence slots fill
 * — exactly as when the same fields lived on the system object.
 *
 * SOFT vs HARD reservations (guardrail — do NOT unify): combat targets use
 * `huntersPerTarget` (SOFT: a down-weighting score penalty in selectTarget,
 * never an exclusion) while economy targets use `claimedItems` (HARD: the
 * first claimant exclusively reserves the item for the tick). Both mechanisms
 * are relocated here unchanged — same data structures, same check-then-write
 * logic, opposite semantics on purpose.
 */

/**
 * Cross-tick FIGHT MEMORY — the ONE piece of coordinator state that must
 * SURVIVE the per-tick blackboard construction. The memory has a 20s
 * window (HOTSPOT_MEMORY_TICKS) with age-based expiry; the blackboard
 * carries this object BY REFERENCE from BotSystem's persistent instance.
 *
 * Stimulus-driven since bot-ai-v2 ticket 03 (DEC-002): the ONE writer is
 * the StimulusRouter (StimulusFightMemory.writeFightMemory, fed by routed
 * attack + explosion domain events) — the polling hotspot writers were
 * retired with that migration. Readers mutate nothing; a fresh blackboard
 * next tick sees the carried-forward memory.
 */
export interface CombatHotspotMemory {
  x: number;
  y: number;
  /** Tick of the last fight-stimulus write; -9999 = never written. */
  tick: number;
}

/**
 * Per-tick coordination state shared by all bots. Everything except
 * `hotspot` starts empty/false/zero on every tick — fresh construction is the
 * reset.
 */
export interface TickBlackboard {
  /**
   * Shared fight memory (successor of the combat hotspot) — the most recent
   * fight location derived from routed attack/explosion stimuli. HUNT bots
   * converge on this instead of wandering, so gunfire in one part of the map
   * attracts nearby armed bots and sustains combat pressure. Persistent
   * across ticks via the shared CombatHotspotMemory reference (see above);
   * saturating + self-refresh-proof — see BotSystem.tick and the write
   * guards in StimulusFightMemory.ts.
   */
  readonly hotspot: CombatHotspotMemory;

  /**
   * Whether the zone is currently dealing damage to players outside it.
   * Phase 1 (the drop) deals ZERO damage; phases >= 2 do. Written once per
   * tick by updateZoneInfo (before the per-bot loop); read by intent
   * selection (IntentContext.zoneIsLethal). Critical for SurviveZoneIntent:
   * corner-spawned bots are geometrically outside the inscribed zone circle
   * at spawn, but fleeing during the harmless drop preempts SEEK_WEAPON and
   * traps them in FLEE_ZONE for 120s (the "no objectives / wander" bug).
   */
  zoneIsLethal: boolean;

  /**
   * How many bots are currently converging on the fight this tick. Recomputed
   * each tick (fresh 0, incremented as each bot binds a HOTSPOT_STALK
   * macro-goal — bot-ai-v2 ticket 07; the pre-v2 inline HUNT hotspot branch's
   * echo). Once this exceeds the stalk saturation
   * (goal/GoalTables.HOTSPOT_STALK_SATURATION), the goal scorer downweights
   * the stalk for later bots — the fight is already crowded — so a fight
   * draws a few stalkers, not the whole lobby.
   */
  convergingCount: number;

  /**
   * Per-tick map of targetId -> number of bots already committed to
   * attacking that target this tick (SOFT reservation). Each bot that picks
   * a target increments its count; passed to selectTarget so
   * already-contested targets are down-weighted — the standard
   * anti-flocking mechanism that spreads the lobby's fire instead of letting
   * every bot pile onto one victim. Advisory only: a heavily-contested
   * target can still be chosen when no better option scores.
   */
  readonly huntersPerTarget: Map<string, number>;

  /**
   * Per-tick set of item/chest ids that a bot has already committed to
   * looting this tick (HARD reservation). The first bot to target an item
   * claims it and subsequent bots skip it (treating it like a blacklisted
   * item for this tick only). This is the anti-flocking mechanism for the
   * ECONOMY layer — without it, every bot independently picks the same
   * nearest weapon/chest and they pile onto one tile, colliding and idling
   * instead of spreading across the map's loot. Hard because two bots on one
   * chest both freeze channeling and only one can win.
   */
  readonly claimedItems: Set<string>;
}

/**
 * Build the fresh per-tick blackboard. Replaces the old implicit reset
 * (`resetCombatCoordinator`: convergingCount = 0, huntersPerTarget.clear(),
 * claimedItems.clear(), plus zoneIsLethal's rewrite in updateZoneInfo) —
 * fresh empty structures are equivalent to clear() because nothing retains a
 * reference to the previous tick's maps beyond the tick (audited: the only
 * consumers read them within the per-bot loop / selectTarget call).
 *
 * @param hotspot the system's persistent cross-tick hotspot memory, shared by
 *  reference so the 20s combat memory survives the per-tick construction.
 */
export function createTickBlackboard(hotspot: CombatHotspotMemory): TickBlackboard {
  return {
    hotspot,
    zoneIsLethal: false,
    convergingCount: 0,
    huntersPerTarget: new Map(),
    claimedItems: new Set(),
  };
}
