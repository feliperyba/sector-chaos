/**
 * GameSceneDevHooks — dev/debug instrumentation extracted from GameScene.ts
 * (max-lines cap). Mechanical extraction: bodies verbatim, `this.X` →
 * parameter references (the GameScenePositionHelpers pattern).
 *
 * Cohesive group: the ARMS-DUMP console hook, the WalkStutter (C5) logger
 * install + per-frame record, and the prediction-error overlay. All are
 * diagnostics — none touch gameplay state.
 */
import Phaser from 'phaser';
import type { PlayerState } from './types.js';
import type { PlayerRenderer } from './rendering/PlayerRenderer.js';
import type { CameraService } from './rendering/CameraService.js';
import type { GameState } from './controllers/GameState.js';
import type { PredictionService } from './prediction/PredictionService.js';
import type { TelemetrySampler } from './telemetry/TelemetrySampler.js';
import { WalkDebugLog } from './debug/WalkDebugLog.js';
import { DesignTokens } from './ui/DesignTokens.js';

const PREDICTION_OVERLAY_ENABLED =
  (typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('showPredictionError') === 'true') ||
  (typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).__SECTO_DEBUG_SHOW_OVERLAY__ === true);

/**
 * Bug 2 (lingering arms): live diagnostic dump, ALWAYS available (one
 * function ref — negligible cost) so it works in any build. Call
 * `window.__SECTO_ARMS_DUMP()` from the console when arms linger — returns
 * { orphanArmKeys, visualKeys, armState }. orphanArmKeys non-empty ⇒ arms
 * orphaned (no visual, so updateAllPlayerFrames never hides them — the prime
 * suspect for arms frozen at world positions). armState anyVisible with the
 * matching visualKey bodyVisible false ⇒ a visibility leak.
 */
export function installArmsDump(playerRenderer: PlayerRenderer): void {
  window.__SECTO_ARMS_DUMP = () => {
    const r = playerRenderer.__debugArmLeak();
    // eslint-disable-next-line no-console
    const visibleArms = r.armState.filter((a) => a.anyVisible);
    const bodyByKey = new Map(r.visualKeys.map((v) => [v.key, v]));
    const leaks = visibleArms.filter((a) => {
      const b = bodyByKey.get(a.key);
      return !b || !b.bodyVisible || b.bodyAlpha < 0.5;
    });
    // eslint-disable-next-line no-console
    console.log(
      `[ARMS-DUMP] orphanArmKeys=${r.orphanArmKeys.length} ` +
        `visibleArmSets=${visibleArms.length} ` +
        `leaks(arms-visible/body-hidden)=${leaks.length}`,
      { orphanArmKeys: r.orphanArmKeys, leaks, full: r },
    );
    return r;
  };
}

/**
 * WalkStutter instrumentation (C5). DEV-gated like the debug bridge. Reads
 * camera scroll at render time (deferred-emit), so it must outlive update()
 * and is torn down on SHUTDOWN to avoid leaking the listener on restart.
 * Buffers in-memory (no per-frame console.log — that was a frame-pacing
 * artifact). Dump via window.__SECTO_WALK_SAVE() (download) or
 * __SECTO_WALK_DUMP() (raw string). Returns undefined when not DEV-gated.
 */
export function installWalkDebugLog(scene: Phaser.Scene): WalkDebugLog | undefined {
  if (window.__SECTO_DEBUG__ || import.meta.env.DEV) {
    const dbg = new WalkDebugLog(scene.cameras.main);
    window.__SECTO_WALK_DUMP = () => dbg.dump();
    window.__SECTO_WALK_SAVE = () => {
      const text = dbg.dump();
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `walk-debug-${Date.now()}.log`;
      a.click();
      URL.revokeObjectURL(url);
      return text.length;
    };
    return dbg;
  }
  return undefined;
}

