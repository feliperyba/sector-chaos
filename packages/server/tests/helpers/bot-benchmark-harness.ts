/**
 * Fast-forward bot AI benchmark harness.
 *
 * Runs a COMPLETE bot match in-process, in wall-clock seconds (not minutes),
 * so bot AI can be benchmarked continuously without a browser or real-time
 * wait. Combines three pieces:
 *
 * 1. {@linkcode ColyseusTestServer} from `@colyseus/testing` instantiates the
 *    REAL GameRoom (full onCreate: map generation, BotSystem, BotManager).
 * 2. `room.autoDispose = false` keeps the client-less room alive (Colyseus
 *    defaults autoDispose=true, which tears down any room with zero clients).
 * 3. The simulation is driven directly via `orchestrator.update(TICK_INTERVAL)`
 *    in a SYNCHRONOUS tight loop. Blocking the event loop means the room's own
 *    real-time `setSimulationInterval` cannot interleave, so the harness has
 *    sole, deterministic control over tick advancement. This is the same
 *    pattern already proven by `GameRoomHelper.advanceTicks`.
 *
 * ## Virtual clock (faithfulness)
 * The server mixes tick-time and wall-clock time: game logic advances per
 * `update(16.67ms)`, but siege warnings, zone timing, and threat habituation
 * read `Date.now()` / `performance.now()`. In production these are in sync
 * (1 tick == 16.67ms real). A naive fast-forward desyncs them (a 0.5s siege
 * warning would outlast hundreds of game ticks). To keep siege/zone faithful,
 * the loop installs a VIRTUAL clock: `Date.now()` and `performance.now()` both
 * advance by exactly `TICK_INTERVAL` per driven tick. The sim can no longer
 * tell accelerated time from real time.
 *
 * The clock is installed BEFORE the room exists and anchored at a SEED-DERIVED
 * epoch (1700000000000 + seed, matching the bot-ID base time) — not real
 * `Date.now()` — so every wall-clock read the sim makes is a pure function of
 * the bench seed and tick index. Same seed + same ticks => byte-identical
 * timing behavior. (Zone GEOMETRY no longer reads the clock at all — ticket
 * 09 derives the zone seed from the map seed — but zone phase TIMING still
 * does, so the virtual clock contract stays load-bearing.)
 *
 * Known trade-off (bot-ai-v2 ticket 11, DEC-012 — LOAD-BEARING CONTRACT):
 * the AI budget guard (`src/ai/lod/AiBudgetGuard.ts`) enforces the GDD
 * §15.3.1b ≤4 ms GLOBAL Bot-AI budget on `performance.now()` — chosen
 * BECAUSE this harness virtualizes that exact clock (Wei's DEC-012 dissent
 * resolution). Since the virtual clock does not advance *within* a single
 * tick, every within-tick guard delta is 0: LOD relief NEVER fires during a
 * benchmark, so bot behavior stays a pure function of the tick stream and
 * the same-seed byte-identity gate holds (the old stale claim of a
 * "per-bot 8ms budget" never existed as code — the guard is the first real
 * enforcement, and it is global). Real AI cost is still OBSERVED via
 * `process.hrtime` (never virtualized): the `aiTime` percentiles plus the
 * `aiBudget` block (overrun counters + `sustainedOverrun` — sustained
 * metric-clock overrun is a bench FAIL gate, not a silent degradation).
 * Both blocks are WALL-CLOCK fields and JOIN THE MASKED SET. Use the
 * production server + Docker for relief/budget realism; use this harness
 * for AI-quality (survival, combat, navigation, siege avoidance) regression
 * checks.
 *
 * ## Believability telemetry + AI-time (bot-ai-v2 DEC-013, ticket 01)
 * The result additionally carries `believability` (reaction-latency
 * histograms, stall telemetry, action diversity / intent entropy, dash-throw-
 * switch reason tallies, idle ratio, path efficiency — each cut per-archetype
 * and per-difficulty) and `aiTime` (P50/P95/P99/max of the per-tick BotSystem
 * slice). Since bot-ai-v2 ticket 04 the believability block ALSO carries the
 * Reactor's fired-reaction counts by type (`reactionsByType` — per-archetype
 * cuts are the windup-reactions-for-all gate) and the true stimulus→
 * activation `reactionLatency` histogram (ex-Gaussian arming draws — spread,
 * not a delta spike). Since bot-ai-v2 ticket 05 the believability block ALSO
 * carries the believed-state telemetry: the belief-source mix
 * (`beliefWritesBySource`: seen/heard/damage writes) and the pursuit
 * outcomes (`pursuitsStarted/Reacquired/Dropped` — the revenge-pursuit
 * termination gate: every started pursuit ends re-acquired or dropped).
 * Determinism contract for both:
 *
 * - `believability` fields are PURE observation of the deterministic tick
 *   stream (no RNG, no clock reads — see src/ai/BotBelievability.ts), so they
 *   are covered by the same-seed byte-identity gate like every other metric.
 * - `aiTime` is measured inside BotSystem.tick via `process.hrtime` — the
 *   same NEVER-VIRTUALIZED monotonic clock this harness uses for `tickBudget`.
 *   It deliberately does NOT read `performance.now()`: under the virtual clock
 *   a within-tick delta is always 0, which would make the metric vacuous. The
 *   measurement is read-only (the value never feeds back into behavior), so
 *   the virtual-clock contract stays intact. As a wall-clock measurement,
 *   `aiTime` JOINS THE MASKED SET for byte-identity comparisons:
 *   `timestamp`, `realDurationMs`, `speedup`, `tickBudget`, `aiTime`,
 *   `aiBudget`. This is the load-bearing contract for the pre-v2 baseline
 *   fixture diff gates. (The budget GUARD, by contrast, reads the
 *   VIRTUALIZED `performance.now()` by design — see "Known trade-off" above —
 *   so relief is deterministic-inert here and only observable in production.)
 *
 * ## Stimulus telemetry (bot-ai-v2 ticket 03 / DEC-002)
 * The result also carries `stimulus` — per-type routed/delivered counters of
 * the StimulusRouter (domain events → hearing-radius bot stimuli) plus fight-
 * memory write counts. Pure observation of the deterministic tick stream
 * (tick-stamped, RNG-free, no wall-clock reads — see
 * src/ai/stimulus/StimulusRouter.ts), so it is covered by the same-seed
 * byte-identity gate. The non-zero-deliveries assertion (bots receive
 * stimuli end-to-end) is the ticket's wiring proof.
 *
 * ## Bot spawn wait
 * `BotManager.spawnBots` trickles bots in via `clock.setInterval` over ~5s of
 * REAL time (it is not tick-driven). The harness polls the player count and
 * waits for all bots to register before starting the fast-forward loop. This
 * is a one-time ~5s setup cost; the full game (36000 ticks) then runs in
 * wall-clock seconds.
 */

import type { ColyseusTestServer } from '@colyseus/testing';
import { Room } from 'colyseus';
import {
  MatchPhase,
  NETWORK,
  WeaponType,
  countTiers,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
} from '@sector-battle/shared';
import type { GameRoom } from '../../src/room/GameRoom.ts';
import type { LightingReport } from '../../src/infrastructure/map/LightingReportBuilder.js';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema.ts';
import type { DifficultyLevel } from '../../src/ai/BotManager.ts';
import { IntentId } from '../../src/ai/intent/Intent.ts';
import {
  INTENT_FAMILY_COUNT,
  LATENCY_BUCKET_COUNT,
  type BelievabilitySummary,
} from '../../src/ai/BotBelievability.ts';
import { PRE_POSITION_BUCKET_COUNT } from '../../src/ai/BotGoalTelemetry.ts';
import type { AiBudgetSummary, LodTelemetry } from '../../src/ai/lod/AiBudgetGuard.ts';
import { BENCH_WIDE_MIX } from '../../src/ai/skill/BotDifficultyTables.ts';
import {
  installSeededSimRandom,
  uninstallSeededSimRandom,
} from '../../src/domain/shared/SimRandom.ts';
import { createRoom } from './test-server.ts';

interface SkillProfileMetrics {
  pickupAttempts: number;
  ticksArmed: number;
}

interface SkillProfile {
  overall: number;
  combat: number;
  survival: number;
  economy: number;
  positioning: number;
  decision: number;
  tier: string;
  metrics: SkillProfileMetrics;
  /** Believability telemetry (DEC-013 ticket 01) — full-match, per-bot. */
  believability: BelievabilitySummary;
}

/** Real Date.now captured at module load (before any virtualization). */
const realDateNow = Date.now;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real wall-clock timer in milliseconds. Uses `process.hrtime` (never stubbed
 * by test setup's `performance.now` override) so tick-budget measurement is
 * accurate in BOTH the standalone tsx runner and the vitest CI environment.
 */
const hrtimeMs = (): number => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};

export interface BenchmarkConfig {
  /** Total bots to fill the match with (bots are the only players). */
  botFillTo: number;
  botDifficulty?: DifficultyLevel;
  /** 'demo' (TMX) or 'procedural'. */
  mapType?: 'procedural' | 'demo';
  /** Deterministic map seed for reproducible runs. */
  seed?: number;
  /** How long (in game-time seconds) to run the fast-forward loop. */
  durationSeconds?: number;
  /** Sample resolution (in game-time seconds). */
  sampleEverySeconds?: number;
  /**
   * lastStandingThreshold passed to the orchestrator once the game starts.
   * 1 = end at last man standing (natural battle-royale finish). -1 = never
   * end on alive count (time/overtime only). The harness holds the threshold
   * at -1 during bot spawn to prevent a premature ACTIVE->FINISHED while bots
   * trickle in, then applies this value.
   */
  lastStandingThreshold?: number;
  /** Max real-time seconds to wait for BotManager to spawn all bots. */
  spawnTimeoutSeconds?: number;
}

export interface BenchmarkSample {
  tick: number;
  second: number;
  phase: MatchPhase;
  aliveBots: number;
  armedBots: number;
  avgHealth: number;
  totalKills: number;
  /** Fraction of living bots whose CURRENT intent is an ENGAGE-family intent
   *  (DUEL/HUNT_VULNERABLE/BARREL_TRAP/CONTEST_LOOT/AMBUSH) at this sample tick.
   *  The primary aggression signal: bots that never ENGAGE are passive. */
  engageFraction: number;
  /** Fraction of living bots whose current intent is RETREAT_AND_RESET or
   *  SURVIVE_ZONE at this sample tick — the flee signals. */
  fleeFraction: number;
  /** MATCH-ARC STATE at this sample tick (bot-ai-v2 ticket 10, DEC-011): the
   *  GDD §14.3 alive-ratio band the match was in ('early' | 'mid' | 'late';
   *  'unknown' pre-match). The samples series IS the arc-state timeline. */
  arcBand: string;
  /** alive/total ratio at this sample tick (−1 unknown). */
  arcAliveRatio: number;
}

/** Aggregate time-in-intent distribution across the whole bot population.
 *  Each value is the fraction of all (bot, sample-tick) observations that fell
 *  into that intent. Sums to ~1.0. The ratio of engage-family vs flee-family
 *  vs non-combat (LOOT/WANDER/HUNT/ARM_UP) is the core aggression diagnostic. */
export interface IntentDistribution {
  /** Sum of all DUEL + HUNT_VULNERABLE + BARREL_TRAP + CONTEST_LOOT + AMBUSH fractions. */
  engage: number;
  /** SURVIVE_ZONE fraction. */
  fleeZone: number;
  /** RETREAT_AND_RESET fraction. */
  retreat: number;
  /** ARM_UP fraction. */
  armUp: number;
  /** LOOT fraction. */
  loot: number;
  /** HUNT fraction. */
  hunt: number;
  /** WANDER fraction. */
  wander: number;
}

/** Per-tick wall-clock budget metrics (the 16ms / 60fps hard constraint). */
export interface TickBudgetMetrics {
  /** 50th percentile tick time. */
  p50Ms: number;
  /** 95th percentile tick time. */
  p95Ms: number;
  /** 99th percentile tick time — the tail that must stay under budget. */
  p99Ms: number;
  /** Worst single tick observed. */
  maxMs: number;
  /** Count of ticks that exceeded the 16ms budget. */
  ticksOverBudget: number;
  /** The budget target (ms). */
  budgetMs: number;
}

/** Aggregate combat-quality metrics across the whole bot population. */
export interface CombatSummary {
  totalKills: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  avgKillsPerBot: number;
  avgDamageDealtPerBot: number;
  avgItemsPerBot: number;
  /** damageDealt / damageTaken — ~1.0 in a symmetric all-bot lobby. */
  dmgRatio: number;
}

/** Movement/positioning diagnostics for the wall-stall, idle, and flocking
 *  symptoms. Sampled every sampleEveryTicks alongside the intent distribution.
 *
 *  - clustering: fraction of sampled living bots that have ≥1 other living bot
 *    within CLUSTER_RADIUS (96px = one hitbox). High values = flocking/piling.
 *  - tightClusters: fraction in a cluster of ≥3 bots (the "4 bots fighting to
 *    walk into the same tile" symptom).
 *  - idleArmedWithEnemy: fraction of sampled living bots that are armed, have a
 *    perceived enemy (BotContext.nearestEnemy !== null), but whose current
 *    intent is NOT an ENGAGE-family intent — the "idling with enemies around"
 *    symptom. */
export interface MovementDiagnostic {
  clustering: number;
  tightClusters: number;
  idleArmedWithEnemy: number;
  /** Per-intent breakdown of the idleArmedWithEnemy fraction (each value is a
   *  fraction of all sampled bots, summing to idleArmedWithEnemy). Identifies
   *  whether idle bots are looting, fleeing the zone, arming, etc. */
  idleByIntent: IntentDistribution;
}

/** Radius for cluster detection — one player hitbox (96px). Two bots within
 *  this are visually overlapping / colliding. */
const CLUSTER_RADIUS = 96;

export interface PlacementEntry {
  playerId: string;
  placement: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsCollected: number;
  alive: boolean;
  /** The bot's assigned difficulty tier (bot-ai-v2 ticket 08, DEC-009.1) —
   *  stamped from the BotSystem profile join so the bench can gate on
   *  placements spanning tiers (easy dies more, hard places higher, both
   *  directions present). Null when no profile survived (defensive). */
  difficulty: string | null;
}

