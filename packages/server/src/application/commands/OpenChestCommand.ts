import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import * as EntityOps from '../../domain/aggregates/GameMatchEntityOps.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';
import type { ChestRejectedEvent } from '../../domain/events/ChestEvents.ts';

export interface OpenChestInput {
  playerId: string;
  chestId: string;
  tick: number;
}

export class OpenChestCommand {
  constructor(private match: GameMatch) {}

  execute(input: OpenChestInput): CommandResultType {
    const chest = this.match.getState().chests.get(input.chestId);
    if (!chest) return CommandResult.fail('Chest not found');

    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');

    if (!player.isActive) return CommandResult.fail('Player is dead');

    const distance = player.movement.position.distanceTo(chest.position);

    try {
      const result = chest.startOpening(input.playerId, distance, player.movement.position);

      if (!result.success) {
        const event: ChestRejectedEvent = {
          type: 'ChestRejected',
          tick: this.match.currentTick,
          timestamp: Date.now(),
          chestId: input.chestId,
          playerId: input.playerId,
          reason: result.reason ?? 'unknown',
        };
        this.match.emitEvent(event);
        return CommandResult.fail(result.reason ?? 'Cannot open chest');
      }
    } catch {
      const event: ChestRejectedEvent = {
        type: 'ChestRejected',
        tick: this.match.currentTick,
        timestamp: Date.now(),
        chestId: input.chestId,
        playerId: input.playerId,
        reason: 'already_open',
      };
      this.match.emitEvent(event);
      return CommandResult.fail('Chest is already being opened');
    }

    // server-chest-cancel-index: the only 'opening'-state entry point — index
    // the new opening so cancelChestOpeningForPlayer finds it in O(1).
    EntityOps.registerChestOpening(this.match.openingChestsByPlayer, input.playerId, input.chestId);
    return CommandResult.ok();
  }
}
