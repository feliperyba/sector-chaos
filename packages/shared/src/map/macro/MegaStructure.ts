import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import type { CompoundInfo, CompoundVariant } from './MacroTypes.js';
import {
  buildCrossPartitionTemplate,
  buildCourtyardRingTemplate,
  buildLootArmTemplate,
  buildPillaredHallTemplate,
  type CompoundTemplateResult,
} from './MegaStructureTemplates.js';
import {
  CITADEL_CHANCE,
  CITADEL_SEAMS,
  CITADEL_SIZE,
  buildCitadelTemplate,
  citadelSeamBlockedByHighway,
} from './MegaStructureCitadel.js';

/** Map edge index that must never be touched (outer perimeter wall). */
const PERIMETER_LAST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE - 1; // 79

/**
 * The four center-sector seams a 10×10 compound may span. Each origin places
 * the footprint so that it straddles a boundary between two of the four
 * inner 2×2 sectors (rows/cols 20–59), making the compound THE central
 * landmark players orient around.
 *
 * Index meaning (sector coords):
 *   0 — E-W seam between (1,1) and (1,2)
 *   1 — E-W seam between (2,1) and (2,2)
 *   2 — N-S seam between (1,1) and (2,1)
 *   3 — N-S seam between (1,2) and (2,2)
 */
const CENTER_SEAMS: readonly { originRow: number; originCol: number }[] = [
  { originRow: 25, originCol: 35 },
  { originRow: 45, originCol: 35 },
  { originRow: 35, originCol: 25 },
  { originRow: 35, originCol: 45 },
];

type CompoundTemplateBuilder = (rng: SeededRNG) => CompoundTemplateResult;

const COMPOUND_TEMPLATES: readonly CompoundTemplateBuilder[] = [
  buildCrossPartitionTemplate,
  buildPillaredHallTemplate,
  buildCourtyardRingTemplate,
  buildLootArmTemplate,
];

/**
 * Descriptive variant family per template (index-aligned with
 * `COMPOUND_TEMPLATES`). Map-redesign ticket 03: feeds the designation's
 * fortress-family word (DEC-010); ticket 06 adds LOOT_ARM (+ the Citadel,
 * authored separately in MegaStructureCitadel.ts).
 */
const COMPOUND_VARIANTS: readonly CompoundVariant[] = [
  'CROSS_PARTITION',
  'PILLARED_HALL',
  'COURTYARD_RING',
  'LOOT_ARM',
];

/** The standard (10×10) placement path — unchanged template mechanics. */
function placeStandardCompound(rng: SeededRNG): {
  originRow: number;
  originCol: number;
  size: number;
  variant: CompoundVariant;
  template: TileType[][];
  chests: Array<{ row: number; col: number }>;
  traps: Array<{ row: number; col: number }>;
  beaconAnchor: { row: number; col: number };
  vault: null;
  entryGaps: Array<{ side: 'top' | 'bottom' | 'left' | 'right'; row: number; col: number }>;
} {
  const seamIdx = rng.nextInt(0, CENTER_SEAMS.length - 1);
  const seam = CENTER_SEAMS[seamIdx]!;

  const templateIdx = rng.nextInt(0, COMPOUND_TEMPLATES.length - 1);
  const result = COMPOUND_TEMPLATES[templateIdx]!(rng);

  // Entry-gap bookkeeping: re-derive the punched gaps from the final template
  // (a gap cell is a border cell that is EMPTY — pure geometry, no RNG).
  const entryGaps: Array<{ side: 'top' | 'bottom' | 'left' | 'right'; row: number; col: number }> =
    [];
  const SIZE = result.tiles.length;
  for (let i = 1; i < SIZE - 1; i++) {
    if (result.tiles[0]![i] === TileType.EMPTY) entryGaps.push({ side: 'top', row: 0, col: i });
    if (result.tiles[SIZE - 1]![i] === TileType.EMPTY)
      entryGaps.push({ side: 'bottom', row: SIZE - 1, col: i });
    if (result.tiles[i]![0] === TileType.EMPTY) entryGaps.push({ side: 'left', row: i, col: 0 });
    if (result.tiles[i]![SIZE - 1] === TileType.EMPTY)
      entryGaps.push({ side: 'right', row: i, col: SIZE - 1 });
  }

  return {
    originRow: seam.originRow,
    originCol: seam.originCol,
    size: SIZE,
    variant: COMPOUND_VARIANTS[templateIdx]!,
    template: result.tiles,
    chests: [...result.chests],
    traps: [],
    beaconAnchor: result.beacon,
    vault: null,
    entryGaps,
  };
}

