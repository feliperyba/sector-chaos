import { describe, it, expect } from 'vitest';
import { IKArmSolver } from '../IKArmSolver.js';

describe('IKArmSolver (shared)', () => {
  const L0 = 30;
  const L1 = 26;

  it('bends arm to reach (30, 0)', () => {
    const solver = new IKArmSolver(L0, L1, 1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 30, y: 0 });
    expect(result.reachable).toBe(true);
    expect(result.elbow.y).not.toBe(0);
    expect(result.hand.x).toBeCloseTo(30, 10);
    expect(result.hand.y).toBeCloseTo(0, 10);
  });

  it('clamps unreachable target to soft max reach', () => {
    const solver = new IKArmSolver(L0, L1, 1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(result.reachable).toBe(false);
    expect(result.hand.x).toBeCloseTo(54.88, 1);
    expect(result.hand.y).toBeCloseTo(0, 10);
    expect(result.elbowAngle).toBeGreaterThan(0);
  });

  it('left arm bends outward (bendSign=-1 → elbow toward -Y)', () => {
    const solver = new IKArmSolver(L0, L1, -1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 30, y: 0 });
    expect(result.elbow.y).toBeLessThan(0);
  });

  it('right arm bends outward (bendSign=+1 → elbow toward +Y)', () => {
    const solver = new IKArmSolver(L0, L1, +1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 30, y: 0 });
    expect(result.elbow.y).toBeGreaterThan(0);
  });

  it('target at shoulder — min reach clamp, no crash', () => {
    const solver = new IKArmSolver(L0, L1, 1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 0, y: 0 });
    expect(result.reachable).toBe(false);
  });

  it('reaches diagonal (20, 20) with bent arm', () => {
    const solver = new IKArmSolver(L0, L1, 1);
    const result = solver.solve({ x: 0, y: 0 }, { x: 20, y: 20 });
    expect(result.reachable).toBe(true);
    expect(result.hand.x).toBeCloseTo(20, 10);
    expect(result.hand.y).toBeCloseTo(20, 10);
    expect(result.elbowAngle).toBeLessThan(Math.PI);
  });

  it('maxReach / minReach properties', () => {
    const solver = new IKArmSolver(30, 26, 1);
    expect(solver.maxReach).toBe(56);
    expect(solver.minReach).toBe(4);
    expect(new IKArmSolver(28, 28, 1).minReach).toBe(0);
  });
});
