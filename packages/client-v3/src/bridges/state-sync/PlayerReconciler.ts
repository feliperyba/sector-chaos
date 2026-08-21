import { PLAYER, PlayerStatus } from '@sector-battle/shared';
import type { InputBuffer } from '../../prediction/InputBuffer.js';
import type { Reconciler } from '../../prediction/Reconciler.js';
import type { GameState } from '../../controllers/GameState.js';
import type { StateSync } from '../../network/StateSync.js';
import type { PlayerState } from '../../types.js';
import type { ReconciliationLog } from '../../debug/ReconciliationLog.js';
import { RttSmoother } from '../../prediction/RttSmoother.js';

export interface PlayerReconcilerDeps {
  /**
   * Owning GameState — single writer for the reconciliation snap +
   * correctionOffset decision (ADR-0005/0010/0033 + ADR-0026). The
   * reconciler reads gameState.localPos for the pre-correction
   * snapshot used by the telemetry log block (debug only, not
   * gameplay state — which is why the log block stays here rather
   * than moving onto GameState).
   */
  gameState: GameState;
  rtt: { value: number };
  inputBuffer: InputBuffer;
  reconciler: Reconciler;
  stateSync: { value: StateSync | null };
  reconciliationLog: { value: ReconciliationLog | undefined };
  isSpectating: { value: boolean };
}

export class PlayerReconciler {
  /**
   * Client-measured RTT estimate — the source of truth for the snap threshold.
   * Supersedes the server's `player.rtt`, whose `serverTick - clientTick`
   * formula (independent monotonic counters) grew without bound even at zero
   * latency — live data showed 15+ s on localhost, pinning the snap threshold
   * at its 64px cap. The client instead measures the real input round-trip:
   * send time (InputBuffer) → server ack (lastProcessedInput) arrival. See
   * RttSmoother.
   */
  private readonly rttSmoother = new RttSmoother();

  constructor(private readonly deps: PlayerReconcilerDeps) {}

  handleLocalPlayerChange(p: PlayerState): void {
    const seq = p.lastProcessedInput ?? 0;
    // Measure RTT from the real input round-trip rather than trusting the
    // server's `p.rtt`. The InputBuffer remembers when seq was sent; the gap
    // to now is the round-trip for that input. Returns 0 until enough samples.
    const sendTime = this.deps.inputBuffer.getSendTimeMs(seq);
    const rtt =
      sendTime !== undefined
        ? this.rttSmoother.addSample(seq, performance.now() - sendTime)
        : this.rttSmoother.value;
    // NET-23: derive the server-authoritative speed + staggered flag from the
    // patch (PlayerSchema carries both — `speed` = movement.speed.value at the
    // acked tick; `status & STAGGERED` = the stagger flag). These become the
    // replay window's integration scalars so a speed power-up or stagger no
    // longer leaves a persistent offset masked by a stale rec.speed replay.
    const serverSpeed = p.speed ?? PLAYER.BASE_SPEED;
    const serverIsStaggered = (p.status & PlayerStatus.STAGGERED) !== 0;
    this.handleLocalPlayerPositionChange(
      p.x,
      p.y,
      p.velocityX ?? 0,
      p.velocityY ?? 0,
      seq,
      rtt,
      serverSpeed,
      serverIsStaggered,
    );
  }

  handleLocalPlayerPositionChange(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    lastProcessedInput: number,
    rtt: number,
    /**
     * NET-23 — server-authoritative walk-speed scalar for the replay window.
     * Defaults to BASE_SPEED for legacy callers (matched-physics harnesses that
     * don't model speed changes). Production always passes the patch's `speed`.
     */
    serverSpeed: number = PLAYER.BASE_SPEED,
    /** NET-23 — server-authoritative staggered flag for the replay window. */
    serverIsStaggered: boolean = false,
  ): void {
    // Don't reconcile corpse position over spectated target
    if (this.deps.isSpectating.value) {
      this.deps.rtt.value = rtt;
      return;
    }
    const seq = lastProcessedInput;
    const r = this.deps.reconciler.reconcile(
      x,
      y,
      seq,
      this.deps.gameState.localPos.x,
      this.deps.gameState.localPos.y,
      velocityX,
      velocityY,
      serverSpeed,
      serverIsStaggered,
    );

    // Capture pre-correction position BEFORE the write (telemetry only).
    const preCorrectionX = this.deps.gameState.localPos.x;
    const preCorrectionY = this.deps.gameState.localPos.y;
    // Delegate the threshold-gated write + correctionOffset decision to
    // GameState (ADR-0005/0010/0033 + ADR-0026 — single owner, scalar
    // args, mutate-in-place). rtt is threaded so the Tier-3 snap threshold
    // can scale with connection latency (B4 perf regression H3).
    const wasCorrected = this.deps.gameState.applyReconciledPosition(
      r.x,
      r.y,
      r.velocityX,
      r.velocityY,
      rtt,
    );

    const log = this.deps.reconciliationLog.value;
    if (log) {
      const tick = this.deps.stateSync.value!.getTick();
      log.push({
        tick,
        seq,
        serverX: x,
        serverY: y,
        localX: preCorrectionX,
        localY: preCorrectionY,
        correctionX: r.x - preCorrectionX,
        correctionY: r.y - preCorrectionY,
        wasCorrected,
      });
    }

    this.deps.rtt.value = rtt;
  }
}
