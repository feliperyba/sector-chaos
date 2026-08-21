/**
 * LightingBudgetStage — the per-frame budget pass wired into the pipeline.
 *
 * Ticket 11. The pipeline's `update()` runs this stage right before `packLights`:
 * it takes the static placements + the dynamic-light candidate list (populated
 * by `DynamicLightPopulator`), runs the pure `selectLightsForBudget` cull
 * against the camera rect, and returns the KEPT slices ready to pack. This
 * guarantees:
 *
 *   (a) No silent MAX_LIGHTS overflow (the packer still hard-caps at 256, but
 *       we prioritize first so the highest-priority lights always survive).
 *   (b) The ≤80 on-screen perf target (spec §"Performance budget").
 *   (c) Player + explosion lights win slots over distant static props when over
 *       budget (priority: PLAYER > EXPLOSION > PROJECTILE > STATIC > BARREL).
 *
 * The cull is DETERMINISTIC given (placements + dynamic + camera) — same inputs
 * → same kept subset (Seam-A tested in LightBudget.test.ts). No `Math.random`,
 * no wall-clock; the only per-frame input is the camera rect.
 *
 * Extracted from LightingPipeline.ts to respect the 450-line file-length lint
 * cap. This module owns the reusable scratch arrays + budget config; the
 * pipeline constructs one instance and calls `select()` each frame.
 *
 * Ticket 01 (B4 perf): the candidate wrappers (`StaticLightCandidate` +
 * `DynamicLightCandidate`) are now POOLED — pre-ticket-01 each frame allocated
 * ~160 static-candidate literals + one dynamic-candidate literal per
 * `addDynamic` call (~64+ at 64-player peak). The pools are grow-only; the
 * high-water mark is reached once and reused, so steady-state allocation is
 * zero. (The header's old "zero per-frame allocation in steady state" claim
 * was aspirational before ticket 01 — the candidate-array `push({...})` paths
 * allocated every frame.)
 */
import type Phaser from 'phaser';
import { gridToWorldPx, type DynamicLight, type LightPlacementTiled } from './LightPacker.js';
import { HERO_LIGHT_OVERRIDES, DEFAULT_HERO_LIGHT } from './LightPalette.js';
import {
  selectLightsForBudget,
  createBudgetScratch,
  DEFAULT_BUDGET,
  LIGHT_PRIORITY,
  type BudgetConfig,
  type BudgetScratch,
  type DynamicLightCandidate,
  type StaticLightCandidate,
} from './LightBudget.js';

/**
 * Representative radius for ambient-scatter candidates in the budget cull
 * (ticket 17). The prototype's scatter loop used radius 120–280
 * (`prototype.js:611`); the per-light realized radius is set deterministically
 * by the packer from the placement's grid coords (so every client agrees). The
 * budget's distance-cull only needs a representative value to test disk-vs-rect
 * intersection — the midpoint of the spec range (200) plus the default 256px
 * halo margin comfortably covers the full 120–280 band, so the cull never
 * drops a scatter disk whose halo could reach the viewport.
 */
const SCATTER_CULL_RADIUS = 200;

/**
 * The kept slices ready to hand to `packLights`. The arrays are the stage's
 * reused scratch (references valid only until the next `select` call).
 */
export interface BudgetedLights {
  placements: LightPlacementTiled[];
  dynamic: DynamicLight[];
}

/**
 * One per pipeline. Owns the scratch arrays + budget config. The pipeline
 * populates `dynamicCandidates` each frame (via `addDynamicLight`), then calls
 * `select()` to get the budgeted slices for packing.
 */
export class LightingBudgetStage {
  /** The per-frame dynamic candidate list (populated by the populator). */
  readonly dynamicCandidates: DynamicLightCandidate[] = [];
  /** Budget config (default = spec ≤80 on-screen + 256px margin). */
  budgetConfig: BudgetConfig = DEFAULT_BUDGET;

  // Reused scratch (zero per-frame allocation at steady state):
  private readonly staticCandidates: StaticLightCandidate[] = [];
  private readonly budgetedPlacements: LightPlacementTiled[] = [];
  private readonly budgetedDynamic: DynamicLight[] = [];
  /**
   * Ticket 01 (B4 perf) — grow-only pools for the per-frame candidate
   * wrappers. The entries are acquired via {@link acquireStaticCandidate} /
   * {@link acquireDynamicCandidate} and mutated in place; the high-water mark
   * is reached once (worst-case placement/entity count) then reused every
   * frame, so steady-state allocation is zero. Pre-ticket-01 each frame
   * allocated ~160 `StaticLightCandidate` + one `DynamicLightCandidate` per
   * `addDynamic` call (~64+ at 64-player peak) — a load-bearing GC-pressure
   * source per the B4 investigation.
   */
  private readonly staticPool: StaticLightCandidate[] = [];
  private readonly dynamicPool: DynamicLightCandidate[] = [];
  /**
   * Ticket 24 — instance-scoped budget scratch (was the module-singleton
   * SORT_BUFFER/STATIC_OUT/DYNAMIC_OUT in LightBudget.ts). One per pipeline,
   * so no hidden cross-instance state; the `_resetBudgetBuffersForTests` test
   * hook is gone (a fresh stage = fresh scratch).
   */
  private readonly budgetScratch: BudgetScratch = createBudgetScratch();
  /**
   * B4 H5 — reused `BudgetedLights` result wrapper. `select()` returns this
   * same object every frame (mutating `placements`/`dynamic` to point at the
   * reused slices below) instead of allocating a fresh `{placements, dynamic}`
   * literal per call. One object per stage instance, never resized — zero
   * per-frame allocation.
   */
  private readonly budgetedResult: BudgetedLights = {
    placements: this.budgetedPlacements,
    dynamic: this.budgetedDynamic,
  };

