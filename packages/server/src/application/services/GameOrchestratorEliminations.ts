import type { GameEvent } from '../../domain/events/index.ts';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { EliminationService } from '../../domain/services/index.ts';

/**
 * Player-elimination event processing for the orchestrator's update loop.
 * Mechanical extraction from GameOrchestrator.update() — body verbatim.
 */
export function processEliminationEvents(
  events: GameEvent[],
  match: GameMatch,
  eliminationService: EliminationService,
): void {
  for (const event of events) {
    if (event.type === 'PlayerEliminated' && event.playerId) {
      const eliminatedPlayerId = event.playerId as string;
      eliminationService.recordElimination(
        eliminatedPlayerId,
        (event.killedBy as string) ?? null,
        (event.weapon as number) ?? null,
        { x: (event.x as number) ?? 0, y: (event.y as number) ?? 0 },
        event.timestamp,
      );
      const killerId = (event.killedBy as string) ?? null;
      if (killerId) {
        const killer = match.getPlayer(killerId);
        if (killer) killer.recordKill();
      }
      const eliminatedPlayer = match.getPlayer(eliminatedPlayerId);
      if (eliminatedPlayer) {
        eliminationService.recordDeathStats(eliminatedPlayerId, {
          playerId: eliminatedPlayerId,
          alive: false,
          hp: 0,
          kills: eliminatedPlayer.kills,
          damageDealt: eliminatedPlayer.damageDealt,
          damageTaken: eliminatedPlayer.damageTaken,
          itemsCollected: eliminatedPlayer.itemsCollected,
          survivalTimeMs: eliminatedPlayer.getSurvivalTimeMs(
            eliminatedPlayer.statusEffects.deathTick > 0
              ? eliminatedPlayer.statusEffects.deathTick
              : match.currentTick,
            60,
          ),
          weaponsUsed: eliminatedPlayer.combat.weaponsUsedCount,
        });
      }
    }
  }
}
