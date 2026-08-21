import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';

export class LeaveMatchCommand {
  constructor(private match: GameMatch) {}

  execute(playerId: string): CommandResultType {
    this.match.removePlayer(playerId);
    return CommandResult.ok();
  }
}