  /** Begin a new frame: clear the dynamic candidate list. */
  beginFrame(): void {
    this.dynamicCandidates.length = 0;
  }

  /** Add a dynamic light + its budget priority for this frame. */
  addDynamic(light: DynamicLight, priority: number): void {
    // Ticket 01 (B4 perf): acquire a pooled wrapper + mutate in place instead
    // of pushing a fresh `{ light, priority }` literal (was one alloc per
    // registered light — ~64+ at 64-player peak). The `light` ref itself is
    // owned by the populator (pooled separately in DynamicLightPopulator).
    const i = this.dynamicCandidates.length;
    let entry = this.dynamicPool[i];
    if (entry === undefined) {
      entry = { light, priority };
      this.dynamicPool[i] = entry;
    } else {
      entry.light = light;
      entry.priority = priority;
    }
    this.dynamicCandidates[i] = entry;
  }

  /**
   * Run the budget pass + return the kept slices. The camera's `worldView` is
   * the only per-frame input (placements are set at map load). Mutates + returns
   * the reused `BudgetedLights` scratch — read it before the next `select`.
   */
  select(
    placements: ReadonlyArray<LightPlacementTiled>,
    tileSize: number,
    cam: Phaser.Cameras.Scene2D.Camera,
  ): BudgetedLights {
    // Fast path: both feeds empty → skip the budget entirely.
    if (placements.length === 0 && this.dynamicCandidates.length === 0) {
      this.budgetedPlacements.length = 0;
      this.budgetedDynamic.length = 0;
      return this.budgetedResult;
    }

    // Build the static-candidate scratch (grid→world px + hero radius + the
    // ticket-17 scatter priority tag). Ambient-scatter placements
    // (`isScatter: true`) get the AMBIENT_SCATTER priority so they trim BEFORE
    // motivated props when over budget, and a representative cull radius (the
    // prototype's scatter range midpoint — see SCATTER_CULL_RADIUS).
    //
    // Ticket 01 (B4 perf): each candidate acquires a POOLED entry
    // (this.staticPool) instead of pushing a fresh `{...}` literal. Every
    // field is set explicitly each frame so a pooled entry reused across a
    // scatter→non-scatter transition carries no stale state (priority is
    // always set; non-scatter gets STATIC, which behaves identically to the
    // pre-ticket-01 "no priority field → defaults to STATIC" path).
    this.staticCandidates.length = 0;
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      let x: number;
      let y: number;
      let radius: number;
      let priority: number;
      if (p.isScatter) {
        x = gridToWorldPx(p.gridX, tileSize);
        y = gridToWorldPx(p.gridY, tileSize);
        radius = SCATTER_CULL_RADIUS;
        priority = LIGHT_PRIORITY.AMBIENT_SCATTER;
      } else {
        const hero = HERO_LIGHT_OVERRIDES[p.kind];
        // Map-redesign ticket 04: honor an explicit per-placement radius (the
        // beacon's 512px) so the cull disk matches the REALIZED packer radius
        // (`LightPacker` uses `p.radius ?? hero.radius`). Existing map-gen
        // placements never set `radius`, so their cull behavior is unchanged.
        radius = p.radius ?? hero?.radius ?? DEFAULT_HERO_LIGHT.radius;
        x = gridToWorldPx(p.gridX, tileSize);
        y = gridToWorldPx(p.gridY, tileSize);
        // Map-redesign ticket 05 (DEC-005): the beacon band — hero-landmark
        // destination lights outrank every other static (sconces, crystals,
        // POI pools) and all ambient scatter, so a beacon is never dropped
        // for scatter when the on-screen budget trims. Still below every
        // dynamic combat band (player/explosion/projectile).
        priority = p.kind === 'beacon' ? LIGHT_PRIORITY.BEACON : LIGHT_PRIORITY.STATIC;
      }
      let entry = this.staticPool[i];
      if (entry === undefined) {
        entry = { x, y, radius, priority };
        this.staticPool[i] = entry;
      } else {
        entry.x = x;
        entry.y = y;
        entry.radius = radius;
        entry.priority = priority;
      }
      this.staticCandidates[i] = entry;
    }

    // Camera rect (world px). The lit RT is viewport-sized, so off-screen lights
    // contribute nothing visible — culling them is free perf.
    const wv = cam.worldView;
    const result = selectLightsForBudget(
      this.staticCandidates,
      this.dynamicCandidates,
      { x: wv.x, y: wv.y, width: wv.width, height: wv.height },
      this.budgetConfig,
      this.budgetScratch,
    );

    // Build the budgeted placement slice from the kept static indices.
    this.budgetedPlacements.length = 0;
    for (let i = 0; i < result.staticIndices.length; i++) {
      const idx = result.staticIndices[i]!;
      this.budgetedPlacements.push(placements[idx]!);
    }
    // Build the budgeted dynamic slice from the kept dynamic indices.
    this.budgetedDynamic.length = 0;
    for (let i = 0; i < result.dynamicIndices.length; i++) {
      const idx = result.dynamicIndices[i]!;
      this.budgetedDynamic.push(this.dynamicCandidates[idx]!.light);
    }
    return this.budgetedResult;
  }
}
