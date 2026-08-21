/**
 * Map-polish ticket 08 — late-join/spectator reconciliation + the
 * destroy→light-off hook wiring.
 *
 * `mapData` carries the FULL light-placement list for the whole match; a
 * client joining after lights were destroyed receives placements whose
 * backing entities are already gone. `cullDestroyedLightPlacements` drops
 * exactly those at map load — a pure function of (placement list, live
 * destructibles schema state), never local history, zero randomness
 * (ADR-0035). This also fixes the pre-existing ghost-campfire-light bug:
 * campfire placements are entity-backed by their crates.
 *
 * `wireLightPlacementRemoval` pins the boot wiring previously inlined in
 * `bootLightingPipeline`: the hook must tear down BOTH halves of a
 * destructible-backed light's footprint (light disk + fixture sprite).
 */
import { describe, it, expect, vi } from 'vitest';
import type { LightPlacementTiled, LightAnchor } from '@sector-battle/shared';
import {
  cullDestroyedLightPlacements,
  isEntityBackedLightPlacement,
  LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS,
  wireLightPlacementRemoval,
} from '../LightPlacementReconcile.js';
import type { DestructibleState } from '../../../types.js';
import { DESTRUCTIBLE_TYPE_LIGHT } from '../../../types.js';

const TILE = 128;

function placement(
  anchor: LightAnchor | undefined,
  gridX: number,
  gridY: number,
): LightPlacementTiled {
  return {
    gridX,
    gridY,
    kind: 'torch',
    ...(anchor !== undefined ? { anchor } : {}),
    rotation: 0,
    flipH: false,
    flipV: false,
    isScatter: false,
  } as LightPlacementTiled;
}

function entity(
  key: string,
  col: number,
  row: number,
  overrides: Partial<DestructibleState> = {},
): [string, DestructibleState] {
  return [
    key,
    {
      id: key,
      type: DESTRUCTIBLE_TYPE_LIGHT,
      hp: 1,
      maxHp: 1,
      x: col * TILE + TILE / 2,
      y: row * TILE + TILE / 2,
      isDestroyed: false,
      primed: false,
      fuseExpiresAtTick: 0,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
      ...overrides,
    },
  ];
}

describe('LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS — the cull candidate set', () => {
  it('contains the ticket-07 conversion set PLUS campfire (the ghost-campfire fix)', () => {
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('route')).toBe(true);
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('fill')).toBe(true);
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('poi-pool')).toBe(true);
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('crystal')).toBe(true);
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('campfire')).toBe(true);
  });

  it('excludes the exemptions: doorway sconces (and beacons never carry an anchor)', () => {
    expect(LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has('doorway')).toBe(false);
    // A beacon placement (no anchor at all) is never entity-backed.
    expect(isEntityBackedLightPlacement(placement(undefined, 0, 0))).toBe(false);
    expect(isEntityBackedLightPlacement(placement('doorway', 0, 0))).toBe(false);
    expect(isEntityBackedLightPlacement(placement('route', 0, 0))).toBe(true);
    expect(isEntityBackedLightPlacement(placement('campfire', 0, 0))).toBe(true);
  });
});

