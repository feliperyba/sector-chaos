/**
 * LightBudget — pure-logic budget manager for the dynamic + static light merge.
 *
 * Ticket 11. The world is now lit by LIVE match state (player auras +
 * explosions + projectiles + barrel-fire), composed with the ticket-10 static
 * map placements. Both feeds flow into a single per-frame light array that
 * MUST stay within two budgets:
 *
 *   1. `MAX_LIGHTS` (256) — the compile-time GLSL loop cap. The packer already
 *      hard-caps at 256; this module guarantees we never silently overflow by
 *      trimming BEFORE packing.
 *   2. The ≤80 on-screen perf target (spec §"Performance budget"). The real
 *      GPU cost is bounded by the active light count, so a hard on-screen cap
 *      keeps the deferred pipeline (which scales `objects + lights`, not
 *      `objects × lights`) inside the validated 144fps+ band.
 *
 * The cull is DETERMINISTIC given the candidate set + camera rect: same inputs
 * → same kept subset, bit-for-bit. That determinism is the Seam-A test surface
 * (`LightBudget.test.ts`). No `Math.random`, no wall-clock. Ticket 01 (B4 perf)
 * made the hot path allocation-free at steady state: the sort entries come
 * from a grow-only pool (`BudgetScratch.sortPool`) whose high-water mark is
 * reached once and then reused, so no per-frame object allocation.
 *
 * Cull rule (applied in order):
 *   1. Distance-cull: drop any candidate whose disk (position + radius) does
 *      not intersect `cameraRect` grown by `margin` (off-screen lights don't
 *      contribute visible light — the lit RT is viewport-sized). This alone
 *      handles the common case (a 64-player match spread across a 10k×10k
 *      world: only the ~10–20 lights near the camera survive).
 *   2. Priority trim: if the distance-culled set still exceeds the on-screen
 *      target, sort by (priority ASC, distance-to-camera ASC) and keep the
 *      first N. Priority order (ticket 11 acceptance criteria + ticket 17
 *      ambient-scatter tier):
 *          PLAYER (0) > EXPLOSION (1) > PROJECTILE (2) > STATIC (3) >
 *          AMBIENT_SCATTER (4) > BARREL (5)
 *      Players + explosions are the action the player is looking at; motivated
 *      static props (torches/campfires) beat the ambient-scatter fill layer;
 *      distant scatter is the first light-only layer to drop when over budget
 *      (ticket 17 — scatter is the lowest-priority mood fill, never a fixture).
 *
 * The output is two kept-index lists (static + dynamic) so the caller can trim
 * its own arrays without rebuilding them — zero per-frame allocation.
 */
import type { DynamicLight } from './LightPacker.js';

/**
 * Light priority (lower = kept first when trimming). The order is load-bearing
 * for the budget trim: player auras + explosions are the live action the player
 * is looking at, so they win slots over distant static torches. Exported so
 * the populator tags its dynamic lights + the Seam-A tests can assert the order.
 *
 * Ticket 17 adds {@link AMBIENT_SCATTER} BELOW {@link STATIC}: the
 * ambient-scatter fill layer (the prototype's `remaining` loop,
 * `prototype.js:604-614`) is light-only mood fill, never a motivated fixture,
 * so distant scatter trims BEFORE distant props (torches/campfires) when the
 * on-screen budget is exceeded. Near-camera props + scatter survive together
 * (the trim is by distance within each priority band, so a near scatter beats
 * a far scatter but loses to any in-view motivated prop).
 *
 * Map-redesign ticket 05 (DEC-005) adds the {@link BEACON} band between
 * PROJECTILE and STATIC: the hero-landmark destination lights are the top of
 * the STATIC hierarchy — "beacons never dropped for scatter" (nor for generic
 * sconces/crystals). They still sit BELOW every dynamic combat band
 * (player auras, explosions, projectiles): combat readability outranks
 * navigation mood (DEC-005 #6 value-band rule).
 */