/** Death-cause breakdown — tallied from PlayerEliminated events. */
export interface DeathCauseSummary {
  /** Siege wall crush (100 dmg instant-kill). */
  siege: number;
  /** Zone damage / sudden death. */
  zone: number;
  /** Barrel explosion (50 dmg, 256px radius). */
  barrel: number;
  /** Spike/fire/teleport trap. */
  trap: number;
  /** Melee/ranged/thrown/projectile — combat kills. */
  combat: number;
  /** Unknown or unclassified. */
  other: number;
}

/** Aggregate skill scores across the bot population. */
export interface SkillSummary {
  avgOverall: number;
  avgCombat: number;
  avgSurvival: number;
  avgEconomy: number;
  avgPositioning: number;
  avgDecision: number;
  /** Tier distribution: count of bots in each tier. */
  tierDistribution: Record<string, number>;
  /** Top 3 bots by overall skill score. */
  topBots: Array<{ playerId: string; overall: number; tier: string }>;
  /** Weakest dimension name and its average score. */
  weakestDimension: string;
  weakestScore: number;
  /** How many bots ever attempted a pickup. */
  botsWithPickupAttempts: number;
  /** How many bots ever held a real weapon. */
  botsEverArmed: number;
}

/** Aggregated latency histogram over a bot group (population-level cut). */
export interface LatencyHistogramAggregate {
  /** Summed per-bucket counts (bucket labels: see BotBelievability.LATENCY_BUCKET_LABELS). */
  buckets: number[];
  stimuli: number;
  responded: number;
  censored: number;
  /** Mean responded delta in ticks (-1 when the group has no responses). */
  avgTicks: number;
}

/** Believability metrics aggregated over a group of bots (DEC-013 ticket 01).
 *  The "group" is the whole population, one archetype, or one difficulty. */
export interface BelievabilityAggregate {
  /** Bots contributing to this aggregate. */
  bots: number;
  /** Mean per-bot normalized intent entropy (0 = one intent all match, 1 = even mix). */
  avgIntentEntropy: number;
  /** Summed intent-family tick counts (7 buckets, INTENT_FAMILY_KEYS order). */
  intentFamilyTicks: number[];
  /** Dash inputs by reason tag (call-site label). */
  dashByReason: Record<string, number>;
  /** Throw inputs by reason tag. */
  throwByReason: Record<string, number>;
  /** Switch-slot inputs by reason tag. */
  switchByReason: Record<string, number>;
  dashTotal: number;
  throwTotal: number;
  switchTotal: number;
  /** Goal suspensions issued (stall-relocation mechanism firings). */
  suspensions: number;
  suspensionsByFamily: Record<string, number>;
  /** Suspensions by reason tag — 'stall' (goal relocation) vs
   *  'search-failure' (bot-ai-v2 ticket 05: the suspension mechanism
   *  extended from goals to TARGETS — a belief investigation that went
   *  ~90 ticks without re-acquiring). */
  suspensionsByReason: Record<string, number>;
  /** Forced-wander (stall escape) window activations. */
  forcedWanderActivations: number;
  /** Mean per-bot fraction of alive ticks inside a stuck window. */
  avgStuckTimeRatio: number;
  /** Mean per-bot fraction of alive ticks physically idle (speed < 60px/s). */
  avgIdleRatio: number;
  /** Mean per-bot path efficiency (windowed straight-line / traveled px, ≤1). */
  avgPathEfficiency: number;
  /** damage-taken → state-change reaction latency (v1 channel). */
  damageResponse: LatencyHistogramAggregate;
  /** enemy-seen → first-attack reaction latency (v1 channel). */
  seenToAttack: LatencyHistogramAggregate;
  /** Fired-reaction counts by Reactor type (bot-ai-v2 ticket 04, DEC-004):
   *  imminentDeath / projectile / startle / explosion / windup. The
   *  per-archetype cuts of this record are the "windup reactions occur for
   *  ALL archetypes" bench gate. */
  reactionsByType: Record<string, number>;
  /** Total fired reactions (Σ reactionsByType values). */
  reactionsTotal: number;
  /** TRUE stimulus→activation latency of fired reactions (the Reactor's
   *  ex-Gaussian arming draws — non-degenerate by construction; the spread
   *  vs the pre-v2 baseline is the reaction-latency gate, DEC-013). */
  reactionLatency: LatencyHistogramAggregate;
  /** Belief writes by source ('seen' | 'heard' | 'damage') — the belief-
   *  source mix (bot-ai-v2 ticket 05, DEC-003). Deterministic observation
   *  of the believed-state write path; covered by the byte-identity gate. */
  beliefWritesBySource: Record<string, number>;
  /** Total belief writes (Σ beliefWritesBySource values). */
  beliefWritesTotal: number;
  /** Believed-state investigation outcomes (ticket 05: revenge pursuits
   *  terminate on re-acquire or drop — the pursuit-termination gate reads
   *  exactly these; every started pursuit ends in one outcome unless the
   *  bot is still alive and investigating at match end). */
  pursuitsStarted: number;
  pursuitsReacquired: number;
  pursuitsDropped: number;
  /** Stuck-ladder rung entries by key (bot-ai-v2 ticket 06, DEC-005.2 —
   *  'sidestep'|'backUp'|'replan'|'smash'|'relocate'). The stall gate:
   *  rungs fire while suspensions/stuck-time drop vs baseline. */
  ladderRungsByRung: Record<string, number>;
  /** Total ladder rung entries (Σ ladderRungsByRung values). */
  ladderRungsTotal: number;
  /** Deaths at low HP adjacent to a wall tile (DEC-005.4 wall-death
   *  telemetry — the navigated retreat's directional gate). */
  wallAdjacentLowHpDeaths: number;
  /** Macro-goal commits by kind label (bot-ai-v2 ticket 07, DEC-008):
   *  lootCluster/quietSide/unexploredSector/prePosition/hotspotStalk/
   *  endgameHold. The PER-ARCHETYPE cut of this record is the goal-mix
   *  distribution gate (distinct strategic mixes per archetype). */
  macroGoalsByKind: Record<string, number>;
  /** Total macro-goal commits (Σ macroGoalsByKind values). */
  macroGoalsTotal: number;
  /** PRE_POSITION rotation-timing samples (ticket 07): count, mean
   *  ticks-ahead-of-shrink at commit and the ticks-ahead histogram — the
   *  early-mover vs late-cutter distribution per archetype (the margin
   *  data table's visible surface). */
  prePositionSamples: number;
  prePositionAvgTicksAhead: number;
  prePositionBuckets: number[];
  /** Mean per-bot speed coefficient-of-variation (bot-ai-v2 ticket 08,
   *  DEC-009.2) — the signature movement's speed-variance surface. */
  avgSpeedCv: number;
  /** Mean per-bot near-zero-speed tick ratio — the anchor-loiter/stop
   *  surface (SCAVENGER loiters, TRAPPER holds). */
  avgStoppedTickRatio: number;
}

/** The believability block of a benchmark result: population overall + cuts. */
export interface BelievabilityTelemetry {
  overall: BelievabilityAggregate;
  /** Per-archetype cut (archetype label → aggregate; bots without a profile
   *  are grouped under 'Unknown'). */
  byArchetype: Record<string, BelievabilityAggregate>;
  /** Per-difficulty cut (profile difficulty label → aggregate). */
  byDifficulty: Record<string, BelievabilityAggregate>;
  /** The QUANTIFIED "no swarm of clones" gate (bot-ai-v2 ticket 08,
   *  DEC-009/DEC-013): distribution-distance metrics between the cuts —
   *  pairwise total-variation distances of the per-archetype intent mixes
   *  and per-difficulty reaction-latency histograms, plus between-group
   *  separation (η²) of the per-archetype movement features. Computed from
   *  the same deterministic observations as the cuts; same-seed stable. */
  noClones: NoClonesSummary;
}

/** Distribution-distance summary — the no-clones gate, quantified. */
export interface NoClonesSummary {
  /** Max pairwise total-variation distance (0..1) between per-archetype
   *  intent-family mixes. 0 = identical mixes (clones); the bench gate
   *  reads this against the baseline. */
  archetypeIntentTvdMax: number;
  /** Every pairwise archetype intent-mix TVD ('A|B' key, sorted labels). */
  archetypeIntentTvdPairs: Record<string, number>;
  /** Max pairwise TVD between per-difficulty FIRED-reaction latency
   *  histograms (the ex-Gaussian μ per tier made visible: an easy bot's
   *  reaction distribution is a different distribution, not a shifted
   *  spike). */
  difficultyReactionTvdMax: number;
  /** Every pairwise difficulty reaction-latency TVD. */
  difficultyReactionTvdPairs: Record<string, number>;
  /** Per-difficulty mean fired-reaction latency (ticks) — the monotonic
   *  tier ordering check (easy > medium > hard is the GDD §14.2 means
   *  surfacing end-to-end). */
  difficultyReactionAvgTicks: Record<string, number>;
  /** Between-group separation (η², 0..1) of per-archetype speed CV —
   *  1 = all variance between archetypes (perfect signatures), 0 = none. */
  movementSpeedCvEtaSq: number;
  /** η² of per-archetype stopped-tick ratio (the loiter signature). */
  movementStoppedEtaSq: number;
  /** Bot count the movement separation was computed over. */
  movementSamples: number;
}

/** Wall-clock percentile metrics of the per-tick BotSystem pass. MASKED in
 * the determinism contract (see the harness header). */
export interface AiTimeMetrics {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  samples: number;
}

function emptyAiTimeMetrics(): AiTimeMetrics {
  return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 };
}

/**
 * ENFORCED AI BUDGET (bot-ai-v2 ticket 11, DEC-012.2): the BotSystem's
 * budget-guard summary — metric-clock percentiles + overrun counters +
 * `sustainedOverrun` (a sustained overrun makes the bench FAIL, not silently
 * degrade) + guard-clock relief tallies (deterministically all level-0 under
 * the virtual clock — relief only fires in production). WALL-CLOCK values:
 * the whole block is MASKED in the determinism contract (same class as
 * aiTime/tickBudget).
 */
export type AiBudgetMetrics = AiBudgetSummary;

function emptyAiBudgetMetrics(): AiBudgetMetrics {
  return {
    targetMs: 4,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    samples: 0,
    ticksOverBudget: 0,
    maxConsecutiveOverrunTicks: 0,
    sustainedOverrunTicks: 0,
    sustainedOverrun: false,
    reliefTicksByLevel: [0, 0, 0, 0],
  };
}

/**
 * LOD telemetry (bot-ai-v2 ticket 11, DEC-012.1): tier shares, think-tick
 * execution/skips, and immediate combat upgrades. PURE observation of the
 * deterministic tick stream (tier assignment is a pure function of
 * positions/engagement) — covered by the same-seed byte-identity gate, NOT
 * masked. The gate surface for "LOD is actually engaging" (T1/T2 share > 0
 * on a spread 63-bot lobby) and "no behavioral cliff" (combatTierUpgrades
 * > 0 in a fighting match).
 */
export type LodTelemetryMetrics = LodTelemetry;

function emptyLodTelemetryMetrics(): LodTelemetryMetrics {
  return {
    tierBotTicks: [0, 0, 0],
    tierShare: [0, 0, 0],
    thinkTicksExecuted: 0,
    thinkTicksSkipped: 0,
    combatTierUpgrades: 0,
  };
}

/**
 * Stimulus delivery telemetry (bot-ai-v2 ticket 03 / DEC-002): counters from
 * the BotSystem's StimulusRouter. Deterministic (tick-stamped, RNG-free — no
 * wall-clock reads), covered by the same-seed byte-identity gate. The
 * non-zero `deliveredTotal` assertion is the end-to-end wiring proof that
 * bots receive domain-event stimuli.
 */
export interface StimulusTelemetry {
  /** Events that produced a stimulus, per type (STIMULUS_TYPE_KEYS order). */
  routedByType: Record<string, number>;
  /** Stimuli enqueued into bot queues, per type (STIMULUS_TYPE_KEYS order). */
  deliveredByType: Record<string, number>;
  deliveredTotal: number;
  /** Fight-memory writes (attack + explosion stimuli → shared hotspot). */
  fightMemoryWrites: number;
}

function emptyStimulusTelemetry(): StimulusTelemetry {
  return { routedByType: {}, deliveredByType: {}, deliveredTotal: 0, fightMemoryWrites: 0 };
}

/**
 * MATCH-ARC telemetry (bot-ai-v2 ticket 10, DEC-011): the GDD §14.3
 * alive-ratio band timeline + the kills-per-minute curve by phase band.
 * Pure observation of the deterministic tick stream (the band is a pure
 * function of alive counts — no RNG, no wall-clock), so it is covered by the
 * same-seed byte-identity gate. The directional arc gates read this block:
 * first-60s kills down vs baseline while total engagement holds (mid+late
 * combat kills present), a mid-game plateau in the alive curve (samples[]
 * carries the band per sample), and full-duration runs finishing within the
 * phase-table timeline (ticksRun vs the zone phase table).
 */
export interface MatchArcTelemetry {
  /** Ticks each band was active (sums to ticksRun). */
  bandTicks: Record<string, number>;
  /** First tick each band was observed (absent when never). */
  firstTickByBand: Record<string, number>;
  /** Eliminations (all causes) per band. */
  eliminationsByBand: Record<string, number>;
  /** Combat-cause eliminations (melee/ranged/thrown/projectile — the kill
   *  proxy matching the deathCauses.combat bucket) per band. */
  combatKillsByBand: Record<string, number>;
  /** Combat kills per minute of band time (−1 when the band never ran). */
  killsPerMinuteByBand: Record<string, number>;
  /** EARLY-band combat kills credited per KILLER archetype (DEC-011 Viktor
   *  dissent gate: early-game AGGRESSOR fights still occur — Aggressor > 0). */
  earlyKillsByArchetype: Record<string, number>;
  /** Denominator snapshot: registered players at the final sample. */
  totalPlayers: number;
}

function emptyMatchArcTelemetry(): MatchArcTelemetry {
  return {
    bandTicks: {},
    firstTickByBand: {},
    eliminationsByBand: {},
    combatKillsByBand: {},
    killsPerMinuteByBand: {},
    earlyKillsByArchetype: {},
    totalPlayers: 0,
  };
}

const ARC_COMBAT_KILL_CAUSES = new Set([
  'melee_hit',
  'ranged_hit',
  'thrown_hit',
  'projectile_hit',
  'self_thrown',
]);

