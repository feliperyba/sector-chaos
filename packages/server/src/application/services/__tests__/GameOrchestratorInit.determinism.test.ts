import { describe, it, expect } from 'vitest';
import { SeededRNG } from '@sector-battle/shared';

describe('Entity type selection determinism', () => {
  it('SeededRNG produces same sequence for same seed', () => {
    const rng1 = new SeededRNG(42 ^ 0xcafe_babe);
    const rng2 = new SeededRNG(42 ^ 0xcafe_babe);

    const trapTypes = ['spike', 'fire', 'teleport'] as const;
    const powerUpTypes = ['health_pack', 'health_pack', 'barrier', 'speed_boost'] as const;

    // Simulate entity type selection
    const results1: string[] = [];
    const results2: string[] = [];
    for (let i = 0; i < 20; i++) {
      results1.push(trapTypes[rng1.nextInt(0, trapTypes.length - 1)]!);
      results1.push(powerUpTypes[rng1.nextInt(0, powerUpTypes.length - 1)]!);
      results2.push(trapTypes[rng2.nextInt(0, trapTypes.length - 1)]!);
      results2.push(powerUpTypes[rng2.nextInt(0, powerUpTypes.length - 1)]!);
    }

    expect(results1).toEqual(results2);
  });
});
