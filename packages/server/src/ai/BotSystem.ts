import { TileType } from '@sector-battle/shared';
import type { GameMatch } from '../domain/aggregates/GameMatch.ts';
import type { GameEvent } from '../domain/events/index.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import { WorldSnapshot } from './WorldSnapshot.ts';
import { MAX_PLAYERS } from './WorldSnapshotTypes.ts';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import type { Vec2 } from './BotContext.ts';
import { BotContext } from './BotContext.ts';
import { BotSkillTracker, computeProfile, type SkillProfile } from './BotSkillTracker.ts';
import { buildPersonality, type DifficultyLevel } from './intent/PersonalityProfile.ts';
import { MOVEMENT_PROFILES } from './skill/MovementProfileTables.ts';
import { createMovementSignature } from './skill/BotMovementSignature.ts';
import { restrictionsFor } from './skill/RestrictionTables.ts';
import { IntentSelector } from './intent/IntentSelector.ts';
import { buildPhase2Intents } from './intent/intents.ts';
import type { ZoneFeed } from './WorldSnapshotZone.ts';
//
// Collaborator modules (all behavior-preserving extractions — each function
// body is byte-identical to the original method, with `this.` → `system.`).
//
import type { StimulusDeliverySummary, StimulusRouter } from './stimulus/StimulusRouter.ts';
import { createStimulusRouterFor } from './BotSystemRouterWiring.ts';
import { BotReactor } from './reactor/BotReactor.ts';
import type { ItemClaim } from './combat/ItemContests.ts';
import type { CombatHotspotMemory } from './TickBlackboard.ts';
import { createMacroGoalState, type MacroGoalState } from './goal/GoalGenerator.ts';
import type { MapIdentityView } from './goal/GoalTypes.ts';
import { computeMatchArc, type MatchArcState } from './arc/MatchArc.ts';
import { botSystemTick } from './BotSystemTick.ts';
import {
  buildAiBudgetSummary,
  buildLodTelemetry,
  computePercentilesFromSamples,
  createAiBudgetGuardState,
  type AiBudgetSummary,
  type AiTimePercentiles,
  type LodTelemetry,
} from './lod/AiBudgetGuard.ts';

export type { AiTimePercentiles };

/**
 * BotSystem is now the ORCHESTRATOR. All domain logic has been moved into
 * focused collaborator modules (BotZoneSafety, BotSpatialIndex, BotTelemetry,
 * BotTickUtilities, BotCombatExecutors, BotEconomyExecutors,
 * BotRoamExecutors, BotTickDriver) as `system`-taking
 * module functions. The class owns the shared STATE (fields) + the LIFECYCLE
 * (register/tick/dispose) and delegates the per-tick work. Per-tick bot
 * COORDINATION state lives on the TickBlackboard constructed fresh at the
 * top of tick() and threaded explicitly through the phases/executors
 * (ticket 35); only true lifecycle state, slow-cycling maps, and the
 * persistent fight-memory carrier (bb.hotspot, written by the
 * StimulusRouter since bot-ai-v2 ticket 03 — BotCombatCoordinator was
 * retired with it) remain on the class.
 *
 * Public API is byte-identical to the pre-refactor class: registerBot,
 * unregisterBot, setDefaultDifficulty, tick, dispose, getSkillSummaries,
 * setTelemetry. Behavior is provably preserved by construction (every moved
 * body is verbatim modulo `this.` → `system.`).
 */
export class BotSystem {
  bots: Map<string, BotContext> = new Map();
  readonly match: GameMatch;
  readonly entityMaps: ReturnType<GameMatch['getState']>;
  readonly pathfinder: Pathfinder;
  readonly worldSnapshot: WorldSnapshot;
  /** The per-tick input accumulator (cleared+refilled by botSystemTick).
   *  Public-by-design like the other collaborator-facing fields (see the
   *  class NOTE) — the BotSystemTick partial owns the loop that fills it. */
  readonly tickInputs: QueuedInput[] = [];
  mapCenter: Vec2 = { x: 0, y: 0 };
  mapWidth = 0;
  mapHeight = 0;
  destructibleMap: Map<number, number> = new Map();
  /**
   * Parallel to destructibleMap: real world-space centroid of each
   * destructible's SAT collider polygon (keyed packGridKey(gx, gy), see
   * BotDestructibles.ts). The bot's aim
   * uses this instead of tile-center so its swing aligns with the server's
   * SAT contact test — destructible colliders are artist-authored polygons
   * frequently off-center, and aiming at tile-center misses ~88% of the time.
   * Built from the collision service's enriched atlas each grid-sync.
   */
  destructibleCentroidMap: Map<number, { x: number; y: number }> = new Map();

