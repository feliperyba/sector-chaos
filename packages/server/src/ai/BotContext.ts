import { WeaponType, type Vec2 } from '@sector-battle/shared';
import { safeGetWeaponDef } from './BotLoadout.ts';
import type { IntentMemoEntry } from './intent/intentHelpers.ts';
import {
  type EnemyInfo,
  type ItemInfo,
  type DangerInfo,
  type HotBarrelInfo,
  type ProjectileInfo,
  type WeaponSlot,
  BotState,
} from './BotContextTypes.ts';
import { hashPhase, hashToSeed, BotRNG } from './BotContextRng.ts';
import { EnemyHistoryRing } from './BotEnemyHistory.ts';
import { BeliefStore } from './belief/BeliefTypes.ts';
import { BotCombatAwareness } from './combat/BotCombatState.ts';
import { StuckLadderState } from './navigation/StuckLadder.ts';
import {
  getBestSlotForDestructibles,
  getBestSlotForDistance,
  getBestSlotForMatchup,
} from './BotContextSlots.ts';
import type { MovementSignatureState } from './skill/BotMovementSignature.ts';
import type { SkillRestrictions } from './skill/RestrictionTables.ts';
import { LodTier, type LodReliefLevel } from './lod/LodTiers.ts';

export { hashPhase, hashToSeed, BotRNG };
export {
  type Vec2,
  type EnemyInfo,
  type ItemInfo,
  type DangerInfo,
  type HotBarrelInfo,
  type ProjectileInfo,
  type WeaponSlot,
  BotState,
};

export class BotContext {
  readonly playerId: string;

  /** Per-bot deterministic RNG. Used for all stochastic AI decisions so the
   *  same bot + game seed always produces the same behavior (eliminates
   *  run-to-run variance in benchmarks). */
  readonly rng: BotRNG;

  state: BotState = BotState.WANDER;
  /** Goal hysteresis: after a state transition the bot is "committed" to the new
   *  state until this tick, during which the IntentSelector's non-survival
   *  transitions are suppressed (prevents intent thrash from input flicker).
   *  Survival overrides always win regardless of the commit window. */
  stateCommittedUntilTick = 0;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facingAngle = 0;
  health = 100;
  maxHealth = 100;
  isAlive = true;
  activeSlot = 0;
  isFreshSpawn = false;
  /** True while this bot has an active BARRIER powerup (invulnerable). Set each
   *  tick from the PlayerDTO; combat uses it to play more aggressively since
   *  incoming damage is negated for the duration. */
  selfBarrierActive = false;

  /**
   * Slot-indexed weapon array (length PLAYER.INVENTORY_SIZE); each entry is the
   * weapon in that server slot, or null. MUST be slot-indexed (not compacted) so
   * `ctx.weapons[ctx.activeSlot]` returns the held weapon — compacting breaks
   * getActiveWeapon (returns FISTS when holding a real weapon) and
   * getBestSlotForDistance (indices point at null server slots → SWITCH_SLOT
   * silently fails). Synced slot-indexed from the PlayerDTO in BotSelfState.
   */
  weapons: (WeaponSlot | null)[] = [];

  enemies: EnemyInfo[] = [];
  items: ItemInfo[] = [];
  dangers: DangerInfo[] = [];
  projectiles: ProjectileInfo[] = [];
  /**
   * Object pools for the per-scan perception DTOs. scanWorld releases the
   * previous scan's objects back here and acquires on the next scan, avoiding
   * ~100-200 short-lived allocations/tick. Pooled objects are never retained
   * across scans.
   */
  enemyPool: EnemyInfo[] = [];
  itemPool: ItemInfo[] = [];
  dangerPool: DangerInfo[] = [];
  projectilePool: ProjectileInfo[] = [];
  /** Reused spawn-expiry map (cleared per scan, not reallocated). */
  spawnExpiryMap: Map<string, number> = new Map();
  /** Barrels near both the bot AND an enemy — enemies can detonate these at any
   *  moment, so the bot must hard-flee their blast radius. Populated each scan. */
  hotBarrels: HotBarrelInfo[] = [];
  /** Barrel density of the bot's current map sector (0-255 barrels per 1280px
   *  cell). Set by BotSystem each tick from the shared density grid. When >2,
   *  the bot is in a barrel-dense area and combat there risks chain explosions. */
  localBarrelDensity = 0;

