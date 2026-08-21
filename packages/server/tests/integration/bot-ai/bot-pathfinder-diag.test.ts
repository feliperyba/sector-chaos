import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../../helpers/test-server';
import { createGameRoom } from '../../helpers/game-room-helper';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../../src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch';

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await cleanup(server);
});

function uid(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function forceActivePhase(room: Room<{ state: GameStateSchema }>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: {
      getCurrentState: () => { phase: number };
      transitionTo: (p: number) => void;
    };
    phase: number;
  };
  const match = (gameRoom.getOrchestrator() as unknown as { match: GameMatch }).match as unknown as {
    phase: number;
  };
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) {
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  }
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN) {
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  }
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

const BOT_SPAWN_WAIT_TICKS = 450;

describe('Bot Pathfinder Diagnostic', () => {
  it('tests pathfinding from stuck bot position', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 3,
      matchId: uid('pathfind'),
      mapType: 'demo',
    });

    await helper.advanceTicks(BOT_SPAWN_WAIT_TICKS);
    await helper.addPlayer('PathfindHuman');
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as unknown as {
      simulation: {
        botSystem: import('../../../src/ai/BotSystem').BotSystem;
      };
    };

    const botSystem = orch.simulation.botSystem;

    // Get the pathfinder from the bot system
    const bsInternal = botSystem as unknown as {
      pathfinder: import('../../../src/ai/navigation/Pathfinder').Pathfinder;
    };
    const pathfinder = bsInternal.pathfinder;

    // Print grid dimensions and walkable status
    const gridMethod = pathfinder as unknown as {
      grid: boolean[][];
      tileSize: number;
    };

    console.log(`\nPathfinder: tileSize=${gridMethod.tileSize}`);
    console.log(`Grid: ${gridMethod.grid.length} rows x ${gridMethod.grid[0]?.length ?? 0} cols`);

    // Print grid around the stuck bot position (1, 5) with ±3 range
    console.log('\nGrid walkability map (.=walkable #=wall):');
    for (let y = 0; y < gridMethod.grid.length; y++) {
      let row = '';
      for (let x = 0; x < (gridMethod.grid[y]?.length ?? 0); x++) {
        row += gridMethod.grid[y]?.[x] ? '.' : '#';
      }
      console.log(`  ${y.toString().padStart(2)}: ${row}`);
    }

    // Test pathfinding from stuck position to open area
    const stuckPos = { x: 192, y: 704 }; // Bot 1 position
    const openPos = { x: 1000, y: 1000 }; // Middle of open area

    const path = pathfinder.findPath(stuckPos, openPos);
    console.log(`\nPath from (192,704) to (1000,1000): ${path ? `${path.length} waypoints` : 'NULL'}`);
    if (path) {
      for (const wp of path) {
        console.log(`  (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`);
      }
    }

    // Test from open to open
    const path2 = pathfinder.findPath({ x: 800, y: 1200 }, { x: 1500, y: 800 });
    console.log(`\nPath from (800,1200) to (1500,800): ${path2 ? `${path2.length} waypoints` : 'NULL'}`);

    // Check walkability at stuck position
    const stuckGrid = pathfinder.worldToGrid(stuckPos);
    console.log(`\nStuck pos grid: (${stuckGrid.x}, ${stuckGrid.y})`);
    console.log(`Is walkable: ${pathfinder.isWalkable(stuckGrid.x, stuckGrid.y)}`);

    // Check neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = stuckGrid.x + dx;
        const gy = stuckGrid.y + dy;
        console.log(`  (${gx},${gy}): walkable=${pathfinder.isWalkable(gx, gy)}`);
      }
    }

    expect(true).toBe(true); // Diagnostic only
  }, 60_000);
});