  /** Per-bot skill telemetry. Created on register, kept after death so dead
   *  bots still get scored on their full match contribution. */
  readonly skillTrackers: Map<string, BotSkillTracker> = new Map();

  /** Per-bot personality profile (deterministic from playerId + difficulty).
   *  The legacy bot ran one decision cascade identically for all 64 bots; this
   *  is what makes them differ (aggression/greed/caution/opportunism/trapper
   *  weights + skill knobs driven by the previously-dead difficulty field). */
  readonly profiles: Map<string, import('./intent/PersonalityProfile.ts').PersonalityProfile> =
    new Map();
  /** Per-bot intent selector — the single decision point that drives the
   *  canonical intent cascade (ADR-0030/0031/0036). Holds the bot's current
   *  committed intent + its commit deadline (hysteresis). */
  readonly selectors: Map<string, IntentSelector> = new Map();
  /** Default difficulty for new bots. Finally consumed by the intent layer
   *  (was dead in the legacy system — BotManager stored it but nothing read it). */
  defaultDifficulty: DifficultyLevel = 'hard';

  /** Global room-state vision is on the WorldSnapshot: `worldSnapshot.aliveBotCount`
   *  is maintained inline by the player sync pass (syncWorldPlayers) — it feeds
   *  the endgame WIN_SEEK heuristic, per-context globalThreatLevel and the
   *  IntentContext. (The old population-centroid field was removed in favor of
   *  per-bot radial spread around the zone-safe center — HUNT Priority-3 —
   *  because it caused the dominant "flock-to-one-location" bug.) */

  /**
   * Persistent cross-tick FIGHT MEMORY (bot-ai-v2 ticket 03, DEC-002). The
   * per-tick coordination state (hunter counts, claimed items, convergence
   * saturation count, zone lethality) is built fresh each tick() on the
   * TickBlackboard — but the fight memory has a 20s window
   * (HOTSPOT_MEMORY_TICKS) with age-based expiry and is NEVER reset per
   * tick, so it lives here as a persistent object that each tick's
   * blackboard carries BY REFERENCE (`bb.hotspot`).
   *
   * Stimulus-driven since ticket 03: the ONE writer is the StimulusRouter
   * (attack + explosion stimuli — StimulusFightMemory.writeFightMemory),
   * which replaced the retired polling writers (recordGunfireHotspot's
   * whole-map gunfire scan and contributeCombatHotspot's per-sighting
   * write). HUNT bots still read `bb.hotspot` unchanged. See
   * StimulusFightMemory.ts for the preserved write guards.
   */
  readonly combatHotspot: CombatHotspotMemory = { x: 0, y: 0, tick: -9999 };

  /**
   * PERSISTENT cross-tick ITEM CLAIMS (bot-ai-v2 ticket 09, DEC-010.5):
   * itemId → {botId, untilTick}. The per-tick blackboard's claimedItems
   * spread stays, but claims now SURVIVE ticks for the claim window (lazily
   * pruned on write — see combat/ItemContests.ts), so two bots can no longer
   * alternate-claim one item across ticks (the audited loot ping-pong).
   */
  readonly itemClaims: Map<string, ItemClaim> = new Map();

  /**
   * Domain-event → hearing-radius stimulus fan-out (bot-ai-v2 ticket 03,
   * DEC-002). Fed by GameOrchestrator.update with the SAME aggregated event
   * stream the network mapper ships to clients (ingestStimulusEvents).
   * Delivers `{type, worldX, worldY, tick, strength}` entries into per-bot
   * bounded queues via one player-grid range query per event; also folds
   * attack/explosion stimuli into {@linkcode combatHotspot}. Stimuli are
   * inert until ticket 04's Reactor — no decision reads them yet.
   */
  readonly stimulusRouter: StimulusRouter;

  /**
   * The per-bot Reactor — the prioritized visible-reaction interrupt layer
   * (bot-ai-v2 ticket 04, DEC-004/DEC-007). Runs every tick AFTER perception,
   * BEFORE executor dispatch (wired in BotTickDriver.tickBot): imminent
   * death > incoming projectile > took-damage startle > heard explosion >
   * enemy windup. A reaction that owns a tick emits its observable queued
   * inputs (turn/move/dash through the same factories as every executor) and
   * skips the intent pipeline for its bounded (≤15 tick) window; the
   * three legacy executor under-fire special cases were retired with it
   * (flinching now happens in ALL intent states). All reaction timing draws
   * route through the per-bot BotRNG (ex-Gaussian latency; GDD §14.2 table
   * values as distribution means) — deterministic, no wall-clock reads.
   */
  readonly reactor: BotReactor;

