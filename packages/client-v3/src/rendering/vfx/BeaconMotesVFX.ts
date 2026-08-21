/**
 * BeaconMotesVFX — the beacon particle-system renderer (map-polish tickets
 * 02 + 17). Ticket 17 makes the particles a first-class artistic layer: a
 * THREE-tier composition around every hero + fortress beacon crystal, all
 * drawn into ONE Graphics with ADDITIVE blending so the particles read
 * AGAINST the glow instead of being washed out by it:
 *
 *   INNER SPARKS  bright tight-orbit motes (64–128 px, ≈1–2 min/orbit) —
 *                 the glinting halo hugging the crystal.
 *   OUTER DUST    slower, larger, fainter motes drifting 160–288 px out —
 *                 colored haze hanging in the moody mid falloff.
 *   ACCENTS       a rare pulse ring (every 8–13 s) + a rare ember streak
 *                 with a fading trail (every 11–16 s) — the crystal visibly
 *                 EXHALES.
 *
 * All parameters + the closed-form accent math live in the Phaser-free
 * `BeaconMotesConfig` (sparks + shared hash/tint) and `BeaconMotesTiers`
 * (dust + accents + union culling) — see those headers for the ADR-0035
 * determinism contract (pure integer hash of synced ids; same map ⇒
 * identical composition on every client; NO dynamic light submitted).
 *
 * Why the motes render ABOVE the lighting composite (ticket 30, round 3):
 * tickets 02/17 drew the particles at world depth 400 — captured INTO the
 * albedo RT, so the deferred beacon light evaluated OVER the particle
 * pixels. Near the crystal the beacon falloff saturated the albedo into a
 * white-ish blob and the particles vanished inside it (the owner's verdict:
 * "washed away by the crystal light ... only the ring is noticeable"). Two
 * alpha-only retunes could not fix a LAYER bug. The Graphics now draws at
 * `DesignTokens.depth.vfxOverlay` (480) and is registered OUT of the
 * world-capture (`excludeFromWorldLightCapture`): it is neither captured
 * into the albedo nor ignored on the main camera, so it renders into the
 * camera scene texture — the slot-0 path the HUD travels — which the Final
 * filter alpha-composites OVER the lit world (final.frag
 * `mix(mapped, scene.rgb, scene.a)`). The particles read as sparks floating
 * OVER the glow; there is exactly ONE copy (no washed under-layer + crisp
 * top copy).
 *
 * Blend note (traced, not assumed): the scene texture stores PREMULTIPLIED
 * pixels — the Phaser-4 batch shader returns `vec4(color * alpha, alpha)`
 * (ApplyTint.glsl) and ADD blends as `(ONE, DST_ALPHA)`
 * (WebGLRenderer.js blend table) — so a mote drawn onto the empty slot-0
 * buffer stores rgb = tint·α, a = α, and the Final composite yields
 * `mapped·(1−α) + tint·α²`: semi-transparent presence scales QUADRATICALLY.
 * The tuning bands in BeaconMotesConfig/BeaconMotesTiers are set so the
 * effective (α²) presence matches the intended on-screen read — sparks at
 * 0.55–0.95 read as a 0.30–0.90 presence lerp toward their tint; the dust
 * and the rare accents store √(intended) alphas. ADD is kept over NORMAL
 * (identical on the empty buffer; differing only on mote-vs-mote overlap)
 * so overlapping particles still only brighten each other, and the Canvas
 * fallback ('lighter' composite) keeps the additive read.
 *
 * Perf discipline (zero per-frame allocations in the steady-state update):
 * per-anchor packed `Float64Array` spark + dust params are allocated ONCE in
 * `setAnchors` (when the synced landmarks arrive); the accent evaluators
 * write into constructor-allocated scratch records; the update loop is
 * index-based with a single `Graphics` clear + redraw. Anchors outside the
 * camera view rect + union `CULL_MARGIN` are skipped (zero draw entries) —
 * worst case is 17 anchors × ~31 ops map-wide, culled to the ~1–3 anchors
 * on screen.
 *
 * Lifecycle: constructed in `GameSceneSetup.setupGameSystems`; anchors fed in
 * the `onMapData` handler (next to the light-prop wiring) from the SAME
 * synced `MapData.landmarks` the composite bake consumes + the beacon light
 * placements; driven from the scene loop via the Phaser scene UPDATE event
 * (GameScene.ts sits at its 498-line file-length cap, so the motes
 * self-subscribe — the `LightingWorldCaptureRegistry` PRE_RENDER /
 * `MatchmakingUI` PRE_UPDATE pattern — instead of growing `GameScene.update`);
 * destroyed on scene SHUTDOWN (self-subscribed + the setup shutdown handler;
 * idempotent).
 *
 * Render band: depth 480 (`DesignTokens.depth.vfxOverlay`, ticket 30) —
 * ABOVE the deferred lighting composite, BELOW the HUD. Under WebGL the
 * Graphics is registered out of the world-capture (`excludeFromWorldLightCapture`)
 * so it renders into the camera scene texture and is composited over the lit
 * world by the Final filter (the HUD's slot-0 path); on the Canvas fallback
 * (no lighting pipeline) it renders directly on the main camera, above the
 * world-VFX band and below the HUD.
 */
