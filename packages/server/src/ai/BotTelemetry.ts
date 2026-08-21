/**
 * Telemetry helpers extracted verbatim from the original BotSystem.ts.
 *
 * Each function body is byte-identical to the original method except `this.`
 * → `system.` (none of these methods referenced `this`, so the bodies are
 * truly identical). Behavior is provably preserved by construction.
 */

import { distance, InputAction } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { PlayerDTO } from './WorldSnapshot.ts';
import type { BotSystem } from './BotSystem.ts';
import { BotState } from './BotContext.ts';
import type { BotContext } from './BotContext.ts';
import type { BotSkillTracker, BotDeathCause } from './BotSkillTracker.ts';
import type { ZoneInfo } from './BotZoneSafety.ts';
import { isBarrel } from './BotDestructibles.ts';
import { IntentId } from './intent/Intent.ts';

/**
 * Tally a goal suspension on the bot's believability counters (DEC-013
 * ticket 01). Called at every suspend() call site — observation only, no
 * decision reads it. The selector keeps its own live counters
 * (IntentSelector.suspensionsIssued etc.); this full-match tally survives
 * the bot's death via the skill tracker. `reason` (bot-ai-v2 ticket 05)
 * distinguishes stall relocations ('stall', the default) from
 * search-failure target drops ('search-failure' — the suspension mechanism
 * extended from goals to targets).
 */
export function noteGoalSuspension(
  system: BotSystem,
  playerId: string,
  family: IntentId,
  reason: string = 'stall',
): void {
  const tracker = system.skillTrackers.get(playerId);
  if (tracker) tracker.believability.noteSuspension(IntentId[family], reason);
}

/**
 * Executor-input tally (DEC-013 ticket 01): count this tick's emitted inputs
 * on the skill tracker — pickup/attack attempts (the pre-existing counters)
 * plus the believability reason tags for dash/throw/switch. Called from BOTH
 * input-collection sites (runExecutorAndTelemetry and the demolition yield
 * guard) with the executor's returned batch. Observation-only.
 *
 * Equivalence note: the demolition-guard site previously counted ATTACK only;
 * the unified tally also counts PICKUP there, which is behavior-identical
 * because the demolition executor never emits PICKUP inputs.
 */
export function tallyExecutorInputs(
  tracker: BotSkillTracker,
  tick: number,
  inputs: readonly QueuedInput[],
): void {
  for (const qi of inputs) {
    if (qi.action === InputAction.PICKUP) tracker.pickupAttempts++;
    else if (qi.action === InputAction.ATTACK) tracker.attacksAttempted++;
  }
  tracker.believability.noteEmittedInputs(inputs, tick);
}

/** Attribute a death cause from the bot's last-known context. */
export function recordBotDeath(
  system: BotSystem,
  ctx: BotContext,
  tracker: BotSkillTracker,
  tick: number,
): void {
  tracker.isDead = true;
  tracker.deaths++;
  tracker.deathTick = tick;
  // PURSUIT CLOSURE ON DEATH (bot-ai-v2 ticket 05, DEC-003): an open
  // investigation ends with its investigator — close it as 'dropped' so the
  // pursuit-outcome bookkeeping stays exhaustive (every started pursuit ends
  // in exactly one terminal event unless the bot is alive at match end).
  if (ctx.pursuitTargetId !== null) {
    ctx.pursuitTargetId = null;
    ctx.pursuitStartTick = -9999;
    if (ctx.beliefs.exemptId !== null) ctx.beliefs.exemptId = null;
    tracker.believability.beliefs.notePursuitOutcome('dropped');
  }
  // WALL-DEATH TELEMETRY (bot-ai-v2 ticket 06, DEC-005.4): deaths at low HP
  // while adjacent to a wall tile — the signature of the old straight-line
  // retreat wedging into geometry. The navigated break-line retreat is
  // measured by this counter dropping vs baseline.
  if (ctx.health < ctx.maxHealth * 0.4) {
    const pf = system.pathfinder;
    const ts = pf.getTileSize();
    const gx = Math.floor(ctx.x / ts);
    const gy = Math.floor(ctx.y / ts);
    if (
      !pf.isWalkable(gx - 1, gy) ||
      !pf.isWalkable(gx + 1, gy) ||
      !pf.isWalkable(gx, gy - 1) ||
      !pf.isWalkable(gx, gy + 1)
    ) {
      tracker.believability.noteWallAdjacentDeath();
    }
  }
  const distToCenter = distance(ctx.x, ctx.y, ctx.zoneCenterX, ctx.zoneCenterY);
  const outsideZone = ctx.zoneRadius > 0 && distToCenter > ctx.zoneRadius;
  const onSiege = ctx.siegeWarnings.length > 0;
  const nearBarrel = ctx.dangers.some((d) => isBarrel(d.type) && d.distance < 100);
  // Trap dangers carry non-barrel types (spike / fire / teleport). A bot that
  // died while standing on one likely died to it.
  const onTrap = ctx.dangers.some((d) => !isBarrel(d.type) && d.distance < 120);
  let cause: BotDeathCause;
  if (outsideZone || onSiege) {
    cause = onSiege && !outsideZone ? 'siege' : 'zone';
  } else if (nearBarrel) {
    cause = 'barrel';
  } else if (onTrap) {
    cause = 'trap';
  } else {
    // Default: if an enemy was recently visible, it was combat; otherwise
    // unclassifiable. This is an approximation but sufficient for
    // population-level death-cause scoring.
    cause = ctx.nearestEnemy !== null && ctx.tick - ctx.lastSeenEnemyTick < 60 ? 'combat' : 'other';
  }
  switch (cause) {
    case 'siege':
      tracker.siegeDeaths++;
      break;
    case 'zone':
      tracker.zoneDeaths++;
      break;
    case 'barrel':
      tracker.barrelDeaths++;
      break;
    case 'trap':
      tracker.trapDeaths++;
      break;
    case 'combat':
      tracker.combatDeaths++;
      break;
    default:
      tracker.otherDeaths++;
  }
}

