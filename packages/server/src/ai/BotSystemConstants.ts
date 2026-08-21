/**
 * Module-level constants extracted verbatim from the original BotSystem.ts
 * (lines 93-165). Each value, identifier, and comment is preserved exactly;
 * only the file location changed. Shared across the decomposed BotSystem
 * modules so that no module needs a runtime import from BotSystem.ts (which
 * would create a circular runtime dependency — see ADR in BotSystem.ts).
 */

import { PLAYER, CHEST } from '@sector-battle/shared';

export const PERCEPTION_INTERVAL = 3;
// DEC-006 fix 6 removed five dead exports that were never consumed anywhere
// (verified by audit + grep): STATE_COMMIT_TICKS, RETREAT_HP_PERCENT,
// ZONE_EDGE_SAFE_HP_PERCENT, SIEGE_WARNING_TILE_RADIUS, and HUNT_START_TICK
// (HuntIntent uses its own literal 600 start tick — see intentSurvival.ts).
// bot-ai-v2 ticket 07 (DEC-008) removed three more with the HUNT orbit /
// random wander retirement: HUNT_REPATH_TICKS + HOTSPOT_REPATH_TICKS (the
// 37°/repath ring sweep cadence) and hashPlayerIdAngle (the orbit's
// id-hash angle), plus HOTSPOT_ATTRACT_RANGE / HOTSPOT_SATURATION (the
// retired inline hotspot branch; the saturation concept lives in
// goal/GoalTables.HOTSPOT_STALK_SATURATION now).
export const KILL_SECURE_ENEMY_HP_PERCENT = 0.15;
// Seek health at 60% HP when no enemy is visible.
export const SEEK_HEALTH_HP_PERCENT = 0.6;
/** Goal-less/stall-relocation anchor cadence for the wander executor's
 *  fallback path (the committed macro-goal owns the primary cadence). */
export const WANDER_REPATH_TICKS = 120;
export const PICKUP_RADIUS = PLAYER.PICKUP_RADIUS;
// Chests accept opens up to CHEST.INTERACTION_RANGE (192px) but chest tiles are
// non-walkable, so navigateTo parks the bot on an adjacent tile ~1 tile away.
// Emit the open input well inside the open range (with margin for drift during
// the 0.5s open channel) — using PICKUP_RADIUS (64px) here leaves the bot stuck
// just outside the gate, never opening. 144px = 0.75 * 192.
export const CHEST_OPEN_RADIUS = CHEST.INTERACTION_RANGE * 0.75;
// Chests stream into the item list with this sentinel tier (see WorldSnapshot).
export const CHEST_TIER_SENTINEL = 5;
// HUNT starts after a brief arming window. Armed bots need a moment to pick up
// a weapon and orient before seeking fights; starting HUNT at tick 0 starved
// the economy (bots hunted before arming). 600 ticks (10s) gives the initial
// looting wave time, then armed bots actively seek combat.
// (The value lives as the literal in HuntIntent's gates; the dead
// HUNT_START_TICK export was removed by DEC-006 fix 6.)
/** How long (ticks) HUNT remembers the last enemy position and chases it. 8s. */
export const LAST_ENEMY_MEMORY_TICKS = 480;
/** How long (ticks) the shared combat hotspot stays attractive to HUNT bots.
 *  20s — long enough for distant hunters to converge and sustain a brawl. */
export const HOTSPOT_MEMORY_TICKS = 1200;
/** Arrival-escape window (Fix A3). After a HUNT bot reaches its target and
 *  finds no enemy, it avoids re-pathing to that same dead coordinate for this
 *  long (~1.5s). Short enough that a bot re-engages quickly if the enemy really
 *  is still nearby and gets re-perceived; long enough to break orbit around a
 *  dead hotspot. */
export const HUNT_ARRIVAL_ESCAPE_TICKS = 90;
/** Dash cooldown in ticks (3s). Mirrors BotCombat's DASH_COOLDOWN_TICKS — kept
 *  here for the under-fire / mobility dash checks in non-combat executors. */
export const DASH_COOLDOWN_TICKS = 180;

/** Goal suspension durations (moved from BotSystem static fields so that
 *  collaborator modules can reference them without a runtime import of the
 *  BotSystem class — keeps `import type { BotSystem }` type-only, avoiding
 *  runtime circular imports). Values + identifiers preserved verbatim. */
export const GOAL_SUSPEND_TICKS = 240; // 4s — relocate via HUNT/WANDER
export const GOAL_SUSPEND_TICKS_LONG = 480; // 8s — long stall = worse wedge

/** Tick-driver policy constants (moved verbatim from inlined locals in
 *  BotTickDriver.ts — same identifiers, same values, same trailing comments).
 *  DEMO_TIMEOUT caps a single DEMOLITION episode: the tick driver's
 *  demolition-yield guard bails a bot out after this long without clearing
 *  the tile (a stuck bot — wrong aim, unreachable tile, or stale target —
 *  would otherwise be re-entered into DEMOLITION by the yield guard every
 *  tick indefinitely). BLACKLIST_TICKS is how long the universal anti-stall
 *  blacklists all currently-visible items after a forced wander reset, so the
 *  bot relocates to a new sector instead of cycling to the next unreachable
 *  item in the same one. */
export const DEMO_TIMEOUT = 300; // 5s max per demolition episode
export const BLACKLIST_TICKS = 1800; // 30s

/** Cap on hotspot convergence (bot-ai-v2 ticket 07 note): the RETIRED inline
 *  HUNT hotspot branch's saturation constant was removed with the branch; the
 *  concept (and its value) lives in goal/GoalTables.HOTSPOT_STALK_SATURATION,
 *  enforced at the macro-goal scoring seam against bb.convergingCount. */