  /** Barrel density grid — a coarse 8×8 grid where each cell counts how many
   *  barrels are in that sector. Computed once every 30 ticks (shared across
   *  all bots) from the WorldSnapshot. Used by HUNT/WANDER target selection to
   *  route bots toward barrel-sparse sectors, cutting chain-explosion deaths.
   *  A bot that fights in a barrel-dense area is likely to die from an
   *  enemy-triggered chain explosion it can't dodge (same-tick resolution). */
  barrelDensity: Uint8Array = new Uint8Array(64);
  barrelDensityCellSize = 0;
  barrelDensityCols = 8;

  /**
   * Read-only map identity view (ticket 07, DEC-008): sector tiers + POI
   * names + hero-landmark anchors from the map redesign payload — consumed
   * READ-ONLY as loot-goal flavor; null on tier-less maps (demo TMX).
   */
  mapIdentity: MapIdentityView | null = null;

  /**
   * Per-bot macro-goal generator state (ticket 07): the committed strategic
   * goal layer above intents (survives intent churn). Created in
   * registerBot, dropped in unregisterBot; goal-mix telemetry lives on the
   * believability counters (which survive death), not here.
   */
  readonly macroGoals: Map<string, MacroGoalState> = new Map();

  /** MATCH ARC (ticket 10, DEC-011): GDD §14.3 phase weights, per-tick. */
  matchArc: MatchArcState = computeMatchArc(0, 0);

  /** Per-tick BotSystem wall-clock samples (ms), one entry per tick() call —
   *  the raw input of getAiTimePercentiles() and the enforced budget's
   *  sustained-overrun surface (BotSystemTick appends; see AiTimePercentiles
   *  for the determinism/masking contract). Collaborator-facing by design. */
  readonly aiTickTimes: number[] = [];

  /**
   * ENFORCED AI BUDGET + LOD STATE (bot-ai-v2 ticket 11, DEC-012): the guard
   * counters (metric-clock overrun bookkeeping, guard-clock relief tallies)
   * and the deterministic LOD observation counters. See lod/AiBudgetGuard.ts
   * for the two-clock contract.
   */
  readonly aiBudget = createAiBudgetGuardState();

  /** LOD reference scratch (ticket 11): this tick's reference-player
   *  positions + ids (alive humans, else all alive players in all-bot
   *  lobbies), filled in place each tick by collectLodReferences — no
   *  per-tick allocation. */
  readonly lodRefX = new Float64Array(MAX_PLAYERS);
  readonly lodRefY = new Float64Array(MAX_PLAYERS);
  readonly lodRefIds: string[] = Array.from({ length: MAX_PLAYERS }, () => '');
  /** Number of valid scratch entries this tick. */
  lodRefCount = 0;
  /** True when the reference set is the all-bot fallback (self excluded from
   *  distance checks — see LodAssignment.nearestReferenceDistance). */
  lodRefsIncludeBots = false;

  constructor(match: GameMatch, pathfinder: Pathfinder, zoneFeed?: ZoneFeed) {
    this.match = match;
    this.entityMaps = match.getState();
    this.pathfinder = pathfinder;
    // ZONE FEED (perf-arc ticket 17): replaces the retired zoneDataGetter
    // closure over the wire MatchStateProjector — the snapshot sync pass now
    // reads zone state directly from the services each tick (see
    // WorldSnapshotZone.ts). Same reads, same tick ⇒ identical bot-visible
    // values; no feed (undefined) keeps the neutral map-center fallback.
    this.worldSnapshot = new WorldSnapshot(undefined, zoneFeed);
    const grid = match.getGrid();
    const ts = pathfinder.getTileSize();
    this.mapWidth = grid[0]!.length * ts;
    this.mapHeight = grid.length * ts;
    this.mapCenter = { x: this.mapWidth / 2, y: this.mapHeight / 2 };
    this.worldSnapshot.setMapBounds(this.mapWidth, this.mapHeight);
    // Barrel density grid: 8×8 cells across the map. Each cell covers
    // mapWidth/8 ≈ 1280px (10 tiles). This is coarse enough to be cheap
    // (one pass over ~30-60 barrels every 30 ticks) but fine enough to
    // distinguish barrel-dense sectors from sparse ones.
    this.barrelDensityCellSize = this.mapWidth / this.barrelDensityCols;
    // Stimulus router (ticket 03): the deps adapter lives verbatim in
    // BotSystemRouterWiring (length-gate partial, ticket 07) — world-snapshot
    // reads, damage-stimulus → believability forwarding, and the ticket-05
    // believed-state hooks.
    this.stimulusRouter = createStimulusRouterFor(this);
    // Reactor (ticket 04): structural deps adapter — the trackers (reaction
    // telemetry), the pathfinder tile size (siege grid→world math), the map
    // center (safe-direction fallback), and the pathfinder itself (review M1:
    // wall validation on every emitted reaction movement angle — DEC-005.1
    // at the reactor seam). mapCenter is assigned above and never reassigned,
    // so the object reference stays valid.
    this.reactor = new BotReactor({
      skillTrackers: this.skillTrackers,
      getTileSize: () => this.pathfinder.getTileSize(),
      mapCenter: this.mapCenter,
      pathfinder: this.pathfinder,
    });
  }

