/**
 * Check the TileType of the wall tiles bordering the demo weapon pocket.
 */
import { TileType } from '@sector-battle/shared';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';

interface PfLike {
  worldToGrid(p: { x: number; y: number }): { x: number; y: number };
  getTileSize(): number;
}
interface MatchLike {
  getGrid(): number[][];
}
interface OrchLike {
  getMatch(): MatchLike | undefined;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(d: number): unknown;
  getBotSystem(): { pathfinder: PfLike } | null;
}
function asGameRoom(room: unknown): { getOrchestrator(): OrchLike } {
  return room as { getOrchestrator(): OrchLike };
}

const NAME: Record<number, string> = {};
for (const k of Object.keys(TileType) as (keyof typeof TileType)[]) {
  if (typeof TileType[k] === 'number') NAME[TileType[k] as number] = k;
}

async function main() {
  const server = await createTestServer();
  try {
    const room = await createRoom(server, { botFillTo: 1, mapType: 'demo', seed: 12345 });
    room.autoDispose = false;
    const orch = asGameRoom(room).getOrchestrator();
    orch.setLastStandingThreshold(-1);
    orch.start();
    const orchUpdate = () => orch.update(1000 / 60);
    for (let i = 0; i < 5; i++) orchUpdate();

    const tileGrid = orch.getMatch()!.getGrid();
    const rows = tileGrid.length;
    const cols = tileGrid[0]!.length;
    console.log(`demo grid ${rows}x${cols}. Full TileType map:`);
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const t = tileGrid[r]![c]!;
        // single char code
        if (t === TileType.EMPTY) line += '.';
        else if (t === TileType.EXIT) line += 'E';
        else if (t === TileType.DESTRUCTIBLE_WALL)
          line += 'w'; // breakable wall
        else if (t === TileType.DESTRUCTIBLE_CRATE) line += 'c';
        else if (t === TileType.DESTRUCTIBLE_BARREL) line += 'b';
        else if (t === TileType.INDESTRUCTIBLE_WALL) line += '#';
        else if (t === TileType.INDESTRUCTIBLE_CRATE) line += 'O';
        else if (t === TileType.CHEST) line += '$';
        else line += '?';
      }
      console.log(line);
    }
    console.log(
      'Legend: .=EMPTY E=EXIT w=DESTRUCTIBLE_WALL c=CRATE b=BARREL #=INDESTRUCTIBLE_WALL O=INDESTRUCTIBLE_CRATE $=CHEST',
    );
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
