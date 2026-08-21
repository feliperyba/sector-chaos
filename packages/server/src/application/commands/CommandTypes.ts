import type { GameEvent } from '../../domain/events/index.ts';

export interface Command {
  type: string;
  playerId: string;
  tick: number;
}

export interface CommandResult {
  success: boolean;
  events: GameEvent[];
  error?: string;
}

export const CommandResult = {
  ok(events: GameEvent[] = []): CommandResult {
    return { success: true, events };
  },
  fail(error: string): CommandResult {
    return { success: false, events: [], error };
  },
};
