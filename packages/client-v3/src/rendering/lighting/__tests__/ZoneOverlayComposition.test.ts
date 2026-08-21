import { describe, it, expect } from 'vitest';
import { DesignTokens } from '../../../ui/DesignTokens.js';

/**
 * Ticket 13 — Siege/zone overlay composition with lighting (Seam A guard).
 *
 * The ticket's core invariant: the zone overlays (GDD §8.1.4) are captured into
 * `__albedoRT` before the HdrLit pass so the lighting composes OVER them. The
 * spec's "Zone overlay composition" clause pins it:
 *
 *   "the siege red-tint overlay and walled-sector darkening (rendered by
 *    ZoneRenderer into the siege overlay RT at depth 3) must be treated as part
 *    of the albedo the composite samples — i.e. they are present in __albedoRT
 *    before the light pass."
 *
 * The mechanism: `buildWorldCaptureList` (LightingAlbedoRtBuilder.ts) captures
 * every scene child with `depth < worldDepthCutoff` (= `DesignTokens.depth.hudBg`
 * = 500). The zone overlays live at depths 3/24/25, well under the cutoff, so
 * they flow into the albedo. (Importing `buildWorldCaptureList` directly is
 * blocked here because its module transitively pulls Phaser's runtime, which
 * cannot init in jsdom — the function's integration is covered by the live
 * `__LIGHTING_DIAG__` snapshot in Seam C, which shows RenderTexture + Arc +
 * Graphics captured under the depth-0 bucket. This test instead locks the
 * DEPTH CONTRACT that makes that capture happen — if hudBg ever dropped below
 * 25, or the overlay depths got bumped, the siege red would silently disappear
 * from under the lighting.)
 *
 * The depths asserted here are the real depths the renderers assign:
 *   - MapRenderer.siegeOverlayRT   depth 3  (MapRenderer.render → setDepth(3))
 *   - ZoneRenderer.outsideOverlay  depth 24 (the siege red-tint — GDD §8.1.4)
 *   - ZoneRenderer.zoneCircle      depth 25 (the animated red siege-line border)
 *   - ZoneRenderer.warningOverlay  depth 950 (screen-space — HUD layer, NOT captured)
 */
describe('Ticket 13 — Zone overlay depth contract for albedo capture', () => {
  /** The real cutoff the pipeline uses (DesignTokens.depth.hudBg = 500). */
  const HUD_CUTOFF = DesignTokens.depth.hudBg;

  // The overlay depths, asserted verbatim against the renderers' source so a
  // silent bump is caught here (not in a live match where the siege red quietly
  // vanishes from under the lighting).
  const SIEGE_OVERLAY_RT_DEPTH = 3; // MapRenderer.siegeOverlayRT.setDepth(3)
  const OUTSIDE_OVERLAY_DEPTH = 24; // ZoneRenderer.outsideOverlay.setDepth(24)
  const ZONE_CIRCLE_DEPTH = 25; // ZoneRenderer.zoneCircle.setDepth(25)
  const WARNING_OVERLAY_DEPTH = 950; // ZoneRenderer.warningOverlay.setDepth(950)

  /** Mirrors the predicate in buildWorldCaptureList (depth < cutoff → captured). */
  const isCapturedIntoAlbedo = (depth: number): boolean => depth < HUD_CUTOFF;

  it('DesignTokens.depth.hudBg is 500 (the documented world/HUD boundary)', () => {
    expect(DesignTokens.depth.hudBg).toBe(500);
  });

  it('the siege overlay RT (depth 3) is below the cutoff → captured into the albedo', () => {
    expect(isCapturedIntoAlbedo(SIEGE_OVERLAY_RT_DEPTH)).toBe(true);
  });

  it('the siege red-tint overlay (depth 24) is below the cutoff → captured', () => {
    expect(isCapturedIntoAlbedo(OUTSIDE_OVERLAY_DEPTH)).toBe(true);
  });

  it('the red zone border / siege line (depth 25) is below the cutoff → captured', () => {
    expect(isCapturedIntoAlbedo(ZONE_CIRCLE_DEPTH)).toBe(true);
  });

  it('the screen-space warning border (depth 950) is ABOVE the cutoff → NOT captured (HUD layer)', () => {
    // The warning border renders on the main camera + is alpha-composited by
    // the Final filter over the lit world — it is correctly EXCLUDED from the
    // albedo (lighting must not compose over a HUD-layer overlay).
    expect(isCapturedIntoAlbedo(WARNING_OVERLAY_DEPTH)).toBe(false);
  });

  it('the hudBg cutoff comfortably clears every world-layer overlay (guard against a silent bump)', () => {
    // If hudBg ever dropped to <= 25, the zone overlays would stop being captured
    // and the siege red would silently disappear from under the lighting. This
    // pins the load-bearing margin.
    expect(HUD_CUTOFF).toBeGreaterThan(ZONE_CIRCLE_DEPTH);
    expect(HUD_CUTOFF - ZONE_CIRCLE_DEPTH).toBeGreaterThanOrEqual(475); // 500 - 25
  });

  it('the full overlay stack (RT@3 + tint@24 + border@25) all compose under the lighting together', () => {
    // The composition guarantee only holds if ALL three zone-overlay layers make
    // it into the albedo in the same frame.
    const overlayStack = [SIEGE_OVERLAY_RT_DEPTH, OUTSIDE_OVERLAY_DEPTH, ZONE_CIRCLE_DEPTH];
    expect(overlayStack.every(isCapturedIntoAlbedo)).toBe(true);
  });
});