/** The rare 14×14 Citadel placement path (map-redesign ticket 06 / DEC-004.1). */
function placeCitadel(rng: SeededRNG, highwayCarvedTiles: Set<string>) {
  // Seam selection: prefer a seam the highway does not touch AT ALL (one
  // always exists — an H-highway cuts the two E-W seams but leaves the N-S
  // seams clean, and vice versa), falling back to a seam whose vault-critical
  // block alone is clean (a crossing then reads as an extra entrance). The
  // candidate order is drawn from the isolated CITD stream.
  const order = rng.shuffle([0, 1, 2, 3]);
  let best = order[0]!;
  let bestLevel = Number.MAX_SAFE_INTEGER;
  for (const idx of order) {
    const seam = CITADEL_SEAMS[idx]!;
    let level = 0;
    if (citadelSeamBlockedByHighway(seam, highwayCarvedTiles)) level = 2;
    else if (footprintTouchesHighway(seam, highwayCarvedTiles)) level = 1;
    if (level < bestLevel) {
      best = idx;
      bestLevel = level;
      if (level === 0) break;
    }
  }
  const seam = CITADEL_SEAMS[best]!;

  const citadel = buildCitadelTemplate(rng);
  return {
    originRow: seam.originRow,
    originCol: seam.originCol,
    size: CITADEL_SIZE,
    variant: 'CITADEL' as const,
    template: citadel.tiles,
    chests: [citadel.chest],
    traps: citadel.trapCandidates.slice(0, citadel.trapCount).map((t) => ({ ...t })),
    beaconAnchor: citadel.beacon,
    vault: citadel.vault,
    entryGaps: citadel.entryGaps.map((g) => ({ ...g })),
  };
}

/** Whether ANY footprint tile of the seam intersects the highway carve. */
function footprintTouchesHighway(
  seam: { originRow: number; originCol: number },
  highwayCarvedTiles: Set<string>,
): boolean {
  for (let r = 0; r < CITADEL_SIZE; r++) {
    for (let c = 0; c < CITADEL_SIZE; c++) {
      if (highwayCarvedTiles.has(`${seam.originRow + r},${seam.originCol + c}`)) return true;
    }
  }
  return false;
}

/**
 * Place the mega-structure compound on the sector grid.
 *
 * Picks one of the four center-sector seams, builds the template, and stamps
 * it onto the composite map. Placement rules:
 *
 *   1. **Perimeter safety** — any template cell that would land on the outer
 *      map perimeter (rows/cols 0 or PERIMETER_LAST) is skipped.
 *   2. **Highway wins** — any template cell whose global coord is already in
 *      `highwayCarvedTiles` is skipped (left as whatever the highway wrote,
 *      typically EMPTY). This lets a crossing highway split the compound.
 *   3. **Carved-tile accounting** — every touched coord (written OR skipped
 *      due to highway/perimeter) is recorded in `carvedTiles` so downstream
 *      passes (heal, entity exclusion) treat the full footprint consistently.
 *
 * Map-redesign ticket 06 (DEC-004): a seed-parameterized rarity roll on the
 * isolated CITD stream (`citadelRng`, avalanche-mixed — see
 * MacroFeaturePass) selects the rare 14×14 Citadel (~10–15% of seeds). The
 * COMP stream keeps its exact draw shape for standard maps EXCEPT the
 * template-index bound, which now spans four templates (sanctioned change —
 * golden fixtures re-pin).
 *
 * @param sectors - the 2D sector grid (mutated in place)
 * @param rng - isolated COMP RNG stream (standard template draws)
 * @param highwayCarvedTiles - coords the highway already wrote; never overwritten
 * @param citadelRng - isolated avalanche-mixed CITD stream (roll + geometry)
 * @returns compound metadata including origin, anchors and all carved tiles
 */
export function placeCompound(
  sectors: SectorData[][],
  rng: SeededRNG,
  highwayCarvedTiles: Set<string>,
  citadelRng: SeededRNG,
): CompoundInfo {
  const isCitadel = citadelRng.nextFloat() < CITADEL_CHANCE;
  const placement = isCitadel
    ? placeCitadel(citadelRng, highwayCarvedTiles)
    : placeStandardCompound(rng);

  const { originRow, originCol, size: SIZE, template } = placement;
  const carvedTiles = new Set<string>();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const gr = originRow + r;
      const gc = originCol + c;

      // NEVER touch the outer map perimeter.
      if (gr <= 0 || gr >= PERIMETER_LAST || gc <= 0 || gc >= PERIMETER_LAST) {
        continue;
      }

      // Highway wins: skip writing (leave whatever highway wrote) but still
      // account for the coord so heal/entity passes see the full footprint.
      if (highwayCarvedTiles.has(`${gr},${gc}`)) {
        carvedTiles.add(`${gr},${gc}`);
        continue;
      }

      const sr = Math.floor(gr / SECTOR_TILE_SIZE);
      const sc = Math.floor(gc / SECTOR_TILE_SIZE);
      const lr = gr % SECTOR_TILE_SIZE;
      const lc = gc % SECTOR_TILE_SIZE;

      const sectorRow = sectors[sr];
      const sector = sectorRow?.[sc];
      const tileRow = sector?.tiles?.[lr];
      if (tileRow) {
        tileRow[lc] = template[r]![c]!;
      }

      carvedTiles.add(`${gr},${gc}`);
    }
  }

  return {
    originRow,
    originCol,
    size: SIZE,
    variant: placement.variant,
    carvedTiles,
    chests: placement.chests.map(({ row, col }) => ({
      row: originRow + row,
      col: originCol + col,
    })),
    traps: placement.traps.map(({ row, col }) => ({ row: originRow + row, col: originCol + col })),
    beaconAnchor: {
      row: originRow + placement.beaconAnchor.row,
      col: originCol + placement.beaconAnchor.col,
    },
    vault: placement.vault
      ? { row: originRow + placement.vault.row, col: originCol + placement.vault.col }
      : null,
    entryGaps: placement.entryGaps.map((g) => ({
      side: g.side,
      row: originRow + g.row,
      col: originCol + g.col,
    })),
  };
}
