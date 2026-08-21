import Phaser from 'phaser';

/**
 * Zone overlay renderer (GDD §8.1.4): the current-zone ring (`zoneCircle`),
 * the next-zone ring (`targetCircle`), the outside-zone red tint
 * (`outsideOverlay`), the screen-space warning border (`warningOverlay`), and
 * a stub siege-sector overlay (`siegeOverlay` — always geometry-empty; the
 * visible siege walls are baked by MapRenderer's siegeOverlayRT at depth 3).
 *
 * Ticket 54 — create-once, hide-on-clear. All five objects are created in the
 * constructor and hidden until first use; `clear()` hides instead of
 * destroying. This aligns the zone renderer with the create-once pattern the
 * other renderers use and removes both the scattered lazy-create null checks
 * and the destroy/re-create allocation churn around `clear()`.
 *
 * ── Lighting-capture safety (ghost-guard — ticket 47's lesson) ──
 *
 * Four of the five objects sit BELOW the world/HUD capture cutoff
 * (`DesignTokens.depth.hudBg = 500`): zoneCircle + targetCircle at depth 25,
 * outsideOverlay at 24, siegeOverlay at 3. The albedo capture filter
 * (`LightingAlbedoRtBuilder.passesWorldCaptureFilter`) checks DEPTH ONLY — no
 * visibility check — and Phaser's `DynamicTexture.draw` draws ARRAY entries
 * "regardless if they pass a `willRender` check or not" (phaser 4.1
 * DynamicTexture.js:767) — and the capture list is an array. So a hidden
 * object still bakes whatever alpha/geometry it carries into `__albedoRT`.
 * Each hidden object therefore carries a mechanism that makes it contribute
 * NOTHING even while captured:
 *
 *  - Arcs (zoneCircle, targetCircle — depth 25, captured): `setAlpha(0)`.
 *    ArcWebGLRenderer multiplies `src.alpha` into every fill/stroke vertex
 *    tint, so alpha 0 is fully transparent under capture — the same lever
 *    DamageNumberRenderer's pool uses (ticket 47). `setVisible(false)`
 *    additionally skips the main camera (the whole story on the Canvas
 *    fallback path, where the capture pipeline never boots).
 *  - Graphics (outsideOverlay, warningOverlay, siegeOverlay): `clear()` —
 *    Graphics.clear() empties the command buffer (phaser 4.1 Graphics.js),
 *    and an empty buffer submits zero triangles even when drawn into the RT.
 *    `setVisible(false)` skips the main camera (warningOverlay at depth 950
 *    is never captured — HUD layer — so visibility is its whole story).
 *
 * First-show restores the exact state the old lazy-create produced: object
 * alpha 1 + visible (stroke/fill alphas live on the styles, which are never
 * touched). Position/radius are set BEFORE showing, so a placeholder
 * transform is never displayed.
 *
 * Lifecycle: scene shutdown destroys display-list children (phaser 4.1
 * DisplayList.shutdown → `list[i].destroy(true)`), so hide-on-clear cannot
 * leak objects across scene restarts — `clear()` runs on the SHUTDOWN event
 * (GameSceneSetup) and Phaser's teardown finalizes the objects right after.
 */