/**
 * Generation manifest (map-redesign tickets 02–10 / DEC-009): the seed-authored
 * map identity fields audited from every benchmark run — the sector loot-tier
 * pyramid assignment, the per-match hot sector, POI names and the map
 * designation (DEC-001/010), the landmark audit fields (DEC-002), the fortress
 * variant (DEC-004), the lighting report (DEC-005), the skeleton/mirror grids
 * (DEC-007), the zone audit (DEC-008), and — completing the manifest
 * (ticket 10) — the macro shape, fairness repair counts and the drop/death
 * distribution audit. Null fields on non-procedural (demo TMX) runs.
 * Deterministic per seed, so it is included in the same-seed byte-identity
 * contract (the distribution audit is behavioral, not generative — it rides
 * the same virtual-clock determinism as every other sampled metric).
 */
export interface GenerationManifest {
  /** Base loot-tier pyramid (4x4, row-major). The hot sector is WARM here. */
  sectorTiers: string[][] | null;
  /** Per-match hot sector (outer WARM upgraded to HOT for the match). */
  hotSector: { row: number; col: number } | null;
  /** Base-tier sector counts (diagnostics; pyramid targets HOT 2-3 / WARM ~8 / COLD ~5). */
  counts: { hot: number; warm: number; cold: number } | null;
  /** Map designation, e.g. "RINGROAD • SPIRE • 63" (map-redesign ticket 03 / DEC-010). */
  designation: string | null;
  /** Generated POI name per sector (4x4; map-redesign ticket 03 / DEC-001). */
  poiNames: string[][] | null;
  /**
   * Hero landmark composition id per sector (4x4; map-redesign ticket 04 /
   * DEC-002) — the landmark-frequency audit surface (rare under-rolling,
   * signature rotation, adjacency uniqueness).
   */
  heroCompositionIds: string[][] | null;
  /** Junction minor-landmark count (2–3 per map). Null on demo runs. */
  minorLandmarkCount: number | null;
  /** How many hero landmarks rolled RARE this map (the under-rolled event). */
  rareLandmarkCount: number | null;
  /**
   * Fortress variant family (map-redesign ticket 06 / DEC-004): the placed
   * compound/Citadel template — CROSS_PARTITION / PILLARED_HALL /
   * COURTYARD_RING / LOOT_ARM / CITADEL. The Citadel-frequency audit surface
   * (the ~10–15% rarity band). Null on demo runs.
   */
  fortressVariant: string | null;
  /** Citadel footprint size (14) when the map rolled the rare variant. */
  fortressSize: number | null;
  /**
   * Per-sector skeleton (sub-variant) ids, 4×4 (map-redesign ticket 08 /
   * DEC-007) — the skeleton audit surface of the manifest. Null on demo runs.
   */
  sectorSkeletons: string[][] | null;
  /**
   * Per-sector horizontal-mirror flags, 4×4 (map-redesign ticket 08 /
   * DEC-007.2) — the mirror audit surface (mirrored + unmirrored instances
   * must both appear across seeds). Null on demo runs.
   */
  sectorMirrored: boolean[][] | null;
  /** How many sectors were mirror-flipped this map (0..16). */
  mirroredSectorCount: number | null;
  /** How many DISTINCT skeletons appear across the 16 sectors (1..20). */
  distinctSkeletonCount: number | null;
  /**
   * Lighting-hierarchy discipline report (map-redesign ticket 05 / DEC-005):
   * totals by kind, POI-glow pool count, residual ≤3-hue-family violations
   * (LOGGED here per the ticket criterion), hue enforcement actions,
   * value-band violations, dark-pocket summary, and the on-screen static
   * count sample. On demo-TMX runs the TMX-authored placements are reported
   * with no tier split (coldSectorPockets = 0).
   */
  lighting: LightingReport | null;
  /**
   * Zone determinism audit (map-redesign ticket 09 / DEC-008): the seed the
   * zone RNG was initialized with (derived from the FINAL map seed on the
   * isolated 'ZSEC' salt — no longer `Date.now()`) plus the per-phase target
   * center sequence captured from the `ZoneWarning` events during the run
   * (the same next-circle telegraph data clients render). Deterministic per
   * seed, so it is covered by the same-seed byte-identity contract. Null on
   * demo runs (their zone is seeded from the fixed TMX seed, but with no
   * landmark assignment there is no bias and no generation seed to audit).
   */
  zone: ZoneAudit | null;
  /**
   * Macro-shape word of the designation (map-redesign ticket 10 / DEC-009
   * manifest completion): the highway-orientation × flavor-feature vocabulary
   * token (RINGROAD / SPINEWAY / RIDGELINE / TWINFIELDS) — derived from the
   * designation's first token (the shape IS that vocabulary, by construction
   * in poiNames.ts). Null on demo runs.
   */
  macroShape: string | null;
  /**
   * How many spawns the per-spawn fairness repair pass re-picked
   * (map-redesign ticket 10 / DEC-009; 0 = first-choice spawns already
   * equitable). Null on demo runs.
   */
  spawnRepairs: number | null;
  /** Pipeline attempts the successful map took (1 = first attempt). */
  generationAttempts: number | null;
  /**
   * Post-repair spawn-equity worst ratio per component (each spawn's value vs
   * its OWN sector's eligible-pool median — the gate reference; see
   * spawnFairness.ts). ≤ 1.3 everywhere on a gate-clean map. Null on demo.
   */
  equityMaxRatio: { weapon: number; chest: number; clump: number; hot: number } | null;
  /**
   * Drop/death distribution audit (map-redesign ticket 10 / DEC-009 +
   * DEC-003 Marcus dissent): where players LANDED at match start and where
   * the first-60s deaths happened, per sector. Null on demo runs.
   */
  distribution: DistributionAudit | null;
}

/**
 * Drop/death distribution audit of a run (map-redesign ticket 10 / DEC-003
 * dissent resolution): per-sector first-60s drop share + death share, plus
 * the compound (fortress-footprint) drop share. Shares are fractions of the
 * respective totals (bots alive at match start / first-60s deaths).
 */
export interface DistributionAudit {
  /** Share of bots whose match-start position lies in each sector (16, row-major). */
  dropShareBySector: number[];
  /** Share of first-60s deaths by death position, per sector (16, row-major). */
  first60sDeathShareBySector: number[];
  /** Share of drops landing inside the fortress footprint (DEC-003 compound cap). */
  compoundDropShare: number;
  /** Bots alive at the ACTIVE-phase drop snapshot (denominator of drop shares). */
  dropTotal: number;
  /** Deaths in the first 60 game-time seconds (denominator of death shares). */
  first60sDeaths: number;
}

/** Zone audit payload of the generation manifest (ticket 09 / DEC-008). */
export interface ZoneAudit {
  /** `deriveZoneSeed(mapResult.seed)` — the zone RNG seed actually used. */
  seed: number | null;
  /**
   * Per-phase telegraphed target circles, in emission order: one entry per
   * `ZoneWarning` event (the entry's `phase` is the event's `nextPhaseIndex`
   * — the phase the warning was telegraphing INTO).
   */
  centers: Array<{ phase: number; x: number; y: number; radius: number }>;
}

export interface BenchmarkResult {
  config: Required<Omit<BenchmarkConfig, 'botDifficulty' | 'mapType' | 'seed'>> & {
    botDifficulty: string;
    mapType: string;
    seed: number;
    /** bot-ai-v2 ticket 08: the per-bot difficulty assignment mode —
     *  'bench-wide-mix' (all-bot lobby pinned across all five tiers,
     *  DEC-009.1) or 'room-default' (single room-wide difficulty). */
    difficultyMix: string;
  };
  samples: BenchmarkSample[];
  /** Ticks actually simulated (may be less than durationSeconds*60 if the match finished early). */
  ticksRun: number;
  /** True if the match reached FINISHED within the duration. */
  finished: boolean;
  /** Final phase reached. */
  finalPhase: MatchPhase;
  /** Real (wall-clock) ms the fast-forward loop took. */
  realDurationMs: number;
  /** Effective speedup vs real-time (game-seconds per real-second). */
  speedup: number;
  /** Raw GameSimulation metrics (system timings, totals). */
  simulationMetrics: unknown;
  /** Per-tick wall-clock budget metrics vs the 16ms target. */
  tickBudget: TickBudgetMetrics;
  /** Aggregate combat quality across the bot population. */
  combat: CombatSummary;
  /** Aggregate time-in-intent distribution (the aggression diagnostic). */
  intentDistribution: IntentDistribution;
  /** Movement/positioning diagnostics (clustering, idle-with-enemy). */
  movement: MovementDiagnostic;
  /** Approximate placements (alive → kills → damageDealt tiebreak). */
  placements: PlacementEntry[];
  /** Death-cause breakdown from PlayerEliminated events. */
  deathCauses: DeathCauseSummary;
  /** Per-bot skill evaluation profiles. */
  skill: SkillSummary;
  /**
   * Believability telemetry (DEC-013 ticket 01): reaction-latency histograms,
   * stall telemetry, action diversity (intent entropy + dash/throw/switch
   * reason tallies), idle ratio, path efficiency — each cut per-archetype and
   * per-difficulty. Deterministic (pure observation) — covered by the
   * same-seed byte-identity gate.
   */
  believability: BelievabilityTelemetry;
  /**
   * Wall-clock percentiles of the per-tick BotSystem pass. MASKED in the
   * determinism contract (same class as tickBudget — see the harness header).
   */
  aiTime: AiTimeMetrics;
  /**
   * ENFORCED AI BUDGET (bot-ai-v2 ticket 11, DEC-012): percentiles vs the
   * ≤4 ms GDD target, overrun counters, `sustainedOverrun` (FAIL gate), and
   * relief tallies. MASKED in the determinism contract (wall-clock — see the
   * harness header).
   */
  aiBudget: AiBudgetMetrics;
  /**
   * LOD telemetry (bot-ai-v2 ticket 11): tier shares + think-tick skips +
   * immediate combat upgrades. DETERMINISTIC observation — byte-identity
   * covered, NOT masked.
   */
  lodTelemetry: LodTelemetryMetrics;
  /**
   * Stimulus delivery counters per type (bot-ai-v2 ticket 03 / DEC-002) —
   * deterministic observation, covered by the byte-identity gate.
   */
  stimulus: StimulusTelemetry;
  /**
   * MATCH-ARC telemetry (bot-ai-v2 ticket 10, DEC-011): the GDD §14.3
   * band timeline (per-sample arcBand fields on samples[]), kills-per-minute
   * by phase band, and the early-band killer-archetype join (Viktor gate).
   * Deterministic observation, covered by the byte-identity gate.
   */
  matchArc: MatchArcTelemetry;
  /** Seed-authored map identity fields (map-redesign ticket 02). */
  generationManifest: GenerationManifest;
  finalSnapshot: {
    aliveBots: number;
    armedBots: number;
    avgHealth: number;
    totalKills: number;
    aliveBotIds: string[];
  };
  /** Per-drop `[tick, gridX, gridY]` triples for every SiegeWallDropped event,
   * in emission order — the wall-drop cadence series used by the GDD §8.1.3
   * behavior-preservation gate. Only captured when
   * `BENCH_CAPTURE_WALL_DROPS=1` (dev/test-only; never populated otherwise). */
  wallDrops?: Array<[number, number, number]>;
  timestamp: string;
}

/** Minimal structural view of a domain Player (avoids importing the full entity). */
interface DomainPlayerLike {
  id: string;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsCollected: number;
  isAlive(): boolean;
  health: { current: number };
  inventory: { weapons: Array<{ type: WeaponType } | null> };
  movement: { position: { x: number; y: number } };
}

interface OrchestratorLike {
  getMatch():
    | {
        players: Map<string, DomainPlayerLike>;
        /** Maintained alive counter (server-alive-counter) + scan-based drift check. */
        getAlivePlayerCount(): number;
        scanAlivePlayerCount(): number;
        aliveCountMatchesScan(): boolean;
      }
    | undefined;
  getSimulation(): { getMetrics(): unknown };
  getPhase(): MatchPhase;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
  getBotSystem(): {
    getSkillSummaries(matchTicks?: number): Map<string, SkillProfile>;
    selectors: Map<string, { currentIntentId: IntentId | null }>;
    bots: Map<string, { nearestEnemy: { distance: number } | null; x: number; y: number }>;
    /** Believability cut join (DEC-013): per-bot archetype label + difficulty. */
    profiles: Map<string, { archetypeLabel: string; difficulty: string }>;
    /** MATCH-ARC state (ticket 10, DEC-011): this tick's GDD §14.3 band. */
    matchArc?: { band: 'early' | 'mid' | 'late'; aliveRatio: number } | undefined;
    /** AI-time percentile summary (wall-clock — masked, see harness header). */
    getAiTimePercentiles(): {
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
      samples: number;
    };
    /** Enforced-budget summary (bot-ai-v2 ticket 11 — wall-clock, masked). */
    getAiBudgetSummary?(): AiBudgetSummary;
    /** Deterministic LOD observation (ticket 11 — byte-identity covered). */
    getLodTelemetry?(): LodTelemetry;
    /** Stimulus delivery counters (bot-ai-v2 ticket 03 — deterministic). */
    getStimulusDeliverySummary(): {
      routedByType: Record<string, number>;
      deliveredByType: Record<string, number>;
      deliveredTotal: number;
      fightMemoryWrites: number;
    };
  } | null;
}

function asGameRoom(room: Room<{ state: GameStateSchema }>): GameRoom {
  return room as unknown as GameRoom;
}

/**
 * Hold (gate) `Room.prototype.setSimulationInterval` callback dispatch — F4
 * benchmark determinism.
 *
 * The room registers its real 16.67ms interval in onCreate
 * (`GameRoomLifecycle.ts` `setSimulationInterval(...)` call); during the
 * harness's `createRoom` awaits (two `waitForNextSimulationTick` sleeps) that
 * interval fires a VARIABLE number of `onSimulationTick(realDeltaTime)` calls
 * — each running `orchestrator.update()` with the real elapsed delta and
 * head-starting the countdown by a run-dependent amount. Gating dispatch
 * means ZERO real ticks run before the fast-forward loop: the harness's
 * synchronous `orchestrator.update(TICK_INTERVAL)` calls become the only tick
 * source, so the state at loop tick 1 is identical across runs.
 *
 * The interval itself is still registered (Colyseus internals and
 * `waitForNextSimulationTick`'s `_idleTimeout` probe keep working) — only the
 * callback body is held. Harness-side only; production rooms never run under
 * a hold. Returns a `release()` that restores the original prototype method.
 */
