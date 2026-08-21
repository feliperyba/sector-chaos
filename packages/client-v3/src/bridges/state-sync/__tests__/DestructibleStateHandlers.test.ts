/**
 * Map-polish ticket 08 — destructible-removal handler tests (stub-driven).
 *
 * The destroy→light-off chain the ticket pins end-to-end:
 *
 *   server hit → schema delete → `onDestructibleRemove(key)`
 *     → dust cloud (NOT type-gated)
 *     → `mapRenderer.clearGridCell` (SKIPPED for non-solid light props)
 *     → `gameState.onLightPlacementRemoved(gridX, gridY)` with the entity's
 *       tile coords (wired by boot to BOTH `LightingPipeline
 *       .removePlacementAt` AND `LightPropRenderer.removeAt` — see
 *       LightPlacementReconcile.test.ts for the both-halves wiring proof)
 *     → `entityRenderer.removeDestructible(key)`
 *
 * SERVER-AUTHORITATIVE tripwire: this handler is the schema's onRemove
 * callback — the ONLY place light-off may fire from. These tests pin that it
 * reacts purely to the passed key + tracked state (no client-side decision).
 */
import { describe, it, expect, vi } from 'vitest';
import { createDestructibleStateHandlers } from '../DestructibleStateHandlers.js';
import type { StateBridgeDeps } from '../../ClientStateBridge.js';
import type { DestructibleState } from '../../../types.js';
import { DESTRUCTIBLE_TYPE_LIGHT } from '../../../types.js';

const TILE = 128;

/** Position of a tile (col,row) center — what the entity registry reports. */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

interface RendererStub {
  isLightProp: boolean;
  pos: { x: number; y: number } | null;
}

function makeDeps(renderer: RendererStub) {
  const entityRenderer = {
    isLightPropDestructible: vi.fn(() => renderer.isLightProp),
    getDestructiblePosition: vi.fn(() => renderer.pos),
    spawnDustCloud: vi.fn(),
    removeDestructible: vi.fn(),
    addDestructible: vi.fn(),
    updateDestructible: vi.fn(),
  };
  const mapRenderer = {
    getTileSize: vi.fn(() => TILE),
    clearGridCell: vi.fn(),
  };
  const onLightPlacementRemoved = vi.fn();
  const gameState = {
    onLightPlacementRemoved,
    // as unknown: the real GameState carries registries irrelevant here.
  };
  const handlers = createDestructibleStateHandlers({
    entityRenderer,
    mapRenderer,
    gameState,
  } as unknown as StateBridgeDeps);
  return { handlers, entityRenderer, mapRenderer, gameState, onLightPlacementRemoved };
}

describe('DestructibleStateHandlers.onDestructibleRemove — light props (ticket 08)', () => {
  it('fires the light-off hook with the entity tile coords', () => {
    const { handlers, onLightPlacementRemoved } = makeDeps({
      isLightProp: true,
      pos: tileCenter(5, 3),
    });
    handlers.onDestructibleRemove('dest_light_3_5');
    expect(onLightPlacementRemoved).toHaveBeenCalledTimes(1);
    expect(onLightPlacementRemoved).toHaveBeenCalledWith(5, 3);
  });

  it('plays the dust cloud (destruction feedback is NOT type-gated off)', () => {
    const { handlers, entityRenderer } = makeDeps({
      isLightProp: true,
      pos: tileCenter(5, 3),
    });
    handlers.onDestructibleRemove('dest_light_3_5');
    expect(entityRenderer.spawnDustCloud).toHaveBeenCalledWith(
      5 * TILE + TILE / 2,
      3 * TILE + TILE / 2,
    );
  });

  it('SKIPS clearGridCell for non-solid light props (no grid/base-RT corruption)', () => {
    // Ticket 07 hydrates light props on EMPTY tiles; clearGridCell would
    // rewrite an already-walkable cell AND smear its dark rect over the
    // tile's baked floor art in the base render texture.
    const { handlers, mapRenderer } = makeDeps({
      isLightProp: true,
      pos: tileCenter(5, 3),
    });
    handlers.onDestructibleRemove('dest_light_3_5');
    expect(mapRenderer.clearGridCell).not.toHaveBeenCalled();
  });

  it('still removes the entity from the renderer registry', () => {
    const { handlers, entityRenderer } = makeDeps({
      isLightProp: true,
      pos: tileCenter(5, 3),
    });
    handlers.onDestructibleRemove('dest_light_3_5');
    expect(entityRenderer.removeDestructible).toHaveBeenCalledWith('dest_light_3_5');
  });
});

