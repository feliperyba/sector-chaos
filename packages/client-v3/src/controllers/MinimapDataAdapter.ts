import type { StateSync } from '../network/StateSync.js';
import type { MapRenderer } from '../rendering/MapRenderer.js';
import type { GameState } from './GameState.js';
import type { MinimapData } from '../hud/MinimapRenderer.js';
import type { LandmarkAssignment } from '@sector-battle/shared';

export class MinimapDataAdapter {
  private readonly pickupPositions: { x: number; y: number }[] = [];
  private readonly chestPositions: { x: number; y: number }[] = [];
  private pickupCount = 0;
  private chestCount = 0;
  private readonly _data: MinimapData = {
    playerX: 0,
    playerY: 0,
    worldW: 0,
    worldH: 0,
    zoneCX: 0,
    zoneCY: 0,
    zoneRadius: 0,
    targetCX: 0,
    targetCY: 0,
    targetRadius: 0,
    grid: [],
    tileSize: 0,
    gridVersion: 0,
    pickups: [],
    pickupCount: 0,
    chests: [],
    chestCount: 0,
    sectorTiers: null,
    hotSector: null,
    poiNames: null,
    landmarks: null as LandmarkAssignment | null,
  };

  constructor(
    private readonly state: GameState,
    private readonly stateSync: StateSync,
    private readonly mapRenderer: MapRenderer,
  ) {}

  assemble(): MinimapData {
    const zoneState = this.stateSync.getZoneState();
    const entities = this.stateSync.getEntities();

    this.pickupCount = 0;
    for (const wp of entities.weaponPickups.values()) {
      if (wp.lifetime <= 0) continue;
      let entry = this.pickupPositions[this.pickupCount];
      if (!entry) {
        entry = { x: 0, y: 0 };
        this.pickupPositions[this.pickupCount] = entry;
      }
      entry.x = wp.x;
      entry.y = wp.y;
      this.pickupCount++;
    }

    this.chestCount = 0;
    for (const c of entities.chests.values()) {
      if (c.state >= 2) continue;
      let entry = this.chestPositions[this.chestCount];
      if (!entry) {
        entry = { x: 0, y: 0 };
        this.chestPositions[this.chestCount] = entry;
      }
      entry.x = c.x;
      entry.y = c.y;
      this.chestCount++;
    }

    const d = this._data;
    d.playerX = this.state.localPos.x;
    d.playerY = this.state.localPos.y;
    d.worldW = this.mapRenderer.getMapWidth();
    d.worldH = this.mapRenderer.getMapHeight();
    d.zoneCX = zoneState.centerX;
    d.zoneCY = zoneState.centerY;
    d.zoneRadius = zoneState.currentRadius;
    d.targetCX = zoneState.targetCenterX;
    d.targetCY = zoneState.targetCenterY;
    d.targetRadius = zoneState.targetRadius;
    d.grid = this.mapRenderer.getGrid();
    d.tileSize = this.mapRenderer.getTileSize();
    // Perf ticket 18: grid mutation counter — drives the minimap terrain
    // cache invalidation when the grid mutates in place (same array ref).
    d.gridVersion = this.mapRenderer.getGridVersion();
    d.pickups = this.pickupPositions;
    d.pickupCount = this.pickupCount;
    d.chests = this.chestPositions;
    d.chestCount = this.chestCount;
    // Map-redesign ticket 02: server-authored tier identity, stashed once at
    // map load. Static per match — safe to re-read every frame (no alloc).
    d.sectorTiers = this.state.sectorTiers;
    d.hotSector = this.state.hotSector;
    // Map-redesign ticket 03: server-authored POI names for the minimap
    // labels (current + adjacent sectors). Static per match.
    d.poiNames = this.state.poiNames;
    // Map-redesign ticket 04: server-authored landmarks for the minimap
    // icons (hero ringed dots + minor diamonds). Static per match.
    d.landmarks = this.state.landmarks;
    return d;
  }
}