import Phaser from 'phaser';
import type { LandmarkAssignment, LightPlacementTiled } from '@sector-battle/shared';
import { excludeFromWorldLightCapture } from '../lighting/LightingAlbedoRtBuilder.js';
import { DesignTokens } from '../../ui/DesignTokens.js';
import {
  MOTE_ALPHA_OFFSET,
  MOTE_BOB_AMPLITUDE_OFFSET,
  MOTE_BOB_FREQ_OFFSET,
  MOTE_BOB_PHASE_OFFSET,
  MOTE_PARAM_STRIDE,
  MOTE_PHASE_OFFSET,
  MOTE_RADIUS_OFFSET,
  MOTE_SIZE_OFFSET,
  MOTE_SPEED_OFFSET,
  MOTES_PER_BEACON,
  TAU,
  collectBeaconAnchors,
  fillMoteParams,
  findFortressBeaconPlacement,
  moteTint,
  moteTintWith,
} from './BeaconMotesConfig.js';
import {
  ACCENT_TINT_BRIGHTEN,
  DUST_PER_BEACON,
  DUST_TINT_BRIGHTEN,
  EMBER_HEAD_SIZE,
  EMBER_TRAIL_DT,
  EMBER_TRAIL_SEGMENTS,
  EMBER_WIDTH,
  RING_WIDTH,
  type EmberPoint,
  type RingEval,
  emberAlpha,
  emberLifeProgress,
  emberLifeSeconds,
  emberPointAt,
  evalPulseRing,
  fillDustParams,
  isAnchorInView,
} from './BeaconMotesTiers.js';

/** One beacon crystal's preallocated particle record (built once, read per frame). */
interface BeaconAnchorMotes {
  /** Crystal center in world px (tile center — the composite-bake anchor). */
  x: number;
  y: number;
  /** Anchor tile (the pure-hash key for the accent evaluators). */
  tileX: number;
  tileY: number;
  /** 0xRRGGBB INNER-SPARK tint (beacon color brightened toward white). */
  sparkTint: number;
  /** 0xRRGGBB OUTER-DUST tint (beacon color, more saturated). */
  dustTint: number;
  /** 0xRRGGBB ACCENT tint (beacon color, brightest derivation). */
  accentTint: number;
  /** Packed spark params (MOTES_PER_BEACON × MOTE_PARAM_STRIDE). */
  sparks: Float64Array;
  /** Packed dust params (DUST_PER_BEACON × MOTE_PARAM_STRIDE). */
  dust: Float64Array;
}

