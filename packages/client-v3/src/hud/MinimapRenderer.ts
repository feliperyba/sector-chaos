import Phaser from 'phaser';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { Panel } from '../ui/components/Panel.js';
import type { LandmarkAssignment } from '@sector-battle/shared';
import {
  createSectorLabelSlots,
  updateSectorLabels,
  type SectorLabelSlot,
} from './MinimapSectorLabels.js';
import { drawLandmarkIcons } from './MinimapLandmarks.js';
import { MINIMAP_SCALE, minimapViewRange, redrawMinimapTerrain } from './MinimapTerrain.js';

// ---------------------------------------------------------------------------

export interface MinimapData {
  playerX: number;
  playerY: number;
  worldW: number;
  worldH: number;
  zoneCX: number;
  zoneCY: number;
  zoneRadius: number;
  targetCX?: number;
  targetCY?: number;
  targetRadius?: number;
  grid: number[][];
  tileSize: number;
  /**
   * Monotonic mutation counter from MapRenderer (perf ticket 18) — bumped by
   * every grid-mutation seam (clearGridCell / setSiegeWall* / render). The
   * terrain cache treats a bump as "grid contents changed, redraw terrain"
   * even though the grid array identity is unchanged (in-place mutation).
   */
  gridVersion: number;
  pickups: Array<{ x: number; y: number }>;
  pickupCount: number;
  chests: Array<{ x: number; y: number }>;
  chestCount: number;
  /**
   * Seed-authored loot-tier pyramid per sector (map-redesign ticket 02) —
   * drives the subtle sector tier tint. Null/undefined on demo maps.
   */
  sectorTiers?: ReadonlyArray<ReadonlyArray<string>> | null;
  /** Per-match hot sector (drives the distinct gold diamond mark). */
  hotSector?: { row: number; col: number } | null;
  /**
   * Server-authored POI names per sector (map-redesign ticket 03 / DEC-001)
   * — drives the sector name labels for the player's current + adjacent
   * sectors. Null/undefined on demo maps → no labels.
   */
  poiNames?: ReadonlyArray<ReadonlyArray<string>> | null;
  /**
   * Server-authored landmarks (map-redesign ticket 04 / DEC-002) — drives
   * the hero/minor landmark icons. Null/undefined on demo maps → no icons.
   */
  landmarks?: LandmarkAssignment | null;
}

// ---------------------------------------------------------------------------
// Sector loot-tier tint (map-redesign ticket 02 / DEC-003) — the full tier
// table lives in MinimapTerrain; the renderer keeps the HOT gold for the
// hot-sector diamond mark in the dynamic overlay pass.
// ---------------------------------------------------------------------------

/** HOT districts — warm gold, brightest of the three tints. */
const TIER_TINT_HOT = 0xffc94d;
/** Sector grid is 4x4 (matches SECTOR_GRID_SIZE in shared constants). */
const SECTOR_GRID = 4;

// ---------------------------------------------------------------------------
// MinimapRenderer — player-centered minimap with proper wall rendering
// ---------------------------------------------------------------------------

export class MinimapRenderer {
  private scene: Phaser.Scene;
  /** Dynamic overlay layer — cleared and redrawn EVERY frame. */
  private minimapGfx!: Phaser.GameObjects.Graphics;
  /**
   * Static terrain layer (perf ticket 18) — sector tier wash + the three tile
   * passes, redrawn ONLY when the terrain cache key changes (see
   * `terrainKey*`). Inserted BEFORE `minimapGfx` at the same depth so the
   * display list keeps terrain strictly under every dynamic overlay — the
   * exact command order of the pre-cache single-Graphics draw.
   */
  private minimapTerrainGfx!: Phaser.GameObjects.Graphics;
  private minimapPanel!: Panel;
  private sectorLabels: SectorLabelSlot[] = [];

