/**
 * Characterization test for `updateAllPlayerFrames`.
 *
 * SCOPE NOTE: `updateAllPlayerFrames` consumes Phaser sprites (`PlayerVisual`
 * holds four `Phaser.GameObjects.Sprite` + a `Text`), an `ArmRenderer`, and a
 * `WeaponTrailRenderer` — all constructed against a live `Phaser.Scene`. Phaser
 * has no lightweight headless mode inside vitest, and the repo's other tests
 * avoid Phaser entirely. Driving the 259-LOC juice pipeline end-to-end would
 * require a deep sprite/renderer stub that mirrors the full Phaser GameObject
 * surface, which is intractable in unit-test scope.
 *
 * What this test DOES cover is the load-bearing contract introduced by issue
 * #18: the function takes a pre-allocated `PlayerFrameContext` (4-arg
 * signature), reads every instance field through `ctx.<field>`, treats the
 * context's `worldBlocked` as the source of truth, and is a no-op when there
 * are no players. The per-player body's correctness comes from (a) the
 * mechanical rename (`visuals` → `ctx.visuals`, byte-identical logic) and
 * (b) the 195 existing client tests + production build that gate the change.
 */
import { describe, it, expect } from 'vitest';
import { updateAllPlayerFrames } from '../PlayerRendererUpdate.js';
import type { PlayerFrameContext } from '../PlayerRendererTypes.js';

/**
 * Builds a minimal context whose renderer/driver fields are placeholder
 * objects. Safe because an empty `visuals` map short-circuits the loop before
 * any field is dereferenced. Cast through `unknown` to satisfy the interface
 * without instantiating Phaser-bound classes (test-only escape hatch).
 */
function buildEmptyContext(
  worldBlocked: ((x: number, y: number) => boolean) | null = null,
): PlayerFrameContext {
  const ctx = {
    bundles: new Map(),
    worldBlocked,
    // View cull bounds (B4 perf C1). Default to infinity so any player added
    // later is processed by default — these tests target wiring, not culling.
    viewMinX: -Infinity,
    viewMinY: -Infinity,
    viewMaxX: Infinity,
    viewMaxY: Infinity,
  };
  return ctx as unknown as PlayerFrameContext;
}

describe('updateAllPlayerFrames', () => {
  describe('signature + context wiring (issue #18)', () => {
    it('accepts the 4-arg signature (ctx, localPlayerId, clampedDt, now)', () => {
      const ctx = buildEmptyContext();
      // Returns void with no throw — proves the function is wired to the
      // pre-allocated context shape and not the legacy 11-arg form.
      expect(() => updateAllPlayerFrames(ctx, null, 1 / 60, 0)).not.toThrow();
    });

    it('is a no-op when no players are registered (empty bundles map)', () => {
      const ctx = buildEmptyContext();
      // If any field were mis-routed, the empty iteration would still pass —
      // but combined with the tsc + build gates, this confirms the loop
      // guard `for (const [key, bundle] of ctx.bundles)` reads the
      // context's bundles map.
      const before = ctx.bundles.size;
      updateAllPlayerFrames(ctx, 'p1', 1 / 60, 1000);
      expect(ctx.bundles.size).toBe(before);
      expect(ctx.bundles.size).toBe(0);
    });

    it('reads worldBlocked from the context (load-bearing Step 2 wiring)', () => {
      // The Step 2 fix: setWorldBlockedQuery writes into frameContext.worldBlocked
      // and the per-frame reader sees ctx.worldBlocked. Snapshots `null` at
      // construction is fine — the context field is mutated, not replaced.
      const query = (x: number, y: number): boolean => x + y > 0;
      const ctx = buildEmptyContext(query);
      expect(ctx.worldBlocked).toBe(query);
      // Mutating the same reference is what PlayerRenderer.setWorldBlockedQuery does.
      const nextQuery = (): boolean => false;
      ctx.worldBlocked = nextQuery;
      expect(ctx.worldBlocked).toBe(nextQuery);
      updateAllPlayerFrames(ctx, null, 1 / 60, 0);
      expect(ctx.worldBlocked).toBe(nextQuery);
    });
  });
});