describe('cullDestroyedLightPlacements — late-join reconciliation', () => {
  it('the ticket scenario: 2 entity-backed placements, 1 destroyed entity → 1 culled, 1 kept', () => {
    const alive = placement('route', 5, 3);
    const dead = placement('route', 9, 2);
    // The live schema state carries ONE entity — at (5,3)'s tile.
    const destructibles = new Map([entity('dest_light_3_5', 5, 3)]);
    const result = cullDestroyedLightPlacements([alive, dead], destructibles, TILE);
    expect(result).toEqual([alive]);
  });

  it('the ghost-campfire fix: a campfire whose crate died before the join is culled', () => {
    const campfire = placement('campfire', 4, 8);
    // Empty destructibles: the joiner's snapshot has no live crate there.
    const result = cullDestroyedLightPlacements([campfire], new Map(), TILE);
    expect(result).toEqual([]);
  });

  it('a live campfire crate keeps its placement', () => {
    const campfire = placement('campfire', 4, 8);
    const crateEntity = entity('dest_crate_8_4', 4, 8, { type: 0, hp: 2, maxHp: 2 });
    const result = cullDestroyedLightPlacements([campfire], new Map([crateEntity]), TILE);
    expect(result).toEqual([campfire]);
  });

  it('exempt placements pass through untouched even with EMPTY schema state', () => {
    const beacon = { ...placement(undefined, 1, 1), kind: 'beacon' } as LightPlacementTiled;
    const doorway = placement('doorway', 6, 6);
    const result = cullDestroyedLightPlacements([beacon, doorway], new Map(), TILE);
    expect(result).toEqual([beacon, doorway]);
    // Same references — exempt entries are never rebuilt.
    expect(result[0]).toBe(beacon);
    expect(result[1]).toBe(doorway);
  });

  it('entity-backed placements with live entities pass through untouched', () => {
    const a = placement('route', 5, 3);
    const b = placement('crystal', 9, 2);
    const c = placement('fill', 0, 0);
    const placements = [a, b, c];
    const destructibles = new Map([
      entity('dest_light_3_5', 5, 3),
      entity('dest_light_2_9', 9, 2),
      entity('dest_light_0_0', 0, 0),
    ]);
    const result = cullDestroyedLightPlacements(placements, destructibles, TILE);
    expect(result).toEqual([a, b, c]);
    // Identity preserved — nothing culled, the ORIGINAL array comes back so
    // the pipeline keeps its placement reference.
    expect(result).toBe(placements);
  });

  it('a schema entry flagged isDestroyed does not vouch for its placement (defensive)', () => {
    const dead = placement('route', 9, 2);
    const flagged = entity('dest_light_2_9', 9, 2, { isDestroyed: true });
    const result = cullDestroyedLightPlacements([dead], new Map([flagged]), TILE);
    expect(result).toEqual([]);
  });

  it('is pure: same inputs → same output (ADR-0035, no randomness/history)', () => {
    const alive = placement('poi-pool', 5, 3);
    const dead = placement('crystal', 9, 2);
    const destructibles = new Map([entity('dest_light_3_5', 5, 3)]);
    const r1 = cullDestroyedLightPlacements([alive, dead], destructibles, TILE);
    const r2 = cullDestroyedLightPlacements([alive, dead], destructibles, TILE);
    expect(r1).toEqual(r2);
  });

  it('empty placements / invalid tileSize short-circuit to the original list', () => {
    expect(cullDestroyedLightPlacements([], new Map([entity('e', 0, 0)]), TILE)).toEqual([]);
    const placements = [placement('route', 5, 3)];
    // tileSize <= 0 cannot map entities to tiles — hand the list back
    // unchanged rather than culling on garbage math.
    expect(cullDestroyedLightPlacements(placements, new Map(), 0)).toBe(placements);
    expect(cullDestroyedLightPlacements(placements, new Map(), -128)).toBe(placements);
  });

  it('orders/keeps mixed lists correctly (partial cull keeps order)', () => {
    const beacon = { ...placement(undefined, 1, 1), kind: 'beacon' } as LightPlacementTiled;
    const deadRoute = placement('route', 9, 2);
    const aliveFill = placement('fill', 7, 1);
    const doorway = placement('doorway', 6, 6);
    const destructibles = new Map([entity('dest_light_1_7', 7, 1)]);
    const result = cullDestroyedLightPlacements(
      [beacon, deadRoute, aliveFill, doorway],
      destructibles,
      TILE,
    );
    expect(result).toEqual([beacon, aliveFill, doorway]);
  });
});

describe('wireLightPlacementRemoval — the boot hook (both halves)', () => {
  it('installs the hook and tears down BOTH the light disk AND the fixture sprite', () => {
    const gameState: { onLightPlacementRemoved?: (x: number, y: number) => void } = {};
    const removePlacementAt = vi.fn();
    const removeAt = vi.fn();
    wireLightPlacementRemoval(gameState, { removePlacementAt }, { removeAt });
    expect(gameState.onLightPlacementRemoved).toBeTypeOf('function');
    gameState.onLightPlacementRemoved!(5, 3);
    expect(removePlacementAt).toHaveBeenCalledTimes(1);
    expect(removePlacementAt).toHaveBeenCalledWith(5, 3);
    expect(removeAt).toHaveBeenCalledTimes(1);
    expect(removeAt).toHaveBeenCalledWith(5, 3);
  });

  it('tolerates a null prop renderer (early-boot defensive guard)', () => {
    const gameState: { onLightPlacementRemoved?: (x: number, y: number) => void } = {};
    const removePlacementAt = vi.fn();
    wireLightPlacementRemoval(gameState, { removePlacementAt }, null);
    expect(() => gameState.onLightPlacementRemoved!(2, 7)).not.toThrow();
    expect(removePlacementAt).toHaveBeenCalledWith(2, 7);
  });

  it('replacing the hook (second boot) overwrites the first cleanly', () => {
    const gameState: { onLightPlacementRemoved?: (x: number, y: number) => void } = {};
    const first = vi.fn();
    const second = vi.fn();
    wireLightPlacementRemoval(gameState, { removePlacementAt: first }, null);
    wireLightPlacementRemoval(gameState, { removePlacementAt: second }, null);
    gameState.onLightPlacementRemoved!(0, 0);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(0, 0);
  });
});
