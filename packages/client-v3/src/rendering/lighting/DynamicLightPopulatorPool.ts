/**
 * DynamicLightPopulatorPool — the populator's per-pipeline scratch + the
 * ticket-01 (B4 perf) alternating two-pool clone scheme. Mechanical extraction
 * from DynamicLightPopulator.ts (F8 file-length retirement) — bodies verbatim,
 * only the module boundary moved. Allocation behavior is unchanged (grow-only
 * pools, flip per frame → steady-state zero-alloc).
 */
import type { DynamicLight } from './LightPacker.js';
import { ProjectileTrailBuffer } from './ProjectileLightTuning.js';
import type { LightingPipeline } from './LightingPipeline.js';

/**
 * A pooled `DynamicLight` with a MUTABLE color tuple (so the pool can write the
 * color channels in place each frame without allocating a fresh array). The
 * mutable tuple is assignable to `DynamicLight`'s `readonly [...]` field.
 */
export type PooledDynamicLight = Omit<DynamicLight, 'color'> & { color: [number, number, number] };

/**
 * Per-pipeline mutable scratch (ticket 24 — was the module-singleton
 * `SCRATCH_LIGHT`/`INTERP_OUT`/`PROJECTILE_TRAILS`/`LIVE_PROJECTILE_IDS`
 * smell). WeakMap-keyed so each pipeline gets its own (no cross-instance
 * state) + is GC'd when the pipeline dies. Lazily allocated on first call.
 *
 * Ticket 01 (B4 perf) adds `clonePoolA`/`clonePoolB` + `clonePoolFlip`: two
 * alternating grow-only pools flipped each frame. The previous frame's pool
 * holds the `lastKeptDynamic` refs read at the START of this frame's
 * `pipeline.update()`; leaving it untouched this frame keeps those refs valid.
 * Both pools reach their high-water mark after 2 frames → zero per-frame alloc.
 */
export interface DynamicLightScratch {
  /** Reused per-entity scratch light (mutated in place; `cloneLight`d before
   * registering — see the populator header "Allocation shape" note). Typed as
   * `PooledDynamicLight` so the `color` channel can be written in place
   * (`scratchLight.color[0] = …`) instead of reassigned a fresh array literal
   * per emit — the latter allocated a transient `[a,b,c]` tuple ~64+ times per
   * frame at 64 players that immediately became garbage (B4 perf H5). */
  scratchLight: PooledDynamicLight;
  /** Reused output buffer for interpolated positions. */
  interpOut: { x: number; y: number };
  /** Per-projectile trail ring buffer (lives across frames; dead ids pruned). */
  projectileTrails: ProjectileTrailBuffer;
  /** Reused set of live projectile ids this frame, for trail pruning. */
  liveProjectileIds: Set<string>;
  /** Ticket 01 (B4) — first alternating clone pool (frame N, N+2, …). */
  clonePoolA: PooledDynamicLight[];
  /** Ticket 01 (B4) — second alternating clone pool (frame N+1, N+3, …). */
  clonePoolB: PooledDynamicLight[];
  /** Ticket 01 (B4) — which pool is active this frame (toggles each call). */
  clonePoolFlip: boolean;
  /** Ticket 01 (B4) — number of entries handed out from the active pool this
   * frame; reset to 0 at the top of each `populateDynamicLights` call. */
  clonePoolCount: number;
}

/** Per-pipeline scratch (WeakMap-keyed → a dead pipeline's scratch is GC'd). */
const SCRATCH_BY_PIPELINE = new WeakMap<LightingPipeline, DynamicLightScratch>();

/** Look up (or lazily allocate) the per-pipeline scratch. */
export function scratchForPipeline(pipeline: LightingPipeline): DynamicLightScratch {
  let s = SCRATCH_BY_PIPELINE.get(pipeline);
  if (s === undefined) {
    s = {
      scratchLight: {
        x: 0,
        y: 0,
        radius: 0,
        intensity: 0,
        color: [0, 0, 0],
        corePower: 0,
        haloFrac: 0,
        specPower: 0,
        cookieOn: 0,
        // D2 — default 'add' (the historical behavior); the aura path overrides
        // to 'max' from the palette. chest-glint / fire-trap / explosion paths
        // inherit 'add' (energy should accumulate there).
        blend: 'add',
        flickerMul: 1.0,
      },
      interpOut: { x: 0, y: 0 },
      projectileTrails: new ProjectileTrailBuffer(),
      liveProjectileIds: new Set(),
      clonePoolA: [],
      clonePoolB: [],
      clonePoolFlip: false,
      clonePoolCount: 0,
    };
    SCRATCH_BY_PIPELINE.set(pipeline, s);
  }
  return s;
}

/**
 * Clone a DynamicLight into a reusable pooled object (ticket 01 / B4 perf).
 * Each registered light MUST be a distinct object (the pipeline holds the
 * refs across `addDynamicLight` calls; the budget may keep some into
 * `lastKeptDynamic` — read across frames by the atmosphere ember-anchor
 * resolver). The alternating two-pool scheme (see the scratch interface) keeps
 * the previous frame's refs valid until consumed; both pools are grow-only →
 * zero per-frame alloc at steady state. Registry explosion lights are already
 * distinct objects (skip clone).
 */
export function cloneLight(scratch: DynamicLightScratch, src: DynamicLight): DynamicLight {
  const pool = scratch.clonePoolFlip ? scratch.clonePoolB : scratch.clonePoolA;
  const i = scratch.clonePoolCount++;
  let dst: PooledDynamicLight | undefined = pool[i];
  if (dst === undefined) {
    // First reach of this index in this pool → allocate once (each pooled
    // entry owns its own `color[3]` array, mutated in place thereafter).
    dst = {
      x: src.x,
      y: src.y,
      radius: src.radius,
      intensity: src.intensity,
      color: [src.color[0], src.color[1], src.color[2]],
      corePower: src.corePower,
      haloFrac: src.haloFrac,
      specPower: src.specPower,
      cookieOn: src.cookieOn,
      // D2 — forward the per-light blend mode (defaults to 'add'; auras carry
      // 'max' from the palette).
      blend: src.blend ?? 'add',
      flickerMul: src.flickerMul ?? 1.0,
    };
    pool[i] = dst;
    return dst;
  }
  // Reused pooled entry — mutate in place (zero allocation).
  dst.x = src.x;
  dst.y = src.y;
  dst.radius = src.radius;
  dst.intensity = src.intensity;
  const c = dst.color;
  c[0] = src.color[0];
  c[1] = src.color[1];
  c[2] = src.color[2];
  dst.corePower = src.corePower;
  dst.haloFrac = src.haloFrac;
  dst.specPower = src.specPower;
  dst.cookieOn = src.cookieOn;
  // D2 — forward the per-light blend mode (defaults to 'add').
  dst.blend = src.blend ?? 'add';
  dst.flickerMul = src.flickerMul ?? 1.0;
  return dst;
}
