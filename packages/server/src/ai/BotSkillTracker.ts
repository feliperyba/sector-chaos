/**
 * Per-bot skill telemetry + scoring.
 *
 * Each bot accumulates cheap per-tick counters throughout the match. At match
 * end (or on demand), {@linkcode computeProfile} folds those counters into five
 * normalized 0–100 sub-scores (combat / survival / economy / positioning /
 * decision) and an overall score + tier label.
 *
 * Design goals:
 *  - The benchmark harness reads these via `BotSystem.getSkillSummaries()` and
 *    reports the population averages + tier distribution + weakest dimension.
 *    That output is the main regression signal for AI tuning — each iteration
 *    targets whichever dimension the previous run flagged as weakest.
 *  - Counters are integers/floats updated inline in the hot tickBot path, so
 *    they add negligible cost (no allocation, no iteration).
 *  - A tracker is created at bot registration and kept (not deleted) when the
 *    bot dies, so a bot that died at tick 1000 is still scored over its full
 *    (shorter) match contribution.
 */

import {
  BotBelievabilityCounters,
  summarizeBelievability,
  type BelievabilitySummary,
} from './BotBelievability.ts';

/** Shape consumed by the benchmark harness (see bot-benchmark-harness.ts). */
export interface SkillProfile {
  overall: number;
  combat: number;
  survival: number;
  economy: number;
  positioning: number;
  decision: number;
  tier: string;
  metrics: {
    pickupAttempts: number;
    ticksArmed: number;
    attacksAttempted: number;
    ticksEngaging: number;
  };
  /** Believability telemetry (DEC-013 ticket 01) — observation-only counters
   *  summarized over the bot's full life. See BotBelievability.ts. */
  believability: BelievabilitySummary;
}

/** Death-cause attribution for a bot. */
export type BotDeathCause = 'siege' | 'zone' | 'barrel' | 'trap' | 'combat' | 'other';

/** Aggregated telemetry for one bot. */
export class BotSkillTracker {
  // --- time accumulation (in ticks) ---
  /** Ticks the bot was alive (recorded each tick it was updated while alive). */
  ticksAlive = 0;
  /** Ticks the bot held a real (non-FISTS) weapon with ammo remaining. */
  ticksArmed = 0;
  /** Ticks the bot spent inside the safe zone radius (not at risk of zone dmg). */
  ticksInZone = 0;
  /** Ticks the bot spent in the ENGAGE state. */
  ticksEngaging = 0;
  /** Ticks the bot had an enemy within perception range. */
  ticksNearEnemy = 0;
  /** Ticks the bot was damaged AND standing in the outer half of the zone. */
  ticksDamagedAtEdge = 0;

  // --- economy / looting ---
  pickupAttempts = 0;
  pickupsGrabbed = 0;
  weaponsPickedUp = 0;
  powerUpsCollected = 0;
  healthPacksCollected = 0;
  barriersCollected = 0;
  speedBoostsCollected = 0;
  /** Highest weapon tier index ever held (0=common … 3=legendary). -1 = none. */
  highestWeaponTier = -1;
  /** Ticks the bot held at least a tier-2 (rare) weapon. */
  ticksArmedTier2Plus = 0;

  // --- combat ---
  attacksAttempted = 0;
  /** Damage attributed to this bot (from PlayerEliminated/kill feed + delt).
   *  We approximate damageDealt via the domain player stat at scoring time, so
   *  this counter only tracks attack *volume*, not landed damage. */
  deaths = 0;
  damageDealtSnapshot = 0;
  damageTakenSnapshot = 0;
  killSnapshot = 0;

  // --- deaths by cause ---
  siegeDeaths = 0;
  zoneDeaths = 0;
  barrelDeaths = 0;
  trapDeaths = 0;
  combatDeaths = 0;
  otherDeaths = 0;

  /** Has this bot died yet this match? */
  isDead = false;
  /** Tick at which the bot died (for survival-time computation). */
  deathTick = -1;

  /**
   * Believability counters (DEC-013 ticket 01). Observation-only: written by
   * the BotTelemetry seams, read by the benchmark. Lives on the tracker (not
   * the BotContext) so the full-match tallies survive the bot's death —
   * selectors/contexts are dropped on unregister.
   */
  readonly believability = new BotBelievabilityCounters();

  /** Called every tick the bot is alive + updated. */
  recordAliveTick(): void {
    this.ticksAlive++;
  }
}

