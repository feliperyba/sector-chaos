import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import { CommandResult, type CommandResult as CommandResultType } from './CommandTypes.ts';

export interface JoinMatchInput {
  playerId: string;
  playerName: string;
}

export class JoinMatchCommand {
  constructor(
    private match: GameMatch,
    private maxPlayers: number,
  ) {}

  execute(input: JoinMatchInput): CommandResultType {
    if (this.match.playersCount >= this.maxPlayers) return CommandResult.fail('Match is full');

    this.match.addPlayer(input.playerId, input.playerName);
    return CommandResult.ok(this.match.drainEvents());
  }
}
