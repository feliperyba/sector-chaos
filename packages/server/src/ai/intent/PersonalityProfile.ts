/**
 * PersonalityProfile — the deterministic per-bot identity that makes each bot
 * play differently and READABLY.
 *
 * THE PROBLEM THIS SOLVES: the legacy bot ran ONE decision cascade identically
 * for all 64 bots. Every bot made the same tradeoffs (same retreat HP, same
 * aggression, same greed). The only variance was RNG noise. That is why the
 * lobby felt like "a swarm of clones, not 63 distinct threats" — structurally,
 * it was.
 *
 * THE FIX: each bot gets a PersonalityProfile (deterministic from playerId, so
 * benchmarks are reproducible) that weights the tradeoff axes where bots
 * legitimately differ:
 *   - aggression: 倾向 to start/continue fights vs disengage
 *   - greed:      tendency to divert for loot/upgrades vs press combat
 *   - caution:    how early it retreats at low HP (cautious bots bail early)
 *   - opportunism: weight on pursuing vulnerable targets (looters, low-HP) —
 *                  wired in Phase 3 but the knob lives here
 *   - trapper:    affinity for barrel/environmental plays — wired in Phase 3
 *
 * Plus skill knobs driven by the (previously dead) difficulty/mmr:
 *   - aimPrecision:     how tight the aim error is (elite bots miss less)
 *   - reactionLatencyTicks: delay before reacting to a newly-seen enemy
 *   - commitDiscipline: how strongly it holds an intent before re-scoring
 *
 * Named archetypes (AGGRESSOR, SCAVENGER, TRAPPER, DUELIST, SURVIVOR) exist for
 * HUMAN READABILITY — so a developer glancing at a bot's profile instantly
 * grasps its lean. But the underlying weights are continuous vectors, so there
 * is real variance between two "Aggressors" rather than 5 clone-templates.
 *
 * Determinism: the profile is a pure function of (playerId, difficulty). Same
 * inputs → same profile → same behavior. This keeps benchmarks reproducible
 * (a critical requirement) while producing per-bot variety.
 */
import type { BotRNG } from '../BotContext.ts';

/** Named lean of a bot, for readability. The weights are the real identity.
 *  Regular enum (not const) so values survive ESM module boundaries for tests. */
export enum PersonalityArchetype {
  AGGRESSOR, // high aggression, low caution — presses fights, dies young or tops kills
  SCAVENGER, // high greed — prioritizes loot/tier, avoids fair fights
  TRAPPER, // high trapper — plays barrels/environment (Phase 3)
  DUELIST, // balanced combat focus, low greed — fights over loot
  SURVIVOR, // high caution — retreats early, placement-focused
}

export interface PersonalityWeights {
  /** 0..1 — tendency to start and press fights vs disengage/loot. */
  aggression: number;
  /** 0..1 — tendency to divert for loot/upgrades vs keep fighting/hunting. */
  greed: number;
  /** 0..1 — how early to retreat at low HP. High = bails at 50%, low = fights to 20%. */
  caution: number;
  /** 0..1 — bonus weight on pursuing vulnerable targets (Phase 3 hook). */
  opportunism: number;
  /** 0..1 — affinity for barrel/environmental plays (Phase 3 hook). */
  trapper: number;
}

export interface SkillKnobs {
  /** Multiplier on aim error spread. 1.0 = baseline, 0.4 = elite (tight), 1.6 = easy (wild). */
  aimErrorMultiplier: number;
  /** ticks of delay before a newly-spotted enemy is reacted to. 0 = instant, 8 = easy/slow. */
  reactionLatencyTicks: number;
  /** Multiplier on intent commit duration. 1.0 = baseline, 1.5 = stubborn, 0.6 = flighty. */
  commitMultiplier: number;
}

export class PersonalityProfile {
  readonly archetype: PersonalityArchetype;
  readonly weights: PersonalityWeights;
  readonly skill: SkillKnobs;
  /**
   * The difficulty this profile was built for (DEC-013 ticket 01): a stored
   * label, surfaced so the benchmark can cut believability metrics
   * per-difficulty. Pure data — no consumer feeds it back into behavior.
   */
  readonly difficulty: DifficultyLevel;

  constructor(
    archetype: PersonalityArchetype,
    weights: PersonalityWeights,
    skill: SkillKnobs,
    difficulty: DifficultyLevel = 'medium',
  ) {
    this.archetype = archetype;
    this.weights = weights;
    this.skill = skill;
    this.difficulty = difficulty;
  }

  /** Convenience accessors (hot-path friendly — avoid object dereference). */
  get aggression(): number {
    return this.weights.aggression;
  }
  get greed(): number {
    return this.weights.greed;
  }
  get caution(): number {
    return this.weights.caution;
  }
  get opportunism(): number {
    return this.weights.opportunism;
  }
  get trapper(): number {
    return this.weights.trapper;
  }

  /** Human-readable label for diagnostics/benchmark reporting. */
  get archetypeLabel(): string {
    return PersonalityArchetypeLabel[this.archetype];
  }
}

export const PersonalityArchetypeLabel: Record<PersonalityArchetype, string> = {
  [PersonalityArchetype.AGGRESSOR]: 'Aggressor',
  [PersonalityArchetype.SCAVENGER]: 'Scavenger',
  [PersonalityArchetype.TRAPPER]: 'Trapper',
  [PersonalityArchetype.DUELIST]: 'Duelist',
  [PersonalityArchetype.SURVIVOR]: 'Survivor',
};

/**
 * Fallback profile for bots without one (defensive — every bot is assigned a
 * profile at registerBot, but executors must never crash on a missing entry).
 * Medium difficulty, neutral weights: aim is baseline, reaction is 3-tick.
 */
