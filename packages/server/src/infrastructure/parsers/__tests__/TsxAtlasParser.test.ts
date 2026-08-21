import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DECOR_BAKE_FRAMES, OBJECT_VISUAL_FRAMES, TileType } from '@sector-battle/shared';
import { TsxAtlasParser } from '../TsxAtlasParser.ts';

const TSX_PATH = resolve(__dirname, '../../../../../../tiled/env.tsx');

describe('TsxAtlasParser', () => {
  const parser = new TsxAtlasParser();
  const atlas = parser.parse(TSX_PATH);

  it('has 51 sprites (matching tilecount in env.tsx)', () => {
    expect(atlas.sprites).toHaveLength(51);
  });

  it('assigns sequential spriteId === array index', () => {
    for (let i = 0; i < atlas.sprites.length; i++) {
      expect(atlas.sprites[i]!.id).toBe(i);
    }
  });

  it('parses barrel (id 0) as DESTRUCTIBLE_BARREL with collider', () => {
    const barrel = atlas.sprites[0]!;
    expect(barrel.tileType).toBe(TileType.DESTRUCTIBLE_BARREL);
    expect(barrel.imagePath).toBe('barrel');
    expect(barrel.colliders).toHaveLength(1);
    expect(barrel.colliders[0]!.type).toBe('rect');
  });

  it('parses chest (id 5) as CHEST', () => {
    const chest = atlas.sprites[5]!;
    expect(chest.tileType).toBe(TileType.CHEST);
    expect(chest.imagePath).toBe('chest');
    expect(chest.colliders).toHaveLength(1);
  });

  it('parses wall (id 39) as INDESTRUCTIBLE_WALL', () => {
    const wall = atlas.sprites[39]!;
    expect(wall.tileType).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(wall.imagePath).toBe('wall');
    expect(wall.colliders.length).toBeGreaterThanOrEqual(1);
  });

  it('parses wall_corner (id 40) as INDESTRUCTIBLE_WALL with polygon collider', () => {
    const corner = atlas.sprites[40]!;
    expect(corner.tileType).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(corner.imagePath).toBe('wall_corner');
    expect(corner.colliders).toHaveLength(1);
    expect(corner.colliders[0]!.type).toBe('polygon');
    expect((corner.colliders[0] as { points: unknown[] }).points.length).toBeGreaterThan(2);
  });

  it('parses grass (id 12) as EMPTY with no colliders', () => {
    const grass = atlas.sprites[12]!;
    expect(grass.tileType).toBe(TileType.EMPTY);
    expect(grass.imagePath).toBe('grass');
    expect(grass.colliders).toHaveLength(0);
  });

  it('all imagePaths are non-empty strings', () => {
    for (const s of atlas.sprites) {
      expect(s.imagePath).toBeTruthy();
    }
  });

  it('parses destructible wall (id 42) as DESTRUCTIBLE_WALL', () => {
    const wall = atlas.sprites[42]!;
    expect(wall.tileType).toBe(TileType.DESTRUCTIBLE_WALL);
    expect(wall.imagePath).toBe('wall_damaged');
    expect(wall.colliders.length).toBeGreaterThanOrEqual(1);
  });

  it('parses exit (id 10) as EXIT', () => {
    const exit = atlas.sprites[10]!;
    expect(exit.tileType).toBe(TileType.EXIT);
    expect(exit.imagePath).toBe('door_open');
  });

  it('parses door_closed (id 9) as DOOR_CLOSED', () => {
    const door = atlas.sprites[9]!;
    expect(door.tileType).toBe(TileType.DOOR_CLOSED);
    expect(door.imagePath).toBe('door_closed');
  });

  describe('error paths', () => {
    it('throws on missing file', () => {
      expect(() => parser.parse('/nonexistent/path.tsx')).toThrow();
    });

    it('handles empty tileset (tilecount=0)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'tsx-test-'));
      const tsxPath = join(tmpDir, 'empty.tsx');
      writeFileSync(
        tsxPath,
        `<?xml version="1.0"?>
<tileset name="empty" tilecount="0" columns="0" tilewidth="128" tileheight="128"/>`,
      );
      const atlas = parser.parse(tsxPath);
      expect(atlas.sprites).toEqual([]);
      rmSync(tmpDir, { recursive: true });
    });

    it('defaults tile with no properties and no colliders to EMPTY', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'tsx-test-'));
      const tsxPath = join(tmpDir, 'minimal.tsx');
      writeFileSync(
        tsxPath,
        `<?xml version="1.0"?>
<tileset name="test" tilecount="1" columns="1" tilewidth="128" tileheight="128">
  <tile id="0">
    <image source="test.png" width="128" height="128"/>
  </tile>
</tileset>`,
      );
      const atlas = parser.parse(tsxPath);
      expect(atlas.sprites).toHaveLength(1);
      expect(atlas.sprites[0]!.tileType).toBe(TileType.EMPTY);
      expect(atlas.sprites[0]!.imagePath).toBe('test');
      rmSync(tmpDir, { recursive: true });
    });

    it('maps tile with colliders but no TYPE to INDESTRUCTIBLE_WALL', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'tsx-test-'));
      const tsxPath = join(tmpDir, 'collider.tsx');
      writeFileSync(
        tsxPath,
        `<?xml version="1.0"?>
<tileset name="test" tilecount="1" columns="1" tilewidth="128" tileheight="128">
  <tile id="0">
    <objectgroup draworder="index">
      <object id="1" x="0" y="0" width="128" height="128"/>
    </objectgroup>
    <image source="wall.png" width="128" height="128"/>
  </tile>
</tileset>`,
      );
      const atlas = parser.parse(tsxPath);
      expect(atlas.sprites).toHaveLength(1);
      expect(atlas.sprites[0]!.tileType).toBe(TileType.INDESTRUCTIBLE_WALL);
      rmSync(tmpDir, { recursive: true });
    });
  });
});

