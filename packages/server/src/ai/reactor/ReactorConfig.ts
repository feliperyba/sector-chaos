/**
 * Reactor tuning data — bot-ai-v2 ticket 04 (DEC-004/DEC-007).
 *
 * ALL reactor tuning lives in these tables, never in algorithm code: the
 * priority set, the per-archetype reaction mixes (FIXED per archetype so a
 * bot's reflexes are learnable — only TIMING is jittered, via the ex-Gaussian
 * latency table), reaction bounds, suppression masks, and the condition
 * thresholds. Designers rebalance bot reflexes by editing numbers here.
 *
 * GDD compliance (§14.2, §14.4): the difficulty table's reaction times
 * (Easy 600 / Medium 300 / Hard 100 ms) are consumed as the ex-Gaussian
 * distribution MEANS (DEC-007 rejected the literal fixed delay — a fixed
 * delay is itself a metronome tell); imminent environmental threats react
 * with ZERO latency (the §14.4 instant-override: "no tick interval, reaction
 * delay, or cooldown bypass for threat overrides").
 */

import { PersonalityArchetype, type DifficultyLevel } from '../intent/PersonalityProfile.ts';
import type { ReactionType } from './ReactorTypes.ts';

/**
 * The movement STYLE of a reaction (what the bot visibly does relative to the
 * threat). Every style emits a MOVE input every owned tick (visibility
 * invariant) — they differ in the emitted angle:
 *  - 'safe'      run toward the zone-safe point (imminent death); aim = move.
 *  - 'toward'    close on the threat (AGGRESSOR's startle answer).
 *  - 'away'      flee the threat, turning to look at it (aim at threat).
 *  - 'perp'      sidestep perpendicular to the threat axis, facing it.
 *  - 'perpAway'  diagonal: perpendicular sidestep blended with distance.
 */
export type ReactionStyle = 'safe' | 'toward' | 'away' | 'perp' | 'perpAway';

/** One archetype's response recipe for one reaction type. */
export interface ReactionMix {
  style: ReactionStyle;
  /** Emit a DASH on the first owned tick (subject to dash cooldown + the
   *  own-windup suppression — a DASH during own windup is physically dead,
   *  the server drops it, so the mask suppresses the dash, never the MOVE). */
  dash: boolean;
  /** Window length in ticks (clamped to ≤ REACTION_MAX_WINDOW_TICKS). */
  durationTicks: number;
}

/**
 * Per-archetype reaction mixes — FIXED per archetype (DEC-004 "Maya: reaction
 * types must stay consistent per bot"; the learnable-AI requirement). Two
 * same-archetype bots flinch the same WAY at different TIMES. The benches can
 * therefore gate "windup-reaction counts > 0 for ALL archetypes" — every
 * archetype has a real, visible response to every reaction type.
 */
export const ARCHETYPE_REACTION_MIXES: Readonly<
  Record<ReactionType, Readonly<Record<PersonalityArchetype, ReactionMix>>>
