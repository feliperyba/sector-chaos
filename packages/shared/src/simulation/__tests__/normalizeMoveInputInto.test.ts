import { describe, it, expect } from 'vitest';
import { normalizeMoveInputInto } from '../normalizeMoveInputInto.js';
import { PLAYER_PHYSICS_CONFIG } from '../playerPhysicsConfig.js';

/**
 * Verbatim-oracle battery for `normalizeMoveInputInto` (ticket 15 / research
 * C3 rows 2 + 10). Every former hand copy of the input/dash normalization is
 * transcribed below VERBATIM (same expressions, same order) and the shared
 * leaf is asserted BIT-IDENTICAL (`===`, not closeTo) to each transcript over
 * an adversarial input battery: zero vectors, axis units, diagonals,
 * already-normalized doubles (the prediction double-normalization path),
 * magnitude-agnostic pairs, denormal underflow, and overflow-to-Infinity.
 *
 * The transcripts are the deleted originals:
 *   1. server MovementService.validateAndMove (sqrt multiply form)
 *   2. client PredictionService.step (sqrt multiply form + len>0 dash capture)
 *   3. client Reconciler.reconcile (`** 2` form — V8's pow fast-path for
 *      exponent 2 is the exact multiply, asserted here, not assumed)
 *   4. server DashCommand.execute (sqrt multiply form + (1,0) fallback)
 *
 * The former shared simulatePhysicsStepInto copy used Math.hypot and is
 * deliberately NOT an === oracle: hypot is implementation-approximate and NOT
 * bit-identical to the sqrt form (pinned separately below) — replacing it with
 * this leaf is the ticket-15 unification on the server's exact arithmetic.
 */

/** Transcript 1 — MovementService.validateAndMove (former lines 152-155). */
function movementServiceOriginal(dx: number, dy: number) {
  const mag = Math.sqrt(dx * dx + dy * dy);
  const ndx = mag > 0 ? dx / mag : 0;
  const ndy = mag > 0 ? dy / mag : 0;
  return { len: mag, x: ndx, y: ndy };
}

/** Transcript 3 — Reconciler.reconcile (former `** 2` form, lines 209/219). */
function reconcilerOriginal(mx: number, my: number) {
  const len = Math.sqrt(mx ** 2 + my ** 2);
  return {
    len,
    x: len > 0 ? mx / len : 0,
    y: len > 0 ? my / len : 0,
  };
}

/** Transcript 4 — DashCommand.execute normalize (former lines 36-43). */
function dashCommandOriginal(dirX: number, dirY: number) {
  let x = dirX;
  let y = dirY;
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  if (len > 0) {
    x /= len;
    y /= len;
  } else {
    x = 1;
    y = 0;
  }
  return { len, x, y };
}

/**
 * Adversarial battery: covers every value class that reaches the leaf in
 * production (raw WASD integers, pointer-derived floats, already-normalized
 * prediction directions) plus IEEE edge cases (denormal underflow, overflow,
 * signed zero).
 */