  nearestEnemy: EnemyInfo | null = null;
  nearestWeapon: ItemInfo | null = null;
  nearestHealth: ItemInfo | null = null;
  nearestChest: ItemInfo | null = null;
  /**
   * Chest this bot is currently channeling an open on. Chest-opening is a 0.5s
   * channeled action that INTERRUPTS if the player moves >8px from start
   * (Chest.tickOpening). The chest vanishes from the WorldSnapshot item list
   * the instant it enters 'opening' state, so without tracking it here the bot
   * would lose sight of it next tick, re-pick a different loot target, move,
   * and interrupt its own open (822 starts / 0 completions before this field).
   * While set, executeLoot emits a PICKUP (no movement) to hold the channel.
   */
  openingChestId: string | null = null;
  openingChestX = 0;
  openingChestY = 0;
  /** Nearest BARRIER powerup (see POWERUP.BARRIER_DURATION). Null if none in scan range. */
  nearestBarrier: ItemInfo | null = null;
  /** Nearest SPEED_BOOST powerup (see POWERUP constants). Null if none in scan range. */
  nearestSpeedBoost: ItemInfo | null = null;

  targetId: string | null = null;
  targetLockTick = 0;
  /** Engagement-progress tracking: a bot stuck in ENGAGE that makes no progress
   *  (neither closes distance nor deals damage) for this many ticks abandons
   *  the target and re-engages elsewhere. Prevents the "orbit an unreachable
   *  enemy through a wall forever" stall that starves combat. */
  engageStartTick = -9999;
  engageStartDist = 0;

  /** Last position + tick an enemy was perceived (legacy sighting memory —
   *  kept for death-cause attribution and pursuit-progress reads; the HUNT
   *  investigation itself chases the richer BELIEF store since bot-ai-v2
   *  ticket 05). */
  lastSeenEnemyX = 0;
  lastSeenEnemyY = 0;
  lastSeenEnemyTick = -9999;

  lastAttackTick = -9999;
  lastDashTick = -9999;
  lastSwitchSlotTick = -9999;

  /** Universal anti-stall: the tick the bot entered its CURRENT state, and the
   *  last tick it made "progress" (attacked, picked up, or took damage). If a
   *  bot has been in the same state for a long time with no progress, it's
   *  stuck in an oscillation loop (moving just enough to defeat displacement-
   *  based stall detection but never achieving its goal). The tickBot state-
   *  timeout forces a full intent re-evaluation to break the loop. Catches ALL
   *  stuck-in-one-state scenarios regardless of which executor is running. */
  stateEnterTick = 0;
  lastProgressTick = 0;

  /** Previous-tick health, for detecting damage taken this tick. Set in
   *  updateSelfState before ctx.health is updated. */
  prevHealth = 0;
  /** Tick this bot last took damage (health decreased). Drives the
   *  "react to being shot" startle. -9999 = never hit. */
  lastDamageTick = -9999;
  /** BELIEVED-STATE (bot-ai-v2 ticket 05, DEC-003 — see belief/BeliefUpdate.ts):
   *  the believed world between perception and executors. In-scan enemies
   *  remain ground truth (ctx.enemies); beliefs cover out-of-scan enemies. */
  readonly beliefs: BeliefStore = new BeliefStore();
  /** Estimated origin of the last damage: the damage-direction belief
   *  (direction + per-bot RNG spread, NEVER the attacker's true coords).
   *  Written by the stimulus router; read by the Reactor's startle. */
  lastDamageBeliefX = 0;
  lastDamageBeliefY = 0;
  lastDamageBeliefTick = -9999;
  /** COMBAT AWARENESS (bot-ai-v2 ticket 09, DEC-010 — see combat/
   *  BotCombatState.ts): the composed per-bot state for the six
   *  combat-believability mechanisms (sticky weave, disengage discretion,
   *  kill-feed memory, recent-damage tracking, item contests, weapon-break
   *  stamp + pending telemetry drains). Class-field-initialized like
   *  `beliefs`; literal-cast unit-test contexts may omit it (every consumer
   *  null-tolerates). */
  readonly combat: BotCombatAwareness = new BotCombatAwareness();
  /** Enemy this bot is INVESTIGATING via its believed position (closed on
   *  re-acquisition or search-failure — BeliefUpdate.enforceSearchFailure). */
  pursuitTargetId: string | null = null;
  pursuitStartTick = -9999;

