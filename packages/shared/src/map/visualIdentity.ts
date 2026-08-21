import { SeededRNG } from './rng/SeededRNG.js';
import { avalanche } from './lootTiers.js';
import { SECTOR_IDENTITY } from './identitySheets.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE, TILE_PIXEL_SIZE } from './constants.js';
import type {
  EntityPlacement,
  SectorConnection,
  SectorData,
  SectorType,
  TrapPlacement,
} from './types.js';
import type { LandmarkAssignment } from './landmarks.js';

/**
 * Visual identity pass (map-redesign ticket 07 / DEC-006) — the GENERATED
 * half of the identity sheets: per-sector floor tint fields + per-connection
 * gateway dressing, authored by shared generation and consumed verbatim by
 * the client bake. Everything here is VISUAL-ONLY: no tile is written, no
 * collision changes, no entity moves — the fields are translucent overlays
 * baked into the floor layer and the gateway compositions bake into the
 * decoration layer, both at map load (zero per-frame cost).
 *
 * Determinism (ADR 0035): the floor-field placement draws come from ONE
 * isolated XOR-salted, avalanche-mixed stream — `avalanche(seed ^
 * IDENTITY_SEED_XOR)` — never from the main pipeline RNG, so this pass can
 * never perturb the tile/entity/tier streams. The gateway dressing pass is
 * PURE GEOMETRY (zero RNG draws): a projection of `connections` + the
 * landmark anchors. Border jitter is a pure position hash (no RNG): the same
 * seed always yields byte-identical identity data.
 */

/**
 * Isolated RNG stream seed XOR constant for the visual-identity pass
 * ('IDTY' in ASCII hex — same convention as lootTiers' 'TIER'/'HOTS' and
 * landmarks' 'LNDM' salts).
 */
export const IDENTITY_SEED_XOR = 0x49445459;

/** Field kinds: base macro wash ± wear ring near doors, stain near hazards. */
export type FloorTintFieldKind = 'base' | 'wear' | 'stain';

/**
 * One seeded macro floor-tint blob. Coordinates are SECTOR-LOCAL tiles
 * (floats — art centers may sit between tiles); the client adds the sector
 * origin. The border is defined by `radius + tileJitter(...)` per tile: a
 * ±1-tile wobble in quarter-tile steps — organic, non-axis-aligned seams,
 * never a straight debug line.
 */
export interface FloorTintField {
  kind: FloorTintFieldKind;
  /** Center, sector-local tile coords. */
  cx: number;
  cy: number;
  /** Base radius (tiles). */
  radius: number;
  /** Multiply-tint color (identity sheet floor family). */
  tint: number;
  /** Sheet bake alpha (soft overlay strength). */
  alpha: number;
  /** Per-tile border jitter hash seed (pure function of seed+sector+kind). */
  jitterSeed: number;
}

/**
 * Gateway dressing record for ONE sector corridor opening (connection).
 * All data is a pure projection of the connection + identity sheets +
 * landmark anchors — the client composes the visual band + frame from it.
 */
export interface GatewayDressing {
  sectorA: { row: number; col: number };
  sectorB: { row: number; col: number };
  /** 'h': horizontal neighbors (border runs vertically, opening spans rows). */
  axis: 'h' | 'v';
  /** Aperture center (GLOBAL tile coords; may be x.5 on the seam). */
  midX: number;
  midY: number;
  /** Floor base tints of the two sides — the lerp band endpoints. */
  tintA: number;
  tintB: number;
  /** Hero landmark anchors (GLOBAL tiles) per side, when landmarks exist. */
  heroA: { x: number; y: number } | null;
  heroB: { x: number; y: number } | null;
  /**
   * Entering-shot alignment per side (DEC-006 #5): true when the opening's
   * inward sightline points within {@link GATEWAY_ALIGN_COS} of that side's
   * hero landmark — "the entering shot frames the landmark". Where the seed
   * does not allow it the dressing still composes (structure at EVERY
   * gateway), just without the aligned emphasis.
   */
  alignedA: boolean;
  alignedB: boolean;
}

