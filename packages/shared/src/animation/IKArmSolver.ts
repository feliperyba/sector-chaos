/**
 * IKArmSolver.ts — Analytical 2-bone IK (law of cosines).
 *
 * Moved from client-v3 (was packages/client-v3/src/rendering/IKArmSolver.ts)
 * so the server can solve identical arm poses. Pure math — deterministic.
 */
import type { Vec2 } from '../math/Vec2.js';

export interface IKSolution {
  elbow: Vec2;
  hand: Vec2;
  shoulderAngle: number;
  elbowAngle: number;
  reachable: boolean;
}

export class IKArmSolver {
  private readonly _scratchSolution: IKSolution = {
    elbow: { x: 0, y: 0 },
    hand: { x: 0, y: 0 },
    shoulderAngle: 0,
    elbowAngle: 0,
    reachable: false,
  };

  constructor(
    private upperArmLen: number,
    private forearmLen: number,
    private bendSign: number,
  ) {}

  get maxReach(): number {
    return this.upperArmLen + this.forearmLen;
  }

  get minReach(): number {
    return Math.abs(this.upperArmLen - this.forearmLen);
  }

  solve(shoulder: Vec2, target: Vec2): IKSolution {
    const dx = target.x - shoulder.x;
    const dy = target.y - shoulder.y;
    const rawDist = Math.sqrt(dx * dx + dy * dy);
    const L0 = this.upperArmLen;
    const L1 = this.forearmLen;
    const maxR = L0 + L1;
    const minR = Math.abs(L0 - L1);
    const eps = 0.001;

    // Clamp target to reachable range — arms straighten instead of truncating
    let dist = rawDist;
    let clamped = false;
    const softRadius = maxR * 0.95;
    if (rawDist > softRadius) {
      if (rawDist > maxR) {
        dist = maxR * 0.98;
        clamped = true;
      } else {
        const t = (rawDist - softRadius) / (maxR - softRadius);
        const soft = t * t * (3 - 2 * t);
        dist = softRadius + (maxR * 0.98 - softRadius) * soft;
      }
    } else if (rawDist < minR) {
      dist = minR + eps;
      clamped = true;
    }

    // Scale direction vector to clamped distance
    const scale = dist / Math.max(rawDist, eps);
    const cdx = dx * scale;
    const cdy = dy * scale;

    const baseAngle = Math.atan2(dy, dx);

    if (clamped && dist >= maxR - eps) {
      // Fully extended — straight arm toward target
      this._scratchSolution.elbow.x = shoulder.x + Math.cos(baseAngle) * L0;
      this._scratchSolution.elbow.y = shoulder.y + Math.sin(baseAngle) * L0;
      this._scratchSolution.hand.x = shoulder.x + cdx;
      this._scratchSolution.hand.y = shoulder.y + cdy;
      this._scratchSolution.shoulderAngle = baseAngle;
      this._scratchSolution.elbowAngle = Math.PI;
      this._scratchSolution.reachable = false;
      return this._scratchSolution;
    }

    // Law of cosines — 2-bone analytical solve
    const cosAlpha = (dist * dist + L0 * L0 - L1 * L1) / (2 * dist * L0);
    const cosBeta = (L0 * L0 + L1 * L1 - dist * dist) / (2 * L0 * L1);

    const alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
    const beta = Math.acos(Math.max(-1, Math.min(1, cosBeta)));

    const shoulderAngle = baseAngle + this.bendSign * alpha;

    this._scratchSolution.elbow.x = shoulder.x + Math.cos(shoulderAngle) * L0;
    this._scratchSolution.elbow.y = shoulder.y + Math.sin(shoulderAngle) * L0;
    this._scratchSolution.hand.x = shoulder.x + cdx;
    this._scratchSolution.hand.y = shoulder.y + cdy;
    this._scratchSolution.shoulderAngle = shoulderAngle;
    this._scratchSolution.elbowAngle = Math.PI - beta;
    this._scratchSolution.reachable = !clamped;
    return this._scratchSolution;
  }
}
