/**
 * LOD TIERS — bot-ai-v2 ticket 11 (DEC-012.1): fidelity as allocation.
 *
 * Sixty-three lively bots do not fit the GDD §15.3.1b ≤4 ms AI budget at full
 * fidelity, so per-bot fidelity becomes a three-tier ladder assigned EVERY
 * tick from (a) engagement state and (b) distance to the nearest reference
 * player — a HUMAN when any human is alive (the audience's focus), else the
 * nearest OTHER bot (all-bot lobbies — the benchmark):
 *
 *   T0  in combat, or within ~1.5 screens of a reference player — full
 *       cadence: intent think every tick, perception scan stride 3.
 *   T1  mid distance — intent think every 3rd tick (DEC-012 "2-3"),
 *       perception unchanged.
 *   T2  far — intent think every 9th tick (DEC-012 "6-10") with coarse
 *       perception (scan stride stretched 3 → 9).
 *
 * ALWAYS-ON AT EVERY TIER (the no-behavioral-cliff contract): the Reactor,
 * stimulus view refresh/delivery, the per-tick hazard rescan, physics and
 * input submission — bots are players. Tier upgrade on combat entry is
 * IMMEDIATE by construction: the tier is recomputed from this tick's state
 * before the think gate is evaluated, so the very tick a far bot is attacked
 * (damage belief) or perceives an enemy it is T0 and thinks.
 *
 * PURITY / DETERMINISM: every function here is a pure function of its
 * explicit inputs — no RNG, no wall-clock, no allocation-visible state. Tier
 * assignment is therefore deterministic from positions/engagement, which is
 * what keeps the same-seed benchmark byte-identical (DEC-012 validation).
 * The only sanctioned wall-clock read in the AI pass lives in
 * AiBudgetGuard.ts (the budget guard, on the harness-virtualizable clock).
 */

import { PERCEPTION_INTERVAL } from '../BotSystemConstants.ts';

/** The three fidelity tiers. Numeric order = search-priority order (T0's A*
 *  searches are served first — Pathfinder's priority classes use these
 *  values directly). */
export enum LodTier {
  T0 = 0,
  T1 = 1,
  T2 = 2,
}

/** Budget-relief levels (the guard's relief valve, AiBudgetGuard.ts): which
 *  tier's DELIBERATIVE pass is suspended this tick. Higher = more suspended.
 *  Combat-tier T0 is never suspended (fights always think). */
export enum LodReliefLevel {
  NONE = 0,
  SUSPEND_T2 = 1,
  SUSPEND_T1 = 2,
  SUSPEND_T0 = 3,
}

/** One game screen in world px (1920×1080 viewport at zoom 1.0 —
 *  client-v3 main.ts / CameraService). The tier ladder is expressed in
 *  screens so it survives camera changes by editing ONE constant. */
export const LOD_SCREEN_PX = 1920;

/** T0 proximity bound: ~1.5 screens from a reference player (DEC-012). */
export const LOD_T0_MAX_REF_DIST = Math.round(LOD_SCREEN_PX * 1.5); // 2880
/** T1 proximity bound: ~3 screens. Beyond it the bot is T2 (far). */
export const LOD_T1_MAX_REF_DIST = Math.round(LOD_SCREEN_PX * 3); // 5760

/** A perceived enemy within this range puts the bot in a live tactical
 *  situation → combat-tier T0 regardless of reference-player distance (the
 *  "T2 bots still fight when engaged" half of the no-cliff contract; 5 tiles
 *  of 128 px — beyond brawl range, within decision range). */
export const LOD_ENGAGE_ENEMY_RANGE = 640;

/** Damaged within this many ticks → combat-tier T0 (the immediate-upgrade
 *  path for a FAR bot engaged from off-screen: the damage stimulus/belief
 *  lands the same tick the hit resolves, so the next BotSystem.tick — before
 *  the attacker's follow-up — is already full fidelity; covers the Reactor's
 *  ex-Gaussian latency bound of ≤90 ticks with a wide margin). */
export const LOD_COMBAT_ENTRY_DAMAGE_TICKS = 15;

/** T1 intent-think stride (DEC-012 "every 2-3 ticks"). */
export const T1_THINK_STRIDE = 3;
/** T2 intent-think stride (DEC-012 "every 6-10 ticks"). */
export const T2_THINK_STRIDE = 9;
/** T2 perception scan stride — the "coarse perception" half of T2 (the
 *  every-tick hazard rescan is NOT cadenced; only the full scan stretches).
 *  T0/T1 keep the shared PERCEPTION_INTERVAL (3). */
export const T2_SCAN_STRIDE = 9;

/** Inputs of the pure tier assignment. All fields derive deterministically
 *  from the tick stream (positions, committed state, damage events). */