/** The pass output, stored on `MapData.identity`. */
export interface VisualIdentityAssignment {
  /** Per-sector floor tint fields (4×4 grid; 2–3 fields per sector cell). */
  fields: FloorTintField[][][];
  /** One dressing record per sector connection, in `connections` order. */
  gateways: GatewayDressing[];
}

/**
 * Cosine threshold for the entering-shot alignment: the angle between the
 * opening's inward sightline and the direction to the hero must be within
 * ~30° (cos ≈ 0.87) for the landmark to count as FRAMED BY THE DOORWAY —
 * the "entering shot" read. Measured on the standard seeds this is a real
 * signal (roughly half the sides align), so the accent composes only where
 * the seed genuinely allows it; center-anchored heroes align from every
 * door, corner-hugging ones do not.
 */
export const GATEWAY_ALIGN_COS = 0.87;

// ─── Border jitter (pure position hash — the non-axis-aligned seams) ─────────

/**
 * Deterministic per-tile border jitter in quarter-tile steps, one of
 * {-1, -0.75, …, +1}. A pure avalanche hash of (x, y, seed) — no RNG stream
 * consumption; the same tile always jitters identically for a given field.
 * This is what breaks the "square blob / straight seam" read (NoisePosti.ng
 * squareness warning → jittered non-axis borders).
 */
export function tileJitter(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x27d4eb2d) ^ (seed >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return ((h % 9) >>> 0) / 4 - 1;
}

/**
 * Whether a sector-local tile is inside a field's jittered blob: Euclidean
 * distance ≤ radius + tileJitter. Tiles strictly inside (dist ≤ radius − 1)
 * are ALWAYS members (jitter ≥ −1) — the interior is solid; only the border
 * wobbles (zero per-tile noise inside a field).
 */
export function fieldCoversTile(field: FloorTintField, lx: number, ly: number): boolean {
  const dist = Math.hypot(lx - field.cx, ly - field.cy);
  return dist <= field.radius + tileJitter(lx, ly, field.jitterSeed);
}

/**
 * Bake alpha for one covered tile: full sheet alpha inside, feathering to
 * zero over the last ~3 tiles of the radius (large soft fields — a smooth
 * distance falloff, never per-tile randomness). Returns 0 for uncovered
 * tiles; the value is purely a function of (field, tile).
 */
export function fieldTileAlpha(field: FloorTintField, lx: number, ly: number): number {
  const dist = Math.hypot(lx - field.cx, ly - field.cy);
  const feather = Math.max(0, Math.min(1, (field.radius + 1.5 - dist) / 3));
  return feather > 0 && fieldCoversTile(field, lx, ly) ? field.alpha * feather : 0;
}

// ─── The pass ─────────────────────────────────────────────────────────────────

/** Field placement bounds (sector-local): centers stay off the border ring. */
const FIELD_CENTER_MIN = 3;
const FIELD_CENTER_MAX = SECTOR_TILE_SIZE - 3;

/** Clamp a sector-local coordinate into the placement bounds. */
function clampCenter(v: number): number {
  return Math.max(FIELD_CENTER_MIN, Math.min(FIELD_CENTER_MAX, v));
}

/** Pure per-field jitter seed: a function of (seed, sector, kind) — no RNG. */
function fieldJitterSeed(seed: number, row: number, col: number, kindIndex: number): number {
  return (avalanche(seed >>> 0) ^ ((row * 16 + col) * 3 + kindIndex)) >>> 0;
}

/** Convert a world-tile coordinate to this sector's local coords. */
function toLocal(gx: number, gy: number, row: number, col: number): { lx: number; ly: number } {
  return { lx: gx - col * SECTOR_TILE_SIZE, ly: gy - row * SECTOR_TILE_SIZE };
}

/** Aperture center (global tile coords, may be x.5 on the seam). */
export function gatewayMidpoint(conn: SectorConnection): { midX: number; midY: number } {
  const isH = conn.sectorA.row === conn.sectorB.row;
  if (isH) {
    // Horizontal neighbors: border is the vertical line between A's last
    // column and B's first; the 3-tile opening spans rows offsets[0..2]
    // (local 9..11) → center row = 10.
    const borderX = (Math.min(conn.sectorA.col, conn.sectorB.col) + 1) * SECTOR_TILE_SIZE - 0.5;
    const row = conn.sectorA.row;
    return { midX: borderX, midY: row * SECTOR_TILE_SIZE + 10 };
  }
  const borderY = (Math.min(conn.sectorA.row, conn.sectorB.row) + 1) * SECTOR_TILE_SIZE - 0.5;
  const col = conn.sectorA.col;
  return { midX: col * SECTOR_TILE_SIZE + 10, midY: borderY };
}

