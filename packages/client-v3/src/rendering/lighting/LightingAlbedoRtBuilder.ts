/**
 * Albedo RT + camera composition setup for the lighting pipeline (extracted
 * from LightingPipeline.ts to respect the 450-line file-length lint cap).
 *
 * Owns two responsibilities:
 *  1. Building + registering the viewport-sized albedo RenderTexture under
 *     its stable texture-manager key (so the Sobel shader can sample it).
 *  2. The Option B composition rationale (transparent camera + depth-filtered
 *     world-ignore + Final-filter HUD alpha-composite) — the documented
 *     Phaser-4.1 constraint that forces the deviation from the prototype's
 *     HTML-CSS HUD + direct-lit-RT-output pattern.
 */
import type Phaser from 'phaser';
import { ALBEDO_RT_KEY } from './LightingPipeline.js';
import type { LightingWorldCaptureRegistry } from './LightingWorldCaptureRegistry.js';

/**
 * Create the viewport-sized albedo RenderTexture + register its WebGL texture
 * under `ALBEDO_RT_KEY`. Called once at construction + again on resize (the
 * caller destroys the previous RT first).
 *
 * GOTCHA #1: the albedoRT itself is the off-screen capture target — it must
 * NOT appear on the main canvas. We hide the RT game object (NOT the pipeline
 * shaders — those stay visible). Hiding the RT GameObject is safe; it has no
 * render-to-texture step of its own to starve.
 */
export function buildAlbedoRT(
  scene: Phaser.Scene,
  gbufW: number,
  gbufH: number,
): Phaser.GameObjects.RenderTexture {
  const albedoRT = scene.add.renderTexture(0, 0, gbufW, gbufH).setOrigin(0, 0);
  albedoRT.setScrollFactor(0);
  albedoRT.setVisible(false);
  // Register the RT's WebGL texture under a stable key so the Sobel shader can
  // sample it by name. Re-register on rebuild.
  if (scene.textures.exists(ALBEDO_RT_KEY)) {
    scene.textures.remove(ALBEDO_RT_KEY);
  }
  // RenderTexture.texture is a Phaser Texture; its WebGL handle lives on the
  // source. `getWebGLTexture()` exists on the runtime instance (declared on
  // the WebGL-only Texture subtype) — cast through unknown to satisfy TS.
  const albedoWebglTex = (
    albedoRT.texture as unknown as {
      getWebGLTexture(): Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
    }
  ).getWebGLTexture();
  scene.textures.addGLTexture(ALBEDO_RT_KEY, albedoWebglTex);
  return albedoRT;
}

/**
 * Apply the Option B camera composition to the main camera. See the rationale
 * in the file header of `LightingPipeline.ts` — this is the documented
 * Phaser-4.1 forced deviation from the prototype's pattern.
 *
 * Prototype pattern (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js`):
 *   - line 367: `cameras.main.setBackgroundColor('#000814')` — opaque.
 *   - line 372: `cameras.main.ignore(this.worldContainer)` — single container.
 *   - line 285: `gl_FragColor = vec4(max(mapped, 0.0), 1.0)` — Final filter
 *     outputs the LIT RT directly; slot 0 (camera scene tex) is UNUSED.
 *   - HUD is HTML/CSS (`index.html:34` `<div id="hud">` with
 *     `position: fixed; z-index: 10`) — rendered by the BROWSER outside the
 *     Phaser canvas, so it survives the camera filter via CSS layering.
 *
 * Why the prototype pattern CANNOT port literally (Phaser-4.1 constraint):
 *   Phaser 4 camera-internal filters process the ENTIRE camera render
 *   (background + every GameObject at every depth). Per the Phaser 4
 *   filter-system docs (phaser.io/news/2026/05/phaser-4-filter-system):
 *   "to keep specific elements like a HUD unfiltered while applying an effect
 *   to the game world, you must use a SEPARATE CAMERA." The prototype evaded
 *   this because its HUD is HTML/CSS (off-canvas); this codebase's HUD is
 *   Phaser GameObjects (HUDFactory: Text/Images with setScrollFactor(0) at
 *   DesignTokens.depth.hudBg=500+), all on the single main camera. If the
 *   Final filter outputted the lit RT directly (prototype-style), the in-
 *   canvas HUD would be CLOBBERED — it lives inside the very texture the
 *   filter replaces. Adding a separate UI camera is a large architectural
 *   change (42+ HUD objects + camera-service follow logic) and out of scope.
 *
 * Option B (in-shader HUD alpha-composite — faithful equivalent of the
 *   prototype's HTML CSS overlay):
 *   1. Main camera background stays TRANSPARENT (`rgba(0,0,0,0)`). Forced
 *      deviation from prototype line 367 — required so the camera's scene
 *      texture has alpha=0 where no HUD draws, giving the HUD's alpha channel
 *      the discriminator role that CSS z-index plays in the prototype's HTML
 *      HUD. With an opaque background (alpha=1 everywhere) the composite
 *      `mix(lit, scene.rgb, scene.a)` would always pick `scene` and the lit
 *      world would be lost.
 *   2. World-depth children (depth < worldDepthCutoff) are ignored on the
 *      main camera (done in LightingPipeline.update) — the codebase
 *      equivalent of the prototype's `cam.ignore(worldContainer)` (line 372).
 *      There's no single world container here (objects span MapRenderer RTs +
 *      EntityRenderer/PlayerRenderer/ZoneRenderer at depths 3–25), so depth-
 *      filtering the ignore is the faithful port. Prevents the unlit world
 *      double-rendering; only the lit RT (composited by the Final filter)
 *      shows the world.
 *   3. The Final filter (shaders/lighting/final.frag) tonemaps the lit RT and
 *      alpha-composites the HUD (slot 0) over it:
 *        `out = mix(mapped, scene.rgb, scene.a)`
 *      — the in-shader equivalent of the prototype's HTML HUD overlaying the
 *      canvas via CSS.
 *
 * Visual proof (Seam C, this ticket): the HUD (health/inventory/timer/
 *   minimap/killfeed) is verified legible over the lit world in a real
 *   browser screenshot. The transparent background + alpha composite is
 *   load-bearing for HUD visibility.
 */
