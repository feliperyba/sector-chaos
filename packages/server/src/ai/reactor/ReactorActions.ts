/**
 * Reactor action emitters — bot-ai-v2 ticket 04 (DEC-004).
 *
 * Emits the observable movement of an active reaction through the SAME
 * queued-input factories every executor uses (bots stay players on the input
 * pipeline — no direct state mutation).
 *
 * VISIBILITY INVARIANT, ENFORCED BY CONSTRUCTION: {@linkcode emitReactionTick}
 * ALWAYS returns a non-empty array — the MOVE input (which carries BOTH the
 * turn, via its aimAngle, and the velocity change, via dx/dy) is pushed
 * unconditionally on every owned tick; the DASH is an additional, conditional
 * input. There is no code path from a fired reaction to zero inputs, so a
 * reaction with no emitted input fails the suite by construction (the
 * visibility test walks every archetype × reaction mix and asserts ≥1
 * MOVE/DASH per owned tick).
 *
 * Styles (ReactorConfig.ReactionStyle) — all visible at top-down zoom:
 *  - 'safe'      panic-run to the zone-safe point (aim = move direction).
 *  - 'toward'    close on the threat, facing it.
 *  - 'away'      flee the threat while looking at it (the human look-back).
 *  - 'perp'      committed perpendicular sidestep, facing the threat.
 *  - 'perpAway'  diagonal — sidestep blended with distance-gaining.
 */

import { angleTo, normalizeAngle } from '@sector-battle/shared';
import type { QueuedInput } from '../../application/simulation/InputQueue.ts';
import type { BotContext } from '../BotContext.ts';
import type { Pathfinder } from '../navigation/Pathfinder.ts';
import { makeDashInput, makeMoveInput } from '../BotInput.ts';
import { blendDangerAvoidance } from '../BotCombatShared.ts';
import { validateFinalAngle } from '../BotNavigationBlend.ts';
import type { ActiveReaction } from './ReactorTypes.ts';
import type { ReactionMix } from './ReactorConfig.ts';

/** Compute the movement angle for a reaction style, relative to the threat
 *  axis. Pure. `perpSign` is the committed strafe side (±1). */
export function reactionMoveAngle(
  ctx: BotContext,
  active: ActiveReaction,
  mix: ReactionMix,
  safeX: number,
  safeY: number,
): number {
  const toSafe = angleTo(ctx.x, ctx.y, safeX, safeY);
  if (active.threatX === null || active.threatY === null) {
    // No threat basis (imminent death / sourceless startle): run for safety.
    return toSafe;
  }
  const threatAngle = angleTo(ctx.x, ctx.y, active.threatX, active.threatY);
  switch (mix.style) {
    case 'safe':
      return toSafe;
    case 'toward':
      return threatAngle;
    case 'away':
      return angleTo(active.threatX, active.threatY, ctx.x, ctx.y);
    case 'perp':
      return normalizeAngle(threatAngle + (active.perpSign * Math.PI) / 2);
    case 'perpAway': {
      // Blend the perpendicular sidestep with the away direction (both
      // unit-weighted, then renormalized) — a diagonal that clears the
      // hitbox line while gaining distance.
      const perp = normalizeAngle(threatAngle + (active.perpSign * Math.PI) / 2);
      const away = angleTo(active.threatX, active.threatY, ctx.x, ctx.y);
      return Math.atan2(Math.sin(perp) + Math.sin(away), Math.cos(perp) + Math.cos(away));
    }
    default:
      return toSafe;
  }
}

/**
 * Emit one owned tick of an active reaction. Returns the inputs to push for
 * this tick — ALWAYS ≥1 (see module docs: the MOVE is unconditional).
 *
 * WALL VALIDATION (DEC-005.1, review M1): every movement angle this emits —
 * the one-shot DASH and the sustained MOVE — is wall-validated. The reaction
 * angles are raw geometry (threat axis / zone-safe point); the worst case is
 * the imminent-death panic move, which must never spend its escape impulse
 * INTO a wall.
 *
 * @param allowDash the caller's dash usability verdict: dash cooldown ready
 *  AND not suppressed by the bot's own windup. NOTE: the server does NOT
 *  reject a dash during the player's own windup (PlayerCombatChecks.canDash
 *  gates fresh-spawn/stagger/dash-cooldown only) — the suppression is a
 *  DESIGN choice (DEC-004): the swing is a committed, uncancellable action,
 *  and a mid-swing dash would visibly cancel what players learn is an
 *  unbreakable commitment, so the mask kills the dash at the source.
 * @param safeX/safeY the zone-safe point (or map center) for 'safe'-style
 *  escapes and hazard-aware blending.
 * @param pf the pathfinder (wall probe for the emitted angles — one
 *  isWalkable lookup in the common case).
 */
export function emitReactionTick(
  ctx: BotContext,
  active: ActiveReaction,
  mix: ReactionMix,
  allowDash: boolean,
  safeX: number,
  safeY: number,
  pf: Pathfinder,
): QueuedInput[] {
  const inputs: QueuedInput[] = [];
  const reactionAngle = reactionMoveAngle(ctx, active, mix, safeX, safeY);
  // First owned tick: the one-shot DASH when the mix calls for it and it is
  // usable. Wall-validated (no hazard blending — a dash is a committed burst,
  // and steering it by proximity to a barrel would spend it sideways). The
  // reason tag ('react-<type>') feeds the believability dash-reason tallies
  // (per-archetype cuts come free through the existing join in the benchmark
  // harness).
  if (!active.emittedFirstTick && mix.dash && allowDash) {
    inputs.push(
      makeDashInput(
        ctx.playerId,
        validateFinalAngle(ctx, reactionAngle, pf),
        ctx.tick,
        `react-${active.type}`,
      ),
    );
  }
  // Aim: face the threat (the visible TURN of the reaction) except for
  // 'safe' escapes, where the panic run aims along the movement.
  const aimAngle =
    mix.style === 'safe' || active.threatX === null || active.threatY === null
      ? reactionAngle
      : angleTo(ctx.x, ctx.y, active.threatX, active.threatY);
  // Movement: the style's angle, hazard-blended exactly like executor
  // movement so a reaction never steers INTO a barrel while fleeing a blast —
  // and (review M1) wall-validated by the blend's own final-angle choke point.
  const moveAngle = blendDangerAvoidance(ctx, reactionAngle, pf);
  inputs.push(makeMoveInput(ctx.playerId, moveAngle, aimAngle, ctx.tick));
  active.emittedFirstTick = true;
  return inputs;
}
