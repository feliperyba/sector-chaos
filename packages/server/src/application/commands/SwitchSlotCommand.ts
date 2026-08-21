import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { PLAYER } from '@sector-battle/shared';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';

export interface SwitchSlotInput {
  playerId: string;
  tick: number;
  slot: number;
}

export class SwitchSlotCommand {
  constructor(private match: GameMatch) {}

  execute(input: SwitchSlotInput): CommandResultType {
    const player = this.match.getPlayer(input.playerId);
    if (!player) return CommandResult.fail('Player not found');
    if (!player.isActive) return CommandResult.fail('Player is dead');
    if (input.slot < 0 || input.slot >= PLAYER.INVENTORY_SIZE)
      return CommandResult.fail('Invalid slot');
    if (!player.switchSlot(input.slot)) return CommandResult.fail('Cannot switch to empty slot');
    return CommandResult.ok([]);
  }
}