/**
 * Per-tick telemetry: cheap integer increments read inline during tickBot.
 * Guards on dto validity keep this safe even if the bot was just removed.
 */
export function recordTickTelemetry(
  _system: BotSystem,
  ctx: BotContext,
  _dto: PlayerDTO,
  tracker: BotSkillTracker,
  _zoneInfo: ZoneInfo,
): void {
  tracker.recordAliveTick();
  // Stuck-ladder rung drain (bot-ai-v2 ticket 06): forward new rung ENTRY
  // counts to the believability counters (observation-only; the ladder
  // itself never reads them back).
  for (const [rungKey, count] of ctx.ladder.drainFirings()) {
    tracker.believability.noteLadderRung(rungKey, count);
  }
  // COMBAT-AWARENESS DRAIN (bot-ai-v2 ticket 09, DEC-010): forward the
  // pending counters intent-layer decision sites bumped (they have no
  // tracker reference) into the believability combat surface — one
  // observation seam, same discipline as the ladder drain. Drains to zero.
  const combat = tracker.believability.combat;
  const c9 = ctx.combat;
  if (c9) {
    if (c9.pendingWeaveCommits > 0) {
      combat.weaveCommits += c9.pendingWeaveCommits;
      combat.weaveCommitTicksSum += c9.pendingWeaveCommitTicks;
      c9.pendingWeaveCommits = 0;
      c9.pendingWeaveCommitTicks = 0;
    }
    for (const key of Object.keys(c9.pendingDisengages)) {
      const n = c9.pendingDisengages[key] ?? 0;
      if (n > 0) {
        combat.disengageByCause[key] = (combat.disengageByCause[key] ?? 0) + n;
        combat.disengagesTotal += n;
        c9.pendingDisengages[key] = 0;
      }
    }
    for (const key of Object.keys(c9.pendingContestOutcomes)) {
      const n = c9.pendingContestOutcomes[key] ?? 0;
      if (n > 0) {
        if (key === 'win') combat.contestWins += n;
        else if (key === 'loss') combat.contestLosses += n;
        else combat.contestBreakOffs += n;
        c9.pendingContestOutcomes[key] = 0;
      }
    }
    for (const key of Object.keys(c9.pendingWeaponBreakReactions)) {
      const n = c9.pendingWeaponBreakReactions[key] ?? 0;
      if (n > 0) {
        combat.weaponBreakByReaction[key] = (combat.weaponBreakByReaction[key] ?? 0) + n;
        c9.pendingWeaponBreakReactions[key] = 0;
      }
    }
  }
  // Believability per-tick observation (DEC-013): runs after the tick's
  // intent selection + executor, so every observed field (state, enemy
  // sight, damage edge, forced-wander window, position/velocity) is final
  // for the tick. Observation-only — writes counters, reads nothing back.
  tracker.believability.observeTick({
    tick: ctx.tick,
    x: ctx.x,
    y: ctx.y,
    vx: ctx.vx,
    vy: ctx.vy,
    state: ctx.state,
    hasEnemy: ctx.nearestEnemy !== null,
    forceWanderUntilTick: ctx.forceWanderUntilTick,
  });
  if (ctx.hasRealWeapon()) {
    tracker.ticksArmed++;
  }
  const activeTier = ctx.getActiveWeapon().tier;
  if (activeTier > tracker.highestWeaponTier) tracker.highestWeaponTier = activeTier;
  if (activeTier >= 2) tracker.ticksArmedTier2Plus++;
  if (ctx.nearestEnemy) tracker.ticksNearEnemy++;
  if (ctx.state === BotState.ENGAGE) tracker.ticksEngaging++;
  // In-zone = within the safe radius. zoneRadius==0 (early game) counts as safe.
  const distToCenter = distance(ctx.x, ctx.y, ctx.zoneCenterX, ctx.zoneCenterY);
  const inSafeZone = ctx.zoneRadius <= 0 || distToCenter < ctx.zoneRadius;
  if (inSafeZone) tracker.ticksInZone++;
  const hpRatio = ctx.health / ctx.maxHealth;
  const inOuterZone = ctx.zoneRadius > 0 && distToCenter > ctx.zoneRadius * 0.5;
  if (inOuterZone && hpRatio < 0.8) tracker.ticksDamagedAtEdge++;
}
