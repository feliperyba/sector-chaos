import { MapGenerator as SharedMapGenerator } from '@sector-battle/shared';

const gen = new SharedMapGenerator();

// Check 3 different seeds
for (const seed of [50481, 58683, 12345]) {
  const mapData = gen.generate(seed);
  const spawns = mapData.spawnPoints;
  const mapSize = mapData.globalBounds.width;

  // Bin into 8x8 grid for finer analysis
  const bins = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (const sp of spawns) {
    const bx = Math.min(7, Math.floor(sp.x / (mapSize / 8)));
    const by = Math.min(7, Math.floor(sp.y / (mapSize / 8)));
    bins[by][bx]++;
  }

  console.log(`\n=== Seed ${seed}: 8×8 position grid ===`);
  for (let r = 0; r < 8; r++) {
    console.log(`  ${bins[r]!.map((c) => String(c).padStart(2)).join(' ')}`);
  }

  // Distance from center for all spawns
  const cx = mapSize / 2,
    cy = mapSize / 2;
  const dists = spawns.map((s) => Math.round(Math.sqrt((s.x - cx) ** 2 + (s.y - cy) ** 2)));
  dists.sort((a, b) => a - b);
  console.log(
    `  Dist range: ${dists[0]}-${dists[dists.length - 1]}px, median=${dists[Math.floor(dists.length / 2)]}`,
  );
  console.log(`  Map center: (${cx},${cy}), half-size: ${mapSize / 2}px`);

  // Count spawns within zone radius (5120)
  const inZone = spawns.filter((s) => Math.sqrt((s.x - cx) ** 2 + (s.y - cy) ** 2) < 5120).length;
  console.log(`  Spawns inside zone radius (5120): ${inZone}/${spawns.length}`);

  // Count spawns near borders (< 512px from map edge)
  const nearBorder = spawns.filter(
    (s) => s.x < 512 || s.y < 512 || s.x > mapSize - 512 || s.y > mapSize - 512,
  ).length;
  console.log(`  Spawns within 512px of map border: ${nearBorder}/${spawns.length}`);
}
