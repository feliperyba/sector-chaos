import type { AABB } from '../math/AABBCollision.js';

export interface HurtboxEntity {
  id: string;
  kind: 'player' | 'destructible';
  position: { x: number; y: number };
  hurtbox: AABB;
  gridX?: number;
  gridY?: number;
  /**
   * Destructibles only (map-polish ticket 07): set when the entity is
   * NON-SOLID — its tile is EMPTY in the grid and carries NO enriched tile
   * collider (the `'light'` light-prop fixtures). The swept-melee contact
   * test is tile-collider based, so for these entities the sweep falls back
   * to this entity hurtbox — the same box the arc/line melee paths and the
   * thrown/arrow scans already use. Solid destructibles (crate/barrel/wall/
   * iron) never set it; their contact geometry is unchanged.
   */
  nonSolid?: boolean;
}
