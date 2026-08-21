/**
 * Debug-only animation desync snapshot type (CROSS-005). Exported from its own
 * module so debug tooling / TelemetrySampler can depend on the contract without
 * pulling in the full {@link AnimSimDriver}. See AnimSimDriver.debugDesync().
 *
 * `stepAnimation` is deterministic given identical (phase, phaseStartTick,
 * weapon, body state); the phase-age delta is therefore the root cause of any
 * grip→tip segment divergence between the client's prediction and the server's
 * authoritative pose. Positive delta = client's animation clock is ahead.
 */
export interface AnimDesyncSnapshot {
  /** Signed phase-age delta (client localAge − server ageTicks) in ticks. */
  phaseAgeDeltaTicks: number;
  /** Magnitude that exceeded the deadband at the last correction (0 if within). */
  lastCorrectionTicks: number;
  /** Cumulative phase-clock corrections since the driver was created. */
  correctionCount: number;
  /** Locally-stepped grip (world px) snapshotted at the last correction. */
  gripX: number;
  gripY: number;
  /** Locally-stepped tip (world px) snapshotted at the last correction. */
  tipX: number;
  tipY: number;
}