export const DEFAULT_PROFILE: PersonalityProfile = new PersonalityProfile(
  PersonalityArchetype.SURVIVOR,
  { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1.0, reactionLatencyTicks: 3, commitMultiplier: 1.0 },
);

/**
 * Difficulty level consumed by the profile. This is the value the BotManager
 * already tracks (BotManager.ts:4 DifficultyLevel) but never used — finally
 * plumbed through. Higher difficulty = tighter skill knobs.
 */
export type DifficultyLevel = 'easy' | 'normal' | 'medium' | 'hard' | 'elite';

/** Base weight vectors per archetype. Continuous variety comes from the RNG
 *  jitter applied on top (see fromSeed), so two Aggressors aren't identical. */
const ARCHETYPE_BASES: Record<PersonalityArchetype, PersonalityWeights> = {
  [PersonalityArchetype.AGGRESSOR]: {
    aggression: 0.85,
    greed: 0.3,
    caution: 0.2,
    opportunism: 0.6,
    trapper: 0.3,
  },
  [PersonalityArchetype.SCAVENGER]: {
    aggression: 0.35,
    greed: 0.85,
    caution: 0.55,
    opportunism: 0.5,
    trapper: 0.3,
  },
  [PersonalityArchetype.TRAPPER]: {
    aggression: 0.5,
    greed: 0.5,
    caution: 0.5,
    opportunism: 0.65,
    trapper: 0.9,
  },
  [PersonalityArchetype.DUELIST]: {
    aggression: 0.75,
    greed: 0.25,
    caution: 0.4,
    opportunism: 0.55,
    trapper: 0.25,
  },
  [PersonalityArchetype.SURVIVOR]: {
    aggression: 0.3,
    greed: 0.5,
    caution: 0.85,
    opportunism: 0.45,
    trapper: 0.35,
  },
};

/** Skill knobs per difficulty. Driven by the previously-dead difficulty/mmr.
 *  Exported since bot-ai-v2 ticket 08: this is the aim-error half of the
 *  ACCURACY combat cap (CombatCapTables.accuracyCapFor reads it; the
 *  three-cap independence suite mutates it — see CombatCapTables docs). */
export const SKILL_BY_DIFFICULTY: Record<DifficultyLevel, SkillKnobs> = {
  easy: { aimErrorMultiplier: 1.6, reactionLatencyTicks: 8, commitMultiplier: 0.6 },
  normal: { aimErrorMultiplier: 1.2, reactionLatencyTicks: 5, commitMultiplier: 0.85 },
  medium: { aimErrorMultiplier: 1.0, reactionLatencyTicks: 3, commitMultiplier: 1.0 },
  hard: { aimErrorMultiplier: 0.7, reactionLatencyTicks: 1, commitMultiplier: 1.15 },
  elite: { aimErrorMultiplier: 0.45, reactionLatencyTicks: 0, commitMultiplier: 1.3 },
};

/**
 * Build a deterministic PersonalityProfile from a bot's identity.
 *
 * Uses the bot's existing BotRNG (seeded from playerId at construction) so the
 * archetype + jitter are stable across runs. The archetype is picked first
 * (weighted — Aggressors and Survivors are common, Trappers rare), then each
 * weight is jittered ±0.12 around its archetype base and clamped to [0.05, 0.98]
 * so no bot is ever fully degenerate (0 aggression = never fights; 1 caution =
 * always flees).
 *
 * Pure function of (rng, difficulty) — same inputs → same profile.
 */
export function buildPersonality(rng: BotRNG, difficulty: DifficultyLevel): PersonalityProfile {
  // Weighted archetype pick. Weights roughly match battle-royale population
  // expectations: most bots are aggressors/duelists (the fun fights), a chunk
  // are survivors (the placement-focused), fewer are scavengers/trappers
  // (specialists). Trapper is rare because its play needs Phase 3 to shine.
  const roll = rng.next();
  let archetype: PersonalityArchetype;
  if (roll < 0.3) archetype = PersonalityArchetype.AGGRESSOR;
  else if (roll < 0.55) archetype = PersonalityArchetype.DUELIST;
  else if (roll < 0.75) archetype = PersonalityArchetype.SURVIVOR;
  else if (roll < 0.92) archetype = PersonalityArchetype.SCAVENGER;
  else archetype = PersonalityArchetype.TRAPPER;

  const base = ARCHETYPE_BASES[archetype];
  // Jitter each weight ±0.12 for continuous variety within an archetype
  // (DEC-006 fix 2). The jitter itself is the RAW signed draw — symmetric
  // around zero. It was previously sign-clamped into [0.05, 0.98] before
  // being added, so every draw below +0.05 (~71% of them) collapsed to
  // exactly +0.05: weights only ever moved UP from base and intra-archetype
  // variance collapsed (the "swarm of clones"). The RESULT (base + jitter)
  // is still clamped to [0.05, 0.98] below, so no bot is degenerate.
  const jitter = () => (rng.next() - 0.5) * 0.24;
  const weights: PersonalityWeights = {
    aggression: clamp(base.aggression + jitter()),
    greed: clamp(base.greed + jitter()),
    caution: clamp(base.caution + jitter()),
    opportunism: clamp(base.opportunism + jitter()),
    trapper: clamp(base.trapper + jitter()),
  };
  const skill = SKILL_BY_DIFFICULTY[difficulty];
  return new PersonalityProfile(archetype, weights, skill, difficulty);
}

function clamp(v: number): number {
  return Math.max(0.05, Math.min(0.98, v));
}
