import Phaser from 'phaser';
import type { InputFrame } from '../types.js';
import { INPUT_SEND_INTERVAL_MS } from '../types.js';
import type { InputActionName } from '@sector-battle/shared';
import { weaponSlotAction } from '@sector-battle/shared';

/**
 * NET-03 — the input seam is split into two concerns:
 *
 * 1. **Live sampling (every render frame):** {@link sampleLiveMovement} reads
 *    the WASD/arrows state and {@link pollEdgeActions} runs `JustDown`-style
 *    edge detection for DASH / PICKUP / THROW / WEAPON_SLOT_1..4. The live
 *    movement direction feeds the prediction every render frame so a key
 *    release is captured within one frame (eliminates the "ghost input after
 *    release" — NET-01 Cause 1). Edge actions are applied to the prediction
 *    on the DETECTION frame (so e.g. dash starts on press) AND accumulated
 *    into a pending-send queue so each physical press produces exactly one
 *    action in exactly one built `InputFrame`.
 *
 * 2. **Network frame construction + send (every 16ms, unchanged):**
 *    {@link collect} builds the full `InputFrame` (sequence, aim, actions,
 *    targetId) at the `INPUT_SEND_INTERVAL_MS` (16ms) cadence. It drains the
 *    pending-send edge queue into the frame's `actions[]`, re-reads the live
 *    movement direction into `movementX/Y`, and adds the continuous ATTACK
 *    action when the pointer is held. `seq` stays the sent-frame identity the
 *    server acknowledges. Returns `null` on throttle frames (between sends).
 *
 * Today's wire shape is preserved exactly: discrete actions (DASH/PICKUP/
 * THROW/WEAPON_SLOT_*) appear in exactly one sent `InputFrame` per physical
 * press; ATTACK appears in every sent `InputFrame` while the pointer is held.
 */
