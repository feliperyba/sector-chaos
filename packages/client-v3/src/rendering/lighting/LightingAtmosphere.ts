/**
 * LightingAtmosphere — the GPU-particle atmosphere layer controller (ticket 12).
 *
 * Replaces the 06-prototype's flat `Graphics` atmosphere
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:548-580 + 731-765`)
 * with Phaser-4's pooled particle system so the validated "atmospheric depth"
 * (the final delta from 6.5/10 → 7/10 + WOW per the wayfinder 05-addendum
 * blind A/B) holds at 64-player + many-flame scale without per-frame CPU
 * draw cost.
 *
 * Two layers, both ADDITIVE + world-space, in the UNLIT vfxOverlay band
 * (round 5c: `DesignTokens.depth.vfxOverlay` = 480 + registered out of the
 * world-light capture via `excludeFromWorldLightCapture` — ticket 30's
 * mechanism; additive particles are light emitters and must not be multiplied
 * by the scene's light buffer, which rendered them invisible on dim maps):
 *
 *  (a) EMBERS — up to 110 warm particles (`0xffcc66` + white-hot core
 *      `0xffffff`), size 1.5–2.6 × parallax-band multiplier, rising 24–79 px/s
 *      × parallax-band multiplier, horizontal drift, twinkle alpha
 *      (`0.5 + 0.5*sin(t*twinkleSpeed + phase)`) + lifecycle fade
 *      (`sin(life*PI)`), respawn near origin. Anchored to ALL flame-light
 *      positions (torches + campfires + candles + dynamic fires) — distributed
 *      across anchors round-robin (the prototype's `cfIdx` pattern), NOT all at
 *      one fire. Ticket 21 broadened this from campfire-only.
 *
 *  (b) DUST MOTES — recipe-driven per SECTOR (round 5c): one emitter per
 *      district, each with its own shape texture (spark/grain/haze/glint),
 *      saturated family hue and behavior band (LightingAtmosphereThemes.ts),
 *      plus one NEUTRAL circle emitter (demo map / pre-map-load / the menu
 *      diorama). The field is the camera-following rect (2× viewport —
 *      constant on-screen density at any zoom; the A8 world-rect was
 *      reverted, see DUST_FIELD_VIEWPORT_MULTIPLE), split by sector area
 *      each frame (LightingAtmosphereSectorField) so each district's emitter
 *      spawns inside its on-screen slice with a proportional share of the
 *      budget. Death zone = the FULL field for every emitter (motes never
 *      pop at an on-screen sector border).
 *
 * ── Why Phaser particles (not per-particle GameObjects) ──
 *
 * The ticket explicitly forbids per-particle GameObjects (500 GameObjects would
 * be a perf + batching disaster). Phaser's particle system pools + batches all
 * particles of one emitter into a single draw call — the atmosphere's 500
 * particles cost ~2 draw calls total (one per emitter) instead of 500. Each
 * particle is a struct in a typed array, NOT a GameObject on the display list;
 * the EMITTER itself is a single GameObject, which is what the albedo-RT
 * world-capture list picks up.
 *
 * ── Capturing global time in particle callbacks ──
 *
 * The prototype's twinkle/shimmer formulas use GLOBAL scene time `t`
 * (`0.5 + 0.5*sin(t*twinkleSpeed + phase)`), but Phaser's particle `onUpdate`
 * callbacks only receive the particle-LOCAL life fraction `t ∈ [0,1]`. We bridge
 * this by mutating `shared.currentTimeSeconds` (in `update`) which the emitter
 * callbacks (built once in LightingAtmosphereEmitters) re-read each particle
 * update, so twinkle/shimmer stay phase-locked to scene time (matching the
 * prototype's behavior) while the lifecycle fade uses the particle-local life
 * fraction.
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): the particles add
 * depth, never block vision. They render additive over the albedo, so in deep
 * shadow they're near-invisible (additive ≈ 0 where the lit RT is dark) — the
 * "only read where light hits" effect that survived the prototype's blind A/B.
 *
 * ── Toggle (Seam B A/B) ──
 *
 * `window.__LIGHTING_ATMOSPHERE__ = false` hides the layer for the with/without
 * A/B screenshot pair. Defaults ON (production ships with atmosphere). The
 * Seam B harness flips it to capture the "atmosphere matters" proof.
 *
 * The emitter builders (which encode the prototype's exact tuning into the
 * Phaser onEmit/onUpdate callbacks) live in LightingAtmosphereEmitters.ts
 * (extracted to respect the 450-line file-length lint cap + to avoid `this`
 * aliasing in the callback closures).
 */
