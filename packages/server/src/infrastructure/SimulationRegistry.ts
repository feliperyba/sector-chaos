import type { GameSimulation } from '../application/simulation/GameSimulation.ts';

const activeSimulations = new Map<string, GameSimulation>();

export function registerSimulation(roomId: string, sim: GameSimulation): void {
  activeSimulations.set(roomId, sim);
}

export function unregisterSimulation(roomId: string): void {
  activeSimulations.delete(roomId);
}

export function getActiveSimulations(): Map<string, GameSimulation> {
  return activeSimulations;
}