export const LIGHT_PRIORITY = {
  PLAYER: 0,
  EXPLOSION: 1,
  PROJECTILE: 2,
  /** Map-redesign ticket 05 — beacons: top of the static hierarchy, below combat. */
  BEACON: 3,
  STATIC: 4,
  /** Ticket 17 — ambient-scatter fill (light-only, lowest-priority mood fill). */
  AMBIENT_SCATTER: 5,
  BARREL: 6,
} as const;

/**
 * A static-placement candidate for budgeting. Lightweight — only the fields
 * the cull needs (position + radius + priority). The caller resolves
 * gridX/gridY → world px + the hero-override radius + the priority tag once
 * per placement (the world position never changes; this could be cached, but
 * the cost is negligible so we recompute).
 *
 * Ticket 17: the optional `priority` lets ambient-scatter placements
 * (`isScatter: true`) tag themselves {@link LIGHT_PRIORITY.AMBIENT_SCATTER} so
 * they trim before motivated props. Defaults to {@link LIGHT_PRIORITY.STATIC}
 * (all pre-ticket-17 placements + the existing tests).
 */
export interface StaticLightCandidate {
  /** World px X (grid→world already resolved by the caller). */
  x: number;
  /** World px Y. */
  y: number;
  /** Resolved radius (hero override applied). */
  radius: number;
  /**
   * Budget priority for this candidate (lower = kept first). Defaults to
   * {@link LIGHT_PRIORITY.STATIC}. Ticket 17's ambient-scatter layer passes
   * {@link LIGHT_PRIORITY.AMBIENT_SCATTER} so distant scatter trims first.
   */
  priority?: number;
}

/**
 * A dynamic-light candidate. Carries the resolved `DynamicLight` (ready to
 * pack) + the priority tag + position/radius for culling (duplicated from the
 * light for the sort comparator's convenience).
 */
export interface DynamicLightCandidate {
  /** The resolved light, ready to hand to `packLights`'s dynamic slice. */
  light: DynamicLight;
  /** Priority tag (lower = kept first). */
  priority: number;
}

/** Camera view rect in WORLD px (the lit RT is viewport-sized). */
export interface CameraRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Budget configuration. */
export interface BudgetConfig {
  /**
   * Hard on-screen cap (the ≤80 perf target). Distance-culled lights above
   * this count are priority-trimmed. The GL `MAX_LIGHTS` (256) is the absolute
   * last-resort cap enforced separately by the packer.
   */
  onScreenTarget: number;
  /**
   * World-px margin grown around the camera rect before distance-culling. A
   * light whose disk intersects the grown rect is kept (its halo can bleed
   * into view). Generous default so halos don't pop at the screen edge.
   */
  margin: number;
}

/** Default budget: ≤80 on-screen, 256px halo margin. Spec §"Performance budget". */
export const DEFAULT_BUDGET: BudgetConfig = {
  onScreenTarget: 80,
  margin: 256,
};

/**
 * Reusable scratch buffers for the budget pass. Ticket 24 — was the module-
 * scoped mutable singleton smell: `SORT_BUFFER`/`STATIC_OUT`/`DYNAMIC_OUT`
 * were module-globals + a `_resetBudgetBuffersForTests` test-hook cleared them
 * between assertions. Now per-instance: each {@link LightingBudgetStage} owns
 * one, so there's no hidden cross-instance state and the test hook is gone
 * (a fresh instance = fresh scratch). The buffers self-clear each
 * {@link selectLightsForBudget} call (length = 0 keeps the backing array).
 *
 * Each sort entry is a `{ sortKey, index, isStatic }` triple. Ticket 01 (B4
 * perf regression) — the entries are now POOLED (a grow-only `SortEntry[]`
 * whose backing objects are reused across calls via {@link acquireSortEntry}),
 * so the sort is allocation-free at steady state. (`sortKey` is
 * `priority * 1e9 + distSq` — priority dominates; within a priority band,
 * nearer cameras first. `1e9` comfortably exceeds any realistic distSq:
 * world is 10k×10k → max distSq ≈ 2e8.)
 *
 * History note (honest): ticket 24's commit message claimed the sort was
 * "allocation-free" because the buffer was instance-ified, but the per-push
 * `{...}` literals still allocated one object per in-view candidate per frame
 * (~200+ at 64-player peak). That was the load-bearing half of the B4 GC-
 * stutter regression. This pool closes it.
 */
