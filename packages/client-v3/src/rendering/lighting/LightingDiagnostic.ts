/**
 * Diagnostic snapshot builder for the lighting pipeline (extracted from
 * LightingPipeline.ts to respect the 450-line file-length lint cap).
 *
 * Mirrors the prototype's `diag.js` glTexture-existence probing — does NOT
 * call `readPixels` / `game.renderer.snapshot` (Phaser-4.1 gotcha #4: those
 * stall the GPU + can trip CONTEXT_LOST_WEBGL in headless SwiftShader).
 *
 * The snapshot exposes each pipeline shader's existence + glTexture-non-null
 * state, each RT key's registration, the Final filter/controller wiring, and
 * the last frame's world-capture-list composition + albedo/main camera state.
 * The Seam B harness + the Seam C browser verification assert the shader/RT
 * fields to catch the `setVisible(false)`-starvation regression (starved RTs
 * have null glTextures).
 */
import type Phaser from 'phaser';
import {
  ALBEDO_RT_KEY,
  NORMALS_RT_KEY,
  LIT_RT_KEY,
  BLOOM_BRIGHT_RT_KEY,
  BLOOM_H_RT_KEY,
  BLOOM_V_RT_KEY,
} from './LightingPipeline.js';

/** The structured snapshot returned by `LightingPipeline.getDiagnosticSnapshot()`. */
export interface LightingDiagnosticSnapshot {
  shaders: Record<string, { exists: boolean; glTextureNonNull: boolean }>;
  rts: Record<string, boolean>;
  filterRegistered: boolean;
  finalControllerPresent: boolean;
  /** Last frame's world-capture-list composition (debug — see what's drawn). */
  worldCapture: {
    count: number;
    /** Number of baked world RenderTexture layers captured via draw(). */
    rtCount: number;
    /** Depth histogram of captured children (depth bucket → count). */
    byDepthBuckets: Record<string, number>;
    /** Type histogram of captured children (Phaser type string → count). */
    byType: Record<string, number>;
    /** Texture-key histogram of captured children (ticket 17: verifies
     * `lightProps`-textured prop sprites are in the albedo capture). */
    byTexture: Record<string, number>;
  };
  /** Last frame's albedo RT camera worldView + gbuf size. */
  albedo: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    zoom: number;
    worldView: { x: number; y: number; width: number; height: number };
  };
  /** Half-res bloom chain dimensions (ticket 08). */
  bloom: {
    width: number;
    height: number;
  };
  /**
   * Ticket 51 correctness-harness stats (present only while the dev flag
   * `__LIGHTING_CAPTURE_COMPARE__` is enabled): incremental world-capture
   * list vs the old full-scan oracle, compared every frame.
   */
  captureCompare?: {
    framesCompared: number;
    mismatchFrames: number;
    lastIncrementalLength: number;
    lastScanLength: number;
    lastFirstOrderDiff: number;
  };
  main: {
    scrollX: number;
    scrollY: number;
    zoom: number;
    width: number;
    height: number;
    bgColorAlpha: number;
  };
}

/**
 * Inputs the diagnostic needs from the pipeline. The pipeline passes its live
 * state; this function never mutates it.
 */
export interface DiagnosticInputs {
  sobelShader: Phaser.GameObjects.Shader | undefined;
  hdrShader: Phaser.GameObjects.Shader | undefined;
  /** Bloom chain shaders (ticket 08) — probed for glTexture-non-null. */
  bloomBrightShader: Phaser.GameObjects.Shader | undefined;
  bloomHShader: Phaser.GameObjects.Shader | undefined;
  bloomVShader: Phaser.GameObjects.Shader | undefined;
  scene: Phaser.Scene;
  finalController: unknown;
  worldCaptureList: Phaser.GameObjects.GameObject[];
  albedoRT: Phaser.GameObjects.RenderTexture | undefined;
  gbufW: number;
  gbufH: number;
  /** Half-res bloom dimensions (ticket 08) — surfaced for the harness. */
  bloomW: number;
  bloomH: number;
  /** Ticket 51 comparator stats (undefined unless the dev flag is enabled). */
  captureCompare?: LightingDiagnosticSnapshot['captureCompare'];
}

