/**
 * LightingPipelineAtmosphere — the per-frame atmosphere drive extracted from
 * LightingPipeline.ts (ticket 12). Respects the 450-line file-length lint cap.
 *
 * Two responsibilities (both pure — no Phaser, no allocation in steady state):
 *  1. `resolveEmberAnchors` — derive the FLAME anchor positions (world px)
 *     from the static placements (kind ∈ {torch, campfire, candle} —
 *     `FLAME_ANCHOR_KINDS` in LightingAtmosphereConfig) + the kept dynamic fire
 *     lights (barrel-fire / explosions / fire-traps). Ticket 21 broadened this
 *     from the prototype's campfire-only anchor (prototype.js:556) so embers
 *     are source-motivated everywhere a flame lives.
 *  2. `driveAtmosphere` — advance the atmosphere's global time + camera state
 *     for one frame, called BEFORE the albedo capture so the particles are
 *     positioned correctly when `buildWorldCaptureList` runs.
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): the atmosphere is
 * mood, never vision. Honors the `window.__LIGHTING_ATMOSPHERE__` toggle for
 * the Seam B A/B screenshot proof.
 */
import type Phaser from 'phaser';
import {
  resolveFlameAnchors,
  type AtmosphereCameraState,
  type CampfireAnchor,
} from './LightingAtmosphereConfig.js';
import type { LightingAtmosphere } from './LightingAtmosphere.js';
import type { DynamicLight, LightPlacementTiled } from './LightPacker.js';

/** Inputs the atmosphere drive needs from the pipeline (the live state). */
export interface AtmosphereDriveInputs {
  /**
   * The static map-gen placements. Flame kinds (`torch` / `campfire` / `candle`
   * — see `FLAME_ANCHOR_KINDS`) become ember anchors; biome-glow + barrel-fire
   * placements are skipped (see the set's docstring for why).
   */
  placements: ReadonlyArray<LightPlacementTiled>;
  /** Grid→world px conversion factor. */
  tileSize: number;
  /**
   * The kept dynamic slice from the last budget `select()` — fire-colored
   * lights (warm hot palette) fold in as transient ember anchors (barrel-fire/
   * explosions / fire-traps). Cool auras + warm-yellow projectiles are skipped.
   */
  keptDynamic: ReadonlyArray<DynamicLight>;
  /**
   * Camera center (world px) for this frame. Ticket 31: `resolveEmberAnchors`
   * selects the static flame placements NEAREST this point — the legacy
   * first-N-by-generation-order slice measured as always-the-top-band
   * campfires (all 120 embers rose in one map corner on every seed).
   */
  cameraX: number;
  cameraY: number;
}

/**
 * Resolve the ember anchor positions (world px) for this frame. Reads the
 * static flame placements (`FLAME_ANCHOR_KINDS`) + the kept dynamic fire lights
 * (red-dominant color = flame). Capped so a 64-player explosion spam doesn't
 * balloon the ember budget (resolveFlameAnchors caps at maxAnchors=8).
 */
export function resolveEmberAnchors(inputs: AtmosphereDriveInputs): CampfireAnchor[] {
  const { placements, tileSize, keptDynamic, cameraX, cameraY } = inputs;
  const dynamicFirePositions: { x: number; y: number }[] = [];
  for (let i = 0; i < keptDynamic.length; i++) {
    const d = keptDynamic[i]!;
    // Fire-colored lights (warm hot palette) are the flame anchors. The aura
    // (cool blue) + projectile (warm yellow) lights are NOT flame → skip.
    // Match by the fire palette's red-dominant color (r > 0.8 && r > b*2).
    if (d.color[0] > 0.8 && d.color[0] > d.color[2] * 2) {
      dynamicFirePositions.push({ x: d.x, y: d.y });
    }
  }
  return resolveFlameAnchors(placements, tileSize, dynamicFirePositions, {
    x: cameraX,
    y: cameraY,
  });
}

/**
 * Drive the atmosphere for one frame. Advances the global time + camera state
 * + flame anchors (resolved from the static flame placements + kept dynamic
 * fire lights), BEFORE the albedo capture (so the particles are positioned
 * correctly when `buildWorldCaptureList` runs). No-op when the atmosphere
 * hasn't booted.
 *
 * Why this is a named helper, not inlined into `LightingPipeline.update`
 * (ticket 24 middle-man review — it EARNS its keep):
 *  - Anchor resolution (`resolveEmberAnchors`) is real pipeline-owning logic
 *    (it reads the kept dynamic slice + the static placements + applies the
 *    fire-color filter); inlining would leak that into the pipeline body.
 *  - The `Phaser.Cameras.Scene2D.Camera` → `AtmosphereCameraState`
 *    translation (worldView → {scrollX, scrollY, viewWidth, viewHeight}) is a
 *    real type bridge so `LightingAtmosphere.update` stays Phaser-free at the
 *    Seam A test surface.
 *  - The null-guard keeps the pipeline's `update` branch-free when the
 *    atmosphere hasn't booted (Canvas fallback / pre-boot).
 *
 * @param atmosphere   the booted atmosphere controller (or null if not built).
 * @param inputs       the pipeline state for ember-anchor resolution.
 * @param timeSeconds  scene time in seconds (drives twinkle/shimmer phase).
 * @param cam          the main camera (for the dust-mote view-follow zone).
 */
export function driveAtmosphere(
  atmosphere: LightingAtmosphere | null,
  inputs: AtmosphereDriveInputs,
  timeSeconds: number,
  cam: Phaser.Cameras.Scene2D.Camera,
): void {
  if (!atmosphere) return;
  atmosphere.setCampfireAnchors(resolveEmberAnchors(inputs));
  const wv = cam.worldView;
  const camState: AtmosphereCameraState = {
    scrollX: wv.x,
    scrollY: wv.y,
    viewWidth: wv.width,
    viewHeight: wv.height,
  };
  atmosphere.update(timeSeconds, camState);
}
