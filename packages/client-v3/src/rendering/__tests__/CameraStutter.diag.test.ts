import { describe, it, expect } from 'vitest';
import { PredictionService } from '../../prediction/PredictionService.js';
import { GameState } from '../../controllers/GameState.js';
import type { InputBuffer } from '../../prediction/InputBuffer.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { InputFrame } from '../../types.js';
import { PLAYER, SIM_TICK_DT } from '@sector-battle/shared';
import { cameraLerpFactor, DEADZONE_RATIO } from '../CameraService.js';

/* eslint-disable no-console */

/**
 * Diagnostic-only: drives the real PredictionService + a faithful Phaser
 * deadzone/lerp camera model through sustained walk, and reports which signal
 * channel (localPos / visual / scrollX / screenX) moves backward, and how
 * often. NOT a permanent regression — used to locate the stutter source.
 */

function makeStubCollisionService(): ClientCollisionService {
  return {
    resolveCollision: (x: number, y: number) => ({ x, y }),
    // Ticket 21: PredictionService's hot path uses the pooled seam; the
    // stub mirrors the real contract (writes the out box, returns it).
    resolveCollisionInto: (
      x: number,
      y: number,
      _hw: number,
      _hh: number,
      out: { x: number; y: number },
    ) => {
      out.x = x;
      out.y = y;
      return out;
    },
  } as unknown as ClientCollisionService;
}
function makeStubInputBuffer(): InputBuffer {
  return {
    push: () => {},
  } as unknown as InputBuffer;
}
function makeInput(seq: number): InputFrame {
  return { movementX: 1, movementY: 0, aimAngle: 0, sequence: seq, actions: [] };
}

/**
 * Faithful reimplementation of Phaser 4 Camera.preRender follow+deadzone+lerp
 * (src/cameras/2d/Camera.js:522-604). Origin defaults to (0.5,0.5) so originX
 * = halfWidth. Deadzone is re-centered on midPoint each frame (line 548). The
 * scroll only changes when the follow target exits the deadzone; otherwise the
 * lerp is not applied (hard deadzone).
 */
class CameraSim {
  readonly width: number;
  readonly dzW: number;
  scrollX: number;
  midX: number; // midPoint.x (set at end of preRender = scrollX + halfWidth)
  constructor(width: number, startTargetX: number) {
    this.width = width;
    this.dzW = width * DEADZONE_RATIO;
    const halfWidth = width / 2;
    this.scrollX = startTargetX - halfWidth;
    this.midX = this.scrollX + halfWidth;
  }
  preRender(fx: number, lerp: number): number {
    const halfWidth = this.width / 2;
    let sx = this.scrollX;
    // deadzone centered on PREVIOUS midPoint (Phaser line 548)
    const dzCenter = this.midX;
    const dzLeft = dzCenter - this.dzW / 2;
    const dzRight = dzCenter + this.dzW / 2;
    if (fx < dzLeft) {
      sx = sx - (dzLeft - fx) * lerp; // Linear(sx, sx-(dzLeft-fx), lerp)
    } else if (fx > dzRight) {
      sx = sx + (fx - dzRight) * lerp; // Linear(sx, sx+(fx-dzRight), lerp)
    }
    this.scrollX = sx;
    this.midX = sx + halfWidth;
    return sx;
  }
}

interface Sample {
  t: number;
  dt: number;
  localX: number;
  visualX: number;
  scrollX: number;
  screenX: number; // visualX - scrollX
}

/** Count frames where value DECREASES vs previous frame (a rollback). */
function countRollbacks(values: number[]): { count: number; maxDrop: number } {
  let count = 0;
  let maxDrop = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d < -1e-9) {
      count++;
      if (-d > maxDrop) maxDrop = -d;
    }
  }
  return { count, maxDrop };
}

