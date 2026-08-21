import Phaser from 'phaser';
import type { MapRenderer } from '../MapRenderer.js';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

/** Dust puffs are frames in the `vfx` multipack atlas. */
const VFX_ATLAS = 'vfx';
const DUST_FRAMES = ['dirt_01', 'dirt_02', 'dirt_03'];
/** The falling coffin is a frame in the `game` multipack atlas. */
const GAME_ATLAS = 'game';
const COFFIN_FRAME = 'coffin';

/**
 * `SiegeVFX.spawn` options. Siege is genuinely two-phase (guardrail: a narrow
 * discriminated union, not a special-case bypass): the zone-siege cascade
 * first WARNINGS a tile (pending solidification), then either CONFIRMS the
 * wall drop or lets the warning expire; dust puffs also fire standalone when
 * a destructible is removed by siege damage.
 */
export type SiegeSpawnOptions =
  | { kind: 'warning'; gridX: number; gridY: number; solidifyAt: number }
  | { kind: 'confirm'; gridX: number; gridY: number; mapRenderer: MapRenderer | null }
  | { kind: 'dust'; x: number; y: number };

export class SiegeVFX implements VFXEffect<SiegeSpawnOptions> {
  readonly id = 'siege' as const;
  private scene: Phaser.Scene;
  private readonly tileSize: number;
  private readonly pool: SpritePool;
  private warnings = new Map<string, { rect: Phaser.GameObjects.Rectangle; expiresAt: number }>();
  private coffinSprites: Phaser.GameObjects.Sprite[] = [];
  private dustSprites: Phaser.GameObjects.Sprite[] = [];

  constructor(scene: Phaser.Scene, pool: SpritePool, tileSize: number) {
    this.scene = scene;
    this.pool = pool;
    this.tileSize = tileSize;
  }

  spawn(opts: SiegeSpawnOptions): void {
    switch (opts.kind) {
      case 'warning':
        this.addWarning(opts.gridX, opts.gridY, opts.solidifyAt);
        return;
      case 'confirm':
        this.confirmWall(opts.gridX, opts.gridY, opts.mapRenderer);
        return;
      case 'dust':
        this.spawnDustCloud(opts.x, opts.y);
        return;
    }
  }

  private addWarning(gridX: number, gridY: number, solidifyAt: number): void {
    const key = `${gridX},${gridY}`;
    const existing = this.warnings.get(key);
    if (existing) {
      existing.rect.destroy();
      this.warnings.delete(key);
    }
    // Warnings are Rectangle SHAPES, not sprites — outside the SpritePool's
    // domain (ticket 52 pools sprites only); they are destroyed on expiry
    // exactly as before.
    const rect = this.scene.add
      .rectangle(
        gridX * this.tileSize + this.tileSize / 2,
        gridY * this.tileSize + this.tileSize / 2,
        this.tileSize,
        this.tileSize,
        0xff4444,
        0.5,
      )
      .setDepth(6);
    this.warnings.set(key, { rect, expiresAt: solidifyAt });
  }

  private confirmWall(gridX: number, gridY: number, mapRenderer: MapRenderer | null): void {
    const key = `${gridX},${gridY}`;
    const warning = this.warnings.get(key);
    if (warning) {
      warning.rect.destroy();
      this.warnings.delete(key);
    }
    const targetX = gridX * this.tileSize + this.tileSize / 2;
    const targetY = gridY * this.tileSize + this.tileSize / 2;
    // Pool discipline (ticket 52): the coffin sprite comes from the shared
    // pool instead of a direct scene allocation; it disappears at the exact
    // same instant as before (release kills both tweens + hides the sprite —
    // visually identical to the old killTweensOf+destroy).
    const coffin = this.pool
      .acquire(GAME_ATLAS, COFFIN_FRAME, targetX, targetY - 600)
      .setOrigin(0.5)
      .setDisplaySize(this.tileSize, this.tileSize)
      .setDepth(25)
      // Map-redesign ticket 07: the falling coffin tints with the district it
      // lands in (matching the wall it becomes via setSiegeWallWithTexture).
      .setTint(mapRenderer ? mapRenderer.wallTintAtTile(gridX, gridY) : 0xbbbbcc);
    this.coffinSprites.push(coffin);
    this.scene.tweens.add({
      targets: coffin,
      y: targetY,
      duration: 400,
      ease: Phaser.Math.Easing.Quadratic.In,
      onComplete: () => {
        this.spawnDustCloud(targetX, targetY);
        if (mapRenderer) {
          mapRenderer.setSiegeWallWithTexture(gridX, gridY, 'coffin');
        }
        this.pool.release(coffin);
        const idx = this.coffinSprites.indexOf(coffin);
        if (idx >= 0) this.coffinSprites.splice(idx, 1);
      },
    });
    this.scene.tweens.add({
      targets: coffin,
      rotation: 0.08,
      duration: 67,
      yoyo: true,
      repeat: 5,
      ease: Phaser.Math.Easing.Sine.InOut,
    });
  }

  private spawnDustCloud(x: number, y: number): void {
    const vfxTexture = this.scene.textures.get(VFX_ATLAS);
    for (let i = 0; i < 7; i++) {
      const frame = DUST_FRAMES[Math.floor(Math.random() * DUST_FRAMES.length)]!;
      if (!vfxTexture.has(frame)) continue;
      const offsetX = (Math.random() - 0.5) * 20;
      const offsetY = (Math.random() - 0.5) * 20;
      // Dust puffs render ~256px → expanding to ~410px at peak (preserved from the
      // original 512×512 source × scale 0.5→0.8). setDisplaySize is resolution-
      // independent, so it stays correct now that the source is 64×64.
      const DUST_BASE_PX = 256;
      const DUST_PEAK_PX = 410;
      const sprite = this.pool
        .acquire(VFX_ATLAS, frame, x + offsetX, y + offsetY)
        .setOrigin(0.5)
        .setDisplaySize(DUST_BASE_PX, DUST_BASE_PX)
        .setDepth(6)
        .setAlpha(0.7);
      const angle = Math.random() * Math.PI * 2;
      const dist = 25 * (0.5 + Math.random());
      this.dustSprites.push(sprite);
      this.scene.tweens.add({
        targets: sprite,
        x: sprite.x + Math.cos(angle) * dist,
        y: sprite.y + Math.sin(angle) * dist,
        displayWidth: DUST_PEAK_PX,
        displayHeight: DUST_PEAK_PX,
        alpha: 0,
        duration: 500,
        onComplete: () => {
          if (sprite.active) this.pool.release(sprite);
          const idx = this.dustSprites.indexOf(sprite);
          if (idx >= 0) this.dustSprites.splice(idx, 1);
        },
      });
    }
  }

  update(_dt: number): void {
    const now = performance.now();
    for (const [key, warning] of this.warnings) {
      if (now >= warning.expiresAt) {
        warning.rect.destroy();
        this.warnings.delete(key);
      }
    }
    for (let i = this.dustSprites.length - 1; i >= 0; i--) {
      const s = this.dustSprites[i]!;
      if (!s.active) {
        this.dustSprites.splice(i, 1);
      }
    }
  }

  /** Release every warning/coffin/dust visual now; the effect stays usable. */
  clear(): void {
    for (const warning of this.warnings.values()) {
      warning.rect.destroy();
    }
    this.warnings.clear();
    for (const s of this.dustSprites) {
      if (s.active) this.pool.release(s);
    }
    this.dustSprites.length = 0;
    for (const c of this.coffinSprites) {
      if (c.active) this.pool.release(c);
    }
    this.coffinSprites.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}