/**
 * Entering-shot alignment for one side: does the opening's inward sightline
 * (pointing INTO `sector`) frame that sector's hero landmark? Pure geometry.
 */
function sideIsAligned(
  conn: SectorConnection,
  sector: { row: number; col: number },
  hero: { x: number; y: number } | null,
  midX: number,
  midY: number,
): boolean {
  if (!hero) return false;
  const isH = conn.sectorA.row === conn.sectorB.row;
  // Inward normal: pointing from the seam INTO `sector`.
  const inwardX = isH ? (sector.col < Math.max(conn.sectorA.col, conn.sectorB.col) ? -1 : 1) : 0;
  const inwardY = isH ? 0 : sector.row < Math.max(conn.sectorA.row, conn.sectorB.row) ? -1 : 1;
  const dx = hero.x - midX;
  const dy = hero.y - midY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  return (dx / len) * inwardX + (dy / len) * inwardY >= GATEWAY_ALIGN_COS;
}

/**
 * Generate the visual identity assignment: floor tint fields per sector +
 * gateway dressing per connection.
 *
 * Floor fields per sector (2–3, DEC-006 #3): always a BASE macro wash (the
 * type's signature field) + a WEAR ring anchored near the sector's first
 * corridor door (deterministic pick: first touching connection in
 * `connections` order, pulled 2 tiles inward) + a STAIN field when the
 * sector hosts a hazard cluster (≥2 barrels/traps; anchored at the hazard
 * centroid). ALL draws come from the isolated IDTY stream (row-major), so
 * the pass never perturbs the main generation streams.
 */
