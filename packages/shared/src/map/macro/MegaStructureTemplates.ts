import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';

/**
 * The four authored 10×10 standard-compound interior templates
 * (map-redesign ticket 06 / DEC-004.2 — the fourth, LOOT_ARM, is new).
 *
 * Each builder is a pure function of its {@link SeededRNG} (the isolated
 * COMP compound stream) and returns the tile grid PLUS the authored anchors
 * (`CompoundTemplateResult`): chest cells (converted to real loot
 * placements by `MapGenerator`), the per-template beacon anchor, and the
 * entry-gap bookkeeping handled by `punchEntryGaps`.
 */

/** Fixed standard-compound footprint: 10×10 tiles. */
export const COMPOUND_SIZE = 10;

/** Width (in tiles) of each entry gap punched through the outer shell. */
const ENTRY_GAP_WIDTH = 3;

/** Inclusive range of starting positions for entry gaps along a shell side. */
const ENTRY_GAP_START_MIN = 2;
const ENTRY_GAP_START_MAX = 5;

/** Number of entry gaps to punch through the outer shell. */
const ENTRY_GAP_COUNT_MIN = 2;
const ENTRY_GAP_COUNT_MAX = 3;

type Side = 'top' | 'bottom' | 'left' | 'right';
const ALL_SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];

/** The authored anchors a standard template returns with its tiles. */
export interface CompoundTemplateResult {
  tiles: TileType[][];
  /** Authored CHEST cells (local template coords). */
  chests: ReadonlyArray<{ row: number; col: number }>;
  /** Beacon anchor (local template coords) — an authored EMPTY floor cell. */
  beacon: { row: number; col: number };
}

/** Punch 2–3 randomized 3-wide entry gaps through a 10×10 shell. */
export function punchEntryGaps(template: TileType[][], rng: SeededRNG): void {
  const SIZE = COMPOUND_SIZE;
  const sides = rng.shuffle([...ALL_SIDES]);
  const gapCount = rng.nextInt(ENTRY_GAP_COUNT_MIN, ENTRY_GAP_COUNT_MAX);
  for (let i = 0; i < gapCount; i++) {
    const side = sides[i]!;
    const gapStart = rng.nextInt(ENTRY_GAP_START_MIN, ENTRY_GAP_START_MAX);
    for (let g = 0; g < ENTRY_GAP_WIDTH; g++) {
      const pos = gapStart + g;
      if (side === 'top') template[0]![pos] = TileType.EMPTY;
      else if (side === 'bottom') template[SIZE - 1]![pos] = TileType.EMPTY;
      else if (side === 'left') template[pos]![0] = TileType.EMPTY;
      else template[pos]![SIZE - 1] = TileType.EMPTY;
    }
  }
}

/** Allocate a 10×10 grid filled with EMPTY. */
export function initEmptyGrid(): TileType[][] {
  const template: TileType[][] = [];
  for (let r = 0; r < COMPOUND_SIZE; r++) {
    template[r] = [];
    for (let c = 0; c < COMPOUND_SIZE; c++) {
      template[r]![c] = TileType.EMPTY;
    }
  }
  return template;
}

/** Frame a 10×10 grid with the indestructible outer shell. */
export function buildOuterShell(template: TileType[][]): void {
  const SIZE = COMPOUND_SIZE;
  for (let i = 0; i < SIZE; i++) {
    template[0]![i] = TileType.INDESTRUCTIBLE_WALL;
    template[SIZE - 1]![i] = TileType.INDESTRUCTIBLE_WALL;
    template[i]![0] = TileType.INDESTRUCTIBLE_WALL;
    template[i]![SIZE - 1] = TileType.INDESTRUCTIBLE_WALL;
  }
}

/**
 * Template 1 — "Cross Partition": horizontal breakable-wall partitions with
 * doorways, crate clusters in room corners, central courtyard chests.
 */
export function buildCrossPartitionTemplate(rng: SeededRNG): CompoundTemplateResult {
  const SIZE = COMPOUND_SIZE;
  const template = initEmptyGrid();
  buildOuterShell(template);

  for (let c = 1; c <= SIZE - 2; c++) {
    if (c !== 3 && c !== 4) template[4]![c] = TileType.DESTRUCTIBLE_WALL;
    if (c !== 5 && c !== 6) template[6]![c] = TileType.DESTRUCTIBLE_WALL;
  }

  template[2]![3] = TileType.DESTRUCTIBLE_CRATE;
  template[2]![6] = TileType.DESTRUCTIBLE_CRATE;
  template[7]![3] = TileType.DESTRUCTIBLE_CRATE;
  template[7]![6] = TileType.DESTRUCTIBLE_CRATE;
  template[5]![4] = TileType.CHEST;
  template[5]![5] = TileType.CHEST;

  punchEntryGaps(template, rng);
  return {
    tiles: template,
    chests: [
      { row: 5, col: 4 },
      { row: 5, col: 5 },
    ],
    // West room's center — an authored EMPTY cell beside the courtyard.
    beacon: { row: 5, col: 2 },
  };
}