  /** Per-enemy position history rings (aim prediction input). Bounded by LRU
   *  eviction — see BotEnemyHistory.ts for the ring storage and the cap
   *  justification, and BotContextEnemyHistory.ts for the access discipline
   *  (record/get/clear/prune, extracted verbatim from this class in
   *  bot-ai-v2 ticket 05 to hold the module-length gate). Keyed by enemy
   *  player id. */
  readonly enemyHistory: Map<string, EnemyHistoryRing> = new Map();

  strafeDir = 1;
  strafeUntilTick = 0;

  // ── bot-ai-v2 ticket 08 (DEC-009) per-bot identity carriers ──────────────
  // Both are assigned ONCE at BotSystem.registerBot (published at spawn,
  // consistent all match — the scoped-incompetence contract) and never
  // recomputed. Null on unit-test ctx literals / pre-register contexts; every
  // consumer null-tolerates (neutral fallbacks).
  /** Archetype movement signature (movement-profile data + per-bot state). */
  movement: MovementSignatureState | null = null;
  /** Scoped-incompetence restriction set (weapon-class lock / mid-fight
   *  switch / dash-cancel). Null = unrestricted. */
  restrictions: SkillRestrictions | null = null;
  /** True while this bot's OWN attack windup is active (synced from the DTO
   *  each tick in updateSelfState) — the dash-cancel gate's input. */
  isInOwnWindup = false;
  /** Tick LOS was (re)acquired on {@linkcode losHeldTargetId} (−1 = none).
   *  Written by executeEngageState; read by the fire-discipline first-shot
   *  delay (CombatCapTables). */
  losHeldSinceTick = -1;
  losHeldTargetId: string | null = null;
  /** Shared fight-memory seat view (written every tick in runPerception
   *  from system.combatHotspot) — the movement signature's hotspot-avoidance
   *  input, kept on ctx so navigateTo stays system-free. */
  fightMemoryX = 0;
  fightMemoryY = 0;
  fightMemoryTick = -9999;

  path: Vec2[] | null = null;
  /** Current-waypoint index into {@link path} (perf ticket 30): consumption
   *  advances this cursor instead of shift()-ing — O(1) vs O(L²) element moves,
   *  and shift() mutated the pathfinder-cache array this field can alias. */
  pathCursor = 0;

  /** The ONLY way to assign {@link path} — always resets {@link pathCursor}, so
   *  a repath/abandon can never inherit a stale cursor (wrong waypoint). */
  setPath(path: Vec2[] | null): void {
    this.path = path;
    this.pathCursor = 0;
  }
  pathTargetX: number;
  pathTargetY: number;
  pathRepathTick = 0;
  /** Wall-slide commitment (hysteresis): remembers which side (+/-) the bot is
   *  sliding so it doesn't re-probe ±30/60/90° every tick (which swings the move
   *  angle ±60° between ticks — the "reversing/bouncing" movement). slideCommitTick
   *  is when the commit expires (forces periodic re-evaluation). */
  slideDir = 0;
  slideCommitTick = -9999;

  wanderTargetX = 0;
  wanderTargetY = 0;
  wanderRepathTick = 0;
  /** Arrival-escape for HUNT: tick this bot arrived at its HUNT target but found
   *  no enemy. HUNT won't re-path to the same dead coordinate — falls through to
   *  spread so the bot leaves the dead point instead of orbiting it. */
  huntArrivalTick = -9999;

