/**
 * Diagnostic: inspect why bots don't pick up weapons.
 * Runs a short fast-forward loop, then reports:
 *   - how many weapon pickups exist on the map
 *   - how many bots have a real weapon
 *   - nearest weapon distance per bot
 *   - whether bots' nearest-weapon perception is populated
 */
import { WeaponType } from '@sector-battle/shared';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';
import type { GameRoom } from '../src/room/GameRoom.ts';

interface DomainPlayerLike {
  id: string;
  isAlive(): boolean;
  health: { current: number };
  inventory: { weapons: Array<{ type: WeaponType } | null> };
}

interface OrchLike {
  getMatch():
    | {
        players: Map<string, DomainPlayerLike>;
        weaponPickups: Map<string, { isActive: boolean; position: { x: number; y: number } }>;
      }
    | undefined;
  getBotSystem(): {
    bots: Map<
      string,
      {
        nearestWeapon: { distance: number; x: number; y: number } | null;
        hasRealWeapon(): boolean;
        x: number;
        y: number;
        state: number;
      }
    >;
  } | null;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
}

function asGameRoom(room: unknown): GameRoom {
  return room as GameRoom;
}

async function main() {
  const server = await createTestServer();
  try {
    const room = await createRoom(server, {
      botFillTo: 16,
      botDifficulty: 'hard',
      mapType: 'demo',
      seed: 12345,
    });
    room.autoDispose = false;
    const orch = asGameRoom(room).getOrchestrator() as unknown as OrchLike;
    orch.setLastStandingThreshold(-1);

    // wait for bots
    const start = Date.now();
    while ((orch.getMatch()?.players.size ?? 0) < 16 && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    orch.setLastStandingThreshold(1);
    orch.start();

    // Run ~600 ticks (10s game-time) to let bots spawn + start navigating
    const TICK = 1000 / 60;
    for (let i = 0; i < 600; i++) orch.update(TICK);

    const match = orch.getMatch()!;
    const pickups = match.weaponPickups;
    let activePickups = 0;
    let totalPickups = 0;
    for (const [, p] of pickups) {
      totalPickups++;
      if (p.isActive) activePickups++;
    }
    console.log(`weaponPickups on map: ${totalPickups} total, ${activePickups} active`);

    const bots = orch.getBotSystem()!.bots;
    let armed = 0;
    let withNearestWeapon = 0;
    let noStateWeapon = 0;
    const stateCounts: Record<number, number> = {};
    let idx = 0;
    for (const [id, ctx] of bots) {
      idx++;
      if (ctx.hasRealWeapon()) armed++;
      if (ctx.nearestWeapon) {
        withNearestWeapon++;
      } else {
        noStateWeapon++;
      }
      stateCounts[ctx.state] = (stateCounts[ctx.state] ?? 0) + 1;
      if (idx <= 5) {
        console.log(
          `bot ${id.slice(-4)}: pos=(${Math.round(ctx.x)},${Math.round(ctx.y)}) state=${ctx.state} ` +
            `armed=${ctx.hasRealWeapon()} nearestWeapon=${ctx.nearestWeapon ? `d=${Math.round(ctx.nearestWeapon.distance)} at (${Math.round(ctx.nearestWeapon.x)},${Math.round(ctx.nearestWeapon.y)})` : 'NULL'}`,
        );
      }
    }
    console.log(
      `\nBOTS: ${bots.size} total, ${armed} armed, ${withNearestWeapon} have nearestWeapon set, ${noStateWeapon} do NOT`,
    );
    console.log(`state distribution: ${JSON.stringify(stateCounts)}`);

    // Check a bot's nearest pickup distance manually
    const playerList = Array.from(match.players.values()).filter((p) => p.id.startsWith('bot_'));
    if (playerList.length > 0 && activePickups > 0) {
      let sampleBot = playerList[0]!;
      let nearestPickup = Infinity;
      for (const [, p] of pickups) {
        if (!p.isActive) continue;
        const dx = p.position.x - ((sampleBot.inventory as unknown as never) ? 0 : 0);
        void dx;
      }
      // simpler: pick a bot and find its nearest pickup
      const botIds = Array.from(bots.keys());
      for (const bid of botIds.slice(0, 3)) {
        const p = match.players.get(bid);
        if (!p) continue;
        // bot position from player domain object isn't accessible via this type; use ctx
        const ctx = bots.get(bid)!;
        let nd = Infinity;
        for (const [, pk] of pickups) {
          if (!pk.isActive) continue;
          const d = Math.hypot(pk.position.x - ctx.x, pk.position.y - ctx.y);
          if (d < nd) nd = d;
        }
        console.log(
          `bot ${bid.slice(-4)} at (${Math.round(ctx.x)},${Math.round(ctx.y)}): nearest active pickup = ${Math.round(nd)}px`,
        );
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
