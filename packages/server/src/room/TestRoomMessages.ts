import type { Client } from 'colyseus';
import { PLAYER } from '@sector-battle/shared';
import { Health } from '../domain/value-objects/Health.ts';
import { logger } from '@sector-battle/shared';

export interface TestRoomDeps {
  orchestrator: {
    getMatchState(): {
      players: Map<
        string,
        {
          position: { x: number; y: number };
          health: { current: number; max: number };
          status: unknown;
          speed: { value: number };
          connected: boolean;
        }
      >;
    };
    stop(): void;
    getMatch(): {
      currentTick: number;
      getPlayers: () => Iterable<{ id: string; name: string }>;
    };
    eliminationService: {
      getEliminations: () => readonly { playerId: string; order: number }[];
      getDeadPlayerStats: () => ReadonlyMap<
        string,
        {
          kills: number;
          damageDealt: number;
          damageTaken: number;
          itemsCollected: number;
          survivalTimeMs: number;
          weaponsUsed: number;
        }
      >;
    };
    matchEndService: {
      calculatePlacements: (
        stats: unknown[],
        elims: readonly unknown[],
        deadStats: unknown,
      ) => Array<{
        playerId: string;
        placement: number;
        kills: number;
        damageDealt: number;
        damageTaken: number;
        itemsCollected: number;
        survivalTimeMs: number;
        weaponsUsed: number;
      }>;
    };
    match: {
      forEachAlivePlayer: (
        cb: (p: {
          id: string;
          isActive: boolean;
          health: { current: number };
          kills: number;
          damageDealt: number;
          damageTaken: number;
          itemsCollected: number;
          getSurvivalTimeMs: (tick: number, rate: number) => number;
          weaponsUsedCount: number;
        }) => void,
      ) => void;
    };
    matchEndedEmitted: boolean;
  };
  sendMapData(client: Client): void;
  syncState(): void;
  broadcast(channel: string, message: unknown): void;
  enrichedData: {
    grid: unknown;
    width: number;
    height: number;
    tileSize: number;
    seed: number;
    visualLayers: unknown;
    atlas: unknown;
  };
  debugFlags: { paused: boolean; stepOnce: boolean };
}

interface MessageHandlingRoom {
  onMessage(type: string, callback: (client: Client, data: unknown) => void): void;
}

export function registerTestRoomMessages(room: MessageHandlingRoom, deps: TestRoomDeps): void {
  room.onMessage('requestMapData', (client: Client) => {
    deps.sendMapData(client);
  });

  room.onMessage('debug:togglePause', () => {
    deps.debugFlags.paused = !deps.debugFlags.paused;
  });

  room.onMessage('debug:step', () => {
    if (deps.debugFlags.paused) deps.debugFlags.stepOnce = true;
  });

  room.onMessage('debug:inspect', (client: Client, data: unknown) => {
    const payload = data as { x: number; y: number };
    const state = deps.orchestrator.getMatchState();
    const results: Array<Record<string, unknown>> = [];
    const clickWorldX = payload.x;
    const clickWorldY = payload.y;

    for (const [id, player] of state.players) {
      const dx = player.position.x - clickWorldX;
      const dy = player.position.y - clickWorldY;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER.HITBOX_WIDTH) {
        results.push({
          type: 'player',
          id,
          x: player.position.x,
          y: player.position.y,
          health: player.health.current,
          maxHealth: player.health.max,
          status: player.status,
          speed: player.speed.value,
          connected: player.connected,
        });
      }
    }

    client.send('debug:inspectResult', { entities: results });
  });

  room.onMessage('debug:endMatch', (client: Client) => {
    const orch = deps.orchestrator as unknown as {
      eliminationService: {
        getEliminations: () => readonly { playerId: string; order: number }[];
        getDeadPlayerStats: () => ReadonlyMap<
          string,
          {
            kills: number;
            damageDealt: number;
            damageTaken: number;
            itemsCollected: number;
            survivalTimeMs: number;
            weaponsUsed: number;
          }
        >;
      };
      matchEndService: {
        calculatePlacements: (
          stats: unknown[],
          elims: readonly unknown[],
          deadStats: unknown,
        ) => Array<{
          playerId: string;
          placement: number;
          kills: number;
          damageDealt: number;
          damageTaken: number;
          itemsCollected: number;
          survivalTimeMs: number;
          weaponsUsed: number;
        }>;
      };
      match: {
        forEachAlivePlayer: (
          cb: (p: {
            id: string;
            isActive: boolean;
            health: { current: number };
            kills: number;
            damageDealt: number;
            damageTaken: number;
            itemsCollected: number;
            getSurvivalTimeMs: (tick: number, rate: number) => number;
            weaponsUsedCount: number;
          }) => void,
        ) => void;
      };
      getMatch: () => {
        currentTick: number;
        getPlayers: () => Iterable<{ id: string; name: string }>;
      };
      matchEndedEmitted: boolean;
    };

    const state = orch.getMatch();

    const alivePlayers: Array<{
      playerId: string;
      alive: boolean;
      hp: number;
      kills: number;
      damageDealt: number;
      damageTaken: number;
      itemsCollected: number;
      survivalTimeMs: number;
      weaponsUsed: number;
    }> = [];
    orch.match.forEachAlivePlayer((p) => {
      alivePlayers.push({
        playerId: p.id,
        alive: p.isActive,
        hp: p.health.current,
        kills: p.kills,
        damageDealt: p.damageDealt,
        damageTaken: p.damageTaken,
        itemsCollected: p.itemsCollected,
        survivalTimeMs: p.getSurvivalTimeMs(orch.getMatch().currentTick, 60),
        weaponsUsed: p.weaponsUsedCount,
      });
    });

    const eliminations = orch.eliminationService.getEliminations();
    const deadStats = orch.eliminationService.getDeadPlayerStats();
    const placements = orch.matchEndService.calculatePlacements(
      alivePlayers,
      eliminations,
      deadStats,
    );

    const winnerId = placements.length > 0 ? placements[0]!.playerId : '';
    const playerNames: Record<string, string> = {};
    for (const p of state.getPlayers()) {
      playerNames[p.id] = p.name;
    }

    deps.broadcast('match_end', {
      winnerId,
      placements,
    });
    deps.orchestrator.stop();
    logger.info('debug:endMatch triggered', {
      clientId: client.sessionId,
      winnerId,
      playerCount: placements.length,
    });
  });

  room.onMessage('debug:setHealth', (client: Client, data: unknown) => {
    const payload = data as { health: number };
    const state = deps.orchestrator.getMatchState();
    const player = state.players.get(client.sessionId);
    if (player) {
      player.health = new Health(
        Math.max(0, Math.min(payload.health, player.health.max)),
        player.health.max,
      );
      deps.syncState();
      logger.info('debug:setHealth', { clientId: client.sessionId, health: payload.health });
    }
  });
}
