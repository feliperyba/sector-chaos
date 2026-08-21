import type { InputCollector } from './InputCollector.js';
import type { InteractionDetector } from '../controllers/InteractionDetector.js';
import type { StateSync } from '../network/StateSync.js';
import type { GameState } from '../controllers/GameState.js';
import type { InputFrame } from '../types.js';
import type { InputActionName } from '@sector-battle/shared';
import type Phaser from 'phaser';

/**
 * NET-03 — per-render-frame input sample + send-boundary frame, fused into
 * one call. The orchestrator owns the per-frame loop entry point: every
 * render frame it (a) samples the live movement direction, (b) runs edge
 * detection, and (c) builds the network `InputFrame` ONLY when the 16ms send
 * boundary is reached. The caller feeds `(dirX, dirY, edges, sendFrame)` to
 * `PredictionService.step` so the prediction reacts to a release within one
 * render frame (eliminates the stale-coasting ghost, NET-01 Cause 1) while
 * the network send rate stays at 16ms (bandwidth unchanged).
 *
 * `seq` stays the sent-frame identity the server acknowledges — only
 * `sendFrame` carries a sequence, and only on send-boundary frames.
 */
export interface PerFrameInput {
  /** Live movement X (raw WASD/arrows, NOT normalized). Sampled every frame. */
  dirX: number;
  /** Live movement Y (raw WASD/arrows, NOT normalized). Sampled every frame. */
  dirY: number;
  /**
   * Edge actions that fired THIS render frame (applied to the prediction on
   * the detection frame so e.g. DASH starts on press). Also accumulated into
   * the next built `InputFrame` for the network send. The returned array is
   * the orchestrator's scratch array — callers should NOT retain it past the
   * next `collect` call (zero-alloc hot path, ADR-0026).
   */
  edges: ReadonlyArray<InputActionName>;
  /**
   * Built `InputFrame` at the 16ms send boundary, or `null` on throttle
   * frames. Non-null frames are sent to the server and recorded for replay.
   * `sequence` is the server-acked identity (increments only on send).
   */
  sendFrame: InputFrame | null;
}

export class InputOrchestrator {
  /** Pre-allocated PerFrameInput scratch — mutated in place every frame. */
  private readonly _scratch: PerFrameInput = {
    dirX: 0,
    dirY: 0,
    edges: Object.freeze([] as InputActionName[]),
    sendFrame: null,
  };

  constructor(
    private readonly inputCollector: InputCollector,
    private readonly interactionDetector: InteractionDetector,
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly worldToScreen: (wx: number, wy: number) => { x: number; y: number },
    private readonly stateSync: StateSync,
  ) {}

  /**
   * Per-render-frame input pipeline entry. Samples the live movement
   * direction + runs edge detection (every frame), AND builds the network
   * `InputFrame` when the 16ms send boundary is reached. Returns a
   * {@link PerFrameInput} view into the orchestrator's scratch memory
   * (mutated in place next call — zero-alloc hot path, ADR-0026).
   *
   * Order:
   *   1. Sample live WASD direction (every frame).
   *   2. Run edge detection (every frame) — edges feed the prediction AND
   *      accumulate for the next send.
   *   3. If on a 16ms send boundary: build the `InputFrame` (drains the edge
   *      queue, adds continuous ATTACK, runs the InteractionDetector to set
   *      `targetId` for the chest prompt). Otherwise `sendFrame = null`.
   */
  collect(activeSlot: number): PerFrameInput {
    const pointer = this.scene.input.activePointer;

    // (1) Live movement direction (every render frame).
    const dir = this.inputCollector.sampleLiveMovement();

    // (2) Edge detection (every render frame). Edges also accumulate into
    // the collector's pending-send queue for the next send-boundary frame.
    const edges = this.inputCollector.pollEdgeActions(pointer, activeSlot);

    // (3) Build the network InputFrame at the 16ms send boundary.
    // aimAngle is derived from the pointer + the player's visual position
    // (same computation as the legacy path — preserved verbatim).
    const visualScreen = this.worldToScreen(this.state.localPos.x, this.state.localPos.y);
    const aimAngle = Math.atan2(pointer.y - visualScreen.y, pointer.x - visualScreen.x);
    const frame = this.inputCollector.collect(pointer, aimAngle);

    if (frame) {
      this.interactionDetector.detect(this.state.localPos.x, this.state.localPos.y, this.stateSync);
      if (
        this.interactionDetector.nearestType === 'chest' &&
        this.interactionDetector.nearestChestId
      ) {
        frame.targetId = this.interactionDetector.nearestChestId;
      }
    }

    const out = this._scratch;
    out.dirX = dir.x;
    out.dirY = dir.y;
    out.edges = edges;
    out.sendFrame = frame;
    return out;
  }
}
