import Phaser from 'phaser';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

interface Point {
  x: number;
  y: number;
}

interface ShatterFragment {
  sprite: Phaser.GameObjects.Sprite;
  /**
   * Texture-manager key of this fragment's cropped canvas. Each fragment gets
   * a freshly-minted unique key (see createFragmentTextureKey), so freeing it
   * on expiry can never pull a texture out from under another live sprite.
   */
  textureKey: string;
  /**
   * The `game`-atlas frame the sprite's pool slot was acquired under. The
   * fragment swaps in its unique canvas texture after acquire; expiry must
   * restore this frame BEFORE pool release so the slot files back under the
   * 'game' bucket (SpritePool buckets by the sprite's current texture).
   */
  poolFrame: string;
  vx: number;
  vy: number;
  angularVel: number;
  startTime: number;
  duration: number;
}

interface SparkParticle {
  sprite: Phaser.GameObjects.Sprite;
  vx: number;
  vy: number;
  startTime: number;
  duration: number;
}

function clipPolygonByBisector(polygon: Point[], p1: Point, p2: Point): Point[] {
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const result: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const curr = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const currSide = (curr.x - midX) * dx + (curr.y - midY) * dy;
    const nextSide = (next.x - midX) * dx + (next.y - midY) * dy;
    if (currSide <= 0) result.push(curr);
    if (currSide <= 0 !== nextSide <= 0) {
      const t = currSide / (currSide - nextSide);
      result.push({ x: curr.x + t * (next.x - curr.x), y: curr.y + t * (next.y - curr.y) });
    }
  }
  return result;
}

function generateVoronoiCells(w: number, h: number, seedCount: number): Point[][] {
  const seeds: Point[] = [];
  const margin = Math.min(w, h) * 0.15;
  for (let i = 0; i < seedCount; i++) {
    seeds.push({
      x: margin + Math.random() * (w - margin * 2),
      y: margin + Math.random() * (h - margin * 2),
    });
  }

  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];

  const cells: Point[][] = [];
  for (let i = 0; i < seeds.length; i++) {
    let polygon = [...rect];
    for (let j = 0; j < seeds.length; j++) {
      if (i === j) continue;
      polygon = clipPolygonByBisector(polygon, seeds[i]!, seeds[j]!);
      if (polygon.length < 3) break;
    }
    if (polygon.length >= 3) {
      cells.push(polygon);
    }
  }
  return cells;
}

function polygonCenter(polygon: Point[]): Point {
  let cx = 0;
  let cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / polygon.length, y: cy / polygon.length };
}