> = {
  // Priority 1 — imminent death: survival is NOT personality-flavored (GDD
  // §14.4 override semantics; identical rows keep the table total).
  imminentDeath: {
    [PersonalityArchetype.AGGRESSOR]: { style: 'safe', dash: true, durationTicks: 10 },
    [PersonalityArchetype.SCAVENGER]: { style: 'safe', dash: true, durationTicks: 10 },
    [PersonalityArchetype.TRAPPER]: { style: 'safe', dash: true, durationTicks: 10 },
    [PersonalityArchetype.DUELIST]: { style: 'safe', dash: true, durationTicks: 10 },
    [PersonalityArchetype.SURVIVOR]: { style: 'safe', dash: true, durationTicks: 12 },
  },
  // Priority 2 — incoming projectile: everyone evades perpendicular (a real
  // perpendicular escape, promoting the legacy 250px steering nudge to a
  // committed reaction); bolder archetypes hold the sidestep, prudent ones
  // blend distance and spend the dash.
  projectile: {
    [PersonalityArchetype.AGGRESSOR]: { style: 'perp', dash: false, durationTicks: 8 },
    [PersonalityArchetype.SCAVENGER]: { style: 'perpAway', dash: true, durationTicks: 10 },
    [PersonalityArchetype.TRAPPER]: { style: 'perp', dash: false, durationTicks: 8 },
    [PersonalityArchetype.DUELIST]: { style: 'perp', dash: false, durationTicks: 10 },
    [PersonalityArchetype.SURVIVOR]: { style: 'perpAway', dash: true, durationTicks: 12 },
  },
  // Priority 3 — took damage (STARTLE): AGGRESSOR turns to fight / DUELIST
  // sidesteps-spaces / SURVIVOR disengages / SCAVENGER flees / TRAPPER holds.
  startle: {
    [PersonalityArchetype.AGGRESSOR]: { style: 'toward', dash: false, durationTicks: 10 },
    [PersonalityArchetype.SCAVENGER]: { style: 'away', dash: true, durationTicks: 12 },
    [PersonalityArchetype.TRAPPER]: { style: 'perp', dash: false, durationTicks: 8 },
    [PersonalityArchetype.DUELIST]: { style: 'perp', dash: false, durationTicks: 10 },
    [PersonalityArchetype.SURVIVOR]: { style: 'away', dash: false, durationTicks: 12 },
  },
  // Priority 4 — explosion in hearing radius: arc/dash away; TRAPPER may push
  // toward it (the barrel player runs TOWARD his own blasts).
  explosion: {
    [PersonalityArchetype.AGGRESSOR]: { style: 'away', dash: false, durationTicks: 8 },
    [PersonalityArchetype.SCAVENGER]: { style: 'away', dash: true, durationTicks: 12 },
    [PersonalityArchetype.TRAPPER]: { style: 'toward', dash: false, durationTicks: 10 },
    [PersonalityArchetype.DUELIST]: { style: 'away', dash: false, durationTicks: 10 },
    [PersonalityArchetype.SURVIVOR]: { style: 'away', dash: true, durationTicks: 12 },
  },
  // Priority 5 — enemy windup aimed at me: UN-GATED for every archetype
  // (DEC-010.2 — the caution gate is gone); the archetype flavors the
  // RESPONSE, never whether it happens. bot-ai-v2 ticket 09 (DEC-010)
  // tuned the three named response patterns end-to-end:
  //  - TANK-AND-PUNISH (AGGRESSOR): the minimal punish-ready sidestep —
  //    clear the hitbox line, stay in counter range, no dash spent;
  //  - SIDESTEP-AND-SPACE (DUELIST/TRAPPER): the diagonal perpAway —
  //    sidestep the swing WHILE gaining working distance for the next
  //    exchange (the fencer's reset);
  //  - EARLY-DASH (SCAVENGER/SURVIVOR): dash on the first owned tick and
  //    keep leaving — the evade of a bot that does not want the trade.
  windup: {
    [PersonalityArchetype.AGGRESSOR]: { style: 'perp', dash: false, durationTicks: 6 },
    [PersonalityArchetype.SCAVENGER]: { style: 'away', dash: true, durationTicks: 10 },
    [PersonalityArchetype.TRAPPER]: { style: 'perpAway', dash: false, durationTicks: 9 },
    [PersonalityArchetype.DUELIST]: { style: 'perpAway', dash: false, durationTicks: 9 },
    [PersonalityArchetype.SURVIVOR]: { style: 'away', dash: true, durationTicks: 12 },
  },
};

/**
 * Ex-Gaussian latency parameters per difficulty (DEC-007): a reaction fires
 * `gauss(meanMs - tauMs, sigmaMs) + exp(tauMs)` milliseconds after its
 * stimulus, so the DISTRIBUTION MEAN equals `meanMs` — the GDD §14.2 reaction
 * times (Easy 600 / Medium 300 / Hard 100 ms) consumed as distribution means.
 * The GDD table names three levels; 'normal' shares Medium's row and 'elite'
 * shares Hard's (they were already collapsed onto the same skill-knob rows in
 * PersonalityProfile.SKILL_BY_DIFFICULTY).
 * Shape: σ ≈ mean/4 gives the fast bulk; τ ≈ mean/6 the slow tail
 * (ex-Gaussian right skew — human RT, "fast but varied, occasionally slow").
 */
export interface ReactionLatencyParams {
  /** Distribution mean in ms (the GDD §14.2 table value). */
  meanMs: number;
  /** Gaussian σ in ms. */
  sigmaMs: number;
  /** Exponential τ in ms (the slow tail). */
  tauMs: number;
}

export const REACTION_LATENCY_BY_DIFFICULTY: Readonly<
  Record<DifficultyLevel, ReactionLatencyParams>
> = {
  easy: { meanMs: 600, sigmaMs: 150, tauMs: 100 },
  normal: { meanMs: 300, sigmaMs: 75, tauMs: 50 },
  medium: { meanMs: 300, sigmaMs: 75, tauMs: 50 },
  hard: { meanMs: 100, sigmaMs: 25, tauMs: 17 },
  elite: { meanMs: 100, sigmaMs: 25, tauMs: 17 },
};

/** Hard ceiling on a single latency draw (ticks). Caps the ex-Gaussian tail
 *  (Easy μ=600ms can draw ~1s+) so a reaction still lands while its cause is
 *  contextually meaningful. 1.5s. */
export const REACTION_LATENCY_MAX_TICKS = 90;