/**
 * Template 2 — "Pillared Hall": 4 indestructible pillars at interior corners,
 * sparse crate cover, single central chest.
 */
export function buildPillaredHallTemplate(rng: SeededRNG): CompoundTemplateResult {
  const template = initEmptyGrid();
  buildOuterShell(template);

  template[2]![2] = TileType.INDESTRUCTIBLE_WALL;
  template[2]![7] = TileType.INDESTRUCTIBLE_WALL;
  template[7]![2] = TileType.INDESTRUCTIBLE_WALL;
  template[7]![7] = TileType.INDESTRUCTIBLE_WALL;

  template[3]![5] = TileType.DESTRUCTIBLE_CRATE;
  template[6]![4] = TileType.DESTRUCTIBLE_CRATE;
  template[4]![2] = TileType.DESTRUCTIBLE_WALL;
  template[5]![7] = TileType.DESTRUCTIBLE_WALL;
  template[4]![7] = TileType.CHEST;

  punchEntryGaps(template, rng);
  return {
    tiles: template,
    chests: [{ row: 4, col: 7 }],
    // Hall center — authored EMPTY between the four pillars.
    beacon: { row: 5, col: 5 },
  };
}

/**
 * Template 3 — "Courtyard Ring": inner 4×4 breakable-wall ring with chests
 * inside, open corners for flanking.
 */
export function buildCourtyardRingTemplate(rng: SeededRNG): CompoundTemplateResult {
  const SIZE = COMPOUND_SIZE;
  const template = initEmptyGrid();
  buildOuterShell(template);

  const innerR0 = 3;
  const innerR1 = 6;
  for (let c = innerR0; c <= innerR1; c++) {
    template[innerR0]![c] = TileType.DESTRUCTIBLE_WALL;
    template[innerR1]![c] = TileType.DESTRUCTIBLE_WALL;
    template[c]![innerR0] = TileType.DESTRUCTIBLE_WALL;
    template[c]![innerR1] = TileType.DESTRUCTIBLE_WALL;
  }

  template[innerR0]![4] = TileType.EMPTY;
  template[innerR0]![5] = TileType.EMPTY;
  template[innerR1]![4] = TileType.EMPTY;
  template[innerR1]![5] = TileType.EMPTY;

  template[2]![2] = TileType.DESTRUCTIBLE_CRATE;
  template[2]![7] = TileType.DESTRUCTIBLE_CRATE;
  template[7]![2] = TileType.DESTRUCTIBLE_CRATE;
  template[7]![7] = TileType.DESTRUCTIBLE_CRATE;
  template[4]![4] = TileType.CHEST;
  template[5]![5] = TileType.CHEST;

  punchEntryGaps(template, rng);
  return {
    tiles: template,
    chests: [
      { row: 4, col: 4 },
      { row: 5, col: 5 },
    ],
    // Inside the courtyard ring, beside the chest pair.
    beacon: { row: 4, col: 5 },
  };
}

/**
 * Template 4 — "Loot Arm" (map-redesign ticket 06 / DEC-004.2, the Skull-Town
 * "arms" pattern): a central 2-tile-wide east-west corridor spine, with four
 * loot arms (north/south × west/east) ending in a chest each. Breakable spurs
 * frame the spine so the arms read as deliberate alcoves, and the arm mouths
 * stay open (EMPTY) for flanking. Value = the chest positions along the
 * spine, NOT volume — 4 authored chests, tiers rolled per the tier tables
 * + LegendaryBudget cap like every other chest.
 */
export function buildLootArmTemplate(rng: SeededRNG): CompoundTemplateResult {
  const SIZE = COMPOUND_SIZE;
  const template = initEmptyGrid();
  buildOuterShell(template);

  // Spine framing: breakable walls north (row 3) and south (row 6) of the
  // spine, with the arm-lane columns (2 and 7) left open as mouths.
  for (let c = 1; c <= SIZE - 2; c++) {
    if (c !== 2 && c !== 7) {
      template[3]![c] = TileType.DESTRUCTIBLE_WALL;
      template[6]![c] = TileType.DESTRUCTIBLE_WALL;
    }
  }
  // Arm-lane caps: a breakable stub at the far end of each arm frames the
  // chest pocket without sealing it (two open flanks per arm).
  template[1]![4] = TileType.DESTRUCTIBLE_CRATE;
  template[1]![5] = TileType.DESTRUCTIBLE_CRATE;
  template[8]![4] = TileType.DESTRUCTIBLE_CRATE;
  template[8]![5] = TileType.DESTRUCTIBLE_CRATE;

  // The four arm-end chests.
  template[2]![2] = TileType.CHEST;
  template[2]![7] = TileType.CHEST;
  template[7]![2] = TileType.CHEST;
  template[7]![7] = TileType.CHEST;

  punchEntryGaps(template, rng);
  return {
    tiles: template,
    chests: [
      { row: 2, col: 2 },
      { row: 2, col: 7 },
      { row: 7, col: 2 },
      { row: 7, col: 7 },
    ],
    // Spine center — authored EMPTY on the corridor.
    beacon: { row: 5, col: 4 },
  };
}