  /** Goal-stall tracking: a SEEK_WEAPON/LOOT bot wedged against collision geometry
   *  emits move inputs the physics zeroes. Position-based: if the bot hasn't moved
   *  STALL_PROGRESS_PX in STALL_TICKS, force a WANDER to unstick. */
  goalStartTick = -9999;
  goalStartX = 0;
  goalStartY = 0;
  /** Long-window stall tracker: catches micro-oscillation (bot wiggles just
   *  enough to reset the short window but never escapes). <100px in 10s = stuck. */
  longStallStartTick = -9999;
  longStallStartX = 0;
  longStallStartY = 0;
  /** Universal anti-stall position snapshot (every 600 ticks: <300px moved =
   *  force full reset). Separate from longStall which checkGoalStall uses. */
  antiStallSnapTick = -9999;
  antiStallSnapX = 0;
  antiStallSnapY = 0;
  /** Target distance at last anti-stall snapshot. Detects CLOSING progress — a
   *  pursuing bot's net displacement is small but its target distance drops. -1
   *  = no snapshot / no target. */
  antiStallSnapTargetDist = -1;
  /** When > ctx.tick, force WANDER (local roam) to break a geometry stall. */
  forceWanderUntilTick = -9999;
  /** Position where the last goal-suspension fired. While a goal is suspended,
   *  WANDER relocates AWAY from this point so the bot leaves the area before the
   *  suspension expires (else it re-enters the same dead goal in circles). */
  stallEpicenterX = 0;
  stallEpicenterY = 0;
  stallEpicenterTick = -9999;
  /** Item blacklist (itemId → expiry tick). Anti-stall blacklists the bot's
   *  current targets for 30s so it doesn't re-select the same unreachable item
   *  (the LOOT→WANDER→LOOT oscillation). */
  blacklistedItems: Map<string, number> = new Map();
  /** Tick at which the bot's speed first dropped below the combat-demolition
   *  threshold (1.0). Used by the velocity-wedge demolition trigger to require a
   *  PERSISTENT slowdown (≥6 ticks) before diverting into a wall-break mid-combat
   *  — a single-frame strafe slowdown no longer trips it. -9999 = moving fine. */
  lowSpeedSinceTick = -9999;

  /** Last full-inventory weapon PICKUP site — isAtDropSite() skips the bot's
   *  own just-dropped weapon here, breaking the swap-grab loop. */
  lastFullPickupTick = -9999;
  lastFullPickupX = 0;
  lastFullPickupY = 0;
  stuckStartX = 0;
  stuckStartY = 0;
  stuckStartTick = -9999;
  /**
   * STUCK LADDER (bot-ai-v2 ticket 06, DEC-005.2 — see navigation/
   * StuckLadder.ts): the per-bot five-rung anti-stuck state machine
   * (sidestep → back up facing the obstacle → alternate-lane replan →
   * smash-the-blocker → goal suspension + relocation). Owns the visible
   * recovery that replaced the old ±90° unstuck jitter (the
   * stuckUnstuckTick/unstuckDir fields were removed with it).
   */
  readonly ladder = new StuckLadderState();
  /**
   * NAVIGATED RETREAT goal cache (bot-ai-v2 ticket 06, DEC-005.4 — see
   * BotCombatRetreat.refreshRetreatGoal): the pathfinder-backed break-line
   * retreat destination, re-picked every ~30 ticks or when the pursuer
   * moves >120px. retreatGoalTick < 0 = no goal yet.
   */
  retreatGoalX = 0;
  retreatGoalY = 0;
  retreatGoalTick = -9999;
  retreatGoalFromX = 0;
  retreatGoalFromY = 0;

  /** Per-target line-of-sight cache. Combat (executeEngageState) re-checks LOS
   *  every tick it has a target, but LOS is expensive (pathfinder ray cast) and
   *  stable within a few ticks for a stationary-or-slowly-moving engagement.
   *  {@link getCachedLOS} returns the cached result if it's still valid for the
   *  given target within {@link LOS_CACHE_TTL} ticks, else `undefined` signalling
   *  the caller to recompute and store via {@link setCachedLOS}. Centralizing the
   *  validity invariant here (was previously re-derived inline at each call site)
   *  is the one BotContext extraction that passes both the dispatcher test (single
   *  consumer, `tickBot`/`BotTickUtilities` never read it) and the deletion test
   *  (the invariant + write-back concentrate into the methods). Spec 36 §2.1-A. */
  private losCacheTargetId: string | null = null;
  private losCacheTick = -9999;
  private losCacheResult = true;

