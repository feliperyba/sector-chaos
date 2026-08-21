/**
 * Verifies that weapon entities exist on the demo map at runtime.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

const server = await createTestServer();
const { room, helper } = await createGameRoom(server, {
  mapType: 'demo',
  botFillTo: 2,
});

const client = await connectClient(server, room, { name: 'verify' } as any);
await room.waitForNextPatch();
await helper.advanceTicks(10);

const sim = (room as any).getOrchestrator?.()?.simulation;
const match = sim?.match;
if (!match) {
  console.error('No match');
  process.exit(1);
}

// Check weaponPickups
const wps = (match as any).weaponPickups;
if (wps) {
  const wpList = Array.isArray(wps) ? wps : [...(wps.values?.() ?? [])];
  console.log(`WeaponPickups: ${wpList.length} total`);
  for (const wp of wpList) {
    const pos = wp.position || wp;
    console.log(
      `  id=${wp.id} type=${wp.weaponType ?? wp.type} pos=(${pos?.x},${pos?.y}) taken=${wp.isPickedUp ?? wp.taken ?? 'n/a'}`,
    );
  }
} else {
  console.log('No weaponPickups found');
}

// Check chests
const chests = (match as any).chests;
if (chests) {
  const chestList = Array.isArray(chests) ? chests : [...(chests.values?.() ?? [])];
  console.log(`\nChests: ${chestList.length} total`);
  for (const c of chestList.slice(0, 5)) {
    const pos = c.position || c;
    console.log(`  id=${c.id} pos=(${pos?.x},${pos?.y}) opened=${c.isOpen ?? c.opened}`);
  }
}

// Check traps
const traps = (match as any).traps;
if (traps) {
  const trapList = Array.isArray(traps) ? traps : [...(traps.values?.() ?? [])];
  console.log(`\nTraps: ${trapList.length} total`);
  for (const t of trapList.slice(0, 5)) {
    const pos = t.position || t;
    console.log(`  id=${t.id} type=${t.type} pos=(${pos?.x},${pos?.y})`);
  }
}

// Check destructibles
const destructibles = match.getDestructibles?.() ?? (match as any).destructibles;
if (destructibles) {
  const desList = Array.isArray(destructibles)
    ? destructibles
    : [...(destructibles.values?.() ?? [])];
  console.log(`\nDestructibles: ${desList.length} total`);
  const byType: Record<string, number> = {};
  for (const d of desList) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
  }
  console.log('  by type:', JSON.stringify(byType));
}

await cleanup(server);
process.exit(0);
