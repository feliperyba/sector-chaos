import { describe, it, expect, beforeAll } from 'vitest';
import {
  MapGenerator as SharedMapGenerator,
  TileType,
  type MapData,
  type EnrichedMapData,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
} from '@sector-battle/shared';
import { SeedMapAdapter } from '../SeedMapAdapter.js';
import {
  PLAZA_ACCENT_PATHS,
  isBeaconCourtTile,
  resolveBeaconCourtAnchors,
} from '../biomeConfig.js';
import { resolve } from 'node:path';

// Repo root is 6 levels up from this test file (same depth as TsxAtlasParser test)
const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

describe('SeedMapAdapter', () => {
  const sharedGenerator = new SharedMapGenerator();
  const adapter = new SeedMapAdapter();

  // Use a fixed seed that reliably generates a valid map
  const TEST_SEED = 42;
  let mapData: MapData;
  let enriched: EnrichedMapData;

  let courtAnchors: Map<string, { x: number; y: number }>;

  beforeAll(() => {
    mapData = sharedGenerator.generate(TEST_SEED);
    enriched = adapter.adapt(mapData, TEST_SEED, TILED_DIR);
    const sectorsPerSide = Math.max(1, Math.floor(enriched.height / SECTOR_TILE_SIZE));
    courtAnchors = resolveBeaconCourtAnchors(mapData, sectorsPerSide);
  });

  it('produces an EnrichedMapData with correct dimensions', () => {
    const expectedSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
    expect(enriched.width).toBe(expectedSize);
    expect(enriched.height).toBe(expectedSize);
    expect(enriched.grid.length).toBe(expectedSize);
    expect(enriched.grid[0]!.length).toBe(expectedSize);
  });

  it('has tileSize of 128', () => {
    expect(enriched.tileSize).toBe(TILE_PIXEL_SIZE);
  });

  it('preserves the seed', () => {
    expect(enriched.seed).toBe(TEST_SEED);
  });

  it('has exactly 5 visual layers with correct names (ticket 13: wall_fill beneath map_border_walls)', () => {
    expect(enriched.visualLayers).toHaveLength(5);
    const names = enriched.visualLayers.map((l) => l.name);
    expect(names).toEqual([
      'floor',
      'decoration',
      'wall_fill',
      'map_border_walls',
      'interactive_layer',
    ]);
  });

  it('each visual layer has cells matching grid dimensions', () => {
    for (const layer of enriched.visualLayers) {
      expect(layer.cells.length).toBe(enriched.height);
      for (const row of layer.cells) {
        expect(row.length).toBe(enriched.width);
      }
    }
  });

  it('has an atlas with sprites', () => {
    expect(enriched.atlas.sprites.length).toBeGreaterThan(0);
  });

  it('atlas includes env + weapon sprites', () => {
    const imagePaths = enriched.atlas.sprites.map((s) => s.imagePath);
    // Should have wall sprites from env
    expect(imagePaths.some((p) => p.includes('wall'))).toBe(true);
    // Should have weapon sprites from weapons tileset
    expect(imagePaths.some((p) => p.startsWith('weapon_') || p.startsWith('shield_'))).toBe(true);
  });

  it('wall layer has sprites where grid has wall tiles', () => {
    const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
    let wallSpriteCount = 0;
    for (let row = 0; row < enriched.height; row++) {
      for (let col = 0; col < enriched.width; col++) {
        const tile = enriched.grid[row]![col]!;
        const isWallLike =
          tile === TileType.INDESTRUCTIBLE_WALL ||
          tile === TileType.DESTRUCTIBLE_WALL ||
          tile === TileType.INDESTRUCTIBLE_CRATE;

        if (isWallLike) {
          const cell = wallLayer.cells[row]![col];
          if (cell) wallSpriteCount++;
        }
      }
    }
    expect(wallSpriteCount).toBeGreaterThan(0);
  });

  it('floor layer is a dense underlay (every cell has a sprite; borders use wood)', () => {
    const floorLayer = enriched.visualLayers[0]!;

    // Derive the expected `wood` sprite id from the adapter's own atlas, the same
    // way FloorSpriteSelector does (find the sprite whose imagePath === 'wood').
    const woodSprite = enriched.atlas.sprites.find((s) => s.imagePath === 'wood');
    expect(woodSprite).toBeDefined();
    const woodId = woodSprite!.id;

    for (let row = 0; row < enriched.height; row++) {
      for (let col = 0; col < enriched.width; col++) {
        const cell = floorLayer.cells[row]![col];

        // Dense underlay: no holes — every cell has a floor sprite.
        expect(cell).not.toBeNull();
        expect(cell!.spriteId).toBeGreaterThanOrEqual(0);

        // Edge cells (global row/col on a 20-tile sector border) use `wood`;
        // interior cells use a per-sector theme sprite that is not `wood`.
        const rowLocal = row % SECTOR_TILE_SIZE;
        const colLocal = col % SECTOR_TILE_SIZE;
        const isEdge =
          rowLocal === 0 ||
          rowLocal === SECTOR_TILE_SIZE - 1 ||
          colLocal === 0 ||
          colLocal === SECTOR_TILE_SIZE - 1;

        if (isEdge) {
          expect(cell!.spriteId).toBe(woodId);
        } else {
          // `wood` is ALSO the RESOURCE_RICH beacon-court accent (biomeConfig
          // v11 cohesion: the plank dais on the brown depot floor) — interior
          // wood is legal exactly on the court tiles of a sector whose accent
          // IS wood, and nowhere else.
          const sr = Math.floor(row / SECTOR_TILE_SIZE);
          const sc = Math.floor(col / SECTOR_TILE_SIZE);
          const anchor = courtAnchors.get(`${sr},${sc}`);
          const sectorType = mapData.sectors[sr]?.[sc]?.type;
          const onWoodCourt =
            anchor !== undefined &&
            sectorType !== undefined &&
            PLAZA_ACCENT_PATHS[sectorType] === 'wood' &&
            isBeaconCourtTile(col - anchor.x, row - anchor.y);
          if (!onWoodCourt) {
            expect(cell!.spriteId).not.toBe(woodId);
          }
        }
      }
    }
  });

  it('entities are populated', () => {
    expect(enriched.entities).toBeDefined();
    expect(enriched.entities.spawnPoints).toBeDefined();
    expect(enriched.entities.spawnPoints.length).toBeGreaterThan(0);
    expect(enriched.entities.spawnPoints[0]!.gridX).toBeGreaterThanOrEqual(0);
    expect(enriched.entities.spawnPoints[0]!.gridY).toBeGreaterThanOrEqual(0);
  });

  it('entities.destructibles contains placements for crates and barrels', () => {
    // The map may or may not have destructibles, but the array should exist
    expect(Array.isArray(enriched.entities.destructibles)).toBe(true);
    for (const d of enriched.entities.destructibles) {
      expect(d.gridX).toBeGreaterThanOrEqual(0);
      expect(d.gridY).toBeGreaterThanOrEqual(0);
      expect(d.textureKey).toBeTruthy();
      expect([0, 90, 180, 270]).toContain(d.rotation);
    }
  });

  it('entities.chests has valid placements', () => {
    expect(Array.isArray(enriched.entities.chests)).toBe(true);
    for (const c of enriched.entities.chests) {
      expect(c.gridX).toBeGreaterThanOrEqual(0);
      expect(c.gridY).toBeGreaterThanOrEqual(0);
      expect(c.textureKey).toBeTruthy();
    }
  });

  it('entities.weapons has valid placements', () => {
    expect(Array.isArray(enriched.entities.weapons)).toBe(true);
    for (const w of enriched.entities.weapons) {
      expect(w.gridX).toBeGreaterThanOrEqual(0);
      expect(w.gridY).toBeGreaterThanOrEqual(0);
      expect(w.textureKey).toBeTruthy();
      expect(w.weaponType).toBeDefined();
    }
  });

  it('entities.traps has valid placements', () => {
    expect(Array.isArray(enriched.entities.traps)).toBe(true);
    for (const t of enriched.entities.traps) {
      expect(t.gridX).toBeGreaterThanOrEqual(0);
      expect(t.gridY).toBeGreaterThanOrEqual(0);
      expect(t.textureKey).toBeTruthy();
      expect(t.trapType).toBeDefined();
    }
  });

  it('entities.exits has valid placements', () => {
    expect(Array.isArray(enriched.entities.exits)).toBe(true);
    // Exits may be empty depending on map layout, but the array must exist
    for (const e of enriched.entities.exits) {
      expect(e.gridX).toBeGreaterThanOrEqual(0);
      expect(e.gridY).toBeGreaterThanOrEqual(0);
      expect(e.textureKey).toBeTruthy();
    }
  });

  it('entities.powerups has valid placements for POWERUP_SPAWN loot', () => {
    expect(Array.isArray(enriched.entities.powerups)).toBe(true);
    // POWERUP_SPAWN makes up ~60% of LootSpawner output, so the array should be non-empty
    expect(enriched.entities.powerups.length).toBeGreaterThan(0);
    for (const p of enriched.entities.powerups) {
      expect(p.gridX).toBeGreaterThanOrEqual(0);
      expect(p.gridY).toBeGreaterThanOrEqual(0);
      expect(p.textureKey).toBe('puddle');
      expect(p.rotation).toBe(0);
      expect(p.flipH).toBe(false);
      expect(p.flipV).toBe(false);
    }
  });

  it('produces deterministic output for the same seed', () => {
    const enriched2 = adapter.adapt(mapData, TEST_SEED, TILED_DIR);
    // Compare structures
    expect(enriched2.width).toBe(enriched.width);
    expect(enriched2.height).toBe(enriched.height);
    expect(enriched2.tileSize).toBe(enriched.tileSize);
    expect(enriched2.seed).toBe(enriched.seed);
    expect(enriched2.visualLayers.length).toBe(enriched.visualLayers.length);
    expect(enriched2.atlas.sprites.length).toBe(enriched.atlas.sprites.length);

    // Compare grids
    expect(enriched2.grid).toEqual(enriched.grid);

    // Compare visual layers cell-by-cell
    for (let l = 0; l < enriched.visualLayers.length; l++) {
      for (let row = 0; row < enriched.height; row++) {
        for (let col = 0; col < enriched.width; col++) {
          const cell1 = enriched.visualLayers[l]!.cells[row]![col];
          const cell2 = enriched2.visualLayers[l]!.cells[row]![col];
          expect(cell2).toEqual(cell1);
        }
      }
    }

    // Compare entities
    expect(enriched2.entities.destructibles).toEqual(enriched.entities.destructibles);
    expect(enriched2.entities.chests).toEqual(enriched.entities.chests);
    expect(enriched2.entities.weapons).toEqual(enriched.entities.weapons);
    expect(enriched2.entities.traps).toEqual(enriched.entities.traps);
    expect(enriched2.entities.exits).toEqual(enriched.entities.exits);
    expect(enriched2.entities.powerups).toEqual(enriched.entities.powerups);
  });

  it('wall lookup contains only genuine wall imagePaths, no trap sprites', async () => {
    // Re-build the lookup to inspect it directly
    const { TsxAtlasParser } = await import('../../parsers/TsxAtlasParser.js');
    const parser = new TsxAtlasParser();
    const envAtlas = parser.parse(resolve(TILED_DIR, 'env.tsx'));
    const weaponsAtlas = parser.parse(resolve(TILED_DIR, 'weapons.tsx'));
    const combinedSprites = [...envAtlas.sprites];
    const weaponOffset = combinedSprites.length;
    for (const ws of weaponsAtlas.sprites) {
      combinedSprites.push({ ...ws, id: weaponOffset + ws.id });
    }
    const atlas = { sprites: combinedSprites };

    const trapImagePaths = new Set([
      'trap',
      'trap_door',
      'trapdoor_round',
      'trapdoor_square',
      'wall_trap',
    ]);

    // Before fix: traps are INDESTRUCTIBLE_WALL and would appear in wall bucket
    const rawWallSprites = atlas.sprites.filter((s) => s.tileType === TileType.INDESTRUCTIBLE_WALL);
    const hasTrapsInRaw = rawWallSprites.some((s) => trapImagePaths.has(s.imagePath));
    expect(hasTrapsInRaw).toBe(true); // confirms the root cause exists in the atlas

    // After fix: buildSpriteLookup should filter them out.
    // Verify by checking the wall layer's sprite IDs — none should be trap imagePaths
    const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
    const trapSpriteIds = new Set(
      atlas.sprites.filter((s) => trapImagePaths.has(s.imagePath)).map((s) => s.id),
    );

    for (let row = 0; row < enriched.height; row++) {
      for (let col = 0; col < enriched.width; col++) {
        const cell = wallLayer.cells[row]![col]!;
        if (cell === null) continue;
        if (trapSpriteIds.has(cell.spriteId)) {
          const sprite = atlas.sprites[cell.spriteId]!;
          // This should never happen after the fix
          expect.fail(`Wall layer at [${row},${col}] uses trap sprite: ${sprite?.imagePath}`);
        }
      }
    }
  });

  it('autotile-aware: each indestructible wall sprite matches the canonical role for its 8-neighbour mask', async () => {
    const wallLayer = enriched.visualLayers.find((l) => l.name === 'map_border_walls')!;
    const atlasById = new Map(enriched.atlas.sprites.map((s) => [s.id, s]));

    // Canonical role → imagePath for the indestructible material (mirrors the
    // adapter's deterministic lookup; straight/isolated/endcap/cross/t_junction
    // all resolve to `wall`).
    const ROLE_IMAGE: Record<string, string> = {
      straight: 'wall',
      isolated: 'wall',
      endcap: 'wall',
      cross: 'wall',
      t_junction: 'wall',
      outer_corner: 'wall_corner',
      inner_corner: 'inner_round',
      diagonal: 'wall_diagonal',
    };

    // Re-detect masks and classify, asserting the emitted sprite is deterministic.
    const { WallOrientationDetector } = await import('../WallOrientationDetector.js');
    const { classifyWall, WALL_MASK_BITS } = await import('../WallMaskClassifier.js');
    const detector = new WallOrientationDetector();
    const masks = detector.detect(enriched.grid);
    const CARD_BITS = WALL_MASK_BITS.N | WALL_MASK_BITS.E | WALL_MASK_BITS.S | WALL_MASK_BITS.W;
    const DIAG_BITS = WALL_MASK_BITS.NE | WALL_MASK_BITS.SE | WALL_MASK_BITS.SW | WALL_MASK_BITS.NW;

    const rolesSeen = new Set<string>();

    for (let row = 0; row < enriched.height; row++) {
      for (let col = 0; col < enriched.width; col++) {
        const mask = masks[row]![col]!;
        const cell = wallLayer.cells[row]![col]!;
        if (mask === null || cell === null) continue;
        if (enriched.grid[row]![col] !== TileType.INDESTRUCTIBLE_WALL) continue;

        const sprite = atlasById.get(cell.spriteId);
        if (!sprite) continue;

        // The ROLE is a pure function of the mask (the ticket-13 one-open
        // facing modes only rotate straights, never re-role); rotation
        // correctness is pinned by the matrix + continuity-gate suites.
        // Ticket-20 exception: a CORNER-DANGLING cell (zero wall-like
        // cardinals, >=1 wall-like diagonal) re-roles `isolated` to the
        // corner-hugging `outer_corner` L — the floating-shard fix.
        const choice = classifyWall(mask);
        const dangling = (mask & CARD_BITS) === 0 && (mask & DIAG_BITS) !== 0;
        const expectedRole = dangling && choice.role === 'isolated' ? 'outer_corner' : choice.role;
        rolesSeen.add(expectedRole);
        expect(sprite.imagePath).toBe(ROLE_IMAGE[expectedRole]);
        expect(cell.flipH).toBe(choice.flipH);
        expect(cell.flipV).toBe(choice.flipV);
        expect([0, 90, 180, 270]).toContain(cell.rotation);
      }
    }

    expect(rolesSeen.has('straight')).toBe(true);
    expect(rolesSeen.has('inner_corner') || rolesSeen.has('outer_corner')).toBe(true);
  });

  it('all spriteIds in visual layers reference valid atlas entries', () => {
    for (const layer of enriched.visualLayers) {
      for (const row of layer.cells) {
        for (const cell of row) {
          if (cell === null) continue;
          expect(cell.spriteId).toBeGreaterThanOrEqual(0);
          expect(cell.spriteId).toBeLessThan(enriched.atlas.sprites.length);
          const sprite = enriched.atlas.sprites[cell.spriteId];
          expect(sprite).toBeDefined();
          expect([0, 90, 180, 270]).toContain(cell.rotation);
        }
      }
    }
  });
});