export function generateVisualIdentity(
  seed: number,
  sectors: SectorData[][],
  typeGrid: SectorType[][],
  connections: SectorConnection[],
  entityPlacements: EntityPlacement[],
  trapPlacements: TrapPlacement[],
  landmarks: LandmarkAssignment | null,
): VisualIdentityAssignment {
  const rng = new SeededRNG(avalanche((seed ^ IDENTITY_SEED_XOR) >>> 0));

  // ── Floor tint fields ────────────────────────────────────────────────────
  const fields: FloorTintField[][][] = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    fields[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const type = typeGrid[row]?.[col];
      const sheet = type ? SECTOR_IDENTITY[type] : undefined;
      const sectorFields: FloorTintField[] = [];
      if (sheet) {
        // 1. Base macro wash: a large soft field, center jittered mid-sector.
        const baseCx = clampCenter(SECTOR_TILE_SIZE / 2 + rng.nextInt(-4, 4));
        const baseCy = clampCenter(SECTOR_TILE_SIZE / 2 + rng.nextInt(-4, 4));
        const baseR = 4.5 + rng.nextFloat() * 3; // 4.5–7.5 tiles
        sectorFields.push({
          kind: 'base',
          cx: baseCx,
          cy: baseCy,
          radius: baseR,
          tint: sheet.floor.base,
          alpha: sheet.floor.alpha,
          jitterSeed: fieldJitterSeed(seed, row, col, 0),
        });

        // 2. Wear ring near the sector's first corridor door: aperture center
        //    pulled 2 tiles toward the sector interior, ±1 tile jitter.
        const door = firstDoorOf(connections, row, col);
        if (door) {
          const { lx, ly } = toLocal(door.midX, door.midY, row, col);
          const towardCenterX = Math.sign(SECTOR_TILE_SIZE / 2 - lx);
          const towardCenterY = Math.sign(SECTOR_TILE_SIZE / 2 - ly);
          const wearCx = clampCenter(lx + towardCenterX * 2 + rng.nextInt(-1, 1));
          const wearCy = clampCenter(ly + towardCenterY * 2 + rng.nextInt(-1, 1));
          sectorFields.push({
            kind: 'wear',
            cx: wearCx,
            cy: wearCy,
            radius: 2.5 + rng.nextFloat(), // 2.5–3.5 tiles
            tint: sheet.floor.wear,
            alpha: sheet.floor.alpha,
            jitterSeed: fieldJitterSeed(seed, row, col, 1),
          });
        }

        // 3. Stain field near the sector's hazard cluster (≥2 barrels/traps).
        const hazards = hazardTilesInSector(entityPlacements, trapPlacements, row, col);
        if (hazards.length >= 2) {
          let sumX = 0;
          let sumY = 0;
          for (const h of hazards) {
            sumX += h.x;
            sumY += h.y;
          }
          const { lx, ly } = toLocal(sumX / hazards.length, sumY / hazards.length, row, col);
          sectorFields.push({
            kind: 'stain',
            cx: clampCenter(lx + rng.nextInt(-1, 1)),
            cy: clampCenter(ly + rng.nextInt(-1, 1)),
            radius: 2 + rng.nextFloat(), // 2–3 tiles
            tint: sheet.floor.stain,
            alpha: sheet.floor.alpha,
            jitterSeed: fieldJitterSeed(seed, row, col, 2),
          });
        }
      }
      fields[row]![col] = sectorFields;
    }
  }

  // ── Gateway dressing (pure geometry — zero RNG) ──────────────────────────
  const gateways: GatewayDressing[] = connections.map((conn) => {
    const { midX, midY } = gatewayMidpoint(conn);
    const typeA = typeGrid[conn.sectorA.row]?.[conn.sectorA.col];
    const typeB = typeGrid[conn.sectorB.row]?.[conn.sectorB.col];
    const heroA = landmarks?.heroes?.[conn.sectorA.row]?.[conn.sectorA.col];
    const heroB = landmarks?.heroes?.[conn.sectorB.row]?.[conn.sectorB.col];
    return {
      sectorA: conn.sectorA,
      sectorB: conn.sectorB,
      axis: conn.sectorA.row === conn.sectorB.row ? 'h' : 'v',
      midX,
      midY,
      tintA: typeA ? (SECTOR_IDENTITY[typeA]?.floor.base ?? 0) : 0,
      tintB: typeB ? (SECTOR_IDENTITY[typeB]?.floor.base ?? 0) : 0,
      heroA: heroA ? { x: heroA.tileX, y: heroA.tileY } : null,
      heroB: heroB ? { x: heroB.tileX, y: heroB.tileY } : null,
      alignedA: sideIsAligned(
        conn,
        conn.sectorA,
        heroA ? { x: heroA.tileX, y: heroA.tileY } : null,
        midX,
        midY,
      ),
      alignedB: sideIsAligned(
        conn,
        conn.sectorB,
        heroB ? { x: heroB.tileX, y: heroB.tileY } : null,
        midX,
        midY,
      ),
    };
  });

  return { fields, gateways };
}

/** The first connection (in `connections` order) touching a sector. */
function firstDoorOf(
  connections: SectorConnection[],
  row: number,
  col: number,
): { midX: number; midY: number } | null {
  for (const conn of connections) {
    if (
      (conn.sectorA.row === row && conn.sectorA.col === col) ||
      (conn.sectorB.row === row && conn.sectorB.col === col)
    ) {
      return gatewayMidpoint(conn);
    }
  }
  return null;
}

/** Global tile coords of a sector's hazard entities (barrels + traps). */
function hazardTilesInSector(
  entityPlacements: EntityPlacement[],
  trapPlacements: TrapPlacement[],
  row: number,
  col: number,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const e of entityPlacements) {
    if (e.entityType !== 'BARREL') continue;
    if (e.sectorCoord.row !== row || e.sectorCoord.col !== col) continue;
    out.push({ x: e.position.x / TILE_PIXEL_SIZE, y: e.position.y / TILE_PIXEL_SIZE });
  }
  for (const t of trapPlacements) {
    if (t.sectorCoord.row !== row || t.sectorCoord.col !== col) continue;
    out.push({ x: t.position.x / TILE_PIXEL_SIZE, y: t.position.y / TILE_PIXEL_SIZE });
  }
  return out;
}