function createFragmentTextureKey(
  scene: Phaser.Scene,
  sourceFrame: Phaser.Textures.Frame,
  polygon: Point[],
  uid: number,
): string | null {
  const sourceImage = sourceFrame.texture.getSourceImage();
  if (!sourceImage) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.beginPath();
  const first = polygon[0]!;
  ctx.moveTo(first.x - minX, first.y - minY);
  for (let i = 1; i < polygon.length; i++) {
    const pt = polygon[i]!;
    ctx.lineTo(pt.x - minX, pt.y - minY);
  }
  ctx.closePath();
  ctx.clip();
  // The weapon art is a frame inside the `game` multipack atlas, so the source
  // image is the whole atlas PNG. Source-crop to just this frame's cut region
  // (cutX/Y/Width/Height in atlas pixels) before blitting — otherwise the
  // entire spritesheet leaks into every fragment.
  ctx.drawImage(
    sourceImage as HTMLImageElement,
    sourceFrame.cutX,
    sourceFrame.cutY,
    sourceFrame.cutWidth,
    sourceFrame.cutHeight,
    -minX,
    -minY,
    sourceFrame.cutWidth,
    sourceFrame.cutHeight,
  );

  const key = `__shatter_${uid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  scene.textures.addCanvas(key, canvas);
  return key;
}

/** Spark/star frames live in the `vfx` multipack atlas. */
const VFX_ATLAS = 'vfx';
/** Weapon frames (and the pool buckets for fragment sprites) live in `game`. */
const GAME_ATLAS = 'game';
const SPARK_FRAMES = ['spark_02', 'spark_03', 'spark_04', 'star_01'];

const SPARK_TINTS = [0xffdd44, 0xff8844, 0xffffff, 0xffaa22, 0xffcc66, 0xff6622];

/** `WeaponShatterVFX.spawn` options — one weapon-break. */
export interface WeaponShatterSpawnOptions {
  x: number;
  y: number;
  /** Frame name in the `game` atlas (e.g. 'weapon_sword'). */
  textureKey: string;
  facingAngle: number;
  tint: number;
  weaponScale: number;
}

export class WeaponShatterVFX implements VFXEffect<WeaponShatterSpawnOptions> {
  readonly id = 'weapon-shatter' as const;
  private scene: Phaser.Scene;
  private readonly pool: SpritePool;
  private fragments: ShatterFragment[] = [];
  private sparks: SparkParticle[] = [];
  private textureKeys: string[] = [];

  constructor(scene: Phaser.Scene, pool: SpritePool) {
    this.scene = scene;
    this.pool = pool;
  }

  spawn(opts: WeaponShatterSpawnOptions): void {
    const { x, y, textureKey, facingAngle, tint, weaponScale } = opts;
    // `textureKey` is a frame name in the `game` atlas (e.g. 'weapon_sword').
    const gameTexture = this.scene.textures.get(GAME_ATLAS);
    if (!gameTexture.has(textureKey)) return;

    const frame = gameTexture.get(textureKey);
    if (!frame) return;

    const tw = frame.width;
    const th = frame.height;

    const seedCount = 3 + Math.floor(Math.random() * 2);
    const cells = generateVoronoiCells(tw, th, seedCount);
    if (cells.length === 0) return;

    const now = performance.now();
    const cosA = Math.cos(facingAngle);
    const sinA = Math.sin(facingAngle);

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (cell.length < 3) continue;

      const center = polygonCenter(cell);

      const fragKey = createFragmentTextureKey(this.scene, frame, cell, i);
      if (!fragKey) continue;
      this.textureKeys.push(fragKey);

      // Pool discipline (ticket 52): the fragment SPRITE comes from the shared
      // pool (acquired under its source atlas frame), while the canvas TEXTURE
      // cannot pool — it is a unique Voronoi crop, minted here and freed on
      // expiry (the ticket-46 discipline). The unique crop is swapped in after
      // acquire; expiry restores the atlas frame before release.
      const fragmentSprite = this.pool.acquire(GAME_ATLAS, textureKey, 0, 0);
      fragmentSprite.setTexture(fragKey);
      fragmentSprite.setOrigin(0.5, 0.5);
      fragmentSprite.setScale(weaponScale);
      fragmentSprite.setDepth(15);
      if (tint !== 0xffffff) {
        fragmentSprite.setTint(tint);
      }

      const offsetX = center.x - tw / 2;
      const offsetY = center.y - th / 2;
      fragmentSprite.setPosition(
        x + (offsetX * cosA - offsetY * sinA) * weaponScale,
        y + (offsetX * sinA + offsetY * cosA) * weaponScale,
      );
      fragmentSprite.setRotation(facingAngle);

      const radialAngle = Math.atan2(offsetY, offsetX);
      const speed = (100 + Math.random() * 80) * (0.7 + Math.random() * 0.6);
      const worldAngle = radialAngle + facingAngle;

      this.fragments.push({
        sprite: fragmentSprite,
        textureKey: fragKey,
        poolFrame: textureKey,
        vx: Math.cos(worldAngle) * speed,
        vy: Math.sin(worldAngle) * speed,
        angularVel: (Math.random() * 2 - 1) * (3 + Math.random() * 5),
        startTime: now,
        duration: 600 + Math.random() * 200,
      });
    }

    // Spark particles using actual spark/star frames (64×64, scaled up)
    const vfxTexture = this.scene.textures.get(VFX_ATLAS);
    const sparkCount = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < sparkCount; i++) {
      const angle = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.8;
      const speed = 120 + Math.random() * 160;
      const frame = SPARK_FRAMES[Math.floor(Math.random() * SPARK_FRAMES.length)]!;
      if (!vfxTexture.has(frame)) continue;
      const sparkTint = SPARK_TINTS[Math.floor(Math.random() * SPARK_TINTS.length)]!;
      // 64×64 source → display ~16-40px (scale ~0.25-0.625)
      const displaySize = 16 + Math.random() * 24;
      const scale = displaySize / 64;

      const sprite = this.pool.acquire(VFX_ATLAS, frame, x, y);
      sprite.setOrigin(0.5, 0.5);
      sprite.setScale(scale);
      sprite.setTint(sparkTint);
      sprite.setDepth(16);
      sprite.setRotation(Math.random() * Math.PI * 2);

      this.sparks.push({
        sprite,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        startTime: now,
        duration: 400 + Math.random() * 300,
      });
    }
  }

  update(dt: number): void {
    const now = performance.now();
    const step = dt / 1000;

    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i]!;
      const elapsed = now - f.startTime;
      if (elapsed > f.duration) {
        this.releaseFragment(f);
        this.fragments.splice(i, 1);
        continue;
      }

      f.sprite.x += f.vx * step;
      f.sprite.y += f.vy * step;
      f.vy += 200 * step;
      f.sprite.rotation += f.angularVel * step;
      f.sprite.setAlpha(1 - elapsed / f.duration);
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      const elapsed = now - s.startTime;
      if (elapsed > s.duration) {
        this.pool.release(s.sprite);
        this.sparks.splice(i, 1);
        continue;
      }

      const progress = elapsed / s.duration;
      s.sprite.x += s.vx * step;
      s.sprite.y += s.vy * step;
      s.vy += 150 * step;
      s.sprite.setAlpha(1 - progress);
      s.sprite.setScale(s.sprite.scaleX * (1 - progress * 0.5 * step * 3));
      s.sprite.rotation += 4 * step;
    }
  }

  /**
   * Free a fragment's canvas texture once its sprite is gone. Without this the
   * texture manager grows by one entry per Voronoi fragment per weapon break
   * for the whole match — textures were only freed at scene shutdown.
   *
   * The `exists()` guard makes a double remove a silent no-op instead of a
   * `console.warn('No texture found matching key: ...')` from Phaser (e.g. the
   * key was already released at expiry, or removed externally). The key is
   * also dropped from `textureKeys` so the shutdown sweep only ever sees keys
   * of fragments that are still in flight.
   */
  private releaseFragmentTexture(key: string): void {
    if (this.scene.textures.exists(key)) {
      this.scene.textures.remove(key);
    }
    const idx = this.textureKeys.indexOf(key);
    if (idx !== -1) {
      this.textureKeys.splice(idx, 1);
    }
  }

  /**
   * Expire one fragment: return its sprite to the pool (restoring the atlas
   * frame first so the slot files back under the 'game' bucket) and free the
   * unique canvas texture (ticket 46). Order matters — the texture is only
   * removed after no sprite references it.
   */
  private releaseFragment(f: ShatterFragment): void {
    f.sprite.setTexture(GAME_ATLAS, f.poolFrame);
    this.pool.release(f.sprite);
    this.releaseFragmentTexture(f.textureKey);
  }

  /** Release every in-flight fragment/spark and free their textures. */
  clear(): void {
    // Reverse iteration: releaseFragment splices `textureKeys`, and reversing
    // keeps the index math valid for both arrays.
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      this.releaseFragment(this.fragments[i]!);
    }
    this.fragments.length = 0;

    for (const s of this.sparks) {
      this.pool.release(s.sprite);
    }
    this.sparks.length = 0;
  }

  destroy(): void {
    this.clear();
  }
}
