/**
 * Pure 2-point integer hash shared by the lighting system's per-position
 * flicker-seed derivations (ticket 24 — was the duplicated-code smell: three
 * sites copied the same `73856093 ^ 19349663` mix). Pure + deterministic —
 * same `(x, y)` → same uint32 on every call, every client. No `Math.random`.
 *
 * The lighting callers all fold the result into a flicker seed in roughly the
 * same shape: hash → xor-shift finalizer → mod 1e6 / 1000 (a stable, well-
 * spread positive float for the flicker sines). The hash itself is exposed
 * raw so callers can mix in extra terms (e.g. the explosion path's tick term)
 * BEFORE the finalizer, preserving each caller's existing bit layout.
 */

/** Knuth-style integer-hash mixing constants (the historical values). */
const HASH_X_MULT = 73856093;
const HASH_Y_MULT = 19349663;

/**
 * Two-point integer hash: `(x * 73856093) ^ (y * 19349663)`. Returns the
 * un-finalized 32-bit mix as a signed JS number (use {@link finalizeHash} for
 * the xor-shifted uint32 + flicker-seed helpers). Pass integer inputs — for
 * world-px positions, callers `Math.floor` first (the explosion + dynamic-
 * populator sites do).
 *
 * Pure: same `(x, y)` → same number, always.
 */
export function hash2(x: number, y: number): number {
  return (x * HASH_X_MULT) ^ (y * HASH_Y_MULT);
}

/**
 * Xor-shift finalizer (the historical `(h ^ (h >>> 13)) >>> 0` step shared by
 * all three lighting hash sites). Returns a uint32 in [0, 2^32). Pure.
 */
export function finalizeHash(h: number): number {
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * A stable flicker seed in [0, 1000) derived from a finalized hash. The shape
 * matches every lighting site's historical `(h % 1_000_000) / 1000` — a well-
 * spread float for the flicker sines, deterministic per input. Pure.
 */
export function flickerSeedFromHash(h: number): number {
  return (h % 1_000_000) / 1000;
}