  /** LOS cache validity window in ticks (~50ms). Within this, a cached LOS result
   *  for the SAME target is reused without recomputation. */
  static readonly LOS_CACHE_TTL = 3;

  /**
   * Return the cached LOS result for `targetId` if it is still valid at `tick`
   * (same target, within {@link LOS_CACHE_TTL}); otherwise `undefined`, signalling
   * the caller to recompute and store the fresh result via {@link setCachedLOS}.
   */
  getCachedLOS(targetId: string, tick: number): boolean | undefined {
    if (this.losCacheTargetId === targetId && tick - this.losCacheTick < BotContext.LOS_CACHE_TTL) {
      return this.losCacheResult;
    }
    return undefined;
  }

  /** Store a freshly-computed LOS result for `targetId` at `tick`. */
  setCachedLOS(targetId: string, tick: number, result: boolean): void {
    this.losCacheTargetId = targetId;
    this.losCacheTick = tick;
    this.losCacheResult = result;
  }

  /**
   * Per-tick memo for intent values (perf ticket 26, extended by 27). Keyed by
   * IntentId (number); each entry records the tick + ic shape it was computed
   * at and the computed value (see intent/intentHelpers.ts `memoizedScan` for
   * the full contract — hit conditions, tick invalidation, purity-window
   * proof, and the ticket-27 ic-shape guard). Entry PRESENCE (with a matching
   * tick + shape) distinguishes "computed null/undefined this tick" from "not
   * yet computed this tick".
   *
   * Lives on the ctx (not the Intent instances) because the ctx is per-bot by
   * construction — one BotContext per playerId — so the memo is per-bot per
   * intent even if intent instances are ever shared. Behavior-preserving proof
   * (the select()→execute() window writes nothing the scans read) is in
   * intentHelpers.ts `memoizedScan`.
   *
   * Lazily attached by `memoizedScan`: unit-test ctx factories build plain
   * object literals (cast to BotContext) that may omit class-initialized
   * fields; a null check keeps those working.
   */
  intentScanMemo: Map<number, IntentMemoEntry> | null = null;

  /**
   * Per-tick cache for `loadoutHasRole` (perf ticket 27). Both roles ('melee'
   * and 'ranged') are derived in ONE pass over ctx.weapons the first time
   * either is queried in a tick; later queries in the same tick — the loot
   * intent's isValid+score collapse AND the economy executor's
   * isWeaponUpgrade role gate — reuse it instead of re-walking the loadout.
   *
   * Soundness (the loadout provably cannot change within a tick):
   *   - ctx.weapons is written exactly once per tick, in BotSelfState.
   *     updateSelfState at tickBot entry — BEFORE intent selection and any
   *     executor runs.
   *   - The whole AI phase for every bot runs BEFORE the simulation applies
   *     any bot input (GameSimulation.step10_BotAI collects all inputs from
   *     botSystem.tick(), then processes pickups/swaps afterwards), so no
   *     pickup/switch can mutate the loadout mid-AI-phase.
   * A hit requires cache.tick === ctx.tick (set once per tick in BotSystem.tick
   * before tickBot), so every tick boundary forces a recompute.
   *
   * Lazily tolerated null/undefined: unit-test ctx factories build plain
   * object literals (cast to BotContext) that may omit class-initialized
   * fields (same contract as intentScanMemo above).
   */
  loadoutRoleCache: { tick: number; melee: boolean; ranged: boolean } | null = null;

  zoneCenterX = 0;
  zoneCenterY = 0;
  zoneRadius = 0;
  /** True while the zone center is actively transitioning (shrinking/moving). */
  zoneIsShrinking = false;
  /** Safe point to head toward during zone flee — pre-positioned toward the
   *  zone's target/next center so the bot doesn't get caught outside mid-shrink. */
  zoneSafeX = 0;
  zoneSafeY = 0;
  zoneSafeRadius = 0;
  /** Zone damage per tick outside the circle (5; 10 sudden death) — the
   *  zone-as-cost HP arithmetic input (bot-ai-v2 ticket 07, DEC-008).
   *  Written every tick by syncZoneState from the zone info. */
  zoneDamagePerTick = 0;

