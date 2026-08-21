/**
 * Single-axis clamp of a CENTER position to one map extent (ticket 15 /
 * research C3 row 7) — the ONE leaf behind the two former coordinate-basis
 * mirrors:
 *
 *   server `MovementService.clampValue` (CENTER-based):
 *     `Math.max(halfSize, Math.min(value, mapExtent - halfSize))`
 *   client `ClientCollisionService.clampBounds` (CORNER-based):
 *     `if (pos < 0) pos = 0; if (pos + size > extent) pos = extent - size;`
 *
 * The server consumed its center form directly. The client converts at its
 * call site by clamping the CENTER (`resolvedCorner + halfW`) INSTEAD of the
 * corner and carrying the clamped center onward — no corner round-trip, so the
 * composed client call is bit-identical to the former corner form for every
 * input on any realizable map (`mapExtent >= size`, where size = 2 * halfSize):
 *
 *   corner < 0        → center < halfSize  → halfSize          (old: 0 + halfSize)
 *   corner > E - size → center > E - h     → E - halfSize      (old: E - size + h)
 *   in-bounds         → unchanged center   → corner + halfSize (same expression)
 *
 * NET-22 PRECEDENT: a 312px defect once lived in exactly this corner/center
 * conversion, which is why the equivalence — including non-square maps and
 * adversarial doubles — is pinned by a verbatim-oracle battery in
 * `__tests__/clampToMapExtent.test.ts` rather than left "obviously equal".
 *
 * Degenerate domain note: for `mapExtent < 2 * halfSize` (a map smaller than
 * the 96px hitbox — no realizable grid) the two bases diverge: the center form
 * pins the player to `halfSize`, the former corner form produced
 * `mapExtent - size` (negative). The battery pins this documented divergence.
 */
export function clampToMapExtent(centerPos: number, halfSize: number, mapExtent: number): number {
  return Math.max(halfSize, Math.min(centerPos, mapExtent - halfSize));
}
