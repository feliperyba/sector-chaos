/**
 * LightingAtmosphereTextures — procedurally generated per-SHAPE particle
 * textures (map-polish round 5c).
 *
 * Round 5b put every district's motes on ONE shared white circle, differing
 * only by pale tints — the owner verdict: "the same circle with the same
 * tone". 5c gives each district's emitter its own silhouette, drawn here at
 * boot into 16×16 textures (same canvas size as the shared circle so
 * `particleScaleForSize`'s Ø = size×2 math is unchanged for every shape).
 *
 * All shapes are WHITE — the per-emitter tint carries the district hue. The
 * shapes intentionally occupy different fractions of the 16×16 canvas (a
 * grain is elongated, a glint is a thin star): same nominal size, visibly
 * different silhouettes — the point of the ticket.
 *
 * Zero RNG, draw-once-at-construction, best-effort teardown — mirrors
 * `ensureAtmosphereParticleTexture`'s lifecycle exactly.
 */
import Phaser from 'phaser';
import type { SectorParticleShape } from './LightingAtmosphereThemes.js';

/** Stable texture keys per shape (all 16×16 white). */
export const SECTOR_SHAPE_TEXTURE_KEY: Readonly<Record<SectorParticleShape, string>> = {
  spark: '__atmoSpark',
  grain: '__atmoGrain',
  haze: '__atmoHaze',
  glint: '__atmoGlint',
};

/**
 * Draw one shape into a generated texture. Each case documents the fiction it
 * serves (see LightingAtmosphereThemes.SECTOR_ATMOSPHERE_THEMES).
 */
function drawShape(gfx: Phaser.GameObjects.Graphics, shape: SectorParticleShape): void {
  gfx.fillStyle(0xffffff, 1);
  switch (shape) {
    case 'spark':
      // Hard crisp dot — electric sparks (GRID_ARENA).
      gfx.fillCircle(8, 8, 5);
      break;
    case 'grain':
      // Elongated grain — drifting pollen (OPEN_ARENA).
      gfx.fillEllipse(8, 8, 11, 7);
      break;
    case 'haze':
      // Soft falloff blob — hanging ash haze (MAZE): concentric translucent
      // circles accumulate toward the center for a blurred edge.
      for (let r = 8; r >= 1; r--) {
        gfx.fillStyle(0xffffff, 0.22);
        gfx.fillCircle(8, 8, r);
      }
      break;
    case 'glint':
      // Four-point sparkle — treasure glints (RESOURCE_RICH): two diamonds
      // (vertical + horizontal) sharing a bright core bead. Round 5d: the
      // 2px-thin arms aliased to nothing at mote scales — arms widened to 3px
      // + the r2.5 bead carries visibility when the arms still drop out at the
      // far parallax band (a glint reads as a flash + bead, not thin lines).
      gfx.fillPoints(
        [
          new Phaser.Math.Vector2(8, 1),
          new Phaser.Math.Vector2(11, 8),
          new Phaser.Math.Vector2(8, 15),
          new Phaser.Math.Vector2(5, 8),
        ],
        true,
      );
      gfx.fillPoints(
        [
          new Phaser.Math.Vector2(1, 8),
          new Phaser.Math.Vector2(8, 11),
          new Phaser.Math.Vector2(15, 8),
          new Phaser.Math.Vector2(8, 5),
        ],
        true,
      );
      gfx.fillCircle(8, 8, 2.5);
      break;
  }
}

/**
 * Generate all four shape textures (idempotent — skips existing keys). Call
 * once when the sector emitters are first built (a sector grid arrived).
 */
export function ensureSectorParticleTextures(scene: Phaser.Scene): void {
  const shapes: SectorParticleShape[] = ['spark', 'grain', 'haze', 'glint'];
  for (const shape of shapes) {
    const key = SECTOR_SHAPE_TEXTURE_KEY[shape];
    if (scene.textures.exists(key)) continue;
    const gfx = scene.add.graphics();
    drawShape(gfx, shape);
    gfx.generateTexture(key, 16, 16);
    gfx.destroy();
  }
}

/** Remove the generated shape textures (best-effort shutdown). */
export function destroySectorParticleTextures(scene: Phaser.Scene): void {
  for (const key of Object.values(SECTOR_SHAPE_TEXTURE_KEY)) {
    if (scene.textures.exists(key)) scene.textures.remove(key);
  }
}
