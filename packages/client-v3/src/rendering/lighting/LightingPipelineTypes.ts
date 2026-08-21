/**
 * LightingPipelineTypes — shared type + key surface for the deferred lighting
 * pipeline. Mechanical extraction from LightingPipeline.ts (max-lines cap);
 * re-exported by LightingPipeline.ts so import sites are unchanged.
 */

/** RT texture keys (the registry keys the next stage samples by). */
export const ALBEDO_RT_KEY = '__albedoRT';
export const NORMALS_RT_KEY = '__normalsRT';
export const LIT_RT_KEY = '__litRT';
/** Bloom chain RT keys (ticket 08) — half-res, sample key for the next stage. */
export const BLOOM_BRIGHT_RT_KEY = '__bloomBright';
export const BLOOM_H_RT_KEY = '__bloomH';
export const BLOOM_V_RT_KEY = '__bloomVRT';

export interface LightingPipelineOptions {
  /** Tile size in world px (grid→world conversion for placements). */
  tileSize: number;
  /**
   * Depth cutoff: scene children with `depth < worldDepthCutoff` are captured
   * into the albedo RT each frame (the "visible world"). HUD/overlays live at
   * `depth >= hudBg` (`DesignTokens.depth.hudBg` = 500), so they're excluded.
   * Defaults to `DesignTokens.depth.hudBg`.
   */
  worldDepthCutoff?: number;
  /**
   * Sobel normal-generation strength override for THIS pipeline instance
   * (defaults to the global `SOBEL_STRENGTH`). The menu passes a stronger value
   * so its few hero lights read with more surface relief; the gameplay scene
   * omits it and uses the global default (unaffected).
   */
  sobelStrength?: number;
  /**
   * Specular-term scale override for THIS pipeline instance (defaults to 1.0 —
   * un-tempered). The menu passes a >1 value so the albedo-modulated specular
   * sheen reads more strongly on its fixtures; gameplay omits it (1.0,
   * unaffected).
   */
  specularScale?: number;
}