function runWalk(opts: {
  fps: number;
  frames: number;
  walkX?: number;
  jitterMs?: number;
  viewportW?: number;
}): {
  samples: Sample[];
  localBack: ReturnType<typeof countRollbacks>;
  visualBack: ReturnType<typeof countRollbacks>;
  scrollBack: ReturnType<typeof countRollbacks>;
  screenBack: ReturnType<typeof countRollbacks>;
} {
  const { fps, frames } = opts;
  const jitterMs = opts.jitterMs ?? 0;
  const viewportW = opts.viewportW ?? 2560;
  const state = new GameState();
  state.localPos = { x: 0, y: 0 };
  state.localVelocity = { x: 0, y: 0 };
  const svc = new PredictionService(makeStubCollisionService(), makeStubInputBuffer(), state);
  const cam = new CameraSim(viewportW, 0);
  const samples: Sample[] = [];
  let seq = 1;
  let t = 0;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < frames; i++) {
    const jit = jitterMs ? (rand() - 0.5) * 2 * jitterMs : 0;
    const dt = (1000 / fps + jit) / 1000;
    // sendFrame on the 16ms boundary-ish cadence (every frame at 60fps)
    const sendFrame = makeInput(seq++);
    svc.step(1, 0, dt, PLAYER.BASE_SPEED, false, [], sendFrame);
    const visual = svc.getVisualPosition();
    const lerp = cameraLerpFactor(dt);
    const scrollX = cam.preRender(visual.x, lerp);
    samples.push({
      t,
      dt,
      localX: state.localPos.x,
      visualX: visual.x,
      scrollX,
      screenX: visual.x - scrollX,
    });
    t += dt;
  }
  // Discard first ~25 frames (accel ramp + deadzone acquisition transient).
  const burn = 25;
  const s = samples.slice(burn);
  return {
    samples,
    localBack: countRollbacks(s.map((p) => p.localX)),
    visualBack: countRollbacks(s.map((p) => p.visualX)),
    scrollBack: countRollbacks(s.map((p) => p.scrollX)),
    screenBack: countRollbacks(s.map((p) => p.screenX)),
  };
}

describe('CameraStutter DIAGNOSTIC', () => {
  it('60fps sustained walk — which channel rolls back?', () => {
    const r = runWalk({ fps: 60, frames: 240 });
    console.log('[DIAG] 60fps local  back:', r.localBack);
    console.log('[DIAG] 60fps visual back:', r.visualBack);
    console.log('[DIAG] 60fps scroll back:', r.scrollBack);
    console.log('[DIAG] 60fps screen back:', r.screenBack);
    const s = r.samples.slice(25);
    const screenSwing = Math.max(...s.map((p) => p.screenX)) - Math.min(...s.map((p) => p.screenX));
    console.log(
      '[DIAG] 60fps screenX swing (max-min) over steady-state:',
      screenSwing.toFixed(3),
      'px',
    );
    // print first 15 steady samples to eyeball
    console.log(
      '[DIAG] steady samples (localX, visualX, scrollX, screenX):\n' +
        s
          .slice(0, 15)
          .map((p) =>
            `  ${p.t.toFixed(4)} L=${p.localX.toFixed(2)} V=${p.visualX.toFixed(2)} S=${p.scrollX.toFixed(2)} scr=${p.screenX.toFixed(2)}`.trim(),
          )
          .join('\n'),
    );
    expect(r.samples.length).toBe(240);
  });

  it('60fps with ±3ms delta jitter (real rAF cadence noise)', () => {
    const r = runWalk({ fps: 60, frames: 480, jitterMs: 3 });
    console.log('[DIAG] 60fps±3ms local  back:', r.localBack);
    console.log('[DIAG] 60fps±3ms visual back:', r.visualBack);
    console.log('[DIAG] 60fps±3ms scroll back:', r.scrollBack);
    console.log('[DIAG] 60fps±3ms screen back:', r.screenBack);
    expect(r.samples.length).toBe(480);
  });

  it('165fps sustained walk (no cap) — does extrapolation term cause rollback?', () => {
    const r = runWalk({ fps: 165, frames: 600 });
    console.log('[DIAG] 165fps local  back:', r.localBack);
    console.log('[DIAG] 165fps visual back:', r.visualBack);
    console.log('[DIAG] 165fps scroll back:', r.scrollBack);
    console.log('[DIAG] 165fps screen back:', r.screenBack);
    const s = r.samples.slice(25);
    const screenSwing = Math.max(...s.map((p) => p.screenX)) - Math.min(...s.map((p) => p.screenX));
    console.log('[DIAG] 165fps screenX swing (max-min):', screenSwing.toFixed(3), 'px');
    expect(r.samples.length).toBe(600);
  });
});
