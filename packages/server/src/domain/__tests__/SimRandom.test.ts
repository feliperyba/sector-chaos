import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  simRandom,
  installSeededSimRandom,
  uninstallSeededSimRandom,
} from '../shared/SimRandom.ts';

/**
 * SimRandom (F4 benchmark determinism) contract tests:
 *
 * 1. Production default: with no override installed, `simRandom` must be a
 *    pass-through to the global `Math.random` (same values, same source).
 * 2. Seeded mode: same seed → same per-site draw sequence (byte-identical
 *    across "runs", simulated by reinstalling the same seed).
 * 3. Per-site independence: different site tags draw from different streams;
 *    interleaving sites does not perturb each site's own sequence.
 * 4. Uninstall restores the production pass-through.
 */

afterEach(() => {
  uninstallSeededSimRandom();
});

describe('simRandom', () => {
  it('returns the exact Math.random() value when no override is installed', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.4242);
    try {
      expect(simRandom('spawn-jitter')).toBe(0.4242);
      expect(mathRandomSpy).toHaveBeenCalledTimes(1);
    } finally {
      mathRandomSpy.mockRestore();
    }
  });

  it('is deterministic per seed + site across installs', () => {
    installSeededSimRandom(12345);
    const first = [simRandom('ground-weapon-type'), simRandom('ground-weapon-type')];

    installSeededSimRandom(12345); // fresh install, same seed = a new "run"
    const second = [simRandom('ground-weapon-type'), simRandom('ground-weapon-type')];

    expect(second).toEqual(first);
  });

  it('gives different sites independent streams', () => {
    installSeededSimRandom(12345);
    const interleaved: number[] = [];
    // Interleave draws across two sites.
    interleaved.push(simRandom('spawn-jitter'));
    interleaved.push(simRandom('teleport-destination'));
    interleaved.push(simRandom('spawn-jitter'));

    installSeededSimRandom(12345);
    // Draw from ONE site only — its sequence must be unaffected by the other
    // site's draws having been interleaved in the first pass.
    const soloJitter = [simRandom('spawn-jitter'), simRandom('spawn-jitter')];

    expect(interleaved[0]).toBe(soloJitter[0]);
    expect(interleaved[2]).toBe(soloJitter[1]);
    expect(interleaved[1]).not.toBe(soloJitter[0]);
  });

  it('produces values in [0, 1) under seeding', () => {
    installSeededSimRandom(987654321);
    for (let i = 0; i < 1000; i++) {
      const v = simRandom('bot-name-shuffle');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('restores the Math.random pass-through after uninstall', () => {
    installSeededSimRandom(1);
    expect(simRandom('x')).toBeDefined();
    uninstallSeededSimRandom();
    const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.77);
    try {
      expect(simRandom('x')).toBe(0.77);
    } finally {
      mathRandomSpy.mockRestore();
    }
  });
});
