import { PLAYER, normalizeMoveInputInto } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';

/**
 * Dir receptacle for the shared normalize leaf (ticket 15). Module-pooled —
 * consumed synchronously into locals below, never escapes execute() (dash
 * edges are rare; nothing re-enters execute within a call).
 */
const dirOut: { x: number; y: number } = { x: 0, y: 0 };

export interface DashInput {
  playerId: string;
  tick: number;
  dx: number;
  dy: number;
}

export interface DashResult {
  startTick: number;
  multiplier: number;
  directionX: number;
  directionY: number;
}

export type ActiveDash = DashResult;

export class DashCommand {
  constructor(private match: GameMatch) {}

  execute(input: DashInput): CommandResultType & { dashData?: DashResult } {
    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');
    if (player.movement.isDashing) return CommandResult.fail('Already dashing');

    let dirX = input.dx;
    let dirY = input.dy;
    if (dirX === 0 && dirY === 0) {
      dirX = Math.cos(player.movement.facingAngle);
      dirY = Math.sin(player.movement.facingAngle);
    }
    // Ticket 15: the dash-direction normalize is the shared leaf — the SAME
    // sqrt-form arithmetic the client's simulatePhysicsStepInto dash branch
    // now runs. The fallbacks stay call-site-owned by design: the zero-input
    // fallback to facingAngle applies BEFORE normalize (above); the (1,0)
    // fallback after normalize only covers the pathological len==0 remainder
    // (denormal-scale input).
    const dirLen = normalizeMoveInputInto(dirOut, dirX, dirY);
    if (dirLen > 0) {
      dirX = dirOut.x;
      dirY = dirOut.y;
    } else {
      dirX = 1;
      dirY = 0;
    }

    if (!player.startDash()) return CommandResult.fail('Cannot dash');
    player.startDashSpeed();

    const dashSpeed = player.movement.speed.value;
    player.movement.velocityX = dirX * dashSpeed;
    player.movement.velocityY = dirY * dashSpeed;

    return {
      success: true,
      events: [],
      dashData: {
        startTick: input.tick,
        multiplier: PLAYER.DASH_SPEED_MULTIPLIER,
        directionX: dirX,
        directionY: dirY,
      },
    };
  }
}
