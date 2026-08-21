// Map analysis: weapon positions, wall types, and reachability
import { resolve } from 'path';

const OUT = resolve(process.cwd(), '.reference/map-analysis.json');

// Parse the TMX to find weapon spawn positions and wall types
import { readFileSync } from 'fs';
const tmx = readFileSync('tiled/demo_map.tmx', 'utf-8');

// Extract tile data
const tileMatch = tmx.match(/name="interactive_layer"[\s\S]*?<data[^>]*>([\s\S]*?)<\/data>/);
if (!tileMatch) {
  console.error('No interactive layer found');
  process.exit(1);
}

const tiles = tileMatch[1]!
  .trim()
  .split(',')
  .map((t) => parseInt(t.trim()));
const MAP_W = 22;
const MAP_H = 22;

// Decode Tiled flags
function decodeTiledId(raw: number) {
  const flippedH = !!(raw & 0x80000000);
  const flippedV = !!(raw & 0x40000000);
  const flippedAD = !!(raw & 0x20000000);
  const flippedD = !!(raw & 0x10000000);
  const tileId = raw & 0x0fffffff;
  return { tileId, flippedH, flippedV };
}

// Count tile types
const typeCounts: Record<number, number> = {};
for (const t of tiles) {
  if (t === 0) continue;
  const { tileId } = decodeTiledId(t);
  typeCounts[tileId] = (typeCounts[tileId] || 0) + 1;
}
console.log('Tile ID counts:', JSON.stringify(typeCounts, null, 2));

// Find weapon/chest/item tiles (typically IDs 50+ based on earlier analysis)
// Iron walls = certain tile IDs, breakable = others
// From earlier analysis: 71 breakable, 46 iron, 117 total destructibles

// Print a simple ASCII map showing walls and open spaces
let ascii = '';
for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    const raw = tiles[y * MAP_W + x]!;
    if (raw === 0) {
      ascii += '.'; // empty
    } else {
      const { tileId } = decodeTiledId(raw);
      // Known wall tile IDs from earlier analysis
      // ID 1-9: walls/barrels (breakable)
      // ID 35+: various structures
      // High-count IDs: 9(12), 43(9), 7(6), 21(5), 17(5), 8(5), 3(9), 2(5), 1(4)
      // These are the interactive layer tiles
      ascii += tileId.toString(16).padStart(2, '0') + ' ';
      if (x < MAP_W - 1) {
        // remove extra space for alignment
      }
    }
  }
  ascii += '\n';
}

// Simplified: show just walls vs empty
let simple = 'Map (22x22): # = wall/destructible, . = empty\n';
for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    const raw = tiles[y * MAP_W + x]!;
    simple += raw === 0 ? '.' : '#';
  }
  simple += '\n';
}
console.log(simple);
