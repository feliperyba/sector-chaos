import { AABBCollision, type AABB } from '../math/AABBCollision.js';
import type { MTV } from '../math/Vec2.js';

/**
 * Pooled AABB scratch for the moving player (module-level, the
 * `ProjectileTileCollision.tempMTV` pattern). `AABBCollision.getMTVInto` only
 * READS the four fields, so in-place pooled mutation is numeric-identical to
 * the per-iteration object literals it replaces (INVESTIGATION.md §3.5).
 * Written on every call → the function is NOT reentrant; both call contexts
 * (server sim tick, client prediction/replay) are synchronous single-threaded.
 */
const movingScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };
/** Pooled AABB scratch for the other player of the current iteration. */
const otherScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Resolve player-vs-player AABB minimum-translation-vector separation for one
 * moving player against a list of other-player centers.
 *
 * For each other player (in the given order), computes the MTV pushing the
 * moving player's AABB out of the other player's AABB and adds it to the
 * running position, then writes the separated CENTER into `out`. This is the
 * single shared body of the previously duplicated loops — and, since ticket
 * 44, the ONLY production implementation of player-vs-player separation:
 *
 * - server `MovementService.resolvePlayerCollision` (MovementService.ts) —
 *   packs the filtered id-sorted alive list into a flat buffer and calls this
 *   function; formerly an inline `PLAYER.HITBOX_*` AABB construction +
 *   `getMTVInto` + `mtv.x !== 0 ? mtv.x * mtv.depth : 0` offset application,
 *   recomputing the moving AABB from the accumulated position each iteration;
 * - client `ClientCollisionService.resolveCollision` nearby-player loop
 *   (ClientCollisionService.ts) — packs the nearby pool into a flat buffer in
 *   `setNearbyPlayers` and calls this function with the half-extents it
 *   receives (`halfW = PLAYER.HITBOX_WIDTH / 2`, via
 *   `PLAYER_PHYSICS_CONFIG.playerHalfW` upstream in `simulatePhysicsStepInto`)
 *   so `halfW * 2 === PLAYER.HITBOX_WIDTH` exactly.
 *
 * The two former loops were bit-for-bit identical given the same ordered
 * other-player list and the production half-extents;
 * `resolvePlayerSeparation.test.ts` proves that equivalence with verbatim
 * replicas of both loops (kept as the math gate after the ticket-44 wiring).
 *
 * FILTERING AND ORDERING STAY IN THE CALLERS (this function processes every
 * entry it is given, unconditionally, in array order):
 * - the server skips the mover itself (by id), `!isActive` others without
 *   death collision, dashing others, and short-circuits entirely while the
 *   mover is dashing, and feeds an id-sorted list (order affects
 *   multi-overlap accumulation);
 * - the client filters dead/dying/spectating players and the local player
 *   upstream (GameScene dead-mask/radius loop) before packing the flat array.
 *
 * Callers also own everything around this step: tile collision and map-bounds
 * clamping happen before (server `resolveTileCollision` + `clampValue`; client
 * `resolveTileCollisionEnriched` + `clampBounds`), and the client's
 * corner→center conversion (`resolvedX + halfW`) is the caller's concern —
 * this function takes and returns CENTER coordinates.
 *
 * Pure calculator (ADR-0035 §5.4): allocates nothing (module-pooled AABB
 * scratch + caller-owned MTV/out receptacles) and reads no state beyond its
 * arguments. No `Math.random`. Server-authoritative: the server calls this
 * inside its authoritative loop and keeps ownership of the result; the client
 * calls it inside prediction/replay only.
 *
 * @param centerX    Moving player's center X (start of the separation chain)
 * @param centerY    Moving player's center Y
 * @param halfW      Half hitbox width — production passes PLAYER.HITBOX_WIDTH / 2
 * @param halfH      Half hitbox height — production passes PLAYER.HITBOX_HEIGHT / 2
 * @param othersFlat Flat packed other-player centers [x0, y0, x1, y1, ...].
 *                   `ArrayLike<number>` — a plain array or a typed array
 *                   (e.g. `Float64Array`) both work. May be a larger
 *                   preallocated buffer; only the first `otherCount` pairs
 *                   are read.
 * @param otherCount Number of other players (active prefix = 2 * otherCount
 *                   entries of `othersFlat`). 0 → no-op passthrough.
 * @param mtvScratch Caller-owned MTV receptacle, reused across iterations
 *                   (same per-instance-scratch contract as both originals).
 * @param out        Caller-owned receptacle for the separated center
 *                   (mutated in place; returns nothing).
 */
export function resolvePlayerSeparation(
  centerX: number,
  centerY: number,
  halfW: number,
  halfH: number,
  othersFlat: ArrayLike<number>,
  otherCount: number,
  mtvScratch: MTV,
  out: { x: number; y: number },
): void {
  let outX = centerX;
  let outY = centerY;

  // Constant across iterations (identical to the per-iteration literal:
  // `halfW * 2` / `halfW and 96` are exactly equal for the production
  // half-extent 48 — 48 * 2 === 96 with no rounding).
  movingScratch.width = halfW * 2;
  movingScratch.height = halfH * 2;
  otherScratch.width = halfW * 2;
  otherScratch.height = halfH * 2;

  for (let i = 0; i < otherCount; i++) {
    const otherX = othersFlat[i * 2]!;
    const otherY = othersFlat[i * 2 + 1]!;

    // Same per-iteration construction as both originals: the moving AABB is
    // rebuilt from the ACCUMULATED position (order-sensitive chain).
    movingScratch.x = outX - halfW;
    movingScratch.y = outY - halfH;
    otherScratch.x = otherX - halfW;
    otherScratch.y = otherY - halfH;

    if (AABBCollision.getMTVInto(movingScratch, otherScratch, mtvScratch)) {
      const offsetX = mtvScratch.x !== 0 ? mtvScratch.x * mtvScratch.depth : 0;
      const offsetY = mtvScratch.y !== 0 ? mtvScratch.y * mtvScratch.depth : 0;
      outX += offsetX;
      outY += offsetY;
    }
  }

  out.x = outX;
  out.y = outY;
}
