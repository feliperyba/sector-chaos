import { describe, it, expect } from 'vitest';
import { TileType, WeaponTier } from '@sector-battle/shared';
import { applyWeaponSpawnClearance } from '../../../src/domain/services/WeaponSpawnClearance.ts';
import type { MapResult } from '../../../src/domain/services/MapGenerator.ts';

const W = TileType.INDESTRUCTIBLE_WALL;
const E = TileType.EMPTY;

function makeMap(
  rows: TileType[][],
  weapons: Array<{ x: number; y: number }>,
  extra: Partial<MapResult> = {},
): MapResult {
  return {
    grid: rows,
    seed: 1,
    weaponSpawnPlacements: weapons.map((w, i) => ({
      gridX: w.x,
      gridY: w.y,
      tier: WeaponTier.COMMON,
      textureKey: `w${i}`,
    })),
    ...extra,
  } as unknown as MapResult;
}

describe('applyWeaponSpawnClearance', () => {
  it('keeps weapons in the open unchanged', () => {
    const map = makeMap(
      [
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
      ],
      [{ x: 2, y: 2 }],
    );
    applyWeaponSpawnClearance(map);
    expect(map.weaponSpawnPlacements[0]).toMatchObject({ gridX: 2, gridY: 2 });
  });

  it('nudges a weapon flush against an east wall to the nearest axial-clear tile', () => {
    const map = makeMap(
      [
        [E, E, E, W, E],
        [E, E, E, W, E],
        [E, E, E, W, E],
        [E, E, E, W, E],
        [E, E, E, W, E],
      ],
      [{ x: 2, y: 2 }],
    );
    applyWeaponSpawnClearance(map);
    const wp = map.weaponSpawnPlacements[0]!;
    // (2,2) has the wall at (3,2) → must move; first ring clear candidate in
    // row-major order is (1,1).
    expect(wp).toMatchObject({ gridX: 1, gridY: 1 });
    // Preserves the placement payload (tier/texture).
    expect(wp.tier).toBe(WeaponTier.COMMON);
    expect(wp.textureKey).toBe('w0');
  });

  it('clears against crates and chests too (any solid grid tile)', () => {
    const map = makeMap(
      [
        [E, E, E, E, E],
        [E, E, TileType.DESTRUCTIBLE_CRATE, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
      ],
      [{ x: 2, y: 2 }],
    );
    applyWeaponSpawnClearance(map);
    const wp = map.weaponSpawnPlacements[0]!;
    expect(wp.gridX === 2 && wp.gridY === 2).toBe(false);
  });

  it('avoids tiles claimed by other entity placements and nudged weapons', () => {
    const map = makeMap(
      [
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
        [E, E, E, E, E],
      ],
      [
        { x: 1, y: 1 },
        { x: 1, y: 1 },
      ],
      {
        trapPlacements: [{ gridX: 1, gridY: 2, trapType: undefined }],
      } as Partial<MapResult>,
    );
    applyWeaponSpawnClearance(map);
    const keys = map.weaponSpawnPlacements.map((w) => `${w.gridX},${w.gridY}`);
    // Both weapons start on (1,1): the first claims it, so the second must
    // move — and not onto the trap tile (1,2) either.
    expect(keys[0]).toBe('1,1');
    expect(keys[1]).not.toBe('1,1');
    expect(keys[1]).not.toBe('1,2');
    expect(new Set(keys).size).toBe(2);
  });

  it('keeps the original position when no clear tile exists in range', () => {
    const map = makeMap(
      [
        [W, W, W, W, W],
        [W, E, E, E, W],
        [W, E, E, E, W],
        [W, W, W, W, W],
      ],
      [{ x: 2, y: 2 }],
    );
    applyWeaponSpawnClearance(map);
    expect(map.weaponSpawnPlacements[0]).toMatchObject({ gridX: 2, gridY: 2 });
  });

  it('is deterministic (same input → same output)', () => {
    const rows: TileType[][] = Array.from({ length: 12 }, () =>
      Array.from({ length: 12 }, () => (Math.random() > 0.8 ? W : E)),
    );
    const weapons = [
      { x: 3, y: 3 },
      { x: 8, y: 2 },
      { x: 5, y: 9 },
      { x: 0, y: 11 },
    ];
    const a = makeMap(
      rows.map((r) => [...r]),
      weapons,
    );
    const b = makeMap(
      rows.map((r) => [...r]),
      weapons,
    );
    applyWeaponSpawnClearance(a);
    applyWeaponSpawnClearance(b);
    expect(a.weaponSpawnPlacements).toEqual(b.weaponSpawnPlacements);
  });
});
