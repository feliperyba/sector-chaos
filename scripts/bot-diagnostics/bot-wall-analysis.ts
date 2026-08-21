/**
 * Wall analysis: how many wall tiles block the path to weapons?
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';

async function main() {
  const server = await createTestServer();
  const { room, helper } = await createGameRoom(server, {
    matchId: `wall-diag-${Date.now()}`,
    seed: 42,
    botFillTo: 2,
    mapType: 'demo',
  });
  const client = await connectClient(server, room, { name: 'Diag' });
  await room.waitForNextPatch();
  await helper.advanceTicks(460);

  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const matchFlow = orch.matchFlow;
  if (matchFlow.getCurrentState().phase === MatchPhase.WAITING)
    matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;

  const match = orch.match ?? orch.simulation?.match;
  const state = match?.getState?.() ?? match?.state;

  // Wall destructibles
  console.log('=== WALL DESTRUCTIBLES ===');
  const walls: { id: string; x: number; y: number; gx: number; gy: number }[] = [];
  for (const [id, d] of state.destructibles) {
    if (d.type === 'wall') {
      walls.push({
        id,
        x: Math.round(d.position.x),
        y: Math.round(d.position.y),
        gx: Math.floor(d.position.x / 128),
        gy: Math.floor(d.position.y / 128),
      });
    }
  }
  walls.sort((a, b) => a.y - b.y);
  for (const w of walls) {
    console.log(`  ${w.id}: pos=(${w.x},${w.y}) tile=(${w.gx},${w.gy})`);
  }
  console.log(`Total walls: ${walls.length}`);

  // Weapon positions
  console.log('\n=== WEAPON POSITIONS ===');
  const weapons: { x: number; y: number; gx: number; gy: number }[] = [];
  for (const [id, wp] of state.weaponPickups) {
    if (!wp.isActive) continue;
    weapons.push({
      x: Math.round(wp.position.x),
      y: Math.round(wp.position.y),
      gx: Math.floor(wp.position.x / 128),
      gy: Math.floor(wp.position.y / 128),
    });
  }
  weapons.sort((a, b) => a.y - b.y);
  for (const w of weapons.slice(0, 5)) {
    console.log(`  pos=(${w.x},${w.y}) tile=(${w.gx},${w.gy})`);
  }
  console.log(`  ... ${weapons.length} total weapons`);
  console.log(
    `  Weapon tile X range: ${Math.min(...weapons.map((w) => w.gx))}-${Math.max(...weapons.map((w) => w.gx))}`,
  );
  console.log(
    `  Weapon tile Y range: ${Math.min(...weapons.map((w) => w.gy))}-${Math.max(...weapons.map((w) => w.gy))}`,
  );

  // Wall X positions
  const wallXs = [...new Set(walls.map((w) => w.gx))].sort();
  console.log(`\n  Wall columns (tile X): ${wallXs.join(', ')}`);
  console.log(
    `  Weapons are at X=${Math.min(...weapons.map((w) => w.gx))}-${Math.max(...weapons.map((w) => w.gx))}`,
  );
  console.log(`  Walls at X=${wallXs.join(',')} block access from the right`);

  // How many wall tiles at the critical X=6 column?
  const criticalWalls = walls.filter((w) => w.gx === 6);
  console.log(`\n  Wall tiles at X=6: ${criticalWalls.length}`);
  console.log(`  Y positions: ${criticalWalls.map((w) => w.gy).join(',')}`);

  // Test pathfinding: bot at tile (8,8) to weapon at tile (3,2)
  const botSystem = orch.simulation?.botSystem ?? (orch as any).botSystem;
  const pf = botSystem?.pathfinder ?? (gameRoom as any).pathfinder;
  if (!pf) {
    console.log('Pathfinder not found, skipping path test');
  } else {
    console.log('\n=== PATHFINDING TEST ===');
    const fromTile = { x: 8, y: 8 };
    const toTile = { x: 3, y: 2 };

    // Build destructible map
    const destructMap = new Map<string, number>();
    for (const w of walls) {
      destructMap.set(`${w.gx},${w.gy}`, 5);
    }

    console.log(
      `Start walkable (${fromTile.x},${fromTile.y}): ${pf.isWalkable(fromTile.x, fromTile.y)}`,
    );
    console.log(`End walkable (${toTile.x},${toTile.y}): ${pf.isWalkable(toTile.x, toTile.y)}`);
    console.log(`Grid size: ${pf.grid?.length} x ${pf.grid?.[0]?.length}`);
    // Check a few tiles around X=6 (wall column)
    for (let y = 1; y <= 6; y++) {
      console.log(
        `  tile(6,${y}) walkable=${pf.isWalkable(6, y)} in destrMap=${destructMap.has('6,' + y)}`,
      );
    }

    // Direct path (through walls = impossible)
    const directPath = pf.findPath(fromTile, toTile);
    console.log(
      `Direct path (8,8)→(3,2): ${directPath ? directPath.length + ' steps' : 'BLOCKED'}`,
    );

    // Through destructibles
    const destrPath = pf.findPathThroughDestructibles(fromTile, toTile, destructMap);
    console.log(`Through destructibles: ${destrPath ? destrPath.length + ' waypoints' : 'null'}`);
    if (destrPath) {
      for (let i = 0; i < destrPath.length; i++) {
        const p = destrPath[i]!;
        const isDestruct = destructMap.has(`${p.x},${p.y}`);
        console.log(`  wp${i}: (${p.x},${p.y}) ${isDestruct ? '← WALL' : ''}`);
      }
    }
  }

  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
