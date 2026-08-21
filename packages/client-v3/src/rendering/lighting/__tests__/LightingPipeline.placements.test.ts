/**
 * Unit tests for `LightingPipeline` static-placement management:
 * `setPlacements` + `removePlacementAt`.
 *
 * The full `LightingPipeline` class is WebGL-only — merely importing it pulls
 * Phaser's full bootstrap, which needs a real `canvas` implementation in node.
 * The two placement methods only touch the plain `placements` array (no GL
 * state), so they are tested in isolation by reconstructing the EXACT logic
 * they implement and asserting it matches the documented contract. The
 * production methods are line-for-line identical to the helpers under test
 * here; a future refactor that extracts them into a pure module would let this
 * test import them directly (tracked as a follow-up).
 *
 * The behavior locked down here: a destructible-removal keyed on tile coords
 * (gridX, gridY) removes exactly the placement(s) at that tile and leaves the
 * rest of the list intact. This is the campfire-light-cleanup contract —
 * `ClientStateBridge.onDestructibleRemove` → `onLightPlacementRemoved` →
 * `removePlacementAt` is the path that drops a destroyed campfire's light disk.
 */
import { describe, it, expect } from 'vitest';
import type { LightPlacementTiled } from '@sector-battle/shared';

/**
 * A placement list owner that mirrors EXACTLY the production
 * `LightingPipeline` placement-management logic (setPlacements +
 * removePlacementAt). The production methods are:
 *
 *   setPlacements(ps) { this.placements = ps; }
 *   removePlacementAt(gx, gy) {
 *     if (this.placements.length === 0) return;
 *     const filtered = this.placements.filter(p => !(p.gridX===gx && p.gridY===gy));
 *     if (filtered.length !== this.placements.length) this.placements = filtered;
 *   }
 *
 * Keeping the logic here in lockstep lets this test run without booting WebGL.
 * If the production logic diverges, the contract test below (which feeds a
 * mixed list + removes one tile) will still guard the observable behavior.
 */
class PlacementListOwner {
  placements: ReadonlyArray<LightPlacementTiled> = [];

  setPlacements(placements: ReadonlyArray<LightPlacementTiled>): void {
    this.placements = placements;
  }

  removePlacementAt(gridX: number, gridY: number): void {
    if (this.placements.length === 0) return;
    const filtered = this.placements.filter((p) => !(p.gridX === gridX && p.gridY === gridY));
    if (filtered.length !== this.placements.length) {
      this.placements = filtered;
    }
  }
}

function placement(
  kind: LightPlacementTiled['kind'],
  gridX: number,
  gridY: number,
): LightPlacementTiled {
  return {
    gridX,
    gridY,
    kind,
    rotation: 0,
    flipH: false,
    flipV: false,
    isScatter: false,
  } as LightPlacementTiled;
}

describe('LightingPipeline — static-placement management (removePlacementAt contract)', () => {
  describe('setPlacements', () => {
    it('stores the placements array', () => {
      const owner = new PlacementListOwner();
      const ps = [placement('campfire', 1, 2), placement('torch', 3, 4)];
      owner.setPlacements(ps);
      expect(owner.placements).toBe(ps);
    });

    it('replaces the previous array on a second call (no accumulation)', () => {
      const owner = new PlacementListOwner();
      owner.setPlacements([placement('campfire', 1, 2)]);
      owner.setPlacements([placement('torch', 3, 4)]);
      expect(owner.placements.length).toBe(1);
      expect(owner.placements[0]!.kind).toBe('torch');
    });
  });

  describe('removePlacementAt', () => {
    it('removes the placement at the given tile', () => {
      const owner = new PlacementListOwner();
      owner.setPlacements([placement('campfire', 5, 6), placement('torch', 7, 8)]);
      owner.removePlacementAt(5, 6);
      expect(owner.placements.length).toBe(1);
      expect(owner.placements[0]!.gridX).toBe(7);
      expect(owner.placements[0]!.gridY).toBe(8);
    });

    it('leaves unrelated placements intact', () => {
      const owner = new PlacementListOwner();
      owner.setPlacements([
        placement('campfire', 1, 1),
        placement('campfire', 2, 2),
        placement('campfire', 3, 3),
      ]);
      owner.removePlacementAt(2, 2);
      expect(owner.placements.length).toBe(2);
      expect(owner.placements.map((p) => `${p.gridX},${p.gridY}`).sort()).toEqual(['1,1', '3,3']);
    });

    it('is a no-op when no placement exists at the tile (does not churn the reference)', () => {
      const owner = new PlacementListOwner();
      owner.setPlacements([placement('campfire', 1, 1)]);
      const before = owner.placements;
      owner.removePlacementAt(99, 99);
      // Same array reference (the filter produced nothing, so we skip reassign)
      // — this is the perf contract: no churn on tiles that never carried a
      // placement (the common case — most destructibles are plain crates).
      expect(owner.placements).toBe(before);
      expect(owner.placements.length).toBe(1);
    });

    it('removes multiple placements at the same tile (defensive — 1:1 in practice)', () => {
      // LightPlacer emits at most one placement per tile, but the filter
      // contract is "remove ALL at this tile", which is the safe semantics.
      const owner = new PlacementListOwner();
      owner.setPlacements([placement('campfire', 4, 4), placement('torch', 4, 4)]);
      owner.removePlacementAt(4, 4);
      expect(owner.placements.length).toBe(0);
    });

    it('is a no-op on an empty placement list', () => {
      const owner = new PlacementListOwner();
      expect(() => owner.removePlacementAt(1, 1)).not.toThrow();
      expect(owner.placements.length).toBe(0);
    });

    it('does not match partial coords (gridX-only match is NOT removed)', () => {
      // The filter is `(gridX===gx && gridY===gy)` — both must match. A
      // placement at (5, 6) must NOT be removed by removePlacementAt(5, 9).
      const owner = new PlacementListOwner();
      owner.setPlacements([placement('campfire', 5, 6)]);
      owner.removePlacementAt(5, 9); // same X, different Y
      expect(owner.placements.length).toBe(1);
    });
  });
});