export function applyOptionBCameraSetup(scene: Phaser.Scene): void {
  scene.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
}

/**
 * Draw the visible world (baked world RenderTextures + live GameObjects) into
 * the albedo RT, mirroring the prototype's per-frame capture
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:774`):
 *
 *     this.albedoRT.draw(this.worldContainer);
 *
 * The prototype's worldContainer is a Container of live Sprites, so a single
 * `draw()` call captures everything. The real codebase's world is a mix of
 * BAKED RenderTexture GameObjects (MapRenderer's per-layer world RTs at
 * `renderStaticVisualLayers`, lines 332-388) + live GameObjects (players,
 * projectiles, zones, etc.). Both kinds must be captured into the albedo.
 *
 * ── Phaser-4.1 RT-into-RT capture: `draw()` is the correct API. ──
 *
 * The faithful Phaser-4.1 idiom for capturing GameObjects — including baked
 * RenderTexture GameObjects — into a destination RenderTexture is `draw()`:
 *
 *   `Phaser.GameObjects.RenderTexture#draw(entries, x, y, alpha, tint)`
 *    (node_modules/.pnpm/phaser@4.1.0/.../gameobjects/rendertexture/RenderTexture.js:485)
 *
 * which delegates to the underlying DynamicTexture's `draw()`
 * (DynamicTexture.js:793). For each entry it pushes a DRAW command
 * (DynamicTextureCommands.DRAW = 4) into the command buffer; when the
 * destination RT is `render()`ed, the WebGL DynamicTextureHandler invokes
 * `object.renderWebGLStep(...)` for each entry
 * (DynamicTextureHandler.js:233-264). For a RenderTexture entry that routes
 * through `RenderTextureWebGLRenderer` (RenderTextureWebGLRenderer.js:24-54):
 *
 *   1. The `src.isCurrentlyRendering` guard prevents infinite loops when an RT
 *      is drawn into another RT.
 *   2. `src.render()` flushes the source RT's own command buffer to its
 *      framebuffer (no-op when the source has no pending commands — the steady
 *      state for the baked world RTs after `MapRenderer.render`).
 *   3. `ImageWebGLRenderer` then draws the source RT as a textured quad using
 *      its framebuffer texture (the source RT's `texture.source.glTexture`,
 *      wired to the DrawingContext's render texture at DynamicTexture.js:197).
 *
 * The source RT GameObject is positioned at world (0,0) with origin (0,0) and
 * size = full world (`renderStaticVisualLayers`, lines 334-336); drawn through
 * the albedo RT's own camera (which mirrors the main cam scroll/zoom — see
 * LightingPipeline.update) it lands at exactly the world footprint the main
 * camera would render it at. One consistent transform model: the albedo RT's
 * camera transforms EVERYTHING (RTs and live objects alike); no hand-rolled
 * per-entry screen-space math.
 *
 * ── Why NOT stamp (the iteration-2 path that produced an empty albedo). ──
 *
 * Iteration 2 split the world into RenderTextures (stamped via
 * `albedoRT.stamp(rtTex.key, ...)`) and live objects (drawn via `draw()`).
 * The stamp path is the wrong tool here:
 *
 *   - `stamp(key, frame, x, y, config)` (DynamicTexture.js:669) draws a
 *     texture by KEY in the destination RT's local drawing space — it
 *     explicitly IGNORES the DynamicTexture's camera (DynamicTexture.js:656,
 *     docstring: "This method ignores the `camera` property of the Dynamic
 *     Texture"). To position the world correctly you must hand-roll the
 *     camera scroll+zoom into the stamp's x/y/scale. That hand-rolled math
 *     runs in a DIFFERENT transform space than `draw()` (which respects the
 *     camera), so RT-vs-live-object parallax breaks under zoom.
 *   - Empirically (Seam C, iteration 2): the stamped world RTs produced a 96%
 *     black albedo (debug-albedo-passthrough.png) — the test light's emissive
 *     halo was the only non-black contribution, confirming `albedo.rgb ≈ 0`
 *     at every world tile. The world seen on screen was bleeding through slot
 *     0 of the Final filter (the camera-internal scene texture), NOT being
 *     lit. The stamp was effectively a no-op for the world tiles.
 *
 * `draw()` is the prototype-validated path; it captures both baked RTs and
 * live GameObjects with one consistent camera transform. Iteration 3 replaced
 * the stamp with `draw()` and the world RTs were captured (verified
 * empirically: drawing a single world RT into a fresh RT with `draw()`
 * produced a 44% non-black texture with the real tile content visible).
 *
 * ── GOTCHA #5 (pinned) — pipeline-internal RT Shaders MUST be excluded. ──
 *
 * Iteration 3's first `draw()` attempt STILL produced a 96% black albedo
 * because the world-capture list also included the pipeline's own sobelShader
 * + hdrShader (both `renderToTexture: true`). Drawing a renderToTexture
 * Shader into an RT is destructive to the host flush:
 *
 *   ShaderWebGLRenderer (`phaser/.../gameobjects/shader/ShaderWebGLRenderer.js:
 *   27-40`) ignores the destination RT's drawingContext and renders into its
 *   OWN framebuffer instead:
 *
 *       if (src.renderToTexture) {
 *           drawingContext = src.drawingContext;   // hijacks the dest context
 *           ...
 *           drawingContext.use();                  // binds the SHADER's FB
 *       }
 *       src.renderNode.run(drawingContext, src, parentMatrix);
 *       if (src.renderToTexture) { drawingContext.release(); }
 *
 *   After the Shader returns, the GPU's currently-bound framebuffer is left
 *   pointing at the SHADER's framebuffer (the batch system binds the FB
 *   lazily on the first quad after a `finishBatch()`, and `release()` ends
 *   on the Shader's FB). The DynamicTextureHandler's `currentContext`
 *   variable still references the albedo's drawingContext, but the GPU
 *   state is now wrong — subsequent DRAW entries (the actual world tiles)
 *   flush into the Shader's framebuffer instead of the albedo's.
 *
 * Empirical proof (Seam C, iteration 3, live dev server):
 *   - Drawing the 4 world RTs alone (no Shaders) into a fresh RT with the
 *     pipeline's camera state: 44% non-black, real tile content visible.
 *   - Pipeline's albedo with the 2 Shaders in the capture list: 96% black.
 *   - Pipeline's albedo AFTER excluding the 2 Shaders (this fix): tiles
 *     visible — see `debug-albedo-passthrough.png` (Seam C proof artifact).
 *
 * The prototype's worldContainer (`prototype.js:355`) does NOT contain its
 * Sobel/HdrLit shaders (they're separate display-list objects), so excluding
 * pipeline-internal RT shaders from the world capture is the faithful port.
 * The exclusion lives in `LightingPipeline.update()` (it has the shader
 * references) and skips both by reference and defensively by
 * `type === 'Shader' && renderToTexture === true`.
 */