import Phaser from 'phaser';
import { SectorType } from '@sector-battle/shared';
import {
  type CampfireAnchor,
  type AtmosphereCameraState,
  resolveDustEmitField,
  EMBER_COUNT,
  DUST_COUNT,
  scaleAtmosphereCount,
} from './LightingAtmosphereConfig.js';
import {
  buildEmberEmitter,
  buildDustEmitter,
  neutralDustRecipe,
  sectorDustRecipe,
  ensureAtmosphereParticleTexture,
  destroyAtmosphereParticleTexture,
  type AtmosphereSharedState,
} from './LightingAtmosphereEmitters.js';
import { SECTOR_ATMOSPHERE_THEMES } from './LightingAtmosphereThemes.js';
import { splitDustFieldBySector, type DustFieldSlice } from './LightingAtmosphereSectorField.js';
import {
  ensureSectorParticleTextures,
  destroySectorParticleTextures,
} from './LightingAtmosphereTextures.js';
import { getLightingDevFlags } from './LightingDevFlags.js';

// Re-export the canonical constants + pure helpers so the orchestrator's grep
// + single-import callers reach them through this module. Source of truth
// lives in LightingAtmosphereConfig.ts (Phaser-free for the Seam A test).
export {
  EMBER_COLOR,
  EMBER_CORE_COLOR,
  EMBER_COUNT,
  EMBER_LIFECYCLE_FORMULA,
  EMBER_RISE_MAX,
  EMBER_RISE_MIN,
  EMBER_SIZE_MAX,
  EMBER_SIZE_MIN,
  EMBER_TWINKLE_AMP,
  EMBER_TWINKLE_BASE,
  EMBER_TWINKLE_SPEED_MAX,
  EMBER_TWINKLE_SPEED_MIN,
  DUST_COLOR,
  DUST_COUNT,
  DUST_DRIFT_SPAN,
  DUST_SHIMMER_AMP,
  DUST_SHIMMER_BASE,
  DUST_SHIMMER_FREQ,
  DUST_SIZE_MAX,
  DUST_SIZE_MIN,
  ATMOSPHERE_DEPTH,
  atmosphereSeed,
  PARTICLE_TEXTURE_PX,
  particleScaleForSize,
  resolveCampfireAnchors,
  resolveFlameAnchors,
  FLAME_ANCHOR_KINDS,
  EMBER_PARALLAX_BANDS,
  DUST_PARALLAX_BANDS,
  atmosphereParallaxBand,
  scaleAtmosphereCount,
  REFERENCE_VIEWPORT_AREA,
  DUST_FIELD_VIEWPORT_MULTIPLE,
  resolveDustEmitField,
  cameraFollowDustField,
  COUNT_FLOOR_MULTIPLE,
  COUNT_CEILING_MULTIPLE,
  EMBER_POOL_SIZE,
  DUST_POOL_SIZE,
  type AtmosphereParallaxBand,
  type CampfireAnchor,
  type AtmosphereCameraState,
} from './LightingAtmosphereConfig.js';