  registerBot(playerId: string, difficulty?: DifficultyLevel): void {
    const ctx = new BotContext(playerId);
    this.bots.set(playerId, ctx);
    this.stimulusRouter.registerBot(playerId);
    this.reactor.registerBot(playerId);
    this.macroGoals.set(playerId, createMacroGoalState(playerId));
    if (!this.skillTrackers.has(playerId)) {
      this.skillTrackers.set(playerId, new BotSkillTracker());
    }
    // Build the deterministic personality profile + intent selector. The
    // profile is seeded from the bot's own RNG (seeded from playerId at ctx
    // construction) so it's stable across runs. The selector starts with the
    // Phase-2 intent set; Phase 3 swaps in an expanded set with moment intents.
    //
    // PER-BOT DIFFICULTY (bot-ai-v2 ticket 08, DEC-009.1): the caller (the
    // BotManager) passes the difficulty drawn per bot from the lobby's MMR
    // band (GDD §14.6) on the room's seeded stream; the room-wide
    // defaultDifficulty remains the explicit fallback when no draw applies
    // (no-MMR lobbies — the GDD default path). The difficulty selects the
    // skill-knob row AFTER the archetype/jitter draws, so the ctx.rng stream
    // is identical either way.
    const effectiveDifficulty = difficulty ?? this.defaultDifficulty;
    const profile = buildPersonality(ctx.rng, effectiveDifficulty);
    this.profiles.set(playerId, profile);
    this.selectors.set(playerId, new IntentSelector(buildPhase2Intents()));
    // PUBLISHED AT SPAWN (DEC-009.3, consistent all match): the scoped-
    // incompetence restriction set and the archetype movement signature are
    // derived ONCE from the assigned difficulty/archetype and stored on the
    // ctx — nothing recomputes them later.
    ctx.restrictions = restrictionsFor(effectiveDifficulty);
    ctx.movement = createMovementSignature(ctx.rng, MOVEMENT_PROFILES[profile.archetype]);
  }

  /** Set the read-only map identity view for the macro-goal generator
   *  (null / never called = tier-blind AI — every consumer tolerates it). */
  setMapIdentity(view: MapIdentityView | null): void {
    this.mapIdentity = view;
  }

  /** Set the default difficulty for subsequently-registered bots. Finally
   *  consumed by the personality profile (was dead in the legacy system). */
  setDefaultDifficulty(difficulty: DifficultyLevel): void {
    this.defaultDifficulty = difficulty;
  }

  unregisterBot(playerId: string): void {
    this.bots.delete(playerId);
    this.stimulusRouter.unregisterBot(playerId);
    this.reactor.unregisterBot(playerId);
    this.macroGoals.delete(playerId);
    // NOTE: skill tracker is intentionally KEPT here. unregisterBot fires on
    // bot death/removal mid-match, but we still want the bot scored over its
    // full contribution at match end. Trackers are cleared only in dispose().
    // Profiles/selectors are cheap to drop; they're per-living-bot only.
    this.profiles.delete(playerId);
    this.selectors.delete(playerId);
  }

  dispose(): void {
    this.bots.clear();
    this.stimulusRouter.clearStates();
    this.reactor.clearStates();
    this.macroGoals.clear();
    this.itemClaims.clear(); // ticket 09: persistent claims die with the match
    this.skillTrackers.clear();
  }

  setTelemetry(_telemetry: unknown): void {}

  /**
   * Fan one aggregated domain-event batch (the exact stream the network
   * mapper ships to clients) out to hearing-range bots as stimuli
   * (GameOrchestrator.update taps this after aggregation). Read-only over
   * `events` — never drains or mutates the stream. `fallbackTick` stamps
   * stimuli from wall-clock-free services that emit `tick: 0` (e.g.
   * ZoneWarning); everything else uses the event's own tick.
   */
  ingestStimulusEvents(events: readonly GameEvent[], fallbackTick: number): void {
    this.stimulusRouter.ingest(events, fallbackTick);
  }

