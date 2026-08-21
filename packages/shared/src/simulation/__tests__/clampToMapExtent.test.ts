import { describe, it, expect } from 'vitest';
import { clampToMapExtent } from '../clampToMapExtent.js';
import { PLAYER, COMBAT } from '../../constants/index.js';

/**
 * Verbatim-oracle battery for `clampToMapExtent` (ticket 15 / research C3
 * row 7) — the MANDATORY corner/center equivalence proof (NET-22 precedent:
 * a 312px defect once lived in exactly this conversion, so equivalence is
 * proven over map-extent edges + adversarial doubles, never assumed).
 *
 * Both former clamps are transcribed VERBATIM:
 *
 *   server MovementService.clampValue (CENTER-based, deleted):
 *     const halfSize = size / 2;
 *     return Math.max(halfSize, Math.min(value, mapExtent - halfSize));
 *   client ClientCollisionService.clampBounds (CORNER-based, deleted):
 *     if (pos < 0) pos = 0;
 *     if (pos + size > mapExtent) pos = mapExtent - size;
 *     return pos;
 *
 * The client consumed the corner form and THEN converted to center
 * (`+ halfW`); the call site now clamps the CENTER directly
 * (`clampToMapExtent(corner + halfW, halfW, extent)`). The equivalence
 * asserted below is exactly that composition:
 *
 *   clampToMapExtent(corner + h, h, E) === clampBoundsCorner(corner, 2h, E) + h
 *
 * which holds for EVERY input on realizable maps (E >= 2h — any grid at least
 * one hitbox wide; production is 10240px):
 *   - corner < 0        → old 0 + h        → h            = max(h, min(c, E-h))
 *   - corner > E - 2h   → old E - 2h + h   → E - h        = max(h, min(c, E-h))
 *   - in-bounds         → old corner + h   → corner + h   (same expression)
 *
 * plus a seeded random sweep (deterministic — no flakiness) reproducing the
 * former 1.2M-point verification: zero differences on every E >= 2h.
 */

const H = PLAYER.HITBOX_WIDTH / 2; // 48 — shared half-extent
const SIZE = PLAYER.HITBOX_WIDTH; // 96 — the former corner-form size argument
const HALF_H = PLAYER.HITBOX_HEIGHT / 2;

/** Transcript — server MovementService.clampValue (center-based, deleted). */
function serverClampValueOriginal(value: number, size: number, mapExtent: number): number {
  const halfSize = size / 2;
  return Math.max(halfSize, Math.min(value, mapExtent - halfSize));
}

/** Transcript — client ClientCollisionService.clampBounds (corner-based, deleted). */
function clientClampBoundsOriginal(pos: number, size: number, mapExtent: number): number {
  if (pos < 0) pos = 0;
  if (pos + size > mapExtent) pos = mapExtent - size;
  return pos;
}

/** The composed CLIENT call site after ticket 15 (center clamp, no round-trip). */
function clientComposed(corner: number, half: number, mapExtent: number): number {
  return clampToMapExtent(corner + half, half, mapExtent);
}

/** Realizable map extents: production square, non-square, minimum 2-tile, exactly-hitbox. */
const EXTENTS = [
  10240, // production 160 tiles * 64
  5120, // non-square map: the other axis (NET-22 312px defect class)
  8256, // odd tile count (129 * 64) — non-square-ish
  128, // 2-tile axis — minimum realizable grid
  96, // exactly the hitbox size (E === 2h boundary of the realizable domain)
];

/**
 * Map-extent EDGE cases (the mandatory part): both sides of every boundary in
 * both bases — 0 / halfSize / size / extent-halfSize / extent / beyond — with
 * grid-aligned (multiple-of-64) and adversarial fractional doubles.
 */
function edgeCorners(extent: number): number[] {
  const edges = [
    0,
    H,
    H - 1,
    H + 1,
    H * 2,
    extent - SIZE,
    extent - SIZE - 1,
    extent - SIZE + 1,
    extent - H,
    extent,
    extent + 1,
    -1,
    -H,
    -extent,
    extent / 2,
  ];
  // fractional + grid-aligned variants around each edge (the physics path
  // produces arbitrary doubles: x + vx*dt)
  const variants: number[] = [];
  for (const e of edges) {
    variants.push(e, e + 0.1, e - 0.1, e + 0.5000000001, Math.round(e / 64) * 64);
  }
  variants.push(0.1, 0.5, 1e-10, 5000.123456789012, 10239.9, 10191.999999999996);
  return variants;
}

