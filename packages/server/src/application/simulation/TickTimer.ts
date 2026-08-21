import { SIM_TICK_DT } from '@sector-battle/shared';

export class TickTimer {
  private accumulator: number;
  private static readonly DT: number = SIM_TICK_DT;
  /**
   * Maximum simulation steps per callback. Colyseus's `setSimulationInterval`
   * drifts under event-loop load (measured ~51Hz vs configured 60Hz); capping
   * this at 1 (the old ADR-0025 value) made it impossible for the sim to catch
   * up when a callback fired late, so the sim ran in slow motion (~85% real
   * time) while the client predicted at true 60Hz → prediction drift → the
   * periodic reconciliation "stutter". 4 (matching the client's
   * `MAX_PREDICTION_SUBSTEPS`) lets the sim run extra ticks to hold 60Hz when a
   * callback was delayed, while the `frameTime` clamp below (0.25s) keeps a
   * hard ceiling on per-callback work so a pathological gap (backgrounded tab,
   * GC pause) can't trigger a spiral-of-death.
   */
  private static readonly MAX_STEPS: number = 4;

  constructor() {
    this.accumulator = 0;
  }

  consume(frameTimeMs: number): number {
    const frameTime = Math.min(frameTimeMs / 1000, 0.25);
    this.accumulator += frameTime;
    let steps = 0;
    while (this.accumulator >= TickTimer.DT && steps < TickTimer.MAX_STEPS) {
      this.accumulator -= TickTimer.DT;
      steps++;
    }
    return steps;
  }

  get dt(): number {
    return TickTimer.DT;
  }

  get alpha(): number {
    return this.accumulator / TickTimer.DT;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
