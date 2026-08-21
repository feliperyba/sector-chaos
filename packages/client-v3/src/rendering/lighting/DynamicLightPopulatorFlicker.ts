/**
 * DynamicLightPopulatorFlicker — the populator's deterministic phase/seeding
 * helpers: the C7 aura-breathing constants + hash (per-player phase) and the
 * fire-trap flicker seed (per-position). Mechanical extraction from
 * DynamicLightPopulator.ts (F8 file-length retirement) — bodies verbatim, only
 * the module boundary moved. All helpers are pure/deterministic (no
 * Math.random), so the per-frame light output is byte-identical.
 */
import { hash2, finalizeHash, flickerSeedFromHash } from './LightingHash.js';

// ── C7 (lighting-system-3) — aura subtle breathing ─────────────────────────
// The aura is the most-observed light on screen (it follows every player) and
// pre-C7 it was 100% static (`flickerMul = 1.0` hardcoded). C7 adds a SLOW
// breathing pulse — distinct from torch flicker (slow sine vs multi-octave
// noise) — that preserves the "steady identity" character while adding life
// (the Lichtner "soft identity halo" made alive). Deterministic per (time,
// playerId): a per-player hash phase de-synchronizes the 64 auras so they
// don't pulse in unison. No `Math.random()`. Cosmetic-only (GDD `docs/GDD.md:
// 210`) — ±6% is subtle, never a strobe.
/**
 * Aura breathing amplitude (±6% intensity). Pinned per the C7 spec — small
 * enough to read as "living light", large enough to be perceptible. Tuned by
 * eye against the post-C2 warm aura. DO NOT raise above ~0.10 (would read as
 * a strobe + impede aim perception).
 */
export const AURA_BREATHING_AMP = 0.06;
/**
 * Aura breathing frequency (~0.6Hz = ~1.7s period). SLOW — distinct from
 * torch flicker (multi-Hz). Pinned per the C7 spec. A calm breathing rate,
 * not a panting shimmer.
 */
export const AURA_BREATHING_HZ = 0.6;
/** 2π — the sin period (named for readability at the breathing site). */
const TWO_PI = Math.PI * 2;

/**
 * Deterministic per-position flicker seed (stable hash of world coords). Used
 * so per-entity dynamic flame lights (active fire traps) get distinct flicker
 * phases without strobing in unison — same position → same seed → same phase.
 * Pure, no Math.random. Mirrors `flickerSeedForPlacement` (LightPacker) for
 * static placements; this is the dynamic-entity analogue (shares the central
 * `hash2` helper — ticket 24).
 */
export function flickerSeedFromPosition(x: number, y: number): number {
  return flickerSeedFromHash(finalizeHash(hash2(Math.floor(x), Math.floor(y))));
}

// ── C7 (lighting-system-3) — per-player hash + aura breathing ──────────────
/**
 * Deterministic per-player phase offset in `[0, 2π)`, derived from a stable
 * string hash of the player id. Used by the aura breathing so 64 auras don't
 * pulse in unison — each player's breathing sine sits at a distinct phase.
 *
 * The hash is an FNV-1a-style string fold (no external dependency; the existing
 * `LightingHash` helpers only take integer `(x, y)` inputs, and the player id
 * is a string). Pure: same id → same phase, every call, every client. No
 * `Math.random()`. Spread via the FNV mix so adjacent ids (`bot-1`, `bot-2`)
 * land on distinct phases (cheap diversity — see the C7 test).
 *
 * C7 chose a string-local hash (rather than reusing the integer `hash2`) for
 * two reasons: (1) the integer hash would require an extra `parseInt` step
 * that loses bits on non-numeric ids (`local`, `remote-1`, `bot-42`); (2) a
 * dedicated string hash keeps the phase well-spread across the full id space.
 */
export function hashPlayerIdPhase(playerId: string): number {
  // FNV-1a 32-bit: hash each char code into an offset basis with the FNV prime.
  // Stable, deterministic, well-spread for short string ids. The `>>> 0` keeps
  // the accumulator a uint32 across iterations (JS bitwise ops are 32-bit).
  let h = 0x811c9dc5; // FNV offset basis.
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    // h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24) == h * 0x01000193.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  // Map to [0, 2π). `h / 2^32` is in [0, 1); × 2π gives the phase. A direct
  // mod-2π would lose spread for small h; the divide keeps full resolution.
  return (h / 0x1_0000_0000) * TWO_PI;
}

/**
 * The aura breathing multiplier for a given wall-clock time + player id.
 *
 * `flickerMul = 1.0 + AURA_BREATHING_AMP * sin(t * AURA_BREATHING_HZ * 2π +
 * hashPlayerIdPhase(playerId))` — a slow ±6% intensity pulse at ~0.6Hz, with a
 * per-player phase so 64 auras don't pulse in unison. Deterministic per
 * (time, playerId); pure of inputs. No `Math.random()`.
 *
 * @param t        wall-clock SECONDS (the populator passes `nowMs / 1000` so
 *                 the breathing rate matches the spec's Hz regardless of the
 *                 caller's ms-vs-s convention).
 * @param playerId the player whose aura is breathing (drives the phase).
 */
export function computeAuraBreathingMul(t: number, playerId: string): number {
  return (
    1 + AURA_BREATHING_AMP * Math.sin(t * AURA_BREATHING_HZ * TWO_PI + hashPlayerIdPhase(playerId))
  );
}