const BATTERY: Array<[number, number]> = [
  [0, 0],
  [-0, -0],
  [1, 0],
  [1, -0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [3, 4],
  [-3, 4],
  [100, 100],
  [430, -430],
  [0.1, 0.2],
  // already-normalized diagonals — the prediction path normalizes in
  // PredictionService and simulatePhysicsStepInto normalizes AGAIN with this
  // leaf; these are the exact doubles that flow through that second pass.
  [0.7071067811865475, 0.7071067811865475],
  [0.7071067811865476, 0.7071067811865476],
  [-0.7071067811865475, 0.7071067811865476],
  // denormal scale: dx*dx underflows to 0 → len 0 → out (0,0)
  [5e-324, 5e-324],
  [1e-200, 1e-200],
  [1e-323, 0],
  [2.2250738585072014e-308, 0],
  // small-but-representable magnitude (no underflow)
  [1e-160, 1e-160],
  // overflow: dx*dx = Infinity → len Infinity → components 0 (len > 0 TRUE —
  // pins why the leaf RETURNS the length: callers' `len > 0` discriminators
  // must keep seeing the former branch outcome)
  [1e200, 1e200],
  [1e150, 1e150],
  [1, 1e-300],
  [1e-300, 1],
];

const out = { x: 0, y: 0 };

describe('normalizeMoveInputInto — verbatim-oracle parity battery (ticket 15)', () => {
  it('is bit-identical to the MovementService transcript over the whole battery', () => {
    for (const [dx, dy] of BATTERY) {
      const len = normalizeMoveInputInto(out, dx, dy);
      const oracle = movementServiceOriginal(dx, dy);
      expect({ len, x: out.x, y: out.y }).toEqual(oracle);
    }
  });

  it('is bit-identical to the Reconciler `** 2` transcript over the whole battery', () => {
    for (const [dx, dy] of BATTERY) {
      const len = normalizeMoveInputInto(out, dx, dy);
      const oracle = reconcilerOriginal(dx, dy);
      expect({ len, x: out.x, y: out.y }).toEqual(oracle);
    }
  });

  it('is bit-identical to the DashCommand normalize transcript (len>0 branch) over the battery', () => {
    for (const [dx, dy] of BATTERY) {
      const len = normalizeMoveInputInto(out, dx, dy);
      const oracle = dashCommandOriginal(dx, dy);
      expect(len).toBe(oracle.len);
      // The (1,0) fallback lives at DashCommand's call site, not in the leaf:
      // compare only where the caller's `len > 0` branch took the leaf values.
      if (oracle.len > 0) {
        expect(out.x).toBe(oracle.x);
        expect(out.y).toBe(oracle.y);
      }
    }
  });

  it('is bit-identical to the PredictionService usage: len drives the exact `len > 0` dash capture', () => {
    // PredictionService.step former lines 198/207-211/216-217: one len,
    // dash-direction captured ONLY when len > 0, frame input = len>0 ? d/len : 0.
    for (const [dirX, dirY] of BATTERY) {
      const len = normalizeMoveInputInto(out, dirX, dirY);
      const oracleLen = Math.sqrt(dirX * dirX + dirY * dirY);
      expect(len).toBe(oracleLen);
      if (len > 0) {
        expect(out.x).toBe(dirX / oracleLen);
        expect(out.y).toBe(dirY / oracleLen);
      }
      // frame input (the (0,0) case must write zeros — deceleration trigger)
      expect(out.x).toBe(oracleLen > 0 ? dirX / oracleLen : 0);
      expect(out.y).toBe(oracleLen > 0 ? dirY / oracleLen : 0);
    }
  });

  it('pins exact outputs on the load-bearing doubles (float-order contract)', () => {
    // (1,1) and (100,100) normalize to the SAME unit double — magnitude-agnostic.
    expect(normalizeMoveInputInto(out, 1, 1)).toBe(Math.SQRT2);
    expect(out.x).toBe(0.7071067811865475);
    expect(normalizeMoveInputInto(out, 100, 100)).toBe(141.4213562373095);
    expect(out.x).toBe(0.7071067811865475);
    // Second pass over the normalized diagonal (the double-normalization the
    // prediction path performs): the sqrt form yields these EXACT bits —
    // Math.hypot on the same input yields 1 and would leave x at
    // 0.7071067811865475. THIS is why the contract forbids hypot.
    expect(normalizeMoveInputInto(out, 0.7071067811865475, 0.7071067811865475)).toBe(
      0.9999999999999999,
    );
    expect(out.x).toBe(0.7071067811865476);
    expect(out.y).toBe(0.7071067811865476);
    // 3-4-5 exact.
    expect(normalizeMoveInputInto(out, 3, 4)).toBe(5);
    expect(out.x).toBe(0.6);
    expect(out.y).toBe(0.8);
  });

  it('zero vector normalizes to (0,0) — the deceleration trigger', () => {
    expect(normalizeMoveInputInto(out, 0, 0)).toBe(0);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    // signed zero on one axis propagates exactly like the former copies
    expect(normalizeMoveInputInto(out, 1, -0)).toBe(1);
    expect(Object.is(out.x, 1)).toBe(true);
    expect(Object.is(out.y, -0)).toBe(true);
  });

  it('denormal underflow yields len 0 (out (0,0)) — same branch the former copies took', () => {
    expect(normalizeMoveInputInto(out, 5e-324, 5e-324)).toBe(0);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(normalizeMoveInputInto(out, 1e-200, 1e-200)).toBe(0);
  });

  it('overflow yields len Infinity with (0,0) out — and len > 0 stays TRUE (return-len contract)', () => {
    const len = normalizeMoveInputInto(out, 1e200, 1e200);
    expect(len).toBe(Infinity);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    // A caller's `len > 0` discriminator (DashCommand / physics-step dash
    // branch / PredictionService capture) saw exactly this outcome before the
    // leaf existed — the returned length preserves it bit-for-bit.
    expect(len > 0).toBe(true);
  });

  it('writes into the caller receptacle without allocating (out identity preserved)', () => {
    const receptacle = { x: 123, y: 456 };
    normalizeMoveInputInto(receptacle, 1, 0);
    expect(receptacle).toEqual({ x: 1, y: 0 });
  });
});

describe('normalizeMoveInputInto — hypot supersession pin (ticket 15 float-order contract)', () => {
  it('Math.hypot is NOT bit-identical to the sqrt form on the movement domain (why hypot is banned)', () => {
    // Documentation-as-test: on the already-normalized diagonal — a value the
    // prediction path actually produces — V8's Math.hypot returns exactly 1
    // while the mandated sqrt form returns 0.9999999999999999. We do NOT
    // assert the hypot value (it is implementation-approximate); we assert the
    // LEAF's sqrt bits, so any regression to a hypot body changes these pins.
    const v = 0.7071067811865475;
    expect(Math.hypot(v, v)).toBe(1); // V8 pin — documents the divergence
    expect(normalizeMoveInputInto(out, v, v)).not.toBe(1);
    expect(normalizeMoveInputInto(out, v, v)).toBe(0.9999999999999999);
  });
});

describe('normalizeMoveInputInto — exports wired through the package surface', () => {
  it('re-exports from simulation/index (consumed by server + client via @sector-battle/shared)', async () => {
    // The consumers import from '@sector-battle/shared'; this pins the index
    // wiring so the leaf cannot silently become package-private.
    const index = await import('../index.js');
    expect(index.normalizeMoveInputInto).toBe(normalizeMoveInputInto);
    expect(index.PLAYER_PHYSICS_CONFIG).toBe(PLAYER_PHYSICS_CONFIG);
  });
});
