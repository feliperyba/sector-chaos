import type { PlayerRoundStats } from './MatchEndService.ts';

export interface EliminationRecord {
  order: number;
  playerId: string;
  killerId: string | null;
  weaponType: number | null;
  timestamp: number;
  position: { x: number; y: number };
}

const DAMAGE_SOURCE_TTL_MS = 2000;

interface DamageSourceEntry {
  attackerId: string;
  timestamp: number;
}

export class EliminationService {
  private eliminations: EliminationRecord[] = [];
  private nextOrder: number = 1;
  private damageSources: Map<string, DamageSourceEntry> = new Map();
  private deadPlayerStats: Map<string, PlayerRoundStats> = new Map();

  recordElimination(
    playerId: string,
    killerId: string | null,
    weaponType: number | null,
    position: { x: number; y: number },
    timestamp: number,
  ): EliminationRecord {
    const resolvedKillerId = killerId ?? this.getLastKiller(playerId);

    const record: EliminationRecord = {
      order: this.nextOrder++,
      playerId,
      killerId: resolvedKillerId,
      weaponType,
      timestamp,
      position: { x: position.x, y: position.y },
    };

    this.eliminations.push(record);
    return record;
  }

  recordDeathStats(playerId: string, stats: PlayerRoundStats): void {
    this.deadPlayerStats.set(playerId, stats);
  }

  getDeadPlayerStats(): ReadonlyMap<string, PlayerRoundStats> {
    return this.deadPlayerStats;
  }

  getEliminations(): readonly EliminationRecord[] {
    return this.eliminations;
  }

  getLastKiller(playerId: string): string | null {
    const entry = this.damageSources.get(playerId);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > DAMAGE_SOURCE_TTL_MS) {
      this.damageSources.delete(playerId);
      return null;
    }

    return entry.attackerId;
  }
}