// Normalization bounds. A bot that hits the "good" reference value scores ~90
// on that axis; values are clamped to [0, 100] after scaling. These are
// deliberately generous so a competent hard bot lands in the Veteran/Elite band
// and a clearly broken behavior collapses toward Rookie — making regressions
// obvious in the benchmark summary.
const REF = {
  // combat: kills per full match (600s). Hard bots should net several.
  killsGood: 4,
  // damage dealt per full match.
  dmgDealtGood: 400,
  // damage dealt per tick of engaging (DPS-while-fighting proxy).
  dmgPerEngageTickGood: 0.6,
  // armed time as a fraction of alive time.
  armedFractionGood: 0.6,
  // pickups (weapons + powerups) per match.
  pickupsGood: 6,
  // powerups collected per match.
  powerupsGood: 2,
  // fraction of alive time spent safely inside the zone.
  inZoneFractionGood: 0.95,
  // damage-dealt / damage-taken ratio (1.0 = even in symmetric lobby).
  dmgRatioGood: 1.0,
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Map a raw value toward 0..100 where hitting `good` ≈ 90/100. */
function scoreLine(value: number, good: number): number {
  if (good <= 0) return 0;
  // value/good = 0 -> 0; = 1 -> ~90; asymptote to 100.
  return Math.round(clamp01(value / good) * 90 + clamp01(value / (good * 2)) * 10);
}

/**
 * Compute a bot's skill profile from its accumulated telemetry + the live
 * domain-player stat snapshot (for damageDealt/damageTaken, which the tracker
 * doesn't re-tally to avoid double counting).
 *
 * @param tracker  the bot's telemetry
 * @param matchTicks total ticks the match ran (for time-fraction normalization)
 * @param dmgDealt   total damage attributed to the bot (from domain player stat)
 * @param dmgTaken   total damage the bot took (from domain player stat)
 * @param kills      confirmed kills (from domain player stat — authoritative)
 * @param survivalTicks ticks the bot survived (deathTick or matchTicks if alive)
 */
export function computeProfile(
  tracker: BotSkillTracker,
  matchTicks: number,
  dmgDealt: number,
  dmgTaken: number,
  kills: number,
  survivalTicks: number,
): SkillProfile {
  tracker.damageDealtSnapshot = dmgDealt;
  tracker.damageTakenSnapshot = dmgTaken;
  tracker.killSnapshot = kills;

  const alive = tracker.ticksAlive > 0 ? tracker.ticksAlive : 1;
  const match = matchTicks > 0 ? matchTicks : alive;

  // ---- COMBAT ----
  // Reward: raw kills, total damage, and damage-per-engaging-tick (efficiency
  // — a bot that deals damage only while actively fighting, not while wandering).
  const dmgPerEngageTick = tracker.ticksEngaging > 0 ? dmgDealt / tracker.ticksEngaging : 0;
  const combat =
    scoreLine(kills, REF.killsGood) * 0.45 +
    scoreLine(dmgDealt, REF.dmgDealtGood) * 0.3 +
    scoreLine(dmgPerEngageTick, REF.dmgPerEngageTickGood) * 0.25;

  // ---- SURVIVAL ----
  // Reward longevity (survival fraction of match) and penalize *avoidable*
  // deaths (zone/siege/barrel — a skilled bot shouldn't die to the
  // environment). Combat deaths are not penalized (dying in a fight is fine).
  const survivalFraction = clamp01(survivalTicks / match);
  const avoidableDeaths = tracker.zoneDeaths + tracker.siegeDeaths + tracker.barrelDeaths;
  // Each avoidable death erodes survival score; 1 avoidable death is bad.
  const avoidablePenalty = clamp01(avoidableDeaths * 0.45);
  // Survival = longevity scaled down by avoidable deaths. A bot that lived long
  // but died stupidly (zone/siege/barrel) scores worse than one that died in a
  // fair fight.
  const survival = scoreLine(survivalFraction, 1.0) * (1 - avoidablePenalty);

  // ---- ECONOMY ----
  // Reward: armed-time fraction, total pickups, powerup usage, and reaching
  // tier-2+ weapons. A bot that never arms or loots scores near zero here.
  const armedFraction = tracker.ticksArmed / alive;
  const economy =
    scoreLine(armedFraction, REF.armedFractionGood) * 0.4 +
    scoreLine(tracker.pickupsGrabbed, REF.pickupsGood) * 0.25 +
    scoreLine(tracker.powerUpsCollected, REF.powerupsGood) * 0.15 +
    scoreLine(tracker.ticksArmedTier2Plus, match * 0.3) * 0.2;

  // ---- POSITIONING ----
  // Reward staying inside the safe zone, penalize being damaged at the zone
  // edge (the #1 cause of zone deaths in diagnostics).
  const inZoneFraction = tracker.ticksInZone / alive;
  const edgeDamageFraction = tracker.ticksDamagedAtEdge / alive;
  const positioning =
    scoreLine(inZoneFraction, REF.inZoneFractionGood) * (1 - edgeDamageFraction * 0.7);

  // ---- DECISION ----
  // Composite of engagement quality + damage ratio + economy. This catches
  // bots that survive by hiding (low combat) or that loot but never fight.
  const dmgRatio = dmgTaken > 0 ? dmgDealt / dmgTaken : dmgDealt > 0 ? 1.5 : 0;
  const decision =
    scoreLine(dmgRatio, REF.dmgRatioGood) * 0.4 +
    scoreLine(dmgPerEngageTick, REF.dmgPerEngageTickGood) * 0.3 +
    scoreLine(tracker.powerUpsCollected, REF.powerupsGood) * 0.15 +
    scoreLine(armedFraction, REF.armedFractionGood) * 0.15;

  // ---- OVERALL ----
  const overall = Math.round(
    combat * 0.32 + survival * 0.24 + economy * 0.18 + positioning * 0.12 + decision * 0.14,
  );

  return {
    overall,
    combat: Math.round(combat),
    survival: Math.round(survival),
    economy: Math.round(economy),
    positioning: Math.round(positioning),
    decision: Math.round(decision),
    tier: tierFor(overall),
    metrics: {
      pickupAttempts: tracker.pickupAttempts,
      ticksArmed: tracker.ticksArmed,
      attacksAttempted: tracker.attacksAttempted,
      ticksEngaging: tracker.ticksEngaging,
    },
    believability: summarizeBelievability(tracker.believability, tracker.ticksAlive),
  };
}

function tierFor(overall: number): string {
  if (overall >= 75) return 'Elite';
  if (overall >= 60) return 'Veteran';
  if (overall >= 45) return 'Skilled';
  if (overall >= 30) return 'Novice';
  return 'Rookie';
}