/**
 * Reaction window bound (DEC-004: "bounded duration ≤ ~15 ticks"). Every mix
 * duration is clamped to this at activation; the unit suite pins every table
 * entry ≤ this value so the bound holds by construction.
 */
export const REACTION_MAX_WINDOW_TICKS = 15;

/**
 * Post-window refractory: after a reaction ends, no new reaction arms before
 * this many ticks have passed — the NO-CHAINING bound. Reactions are spikes,
 * not a mode. Imminent-death is exempt ONLY in the preempt sense (it may
 * replace an active window per GDD §14.4); after any window ends, the
 * refractory applies to all types.
 */
export const REACTION_REFRACTORY_TICKS = 10;

/**
 * Suppression masks during the bot's OWN attack windup (DEC-004: no
 * self-stunlock). Windup is uncancellable (COMBAT.WINDUP_UNCANCELLABLE) and
 * DASH is rejected while in windup, so reacting mid-swing is wasted motion
 * that would also fight the bot's own committed attack. Imminent death is
 * exempt: movement stays legal during windup and GDD §14.4 mandates the
 * instant override (the reaction emits MOVE, and the dash branch is
 * additionally masked by the same dto flag).
 */
export const SUPPRESSED_DURING_OWN_WINDUP: Readonly<Record<ReactionType, boolean>> = {
  imminentDeath: false,
  projectile: true,
  startle: true,
  explosion: true,
  windup: true,
};

// ---------------------------------------------------------------------------
// Condition thresholds (flag reads — see ReactorConditions.ts).
// ---------------------------------------------------------------------------

/** Player half-hitbox (PLAYER.HITBOX_WIDTH 96 / 2) + slack: a projectile's
 *  ray passes within this perpendicular distance of the bot's center ⇒ it is
 *  on an intercept course with the hitbox. */
export const PROJECTILE_INTERCEPT_MARGIN_PX = 48 + 8;

/** Only projectiles that reach the bot within this many ticks count as
 *  incoming (a distant round closing in 2s is not yet a reflex cause). */
export const PROJECTILE_IMPACT_HORIZON_TICKS = 30;

/** Ignore projectiles closer than this (already passing — dodging now is
 *  motion noise, and division-by-zero hygiene for degenerate ranges). */
export const PROJECTILE_MIN_DISTANCE_PX = 24;

/** Minimum age-decayed strength for an explosion stimulus to trigger the
 *  explosion reaction (strong, nearby blasts — not the distant rumble). */
export const EXPLOSION_MIN_EFFECTIVE_STRENGTH = 0.3;

/** An explosion stimulus older than this (ticks) no longer triggers — the
 *  blast already happened; flinching at stale booms reads as a bug. */
export const EXPLOSION_MAX_AGE_TICKS = 30;

/** ctx.lastDamageTick within this many ticks counts as a FRESH damage cause
 *  (the startle edge — the value is compared against the per-bot dedupe tick
 *  so repeated ticks of the same hit react once). */
export const DAMAGE_FRESH_TICKS = 3;

/**
 * The moved windup-dodge gates (from the retired shouldDodgeWindup): the
 * PERSONALITY gate is gone (un-gated for all archetypes); the skill + threat
 * gates remain — they are correctness (reacting to a swing that already
 * landed, or one aimed elsewhere, is noise, not reflex).
 */
export const WINDUP_THREAT_DOT = 0.25;
export const WINDUP_RANGE_FACTOR = 1.1;
/** Minimum windup ticks that must REMAIN (after the bot's static reaction
 *  knob) before the reaction arms — guarantees a real chance to clear the
 *  hitbox (carried over verbatim from DODGE_LEAD_TICKS). */
export const WINDUP_LEAD_TICKS = 2;

/** Per-enemy windup reaction cooldown: one reaction per windup EPISODE. The
 *  longest weapon windup is ~20 ticks (Hammer 200ms); 30 exceeds it. */
export const WINDUP_EPISODE_COOLDOWN_TICKS = 30;

// ---------------------------------------------------------------------------
// Startle confusion + accuracy penalty (DEC-007).
// ---------------------------------------------------------------------------

/** No intent switching while startled: the confusion window extends this many
 *  ticks past the startle reaction window (the visible freeze outlasts the
 *  flinch, like a human regaining composure). */
export const STARTLE_CONFUSION_TAIL_TICKS = 6;

/** The startle accuracy penalty decays linearly to zero across this window
 *  (counted from reaction ACTIVATION). 0.5s. */
export const STARTLE_ACCURACY_TICKS = 30;

/** Peak extra aim spread at startle activation (multiplier ADDITIVE term:
 *  effective precision × (1 + penalty); decays linearly to 0). */
export const STARTLE_AIM_PENALTY = 0.8;