function holdRoomSimulationIntervals(): () => void {
  const proto = Room.prototype as unknown as {
    setSimulationInterval: (this: Room, cb: (deltaTime: number) => void, delay?: number) => void;
  };
  const saved = proto.setSimulationInterval;
  let hold = true;
  proto.setSimulationInterval = function (cb, delay) {
    saved.call(
      this,
      (deltaTime: number) => {
        if (hold) return;
        cb(deltaTime);
      },
      delay,
    );
  };
  return () => {
    proto.setSimulationInterval = saved;
    hold = false;
  };
}

function getOrchestrator(room: Room<{ state: GameStateSchema }>): OrchestratorLike {
  return asGameRoom(room).getOrchestrator() as unknown as OrchestratorLike;
}

function countPlayers(orch: OrchestratorLike): number {
  return orch.getMatch()?.players.size ?? 0;
}

function snapshotPlayers(orch: OrchestratorLike): {
  alive: DomainPlayerLike[];
  all: DomainPlayerLike[];
} {
  const players = orch.getMatch()?.players;
  if (!players) return { alive: [], all: [] };
  const all: DomainPlayerLike[] = Array.from(players.values());
  const alive = all.filter((p) => p.id.startsWith('bot_') && p.isAlive());
  return { alive, all };
}

function isArmed(bot: DomainPlayerLike): boolean {
  return bot.inventory.weapons.some((w) => w !== null && w.type !== WeaponType.FISTS);
}

/**
 * Wait (real-time) for BotManager's interval-based spawner to register all
 * `target` bots. Bots spawn via `clock.setInterval` over ~5s of wall-clock;
 * this is the only real-time wait in the harness.
 */
async function waitForBots(
  orch: OrchestratorLike,
  target: number,
  timeoutMs: number,
): Promise<number> {
  const start = realDateNow();
  let count = countPlayers(orch);
  while (count < target && realDateNow() - start < timeoutMs) {
    await sleep(100);
    count = countPlayers(orch);
  }
  return count;
}

/** Intent family classifier — which intent bucket a given IntentId falls into
 *  for the aggression distribution. Kept in sync with the executor dispatch in
 *  BotTickPhases.executeState + intents.ts intentIdToBotState. */
function intentFamily(id: IntentId | null): keyof IntentDistribution {
  switch (id) {
    case IntentId.DUEL:
    case IntentId.HUNT_VULNERABLE:
    case IntentId.BARREL_TRAP:
    case IntentId.CONTEST_LOOT:
    case IntentId.AMBUSH:
      return 'engage';
    case IntentId.SURVIVE_ZONE:
      return 'fleeZone';
    case IntentId.RETREAT_AND_RESET:
      return 'retreat';
    case IntentId.ARM_UP:
      return 'armUp';
    case IntentId.LOOT:
      return 'loot';
    case IntentId.HUNT:
      return 'hunt';
    case IntentId.WANDER:
    default:
      return 'wander';
  }
}

function sample(orch: OrchestratorLike, tick: number): BenchmarkSample {
  const { alive, all } = snapshotPlayers(orch);
  const armed = alive.filter(isArmed).length;
  const totalHealth = alive.reduce((sum, p) => sum + p.health.current, 0);
  const totalKills = all.reduce((sum, p) => sum + (p.kills || 0), 0);
  // Read live intent from each living bot's selector to compute the per-sample
  // aggression fractions. This is read-only telemetry — it does not alter any
  // bot decision.
  let engage = 0;
  let flee = 0;
  const botSystem = orch.getBotSystem();
  if (botSystem && alive.length > 0) {
    for (const p of alive) {
      const sel = botSystem.selectors.get(p.id);
      if (!sel) continue;
      const fam = intentFamily(sel.currentIntentId);
      if (fam === 'engage') engage++;
      else if (fam === 'fleeZone' || fam === 'retreat') flee++;
    }
  }
  // MATCH-ARC timeline sample (ticket 10): the GDD §14.3 band at this tick.
  const arc = botSystem?.matchArc;
  return {
    tick,
    second: Math.round(tick / NETWORK.TICK_RATE),
    phase: orch.getPhase(),
    aliveBots: alive.length,
    armedBots: armed,
    avgHealth: alive.length > 0 ? Math.round(totalHealth / alive.length) : 0,
    totalKills,
    engageFraction: alive.length > 0 ? engage / alive.length : 0,
    fleeFraction: alive.length > 0 ? flee / alive.length : 0,
    arcBand: arc?.band ?? 'unknown',
    arcAliveRatio: arc?.aliveRatio ?? -1,
  };
}

const TICK_BUDGET_MS = 16;

/** Compute P50/P95/P99/max tick times + over-budget count from raw samples. */
function computeTickBudget(times: Float64Array, count: number): TickBudgetMetrics {
  const view = times.slice(0, count).sort();
  const len = view.length;
  const at = (p: number): number => (len > 0 ? view[Math.min(len - 1, Math.floor(p * len))]! : 0);
  let over = 0;
  for (let i = 0; i < count; i++) {
    if (times[i] > TICK_BUDGET_MS) over++;
  }
  return {
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: len > 0 ? view[len - 1]! : 0,
    ticksOverBudget: over,
    budgetMs: TICK_BUDGET_MS,
  };
}

/** Aggregate combat stats across all bots (alive + dead). */
function computeCombatSummary(players: DomainPlayerLike[]): CombatSummary {
  const bots = players.filter((p) => p.id.startsWith('bot_'));
  const n = bots.length || 1;
  let kills = 0;
  let dealt = 0;
  let taken = 0;
  let items = 0;
  for (const b of bots) {
    kills += b.kills || 0;
    dealt += b.damageDealt || 0;
    taken += b.damageTaken || 0;
    items += b.itemsCollected || 0;
  }
  return {
    totalKills: kills,
    totalDamageDealt: dealt,
    totalDamageTaken: taken,
    avgKillsPerBot: kills / n,
    avgDamageDealtPerBot: dealt / n,
    avgItemsPerBot: items / n,
    dmgRatio: taken > 0 ? dealt / taken : 0,
  };
}

/** Compute aggregate skill profile from BotSystem's per-bot trackers. */
function computeSkillSummary(profiles: Map<string, SkillProfile>): SkillSummary | null {
  if (profiles.size === 0) return null;

  const n = profiles.size;
  let sumOverall = 0,
    sumCombat = 0,
    sumSurvival = 0,
    sumEconomy = 0,
    sumPositioning = 0,
    sumDecision = 0;
  const tiers: Record<string, number> = {};
  const all: Array<{ playerId: string; overall: number; tier: string }> = [];
  let botsWithPickups = 0;
  let botsArmed = 0;

  for (const [playerId, profile] of profiles) {
    sumOverall += profile.overall;
    sumCombat += profile.combat;
    sumSurvival += profile.survival;
    sumEconomy += profile.economy;
    sumPositioning += profile.positioning;
    sumDecision += profile.decision;
    tiers[profile.tier] = (tiers[profile.tier] ?? 0) + 1;
    all.push({ playerId, overall: profile.overall, tier: profile.tier });
    if (profile.metrics.pickupAttempts > 0) botsWithPickups++;
    if (profile.metrics.ticksArmed > 0) botsArmed++;
  }

  all.sort((a, b) => b.overall - a.overall);

  const dims: Array<[string, number]> = [
    ['combat', sumCombat / n],
    ['survival', sumSurvival / n],
    ['economy', sumEconomy / n],
    ['positioning', sumPositioning / n],
    ['decision', sumDecision / n],
  ];
  dims.sort((a, b) => a[1] - b[1]);

  return {
    avgOverall: sumOverall / n,
    avgCombat: sumCombat / n,
    avgSurvival: sumSurvival / n,
    avgEconomy: sumEconomy / n,
    avgPositioning: sumPositioning / n,
    avgDecision: sumDecision / n,
    tierDistribution: tiers,
    topBots: all.slice(0, 3),
    weakestDimension: dims[0]![0],
    weakestScore: dims[0]![1],
    botsWithPickupAttempts: botsWithPickups,
    botsEverArmed: botsArmed,
  };
}