/** Deterministic LCG sweep (seeded — identical every run, no flakiness). */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('clampToMapExtent — verbatim-oracle parity battery (ticket 15, NET-22 mandatory)', () => {
  it('server-direct: leaf(center, halfSize, E) === former center-based clampValue(center, size, E)', () => {
    for (const extent of EXTENTS) {
      for (const center of edgeCorners(extent)) {
        expect(clampToMapExtent(center, H, extent)).toBe(
          serverClampValueOriginal(center, SIZE, extent),
        );
      }
    }
  });

  it('client-composed: leaf(corner + h, h, E) === former corner-based clamp + corner→center convert', () => {
    for (const extent of EXTENTS) {
      for (const corner of edgeCorners(extent)) {
        expect(clientComposed(corner, H, extent)).toBe(
          clientClampBoundsOriginal(corner, SIZE, extent) + H,
        );
      }
    }
  });

  it('client-composed: seeded sweep over adversarial doubles — zero differences on every realizable extent', () => {
    const rnd = lcg(12345);
    for (const extent of EXTENTS) {
      for (let i = 0; i < 50_000; i++) {
        const corner = rnd() * (extent + 256) - 128; // in/out of bounds, fractional
        expect(clientComposed(corner, H, extent)).toBe(
          clientClampBoundsOriginal(corner, SIZE, extent) + H,
        );
      }
    }
  });

  it('non-square maps: each axis clamps against ITS OWN extent in both bases (the NET-22 312px class)', () => {
    // 10240 x 5120 map: X extent 10240, Y extent 5120. A corner far beyond the
    // SHORT axis must clamp to the SHORT axis bound on Y while X stays at the
    // WIDE axis bound — per-axis selection is call-site wiring (pinned
    // end-to-end by client collision-divergence.test.ts); this pins that the
    // leaf + both bases agree per-axis when fed the axis-correct extent.
    const mapW = 10240;
    const mapH = 5120;
    for (const corner of [-5000, 0, 64, 5000.5, 10239, 10300, 20000]) {
      expect(clientComposed(corner, H, mapW)).toBe(
        clientClampBoundsOriginal(corner, SIZE, mapW) + H,
      );
      expect(clientComposed(corner, HALF_H, mapH)).toBe(
        clientClampBoundsOriginal(corner, PLAYER.HITBOX_HEIGHT, mapH) + HALF_H,
      );
    }
    // X clamped into [48, 10192]; Y clamped into [48, 5072] — X must NEVER be
    // contaminated by mapH (the pre-NET-22 defect clamped X to 5120 - 48).
    expect(clientComposed(20000, H, mapW)).toBe(mapW - H);
    expect(clientComposed(20000, HALF_H, mapH)).toBe(mapH - HALF_H);
    expect(clientComposed(20000, H, mapW)).not.toBe(mapH - H);
  });

  it('pins the exact clamped values at the map-extent edges', () => {
    expect(clampToMapExtent(-1e9, H, 10240)).toBe(H);
    expect(clampToMapExtent(-0.1, H, 10240)).toBe(H);
    expect(clampToMapExtent(H, H, 10240)).toBe(H);
    expect(clampToMapExtent(H + 1, H, 10240)).toBe(H + 1); // first in-bounds center
    expect(clampToMapExtent(10239.9, H, 10240)).toBe(10240 - H); // 10192
    expect(clampToMapExtent(1e9, H, 10240)).toBe(10240 - H);
    expect(clampToMapExtent(5000.123456789012, H, 10240)).toBe(5000.123456789012); // pass-through
  });

  it('documents the never-realizable degenerate divergence (extent < hitbox)', () => {
    // A map axis smaller than the 96px hitbox cannot occur (minimum realizable
    // grid is 2 tiles = 128px; production is 160 tiles). In that degenerate
    // domain the two bases DISAGREE by construction: the center form pins the
    // player to halfSize, the former corner form produced extent - size
    // (negative). Pinned so the boundary of the equivalence domain is explicit.
    const extent = 64; // 1 tile
    expect(clampToMapExtent(50, H, extent)).toBe(H); // center form: pinned to 48
    expect(clientClampBoundsOriginal(50, SIZE, extent) + H).toBe(extent - SIZE + H); // 16
    expect(extent).toBeLessThan(SIZE);
  });

  it('half-extents derive from the pinned hitbox constants (both axes)', () => {
    expect(H).toBe(48);
    expect(HALF_H).toBe(48);
    expect(SIZE).toBe(96);
    expect(PLAYER.HITBOX_HEIGHT).toBe(PLAYER.HITBOX_WIDTH);
    // unrelated sanity: stagger penalty constant is nearby in COMBAT — pin the
    // family invariant that the simulation leaves derive from frozen constants
    // (0.75 is the constant of record; the evidence doc's 0.5 is stale)
    expect(COMBAT.STAGGER_MOVE_SPEED_PENALTY).toBe(0.75);
  });
});
