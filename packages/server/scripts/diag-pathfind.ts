/**
 * Direct pathfinder test: after match setup, query findPath for known bot->weapon pairs.
 */
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';
import type { GameRoom } from '../src/room/GameRoom.ts';

interface CtxLike {
  x: number;
  y: number;
  nearestWeapon: { distance: number; x: number; y: number; id: string } | null;
}

interface PfLike {
  findPath(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): { x: number; y: number }[] | null;
  worldToGrid(p: { x: number; y: number }): { x: number; y: number };
  isWalkable(x: number, y: number): boolean;
  gridToWorld(p: { x: number; y: number }): { x: number; y: number };
  getTileSize(): number;
  isInMainRegion(x: number, y: number): boolean;
}

interface BotSystemLike {
  bots: Map<string, CtxLike>;
  pathfinder: PfLike;
}

interface OrchLike {
  getBotSystem(): BotSystemLike | null;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
  getMatch(): { players: Map<string, unknown> } | undefined;
}

function asGameRoom(room: unknown): { getOrchestrator(): OrchLike } {
  return room as { getOrchestrator(): OrchLike };
}

async function main() {
  const server = await createTestServer();
  try {
    const room = await createRoom(server, {
      botFillTo: 8,
      botDifficulty: 'hard',
      mapType: 'demo',
      seed: 12345,
    });
    room.autoDispose = false;
    const orch = asGameRoom(room).getOrchestrator();
    orch.setLastStandingThreshold(-1);

    const start = Date.now();
    while ((orch.getMatch()?.players.size ?? 0) < 8 && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    orch.setLastStandingThreshold(1);
    orch.start();

    const TICK = 1000 / 60;
    for (let i = 0; i < 60; i++) orch.update(TICK);

    const botSystem = orch.getBotSystem()!;
    const pf = botSystem.pathfinder;
    const bots = botSystem.bots;

    console.log(`tileSize = ${pf.getTileSize()}`);
    let n = 0;
    for (const [id, ctx] of bots) {
      if (n++ >= 5) break;
      const w = ctx.nearestWeapon;
      if (!w) {
        console.log(`bot ${id.slice(-4)}: no nearest weapon`);
        continue;
      }
      const fromGrid = pf.worldToGrid({ x: ctx.x, y: ctx.y });
      const fromX = fromGrid.x,
        fromY = fromGrid.y;
      const toGrid = pf.worldToGrid({ x: w.x, y: w.y });
      const toX = toGrid.x,
        toY = toGrid.y;
      const fromWalk = pf.isWalkable(fromX, fromY);
      const toWalk = pf.isWalkable(toX, toY);
      const fromRegion = pf.isInMainRegion(fromX, fromY);
      const toRegion = pf.isInMainRegion(toX, toY);
      const path = pf.findPath({ x: ctx.x, y: ctx.y }, { x: w.x, y: w.y });
      console.log(
        `bot ${id.slice(-4)} at (${Math.round(ctx.x)},${Math.round(ctx.y)}) grid(${fromX},${fromY}) ` +
          `walk=${fromWalk} region=${fromRegion} -> weapon (${Math.round(w.x)},${Math.round(w.y)}) grid(${toX},${toY}) ` +
          `walk=${toWalk} region=${toRegion} | path=${path ? path.length + ' nodes' : 'NULL'}`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