export function drawWorldIntoAlbedo(
  albedoRT: Phaser.GameObjects.RenderTexture,
  world: ReadonlyArray<Phaser.GameObjects.GameObject>,
): void {
  if (world.length === 0) return;
  // Single draw() of the full world-depth list. RenderTextures + live Sprites
  // all flow through the same camera-transformed path. The albedo RT's camera
  // (set in LightingPipeline.update) supplies the scroll/zoom; we do not
  // transform coordinates here.
  albedoRT.draw(world as Phaser.GameObjects.GameObject[]);
}

/**
 * Per-frame Pass 1 (ticket 51 layout): mirror the main camera into the
 * albedo RT's camera, synchronize the INCREMENTAL world-capture registry
 * (spawn/destroy events maintain it — replaces the per-frame full
 * display-list scan; see LightingWorldCaptureRegistry for the
 * order-equivalence proof + the `__LIGHTING_CAPTURE_COMPARE__` harness),
 * draw the world into the albedo, and refresh the registered GL texture
 * handle (re-binding the source each frame matches the prototype).
 *
 * @returns false when the RT's camera is gone (scene-teardown window) —
 * the caller bails for that frame (was an inline guard in
 * `LightingPipeline.update` before this extraction).
 */
export function captureWorldIntoAlbedo(
  scene: Phaser.Scene,
  albedoRT: Phaser.GameObjects.RenderTexture,
  captureRegistry: LightingWorldCaptureRegistry,
  gbufW: number,
  gbufH: number,
): boolean {
  const cam = scene.cameras.main;
  const rtCam = albedoRT.camera;
  // Defense-in-depth: `RenderTexture.preDestroy` nulls `.camera`. Phaser's
  // scene-teardown `DisplayList.shutdown` destroys children DURING the
  // SHUTDOWN event — if `update()` is still being driven in that window
  // (e.g. a scene forgot to bind its `shutdown` to the event, or an async
  // `create()` overran), `rtCam` is null. Bail instead of throwing — the RT
  // is gone, there's nothing to capture. The scene's SHUTDOWN binding
  // (GameScene.ts:358 / MainMenuScene.create) is the primary fix; this guard
  // keeps a single missed frame from crashing the page.
  if (!rtCam) return false;
  rtCam.setScroll(cam.scrollX, cam.scrollY);
  rtCam.setZoom(cam.zoom);
  rtCam.setOrigin(cam.originX, cam.originY);
  rtCam.setSize(gbufW, gbufH);
  albedoRT.clear();
  captureRegistry.synchronize();
  drawWorldIntoAlbedo(albedoRT, captureRegistry.list);
  albedoRT.render();
  // Refresh the registered GL texture handle (re-binding the source each
  // frame matches the prototype).
  const albedoSource = scene.textures.get(ALBEDO_RT_KEY).source as unknown as {
    glTexture: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
  };
  albedoSource.glTexture = (
    albedoRT.texture as unknown as {
      getWebGLTexture(): Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
    }
  ).getWebGLTexture();
  return true;
}

