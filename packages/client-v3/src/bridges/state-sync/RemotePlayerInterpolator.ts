import type { EntityInterpolator } from '../../prediction/EntityInterpolator.js';

export class RemotePlayerInterpolator {
  constructor(private readonly interpolator: EntityInterpolator) {}

  handleRemotePlayerChange(key: string, x: number, y: number, vx?: number, vy?: number): void {
    // Velocity enables EntityInterpolator's dead-reckoning fast path: when
    // packets are late/jittery, the interpolator extrapolates from the last
    // known velocity instead of freezing (which read as stutter). Without
    // this, hasVelocity stays false forever and remote players always use the
    // 67ms-behind position-only path (no extrapolation during packet gaps).
    this.interpolator.push(key, x, y, vx, vy);
  }

  removePlayer(key: string): void {
    this.interpolator.removeEntity(key);
  }
}