describe('DestructibleStateHandlers.onDestructibleRemove — solid destructibles (regression)', () => {
  it('STILL clears the collision cell for crates (pose containment/prediction)', () => {
    const { handlers, mapRenderer, onLightPlacementRemoved, entityRenderer } = makeDeps({
      isLightProp: false,
      pos: tileCenter(2, 7),
    });
    handlers.onDestructibleRemove('dest_crate_7_2');
    expect(mapRenderer.clearGridCell).toHaveBeenCalledWith(2, 7);
    // The campfire reference: a crate CAN back a campfire light placement —
    // the light-off hook + dust fire for it exactly as before ticket 08.
    expect(onLightPlacementRemoved).toHaveBeenCalledWith(2, 7);
    expect(entityRenderer.spawnDustCloud).toHaveBeenCalled();
    expect(entityRenderer.removeDestructible).toHaveBeenCalledWith('dest_crate_7_2');
  });

  it('clearGridCell uses floored tile math from the tracked position', () => {
    const { handlers, mapRenderer } = makeDeps({
      isLightProp: false,
      // Mid-tile position (not a center) still floors to its tile.
      pos: { x: 9 * TILE + 17, y: 4 * TILE + 125 },
    });
    handlers.onDestructibleRemove('dest_crate_4_9');
    expect(mapRenderer.clearGridCell).toHaveBeenCalledWith(9, 4);
  });

  it('does nothing but removal when no position is tracked (defensive)', () => {
    const { handlers, mapRenderer, onLightPlacementRemoved, entityRenderer } = makeDeps({
      isLightProp: false,
      pos: null,
    });
    handlers.onDestructibleRemove('dest_gone');
    expect(entityRenderer.removeDestructible).toHaveBeenCalledWith('dest_gone');
    expect(mapRenderer.clearGridCell).not.toHaveBeenCalled();
    expect(onLightPlacementRemoved).not.toHaveBeenCalled();
    expect(entityRenderer.spawnDustCloud).not.toHaveBeenCalled();
  });
});

describe('DestructibleStateHandlers — add/change pass-through', () => {
  it('onDestructibleAdd delegates to the renderer', () => {
    const { handlers, entityRenderer } = makeDeps({ isLightProp: true, pos: null });
    const d: DestructibleState = {
      id: 'dest_light_3_5',
      type: DESTRUCTIBLE_TYPE_LIGHT,
      hp: 1,
      maxHp: 1,
      x: 5 * TILE + 64,
      y: 3 * TILE + 64,
      isDestroyed: false,
      primed: false,
      fuseExpiresAtTick: 0,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
    };
    handlers.onDestructibleAdd(d, 'dest_light_3_5');
    expect(entityRenderer.addDestructible).toHaveBeenCalledWith('dest_light_3_5', d);
  });

  it('onDestructibleChange delegates to the renderer', () => {
    const { handlers, entityRenderer } = makeDeps({ isLightProp: true, pos: null });
    handlers.onDestructibleChange({ hp: 0 } as DestructibleState, 'dest_light_3_5');
    expect(entityRenderer.updateDestructible).toHaveBeenCalledWith(
      'dest_light_3_5',
      expect.objectContaining({ hp: 0 }),
    );
  });
});