/** The prediction-error overlay (PREDICTION_OVERLAY_ENABLED gate). */
export function createPredictionOverlay(scene: Phaser.Scene): Phaser.GameObjects.Text | undefined {
  if (PREDICTION_OVERLAY_ENABLED) {
    return scene.add
      .text(10, 10, '', {
        fontSize: '13px',
        fontFamily: 'monospace',
        color: '#00ff88',
        backgroundColor: '#000000aa',
        padding: { x: 6, y: 4 },
      })
      .setDepth(DesignTokens.depth.top)
      .setScrollFactor(0);
  }
  return undefined;
}

/** Refresh the prediction-error overlay text (no-op when the overlay is off). */
export function updatePredictionOverlayText(
  text: Phaser.GameObjects.Text | undefined,
  telemetrySampler: TelemetrySampler,
): void {
  if (text) {
    const m = telemetrySampler.snapshot();
    text.setText(
      [
        `pred: ${m.predictionError.toFixed(1)}px`,
        `rtt: ${m.rttMs}ms`,
        `patch: ${m.patchRate}/s`,
        `input: ${m.inputRate}/s`,
        `corr: ${m.maxCorrection.toFixed(1)}px`,
        `off: ${m.renderOffsetMagnitude.toFixed(1)}px`,
        `jank: ${m.jankFrames}`,
      ].join(' | '),
    );
  }
}

/**
 * WalkStutter instrumentation (C5). Captures this frame's pre-render
 * signals; the logger emits the PREVIOUS frame on the next call (once
 * cam.scrollX/Y reflects that frame's render). One [WALK]/[STUTTER] line
 * per alive+moving frame; auto-suppressed when idle. No-op when the logger
 * is not installed.
 */
export function recordWalkDebugFrame(
  scene: Phaser.Scene,
  walkDebugLog: WalkDebugLog | undefined,
  cameraService: CameraService,
  predictionService: PredictionService,
  state: GameState,
  myPlayer: PlayerState | undefined,
  allPlayerPositions: Map<string, { x: number; y: number }> | undefined,
  visual: { x: number; y: number },
  frameDirX: number,
  frameDirY: number,
  isDead: boolean,
  deltaMs: number,
): void {
  if (walkDebugLog) {
    const cam = scene.cameras.main;
    const ft = cameraService.getFollowTarget();
    // Server's last reported authoritative state (latest patch) + count of
    // other players within 256px. The div=lp-server field is the decisive
    // stutter diagnostic: it reveals whether the client drifts ahead of the
    // server steadily (server slower) or stepwise (patch staleness), and
    // near= correlates divergence with bot proximity (client doesn't predict
    // player-vs-player collision the server applies).
    const sp = myPlayer;
    const lpx = state.localPos.x;
    const lpy = state.localPos.y;
    let nearby = 0;
    const positions = allPlayerPositions;
    if (positions) {
      for (const [pid, pos] of positions) {
        if (pid === state.myId) continue;
        const ddx = pos.x - lpx;
        const ddy = pos.y - lpy;
        if (ddx * ddx + ddy * ddy < 256 * 256) nearby++;
      }
    }
    walkDebugLog.record({
      isDead,
      dtMs: deltaMs,
      dirX: frameDirX,
      dirY: frameDirY,
      acc: predictionService.getAccumulator(),
      substeps: predictionService.getLastSubstepCount(),
      lpX: lpx,
      lpY: lpy,
      lvX: state.localVelocity.x,
      lvY: state.localVelocity.y,
      coX: state.correctionOffset.x,
      coY: state.correctionOffset.y,
      visX: visual.x,
      visY: visual.y,
      ftX: ft.x,
      ftY: ft.y,
      lerpX: cam.lerp.x,
      lerpY: cam.lerp.y,
      dz: cam.deadzone ? { w: cam.deadzone.width, h: cam.deadzone.height } : 'null',
      foX: cam.followOffset.x,
      foY: cam.followOffset.y,
      serverX: sp?.x ?? lpx,
      serverY: sp?.y ?? lpy,
      serverVx: sp?.velocityX ?? 0,
      serverVy: sp?.velocityY ?? 0,
      serverSeq: sp?.lastProcessedInput ?? 0,
      nearbyPlayers: nearby,
    });
  }
}
