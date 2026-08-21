/**
 * Diagnostic: dump spawn point positions and bot assignments for analysis.
 */
import { MapGenerator as SharedMapGenerator } from '@sector-battle/shared';

const gen = new SharedMapGenerator();
const seed = 50481; // same seed as benchmark R1
const mapData = gen.generate(seed);

const spawns = mapData.spawnPoints;

console.log(`\n=== SPAWN POINTS (${spawns.length} total) ===`);
console.log(`Map size: ${mapData.globalBounds.width}×${mapData.globalBounds.height}px`);

// Sort by priority (how SpawnService sees them)
const sorted = [...spawns].sort((a, b) => a.priority - b.priority);

// Group by sector
const sectorMap = new Map<string, SpawnPoint[]>();
for (const sp of spawns) {
  const key = `R${sp.sectorCoord.row}C${sp.sectorCoord.col}`;
  if (!sectorMap.has(key)) sectorMap.set(key, []);
  sectorMap.get(key)!.push(sp);
}

console.log(`\n=== SECTOR DISTRIBUTION (4×4 grid) ===`);
const SECTOR_GRID = 4;
for (let r = 0; r < SECTOR_GRID; r++) {
  let rowStr = '';
  for (let c = 0; c < SECTOR_GRID; c++) {
    const key = `R${r}C${c}`;
    const count = sectorMap.get(key)?.length ?? 0;
    rowStr += `[${count}] `;
  }
  console.log(`  Row ${r}: ${rowStr}`);
}

// Show position distribution in 4x4 quadrants of the map
const mapSize = mapData.globalBounds.width;
const quadSize = mapSize / 4;
console.log(`\n=== POSITION HEATMAP (4×4 quadrants, ${quadSize.toFixed(0)}px each) ===`);
const quadCounts: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
for (const sp of spawns) {
  const qx = Math.floor(sp.x / quadSize);
  const qy = Math.floor(sp.y / quadSize);
  if (qx >= 0 && qx < 4 && qy >= 0 && qy < 4) quadCounts[qy][qx]++;
}

for (let r = 0; r < 4; r++) {
  console.log(`  Q-Row ${r}: ${quadCounts[r].map((c) => `[${String(c).padStart(2)}]`).join(' ')}`);
}

// Simulate SpawnService.assignBatch for 64 bots
const botCount = 64;
const step = Math.max(1, Math.floor(sorted.length / botCount));
console.log(`\n=== BATCH ASSIGNMENT (${botCount} bots, step=${step}) ===`);
const assignments: { x: number; y: number; sectorKey: string }[] = [];
for (let i = 0; i < botCount; i++) {
  const idx = (i * step) % sorted.length;
  const sp = sorted[idx];
  assignments.push({
    x: Math.round(sp.x),
    y: Math.round(sp.y),
    sectorKey: `R${sp.sectorCoord.row}C${sp.sectorCoord.col}`,
  });
}

// Show which sectors bots landed in
const botSectors = new Map<string, number>();
for (const a of assignments) {
  botSectors.set(a.sectorKey, (botSectors.get(a.sectorKey) ?? 0) + 1);
}

console.log(`\n=== BOT DISTRIBUTION ACROSS SECTORS ===`);
for (let r = 0; r < SECTOR_GRID; r++) {
  let rowStr = '';
  for (let c = 0; c < SECTOR_GRID; c++) {
    const key = `R${r}C${c}`;
    const count = botSectors.get(key) ?? 0;
    rowStr += `[${String(count).padStart(2)}] `;
  }
  console.log(`  Row ${r}: ${rowStr}`);
}

// Distance analysis
console.log(`\n=== SPAWN POSITIONS (first 20) ===`);
for (let i = 0; i < Math.min(20, sorted.length); i++) {
  const sp = sorted[i];
  const distToCenter = Math.sqrt((sp.x - mapSize / 2) ** 2 + (sp.y - mapSize / 2) ** 2);
  console.log(
    `  #${i} pri=${sp.priority} pos=(${Math.round(sp.x)},${Math.round(sp.y)}) distCenter=${Math.round(distToCenter)} sector=R${sp.sectorCoord.row}C${sp.sectorCoord.col}`,
  );
}

console.log(`\nMap center: (${mapSize / 2}, ${mapSize / 2})`);
console.log(`Corner distance from center: ${Math.round((Math.sqrt(2) * mapSize) / 2)}px`);