/** Approximate placements (alive → kills → damageDealt tiebreak). */
function computePlacements(
  players: DomainPlayerLike[],
  profiles: Map<string, { difficulty: string }> | undefined,
): PlacementEntry[] {
  const bots = players.filter((p) => p.id.startsWith('bot_'));
  const sorted = [...bots].sort((a, b) => {
    const aAlive = a.isAlive() ? 1 : 0;
    const bAlive = b.isAlive() ? 1 : 0;
    if (aAlive !== bAlive) return bAlive - aAlive;
    if ((b.kills || 0) !== (a.kills || 0)) return (b.kills || 0) - (a.kills || 0);
    return (b.damageDealt || 0) - (a.damageDealt || 0);
  });
  return sorted.map((p, i) => ({
    playerId: p.id,
    placement: i + 1,
    kills: p.kills || 0,
    damageDealt: p.damageDealt || 0,
    damageTaken: p.damageTaken || 0,
    itemsCollected: p.itemsCollected || 0,
    alive: p.isAlive(),
    difficulty: profiles?.get(p.id)?.difficulty ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Believability aggregation (DEC-013 ticket 01). Pure population/cut math
// over the per-bot BelievabilitySummary values from getSkillSummaries.
// ---------------------------------------------------------------------------

const BELIEVABILITY_HISTOGRAM_BUCKETS = LATENCY_BUCKET_COUNT;

function emptyLatencyAggregate(): LatencyHistogramAggregate {
  return {
    buckets: new Array<number>(BELIEVABILITY_HISTOGRAM_BUCKETS).fill(0),
    stimuli: 0,
    responded: 0,
    censored: 0,
    avgTicks: -1,
  };
}

/** Mutable accumulator for building one BelievabilityAggregate. */
interface BelievabilityAcc {
  bots: number;
  entropySum: number;
  intentFamilyTicks: number[];
  dashByReason: Record<string, number>;
  throwByReason: Record<string, number>;
  switchByReason: Record<string, number>;
  dashTotal: number;
  throwTotal: number;
  switchTotal: number;
  suspensions: number;
  suspensionsByFamily: Record<string, number>;
  suspensionsByReason: Record<string, number>;
  forcedWanderActivations: number;
  stuckRatioSum: number;
  idleRatioSum: number;
  pathEfficiencySum: number;
  damageResponse: LatencyHistogramAggregate;
  damageResponseTickSum: number;
  seenToAttack: LatencyHistogramAggregate;
  seenToAttackTickSum: number;
  reactionsByType: Record<string, number>;
  reactionsTotal: number;
  reactionLatency: LatencyHistogramAggregate;
  reactionLatencyTickSum: number;
  beliefWritesBySource: Record<string, number>;
  beliefWritesTotal: number;
  pursuitsStarted: number;
  pursuitsReacquired: number;
  pursuitsDropped: number;
  ladderRungsByRung: Record<string, number>;
  ladderRungsTotal: number;
  wallAdjacentLowHpDeaths: number;
  macroGoalsByKind: Record<string, number>;
  macroGoalsTotal: number;
  prePositionSamples: number;
  prePositionTickSum: number;
  prePositionBuckets: number[];
  // Movement features (bot-ai-v2 ticket 08, DEC-009.2).
  speedCvSum: number;
  stoppedRatioSum: number;
}

function newBelievabilityAcc(): BelievabilityAcc {
  return {
    bots: 0,
    entropySum: 0,
    intentFamilyTicks: Array.from({ length: INTENT_FAMILY_COUNT }, () => 0),
    dashByReason: {},
    throwByReason: {},
    switchByReason: {},
    dashTotal: 0,
    throwTotal: 0,
    switchTotal: 0,
    suspensions: 0,
    suspensionsByFamily: {},
    suspensionsByReason: {},
    forcedWanderActivations: 0,
    stuckRatioSum: 0,
    idleRatioSum: 0,
    pathEfficiencySum: 0,
    damageResponse: emptyLatencyAggregate(),
    damageResponseTickSum: 0,
    seenToAttack: emptyLatencyAggregate(),
    seenToAttackTickSum: 0,
    reactionsByType: {},
    reactionsTotal: 0,
    reactionLatency: emptyLatencyAggregate(),
    reactionLatencyTickSum: 0,
    beliefWritesBySource: {},
    beliefWritesTotal: 0,
    pursuitsStarted: 0,
    pursuitsReacquired: 0,
    pursuitsDropped: 0,
    ladderRungsByRung: {},
    ladderRungsTotal: 0,
    wallAdjacentLowHpDeaths: 0,
    macroGoalsByKind: {},
    macroGoalsTotal: 0,
    prePositionSamples: 0,
    prePositionTickSum: 0,
    prePositionBuckets: new Array<number>(PRE_POSITION_BUCKET_COUNT).fill(0),
    speedCvSum: 0,
    stoppedRatioSum: 0,
  };
}

function addReasonCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
}

function accumulateBelievability(acc: BelievabilityAcc, s: BelievabilitySummary): void {
  acc.bots++;
  acc.entropySum += s.intentEntropy;
  for (let i = 0; i < acc.intentFamilyTicks.length; i++) {
    acc.intentFamilyTicks[i] = (acc.intentFamilyTicks[i] ?? 0) + (s.intentFamilyTicks[i] ?? 0);
  }
  addReasonCounts(acc.dashByReason, s.dashByReason);
  addReasonCounts(acc.throwByReason, s.throwByReason);
  addReasonCounts(acc.switchByReason, s.switchByReason);
  acc.dashTotal += s.dashTotal;
  acc.throwTotal += s.throwTotal;
  acc.switchTotal += s.switchTotal;
  acc.suspensions += s.suspensions;
  addReasonCounts(acc.suspensionsByFamily, s.suspensionsByFamily);
  addReasonCounts(acc.suspensionsByReason, s.suspensionsByReason ?? {});
  acc.forcedWanderActivations += s.forcedWanderActivations;
  acc.stuckRatioSum += s.stuckTimeRatio;
  acc.idleRatioSum += s.idleRatio;
  acc.pathEfficiencySum += s.pathEfficiency;
  for (const [channel, tickSumKey] of [
    ['damageResponse', 'damageResponseTickSum'],
    ['seenToAttack', 'seenToAttackTickSum'],
    ['reactionLatency', 'reactionLatencyTickSum'],
  ] as const) {
    const agg = acc[channel];
    const per = s[channel];
    for (let i = 0; i < agg.buckets.length; i++) {
      agg.buckets[i] = (agg.buckets[i] ?? 0) + (per.buckets[i] ?? 0);
    }
    agg.stimuli += per.stimuli;
    agg.responded += per.responded;
    agg.censored += per.censored;
    // avgTicks is the responded-weighted mean — recover the per-bot tick sum.
    acc[tickSumKey] += per.responded > 0 && per.avgTicks >= 0 ? per.avgTicks * per.responded : 0;
  }
  // Reactor reaction counts (bot-ai-v2 ticket 04).
  addReasonCounts(acc.reactionsByType, s.reactionsByType);
  acc.reactionsTotal += s.reactionsTotal;
  // Believed-state telemetry (bot-ai-v2 ticket 05, DEC-003): belief-source
  // mix + pursuit outcomes.
  addReasonCounts(acc.beliefWritesBySource, s.beliefWritesBySource ?? {});
  acc.beliefWritesTotal += s.beliefWritesTotal ?? 0;
  acc.pursuitsStarted += s.pursuitsStarted ?? 0;
  acc.pursuitsReacquired += s.pursuitsReacquired ?? 0;
  acc.pursuitsDropped += s.pursuitsDropped ?? 0;
  // Stuck-ladder + wall-death telemetry (bot-ai-v2 ticket 06, DEC-005).
  addReasonCounts(acc.ladderRungsByRung, s.ladderRungsByRung ?? {});
  acc.ladderRungsTotal += s.ladderRungsTotal ?? 0;
  acc.wallAdjacentLowHpDeaths += s.wallAdjacentLowHpDeaths ?? 0;
  // Macro-goal telemetry (bot-ai-v2 ticket 07, DEC-008): goal-mix + the
  // PRE_POSITION rotation-timing distribution (ticks-ahead at commit).
  addReasonCounts(acc.macroGoalsByKind, s.macroGoalsByKind ?? {});
  acc.macroGoalsTotal += s.macroGoalsTotal ?? 0;
  acc.prePositionSamples += s.prePositionSamples ?? 0;
  acc.prePositionTickSum +=
    s.prePositionSamples > 0 && s.prePositionAvgTicksAhead >= 0
      ? s.prePositionAvgTicksAhead * s.prePositionSamples
      : 0;
  const ppBuckets = s.prePositionBuckets ?? [];
  for (let i = 0; i < acc.prePositionBuckets.length; i++) {
    acc.prePositionBuckets[i] = (acc.prePositionBuckets[i] ?? 0) + (ppBuckets[i] ?? 0);
  }
  // Movement features (bot-ai-v2 ticket 08, DEC-009.2): per-bot speed CV +
  // stopped-tick ratio (the signature-movement surface).
  acc.speedCvSum += s.speedCv ?? 0;
  acc.stoppedRatioSum += s.stoppedTickRatio ?? 0;
}

function finalizeBelievability(acc: BelievabilityAcc): BelievabilityAggregate {
  const n = acc.bots > 0 ? acc.bots : 1;
  if (acc.damageResponse.responded > 0) {
    acc.damageResponse.avgTicks = acc.damageResponseTickSum / acc.damageResponse.responded;
  }
  if (acc.seenToAttack.responded > 0) {
    acc.seenToAttack.avgTicks = acc.seenToAttackTickSum / acc.seenToAttack.responded;
  }
  if (acc.reactionLatency.responded > 0) {
    acc.reactionLatency.avgTicks = acc.reactionLatencyTickSum / acc.reactionLatency.responded;
  }
  return {
    bots: acc.bots,
    avgIntentEntropy: acc.entropySum / n,
    intentFamilyTicks: acc.intentFamilyTicks,
    dashByReason: acc.dashByReason,
    throwByReason: acc.throwByReason,
    switchByReason: acc.switchByReason,
    dashTotal: acc.dashTotal,
    throwTotal: acc.throwTotal,
    switchTotal: acc.switchTotal,
    suspensions: acc.suspensions,
    suspensionsByFamily: acc.suspensionsByFamily,
    suspensionsByReason: acc.suspensionsByReason,
    forcedWanderActivations: acc.forcedWanderActivations,
    avgStuckTimeRatio: acc.stuckRatioSum / n,
    avgIdleRatio: acc.idleRatioSum / n,
    avgPathEfficiency: acc.pathEfficiencySum / n,
    damageResponse: acc.damageResponse,
    seenToAttack: acc.seenToAttack,
    reactionsByType: acc.reactionsByType,
    reactionsTotal: acc.reactionsTotal,
    reactionLatency: acc.reactionLatency,
    beliefWritesBySource: acc.beliefWritesBySource,
    beliefWritesTotal: acc.beliefWritesTotal,
    pursuitsStarted: acc.pursuitsStarted,
    pursuitsReacquired: acc.pursuitsReacquired,
    pursuitsDropped: acc.pursuitsDropped,
    ladderRungsByRung: acc.ladderRungsByRung,
    ladderRungsTotal: acc.ladderRungsTotal,
    wallAdjacentLowHpDeaths: acc.wallAdjacentLowHpDeaths,
    macroGoalsByKind: acc.macroGoalsByKind,
    macroGoalsTotal: acc.macroGoalsTotal,
    prePositionSamples: acc.prePositionSamples,
    prePositionAvgTicksAhead:
      acc.prePositionSamples > 0 ? acc.prePositionTickSum / acc.prePositionSamples : -1,
    prePositionBuckets: acc.prePositionBuckets,
    avgSpeedCv: acc.speedCvSum / n,
    avgStoppedTickRatio: acc.stoppedRatioSum / n,
  };
}

/** Join per-bot believability summaries with their profile labels and fold
 *  into the overall + per-archetype + per-difficulty cuts. Bots whose profile
 *  was already dropped (defensive — profiles live for living bots only, but
 *  summaries cover the full match) fall under 'Unknown'. Also derives the
 *  no-clones distribution-distance block (bot-ai-v2 ticket 08). */
function computeBelievabilityTelemetry(
  skillSummaries: Map<string, SkillProfile>,
  profiles: Map<string, { archetypeLabel: string; difficulty: string }> | undefined,
): BelievabilityTelemetry {
  const overall = newBelievabilityAcc();
  const byArchetypeAcc = new Map<string, BelievabilityAcc>();
  const byDifficultyAcc = new Map<string, BelievabilityAcc>();
  // Per-bot movement features by archetype label (the η² inputs — group
  // means alone cannot separate between- from within-group variance).
  const movementByArchetype = new Map<string, { cv: number; stopped: number }[]>();
  for (const [playerId, profile] of skillSummaries) {
    const labels = profiles?.get(playerId);
    const archetype = labels?.archetypeLabel ?? 'Unknown';
    const difficulty = labels?.difficulty ?? 'Unknown';
    const s = profile.believability;
    accumulateBelievability(overall, s);
    let archAcc = byArchetypeAcc.get(archetype);
    if (!archAcc) {
      archAcc = newBelievabilityAcc();
      byArchetypeAcc.set(archetype, archAcc);
    }
    accumulateBelievability(archAcc, s);
    let diffAcc = byDifficultyAcc.get(difficulty);
    if (!diffAcc) {
      diffAcc = newBelievabilityAcc();
      byDifficultyAcc.set(difficulty, diffAcc);
    }
    accumulateBelievability(diffAcc, s);
    let arr = movementByArchetype.get(archetype);
    if (!arr) {
      arr = [];
      movementByArchetype.set(archetype, arr);
    }
    arr.push({ cv: s.speedCv ?? 0, stopped: s.stoppedTickRatio ?? 0 });
  }
  const toRecord = (m: Map<string, BelievabilityAcc>): Record<string, BelievabilityAggregate> => {
    const out: Record<string, BelievabilityAggregate> = {};
    for (const [k, v] of m) out[k] = finalizeBelievability(v);
    return out;
  };
  return {
    overall: finalizeBelievability(overall),
    byArchetype: toRecord(byArchetypeAcc),
    byDifficulty: toRecord(byDifficultyAcc),
    noClones: computeNoClones(
      toRecord(byArchetypeAcc),
      toRecord(byDifficultyAcc),
      movementByArchetype,
    ),
  };
}

/** Total-variation distance between two normalized count vectors: half the
 *  L1 distance (0 = identical distributions, 1 = disjoint supports). */
function tvd(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i] ?? 0;
    sb += b[i] ?? 0;
  }
  if (sa <= 0 || sb <= 0) return 0; // an empty group carries no distribution
  let l1 = 0;
  for (let i = 0; i < n; i++) {
    l1 += Math.abs((a[i] ?? 0) / sa - (b[i] ?? 0) / sb);
  }
  return l1 / 2;
}

/** η² (between-group share of total variance) of a one-feature sample keyed
 *  by group. 0 = no between-group structure, →1 = groups fully separated. */
function etaSquared(groups: Map<string, number[]>): number {
  let total = 0;
  let totalSq = 0;
  let count = 0;
  for (const vals of groups.values()) {
    for (const v of vals) {
      total += v;
      totalSq += v * v;
      count++;
    }
  }
  if (count < 2) return 0;
  const mean = total / count;
  const ssTotal = totalSq - count * mean * mean;
  if (ssTotal <= 0) return 0;
  let ssBetween = 0;
  for (const vals of groups.values()) {
    if (vals.length === 0) continue;
    const gm = vals.reduce((a, b) => a + b, 0) / vals.length;
    ssBetween += vals.length * (gm - mean) * (gm - mean);
  }
  return Math.max(0, Math.min(1, ssBetween / ssTotal));
}

/** Pairwise TVD map over labeled distributions. */
function pairwiseTvd(dists: Map<string, readonly number[]>): {
  max: number;
  pairs: Record<string, number>;
} {
  const pairs: Record<string, number> = {};
  let max = 0;
  const keys = [...dists.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = tvd(dists.get(keys[i]!)!, dists.get(keys[j]!)!);
      pairs[`${keys[i]}|${keys[j]}`] = d;
      if (d > max) max = d;
    }
  }
  return { max, pairs };
}

/** The no-clones block (bot-ai-v2 ticket 08, DEC-009 validation): intent-mix
 *  TVD per archetype pair, fired-reaction latency TVD + mean per difficulty,
 *  and movement-feature η² per archetype. All inputs are the same
 *  deterministic per-bot observations the cuts aggregate. */
function computeNoClones(
  byArchetype: Record<string, BelievabilityAggregate>,
  byDifficulty: Record<string, BelievabilityAggregate>,
  movementByArchetype: Map<string, { cv: number; stopped: number }[]>,
): NoClonesSummary {
  const archIntent = new Map<string, readonly number[]>();
  for (const [k, agg] of Object.entries(byArchetype)) {
    archIntent.set(k, agg.intentFamilyTicks);
  }
  const intentRes = pairwiseTvd(archIntent);
  const diffLatency = new Map<string, readonly number[]>();
  const diffAvg: Record<string, number> = {};
  for (const [k, agg] of Object.entries(byDifficulty)) {
    diffLatency.set(k, agg.reactionLatency.buckets);
    diffAvg[k] = agg.reactionLatency.avgTicks;
  }
  const latencyRes = pairwiseTvd(diffLatency);
  const cvGroups = new Map<string, number[]>();
  const stoppedGroups = new Map<string, number[]>();
  let movementSamples = 0;
  for (const [k, vals] of movementByArchetype) {
    cvGroups.set(
      k,
      vals.map((v) => v.cv),
    );
    stoppedGroups.set(
      k,
      vals.map((v) => v.stopped),
    );
    movementSamples += vals.length;
  }
  return {
    archetypeIntentTvdMax: intentRes.max,
    archetypeIntentTvdPairs: intentRes.pairs,
    difficultyReactionTvdMax: latencyRes.max,
    difficultyReactionTvdPairs: latencyRes.pairs,
    difficultyReactionAvgTicks: diffAvg,
    movementSpeedCvEtaSq: etaSquared(cvGroups),
    movementStoppedEtaSq: etaSquared(stoppedGroups),
    movementSamples,
  };
}

/**
 * Run a full bot match in fast-forward and return detailed metrics.
 *
 * The caller owns the {@linkcode ColyseusTestServer} lifecycle (boot + cleanup);
 * pass a booted server (e.g. from `createTestServer`).
 */
