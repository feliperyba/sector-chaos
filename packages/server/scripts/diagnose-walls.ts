import { MapGenerator } from '../src/domain/services/MapGenerator.ts';
import { SeedMapAdapter } from '../src/infrastructure/map/SeedMapAdapter.ts';
import { WallOrientationDetector } from '../src/infrastructure/map/WallOrientationDetector.ts';
import { classifyWall, WALL_MASK_BITS, type WallRole } from '../src/infrastructure/map/WallMaskClassifier.ts';
import { resolve } from 'node:path';

const gen = new MapGenerator();
const mapResult = gen.generate(42);
const adapter = new SeedMapAdapter();
const enriched = adapter.adapt(mapResult.rawMapData!, 42, resolve('tiled'));

const detector = new WallOrientationDetector();
const orientations = detector.detect(enriched.grid);

// Role abbreviations
const ROLE_ABBR: Record<WallRole, string> = {
  straight: 'S',
  outer_corner: 'O',
  inner_corner: 'I',
  t_junction: 'T',
  cross: 'X',
  endcap: 'E',
  isolated: 'P',
  diagonal: 'D',
};

// Dump one sector
function dumpSector(sr: number, sc: number, label: string) {
  const r0 = sr * 20, c0 = sc * 20;

  // Find sector type
  const sectorInfo = mapResult.rawMapData?.sectors?.find((s: any) => s.gridRow === sr && s.gridCol === sc);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SECTOR (${sr},${sc}) — ${label}${sectorInfo ? ` type=${sectorInfo.type} sub=${sectorInfo.subVariantId}` : ''}`);
  console.log(`${'='.repeat(80)}`);

  // Raw grid
  console.log('\n--- RAW GRID (0=empty, 1=indestr, 2=destr, 6=crate, 7=barrel, 8=iron) ---');
  console.log('     ' + Array.from({length: 20}, (_, i) => String(i).padStart(2)).join(' '));
  for (let r = r0; r < r0 + 20; r++) {
    let row = `r${String(r - r0).padStart(2, '0')}: `;
    for (let c = c0; c < c0 + 20; c++) {
      row += String(enriched.grid[r]?.[c] ?? '?').padStart(2) + ' ';
    }
    console.log(row);
  }

  // Roles
  console.log('\n--- WALL ROLES (S=straight O=outer_corner I=inner_corner X=cross E=endcap P=pillar D=diag T=tjay) ---');
  console.log('     ' + Array.from({length: 20}, (_, i) => String(i).padStart(3)).join(''));
  for (let r = r0; r < r0 + 20; r++) {
    let row = `r${String(r - r0).padStart(2, '0')}: `;
    for (let c = c0; c < c0 + 20; c++) {
      const mask = orientations[r]?.[c];
      if (mask === null || mask === undefined) {
        row += ' . ';
        continue;
      }
      const isInternal = r % 20 !== 0 && r % 20 !== 19 && c % 20 !== 0 && c % 20 !== 19;
      const choice = classifyWall(mask, { isInternal });
      const abbr = ROLE_ABBR[choice.role] || '?';
      row += abbr + String(choice.rotation).padStart(2, ' ').substring(0, 2);
    }
    console.log(row);
  }

  // Sprite IDs
  console.log('\n--- WALL LAYER SPRITES (spriteId:rotation) ---');
  const wallLayer = enriched.visualLayers.find(l => l.name === 'map_border_walls');
  if (wallLayer) {
    // Build sprite name lookup
    const spriteNames = new Map<number, string>();
    for (const s of enriched.atlas.sprites) {
      spriteNames.set(s.id, s.imagePath);
    }

    console.log('     ' + Array.from({length: 20}, (_, i) => String(i).padStart(7)).join(' '));
    for (let r = r0; r < r0 + 20; r++) {
      let row = `r${String(r - r0).padStart(2, '0')}: `;
      for (let c = c0; c < c0 + 20; c++) {
        const cell = wallLayer.cells[r]?.[c];
        if (!cell) {
          row += '   .    ';
          continue;
        }
        const name = spriteNames.get(cell.spriteId) ?? '????';
        const shortName = name.substring(0, 5);
        row += shortName.padEnd(5) + ':' + String(cell.rotation).padStart(3) + ' ';
      }
      console.log(row);
    }
  }
}

// Count role distribution across entire map
console.log('\n\n=== FULL MAP ROLE DISTRIBUTION ===');
const roleCounts: Record<string, number> = {};
let totalWalls = 0;
for (let r = 0; r < 80; r++) {
  for (let c = 0; c < 80; c++) {
    const mask = orientations[r]?.[c];
    if (mask === null || mask === undefined) continue;
    totalWalls++;
    const choice = classifyWall(mask);
    roleCounts[choice.role] = (roleCounts[choice.role] ?? 0) + 1;
  }
}
console.log(`Total wall tiles: ${totalWalls}`);
for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / totalWalls) * 100).toFixed(1);
  console.log(`  ${role.padEnd(15)} ${String(count).padStart(4)} (${pct}%)`);
}

// Dump a few different sector types
dumpSector(0, 0, 'top-left');
dumpSector(1, 1, 'center');
dumpSector(2, 3, 'bottom-right');
