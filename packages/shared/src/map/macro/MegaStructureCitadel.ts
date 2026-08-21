import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';

/**
 * The rare 14×14 Citadel compound variant (map-redesign ticket 06 / DEC-004.1
 * — "rarity-as-emotion: under-rolled on purpose").
 *
 * Tiered interior, reading outside-in:
 *
 *   1. **Breakable outer yard ring** — the footprint's outermost wall ring is
 *      DESTRUCTIBLE_WALL (the whole citadel can be smashed open anywhere) with
 *      four 3-wide yard gaps aligned to the shell gaps below.
 *   2. **Yard** — the open band between yard ring and shell; the power
 *      position (a 2×2 INDESTRUCTIBLE pillar cluster) sits here flanking the
 *      north approach lane, with a clear sightline column straight through
 *      the yard gap + shell gap + vault doorway.
 *   3. **Indestructible shell** — the persistent fortress wall with FOUR
 *      3-wide entry gaps (one per side; ≥4 entrances, no side is lockable).
 *   4. **Vault chamber** — an inner walled room (rows/cols 5..8) holding the
 *      GUARANTEED epic-or-better chest + guardian traps, entered via a 3-wide
 *      doorway on the north wall; the SOUTH wall carries a 2-tile
 *      DESTRUCTIBLE breach segment — the second breach path (no lockable
 *      sanctum, no infinite stall: even a doorway camper cannot seal the
 *      vault, and the yard ring is smashable from any angle).
 *
 * All geometry is a pure function of the gap-start draws (isolated CITD
 * stream, see MacroFeaturePass) — zero dependence on any other RNG stream.
 */

/** Citadel footprint side (tiles). */
export const CITADEL_SIZE = 14;

/**
 * Chance a map rolls the Citadel variant (DEC-004: ~10–15% of seeds,
 * deliberately under-rolled). Parameter of the rarity band.
 */
export const CITADEL_CHANCE = 0.125;

/**
 * The four center-sector seams a 14×14 Citadel may span — the 10×10 compound
 * seams grown by 2 tiles on each side of the seam, so the Citadel is THE
 * central landmark straddling the same sector boundaries (never touching the
 * outer perimeter, rows/cols 23..56 ⊂ 20..59).
 *
 * Index meaning (sector coords):
 *   0 — E-W seam between (1,1) and (1,2)
 *   1 — E-W seam between (2,1) and (2,2)
 *   2 — N-S seam between (1,1) and (2,1)
 *   3 — N-S seam between (1,2) and (2,2)
 */
export const CITADEL_SEAMS: ReadonlyArray<{ originRow: number; originCol: number }> = [
  { originRow: 23, originCol: 33 },
  { originRow: 43, originCol: 33 },
  { originRow: 33, originCol: 23 },
  { originRow: 33, originCol: 43 },
];

/** Inclusive range of 3-wide gap start positions along a Citadel side. */
const CITADEL_GAP_START_MIN = 4;
const CITADEL_GAP_START_MAX = 7;
/** Width of every Citadel entry gap (shell AND aligned yard ring). */
const CITADEL_GAP_WIDTH = 3;

/** Inner area bounds (inside the shell at local 3/10). */
const INNER_LO = 4;
const INNER_HI = 9;
/** Vault ring bounds (inside the inner area). */
const VAULT_LO = 5;
const VAULT_HI = 8;

/** The build result consumed by `placeCompound`. */
export interface CitadelTemplateResult {
  tiles: TileType[][];
  /** The single guaranteed epic+ vault chest (local coords). */
  chest: { row: number; col: number };
  /** Guardian trap cells (local coords), first `trapCount` are used. */
  trapCandidates: ReadonlyArray<{ row: number; col: number }>;
  trapCount: number;
  /** Beacon anchor (local coords) — vault floor beside the chest. */
  beacon: { row: number; col: number };
  /** Vault chamber center (local coords). */
  vault: { row: number; col: number };
  /** The four entry gaps (local coords of each gap's first cleared cell). */
  entryGaps: ReadonlyArray<{ side: 'top' | 'bottom' | 'left' | 'right'; row: number; col: number }>;
}

/**
 * Whether the seam's vault-critical block intersects the highway carve.
 * Pure geometry on local bounds — no RNG.
 */
export function citadelSeamBlockedByHighway(
  seam: { originRow: number; originCol: number },
  highwayCarvedTiles: Set<string>,
): boolean {
  for (let r = INNER_LO; r <= INNER_HI; r++) {
    for (let c = INNER_LO; c <= INNER_HI; c++) {
      if (highwayCarvedTiles.has(`${seam.originRow + r},${seam.originCol + c}`)) return true;
    }
  }
  return false;
}

/**
 * Build the 14×14 Citadel template. All randomness comes from the isolated
 * CITD stream (four gap-start draws + the guardian-trap count) — the shared
 * pipeline RNG is never touched.
 *
 * @param rng - the isolated Citadel RNG stream (CITD salt)
 * @returns the template tiles + authored loot/trap/beacon anchors
 */