/**
 * The atmosphere controller. Owns the two particle emitters. Construct after
 * the scene boots; call `update()` once per frame (after camera follow, before
 * the pipeline's albedo capture). Destroys cleanly on `shutdown()`.
 *
 * The emitters are added to the scene's display list at `ATMOSPHERE_DEPTH`
 * (< `DesignTokens.depth.hudBg` = 500), so the pipeline's `buildWorldCaptureList`
 * picks them up automatically — they render into the albedo RT (additive) and
 * the deferred pipeline lights them. NOT a screen-space overlay.
 */
export class LightingAtmosphere {
  private scene: Phaser.Scene;
  private emberEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  /** Neutral dust emitter (demo TMX map / pre-map-load / menu diorama). */
  private neutralDustEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  /**
   * Per-sector dust emitters (round 5c) — built lazily on the first real grid.
   * `running` tracks stop()/start() (Phaser's `maxAliveParticles = 0` means
   * UNLIMITED, not off — phaser.esm.js:74178's `> 0` guard — so "off" must be
   * an actual flow stop; stop() lets alive particles die out gracefully).
   */
  private readonly sectorDustEmitters: Array<{
    type: SectorType;
    emitter: Phaser.GameObjects.Particles.ParticleEmitter;
    zone: Phaser.Geom.Rectangle;
    running: boolean;
  }> = [];
  /** Flow states for the ember + neutral emitters (see sectorDustEmitters). */
  private emberRunning = true;
  private neutralRunning = true;

  /**
   * Shared mutable state read by the emitter callbacks each particle update.
   * Mutated each frame by `update()`; the callbacks (built once in the emitter
   * builders) re-read it so twinkle/shimmer stay phase-locked to scene time.
   */
  private readonly shared: AtmosphereSharedState = {
    currentTimeSeconds: 0,
    campfireAnchors: [],
    fallbackAnchor: { x: 0, y: 0 },
  };

  /** Whether the atmosphere is currently visible (the __LIGHTING_ATMOSPHERE__ toggle). */
  private enabled = true;

