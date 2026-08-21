/**
 * Track a single bot over time to see if it navigates toward its nearest weapon.
 */
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';
import type { GameRoom } from '../src/room/GameRoom.ts';

interface CtxLike {
  x: number;
  y: number;
  state: number;
  tick: number;
  nearestWeapon: { distance: number; x: number; y: number; id: string } | null;
  path: { x: number; y: number }[] | null;
  hasRealWeapon(): boolean;
  stuckStartTick: number;
  health: number;
}

interface OrchLike {
  getBotSystem(): { bots: Map<string, CtxLike> } | null;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
  getMatch(): { players: Map<string, unknown> } | undefined;
}

function asGameRoom(room: unknown): GameRoom {
  return room as GameRoom;
}

const STATE_NAMES = [
  'FLEE_ZONE',
  'SEEK_WEAPON',
  'ENGAGE',
  'RETREAT',
  'LOOT',
  'HUNT',
  'WANDER',
  'DEMOLITION',
];

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
    const orch = asGameRoom(room).getOrchestrator() as unknown as OrchLike;
    orch.setLastStandingThreshold(-1);

    const start = Date.now();
    while ((orch.getMatch()?.players.size ?? 0) < 8 && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    orch.setLastStandingThreshold(1);
    orch.start();

    const TICK = 1000 / 60;
    // First, run a few ticks so bots populate perception
    for (let i = 0; i < 10; i++) orch.update(TICK);

    const bots = orch.getBotSystem()!.bots;
    // Pick the bot with the nearest weapon
    let target: { id: string; ctx: CtxLike } | null = null;
    let bestDist = Infinity;
    for (const [id, ctx] of bots) {
      if (ctx.nearestWeapon && ctx.nearestWeapon.distance < bestDist) {
        bestDist = ctx.nearestWeapon.distance;
        target = { id, ctx };
      }
    }

    if (!target) {
      console.log('No bot with a nearest weapon found');
      return;
    }

    console.log(`Tracking bot ${target.id.slice(-4)}, nearest weapon at d=${Math.round(bestDist)}`);
    console.log(
      'tick | state          | botPos          | weaponPos       | dist  | pathLen | stuckStart | health',
    );

    for (let i = 0; i < 600; i++) {
      orch.update(TICK);
      const ctx = bots.get(target.id);
      if (!ctx) {
        console.log('bot gone');
        break;
      }
      if (i % 30 === 0 || ctx.hasRealWeapon()) {
        const w = ctx.nearestWeapon;
        const dist = w ? Math.round(Math.hypot(ctx.x - w.x, ctx.y - w.y)) : -1;
        console.log(
          `${String(ctx.tick).padStart(5)} | ${STATE_NAMES[ctx.state]!.padEnd(14)} | ` +
            `(${Math.round(ctx.x).toString().padStart(4)},${Math.round(ctx.y).toString().padStart(4)}) | ` +
            `${w ? `(${Math.round(w.x).toString().padStart(4)},${Math.round(w.y).toString().padStart(4)})` : '(----,----)'} | ` +
            `${String(dist).padStart(5)} | ${ctx.path ? String(ctx.path.length - ctx.pathCursor).padStart(7) : '   null'} | ` +
            `${String(ctx.stuckStartTick).padStart(10)} | ${Math.round(ctx.health)}`,
        );
        if (ctx.hasRealWeapon()) {
          console.log('>>> BOT GOT A WEAPON!');
          break;
        }
      }
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
