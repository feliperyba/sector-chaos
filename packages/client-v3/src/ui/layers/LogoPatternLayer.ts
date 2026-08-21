import Phaser from 'phaser';

// ---------------------------------------------------------------------------
// LogoPatternLayer — tiled watermark with diagonal drift animation
// ---------------------------------------------------------------------------

/** Matches pixi-gamelab MenuConfig.layout.logoPattern */
const TILE_SCALE = 0.4;
const TILE_ALPHA = 0.12;
const TILE_ROTATION = Math.PI / 7; // ~25.7°
/** Approximate greyscale/desaturation (Phaser 4 has no ColorMatrixFilter) */
const TILE_TINT = 0x888888;

/** Matches pixi-gamelab MenuConfig.layout */
const DRIFT_SPEED = 0.015; // px per ms on X axis
const DRIFT_Y_FACTOR = 1.35; // Y speed relative to X

/**
 * Container that holds a single oversized TileSprite tiled with the
 * `watermark_doodle` atlas frame, rotated, tinted, and drifting diagonally.
 */
export class LogoPatternLayer extends Phaser.GameObjects.Container {
  private tileSprite: Phaser.GameObjects.TileSprite;

  constructor(
    scene: Phaser.Scene,
    textureKey: string,
    frame: string | undefined,
    width: number,
    height: number,
  ) {
    super(scene, 0, 0);

    // Oversize so the rotated tile still covers the viewport corners.
    const diag = Math.sqrt(width * width + height * height);
    const size = Math.ceil(diag * 1.2);

    this.tileSprite = scene.add.tileSprite(width / 2, height / 2, size, size, textureKey, frame);
    this.tileSprite.setTileScale(TILE_SCALE, TILE_SCALE);
    this.tileSprite.setAlpha(TILE_ALPHA);
    this.tileSprite.setRotation(TILE_ROTATION);
    this.tileSprite.setTint(TILE_TINT);

    this.add(this.tileSprite);
  }

  /** Advance the diagonal drift each frame. */
  updateDrift(_time: number, delta: number): void {
    const dx = DRIFT_SPEED * delta;
    const dy = dx * DRIFT_Y_FACTOR;
    this.tileSprite.tilePositionX += dx;
    this.tileSprite.tilePositionY -= dy;
  }

  /** Re-centre and resize on viewport change. */
  resize(width: number, height: number): void {
    const diag = Math.sqrt(width * width + height * height);
    const size = Math.ceil(diag * 1.2);
    this.tileSprite.setPosition(width / 2, height / 2);
    this.tileSprite.setSize(size, size);
  }
}
