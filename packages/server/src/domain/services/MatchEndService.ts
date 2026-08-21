import type { EliminationRecord } from './EliminationService.ts';

export interface PlacementData {
  playerId: string;
  placement: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsCollected: number;
  survivalTimeMs: number;
  weaponsUsed: number;
}

export interface RoundEndResult {
  winnerId: string;
  reason: 'last_standing' | 'simultaneous_death';
  placements: PlacementData[];
}

export interface PlayerRoundStats {
  playerId: string;
  alive: boolean;
  hp: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsCollected: number;
  survivalTimeMs: number;
  survivalTicks?: number;
  weaponsUsed: number;
}

export class MatchEndService {
  checkRoundEnd(
    alivePlayers: PlayerRoundStats[],
    eliminations: readonly EliminationRecord[],
    deadStats: ReadonlyMap<string, PlayerRoundStats>,
    _elapsedMs: number,
    _suddenDeathElapsedMs: number,
    lastStandingThreshold: number = 0,
  ): RoundEndResult | null {
    // -1 disables the alive-count check entirely (test scenes that want the
    // match to run until zone/sudden-death kills everyone).
    if (lastStandingThreshold < 1) return null;

    if (alivePlayers.length === 0) {
      if (eliminations.length === 0) return null;
      const allStats = this.buildAllStats(alivePlayers, eliminations, deadStats);
      const placements = this.calculatePlacementsFromAll(allStats, eliminations);
      const winner = placements[0]!;
      return {
        winnerId: winner.playerId,
        reason: 'simultaneous_death',
        placements,
      };
    }

    if (alivePlayers.length <= lastStandingThreshold) {
      const winner = alivePlayers[0]!;
      const allStats = this.buildAllStats(alivePlayers, eliminations, deadStats);
      return {
        winnerId: winner.playerId,
        reason: 'last_standing',
        placements: this.calculatePlacementsFromAll(allStats, eliminations),
      };
    }

    return null;
  }

  calculatePlacements(
    stats: PlayerRoundStats[],
    eliminations: readonly EliminationRecord[],
    deadStats: ReadonlyMap<string, PlayerRoundStats> = new Map(),
  ): PlacementData[] {
    return this.calculatePlacementsFromAll(
      this.buildAllStats(stats, eliminations, deadStats),
      eliminations,
    );
  }

  private buildAllStats(
    alivePlayers: PlayerRoundStats[],
    eliminations: readonly EliminationRecord[],
    deadStats: ReadonlyMap<string, PlayerRoundStats>,
  ): PlayerRoundStats[] {
    const allStats = [...alivePlayers];

    const seenPlayerIds = new Set(alivePlayers.map((p) => p.playerId));

    for (const elimination of eliminations) {
      if (!seenPlayerIds.has(elimination.playerId)) {
        const captured = deadStats.get(elimination.playerId);
        allStats.push(
          captured ?? {
            playerId: elimination.playerId,
            alive: false,
            hp: 0,
            kills: 0,
            damageDealt: 0,
            damageTaken: 0,
            itemsCollected: 0,
            survivalTimeMs: 0,
            weaponsUsed: 0,
          },
        );
        seenPlayerIds.add(elimination.playerId);
      }
    }

    return allStats;
  }

  private calculatePlacementsFromAll(
    allStats: PlayerRoundStats[],
    eliminations: readonly EliminationRecord[],
  ): PlacementData[] {
    const eliminationOrderMap = new Map<string, number>();
    for (const e of eliminations) {
      eliminationOrderMap.set(e.playerId, e.order);
    }

    const TICK_RATE = 60;
    const sorted = [...allStats].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive && b.alive) return 0;

      const orderA = eliminationOrderMap.get(a.playerId) ?? 0;
      const orderB = eliminationOrderMap.get(b.playerId) ?? 0;
      if (orderA !== orderB) return orderB - orderA;

      if (b.kills !== a.kills) return b.kills - a.kills;

      if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;

      const survivalA = a.survivalTimeMs ?? (a.survivalTicks ?? 0) * (1000 / TICK_RATE);
      const survivalB = b.survivalTimeMs ?? (b.survivalTicks ?? 0) * (1000 / TICK_RATE);
      if (survivalB !== survivalA) return survivalB - survivalA;

      return Number(a.playerId) - Number(b.playerId);
    });

    return sorted.map((stat, index) => ({
      playerId: stat.playerId,
      placement: index + 1,
      kills: stat.kills,
      damageDealt: stat.damageDealt,
      damageTaken: stat.damageTaken,
      itemsCollected: stat.itemsCollected,
      survivalTimeMs: stat.survivalTimeMs ?? (stat.survivalTicks ?? 0) * (1000 / TICK_RATE),
      weaponsUsed: stat.weaponsUsed,
    }));
  }
}
