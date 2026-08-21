import { GRID } from '@sector-battle/shared';
import type { MapRenderer } from './MapRenderer.js';

/**
 * All world-sprite art lives in the `game` atlas (multipack). Frame keys are
 * bare asset names. Existence checks must test the *frame*, not the texture —
 * `textures.exists('crate')` is now always false (the texture key is `'game'`);
 * the frame is what varies per sprite.
 */
const GAME_ATLAS = 'game';

export class EntityTextureResolver {
  constructor(
    private scene: Phaser.Scene,
    private mapRenderer: MapRenderer | null,
  ) {}

  /** True if `frame` exists in the `game` atlas. */
  hasFrame(frame: string): boolean {
    return this.scene.textures.get(GAME_ATLAS).has(frame);
  }

  resolveAtlasTexture(
    x: number,
    y: number,
    fallbackKey: string,
  ): { textureKey: string; rotation: number } {
    if (!this.mapRenderer) return { textureKey: fallbackKey, rotation: 0 };
    const tileSize = GRID.TILE_SIZE;
    const gridX = Math.floor(x / tileSize);
    const gridY = Math.floor(y / tileSize);
    const visual = this.mapRenderer.getAtlasVisual(gridX, gridY, true);
    if (visual && visual.textureKey && this.hasFrame(visual.textureKey)) {
      return { textureKey: visual.textureKey, rotation: (visual.rotation * Math.PI) / 180 };
    }
    return { textureKey: fallbackKey, rotation: 0 };
  }

  resolveEntityVisual(
    x: number,
    y: number,
    serverTextureKey: string | undefined,
    fallbackKey: string,
  ): { textureKey: string; rotation: number } {
    const atlasResult = this.resolveAtlasTexture(x, y, fallbackKey);
    const textureKey =
      serverTextureKey && this.hasFrame(serverTextureKey)
        ? serverTextureKey
        : atlasResult.textureKey;
    const rotation = atlasResult.rotation;
    return { textureKey, rotation };
  }

  safeTexture(key: string, fallback: string): string {
    return this.hasFrame(key) ? key : fallback;
  }

  destructibleTexture(type: number): string {
    if (type === 0) return 'crate';
    if (type === 1) return 'barrel';
    if (type === 3) return 'wall_damaged';
    return 'crate_small';
  }

  trapTexture(type: number): string {
    if (type === 0) return 'trap_door';
    if (type === 1) return 'trapdoor_round';
    if (type === 2) return 'trapdoor_square';
    return 'trap';
  }
}
