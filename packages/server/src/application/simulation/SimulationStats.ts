export class SimulationStats {
  private _tickCount: number = 0;
  private _totalProcessTime: number = 0;
  private _maxTickTime: number = 0;

  recordTick(processTimeMs: number): void {
    this._tickCount++;
    this._totalProcessTime += processTimeMs;
    if (processTimeMs > this._maxTickTime) {
      this._maxTickTime = processTimeMs;
    }
  }

  get totalTicks(): number {
    return this._tickCount;
  }

  get totalProcessTime(): number {
    return this._totalProcessTime;
  }

  get maxTickTime(): number {
    return this._maxTickTime;
  }

  get avgTickTime(): number {
    return this._tickCount === 0 ? 0 : this._totalProcessTime / this._tickCount;
  }

  reset(): void {
    this._tickCount = 0;
    this._totalProcessTime = 0;
    this._maxTickTime = 0;
  }
}