interface SortEntry {
  /** priority * 1e9 + distanceSq(cameraCenter, lightCenter). */
  sortKey: number;
  /** Index into the candidate array this entry came from. */
  index: number;
  /** True if this is a static candidate, false if dynamic. */
  isStatic: boolean;
}

/** Per-instance scratch the budget pass mutates + returns into. */
export interface BudgetScratch {
  /**
   * Reused sort buffer (one entry per in-view candidate; sorted when trimmed).
   * The array itself is reused; the ENTRY OBJECTS come from {@link sortPool}
   * (acquired via {@link acquireSortEntry}), so no per-push allocation.
   */
  sortBuffer: SortEntry[];
  /** Reused kept static-candidate indices (returned as `staticIndices`). */
  staticOut: number[];
  /** Reused kept dynamic-candidate indices (returned as `dynamicIndices`). */
  dynamicOut: number[];
  /**
   * Ticket 01 (B4) — grow-only pool of `SortEntry` objects. Acquired via
   * {@link acquireSortEntry}; never shrinks (the high-water mark is the worst-
   * case in-view candidate count, reached once and then reused every frame).
   */
  sortPool: SortEntry[];
}

/** Allocate a fresh scratch bag (one per pipeline / test instance). */
export function createBudgetScratch(): BudgetScratch {
  return { sortBuffer: [], staticOut: [], dynamicOut: [], sortPool: [] };
}

/**
 * Acquire a reusable `SortEntry` from the pool (ticket 01 / B4). Grows the
 * pool on first reach of a new index (one alloc per high-water-mark step);
 * thereafter returns the same object so steady-state allocation is zero. The
 * caller mutates the returned entry's fields in place before/after pushing.
 */
function acquireSortEntry(pool: SortEntry[], index: number): SortEntry {
  let entry = pool[index];
  if (entry === undefined) {
    entry = { sortKey: 0, index: 0, isStatic: false };
    pool[index] = entry;
  }
  return entry;
}

export interface BudgetResult {
  /** Kept static-candidate indices (into the input static array). */
  staticIndices: number[];
  /** Kept dynamic-candidate indices (into the input dynamic array). */
  dynamicIndices: number[];
}

/**
 * Select which static + dynamic candidates survive the budget, given the
 * camera rect. DETERMINISTIC: same candidates + camera + scratch → same kept
 * subset.
 *
 * Mutates the supplied `scratch` (resets + repopulates its three buffers) and
 * returns a {@link BudgetResult} view onto `scratch.staticOut` /
 * `scratch.dynamicOut` (read it before the next call reuses the scratch). The
 * returned index arrays are in priority/distance order (highest-priority +
 * nearest first) so the packer's static-first/dynamic-after layout still holds
 * within budget — the GLSL loop breaks at `uLightCount`, so the first N packed
 * lights are the N that survive.
 *
 * @param staticCandidates  resolved static placements (position + radius).
 * @param dynamicCandidates resolved dynamic lights (with priority tags).
 * @param camera            world-px camera view rect.
 * @param config            budget config (on-screen target + margin).
 * @param scratch           the caller-owned scratch (one per pipeline).
 * @returns the result view onto `scratch`'s output buffers.
 */