  /** Stimulus delivery counters for the benchmark JSON (ticket 03). */
  getStimulusDeliverySummary(): StimulusDeliverySummary {
    return this.stimulusRouter.getDeliverySummary();
  }

  /**
   * Compute per-bot skill profiles from accumulated telemetry. Called by the
   * benchmark harness at match end. Damage stats are read from the domain
   * Player (the tracker only tallies counters/attack volume to avoid double
   * counting). Bots whose player entity was already removed (e.g. takeover)
   * fall back to the tracker's snapshot if one was captured.
   */
  getSkillSummaries(matchTicks?: number): Map<string, SkillProfile> {
    const result = new Map<string, SkillProfile>();
    const match = this.match;
    const totalTicks = matchTicks ?? match.currentTick;
    for (const [playerId, tracker] of this.skillTrackers) {
      const player = match.getPlayer(playerId);
      const dmgDealt = player ? player.damageDealt : tracker.damageDealtSnapshot;
      const dmgTaken = player ? player.damageTaken : tracker.damageTakenSnapshot;
      const kills = player ? player.kills : tracker.killSnapshot;
      // itemsCollected on the domain Player counts power-ups (health/barrier/
      // speed) only — see PickupPowerUpCommand. Use it as the authoritative
      // pickups-grabbed + powerups-collected count for economy scoring.
      const itemsCollected = player ? player.itemsCollected : 0;
      tracker.pickupsGrabbed = Math.max(tracker.pickupsGrabbed, itemsCollected);
      tracker.powerUpsCollected = itemsCollected;
      const survivalTicks = tracker.deathTick > 0 ? tracker.deathTick : totalTicks;
      result.set(
        playerId,
        computeProfile(tracker, totalTicks, dmgDealt, dmgTaken, kills, survivalTicks),
      );
    }
    return result;
  }

  tick(tick: number): QueuedInput[] {
    // bot-ai-v2 ticket 11: the per-tick pass moved VERBATIM to the
    // BotSystemTick.ts partial (module-length gate) — the only edits are
    // this-references becoming system-references. All per-tick documentation
    // (two clocks, tick blackboard, fight memory, LOD) lives there.
    return botSystemTick(this, tick);
  }

  /** Percentile summary of the per-tick BotSystem wall-clock slice. */
  getAiTimePercentiles(): AiTimePercentiles {
    return computePercentilesFromSamples(this.aiTickTimes);
  }

  /** The enforced-budget summary (DEC-012): percentiles + overrun FAIL
   *  surface + relief tallies. WALL-CLOCK values — the bench JSON masks the
   *  whole block (same class as tickBudget/aiTime). */
  getAiBudgetSummary(): AiBudgetSummary {
    return buildAiBudgetSummary(this.aiBudget, this.getAiTimePercentiles());
  }

  /** Deterministic LOD observation (tier shares, think skips, immediate
   *  combat upgrades) — pure observation of the tick stream, covered by the
   *  same-seed byte-identity gate (NOT masked). */
  getLodTelemetry(): LodTelemetry {
    return buildLodTelemetry(this.aiBudget);
  }

  /**
   * Persistent pathfinder-grid buffers — `syncPathfinderGrid` refreshes their
   * CONTENTS in place instead of reallocating nested arrays on every dirty
   * tick (combat breaks destructibles constantly; the alloc churn was a
   * measurable slice of the AI budget). Same reference is handed to
   * `pathfinder.updateGrid` each time, which is fine — only contents matter.
   */
  private pfWalkable: boolean[][] = [];
  private pfTileGrid: number[][] = [];

  syncPathfinderGrid(): void {
    const grid = this.match.getGrid();
    const rows = grid.length;
    const cols = rows > 0 ? grid[0]!.length : 0;
    const walkable = this.pfWalkable;
    const tileGrid = this.pfTileGrid;
    if (walkable.length !== rows || tileGrid.length !== rows) {
      walkable.length = 0;
      tileGrid.length = 0;
      for (let r = 0; r < rows; r++) {
        walkable[r] = [];
        tileGrid[r] = [];
      }
    }
    for (let r = 0; r < rows; r++) {
      const src = grid[r]!;
      const w = walkable[r]!;
      const t = tileGrid[r]!;
      for (let c = 0; c < cols; c++) {
        const cell = src[c]!;
        w[c] = cell === TileType.EMPTY || cell === TileType.EXIT;
        t[c] = cell;
      }
    }
    this.pathfinder.updateGrid(walkable, tileGrid);
  }
}