export class InputCollector {
  private keys!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    Space: Phaser.Input.Keyboard.Key;
    E: Phaser.Input.Keyboard.Key;
    One: Phaser.Input.Keyboard.Key;
    Two: Phaser.Input.Keyboard.Key;
    Three: Phaser.Input.Keyboard.Key;
    Four: Phaser.Input.Keyboard.Key;
  };
  private cursorKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
  private seq = 0;
  private lastSendTime = 0;
  /**
   * Per-key previous-frame down-state for the JustDown edge detection,
   * keyed by the NUMERIC `key.keyCode` (perf ticket 21): the former string
   * keys cost a `keyCode.toString()` allocation per polled key per render
   * frame (~7 keys → ~420 transient strings/s). Numeric keys are identity-
   * equivalent (keyCode is unique per key; Map<number> semantics are the
   * same get/set contract).
   */
  private prevKeyStates = new Map<number, boolean>();
  private prevRightDown = false;
  private wheelDelta = 0;

  private readonly _scratchActions: InputActionName[] = [];
  private readonly _scratchFrame: InputFrame = {
    movementX: 0,
    movementY: 0,
    aimAngle: 0,
    sequence: 0,
    actions: this._scratchActions,
  };
  /** Pre-allocated reusable box for the live movement direction sample. */
  private readonly _liveDirOut = { x: 0, y: 0 };
  /** Pre-allocated reusable array for per-frame edge actions. */
  private readonly _edgesOut: InputActionName[] = [];

  /**
   * NET-03 pending-send edge queue. Discrete edges (DASH/PICKUP/THROW/
   * WEAPON_SLOT_*) detected per-frame are accumulated here and drained into
   * the next built `InputFrame` at the 16ms send boundary. This guarantees
   * each physical press produces exactly one action in exactly one sent
   * `InputFrame` — even when the edge fires on a throttle frame (between
   * sends), it is held until the next send rather than dropped or duplicated.
   *
   * Reused across sends (cleared in place by {@link collect}) to preserve
   * the zero-alloc hot path (ADR-0026).
   */
  private readonly _pendingSendEdges: InputActionName[] = [];

  private injectQueue: InputFrame[] = [];
  private continuousFrame: InputFrame | null = null;
  private continuousEnd = 0;

  init(
    keyboard: Phaser.Input.Keyboard.KeyboardPlugin,
    inputPlugin: Phaser.Input.InputPlugin,
  ): void {
    this.cursorKeys = keyboard.createCursorKeys();
    this.keys = {
      W: keyboard.addKey('W'),
      A: keyboard.addKey('A'),
      S: keyboard.addKey('S'),
      D: keyboard.addKey('D'),
      Space: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      E: keyboard.addKey('E'),
      One: keyboard.addKey('ONE'),
      Two: keyboard.addKey('TWO'),
      Three: keyboard.addKey('THREE'),
      Four: keyboard.addKey('FOUR'),
    };
    inputPlugin.on(
      'wheel',
      (_pointer: Phaser.Input.Pointer, _dx: number, _dy: number, _dz: number) => {
        this.wheelDelta += _dy;
      },
    );
  }

  injectFrame(frame: InputFrame): void {
    this.injectQueue.push({ ...frame, sequence: this.seq++ });
  }

  injectContinuous(frame: InputFrame, durationMs: number): void {
    this.continuousFrame = { ...frame, sequence: this.seq };
    this.continuousEnd = performance.now() + durationMs;
  }

  clearInjection(): void {
    this.injectQueue = [];
    this.continuousFrame = null;
    this.continuousEnd = 0;
  }

  /**
   * Drain any injected frame (test/dev hook). The injection path bypasses the
   * live sampling + send-throttle split: an injected frame is returned
   * immediately by {@link collect} regardless of the throttle window. Returns
   * `null` when no injection is pending.
   *
   * Exposed as a private helper used by {@link collect}; the production loop
   * never calls it directly.
   */
  private consumeInjection(): InputFrame | null {
    if (this.continuousFrame !== null) {
      if (performance.now() < this.continuousEnd) {
        return { ...this.continuousFrame, sequence: this.seq++ };
      }
      this.continuousFrame = null;
      this.continuousEnd = 0;
    }
    if (this.injectQueue.length > 0) {
      return this.injectQueue.shift() ?? null;
    }
    return null;
  }

  // ─── NET-03 per-frame live sampling ────────────────────────────────

  /**
   * Read the live WASD / arrow-key state into the pre-allocated `out` box
   * (defaults to the collector's own scratch box) and return it. Runs every
   * render frame. The output is the RAW (dx, dy) — NOT normalized — so the
   * prediction derives direction + magnitude the same way the legacy
   * `collect()` path did (callers normalize via `Math.hypot`).
   *
   * This is the prediction's per-frame input sample. NET-03 removed the
   * `step(null)` stale-coasting path: the prediction now sees a release
   * within one render frame instead of up to `INPUT_SEND_INTERVAL_MS` (16ms)
   * later, eliminating the "ghost input after release" (NET-01 Cause 1).
   *
   * Zero-allocation: writes into the caller-supplied box (or the internal
   * scratch box) and returns it. Never allocates (ADR-0026).
   */
  sampleLiveMovement(out: { x: number; y: number } = this._liveDirOut): {
    x: number;
    y: number;
  } {
    let dx = 0;
    let dy = 0;
    if (this.keys.A.isDown || this.cursorKeys.left.isDown) dx -= 1;
    if (this.keys.D.isDown || this.cursorKeys.right.isDown) dx += 1;
    if (this.keys.W.isDown || this.cursorKeys.up.isDown) dy -= 1;
    if (this.keys.S.isDown || this.cursorKeys.down.isDown) dy += 1;
    out.x = dx;
    out.y = dy;
    return out;
  }

  /**
   * Run per-frame edge detection for the discrete (JustDown) actions:
   * DASH (Space), PICKUP (E), THROW (right-button edge), WEAPON_SLOT_1..4
   * (1-4 keys + mouse wheel). Edges that fire THIS render frame are:
   *
   *   (a) appended to `outEdges` (defaults to the internal scratch array) —
   *       the caller feeds them to `PredictionService.step` so the action is
   *       applied to the prediction on the DETECTION frame (e.g. dash starts
   *       on press, not on the next 16ms send boundary);
   *   (b) accumulated into the private pending-send queue, drained by the
   *       next {@link collect} call so each physical press produces exactly
   *       one action in exactly one built `InputFrame` (no double-fire from
   *       the higher sampling rate, no miss-fire when the edge lands on a
   *       throttle frame).
   *
   * The continuous ATTACK action (pointer left-button held) is NOT an edge —
   * it is read directly at the send boundary inside {@link collect}.
   *
   * The wheel-slot edge fires once per accumulated wheel notch: each notch
   * rotates the active slot by ±1 and emits the corresponding
   * `WEAPON_SLOT_N` action. Multiple notches in one frame emit multiple
   * slots (matches the legacy behavior).
   *
   * Zero-allocation: `outEdges` is cleared in place and refilled; the
   * pending-send queue is a long-lived array. Never allocates (ADR-0026).
   */
  pollEdgeActions(
    pointer: Phaser.Input.Pointer,
    activeSlot: number,
    outEdges: InputActionName[] = this._edgesOut,
  ): InputActionName[] {
    outEdges.length = 0;

    // THROW: right-button JustDown edge.
    const wantsThrow = pointer.rightButtonDown() && !this.prevRightDown;
    if (wantsThrow) {
      outEdges.push('THROW');
      this._pendingSendEdges.push('THROW');
    }
    // DASH: Space JustDown edge.
    if (this.justPressed(this.keys.Space)) {
      outEdges.push('DASH');
      this._pendingSendEdges.push('DASH');
    }
    // PICKUP: E JustDown edge.
    if (this.justPressed(this.keys.E)) {
      outEdges.push('PICKUP');
      this._pendingSendEdges.push('PICKUP');
    }
    // Weapon slots: 1-4 JustDown edges.
    if (this.justPressed(this.keys.One)) {
      outEdges.push('WEAPON_SLOT_1');
      this._pendingSendEdges.push('WEAPON_SLOT_1');
    }
    if (this.justPressed(this.keys.Two)) {
      outEdges.push('WEAPON_SLOT_2');
      this._pendingSendEdges.push('WEAPON_SLOT_2');
    }
    if (this.justPressed(this.keys.Three)) {
      outEdges.push('WEAPON_SLOT_3');
      this._pendingSendEdges.push('WEAPON_SLOT_3');
    }
    if (this.justPressed(this.keys.Four)) {
      outEdges.push('WEAPON_SLOT_4');
      this._pendingSendEdges.push('WEAPON_SLOT_4');
    }
    // Wheel-slot: each accumulated notch rotates the active slot by ±1 and
    // emits the corresponding WEAPON_SLOT_N. Multiple notches in one frame
    // emit multiple slots (matches the legacy collect() behavior).
    if (this.wheelDelta !== 0) {
      const dir = this.wheelDelta > 0 ? 1 : -1;
      this.wheelDelta = 0;
      const slot = ((((activeSlot + dir) % 4) + 4) % 4) + 1;
      const action = weaponSlotAction(slot);
      outEdges.push(action);
      this._pendingSendEdges.push(action);
    }

    // Track right-button state for the next frame's THROW edge detection.
    // (Left-button state is read directly via pointer.isDown at the send
    // boundary — ATTACK is continuous, not an edge.)
    this.prevRightDown = pointer.rightButtonDown();

    return outEdges;
  }

  // ─── NET-03 16ms send-boundary frame construction ──────────────────

  /**
   * Build + return the next network `InputFrame`, throttled to
   * `INPUT_SEND_INTERVAL_MS` (16ms). Returns `null` on throttle frames.
   *
   * The frame's `actions[]` is the accumulated edge queue since the last
   * send (drained) PLUS the continuous ATTACK action when the pointer is
   * held. The frame's `movementX/Y` is the LIVE direction sampled at this
   * instant. `aimAngle`, `sequence`, and `targetId` are populated as before.
   * `seq` increments only on send-boundary frames (the server-acked
   * identity).
   *
   * NET-03: this method NO LONGER samples the keyboard or detects edges —
   * those concerns moved to {@link sampleLiveMovement} / {@link pollEdgeActions}
   * so they run every render frame. This method just BUILDS the wire frame
   * at the 16ms cadence and drains the pending-send edge queue.
   *
   * The caller is responsible for the InteractionDetector-based `targetId`
   * population (preserved by `InputOrchestrator.collect`).
   */
  collect(pointer: Phaser.Input.Pointer, aimAngle: number): InputFrame | null {
    const now = performance.now();
    if (now - this.lastSendTime < INPUT_SEND_INTERVAL_MS) return null;
    this.lastSendTime = now;

    const injected = this.consumeInjection();
    if (injected) return injected;

    // Live direction at the send-boundary instant. The caller may mutate
    // frame.movementX/Y afterwards (e.g. GameScene overrides to the pointer
    // angle when a stationary dash is in progress) before sending.
    const dir = this.sampleLiveMovement();

    // Drain the pending-send edge queue into the frame's actions[].
    const actions = this._scratchActions;
    actions.length = 0;
    for (let i = 0; i < this._pendingSendEdges.length; i++) {
      actions.push(this._pendingSendEdges[i]!);
    }
    this._pendingSendEdges.length = 0;

    // Continuous ATTACK: read at the send boundary (NOT an edge — fired
    // every sent InputFrame while the left button is held). Excluded when
    // a THROW edge also fired this send (matches legacy behavior — the
    // right-button action takes precedence on its send frame).
    const wantsThrow = actions.includes('THROW');
    if (pointer.isDown && !wantsThrow) actions.push('ATTACK');

    const frame = this._scratchFrame;
    frame.movementX = dir.x;
    frame.movementY = dir.y;
    frame.aimAngle = aimAngle;
    frame.sequence = this.seq++;
    frame.targetId = undefined;
    return frame;
  }

  /** Returns true if any movement key (WASD / arrows) is currently held. */
  isMovementKeyDown(): boolean {
    if (!this.keys) return false;
    return (
      this.keys.W.isDown ||
      this.keys.A.isDown ||
      this.keys.S.isDown ||
      this.keys.D.isDown ||
      this.cursorKeys.up.isDown ||
      this.cursorKeys.down.isDown ||
      this.cursorKeys.left.isDown ||
      this.cursorKeys.right.isDown
    );
  }

  /**
   * JustDown helper — true when `key` transitioned from up to down between
   * the previous and current frame. Updated per-frame by {@link pollEdgeActions}.
   * State is tracked in `prevKeyStates` so each physical press fires exactly
   * once regardless of the render rate (NET-03 preserves the per-press
   * invariant under per-frame sampling).
   */
  private justPressed(key: Phaser.Input.Keyboard.Key): boolean {
    // Perf ticket 21: numeric keyCode key — no per-call string allocation.
    const isDown = key.isDown;
    const wasDown = this.prevKeyStates.get(key.keyCode) ?? false;
    this.prevKeyStates.set(key.keyCode, isDown);
    return isDown && !wasDown;
  }
}