export function selectLightsForBudget(
  staticCandidates: ReadonlyArray<StaticLightCandidate>,
  dynamicCandidates: ReadonlyArray<DynamicLightCandidate>,
  camera: CameraRect,
  config: BudgetConfig,
  scratch: BudgetScratch,
): BudgetResult {
  const {
    sortBuffer: SORT_BUFFER,
    staticOut: STATIC_OUT,
    dynamicOut: DYNAMIC_OUT,
    sortPool: SORT_POOL,
  } = scratch;
  // Reset the reusable buffers (length = 0 keeps the backing array for reuse).
  SORT_BUFFER.length = 0;
  STATIC_OUT.length = 0;
  DYNAMIC_OUT.length = 0;

  const camCx = camera.x + camera.width / 2;
  const camCy = camera.y + camera.height / 2;
  // Grown camera rect for the disk-intersection cull (margin lets halos bleed
  // into view without popping at the screen edge).
  const minX = camera.x - config.margin;
  const maxX = camera.x + camera.width + config.margin;
  const minY = camera.y - config.margin;
  const maxY = camera.y + camera.height + config.margin;

  // ── Pass 1: distance-cull + build the sort buffer ──
  // A light's disk intersects the grown camera rect iff its center is within
  // `radius` of the rect on each axis (closest-point test). This is the
  // standard circle-vs-AABB overlap test — cheaper than the true intersection
  // and conservative (never culls a visible light).
  //
  // Ticket 01 (B4 perf): each in-view candidate acquires a POOLED SortEntry
  // (acquireSortEntry) instead of allocating a fresh `{...}` literal per push.
  // At steady state (same camera + entity count frame-to-frame) the pool's
  // high-water mark is reached once → zero per-frame allocation here.
  let poolIdx = 0;
  for (let i = 0; i < staticCandidates.length; i++) {
    const c = staticCandidates[i]!;
    if (diskIntersectsRect(c.x, c.y, c.radius, minX, minY, maxX, maxY)) {
      const dx = c.x - camCx;
      const dy = c.y - camCy;
      const distSq = dx * dx + dy * dy;
      // Ticket 17: per-candidate priority lets ambient-scatter placements tag
      // themselves AMBIENT_SCATTER (below STATIC) so they trim first when over
      // budget. Defaults to STATIC for all pre-ticket-17 placements.
      const prio = c.priority ?? LIGHT_PRIORITY.STATIC;
      const entry = acquireSortEntry(SORT_POOL, poolIdx++);
      entry.sortKey = prio * 1e9 + distSq;
      entry.index = i;
      entry.isStatic = true;
      SORT_BUFFER[poolIdx - 1] = entry;
    }
  }
  for (let i = 0; i < dynamicCandidates.length; i++) {
    const c = dynamicCandidates[i]!;
    const l = c.light;
    if (diskIntersectsRect(l.x, l.y, l.radius, minX, minY, maxX, maxY)) {
      const dx = l.x - camCx;
      const dy = l.y - camCy;
      const distSq = dx * dx + dy * dy;
      const entry = acquireSortEntry(SORT_POOL, poolIdx++);
      entry.sortKey = c.priority * 1e9 + distSq;
      entry.index = i;
      entry.isStatic = false;
      SORT_BUFFER[poolIdx - 1] = entry;
    }
  }

  // ── Pass 2: priority/distance trim if over the on-screen target ──
  // Sort ascending by sortKey (priority band first, then distance-to-camera).
  // Stable (Array.prototype.sort is stable in V8/Node ≥11) so equal-priority
  // equal-distance lights keep their insertion order — the determinism anchor.
  if (SORT_BUFFER.length > config.onScreenTarget) {
    SORT_BUFFER.sort((a, b) => a.sortKey - b.sortKey);
    SORT_BUFFER.length = config.onScreenTarget;
  }

  // ── Split the kept set back into static + dynamic index lists ──
  for (let i = 0; i < SORT_BUFFER.length; i++) {
    const e = SORT_BUFFER[i]!;
    if (e.isStatic) {
      STATIC_OUT.push(e.index);
    } else {
      DYNAMIC_OUT.push(e.index);
    }
  }

  return { staticIndices: STATIC_OUT, dynamicIndices: DYNAMIC_OUT };
}

/**
 * Circle-vs-AABB overlap test (conservative closest-point form). True if the
 * circle at (cx,cy) of `r` intersects the rect [minX,minY,maxX,maxY]. Cheaper
 * than the exact intersection + never culls a visible disk (the closest point
 * on the rect to the circle center is within `r` → they overlap).
 */
function diskIntersectsRect(
  cx: number,
  cy: number,
  r: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const closestX = cx < minX ? minX : cx > maxX ? maxX : cx;
  const closestY = cy < minY ? minY : cy > maxY ? maxY : cy;
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= r * r;
}
