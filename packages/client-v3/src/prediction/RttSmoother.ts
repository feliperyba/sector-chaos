/**
 * RttSmoother — client-side round-trip-time estimator for the local player.
 *
 * This supersedes the server-side `PlayerRttTracker` value (`player.rtt`) as
 * the source of truth for the reconciliation snap threshold
 * (`computeSnapThreshold`). The server tracker computed RTT from
 * `serverTick - clientTick` — but those are INDEPENDENT counters (server sim
 * tick vs client input sequence) whose difference grows monotonically even at
 * zero latency, inflating `rtt` to 15+ seconds on localhost and pinning the
 * snap threshold at its 64px cap.
 *
 * Instead, the client measures the REAL round-trip itself: it already records
 * the send time of every input (`InputBuffer` / `InputRecord.timestamp`) and
 * receives the server's ack (`lastProcessedInput`) in every state patch. The
 * round-trip for an acked input = `ackReceivedTime - inputSendTime`. This is
 * the canonical (Quake 3 / Gaffer-on-Games) client-measured RTT — no clock
 * sync, no cross-machine timestamp comparison. `RttSmoother` EMA-smooths those
 * samples.
 *
 * Pure (no I/O): the caller (PlayerReconciler) reads the send time from the
 * InputBuffer and the current time from `performance.now()`, computes the
 * sample, and feeds it here.
 */
export class RttSmoother {
  /** EMA smoothing factor — same as the legacy server tracker. */
  private static readonly EMA_ALPHA = 0.15;
  /** Samples before the estimate is trusted (mirrors the legacy MIN_SAMPLES). */
  private static readonly MIN_SAMPLES = 3;
  /** Discard absurd samples (clock jump, reordered ack) so they can't poison the EMA. */
  private static readonly MAX_SAMPLE_MS = 5000;

  private smoothed = 0;
  private count = 0;
  private lastAckSeq = -1;

  /**
   * Feed one round-trip sample for acked sequence `seq`.
   *
   * `seq` MUST be the server's `lastProcessedInput` that acknowledges the input
   * sent at the time used to derive `sampleMs`. Non-advancing acks (reconnect /
   * clock reset / duplicate patch) are ignored so the estimate only moves
   * forward on genuine new information.
   *
   * Returns the smoothed RTT in ms (or the unchanged estimate if the sample was
   * discarded). Call `.value` for the gated output (0 until MIN_SAMPLES).
   */
  addSample(seq: number, sampleMs: number): number {
    // Ignore non-advancing acks — they carry no new timing information and a
    // duplicate patch would otherwise double-count the sample.
    if (seq <= this.lastAckSeq) return this.smoothed;
    // Discard artifacts: negative (clock regression) or absurdly large (a stall
    // so long the send record was evicted and a newer seq reused, or a tab
    // throttle). Keeping the prior estimate is safer than trusting garbage.
    if (sampleMs < 0 || sampleMs > RttSmoother.MAX_SAMPLE_MS) {
      this.lastAckSeq = seq;
      return this.smoothed;
    }
    if (this.count === 0) {
      this.smoothed = sampleMs;
    } else {
      this.smoothed = RttSmoother.EMA_ALPHA * sampleMs + (1 - RttSmoother.EMA_ALPHA) * this.smoothed;
    }
    this.count++;
    this.lastAckSeq = seq;
    return this.smoothed;
  }

  /** Trusted smoothed RTT (ms), or 0 before enough samples have arrived. */
  get value(): number {
    return this.count >= RttSmoother.MIN_SAMPLES ? this.smoothed : 0;
  }

  reset(): void {
    this.smoothed = 0;
    this.count = 0;
    this.lastAckSeq = -1;
  }
}