export async function runBotBenchmark(
  server: ColyseusTestServer,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const botFillTo = config.botFillTo;
  const difficulty = config.botDifficulty ?? 'hard';
  const mapType = config.mapType ?? 'demo';
  const seed = config.seed ?? 12345;
  const durationSeconds = config.durationSeconds ?? 600;
  const sampleEverySeconds = config.sampleEverySeconds ?? 10;
  const lastStandingThreshold = config.lastStandingThreshold ?? 1;
  const spawnTimeoutSeconds = config.spawnTimeoutSeconds ?? 30;

  // 0. F4 determinism setup — BEFORE the room exists, so onCreate itself is
  //    deterministic:
  //    (a) Seed all sim-side randomness (spawn jitter, ground-weapon rolls,
  //        teleport destinations, bot-name pool) via the SimRandom override —
  //        a no-op in production, deterministic draws under bench.
  //    (b) Install the virtual clock anchored at a SEED-DERIVED epoch (was
  //        real Date.now()/performance.now() at install time — differed every
  //        run). Anchoring before createRoom means onCreate's wall-clock reads
  //        (matchId, zone phase timing, ...) also see pinned time, so every
  //        sim-side timestamp is seed-relative. (Zone GEOMETRY is seeded from
  //        the map seed since ticket 09 — the clock no longer influences it.)
  //    (c) Hold the room's real setSimulationInterval dispatch so ZERO real
  //        ticks fire during the createRoom awaits (variable per run before).
  //    All three are restored in the function's finally block.
  const seedBaseTime = 1700000000000 + seed;
  let virtualDate = seedBaseTime;
  let virtualPerf = 0;
  const savedDateNow = globalThis.Date.now;
  const savedPerfNow = globalThis.performance.now;
  globalThis.Date.now = () => virtualDate;
  const installPerfNow = (fn: () => number): void => {
    try {
      Object.defineProperty(globalThis.performance, 'now', {
        value: fn,
        writable: true,
        configurable: true,
      });
    } catch {
      (globalThis.performance as { now: () => number }).now = fn;
    }
  };
  installPerfNow(() => virtualPerf);
  installSeededSimRandom(seed);
  const releaseRoomIntervalGate = holdRoomSimulationIntervals();

  try {
    // 1. Instantiate the real GameRoom. onCreate wires the orchestrator,
    //    BotSystem, BotManager and starts the interval-based bot spawner.
    const room = await createRoom(server, {
      botFillTo,
      botDifficulty: difficulty,
      mapType,
      seed,
    });

    // 2. Keep the client-less room alive (Colyseus auto-disposes empty rooms).
    room.autoDispose = false;

    const orch = getOrchestrator(room);

    // 2b. Generation manifest v1 (map-redesign ticket 02): read the seed-
    //     authored loot-tier pyramid + per-match hot sector off the room's
    //     frozen MapIdentityManifest (stashed in onCreate from the shared
    //     generation output). Ticket 03 adds the POI names + map designation
    //     (DEC-001/010); ticket 04 adds the landmark audit fields (DEC-002 —
    //     hero composition ids, minor count, rare share); ticket 05 adds the
    //     lighting-discipline report (DEC-005); ticket 08 the skeleton/mirror
    //     grids (DEC-007); ticket 09 the zone seed (DEC-008); ticket 10 the
    //     fairness audit (DEC-009). Read-only telemetry; deterministic per
    //     seed so byte-identity holds. Demo-TMX runs have no shared
    //     generation -> all-null manifest.
    const manifest = asGameRoom(room).getMapIdentityManifest();
    const manifestSectorTiers = manifest.sectorTiers ?? null;
    const manifestHotSector = manifest.hotSector ?? null;
    const manifestCounts = manifestSectorTiers ? countTiers(manifestSectorTiers) : null;
    const manifestHeroes = manifest.landmarks?.heroes ?? null;
    const manifestMinorCount = manifest.landmarks?.minors.length ?? null;
    const manifestRareCount = manifestHeroes
      ? manifestHeroes.flat().filter((h) => h.rarity === 'rare').length
      : null;
    const manifestLighting = manifest.lightingReport ?? null;
    const manifestZoneSeed = manifest.zoneSeed;
    const zoneCenterAudit: ZoneAudit['centers'] = [];
    const generationManifest: GenerationManifest = {
      sectorTiers: manifestSectorTiers,
      hotSector: manifestHotSector,
      counts: manifestCounts,
      designation: manifest.designation ?? null,
      poiNames: manifest.poiNames ?? null,
      heroCompositionIds: manifestHeroes
        ? manifestHeroes.map((row) => row.map((h) => h.compositionId))
        : null,
      minorLandmarkCount: manifestMinorCount,
      rareLandmarkCount: manifestRareCount,
      fortressVariant: manifest.fortress?.variant ?? null,
      fortressSize: manifest.fortress?.size ?? null,
      // Ticket 08 (DEC-007): skeleton/mirror audit fields.
      sectorSkeletons: manifest.sectorSkeletons ?? null,
      sectorMirrored: manifest.sectorMirrored ?? null,
      mirroredSectorCount: manifest.sectorMirrored
        ? manifest.sectorMirrored.flat().filter(Boolean).length
        : null,
      distinctSkeletonCount: manifest.sectorSkeletons
        ? new Set(manifest.sectorSkeletons.flat()).size
        : null,
      lighting: manifestLighting,
      // Ticket 09 (DEC-008): null on demo runs (no seed-derived zone path).
      zone:
        manifestZoneSeed !== undefined
          ? { seed: manifestZoneSeed, centers: zoneCenterAudit }
          : null,
      // Ticket 10 (DEC-009): manifest completion — macro shape (the
      // designation's shape token), the fairness repair/attempt counts, and
      // the post-repair equity worst ratios. All null on demo runs.
      macroShape: manifest.designation ? manifest.designation.split(' • ')[0]! : null,
      spawnRepairs: manifest.generationAudit?.spawnRepairs ?? null,
      generationAttempts: manifest.generationAudit?.generationAttempts ?? null,
      equityMaxRatio:
        manifest.generationAudit && manifestSectorTiers
          ? {
              weapon: manifest.generationAudit.equity.maxRatio.weapon,
              chest: manifest.generationAudit.equity.maxRatio.chest,
              clump: manifest.generationAudit.equity.maxRatio.clump,
              hot: manifest.generationAudit.equity.maxRatio.hot,
            }
          : null,
      distribution: null, // filled after the loop (see below)
    };

    // 3. Hold lastStandingThreshold at -1 during spawn so the phase machine can't
    //    trip an early ACTIVE->FINISHED while bots are still trickling in.
    orch.setLastStandingThreshold(-1);

    // 3b. SYNCHRONOUS BOT SPAWN — bypass the interval-based trickle spawner.
    //     The interval-based spawn (clock.setInterval) introduces non-determinism:
    //     the exact tick at which each bot registers varies by ±1 between runs due
    //     to real-time event-loop scheduling. This causes butterfly-effect
    //     divergence in the simulation, making benchmarks irreproducible.
    //
    //     Instead, we access the BotManager directly, clear any pending interval
    //     spawns, and call spawnAllBotsSync to register ALL bots in a single call
    //     with deterministic IDs (bot_{seedBase}_{index}). This guarantees the
    //     same bot IDs and the same registration tick on every run.
    const gameRoom = asGameRoom(room);
    const botManager = (
      gameRoom as unknown as {
        botManager: {
          spawnAllBotsSync: (orch: unknown, max: number, baseTs: number) => number;
          dispose: () => void;
          /** bot-ai-v2 ticket 08 (DEC-009.1): pin the wide deliberate mix. */
          setDifficultyMixOverride: (mix: readonly unknown[] | null) => void;
        };
      }
    ).botManager;
    // WIDE DELIBERATE MIX (bot-ai-v2 ticket 08, DEC-009.1): an all-bot bench
    // lobby carries no lobby MMR, so the production path would assign the
    // room-wide default to every bot — believability would be measured on ONE
    // tier. Pin BENCH_WIDE_MIX (20/20/20/20/20 across easy..elite) so the
    // per-difficulty cuts, the tier-ordering reaction gate, and the
    // placements-spread check all see the full tier range. Deterministic:
    // the draws come from the seeded 'bot-difficulty' site stream.
    botManager?.setDifficultyMixOverride?.(BENCH_WIDE_MIX);
    let spawned: number;
    if (botManager && typeof botManager.spawnAllBotsSync === 'function') {
      spawned = botManager.spawnAllBotsSync(orch, botFillTo, seedBaseTime);
    } else {
      // Fallback: interval-based spawn (non-deterministic, for environments
      // where BotManager.spawnAllBotsSync is not available).
      spawned = await waitForBots(orch, botFillTo, spawnTimeoutSeconds * 1000);
    }
    if (spawned < botFillTo) {
      throw new Error(`Bot spawn failed: only ${spawned}/${botFillTo} bots registered`);
    }

    // 5. Apply the real threshold + start the match (COUNTDOWN -> ACTIVE happens
    //    naturally during fast-forward, ~300 ticks / 5s game-time).
    orch.setLastStandingThreshold(lastStandingThreshold);
    orch.start();

    const totalTicks = Math.ceil(durationSeconds * NETWORK.TICK_RATE);
    const sampleEveryTicks = Math.max(1, Math.round(sampleEverySeconds * NETWORK.TICK_RATE));
    const samples: BenchmarkSample[] = [];

    // Per-tick wall-clock timing (measured against the REAL performance.now
    // captured at module load, NOT the virtualized one). Used to verify the
    // 16ms whole-server-tick budget constraint.
    const tickTimes = new Float64Array(totalTicks);

    /** Death-cause tally — collected from PlayerEliminated events. */
    const deathCauses: DeathCauseSummary = {
      siege: 0,
      zone: 0,
      barrel: 0,
      trap: 0,
      combat: 0,
      other: 0,
    };

    /** Running (bot, intent-family) observation counts for the aggregate
     *  intent-distribution diagnostic. Sampled every sampleEveryTicks (not every
     *  tick — sampling every tick would dominate the run with telemetry work for
     *  little extra signal). */
    const intentCounts: Record<keyof IntentDistribution, number> = {
      engage: 0,
      fleeZone: 0,
      retreat: 0,
      armUp: 0,
      loot: 0,
      hunt: 0,
      wander: 0,
    };
    let intentObservations = 0;

    /** Running movement-diagnostic accumulators (clustering + idle-with-enemy).
     *  Same sample cadence as the intent distribution. */
    let clusterSamples = 0;
    let clusteredCount = 0;
    let tightClusteredCount = 0;
    let idleArmedWithEnemyCount = 0;
    /** Per-intent breakdown of the idleArmedWithEnemy bots — which intent are
     *  they in instead of ENGAGE? Tells us whether idle is LOOT diversion,
     *  SURVIVE_ZONE fleeing, ARM_UP transitioning, etc. */
    const idleByIntent: Record<keyof IntentDistribution, number> = {
      engage: 0,
      fleeZone: 0,
      retreat: 0,
      armUp: 0,
      loot: 0,
      hunt: 0,
      wander: 0,
    };

    let ticksRun = 0;
    let finished = false;
    const loopStartReal = realDateNow();
    // Ticket 10 (DEC-009 + DEC-003 Marcus dissent): drop/death distribution
    // audit accumulators. The DROP snapshot is taken on the FIRST tick the
    // match is ACTIVE — bots sit at their spawn points until then, and the ≤1
    // tick of movement before the snapshot is ~7px, far below the 128px tile,
    // so sector binning is exact. DEATHS bin by the x/y carried on
    // PlayerEliminated events within the first 60 game-time seconds.
    // Procedural runs only (demo TMX has no 4x4 sector grid → null audit).
    const SECTOR_COUNT = SECTOR_GRID_SIZE * SECTOR_GRID_SIZE;
    const SECTOR_PX = SECTOR_TILE_SIZE * TILE_PIXEL_SIZE;
    const sectorIndexOf = (x: number, y: number): number =>
      Math.min(SECTOR_GRID_SIZE - 1, Math.max(0, Math.floor(x / SECTOR_PX))) +
      Math.min(SECTOR_GRID_SIZE - 1, Math.max(0, Math.floor(y / SECTOR_PX))) * SECTOR_GRID_SIZE;
    let dropCounts: number[] | null = null;
    let dropTotal = 0;
    let compoundDrops = 0;
    const deathCounts: number[] = new Array<number>(SECTOR_COUNT).fill(0);
    let first60sDeaths = 0;
    const fortressPx = manifest.fortress
      ? {
          x0: manifest.fortress.originCol * TILE_PIXEL_SIZE,
          x1: (manifest.fortress.originCol + manifest.fortress.size) * TILE_PIXEL_SIZE,
          y0: manifest.fortress.originRow * TILE_PIXEL_SIZE,
          y1: (manifest.fortress.originRow + manifest.fortress.size) * TILE_PIXEL_SIZE,
        }
      : null;
    // BENCH_CAPTURE_WALL_DROPS=1 — dev/test-only siege cadence capture for the
    // GDD §8.1.3 behavior-preservation gate (see MapSiegeService differential
    // tests). Passive: reads emitted events, never affects the run.
    const captureWallDrops = process.env.BENCH_CAPTURE_WALL_DROPS === '1';
    const wallDrops: Array<[number, number, number]> = [];
    // MATCH-ARC accumulators (ticket 10, DEC-011): per-band tick/elimination
    // tallies + the early-band killer-archetype join (Viktor gate). The band
    // for tick i+1 is the state BotSystem computed at the START of that tick
    // (before its eliminations applied — deterministic, event-order stable).
    const matchArcAcc = emptyMatchArcTelemetry();
    const bandOf = (t: number): string => {
      const band = orch.getBotSystem()?.matchArc?.band;
      if (band) {
        matchArcAcc.bandTicks[band] = (matchArcAcc.bandTicks[band] ?? 0) + 1;
        if (matchArcAcc.firstTickByBand[band] === undefined) {
          matchArcAcc.firstTickByBand[band] = t;
        }
        return band;
      }
      return 'unknown';
    };
    // server-alive-counter drift check (BENCH_ASSERT_ALIVE_COUNT=1): after every
    // driven tick, verify the maintained alive count equals the full O(n) scan.
    // Test/dev-only — an O(n) scan per tick would reintroduce the cost this
    // feature removes, so it is never enabled in production paths.
    const assertAliveCounter = process.env.BENCH_ASSERT_ALIVE_COUNT === '1';
    let aliveCounterChecks = 0;
    for (let i = 0; i < totalTicks; i++) {
      virtualDate += NETWORK.TICK_INTERVAL;
      virtualPerf += NETWORK.TICK_INTERVAL;
      const t0 = hrtimeMs();
      const tickEvents = orch.update(NETWORK.TICK_INTERVAL) as
        | Array<{
            type: string;
            cause?: string;
            x?: number;
            y?: number;
            gridX?: number;
            gridY?: number;
            nextPhaseIndex?: number;
            nextCenterX?: number;
            nextCenterY?: number;
            nextRadius?: number;
          }>
        | undefined;
      tickTimes[i] = hrtimeMs() - t0;
      // MATCH-ARC (ticket 10): bucket this tick under its band (the arc was
      // recomputed inside orch.update from this tick's start-of-tick alive
      // counts — before the eliminations below applied to them).
      const tickBand = bandOf(i + 1);
      // Ticket 10: the drop snapshot — first ACTIVE tick, all bots at spawns.
      if (dropCounts === null && orch.getPhase() === MatchPhase.ACTIVE) {
        dropCounts = new Array<number>(SECTOR_COUNT).fill(0);
        const { alive } = snapshotPlayers(orch);
        for (const p of alive) {
          const { x, y } = p.movement.position;
          dropCounts[sectorIndexOf(x, y)]!++;
          dropTotal++;
          if (
            fortressPx &&
            x >= fortressPx.x0 &&
            x < fortressPx.x1 &&
            y >= fortressPx.y0 &&
            y < fortressPx.y1
          ) {
            compoundDrops++;
          }
        }
      }
      if (assertAliveCounter) {
        const m = orch.getMatch();
        if (m) {
          aliveCounterChecks++;
          if (!m.aliveCountMatchesScan()) {
            throw new Error(
              `alive-counter drift at tick ${i + 1}: maintained=${m.getAlivePlayerCount()} ` +
                `scan=${m.scanAlivePlayerCount()} (server-alive-counter transition not audited)`,
            );
          }
        }
      }
      if (tickEvents) {
        if (captureWallDrops) {
          for (const e of tickEvents) {
            if (e.type !== 'SiegeWallDropped') continue;
            wallDrops.push([i + 1, e.gridX ?? -1, e.gridY ?? -1]);
          }
        }
        // Ticket 09 (DEC-008): the zone target-center sequence — one entry per
        // ZoneWarning telegraph (the next-circle data clients render). Passive
        // read of emitted events; deterministic per seed.
        if (manifestZoneSeed !== undefined) {
          for (const e of tickEvents) {
            if (e.type !== 'ZoneWarning') continue;
            zoneCenterAudit.push({
              phase: e.nextPhaseIndex ?? -1,
              x: e.nextCenterX ?? 0,
              y: e.nextCenterY ?? 0,
              radius: e.nextRadius ?? 0,
            });
          }
        }
        for (const e of tickEvents) {
          if (e.type !== 'PlayerEliminated' || !e.cause) continue;
          // MATCH-ARC (ticket 10): per-band elimination tallies + the early-band
          // killer-archetype join. killedBy/cause join the BotSystem profile
          // labels — read-only, deterministic.
          matchArcAcc.eliminationsByBand[tickBand] =
            (matchArcAcc.eliminationsByBand[tickBand] ?? 0) + 1;
          if (ARC_COMBAT_KILL_CAUSES.has(e.cause)) {
            matchArcAcc.combatKillsByBand[tickBand] =
              (matchArcAcc.combatKillsByBand[tickBand] ?? 0) + 1;
            if (tickBand === 'early') {
              const ev = e as { killedBy?: string };
              const killerArch =
                orch.getBotSystem()?.profiles.get(ev.killedBy ?? '')?.archetypeLabel ?? 'Unknown';
              matchArcAcc.earlyKillsByArchetype[killerArch] =
                (matchArcAcc.earlyKillsByArchetype[killerArch] ?? 0) + 1;
            }
          }
          // Ticket 10: first-60s death-share binning (procedural runs only).
          if (
            manifestSectorTiers &&
            (i + 1) / NETWORK.TICK_RATE <= 60 &&
            e.x !== undefined &&
            e.y !== undefined
          ) {
            deathCounts[sectorIndexOf(e.x, e.y)]!++;
            first60sDeaths++;
          }
          switch (e.cause) {
            case 'siege_crush':
              deathCauses.siege++;
              break;
            case 'zone_damage':
            case 'zone':
            case 'sudden_death':
              deathCauses.zone++;
              break;
            case 'barrel_explosion':
              deathCauses.barrel++;
              break;
            case 'trap_damage':
            case 'trap':
              deathCauses.trap++;
              break;
            case 'melee_hit':
            case 'ranged_hit':
            case 'thrown_hit':
            case 'projectile_hit':
            case 'self_thrown':
              deathCauses.combat++;
              break;
            default:
              deathCauses.other++;
          }
        }
      }
      ticksRun = i + 1;
      if ((i + 1) % sampleEveryTicks === 0) {
        samples.push(sample(orch, i + 1));
        // Accumulate intent-family + movement-diagnostic observations.
        const botSystem = orch.getBotSystem();
        if (botSystem) {
          const { alive } = snapshotPlayers(orch);
          // Build a position array for cluster detection this sample tick.
          const positions: Array<{ id: string; x: number; y: number }> = [];
          for (const p of alive) {
            positions.push({
              id: p.id,
              x: p.movement.position.x,
              y: p.movement.position.y,
            });
          }
          for (const p of alive) {
            const sel = botSystem.selectors.get(p.id);
            if (!sel) continue;
            const fam = intentFamily(sel.currentIntentId);
            intentCounts[fam]++;
            intentObservations++;

            // Idle-with-enemy: armed, has perceived enemy, but NOT engaging.
            const bctx = botSystem.bots.get(p.id);
            if (bctx && bctx.nearestEnemy && fam !== 'engage' && isArmed(p)) {
              idleArmedWithEnemyCount++;
              idleByIntent[fam]++;
            }

            // Clustering: count other alive bots within CLUSTER_RADIUS.
            let neighbors = 0;
            for (const q of positions) {
              if (q.id === p.id) continue;
              const ddx = q.x - p.movement.position.x;
              const ddy = q.y - p.movement.position.y;
              if (ddx * ddx + ddy * ddy < CLUSTER_RADIUS * CLUSTER_RADIUS) neighbors++;
            }
            clusterSamples++;
            if (neighbors >= 1) clusteredCount++;
            if (neighbors >= 2) tightClusteredCount++;
          }
        }
      }
      if (orch.getPhase() === MatchPhase.FINISHED) {
        finished = true;
        break;
      }
    }
    const loopEndReal = realDateNow();
    if (assertAliveCounter) {
      console.log(
        `alive-counter drift check: ${aliveCounterChecks} tick checks, 0 mismatches (maintained == scan)`,
      );
    }

    // Always capture a final sample so a short/early-finish run still reports.
    const finalSample = sample(orch, ticksRun);
    if (samples.length === 0 || samples[samples.length - 1]!.tick !== finalSample.tick) {
      samples.push(finalSample);
    }

    const realDurationMs = loopEndReal - loopStartReal;
    const gameSeconds = ticksRun / NETWORK.TICK_RATE;
    const { alive, all } = snapshotPlayers(orch);

    const tickBudget = computeTickBudget(tickTimes, ticksRun);
    const combat = computeCombatSummary(all);
    const intentDistribution: IntentDistribution =
      intentObservations > 0
        ? {
            engage: intentCounts.engage / intentObservations,
            fleeZone: intentCounts.fleeZone / intentObservations,
            retreat: intentCounts.retreat / intentObservations,
            armUp: intentCounts.armUp / intentObservations,
            loot: intentCounts.loot / intentObservations,
            hunt: intentCounts.hunt / intentObservations,
            wander: intentCounts.wander / intentObservations,
          }
        : {
            engage: 0,
            fleeZone: 0,
            retreat: 0,
            armUp: 0,
            loot: 0,
            hunt: 0,
            wander: 0,
          };
    const movement: MovementDiagnostic =
      clusterSamples > 0
        ? {
            clustering: clusteredCount / clusterSamples,
            tightClusters: tightClusteredCount / clusterSamples,
            idleArmedWithEnemy: idleArmedWithEnemyCount / clusterSamples,
            idleByIntent: {
              engage: 0,
              fleeZone: idleByIntent.fleeZone / clusterSamples,
              retreat: idleByIntent.retreat / clusterSamples,
              armUp: idleByIntent.armUp / clusterSamples,
              loot: idleByIntent.loot / clusterSamples,
              hunt: idleByIntent.hunt / clusterSamples,
              wander: idleByIntent.wander / clusterSamples,
            },
          }
        : {
            clustering: 0,
            tightClusters: 0,
            idleArmedWithEnemy: 0,
            idleByIntent: {
              engage: 0,
              fleeZone: 0,
              retreat: 0,
              armUp: 0,
              loot: 0,
              hunt: 0,
              wander: 0,
            },
          };
    const placements = computePlacements(all, orch.getBotSystem()?.profiles);
    // Ticket 10: fill the drop/death distribution audit (procedural runs only
    // — dropCounts stays null on demo runs or if the match never went ACTIVE).
    generationManifest.distribution =
      dropCounts && manifestSectorTiers
        ? {
            dropShareBySector: dropCounts.map((c) => (dropTotal > 0 ? c / dropTotal : 0)),
            first60sDeathShareBySector: deathCounts.map((c) =>
              first60sDeaths > 0 ? c / first60sDeaths : 0,
            ),
            compoundDropShare: dropTotal > 0 ? compoundDrops / dropTotal : 0,
            dropTotal,
            first60sDeaths,
          }
        : null;
    const skillSummaries = orch.getBotSystem()?.getSkillSummaries(ticksRun) ?? new Map();
    const skill = computeSkillSummary(skillSummaries) ?? {
      avgOverall: 0,
      avgCombat: 0,
      avgSurvival: 0,
      avgEconomy: 0,
      avgPositioning: 0,
      avgDecision: 0,
      tierDistribution: {},
      topBots: [],
      weakestDimension: 'unknown',
      weakestScore: 0,
      botsWithPickupAttempts: 0,
      botsEverArmed: 0,
    };
    // Believability telemetry + AI-time (DEC-013 ticket 01): the per-bot
    // summaries joined with the profile labels (archetype + difficulty) for
    // the cuts; the BotSystem's own wall-clock percentile summary for the
    // AI-time block (masked — see the harness header).
    const believability = computeBelievabilityTelemetry(
      skillSummaries,
      orch.getBotSystem()?.profiles,
    );
    const aiTime = orch.getBotSystem()?.getAiTimePercentiles() ?? emptyAiTimeMetrics();
    // Enforced AI budget + LOD telemetry (bot-ai-v2 ticket 11, DEC-012): the
    // guard's FAIL surface (masked wall-clock) + the deterministic LOD block.
    const aiBudget = orch.getBotSystem()?.getAiBudgetSummary?.() ?? emptyAiBudgetMetrics();
    const lodTelemetry = orch.getBotSystem()?.getLodTelemetry?.() ?? emptyLodTelemetryMetrics();
    // Stimulus telemetry (bot-ai-v2 ticket 03): per-type delivery counters of
    // the domain-event → hearing-radius fan-out. Deterministic observation.
    const stimulus = orch.getBotSystem()?.getStimulusDeliverySummary() ?? emptyStimulusTelemetry();
    // MATCH-ARC telemetry finalization (ticket 10): kills-per-minute per band
    // (combat kills over band-active minutes) + the denominator snapshot. The
    // per-sample band fields on samples[] complete the timeline.
    const matchArc = matchArcAcc;
    for (const band of ['early', 'mid', 'late'] as const) {
      const minutes = (matchArc.bandTicks[band] ?? 0) / NETWORK.TICK_RATE / 60;
      matchArc.killsPerMinuteByBand[band] =
        minutes > 0 ? (matchArc.combatKillsByBand[band] ?? 0) / minutes : -1;
    }
    matchArc.totalPlayers = orch.getMatch()?.players.size ?? 0;

    return {
      config: {
        botFillTo,
        botDifficulty: difficulty,
        mapType,
        seed,
        durationSeconds,
        sampleEverySeconds,
        lastStandingThreshold,
        spawnTimeoutSeconds,
        difficultyMix: botManager ? 'bench-wide-mix' : 'room-default',
      },
      samples,
      ticksRun,
      finished,
      finalPhase: orch.getPhase(),
      realDurationMs,
      speedup: realDurationMs > 0 ? gameSeconds / (realDurationMs / 1000) : 0,
      simulationMetrics: orch.getSimulation().getMetrics(),
      tickBudget,
      combat,
      intentDistribution,
      movement,
      placements,
      deathCauses,
      skill,
      believability,
      aiTime,
      aiBudget,
      lodTelemetry,
      stimulus,
      matchArc,
      generationManifest,
      finalSnapshot: {
        aliveBots: finalSample.aliveBots,
        armedBots: finalSample.armedBots,
        avgHealth: finalSample.avgHealth,
        totalKills: finalSample.totalKills,
        aliveBotIds: alive.map((p) => p.id),
      },
      ...(captureWallDrops ? { wallDrops } : {}),
      timestamp: new Date().toISOString(),
    };
  } finally {
    // 7. Restore real time, the room interval gate, and the seeded sim RNG so
    //    post-benchmark logging / cleanup and any later runs behave normally.
    releaseRoomIntervalGate();
    globalThis.Date.now = savedDateNow;
    installPerfNow(savedPerfNow);
    uninstallSeededSimRandom();
  }
}