export interface LodAssignmentInputs {
  /** Committed fight state (BotState.ENGAGE / RETREAT) — the selector's own
   *  combat commitment from the last think tick. */
  inFightState: boolean;
  /** Distance (px) to the nearest PERCEIVED enemy, or null when none. */
  nearestEnemyDist: number | null;
  /** ctx.lastDamageTick — tick of the last health drop (−9999 = never). */
  lastDamageTick: number;
  /** Current tick (ages the damage signal). */
  tick: number;
  /** Distance (px) to the nearest reference player (human if any alive,
   *  else nearest other bot). Infinity when alone on the map. */
  nearestReferenceDist: number;
}

/** The pure tier assignment result. */
export interface LodAssignment {
  tier: LodTier;
  /** True when T0 was earned by ENGAGEMENT (not proximity) — engagement-sourced
   *  T0 is exempt from budget relief (fights never stop thinking). */
  combatTier: boolean;
}

/**
 * Assign the LOD tier. PURE — the single decision point of DEC-012.1 and the
 * unit-test seam for tier boundaries + immediate combat upgrade. Evaluation
 * order is load-bearing: engagement first (any distance), then proximity.
 */
export function computeLodTier(inputs: LodAssignmentInputs): LodAssignment {
  const combat =
    inputs.inFightState ||
    (inputs.nearestEnemyDist !== null && inputs.nearestEnemyDist <= LOD_ENGAGE_ENEMY_RANGE) ||
    inputs.tick - inputs.lastDamageTick <= LOD_COMBAT_ENTRY_DAMAGE_TICKS;
  if (combat) return { tier: LodTier.T0, combatTier: true };
  if (inputs.nearestReferenceDist <= LOD_T0_MAX_REF_DIST) {
    return { tier: LodTier.T0, combatTier: false };
  }
  if (inputs.nearestReferenceDist <= LOD_T1_MAX_REF_DIST) {
    return { tier: LodTier.T1, combatTier: false };
  }
  return { tier: LodTier.T2, combatTier: false };
}

/**
 * Budget-relief suspension test (PURE): is this tier's DELIBERATIVE pass
 * (intent think / macro-goal rescore / full perception scan) suspended at the
 * given relief level? Relief never touches the always-on surfaces (Reactor,
 * stimulus, hazards, physics, input submission) — those are not parameters
 * here at all, which is the structural form of that guarantee.
 *
 * T2 is downgraded first (DEC-012's relief order), then T1, then — only at
 * the maximum level — proximity-sourced T0. Combat-tier T0 is NEVER
 * suspended: a fighting bot that stopped thinking would be a behavioral
 * cliff exactly where players are watching.
 */
export function lodDeliberationSuspended(
  tier: LodTier,
  combatTier: boolean,
  relief: LodReliefLevel,
): boolean {
  switch (relief) {
    case LodReliefLevel.NONE:
      return false;
    case LodReliefLevel.SUSPEND_T2:
      return tier === LodTier.T2;
    case LodReliefLevel.SUSPEND_T1:
      return tier === LodTier.T1 || tier === LodTier.T2;
    case LodReliefLevel.SUSPEND_T0:
      return !combatTier;
  }
}

/**
 * Think-cadence test (PURE): does this bot re-score intents this tick?
 * T0 thinks EVERY tick; T1 every {@linkcode T1_THINK_STRIDE}nd tick; T2 every
 * {@linkcode T2_THINK_STRIDE}th. Cadence ticks are staggered per bot via the
 * hashed phases (the same Centaur-style staggering the perception scans use),
 * so think work spreads across ticks instead of spiking. Relief overrides the
 * cadence (a suspended tier never thinks, regardless of stride arithmetic).
 */
export function isThinkTick(
  tier: LodTier,
  combatTier: boolean,
  tick: number,
  phase3: number,
  phase9: number,
  relief: LodReliefLevel,
): boolean {
  if (lodDeliberationSuspended(tier, combatTier, relief)) return false;
  switch (tier) {
    case LodTier.T0:
      return true;
    case LodTier.T1:
      return tick % T1_THINK_STRIDE === phase3 % T1_THINK_STRIDE;
    case LodTier.T2:
      return tick % T2_THINK_STRIDE === phase9 % T2_THINK_STRIDE;
  }
}

/** Full-scan cadence stride for a tier (PURE): T0/T1 keep the shared
 *  PERCEPTION_INTERVAL staggered scan; T2 stretches to
 *  {@linkcode T2_SCAN_STRIDE} (coarse perception). The per-tick hazard
 *  rescan is every tick at every tier. */
export function scanStrideForTier(tier: LodTier): number {
  return tier === LodTier.T2 ? T2_SCAN_STRIDE : PERCEPTION_INTERVAL;
}

/** Which hashed per-bot phase aligns a scan cadence of `stride` (PURE —
 *  pairs with {@linkcode scanStrideForTier}). */
export function scanPhaseForStride(stride: number, phase3: number, phase9: number): number {
  return stride === T2_SCAN_STRIDE ? phase9 : phase3;
}