  // --- Terrain cache key (perf ticket 18). The terrain pixels are a pure
  // function of these inputs — anything else changing never moves a terrain
  // pixel. NOTE: playerX/playerY are keyed EXACTLY, not per tile window: the
  // transforms translate terrain continuously with the player (~1 minimap px
  // per 16.5 world px), so freezing the sub-tile offset would NOT be
  // pixel-identical while moving. Stationary frames (combat/aim/windup/idle)
  // are the steady state this cache eliminates.
  private terrainKeyPlayerX = Number.NaN;
  private terrainKeyPlayerY = Number.NaN;
  private terrainKeyTileSize = 0;
  private terrainKeyWorldW = 0;
  private terrainKeyGrid: number[][] | null = null;
  private terrainKeyGridVersion = -1;
  private terrainKeyTiers: MinimapData['sectorTiers'] = undefined;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.create();
  }

  private create(): void {
    const { width } = this.scene.scale;
    const mc = ComponentConfig.minimap;

    const mmCX = width - mc.offsetX - mc.size / 2;
    const mmCY = mc.offsetY + mc.size / 2;
    const mmLeft = mmCX - mc.size / 2;
    const mmTop = mmCY - mc.size / 2;

    // Dark backing — bottom layer
    const backing = this.scene.add.rectangle(
      mmCX,
      mmCY,
      mc.size,
      mc.size,
      DesignTokens.colors.nearBlack,
      0.85,
    );
    backing.setDepth(DesignTokens.depth.minimapBg - 1);
    backing.setScrollFactor(0);

    // Terrain Graphics — under-layer (static, cache-redrawn on key change)
    this.minimapTerrainGfx = this.scene.add
      .graphics()
      .setPosition(mmLeft, mmTop)
      .setDepth(DesignTokens.depth.minimapBg)
      .setScrollFactor(0);

    // Graphics — middle layer (drawn between backing and border frame)
    this.minimapGfx = this.scene.add
      .graphics()
      .setPosition(mmLeft, mmTop)
      .setDepth(DesignTokens.depth.minimapBg)
      .setScrollFactor(0);

    // Bordered panel — TOP layer (opaque border covers graphics edge overflow,
    // transparent center lets minimap content show through)
    this.minimapPanel = new Panel(this.scene, mmCX, mmCY, {
      width: mc.size,
      height: mc.size,
      variant: 'bordered',
    });
    this.minimapPanel.setDepth(DesignTokens.depth.minimapContent);
    this.minimapPanel.setScrollFactor(0);

    // Sector POI name labels (map-redesign ticket 03) — pooled Text objects,
    // positioned relative to the graphics origin (mmLeft/mmTop) so they track
    // the minimap layout. Created after the panel; depth just UNDER the
    // border frame keeps the frame ring clean.
    this.sectorLabels = createSectorLabelSlots(this.scene, mmLeft, mmTop);
  }

  getEntranceElements(): (Panel | Phaser.GameObjects.Graphics)[] {
    return [this.minimapPanel, this.minimapTerrainGfx, this.minimapGfx];
  }

  // -----------------------------------------------------------------------
  // Minimap Rendering
  // -----------------------------------------------------------------------

  updateMinimap(data: MinimapData): void {
    if (data.worldW <= 0 || data.worldH <= 0) return;

    const SIZE = ComponentConfig.minimap.size;
    const ts = data.tileSize;
    // Shrink view range by one tile so edge tiles don't leak past [0, SIZE]
    const VIEW_RANGE = minimapViewRange(ts);

    // World→minimap coordinate transforms — player always at center
    const toMMX = (wx: number) => (wx - data.playerX) / MINIMAP_SCALE + SIZE / 2;
    const toMMY = (wy: number) => (wy - data.playerY) / MINIMAP_SCALE + SIZE / 2;

    // --- Static terrain (perf ticket 18): redraw ONLY when a terrain-pixel
    // input changed — exact player position (terrain translates continuously
    // with the player under toMMX/toMMY, so a per-tile-window key alone would
    // NOT be pixel-identical while moving), grid identity, grid mutation
    // version, tileSize, worldW, or the sector-tiers reference. In the steady
    // state (stationary player, no mutation) the cached layer persists
    // untouched — zero per-frame tile iteration, zero Graphics re-tessellation.
    // A mutation that lands between two frames is picked up here on the very
    // next call, so no stale frame is ever composited.
    if (
      data.playerX !== this.terrainKeyPlayerX ||
      data.playerY !== this.terrainKeyPlayerY ||
      data.tileSize !== this.terrainKeyTileSize ||
      data.worldW !== this.terrainKeyWorldW ||
      data.grid !== this.terrainKeyGrid ||
      data.gridVersion !== this.terrainKeyGridVersion ||
      data.sectorTiers !== this.terrainKeyTiers
    ) {
      this.minimapTerrainGfx.clear();
      redrawMinimapTerrain(this.minimapTerrainGfx, data, toMMX, toMMY);
      this.terrainKeyPlayerX = data.playerX;
      this.terrainKeyPlayerY = data.playerY;
      this.terrainKeyTileSize = data.tileSize;
      this.terrainKeyWorldW = data.worldW;
      this.terrainKeyGrid = data.grid;
      this.terrainKeyGridVersion = data.gridVersion;
      this.terrainKeyTiers = data.sectorTiers;
    }

    this.minimapGfx.clear();

    // --- Current zone ring (segment-based, clamped to [0, SIZE]) ---
    if (data.zoneRadius > 0) {
      const dz = Math.sqrt((data.zoneCX - data.playerX) ** 2 + (data.zoneCY - data.playerY) ** 2);
      if (dz < VIEW_RANGE + data.zoneRadius) {
        this.minimapGfx.lineStyle(2, DesignTokens.colors.brightRed, 0.8);
        this.drawClippedCircle(
          toMMX(data.zoneCX),
          toMMY(data.zoneCY),
          data.zoneRadius / MINIMAP_SCALE,
          SIZE,
          48,
        );
      }
    }

    // --- Target zone ring (dashed, clamped to [0, SIZE]) ---
    if (
      data.targetCX != null &&
      data.targetCY != null &&
      data.targetRadius != null &&
      data.targetRadius > 0
    ) {
      const dt = Math.sqrt(
        (data.targetCX - data.playerX) ** 2 + (data.targetCY - data.playerY) ** 2,
      );
      if (dt < VIEW_RANGE + data.targetRadius) {
        this.minimapGfx.lineStyle(2, DesignTokens.colors.amber, 0.5);
        this.drawClippedCircle(
          toMMX(data.targetCX),
          toMMY(data.targetCY),
          data.targetRadius / MINIMAP_SCALE,
          SIZE,
          48,
          true,
        );
      }
    }

    // --- Hot-sector mark (map-redesign ticket 02) — a distinct gold diamond
    // at the hot sector's center, visible at match start. When the sector is
    // outside the local minimap view the mark clamps to the minimap edge
    // (pointing toward it), so the gamble is always legible. A diamond (not a
    // circle) keeps it distinct from chest/pickup dots; drawn before the
    // player dot so the player marker stays the topmost element.
    const hot = data.hotSector;
    if (hot && data.worldW > 0) {
      const sectorPx = data.worldW / SECTOR_GRID;
      const hx = toMMX((hot.col + 0.5) * sectorPx);
      const hy = toMMY((hot.row + 0.5) * sectorPx);
      const clampPad = 9;
      const mx = Phaser.Math.Clamp(hx, clampPad, SIZE - clampPad);
      const my = Phaser.Math.Clamp(hy, clampPad, SIZE - clampPad);
      const r = 7;
      this.minimapGfx.lineStyle(2, TIER_TINT_HOT, 0.95);
      // diamond: rotated square via explicit path points
      this.minimapGfx.beginPath();
      this.minimapGfx.moveTo(mx, my - r);
      this.minimapGfx.lineTo(mx + r, my);
      this.minimapGfx.lineTo(mx, my + r);
      this.minimapGfx.lineTo(mx - r, my);
      this.minimapGfx.closePath();
      this.minimapGfx.strokePath();
      this.minimapGfx.fillStyle(TIER_TINT_HOT, 0.95);
      this.minimapGfx.fillCircle(mx, my, 2);
    }

    // --- Chests (gold dots, bounds-checked) ---
    this.minimapGfx.fillStyle(DesignTokens.colors.gold, 1);
    for (let i = 0; i < data.chestCount; i++) {
      const c = data.chests[i]!;
      const mx = toMMX(c.x);
      const my = toMMY(c.y);
      if (mx >= 0 && mx <= SIZE && my >= 0 && my <= SIZE) this.minimapGfx.fillCircle(mx, my, 2.5);
    }

    // --- Pickups (cyan dots, bounds-checked) ---
    this.minimapGfx.fillStyle(DesignTokens.colors.cyan, 1);
    for (let i = 0; i < data.pickupCount; i++) {
      const p = data.pickups[i]!;
      const mx = toMMX(p.x);
      const my = toMMY(p.y);
      if (mx >= 0 && mx <= SIZE && my >= 0 && my <= SIZE) this.minimapGfx.fillCircle(mx, my, 2.5);
    }

    // --- Landmark icons (map-redesign ticket 04) — theme-colored ringed dots
    //     at the hero anchors + small neutral diamonds at the minor nodes,
    //     drawn after terrain/loot so they stay legible on busy ground.
    drawLandmarkIcons(this.minimapGfx, data.landmarks, toMMX, toMMY, SIZE, ts);

    // --- Player dot (always at center — white with directional indicator) ---
    this.minimapGfx.fillStyle(DesignTokens.colors.white, 1);
    this.minimapGfx.fillCircle(SIZE / 2, SIZE / 2, 4);
    this.minimapGfx.fillStyle(DesignTokens.colors.brightRed, 1);
    this.minimapGfx.fillCircle(SIZE / 2, SIZE / 2, 2);

    // --- Sector POI name labels (map-redesign ticket 03) — current sector
    //     bright, orthogonal neighbors dim. Zero alloc: pooled Text objects,
    //     setText only on change.
    updateSectorLabels(this.scene, this.sectorLabels, data, toMMX, toMMY);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Draw a circle as line segments, clamping each segment endpoint to [0, size].
   * Segments fully outside bounds are skipped entirely.
   * @param dashed If true, draws every other segment (dashed effect)
   */
  private drawClippedCircle(
    cx: number,
    cy: number,
    radius: number,
    size: number,
    segments: number,
    dashed = false,
  ): void {
    for (let i = 0; i < segments; i++) {
      if (dashed && i % 2 === 1) continue;
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      const x1 = cx + Math.cos(a1) * radius;
      const y1 = cy + Math.sin(a1) * radius;
      const x2 = cx + Math.cos(a2) * radius;
      const y2 = cy + Math.sin(a2) * radius;
      const in1 = x1 >= 0 && x1 <= size && y1 >= 0 && y1 <= size;
      const in2 = x2 >= 0 && x2 <= size && y2 >= 0 && y2 <= size;
      if (!in1 && !in2) continue;
      this.minimapGfx.beginPath();
      this.minimapGfx.moveTo(Phaser.Math.Clamp(x1, 0, size), Phaser.Math.Clamp(y1, 0, size));
      this.minimapGfx.lineTo(Phaser.Math.Clamp(x2, 0, size), Phaser.Math.Clamp(y2, 0, size));
      this.minimapGfx.strokePath();
    }
  }

  destroy(): void {
    this.minimapGfx.destroy();
    this.minimapTerrainGfx.destroy();
    this.minimapPanel.destroy();
    for (const slot of this.sectorLabels) slot.text.destroy();
    this.sectorLabels = [];
  }
}