export class ZoneRenderer {
  private scene: Phaser.Scene;
  private readonly zoneCircle: Phaser.GameObjects.Arc;
  private readonly targetCircle: Phaser.GameObjects.Arc;
  private readonly outsideOverlay: Phaser.GameObjects.Graphics;
  private readonly warningOverlay: Phaser.GameObjects.Graphics;
  private readonly siegeOverlay: Phaser.GameObjects.Graphics;
  private worldW = 0;
  private worldH = 0;
  /**
   * Ticket 20 — outside-overlay state-change guard. The full-map tint depends
   * ONLY on `isOutside` + world size, so it is re-issued solely on a state
   * transition; `overlayApplied` doubles as the "shown since last clear()"
   * flag so a re-show after clear() redraws exactly like the first show.
   */
  private overlayApplied = false;
  private overlayOutside = false;
  private overlayW = 0;
  private overlayH = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    // Create-once (ticket 54): same construction args + style/depth/scroll
    // chains the old lazy creates used, plus the hidden-at-rest state
    // (visible=false, and alpha=0 for the captured Arcs — see class doc).
    this.zoneCircle = scene.add
      .circle(0, 0, 1, 0x000000, 0)
      .setStrokeStyle(3, 0xff4444, 0.8)
      .setDepth(25)
      .setAlpha(0)
      .setVisible(false);
    this.targetCircle = scene.add
      .circle(0, 0, 1, 0x000000, 0)
      .setStrokeStyle(2, 0xffaa00, 0.4)
      .setDepth(25)
      .setAlpha(0)
      .setVisible(false);
    this.outsideOverlay = scene.add.graphics().setDepth(24).setVisible(false);
    this.warningOverlay = scene.add.graphics().setDepth(950).setScrollFactor(0).setVisible(false);
    this.siegeOverlay = scene.add.graphics().setDepth(3).setVisible(false);
  }

  setWorldBounds(w: number, h: number): void {
    this.worldW = w;
    this.worldH = h;
  }

  update(
    cx: number,
    cy: number,
    radius: number,
    targetCx?: number,
    targetCy?: number,
    targetRadius?: number,
    isOutside = false,
    warningActive = false,
  ): void {
    // Show path (first use or re-show after clear): set the transform FIRST,
    // then restore the old lazy-create visible state (object alpha 1). While
    // hidden the object carried alpha 0 — the albedo ghost-guard — so the
    // alpha reset is mandatory on every show, not just the first.
    this.zoneCircle.setPosition(cx, cy).setRadius(Math.max(1, radius));
    this.zoneCircle.setAlpha(1).setVisible(true);

    // Outside-zone overlay (ticket 20 state-change guard): the tint quad's
    // geometry/color/alpha depend only on isOutside + world size, so re-issue
    // clear+fillRect ONLY on a transition (first show, inside↔outside, world
    // resize, or re-show after clear()). The previous per-frame
    // clear()+fillRect(0,0,worldW,worldH) re-tessellated and re-uploaded a
    // full-map 10240² Graphics quad EVERY frame while the player was outside;
    // the steady state now issues zero Graphics commands on this object.
    // Transitions redraw with the exact old command sequence, so the ticket-54
    // ghost-guard contract holds: the command buffer is empty whenever the
    // player is not outside (an empty buffer bakes nothing into __albedoRT).
    if (
      !this.overlayApplied ||
      this.overlayOutside !== isOutside ||
      this.overlayW !== this.worldW ||
      this.overlayH !== this.worldH
    ) {
      this.overlayApplied = true;
      this.overlayOutside = isOutside;
      this.overlayW = this.worldW;
      this.overlayH = this.worldH;
      this.outsideOverlay.setVisible(true);
      this.outsideOverlay.clear();
      if (isOutside && this.worldW > 0) {
        // Ticket 13 — siege red-tint alpha tuned for legibility under the AAA
        // lighting pipeline. This overlay is captured into __albedoRT (depth 24 <
        // hudBg cutoff — see LightingAlbedoRtBuilder.buildWorldCaptureList) so the
        // HdrLit pass composes OVER it: albedo = world*(1-a) + red*a, then
        // lit = albedo*ambientFloor + lights, then ACES + saturation(1.28x) +
        // split-tone grade. At the previous alpha (0.15) the red washed out to
        // "essentially imperceptible" under that pipeline (verified via controlled
        // A/B browser capture — alpha 0.15 vs 0.25, same scene/lighting): the
        // split-tone's cool shadows (0.88,0.97,1.10) further suppress the red in
        // the mid-tones. 0.25 is the smallest value that reads unambiguously as
        // "danger/siege" (GDD §8.1.4) while keeping the world fully visible
        // (cosmetic-only — GDD `docs/GDD.md:210` forbids fog of war; the world
        // stays 75% opaque under the tint). The crisper zoneCircle border
        // (0xff4444 @ 0.8, depth 25) carries the hard edge; this carries the mood.
        this.outsideOverlay.fillStyle(0xff0000, 0.25);
        this.outsideOverlay.fillRect(0, 0, this.worldW, this.worldH);
      }
    }

    if (targetCx != null && targetCy != null && targetRadius != null) {
      this.targetCircle.setPosition(targetCx, targetCy).setRadius(Math.max(1, targetRadius));
      this.targetCircle.setAlpha(1).setVisible(true);
    } else {
      // No next-zone target: hide with the full ghost-guard (alpha 0 — a
      // bare setVisible(false) would still bake the last ring's stroke into
      // the captured albedo, see class doc).
      this.targetCircle.setAlpha(0).setVisible(false);
    }

    this.warningOverlay.setVisible(true);
    this.warningOverlay.clear();
    if (warningActive) {
      const alpha = 0.1 + Math.sin(performance.now() / 200) * 0.1;
      this.warningOverlay.fillStyle(0xff0000, alpha);
      const sw = this.scene.scale.width;
      const sh = this.scene.scale.height;
      const bw = 50;
      this.warningOverlay.fillRect(0, 0, sw, bw);
      this.warningOverlay.fillRect(0, sh - bw, sw, bw);
      this.warningOverlay.fillRect(0, 0, bw, sh);
      this.warningOverlay.fillRect(sw - bw, 0, bw, sh);
    }
  }

  renderSiegedSectors(
    _sectors: { row: number; col: number }[],
    _sectorTileCount: number,
    _tileSize: number,
    _zoneCenterX?: number,
    _zoneCenterY?: number,
    _zoneRadius?: number,
  ): void {
    // Stub visualizer: geometry is always empty (the visible siege walls live
    // in MapRenderer's siegeOverlayRT). Kept visible-on-call to mirror the old
    // object's always-visible-empty state; an empty command buffer contributes
    // nothing under either camera or the albedo capture (depth 3 < cutoff).
    this.siegeOverlay.setVisible(true);
    this.siegeOverlay.clear();
  }

  clear(): void {
    // Hide, don't destroy (ticket 54): the objects are reused forever — the
    // next update()/renderSiegedSectors() call re-shows them without any
    // allocation. Per-object hide mechanism (MUST contribute nothing under
    // BOTH the main camera and the albedo capture — see class doc):
    //  - Arcs (depth 25, captured): alpha 0 + invisible.
    //  - Graphics: empty command buffer (clear()) + invisible — an empty
    //    buffer submits zero triangles even though three of them remain in
    //    the capture list at depths 24/3.
    // Scene shutdown destroys display-list children after this runs, so
    // nothing outlives the scene.
    this.zoneCircle.setAlpha(0).setVisible(false);
    this.targetCircle.setAlpha(0).setVisible(false);
    this.outsideOverlay.clear().setVisible(false);
    this.warningOverlay.clear().setVisible(false);
    this.siegeOverlay.clear().setVisible(false);
    // Ticket 20: clear() hid the overlay — force the next update() back through
    // the overlay state-change guard so it re-shows + redraws (the old code
    // re-showed unconditionally every frame; the guard must not swallow the
    // first post-clear frame).
    this.overlayApplied = false;
  }
}