/** Build the diagnostic snapshot from the pipeline's live state. */
export function buildDiagnosticSnapshot(inputs: DiagnosticInputs): LightingDiagnosticSnapshot {
  const {
    sobelShader,
    hdrShader,
    bloomBrightShader,
    bloomHShader,
    bloomVShader,
    scene,
    finalController,
    worldCaptureList,
    albedoRT,
    gbufW,
    gbufH,
    bloomW,
    bloomH,
    captureCompare,
  } = inputs;
  const shaderProbe = (s: Phaser.GameObjects.Shader | undefined) =>
    s
      ? { exists: true, glTextureNonNull: s.glTexture !== null }
      : { exists: false, glTextureNonNull: false };
  const byDepthBuckets: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byTexture: Record<string, number> = {}; // ticket 17: verify lightProps sprites
  const tally = (c: Phaser.GameObjects.GameObject) => {
    const obj = c as Phaser.GameObjects.GameObject & { depth: number; texture?: { key: string } };
    const bucket = String(Math.floor((obj.depth ?? 0) / 100) * 100);
    byDepthBuckets[bucket] = (byDepthBuckets[bucket] ?? 0) + 1;
    const t = c.type ?? 'unknown';
    byType[t] = (byType[t] ?? 0) + 1;
    const texKey = obj.texture?.key;
    if (texKey) byTexture[texKey] = (byTexture[texKey] ?? 0) + 1;
  };
  for (const c of worldCaptureList) tally(c);
  const rtCam = albedoRT?.camera;
  const mainCam = scene.cameras.main;
  const bgColor = mainCam.backgroundColor as unknown as
    | { color?: number; alpha?: number }
    | undefined;
  return {
    shaders: {
      sobel: shaderProbe(sobelShader),
      hdr: shaderProbe(hdrShader),
      bloomBright: shaderProbe(bloomBrightShader),
      bloomH: shaderProbe(bloomHShader),
      bloomV: shaderProbe(bloomVShader),
    },
    rts: {
      [ALBEDO_RT_KEY]: scene.textures.exists(ALBEDO_RT_KEY),
      [NORMALS_RT_KEY]: scene.textures.exists(NORMALS_RT_KEY),
      [LIT_RT_KEY]: scene.textures.exists(LIT_RT_KEY),
      [BLOOM_BRIGHT_RT_KEY]: scene.textures.exists(BLOOM_BRIGHT_RT_KEY),
      [BLOOM_H_RT_KEY]: scene.textures.exists(BLOOM_H_RT_KEY),
      [BLOOM_V_RT_KEY]: scene.textures.exists(BLOOM_V_RT_KEY),
    },
    filterRegistered: !!(
      scene.game.renderer as unknown as {
        renderNodes?: { getNode?: (name: string) => unknown };
      }
    ).renderNodes?.getNode?.('FilterFinal'),
    finalControllerPresent: !!finalController,
    worldCapture: {
      count: worldCaptureList.length,
      rtCount: byType['RenderTexture'] ?? 0,
      byDepthBuckets,
      byType,
      byTexture, // ticket 17: count by texture key (lightProps = prop fixtures)
    },
    albedo: rtCam
      ? {
          width: gbufW,
          height: gbufH,
          scrollX: rtCam.scrollX,
          scrollY: rtCam.scrollY,
          zoom: rtCam.zoom,
          worldView: {
            x: rtCam.worldView.x,
            y: rtCam.worldView.y,
            width: rtCam.worldView.width,
            height: rtCam.worldView.height,
          },
        }
      : {
          width: 0,
          height: 0,
          scrollX: 0,
          scrollY: 0,
          zoom: 0,
          worldView: { x: 0, y: 0, width: 0, height: 0 },
        },
    bloom: {
      width: bloomW,
      height: bloomH,
    },
    ...(captureCompare ? { captureCompare } : {}),
    main: {
      scrollX: mainCam.scrollX,
      scrollY: mainCam.scrollY,
      zoom: mainCam.zoom,
      width: mainCam.width,
      height: mainCam.height,
      bgColorAlpha: bgColor?.alpha ?? -1,
    },
  };
}