export class BeaconMotesVFX {
  private readonly scene: Phaser.Scene;
  private readonly gfx: Phaser.GameObjects.Graphics;
  /** Rebuilt only inside setAnchors (once per map) — never per frame. */
  private anchors: BeaconAnchorMotes[] = [];
  /** Orbit/bob time base (seconds), advanced only by update(). */
  private elapsed = 0;
  /** Accent scratch records (constructor-allocated, reused every frame). */
  private readonly ringOut: RingEval = { radius: 0, alpha: 0 };
  private readonly emberNow: EmberPoint = { dx: 0, dy: 0 };
  private readonly emberPrev: EmberPoint = { dx: 0, dy: 0 };
  private destroyed = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    // Ticket 30: ABOVE the lighting composite, BELOW the HUD. The
    // world-capture exclusion is registered in the SAME synchronous block as
    // the Graphics' creation — the capture registry defers new-entry
    // evaluation to the next PRE_RENDER/update, so the exclusion always
    // wins (the Graphics is never captured into the albedo, never ignored
    // on the main camera).
    this.gfx = scene.add.graphics().setDepth(DesignTokens.depth.vfxOverlay);
    excludeFromWorldLightCapture(this.gfx);
    // ADD blend: overlapping particles may only BRIGHTEN one another, never
    // occlude — the anti-wash contract (see the file header for the
    // premultiplied slot-0 composite math).
    this.gfx.setBlendMode(Phaser.BlendModes.ADD);
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.handleSceneUpdate);
    scene.events.on(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown);
  }

  /**
   * One-shot anchor feed — called from the onMapData handler when the synced
   * landmarks/light placements arrive. The ONLY method that allocates
   * (per-anchor spark + dust Float64Arrays + record), once per map load.
   * Hero anchors come from the synced landmarks; the fortress anchor resolves
   * from the synced beacon light placements. The crystal center uses the same
   * tile-center anchor as `bakeLandmarkComposites`.
   */
  setAnchors(
    landmarks: LandmarkAssignment | null | undefined,
    lightPlacements: ReadonlyArray<LightPlacementTiled> | null | undefined,
    tileSize: number,
  ): void {
    if (this.destroyed) return;
    this.anchors.length = 0;
    const fortress = findFortressBeaconPlacement(landmarks, lightPlacements);
    for (const spec of collectBeaconAnchors(landmarks, fortress)) {
      const sparks = new Float64Array(MOTES_PER_BEACON * MOTE_PARAM_STRIDE);
      fillMoteParams(spec.tileX, spec.tileY, sparks);
      const dust = new Float64Array(DUST_PER_BEACON * MOTE_PARAM_STRIDE);
      fillDustParams(spec.tileX, spec.tileY, dust);
      this.anchors.push({
        x: spec.tileX * tileSize + tileSize / 2,
        y: spec.tileY * tileSize + tileSize / 2,
        tileX: spec.tileX,
        tileY: spec.tileY,
        sparkTint: moteTint(spec.color),
        dustTint: moteTintWith(spec.color, DUST_TINT_BRIGHTEN),
        accentTint: moteTintWith(spec.color, ACCENT_TINT_BRIGHTEN),
        sparks,
        dust,
      });
    }
  }

  /** Scene-loop hook (Phaser scene UPDATE event; delta in ms). */
  private readonly handleSceneUpdate = (_time: number, deltaMs: number): void => {
    // Mirror GameScene.update's delta clamp (50ms): a backgrounded tab restores
    // a huge delta that would otherwise fast-forward the orbits.
    this.update(Math.min(deltaMs, 50) / 1000);
  };

  /** Scene-shutdown hook (self-subscribed; destroy is idempotent). */
  private readonly handleShutdown = (): void => {
    this.destroy();
  };

  /**
   * Advance the composition and redraw — one single-Graphics clear + redraw,
   * zero allocations. Anchors outside the camera world-view rect + union
   * CULL_MARGIN are skipped (zero draw entries for off-screen beacons).
   *
   * Sparks + dust share the fire-DOT aura orbit idiom (ParticleVFX :250-265):
   * `cos/sin(phase + speed·t)` at the particle's orbit radius, plus a slow
   * sine bob on y — all parameters read from the packed per-anchor arrays
   * (same slot layout, two bands). The accents are closed-form (see
   * BeaconMotesTiers): the ring strokes one expanding circle, the ember
   * samples its curve at past τ for the trail.
   */
  update(dtSeconds: number): void {
    if (this.destroyed) return;
    if (this.anchors.length === 0) {
      this.gfx.clear(); // a re-feed with empty data must not leave stale dots
      return;
    }
    this.elapsed += dtSeconds;
    this.gfx.clear();
    const view = this.scene.cameras.main.worldView;
    for (let a = 0; a < this.anchors.length; a++) {
      const anchor = this.anchors[a]!;
      if (!isAnchorInView(anchor.x, anchor.y, view.x, view.y, view.width, view.height)) {
        continue;
      }
      this.drawOrbitTier(anchor, anchor.sparks, MOTES_PER_BEACON, anchor.sparkTint);
      this.drawOrbitTier(anchor, anchor.dust, DUST_PER_BEACON, anchor.dustTint);
      this.drawPulseRing(anchor);
      this.drawEmberStreak(anchor);
    }
  }

  /**
   * One orbiting tier (sparks or dust — identical loop shape over the shared
   * packed layout, differing only in band constants and tint).
   */
  private drawOrbitTier(
    anchor: BeaconAnchorMotes,
    m: Float64Array,
    count: number,
    tint: number,
  ): void {
    const t = this.elapsed;
    for (let i = 0; i < count; i++) {
      const o = i * MOTE_PARAM_STRIDE;
      const angle = m[o + MOTE_PHASE_OFFSET]! + m[o + MOTE_SPEED_OFFSET]! * t;
      const bob =
        Math.sin(m[o + MOTE_BOB_FREQ_OFFSET]! * TAU * t + m[o + MOTE_BOB_PHASE_OFFSET]!) *
        m[o + MOTE_BOB_AMPLITUDE_OFFSET]!;
      this.gfx.fillStyle(tint, m[o + MOTE_ALPHA_OFFSET]!);
      this.gfx.fillCircle(
        anchor.x + Math.cos(angle) * m[o + MOTE_RADIUS_OFFSET]!,
        anchor.y + Math.sin(angle) * m[o + MOTE_RADIUS_OFFSET]! + bob,
        m[o + MOTE_SIZE_OFFSET]!,
      );
    }
  }

  /** The rare pulse-ring accent: one expanding, fading stroke off the crystal. */
  private drawPulseRing(anchor: BeaconAnchorMotes): void {
    evalPulseRing(anchor.tileX, anchor.tileY, this.elapsed, this.ringOut);
    if (this.ringOut.alpha <= 0.004) return; // fully faded — no draw entry
    this.gfx.lineStyle(RING_WIDTH, anchor.accentTint, this.ringOut.alpha);
    this.gfx.strokeCircle(anchor.x, anchor.y, this.ringOut.radius);
  }

  /**
   * The rare ember-streak accent: a head dot + a trail of closed-form past
   * positions (the SAME curve sampled at τ−k·Δτ — no history buffer), fading
   * tail-first. Dormant most of the period (zero draw entries).
   */
  private drawEmberStreak(anchor: BeaconAnchorMotes): void {
    const q = emberLifeProgress(anchor.tileX, anchor.tileY, this.elapsed);
    if (q < 0) return; // dormant
    const headAlpha = emberAlpha(q);
    // Trail spacing in life-progress: EMBER_TRAIL_DT seconds of real time,
    // scaled by the anchor's hash-derived life window (pure — no state).
    const dq = EMBER_TRAIL_DT / emberLifeSeconds(anchor.tileX, anchor.tileY);
    emberPointAt(anchor.tileX, anchor.tileY, q, this.emberNow);
    let prevX = anchor.x + this.emberNow.dx;
    let prevY = anchor.y + this.emberNow.dy;
    for (let k = 1; k <= EMBER_TRAIL_SEGMENTS; k++) {
      const qk = q - dq * k;
      if (qk < 0) break; // the trail stops at the ember's birth
      emberPointAt(anchor.tileX, anchor.tileY, qk, this.emberPrev);
      const x = anchor.x + this.emberPrev.dx;
      const y = anchor.y + this.emberPrev.dy;
      const segAlpha = headAlpha * (1 - k / EMBER_TRAIL_SEGMENTS);
      this.gfx.lineStyle(EMBER_WIDTH, anchor.accentTint, segAlpha);
      this.gfx.lineBetween(prevX, prevY, x, y);
      prevX = x;
      prevY = y;
    }
    this.gfx.fillStyle(anchor.accentTint, headAlpha);
    this.gfx.fillCircle(anchor.x + this.emberNow.dx, anchor.y + this.emberNow.dy, EMBER_HEAD_SIZE);
  }

  /** Tear down: unsubscribe the scene hooks, drop the anchor records, destroy the Graphics. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.handleSceneUpdate);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown);
    this.anchors.length = 0;
    this.gfx.destroy();
  }
}
