import Phaser from 'phaser';
import {
  ColliderCollision,
  createSiegeWallSpriteDef,
  TileType,
  SECTOR_TILE_SIZE,
  wallTintAt,
  type SectorType,
} from '@sector-battle/shared';
import type { TileSpriteAtlas, TiledMapLayer, TileVisual, MapData } from '../types.js';
import { logger } from '@sector-battle/shared';

import { TILE_SIZE } from '../types.js';
import { bakeFloorIdentity, bakeGatewayFrames } from './MapRendererIdentity.js';
import { skipsWallBakeAt, WALL_FILL_LAYER_NAME } from './MapRendererWallFill.js';

const INTERACTIVE_TILE_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const ENTITY_PREFIXES = [
  'weapon_',
  'shield_',
  'chest',
  'crate',
  'barrel',
  'trap',
  'trapdoor',
  'door_',
];

export interface AtlasVisual {
  textureKey: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export class MapRenderer {
  private scene: Phaser.Scene;
  private tileSize: number = TILE_SIZE;
  private atlas: TileSpriteAtlas | null = null;
  private visualLayers: TiledMapLayer[] = [];
  private grid: number[][] = [];
  /**
   * Monotonic grid mutation counter (perf ticket 18) — bumped by EVERY seam
   * that writes the grid: `clearGridCell` (destructible/chest removal),
   * `setSiegeWallWithTexture` (siege wall drop) and `render` (full grid
   * load). Consumers that cache grid-derived rendering (the minimap terrain
   * cache) key on this because the grid array mutates IN PLACE — identity
   * comparison alone cannot see a mutation.
   */
  private gridVersion = 0;
  private worldWidth = 0;
  private worldHeight = 0;
  private siegeOverlayRT: Phaser.GameObjects.RenderTexture | null = null;
  /**
   * The decoration-layer render texture (above floor, below walls) — kept so
   * the gateway frame compositions (ticket 07) + the `wall_fill` under-layer
   * (ticket 13) can bake into it after the static layers render, with ZERO
   * new render-texture allocations.
   */
  private decorationRT: Phaser.GameObjects.RenderTexture | null = null;
  /**
   * The floor-layer render texture — kept so the visual-identity bake
   * (map-redesign ticket 07: floor tint fields + gateway lerp bands) can
   * paint into the floor AFTER its sprites render, in the same texture.
   */
  private floorRT: Phaser.GameObjects.RenderTexture | null = null;
  /**
   * Server-authored sector type grid (map-redesign ticket 07 / DEC-006) —
   * the key for per-district wall tints (identity sheets). Null on demo-TMX
   * maps: every wall falls back to the legacy global grey 0xbbbbcc.
   */
  private sectorTypes: SectorType[][] | null = null;
  private siegeWalls = new Set<number>();
  private siegeWallSpriteIndex: number | null = null;
  private readonly _cornerChecks = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  /**
   * Siege-wall visual overrides keyed by the NUMERIC grid encoding the
   * `siegeWalls` Set already uses (`gridX * 100000 + gridY`, perf ticket 21) —
   * the former `` `${gridX},${gridY}` `` string allocated per lookup, and
   * getSiegeWallVisual fires per tile per collision substep. The encoding is
   * injective for gridY ∈ [0, 100000): any read outside that band aliases an
   * in-band key (e.g. (-1, 100000+k) hits the (0, k) slot), but realizable
   * reads clamp to map extents (|gridX|,|gridY| ≤ ~81 on the 80×80 map).
   */
  private siegeVisualOverrides = new Map<number, TileVisual>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  isWalkable(worldX: number, worldY: number, radius: number): boolean {
    if (this.grid.length === 0) return true;
    const c0 = this._cornerChecks[0]!;
    const c1 = this._cornerChecks[1]!;
    const c2 = this._cornerChecks[2]!;
    const c3 = this._cornerChecks[3]!;
    c0.x = worldX - radius;
    c0.y = worldY - radius;
    c1.x = worldX + radius;
    c1.y = worldY - radius;
    c2.x = worldX - radius;
    c2.y = worldY + radius;
    c3.x = worldX + radius;
    c3.y = worldY + radius;
    if (this.isPointBlocked(c0.x, c0.y)) return false;
    if (this.isPointBlocked(c1.x, c1.y)) return false;
    if (this.isPointBlocked(c2.x, c2.y)) return false;
    if (this.isPointBlocked(c3.x, c3.y)) return false;
    return true;
  }

  /**
   * Point solidity query — SAT collider metadata first (a point inside a
   * blocked tile but outside its sprite's colliders is FREE), full-tile grid
   * as fallback. Mirrors the server's CollisionService.isPointBlocked.
   */
  isPointBlocked(x: number, y: number): boolean {
    if (this.grid.length === 0) return false;
    const col = Math.floor(x / this.tileSize);
    const row = Math.floor(y / this.tileSize);
    if (row < 0 || row >= this.grid.length || col < 0 || col >= (this.grid[0]?.length ?? 0))
      return true;
    const tile = this.grid[row]?.[col] ?? 1;
    if (tile === 0 || tile === 4) return false;

    if (this.siegeWalls.has(col * 100000 + row)) return true;

    if (this.atlas && this.visualLayers.length > 0) {
      const result = this.checkCellCollider(x, y, col, row);
      if (result === 'blocked') return true;
      if (result === 'walkable') return false;
    }

    return true;
  }

  private checkCellCollider(
    px: number,
    py: number,
    col: number,
    row: number,
  ): 'blocked' | 'walkable' | 'no-data' {
    for (const layer of this.visualLayers) {
      const cell = layer.cells[row]?.[col];
      if (!cell || cell.spriteId < 0) continue;
      const def = this.atlas!.sprites[cell.spriteId];
      if (!def || def.tileType === 0) continue;
      if (def.colliders.length === 0) return 'walkable';
      for (const collider of def.colliders) {
        const transformed = ColliderCollision.transformCollider(
          collider,
          col,
          row,
          this.tileSize,
          cell.rotation,
          cell.flipH,
          cell.flipV,
        );
        if (ColliderCollision.testPoint(px, py, transformed)) return 'blocked';
      }
      return 'walkable';
    }
    return 'no-data';
  }

  clearGridCell(col: number, row: number): void {
    // Grid mutation only — prediction and pose containment read this grid.
    // (The legacy debug base render texture was never allocated on the atlas
    // path, so there is no baked base tile to repaint.)
    if (row >= 0 && row < this.grid.length && col >= 0 && col < (this.grid[0]?.length ?? 0)) {
      if (this.grid[row]![col] === 0) return;
      this.grid[row]![col] = 0;
      this.gridVersion++;
    }
  }

  setSiegeWall(gridX: number, gridY: number): void {
    this.setSiegeWallWithTexture(gridX, gridY, 'wall');
  }

  /**
   * Draws a siege wall tile. `textureKey` is a frame name in the `game` atlas
   * (e.g. `'wall'`, `'coffin'`); under the multipack atlas it resolves as a
   * frame, not a standalone texture.
   */
  setSiegeWallWithTexture(gridX: number, gridY: number, textureKey: string): void {
    if (!this.siegeOverlayRT) return;
    if (
      gridY >= 0 &&
      gridY < this.grid.length &&
      gridX >= 0 &&
      gridX < (this.grid[0]?.length ?? 0)
    ) {
      if (this.grid[gridY]![gridX] !== 1) {
        this.grid[gridY]![gridX] = 1;
        this.gridVersion++;
      }
      this.siegeWalls.add(gridX * 100000 + gridY);
      this.injectSiegeWallVisual(gridX, gridY);
    }
    // Map-redesign ticket 07: siege walls tint with their district's identity
    // sheet wall tint (consistent material per sector; global-grey fallback
    // on demo maps).
    const siegeTint = wallTintAt(this.sectorTypes, gridX, gridY, SECTOR_TILE_SIZE);
    if (this.hasGameFrame(textureKey)) {
      const tempSprite = this.scene.add
        .sprite(
          gridX * this.tileSize + this.tileSize / 2,
          gridY * this.tileSize + this.tileSize / 2,
          'game',
          textureKey,
        )
        .setOrigin(0.5)
        .setDisplaySize(this.tileSize, this.tileSize)
        .setTint(siegeTint);
      this.siegeOverlayRT.draw(tempSprite);
      this.siegeOverlayRT.render();
      tempSprite.destroy();
    } else {
      const g = this.scene.add.graphics();
      g.fillStyle(siegeTint, 1);
      g.fillRect(gridX * this.tileSize, gridY * this.tileSize, this.tileSize, this.tileSize);
      this.siegeOverlayRT.draw(g);
      this.siegeOverlayRT.render();
      g.destroy();
    }
  }

  private injectSiegeWallVisual(gridX: number, gridY: number): void {
    if (!this.atlas) return;
    if (this.siegeWallSpriteIndex === null) {
      this.siegeWallSpriteIndex = this.atlas.sprites.length;
      this.atlas.sprites.push(createSiegeWallSpriteDef(this.tileSize));
    }
    this.siegeVisualOverrides.set(gridX * 100000 + gridY, {
      spriteId: this.siegeWallSpriteIndex,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  }

  getSiegeWallVisual(gridX: number, gridY: number): TileVisual | null {
    return this.siegeVisualOverrides.get(gridX * 100000 + gridY) ?? null;
  }

  /**
   * The district wall tint for a tile (map-redesign ticket 07) — the identity
   * sheet tint of the tile's sector, or the legacy global grey on demo-TMX
   * maps. Shared by the siege-wall bake and the siege-warning VFX so the
   * falling coffin matches the wall it becomes.
   */
  wallTintAtTile(gridX: number, gridY: number): number {
    return wallTintAt(this.sectorTypes, gridX, gridY, SECTOR_TILE_SIZE);
  }

  /**
   * The sector-type grid [row][col] (map-polish ticket 31) — null on demo-TMX
   * maps / before map load. Consumed by the lighting atmosphere for
   * per-sector dust theming (`LightingAtmosphereThemes`).
   */
  getSectorTypes(): SectorType[][] | null {
    return this.sectorTypes;
  }

  getAtlasVisual(gridX: number, gridY: number, preferEntity = false): AtlasVisual | null {
    if (!this.atlas) return null;
    let firstResult: AtlasVisual | null = null;
    let entityResult: AtlasVisual | null = null;
    for (const layer of this.visualLayers) {
      const cell = layer.cells[gridY]?.[gridX];
      if (!cell) continue;
      const def = this.atlas.sprites[cell.spriteId];
      if (!def || !def.imagePath) continue;
      const visual: AtlasVisual = {
        textureKey: def.imagePath,
        rotation: cell.rotation ?? 0,
        flipH: cell.flipH ?? false,
        flipV: cell.flipV ?? false,
      };
      if (!firstResult) firstResult = visual;
      if (
        INTERACTIVE_TILE_TYPES.has(def.tileType) ||
        ENTITY_PREFIXES.some((p) => def.imagePath.startsWith(p))
      ) {
        entityResult = visual;
      }
    }
    if (preferEntity && entityResult) return entityResult;
    return firstResult;
  }

  /**
   * The autotiled visual (sprite + rotation + flip) for a breakable wall cell,
   * read specifically from the server-authoritative `map_border_walls` layer.
   * The live wall entity uses this so the single entity sprite carries the same
   * material the static layer would have baked.
   */
  getWallVisualAt(gridX: number, gridY: number): AtlasVisual | null {
    if (!this.atlas) return null;
    for (const layer of this.visualLayers) {
      const cell = layer.cells[gridY]?.[gridX];
      if (!cell) continue;
      const def = this.atlas.sprites[cell.spriteId];
      if (!def || !def.imagePath) continue;
      if (def.tileType === TileType.EMPTY) continue;
      return {
        textureKey: def.imagePath,
        rotation: cell.rotation ?? 0,
        flipH: cell.flipH ?? false,
        flipV: cell.flipV ?? false,
      };
    }
    return null;
  }

  getMapWidth(): number {
    return this.worldWidth;
  }
  getMapHeight(): number {
    return this.worldHeight;
  }
  getGrid(): number[][] {
    return this.grid;
  }
  /** Monotonic grid mutation counter (perf ticket 18) — see field doc. */
  getGridVersion(): number {
    return this.gridVersion;
  }
  getTileSize(): number {
    return this.tileSize;
  }
  getAtlas(): TileSpriteAtlas | null {
    return this.atlas;
  }
  getVisualLayers(): TiledMapLayer[] {
    return this.visualLayers;
  }

  render(data: MapData): void {
    this.grid = data.grid;
    // Perf ticket 18: a fresh grid load is a full-grid mutation — bump the
    // version so grid-derived caches (minimap terrain) drop their key.
    this.gridVersion++;
    this.tileSize = data.tileSize;
    this.atlas = data.atlas ?? null;
    this.visualLayers = data.visualLayers ?? [];
    this.worldWidth = data.width * data.tileSize;
    this.worldHeight = data.height * data.tileSize;
    // Map-redesign ticket 07: server-authored sector type grid → per-district
    // identity-sheet wall tints. Null on demo-TMX maps (global grey fallback).
    this.sectorTypes = data.sectorTypes ?? null;

    if (data.visualLayers && data.atlas && this.hasAtlasTextures(data.atlas)) {
      logger.info(
        `Rendering ${data.visualLayers.length} visual layers with atlas (${data.atlas.sprites.length} sprites)`,
      );
      this.renderStaticVisualLayers(data.visualLayers);
    } else {
      logger.info(
        `No visual layers or atlas. visualLayers=${!!data.visualLayers} atlas=${!!data.atlas}`,
      );
    }

    // Map-redesign ticket 07 / DEC-006: bake the visual identity into the
    // STATIC layers (floor tint fields + gateway lerp bands into the floor
    // texture; gateway frame compositions into the decoration texture).
    // Bake-time only — zero per-frame cost, no new render textures. No-op
    // when identity data is absent (demo-TMX maps).
    bakeFloorIdentity(this.scene, this.floorRT, data.identity, this.tileSize);
    bakeGatewayFrames(
      this.scene,
      this.decorationRT,
      data.identity,
      this.sectorTypes,
      this.tileSize,
    );

    // Map-polish ticket 29: the landmark composite dressing bake that used to
    // run here (loose `game`-atlas decor frames at fractional offsets around
    // each hero anchor + one decor tile per junction minor) is REMOVED — the
    // plaza is the server-composed keep + beacon-anchored court floor + light
    // + motes, never client-baked decor tiles over the floor grid.

    this.siegeOverlayRT = this.scene.add.renderTexture(0, 0, this.worldWidth, this.worldHeight);
    this.siegeOverlayRT.setOrigin(0, 0);
    this.siegeOverlayRT.setDepth(3);

    this.scene.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);
  }

  private renderStaticVisualLayers(layers: TiledMapLayer[]): void {
    for (const layer of layers) {
      // Ticket 13: the `wall_fill` under-layer bakes INTO the decoration RT
      // (above floor/decoration, beneath the wall layer's depth-2 RT, zero
      // new render-texture allocations). Seed maps always carry a decoration
      // layer first; if it is ever missing, skip rather than allocate.
      const isFillLayer = layer.name === WALL_FILL_LAYER_NAME;
      if (isFillLayer && !this.decorationRT) {
        logger.warn('wall_fill layer present without a decoration layer to bake into — skipped');
        continue;
      }
      const rt = isFillLayer
        ? this.decorationRT!
        : this.scene.add.renderTexture(0, 0, this.worldWidth, this.worldHeight);
      if (!isFillLayer) {
        rt.setOrigin(0, 0);
        rt.setDepth(layer.name === 'map_border_walls' ? 2 : 1);
      }
      if (layer.name === 'decoration') this.decorationRT = rt;
      if (layer.name === 'floor') this.floorRT = rt;

      const tempSprites: Phaser.GameObjects.Sprite[] = [];
      let bakedCount = 0;
      let skippedCount = 0;
      for (let row = 0; row < layer.cells.length; row++) {
        for (let col = 0; col < (layer.cells[row]?.length ?? 0); col++) {
          const cell = layer.cells[row]?.[col];
          if (!cell) continue;
          if (layer.name === 'interactive_layer' && this.isEntitySprite(cell, layer.name)) {
            skippedCount++;
            continue;
          }
          // Breakable walls are NOT baked here — they render as live HP
          // entities (baking would double-render and ghost after
          // destruction); the fill layer skips destructible cells the same
          // way (see MapRendererWallFill).
          if (skipsWallBakeAt(layer.name, this.grid, row, col)) {
            skippedCount++;
            continue;
          }
          const key = this.resolveTextureKey(cell);
          if (!key || !this.hasGameFrame(key)) continue;
          const px = col * this.tileSize + this.tileSize / 2;
          const py = row * this.tileSize + this.tileSize / 2;
          const sprite = this.scene.add
            .sprite(px, py, 'game', key)
            .setOrigin(0.5)
            .setDisplaySize(this.tileSize, this.tileSize);
          if (cell.rotation) sprite.setRotation((cell.rotation * Math.PI) / 180);
          const sx = cell.flipH ? -1 : 1;
          const sy = cell.flipV ? -1 : 1;
          sprite.setScale(sx, sy);
          if (this.atlas) {
            const def = this.atlas.sprites[cell.spriteId];
            // Ticket 07 / DEC-006: walls render in their DISTRICT's
            // identity-sheet tint (autotiling unaffected — the tint
            // multiplies the same frames). Ticket 13: fill cells are
            // EMPTY-typed floor frames — their own clause picks up the same
            // wall tint (the fill reads as wall BODY, not floor).
            if (def && (def.tileType === 1 || def.tileType === 8 || isFillLayer)) {
              sprite.setTint(wallTintAt(this.sectorTypes, col, row, SECTOR_TILE_SIZE));
            }
          }
          rt.draw(sprite);
          tempSprites.push(sprite);
          bakedCount++;
        }
      }
      rt.render();
      for (const s of tempSprites) s.destroy();
      logger.debug(`Layer "${layer.name}": baked=${bakedCount} skipped(entity)=${skippedCount}`);
    }
  }

  private isEntitySprite(cell: TileVisual, _layerName: string): boolean {
    if (!this.atlas) return false;
    const def = this.atlas.sprites[cell.spriteId];
    if (!def) return false;
    if (INTERACTIVE_TILE_TYPES.has(def.tileType)) return true;
    if (ENTITY_PREFIXES.some((p) => def.imagePath.startsWith(p))) return true;
    return false;
  }

  private resolveTextureKey(cell: TileVisual): string | null {
    if (!this.atlas) return null;
    const def = this.atlas.sprites[cell.spriteId];
    if (!def) return null;
    return def.imagePath || null;
  }

  private hasAtlasTextures(atlas: TileSpriteAtlas): boolean {
    for (let i = 0; i < atlas.sprites.length; i++) {
      const def = atlas.sprites[i];
      if (def && def.imagePath && this.hasGameFrame(def.imagePath)) return true;
    }
    return false;
  }

  /** True if `frame` exists in the `game` multipack atlas. */
  private hasGameFrame(frame: string): boolean {
    return this.scene.textures.get('game').has(frame);
  }
}