export function buildCitadelTemplate(rng: SeededRNG): CitadelTemplateResult {
  const SIZE = CITADEL_SIZE;
  const tiles: TileType[][] = [];
  for (let r = 0; r < SIZE; r++) {
    tiles[r] = [];
    for (let c = 0; c < SIZE; c++) tiles[r]![c] = TileType.EMPTY;
  }

  // Four gap starts (fixed side order: top, bottom, left, right).
  const gapTop = rng.nextInt(CITADEL_GAP_START_MIN, CITADEL_GAP_START_MAX);
  const gapBottom = rng.nextInt(CITADEL_GAP_START_MIN, CITADEL_GAP_START_MAX);
  const gapLeft = rng.nextInt(CITADEL_GAP_START_MIN, CITADEL_GAP_START_MAX);
  const gapRight = rng.nextInt(CITADEL_GAP_START_MIN, CITADEL_GAP_START_MAX);
  const inGap = (i: number, start: number): boolean => i >= start && i < start + CITADEL_GAP_WIDTH;

  // 1. Breakable outer yard ring (gaps aligned with the shell gaps below).
  for (let i = 0; i < SIZE; i++) {
    const wall = TileType.DESTRUCTIBLE_WALL;
    if (!inGap(i, gapTop)) tiles[0]![i] = wall;
    if (!inGap(i, gapBottom)) tiles[SIZE - 1]![i] = wall;
    if (!inGap(i, gapLeft)) tiles[i]![0] = wall;
    if (!inGap(i, gapRight)) tiles[i]![SIZE - 1] = wall;
  }

  // 2. Indestructible shell at local 3/10 with the four 3-wide entry gaps.
  const SHELL = 3;
  for (let i = SHELL; i < SIZE - SHELL; i++) {
    if (!inGap(i, gapTop)) tiles[SHELL]![i] = TileType.INDESTRUCTIBLE_WALL;
    if (!inGap(i, gapBottom)) tiles[SIZE - 1 - SHELL]![i] = TileType.INDESTRUCTIBLE_WALL;
    if (!inGap(i, gapLeft)) tiles[i]![SHELL] = TileType.INDESTRUCTIBLE_WALL;
    if (!inGap(i, gapRight)) tiles[i]![SIZE - 1 - SHELL] = TileType.INDESTRUCTIBLE_WALL;
  }

  // 3. Vault chamber ring (rows/cols 5..8). North wall: a 3-wide doorway
  //    aligned under the north shell gap (the sightline column). South wall:
  //    a 2-tile DESTRUCTIBLE breach — the second path into the vault.
  const doorStart = gapTop <= 5 ? 5 : 6;
  for (let i = VAULT_LO; i <= VAULT_HI; i++) {
    if (!inGap(i, doorStart)) tiles[VAULT_LO]![i] = TileType.INDESTRUCTIBLE_WALL;
    // South wall: indestructible corners frame the breakable breach segment.
    tiles[VAULT_HI]![i] =
      i === VAULT_LO || i === VAULT_HI ? TileType.INDESTRUCTIBLE_WALL : TileType.DESTRUCTIBLE_WALL;
    // East/west walls (rows between the ring's top/bottom).
    if (i > VAULT_LO && i < VAULT_HI) {
      tiles[i]![VAULT_LO] = TileType.INDESTRUCTIBLE_WALL;
      tiles[i]![VAULT_HI] = TileType.INDESTRUCTIBLE_WALL;
    }
  }

  // 4. Power position: 2×2 indestructible pillar cluster in the yard, flanking
  //    the north approach lane (cols gapTop+3..gapTop+4, rows 1..2). The lane
  //    column (gapTop+1) stays clear from the yard gap through the shell gap
  //    to the vault doorway — the "sightline over the vault approach".
  const clusterCol = gapTop + 3;
  for (let dr = 1; dr <= 2; dr++) {
    for (let dc = 0; dc <= 1; dc++) {
      tiles[dr]![clusterCol + dc] = TileType.INDESTRUCTIBLE_WALL;
    }
  }

  // 5. Vault loot + guardians: guaranteed chest at the core, beacon beside it,
  //    traps on the approach. Count 2–3 (DEC-004 guardian trap density).
  const chest = { row: 6, col: 6 };
  tiles[chest.row]![chest.col] = TileType.CHEST;
  const trapCount = rng.nextInt(2, 3);
  const trapCandidates = [
    { row: 7, col: 6 }, // inside the vault, guarding the chest's flank
    { row: 4, col: 5 }, // inner area, west of the vault doorway
    { row: 4, col: 8 }, // inner area, east of the vault doorway
  ];

  return {
    tiles,
    chest,
    trapCandidates,
    trapCount,
    beacon: { row: 7, col: 7 },
    vault: { row: 7, col: 7 },
    entryGaps: [
      { side: 'top', row: 0, col: gapTop },
      { side: 'bottom', row: SIZE - 1, col: gapBottom },
      { side: 'left', row: gapLeft, col: 0 },
      { side: 'right', row: gapRight, col: SIZE - 1 },
    ],
  };
}