/**
 * Inputs for `buildWorldCaptureList`: the pipeline's exclusion set + the
 * world/HUD depth boundary. Extracted from `LightingPipeline.update` to respect
 * the 450-line file-length lint cap.
 */
export interface WorldCaptureInputs {
  /** The scene's display list (cycled each frame). */
  children: Phaser.GameObjects.GameObject[];
  /** The albedo RT (never drawn into itself). */
  albedoRT: Phaser.GameObjects.RenderTexture;
  /**
   * The pipeline-internal RT shaders that MUST be excluded from the capture
   * (GOTCHA #5 — see the file header). Sobel, HdrLit, + the 3 bloom shaders.
   */
  rtShaders: ReadonlyArray<Phaser.GameObjects.Shader>;
  /** Children with `depth >= worldDepthCutoff` are HUD/overlays (excluded). */
  worldDepthCutoff: number;
}

/**
 * GameObjects explicitly registered OUT of the lighting world-capture
 * (map-polish ticket 30). A registered object is NEITHER drawn into the
 * albedo RT NOR ignored on the main camera — it renders into the camera
 * scene texture, which the Final filter alpha-composites OVER the lit world
 * (the same slot-0 path the HUD travels). This is the "above the lighting
 * composite" registration for world-space overlay VFX (the beacon motes).
 *
 * WeakSet: identity-keyed, entries die with the object (no leak, no cleanup
 * protocol). Checked inside `passesWorldCaptureFilter` so the incremental
 * registry AND the full-scan comparator oracle share one predicate — the
 * two paths can never diverge on the exclusion.
 */
const worldLightCaptureExcluded = new WeakSet<Phaser.GameObjects.GameObject>();

/**
 * Register a GameObject to render ABOVE the deferred lighting composite
 * instead of inside it (ticket 30): excludes it from the albedo world-capture
 * so it is composited over the lit output via the camera scene texture.
 * Call synchronously with the object's creation (before the first render) —
 * the capture registry evaluates new display-list entries at the next
 * PRE_RENDER/update, so a same-tick registration always wins.
 */
export function excludeFromWorldLightCapture(obj: Phaser.GameObjects.GameObject): void {
  worldLightCaptureExcluded.add(obj);
}

