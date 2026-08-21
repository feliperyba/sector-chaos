import { SIM_TICK_DT } from '@sector-battle/shared';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { IMovementService } from '../../domain/services/index.ts';
import type { Player } from '../../domain/entities/Player.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';

export interface MovePlayerInput {
  playerId: string;
  dx: number;
  dy: number;
  tick: number;
}

export class MovePlayerCommand {
  constructor(
    private match: GameMatch,
    private movementService: IMovementService,
    /**
     * server-alive-scratch-hoist: the per-tick alive array built at the top of
     * GameSimulation.step() (players-Map insertion order). When provided, the
     * collision pass enumerates it instead of walking the players Map —
     * equivalent membership/order because aliveness cannot change mid-step
     * (the ALIVE bit flips only in step9). Omit (standalone/tests) to fall
     * back to the live map scan.
     */
    private alivePlayers: Player[] | null = null,
  ) {}

  execute(input: MovePlayerInput): CommandResultType {
    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player not alive');

    const result = this.movementService.validateAndMove(
      player,
      input.dx,
      input.dy,
      SIM_TICK_DT,
      this.match.getGrid(),
    );

    if (!result.moved) {
      return { success: false, events: [] };
    }

    const alivePlayers = this.alivePlayers;
    const resolved = this.movementService.resolvePlayerCollision(
      player,
      (cb) => {
        if (alivePlayers) {
          for (let i = 0; i < alivePlayers.length; i++) cb(alivePlayers[i]!);
        } else {
          this.match.forEachAlivePlayer(cb);
        }
      },
      result.correctedPosition,
      input.tick,
    );

    const events = this.match.movePlayer(input.playerId, resolved);
    return CommandResult.ok(events);
  }
}