describe('OBJECT_VISUAL_FRAMES parity (map-polish ticket 06)', () => {
  // The no-baked-objects rule's deny/decor frame constants (shared
  // `bakeFrameDiscipline.ts`) are transcribed from this atlas file — the TSX
  // is the single source of truth. This parity test re-derives the two
  // partitions from the PARSED atlas ({ non-EMPTY imagePath } vs
  // { EMPTY imagePath }) and asserts set equality with the constants, so an
  // atlas edit (new/re-typed frame) can never silently drift past the shared
  // rule test that bans the deny set from every bake-driven frame table.
  const parser = new TsxAtlasParser();
  const atlas = parser.parse(TSX_PATH);

  const derivedDeny = new Set(
    atlas.sprites.filter((s) => s.tileType !== TileType.EMPTY).map((s) => s.imagePath),
  );
  const derivedDecor = new Set(
    atlas.sprites.filter((s) => s.tileType === TileType.EMPTY).map((s) => s.imagePath),
  );

  const diff = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
    [...a].filter((f) => !b.has(f)).sort();

  it('OBJECT_VISUAL_FRAMES exactly equals the non-EMPTY (object-typed) imagePaths', () => {
    expect(diff(OBJECT_VISUAL_FRAMES, derivedDeny), 'constant has frames not object-typed').toEqual(
      [],
    );
    expect(
      diff(derivedDeny, OBJECT_VISUAL_FRAMES),
      'atlas object frames missing from constant',
    ).toEqual([]);
    expect(OBJECT_VISUAL_FRAMES.size).toBe(derivedDeny.size);
  });

  it('DECOR_BAKE_FRAMES exactly equals the EMPTY/decor-overlay imagePaths', () => {
    expect(diff(DECOR_BAKE_FRAMES, derivedDecor), 'constant has non-decor frames').toEqual([]);
    expect(
      diff(derivedDecor, DECOR_BAKE_FRAMES),
      'atlas decor frames missing from constant',
    ).toEqual([]);
    expect(DECOR_BAKE_FRAMES.size).toBe(derivedDecor.size);
  });

  it('the two partitions are disjoint and cover every atlas frame', () => {
    const intersection = [...OBJECT_VISUAL_FRAMES].filter((f) => DECOR_BAKE_FRAMES.has(f)).sort();
    expect(intersection, 'frames in BOTH deny and decor sets').toEqual([]);
    expect(OBJECT_VISUAL_FRAMES.size + DECOR_BAKE_FRAMES.size).toBe(atlas.sprites.length);
  });
});
