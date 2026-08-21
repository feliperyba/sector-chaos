import { describe, it, expect } from 'vitest';
import { BEACON_THEME_LIGHT, SectorType, type LandmarkAssignment } from '@sector-battle/shared';
import { GameState } from '../GameState.js';
import { MinimapDataAdapter } from '../MinimapDataAdapter.js';
import type { StateSync } from '../../network/StateSync.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';

/**
 * Map-redesign ticket 04 — the minimap data adapter must forward the
 * server-authored landmark assignment (`GameState.landmarks`, stashed at
 * map load from the one-shot `mapData` payload) into the per-frame
 * `MinimapData` so `MinimapRenderer` can draw the hero/minor icons. Static
 * per match — the adapter re-reads the field every frame with zero alloc,
 * mirroring the ticket-02/03 tier/name passthroughs. No Phaser, no network
 * (`StateSync` + `MapRenderer` stubbed to the minimal surface `assemble`
 * reads).
 */

function makeStubStateSync(): StateSync {
  return {
    getZoneState: () => ({
      centerX: 0,
      centerY: 0,
      currentRadius: 0,
      targetCenterX: 0,
      targetCenterY: 0,
      targetRadius: 0,
    }),
    getEntities: () => ({ weaponPickups: new Map(), chests: new Map() }),
  } as unknown as StateSync;
}

function makeStubMapRenderer(): MapRenderer {
  return {
    getMapWidth: () => 10240,
    getMapHeight: () => 10240,
    getGrid: () => [],
    getTileSize: () => 128,
    getGridVersion: () => 0,
  } as unknown as MapRenderer;
}

const LANDMARKS: LandmarkAssignment = {
  heroes: [
    [
      {
        compositionId: 'watch-spire',
        rarity: 'signature',
        tileX: 10,
        tileY: 10,
        // Theme-keyed beacon color (map-polish ticket 03 — hue=theme,
        // value=tier): this fixture hero sits in an OPEN_ARENA district.
        beacon: {
          color: BEACON_THEME_LIGHT[SectorType.OPEN_ARENA].color,
          intensity: 2.8,
          radius: 576,
        },
      },
    ],
  ],
  minors: [
    {
      // (propId was removed from MinorLandmark by map-polish ticket 29 —
      // a minor is placement + marker light only.)
      tileX: 41,
      tileY: 61,
      light: { color: [0.72, 0.78, 0.92], intensity: 1, radius: 176 },
    },
  ],
};

describe('MinimapDataAdapter — landmark passthrough (ticket 04)', () => {
  it('forwards GameState.landmarks into MinimapData.landmarks', () => {
    const state = new GameState();
    state.landmarks = LANDMARKS;
    const adapter = new MinimapDataAdapter(state, makeStubStateSync(), makeStubMapRenderer());
    const data = adapter.assemble();
    expect(data.landmarks).toBe(LANDMARKS);
  });

  it('defaults to null (demo maps carry no landmarks)', () => {
    const state = new GameState();
    const adapter = new MinimapDataAdapter(state, makeStubStateSync(), makeStubMapRenderer());
    expect(adapter.assemble().landmarks).toBeNull();
  });

  it('GameState.reset clears the landmark assignment', () => {
    const state = new GameState();
    state.landmarks = LANDMARKS;
    state.reset();
    expect(state.landmarks).toBeNull();
  });
});