  siegeWarnings: Array<{ x: number; y: number }> = [];

  tick = 0;

  // ── LOD (bot-ai-v2 ticket 11, DEC-012) ────────────────────────────────────
  // Fidelity tier + provenance, recomputed EVERY tick by lod/LodAssignment
  // (pure from positions/engagement — see lod/LodTiers.ts). Defaults are FULL
  // fidelity (T0, no relief) so contexts outside a BotSystem pass (unit-test
  // literals, direct executor calls) keep pre-LOD behavior; the tier value
  // doubles as the A* search-priority class.
  lodTier: LodTier = LodTier.T0;
  lodCombatTier = false;
  /** Budget-relief level for this tick (guard-clock derived; NEVER fires
   *  under the bench harness's virtual clock). */
  lodRelief: LodReliefLevel = 0;
  /** Nearest reference player (human, else other bot) — proximity input. */
  lodNearestRefDist = Infinity;

  demolitionGridX = -1;
  demolitionGridY = -1;
  demolitionTargetX = 0;
  demolitionTargetY = 0;
  demolitionTick = -9999;
  preDemolitionState: BotState = BotState.WANDER;

  constructor(playerId: string) {
    this.playerId = playerId;
    this.rng = new BotRNG(hashToSeed(playerId));
    this.pathTargetX = 0;
    this.pathTargetY = 0;
    // Stagger first repath across PATH_REPATH_TICKS so 60+ bots don't all run
    // A* on the same tick. Stable via deterministic RNG.
    this.pathRepathTick = this.rng.int(0, 20);
    this.wanderRepathTick = this.rng.int(0, 120);
    // Stable per-bot perception scan phase spreads scans evenly across ticks.
    this.perceptionPhase = hashPhase(playerId, 3);
    // LOD stride-9 phase (ticket 11): T2 think/scan cadence staggering — same
    // deterministic id-hash, spread over the 9-tick stride so T2 bots don't
    // all think on the same tick.
    this.perceptionPhase9 = hashPhase(playerId, 9);
  }

  /** Per-bot perception scan phase (0..PERCEPTION_INTERVAL-1). */
  perceptionPhase = 0;
  /** Per-bot stride-9 phase (0..8) — T2 think/scan cadence (ticket 11). */
  perceptionPhase9 = 0;

  /** A weapon with no ammo (durability) is broken — doesn't count as "armed".
   *  Drives SEEK_WEAPON priority so a bot holding only broken weapons re-arms. */
  hasRealWeapon(): boolean {
    return this.weapons.some((w) => w !== null && w.weaponType !== WeaponType.FISTS && w.ammo > 0);
  }

  getActiveWeapon(): WeaponSlot {
    const w = this.weapons[this.activeSlot];
    if (w) return w;
    return { weaponType: WeaponType.FISTS, tier: 0, durability: -1, ammo: 0 };
  }

  getBestSlotForDistance(dist: number): number {
    return getBestSlotForDistance(this, dist);
  }

  /** Pick the best weapon slot for the current MATCHUP (enemy range considered),
   *  not just raw distance. Prefers a weapon that OUTRANGES the enemy while still
   *  reaching the target — a Spear+Dagger bot vs a Dagger enemy picks the Spear
   *  (range advantage) instead of swapping to the shorter weapon. Falls back to
   *  tier ranking when no weapon outranges the enemy.
   *
   *  (Bodies live in BotContextSlots.ts since bot-ai-v2 ticket 08 — the
   *  module-length gate — now carrying the scoped-incompetence class gate.) */
  getBestSlotForMatchup(dist: number, enemyRange: number): number {
    return getBestSlotForMatchup(this, dist, enemyRange);
  }

  /** Pick the best weapon slot for breaking a destructible (see
   *  BotContextSlots.getBestSlotForDestructibles for the scoring rationale). */
  getBestSlotForDestructibles(): number {
    return getBestSlotForDestructibles(this);
  }

  getWeaponRange(type: WeaponType): number {
    return safeGetWeaponDef(type)?.baseStats.range ?? 128;
  }
}