  /**
   * Reused rectangles for the dust emitters (zero allocation per frame): the
   * FULL camera-following field (the death zone for EVERY dust emitter —
   * motes die off-screen, never at an on-screen sector border) + the neutral
   * emitter's emit zone. Sector emitters carry their own zone rects (the
   * per-type slices). All mutated in place by `update()`.
   */
  private readonly dustDeathZone = new Phaser.Geom.Rectangle(0, 0, 1, 1);
  private readonly neutralDustZone = new Phaser.Geom.Rectangle(0, 0, 1, 1);
  /** Reused split output (splitDustFieldBySector reuses its objects). */
  private readonly sectorFieldSlices: DustFieldSlice[] = [];
  /** Sector grid for the dust split (null = the neutral regime). */
  private sectorGrid: readonly (readonly SectorType[])[] | null = null;
  private sectorGridTileSize = 0;
  private sectorGridSectorTileSize = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    ensureAtmosphereParticleTexture(scene);
    this.emberEmitter = buildEmberEmitter(scene, this.shared);
    this.neutralDustEmitter = buildDustEmitter(
      scene,
      this.shared,
      neutralDustRecipe(),
      this.neutralDustZone,
      this.dustDeathZone,
    );
    // Seam B A/B toggle: window.__LIGHTING_ATMOSPHERE__ = false hides the layer.
    // Read each frame in update() so the harness can flip it at runtime. Default
    // ON (production ships with atmosphere — the validated WOW look).
    if (getLightingDevFlags().atmosphere === false) {
      this.enabled = false;
      this.setVisible(false);
    }
  }

  /**
   * Set the flame anchors (world px) for this frame. The ember emitCallback
   * round-robin-assigns each spawned particle to one of these (the faithful
   * port of prototype.js:556), distributing embers across ALL flame positions
   * (torches + campfires + candles + dynamic fires) — NOT all at one fire
   * (hard constraint #4). Call before `update()`. Name kept for back-compat;
   * the anchors are now flame anchors (ticket 21 broadened the filter).
   */
  setCampfireAnchors(anchors: ReadonlyArray<CampfireAnchor>): void {
    this.shared.campfireAnchors = anchors;
  }

  /**
   * Set the sector-type grid for per-sector dust recipes (ticket 31, round
   * 5c). Call at map load — the first non-null call builds the per-sector
   * emitters; null/unknown keeps the single NEUTRAL emitter (the pre-ticket
   * global behavior). `tileSize` is the map's grid→px factor;
   * `sectorTileSize` the sector edge in tiles (SECTOR_TILE_SIZE from shared).
   */
  setSectorTypes(
    sectorTypes: readonly (readonly SectorType[])[] | null,
    tileSize: number,
    sectorTileSize: number,
  ): void {
    this.sectorGrid = sectorTypes;
    this.sectorGridTileSize = tileSize;
    this.sectorGridSectorTileSize = sectorTileSize;
    // Build the per-sector emitters ONCE, on the first real grid (round 5c:
    // one emitter per district — its own shape texture + hue + behavior
    // recipe, LightingAtmosphereThemes). Later calls just refresh the grid.
    if (sectorTypes && this.sectorDustEmitters.length === 0) {
      ensureSectorParticleTextures(this.scene);
      for (const type of Object.values(SectorType)) {
        if (typeof type !== 'string') continue; // string enum — skip reverse-mapped keys
        const theme = SECTOR_ATMOSPHERE_THEMES[type];
        if (!theme) continue;
        const zone = new Phaser.Geom.Rectangle(0, 0, 1, 1);
        const emitter = buildDustEmitter(
          this.scene,
          this.shared,
          sectorDustRecipe(theme),
          zone,
          this.dustDeathZone,
        );
        this.sectorDustEmitters.push({ type, emitter, zone, running: true });
      }
    }
  }

  /**
   * Per-frame update. Advance the global time + reposition the dust-mote emit
   * zone (the camera-following rect, ticket 31 — see
   * LightingAtmosphereConfig.DUST_FIELD_VIEWPORT_MULTIPLE for the density
   * rationale). The deathZone (`onLeave`) recycles motes that drift past the
   * field edge. The ember anchors are assigned per-particle in the
   * emitCallback (round-robin across `campfireAnchors`), so no per-frame
   * emitter repositioning is needed here — only the fallback anchor (camera
   * center) is updated for when no flame anchors are registered. The live
   * particle counts are scaled to the viewport area on change.
   *
   * Call AFTER camera follow, BEFORE the pipeline's albedo capture (so the
   * particles are positioned correctly when `buildWorldCaptureList` runs).
   *
   * @param timeSeconds  scene time in seconds (drives twinkle/shimmer phase).
   * @param camera       the camera state (dust-mote field + ember fallback
   *                     anchor + viewport-area count scaling).
   */
  update(timeSeconds: number, camera: AtmosphereCameraState): void {
    this.shared.currentTimeSeconds = timeSeconds;
    // Honor the runtime toggle (Seam B A/B).
    const shouldShow = getLightingDevFlags().atmosphere !== false;
    if (shouldShow !== this.enabled) {
      this.enabled = shouldShow;
      this.setVisible(shouldShow);
    }
    if (!this.enabled) return;

    // ── Dust field: the camera-following rect (DUST_FIELD_VIEWPORT_MULTIPLE
    // × viewport, centered on the camera — ticket 31 restored this; the A8
    // world-rect experiment collapsed on-screen density ≈13×, see
    // DUST_FIELD_VIEWPORT_MULTIPLE's docstring). It is the DEATH zone for
    // every dust emitter (motes recycle off-screen at the field edge).
    const field = resolveDustEmitField(camera);
    this.dustDeathZone.setTo(field.x, field.y, field.w, field.h);

    // ── Viewport-scaled total budget (ticket 21; per-frame is one property
    // write per emitter — negligible, and keeps a freshly (re)started emitter
    // from running at a stale cap).
    const viewArea = camera.viewWidth * camera.viewHeight;
    const emberLive = scaleAtmosphereCount(EMBER_COUNT, viewArea);
    const dustLive = scaleAtmosphereCount(DUST_COUNT, viewArea);

    // ── Embers: only flow while flame anchors exist (round 5c). Demo maps
    // carry NO light placements — without this gate every ember would swarm
    // the camera-center fallback anchor (the measured round-5c demo state:
    // 109 embers alive in one screen-center cluster, invisible under the lit
    // composite and a monster dot once the layer moved to the unlit band).
    // stop() lets already-alive embers die out gracefully (no pops).
    const hasAnchors = this.shared.campfireAnchors.length > 0;
    if (this.emberEmitter) {
      if (hasAnchors !== this.emberRunning) {
        this.emberRunning = hasAnchors;
        if (hasAnchors) this.emberEmitter.start();
        else this.emberEmitter.stop();
      }
      if (hasAnchors) this.emberEmitter.maxAliveParticles = emberLive;
    }

    // ── Round 5c: split the field by on-screen sector area — each district's
    // emitter spawns inside its slice with a proportional share of the budget;
    // the neutral emitter covers the whole field while no grid is known.
    // Rebalanced every frame so border crossings shift the split as the
    // camera pans; absent sectors STOP their emitter (die-out, no pops).
    if (this.sectorGrid && this.sectorDustEmitters.length > 0) {
      splitDustFieldBySector(
        field,
        this.sectorGrid,
        this.sectorGridTileSize,
        this.sectorGridSectorTileSize,
        this.sectorFieldSlices,
      );
      for (const entry of this.sectorDustEmitters) {
        const slice = this.sectorFieldSlices.find((s) => s.sectorType === entry.type);
        if (slice) {
          if (!entry.running) {
            entry.emitter.start();
            entry.running = true;
          }
          entry.zone.setTo(slice.x, slice.y, slice.w, slice.h);
          entry.emitter.maxAliveParticles = Math.round(dustLive * slice.weight);
        } else if (entry.running) {
          entry.emitter.stop();
          entry.running = false;
        }
      }
      if (this.neutralDustEmitter && this.neutralRunning) {
        this.neutralDustEmitter.stop();
        this.neutralRunning = false;
      }
    } else {
      if (this.neutralDustEmitter) {
        if (!this.neutralRunning) {
          this.neutralDustEmitter.start();
          this.neutralRunning = true;
        }
        this.neutralDustZone.setTo(field.x, field.y, field.w, field.h);
        this.neutralDustEmitter.maxAliveParticles = dustLive;
      }
      for (const entry of this.sectorDustEmitters) {
        if (entry.running) {
          entry.emitter.stop();
          entry.running = false;
        }
      }
    }

    // ── Ember fallback anchor = camera center (used by the emitCallback when
    // no flame anchors are registered yet — keeps embers visible at scene start).
    this.shared.fallbackAnchor.x = camera.scrollX + camera.viewWidth / 2;
    this.shared.fallbackAnchor.y = camera.scrollY + camera.viewHeight / 2;
  }

  /** Show/hide all emitter layers (the toggle path). */
  setVisible(visible: boolean): void {
    this.emberEmitter?.setVisible(visible);
    this.neutralDustEmitter?.setVisible(visible);
    for (const entry of this.sectorDustEmitters) entry.emitter.setVisible(visible);
  }

  /** True when the atmosphere layer is currently rendering. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Tear down (scene shutdown). Destroys the emitters + generated texture;
   * best-effort. Safe to call twice.
   */
  shutdown(): void {
    try {
      this.emberEmitter?.destroy();
      this.neutralDustEmitter?.destroy();
      for (const entry of this.sectorDustEmitters) entry.emitter.destroy();
      destroyAtmosphereParticleTexture(this.scene);
      destroySectorParticleTextures(this.scene);
    } catch {
      // best-effort — never throw on shutdown
    }
    this.emberEmitter = null;
    this.neutralDustEmitter = null;
    this.sectorDustEmitters.length = 0;
  }
}