/** Render a benchmark result as a compact human-readable summary. */
export function formatSummary(result: BenchmarkResult): string {
  const c = result.config;
  const f = result.finalSnapshot;
  const b = result.tickBudget;
  const combat = result.combat;
  const lines: string[] = [];
  lines.push('=== Bot AI Benchmark ===');
  lines.push(
    `config: ${c.botFillTo} bots (${c.botDifficulty}), map=${c.mapType}, seed=${c.seed}, ` +
      `duration=${c.durationSeconds}s@${c.sampleEverySeconds}s samples, lastStanding=${c.lastStandingThreshold}`,
  );
  lines.push(
    `ran ${result.ticksRun} ticks (${(result.ticksRun / NETWORK.TICK_RATE).toFixed(1)}s game-time) ` +
      `in ${(result.realDurationMs / 1000).toFixed(2)}s real (${result.speedup.toFixed(1)}x speedup) ` +
      `-> ${MatchPhase[result.finalPhase]}${result.finished ? ' (finished)' : ''}`,
  );
  // Generation manifest v1 (map-redesign ticket 02) — the map's tier pyramid
  // + per-match hot sector for this seed. Ticket 03 appends the designation;
  // ticket 04 appends the landmark audit fields.
  const gm = result.generationManifest;
  if (gm.counts) {
    lines.push(
      `generation: tiers HOT=${gm.counts.hot} WARM=${gm.counts.warm} COLD=${gm.counts.cold}, ` +
        `hot sector (${gm.hotSector?.row ?? '?'},${gm.hotSector?.col ?? '?'})` +
        (gm.designation ? `, designation "${gm.designation}"` : ''),
    );
    if (gm.heroCompositionIds) {
      lines.push(
        `landmarks: rare=${gm.rareLandmarkCount ?? 0}/${gm.heroCompositionIds.flat().length}, ` +
          `minors=${gm.minorLandmarkCount ?? 0}`,
      );
    }
    // Ticket 10 (DEC-009): fairness + distribution audit lines.
    if (gm.spawnRepairs !== null) {
      lines.push(
        `fairness: repairs=${gm.spawnRepairs}, attempts=${gm.generationAttempts}, ` +
          `maxRatio weapon=${gm.equityMaxRatio?.weapon.toFixed(2) ?? '?'} ` +
          `chest=${gm.equityMaxRatio?.chest.toFixed(2) ?? '?'} ` +
          `clump=${gm.equityMaxRatio?.clump.toFixed(2) ?? '?'} ` +
          `hot=${gm.equityMaxRatio?.hot.toFixed(2) ?? '?'}`,
      );
    }
    const dist = gm.distribution;
    if (dist) {
      const fmt = (shares: number[]): string =>
        shares.map((s) => (s * 100).toFixed(0).padStart(2)).join(' ');
      lines.push(
        `distribution: drop%=[${fmt(dist.dropShareBySector)}] (${dist.dropTotal} drops), ` +
          `death60s%=[${fmt(dist.first60sDeathShareBySector)}] (${dist.first60sDeaths} deaths), ` +
          `compoundDrop=${(dist.compoundDropShare * 100).toFixed(1)}%`,
      );
    }
  } else {
    lines.push('generation: no tier manifest (non-procedural map)');
  }
  lines.push(
    '  second | phase            | arc   | alive | armed | avgHP | kills | engage% | flee%',
  );
  for (const s of result.samples) {
    lines.push(
      `  ${String(s.second).padStart(6)} | ${MatchPhase[s.phase].padEnd(16)} | ` +
        `${s.arcBand.padEnd(5)} | ` +
        `${String(s.aliveBots).padStart(5)} | ${String(s.armedBots).padStart(5)} | ` +
        `${String(s.avgHealth).padStart(5)} | ${String(s.totalKills).padStart(5)} | ` +
        `${(s.engageFraction * 100).toFixed(0).padStart(7)}% | ` +
        `${(s.fleeFraction * 100).toFixed(0).padStart(5)}%`,
    );
  }
  lines.push(
    `final: ${f.aliveBots} alive, ${f.armedBots} armed, avgHP ${f.avgHealth}, ${f.totalKills} kills`,
  );
  // Intent distribution — the aggression diagnostic. engage should dominate
  // during fights; flee/retreat should be rare. A bot pool spending most of
  // its time in wander/loot with low engage is passive.
  const id = result.intentDistribution;
  lines.push(
    `intents: engage=${(id.engage * 100).toFixed(1)}% fleeZone=${(id.fleeZone * 100).toFixed(1)}% ` +
      `retreat=${(id.retreat * 100).toFixed(1)}% armUp=${(id.armUp * 100).toFixed(1)}% ` +
      `loot=${(id.loot * 100).toFixed(1)}% hunt=${(id.hunt * 100).toFixed(1)}% ` +
      `wander=${(id.wander * 100).toFixed(1)}%`,
  );
  // Movement diagnostics — clustering (flocking/piling) and idle-with-enemy.
  // Low clustering = bots spread out; low idle = armed bots with enemies fight.
  const md = result.movement;
  lines.push(
    `movement: cluster=${(md.clustering * 100).toFixed(1)}% ` +
      `tightCluster(3+)${(md.tightClusters * 100).toFixed(1)}% ` +
      `idleArmedWithEnemy=${(md.idleArmedWithEnemy * 100).toFixed(1)}%`,
  );
  if (md.idleArmedWithEnemy > 0) {
    const ib = md.idleByIntent;
    lines.push(
      `  idle breakdown: loot=${(ib.loot * 100).toFixed(1)}% ` +
        `fleeZone=${(ib.fleeZone * 100).toFixed(1)}% armUp=${(ib.armUp * 100).toFixed(1)}% ` +
        `hunt=${(ib.hunt * 100).toFixed(1)}% wander=${(ib.wander * 100).toFixed(1)}% ` +
        `retreat=${(ib.retreat * 100).toFixed(1)}%`,
    );
  }
  // Tick budget — the 16ms / 60fps hard constraint.
  const budgetOk = b.p99Ms <= b.budgetMs;
  lines.push(
    `tick budget: P50=${b.p50Ms.toFixed(2)}ms P95=${b.p95Ms.toFixed(2)}ms ` +
      `P99=${b.p99Ms.toFixed(2)}ms max=${b.maxMs.toFixed(2)}ms ` +
      `(>16ms: ${b.ticksOverBudget} ticks) ${budgetOk ? '[PASS]' : '[OVER BUDGET]'}`,
  );
  // Combat quality.
  lines.push(
    `combat: ${combat.totalKills} kills, ${combat.totalDamageDealt} dmg dealt / ` +
      `${combat.totalDamageTaken} taken (ratio ${combat.dmgRatio.toFixed(2)}), ` +
      `${combat.avgKillsPerBot.toFixed(2)} kills/bot, ${combat.avgItemsPerBot.toFixed(1)} items/bot`,
  );
  // Death-cause breakdown.
  const dc = result.deathCauses;
  const totalDeaths = dc.siege + dc.zone + dc.barrel + dc.trap + dc.combat + dc.other;
  lines.push(
    `deaths: ${totalDeaths} total — siege=${dc.siege} zone=${dc.zone} barrel=${dc.barrel} ` +
      `trap=${dc.trap} combat=${dc.combat} other=${dc.other}`,
  );
  // Skill evaluation.
  const sk = result.skill;
  const tierStr = Object.entries(sk.tierDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([tier, count]) => `${tier}=${count}`)
    .join(' ');
  lines.push(
    `skill: avg=${sk.avgOverall.toFixed(1)} | ` +
      `combat=${sk.avgCombat.toFixed(1)} survival=${sk.avgSurvival.toFixed(1)} ` +
      `economy=${sk.avgEconomy.toFixed(1)} positioning=${sk.avgPositioning.toFixed(1)} ` +
      `decision=${sk.avgDecision.toFixed(1)} | ` +
      `weakest=${sk.weakestDimension}(${sk.weakestScore.toFixed(1)})`,
  );
  lines.push(`  tiers: ${tierStr}`);
  lines.push(`  economy: armed=${sk.botsEverArmed} pickupAttempts=${sk.botsWithPickupAttempts}`);
  if (sk.topBots.length > 0) {
    lines.push(
      '  skill top: ' +
        sk.topBots
          .map((b) => `${b.playerId.slice(-4)}(${b.overall.toFixed(1)} ${b.tier})`)
          .join(' | '),
    );
  }
  // Believability telemetry (DEC-013 ticket 01) — reaction latency, stalls,
  // action diversity, idle, path efficiency + the archetype/difficulty cuts.
  const bv = result.believability.overall;
  const fmtHist = (buckets: number[]): string => buckets.join(' ');
  lines.push(
    `believability: entropy=${bv.avgIntentEntropy.toFixed(3)} idle=${(bv.avgIdleRatio * 100).toFixed(1)}% ` +
      `stuck=${(bv.avgStuckTimeRatio * 100).toFixed(1)}% pathEff=${bv.avgPathEfficiency.toFixed(3)}`,
  );
  lines.push(
    `  stalls: suspensions=${bv.suspensions} forcedWander=${bv.forcedWanderActivations} ` +
      `byFamily=${
        Object.entries(bv.suspensionsByFamily)
          .sort((a, b) => b[1] - a[1])
          .map(([f, n]) => `${f}=${n}`)
          .join(' ') || '(none)'
      }`,
  );
  lines.push(
    `  actions: dash=${bv.dashTotal} throw=${bv.throwTotal} switch=${bv.switchTotal} | ` +
      `dashReasons=${
        Object.entries(bv.dashByReason)
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r}=${n}`)
          .join(' ') || '(none)'
      }`,
  );
  lines.push(
    `  latency dmg->state: stimuli=${bv.damageResponse.stimuli} resp=${bv.damageResponse.responded} ` +
      `cens=${bv.damageResponse.censored} avg=${bv.damageResponse.avgTicks.toFixed(1)}t ` +
      `hist=[${fmtHist(bv.damageResponse.buckets)}]`,
  );
  lines.push(
    `  latency seen->attack: stimuli=${bv.seenToAttack.stimuli} resp=${bv.seenToAttack.responded} ` +
      `cens=${bv.seenToAttack.censored} avg=${bv.seenToAttack.avgTicks.toFixed(1)}t ` +
      `hist=[${fmtHist(bv.seenToAttack.buckets)}]`,
  );
  // Believed-state telemetry (bot-ai-v2 ticket 05, DEC-003).
  lines.push(
    `  beliefs: writes=${bv.beliefWritesTotal} ` +
      `sourceMix=seen:${bv.beliefWritesBySource.seen ?? 0} ` +
      `heard:${bv.beliefWritesBySource.heard ?? 0} damage:${bv.beliefWritesBySource.damage ?? 0}`,
  );
  lines.push(
    `  pursuits: started=${bv.pursuitsStarted} reacquired=${bv.pursuitsReacquired} ` +
      `dropped=${bv.pursuitsDropped}`,
  );
  for (const [arch, agg] of Object.entries(result.believability.byArchetype).sort()) {
    lines.push(
      `  archetype[${arch}]: n=${agg.bots} entropy=${agg.avgIntentEntropy.toFixed(3)} ` +
        `idle=${(agg.avgIdleRatio * 100).toFixed(1)}% stuck=${(agg.avgStuckTimeRatio * 100).toFixed(1)}% ` +
        `speedCv=${agg.avgSpeedCv.toFixed(3)} stopped=${(agg.avgStoppedTickRatio * 100).toFixed(1)}% ` +
        `dash=${agg.dashTotal} dmgResp=${agg.damageResponse.responded}`,
    );
  }
  for (const [diff, agg] of Object.entries(result.believability.byDifficulty).sort()) {
    lines.push(
      `  difficulty[${diff}]: n=${agg.bots} entropy=${agg.avgIntentEntropy.toFixed(3)} ` +
        `reactAvg=${agg.reactionLatency.avgTicks.toFixed(1)}t ` +
        `sightAvg=${agg.seenToAttack.avgTicks.toFixed(1)}t ` +
        `idle=${(agg.avgIdleRatio * 100).toFixed(1)}% pathEff=${agg.avgPathEfficiency.toFixed(3)}`,
    );
  }
  // No-clones gate (bot-ai-v2 ticket 08, DEC-009): the quantified
  // distinctness of the cuts — intent-mix TVD per archetype pair, reaction
  // latency TVD per difficulty pair, movement-feature eta-squared.
  const nc = result.believability.noClones;
  lines.push(
    `  no-clones: intentTvdMax=${nc.archetypeIntentTvdMax.toFixed(3)} ` +
      `reactTvdMax=${nc.difficultyReactionTvdMax.toFixed(3)} ` +
      `speedCvEta2=${nc.movementSpeedCvEtaSq.toFixed(3)} ` +
      `stoppedEta2=${nc.movementStoppedEtaSq.toFixed(3)} (n=${nc.movementSamples}) ` +
      `mix=${result.config.difficultyMix}`,
  );
  // AI-time percentiles (wall-clock — masked in the determinism contract).
  const at = result.aiTime;
  lines.push(
    `ai-time (BotSystem/tick): P50=${at.p50Ms.toFixed(2)}ms P95=${at.p95Ms.toFixed(2)}ms ` +
      `P99=${at.p99Ms.toFixed(2)}ms max=${at.maxMs.toFixed(2)}ms (${at.samples} samples)`,
  );
  // Enforced AI budget (bot-ai-v2 ticket 11, DEC-012): the ≤4 ms GDD target,
  // relief tallies, and the sustained-overrun FAIL gate. Relief is
  // deterministic-inert under the virtual clock (all ticks level 0) — non-
  // zero relief rows here would mean the guard read a non-virtualized clock.
  const ab = result.aiBudget;
  const aiBudgetOk = ab.p95Ms <= ab.targetMs && !ab.sustainedOverrun;
  lines.push(
    `ai-budget: target=${ab.targetMs}ms P50=${ab.p50Ms.toFixed(2)}ms P95=${ab.p95Ms.toFixed(2)}ms ` +
      `P99=${ab.p99Ms.toFixed(2)}ms over=${ab.ticksOverBudget} ticks ` +
      `(worst run ${ab.maxConsecutiveOverrunTicks}/${ab.sustainedOverrunTicks}) ` +
      `relief=[none:${ab.reliefTicksByLevel[0]} t2:${ab.reliefTicksByLevel[1]} ` +
      `t1:${ab.reliefTicksByLevel[2]} t0:${ab.reliefTicksByLevel[3]}] ` +
      `${aiBudgetOk ? '[PASS]' : '[FAIL: AI budget]'}`,
  );
  // LOD telemetry (ticket 11): tier shares + think skips + immediate combat
  // upgrades (deterministic observation — byte-identity covered).
  const lt = result.lodTelemetry;
  const ltTotal = lt.tierBotTicks.reduce((a, b) => a + b, 0);
  lines.push(
    `lod: T0=${(lt.tierShare[0]! * 100).toFixed(1)}% T1=${(lt.tierShare[1]! * 100).toFixed(1)}% ` +
      `T2=${(lt.tierShare[2]! * 100).toFixed(1)}% of ${ltTotal} bot-ticks | ` +
      `think exec=${lt.thinkTicksExecuted} skipped=${lt.thinkTicksSkipped} | ` +
      `combatUpgrades=${lt.combatTierUpgrades}`,
  );
  // Stimulus deliveries (bot-ai-v2 ticket 03): non-zero = the domain-event →
  // hearing-radius fan-out is wired end-to-end.
  const st = result.stimulus;
  lines.push(
    `stimulus: delivered=${st.deliveredTotal} fights=${st.fightMemoryWrites} ` +
      `byType=${
        Object.entries(st.deliveredByType)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`)
          .join(' ') || '(none)'
      }`,
  );
  // Match-arc telemetry (bot-ai-v2 ticket 10, DEC-011): band timeline +
  // kills-per-minute curve by phase band + the early-killer archetype join.
  const ma = result.matchArc;
  const bandSummary = (['early', 'mid', 'late'] as const)
    .filter((b) => (ma.bandTicks[b] ?? 0) > 0)
    .map(
      (b) =>
        `${b}: ${Math.round((ma.bandTicks[b] ?? 0) / NETWORK.TICK_RATE)}s @k${ma.killsPerMinuteByBand[b]?.toFixed(2) ?? '-1'}/min (${ma.combatKillsByBand[b] ?? 0} kills)`,
    )
    .join(' | ');
  lines.push(
    `matchArc: ${bandSummary || '(no bands)'} — earlyKillsByArchetype[${
      Object.entries(ma.earlyKillsByArchetype)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}:${n}`)
        .join(' ') || 'none'
    }] (totalPlayers=${ma.totalPlayers})`,
  );
  // Winner + top-3 (tier-tagged — the placements-span-tiers gate's at-a-glance
  // view; the JSON's per-placement difficulty field is the authoritative one).
  const top3 = result.placements.slice(0, 3);
  if (top3.length > 0) {
    const winner = top3[0]!;
    lines.push(
      `winner: ${winner.playerId} (${winner.difficulty ?? '?'} tier, ${winner.kills} kills, ${winner.damageDealt} dmg${winner.alive ? ', alive' : ', dead'})`,
    );
    lines.push(
      '  top3: ' +
        top3
          .map(
            (p) =>
              `#${p.placement} ${p.playerId}[${p.difficulty ?? '?'}](k=${p.kills},d=${p.damageDealt})`,
          )
          .join(' | '),
    );
  }
  return lines.join('\n');
}