/**
 * Per-object world-capture predicate — ONE shared implementation used by
 * BOTH the per-frame full scan (`buildWorldCaptureList`, ticket 51: kept as
 * the correctness-comparator oracle + seed reference) and the incremental
 * hot path (`LightingWorldCaptureRegistry`). Extracted so the two paths can
 * NEVER drift on filter semantics — the incremental list's correctness is
 * only provable against the scan if both evaluate the exact same predicate.
 *
 * Exclusions (in order):
 *  - explicit `excludeFromWorldLightCapture` registration (ticket 30) — the
 *    above-composite overlay path (beacon motes).
 *  - `child === albedoRT` — never draw the RT into itself.
 *  - `rtShaders` membership (reference identity) — GOTCHA #5.
 *  - `depth >= worldDepthCutoff` — HUD/overlays excluded (GOTCHA #2).
 *  - defensive: any `type === 'Shader' && renderToTexture` — GOTCHA #5.
 */
export function passesWorldCaptureFilter(
  child: Phaser.GameObjects.GameObject,
  albedoRT: Phaser.GameObjects.RenderTexture,
  rtShaders: ReadonlyArray<Phaser.GameObjects.Shader>,
  worldDepthCutoff: number,
): boolean {
  // Ticket 30: registered overlays render over the composite, not into it.
  if (worldLightCaptureExcluded.has(child)) return false;
  if (child === albedoRT) return false; // never draw the RT into itself
  for (let j = 0; j < rtShaders.length; j++) {
    if (rtShaders[j] === child) return false; // GOTCHA #5 — pipeline-internal RT shaders hijack the FB
  }
  const obj = child as Phaser.GameObjects.GameObject & {
    depth: number;
    renderToTexture?: boolean;
  };
  if (obj.depth >= worldDepthCutoff) return false;
  // Defensive: any renderToTexture Shader hijacks the framebuffer — skip.
  if (child.type === 'Shader' && obj.renderToTexture === true) return false;
  return true;
}

/**
 * Build the world-capture list (the world-depth subset of the scene's display
 * list) + lazily ignore newly-spawned world objects on the main camera.
 *
 * TICKET 51: this full scan is NO LONGER the hot path —
 * `LightingWorldCaptureRegistry` maintains the list incrementally on
 * scene ADDED/REMOVED events (see that file for the order/depth-mirror
 * proof). This function survives as (a) the comparator oracle for the
 * correctness harness (acceptance criterion: "run both, assert equal") and
 * (b) documentation of the exact semantics the incremental path mirrors.
 *
 * Two gotchas pinned here:
 *  - GOTCHA #2: world-depth children are ignored on the main camera so they
 *    don't also render unlit to the screen (the Final filter shows the LIT RT
 *    instead). Faithful port of the prototype's `cam.ignore(worldContainer)`
 *    (prototype.js:372) — there's no single container here (objects span
 *    MapRenderer RTs + EntityRenderer/PlayerRenderer/ZoneRenderer at depths
 *    3–25), so depth-filtering the ignore (< worldDepthCutoff =
 *    DesignTokens.depth.hudBg = 500) is the equivalent. HUD/overlays at depth
 *    >= 500 stay on the main camera only (slot 0 for the Final filter's alpha
 *    composite). RT shaders are NOT ignored (gotcha #2: they need to render
 *    on the main cam to drive their RT output) — they're excluded from the
 *    CAPTURE list separately (gotcha #5).
 *  - GOTCHA #5: pipeline-internal RT shaders MUST be excluded from the
 *    capture (their ShaderWebGLRenderer hijacks the framebuffer — see the file
 *    header for the full diagnosis). Skipped by reference AND defensively by
 *    `type === 'Shader' && renderToTexture === true`.
 *
 * Zone overlays at depths 3/24/25 ARE captured → the light pass composes over
 * them (GDD §8.1.4 — siege red tint + walled-sector darkening stay legible).
 */
export function buildWorldCaptureList(
  inputs: WorldCaptureInputs,
  outList: Phaser.GameObjects.GameObject[],
  cam: Phaser.Cameras.Scene2D.Camera,
  ignoredOnMainCam: Set<Phaser.GameObjects.GameObject>,
): void {
  outList.length = 0;
  const { children, albedoRT, rtShaders, worldDepthCutoff } = inputs;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!c) continue;
    if (!passesWorldCaptureFilter(c, albedoRT, rtShaders, worldDepthCutoff)) continue;
    outList.push(c);
    if (!ignoredOnMainCam.has(c)) {
      cam.ignore(c);
      ignoredOnMainCam.add(c);
    }
  }
}
