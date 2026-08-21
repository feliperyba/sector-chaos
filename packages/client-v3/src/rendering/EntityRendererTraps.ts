/**
 * Trap rendering — add, update, remove for spike/fire/teleport traps.
 * Extracted from EntityRendererLifecycle for single-responsibility.
 */
import Phaser from 'phaser';
import { GRID } from '@sector-battle/shared';
import type { TrapState } from '../types.js';
import {
  type EntityVisual,
  type EntityVisualMap,
  createEntitySprite,
  hasEntitySprite,
} from './EntityTypes.js';
import type { EntityTextureResolver } from './EntityTextureResolver.js';

function drawFireArea(gfx: Phaser.GameObjects.Graphics, cx: number, cy: number): void {
  const tileSize = GRID.TILE_SIZE;
  const gridX = Math.floor(cx / tileSize);
  const gridY = Math.floor(cy / tileSize);
  const pulse = 0.3 + Math.sin(performance.now() / 200) * 0.15;
  gfx.fillStyle(0xff4400, pulse);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      gfx.fillRect((gridX + dx) * tileSize, (gridY + dy) * tileSize, tileSize, tileSize);
    }
  }
}

export function addTrap(
  entities: EntityVisualMap,
  scene: Phaser.Scene,
  resolver: EntityTextureResolver,
  key: string,
  t: TrapState,
): void {
  if (entities.has(key)) return;
  if (!t.isRevealed) return;
  const fallback = resolver.trapTexture(t.type);
  const { textureKey } = resolver.resolveEntityVisual(t.x, t.y, t.textureKey, fallback);
  const actualKey = resolver.safeTexture(textureKey, fallback);
  const sprite = createEntitySprite(scene, t.x, t.y, actualKey, {
    rotation: t.rotation,
    flipH: t.flipH,
    flipV: t.flipV,
    depth: 4,
  });
  if (!sprite) return;
  const entry: EntityVisual = { sprite, type: 'trap', active: t.fireAreaActive };
  if (t.type === 1) {
    const gfx = scene.add.graphics().setDepth(3);
    entry.fireAreaGraphics = gfx;
    if (t.fireAreaActive) {
      drawFireArea(gfx, t.x, t.y);
    }
  }
  entities.set(key, entry);
}

export function updateTrap(
  entities: EntityVisualMap,
  scene: Phaser.Scene,
  resolver: EntityTextureResolver,
  key: string,
  t: TrapState,
): void {
  const e = entities.get(key);
  if (!e && t.isRevealed) {
    addTrap(entities, scene, resolver, key, t);
    return;
  }
  // Trap keys only ever hold trap entries (which always carry a sprite);
  // explosion records never reach this lookup. hasEntitySprite narrows.
  if (hasEntitySprite(e)) {
    if (!t.isRevealed) e.sprite.setVisible(false);
    if (t.isRevealed) e.sprite.setVisible(true);
    if (t.type === 1) {
      const wasActive = e.active ?? false;
      e.active = t.fireAreaActive;
      if (e.fireAreaGraphics && !t.fireAreaActive) {
        e.fireAreaGraphics.clear();
        // Nothing left to redraw — drop any pending state-change flag.
        e.fireAreaDirty = false;
      } else if (e.fireAreaGraphics && !wasActive) {
        // Arm → fire (perf ticket 19): request the one-shot rebuild. The
        // per-frame loop's gate redraws a dirty trap exactly once even while
        // off-screen (mirroring addTrap's creation-time draw, keeping the
        // Graphics content in sync with state) and then goes silent; on-screen
        // the flag is redundant — the per-frame pulse redraw covers the same
        // frame it always did.
        e.fireAreaDirty = true;
      }
    }
  }
}

/**
 * Redraw fire-area overlay for a single trap entity. The CALLER (the
 * lifecycle per-frame loop) gates this on view cull + `fireAreaDirty`
 * (perf ticket 19) — on-screen it runs every frame for the alpha pulse,
 * off-screen only once per arm → fire transition.
 */
export function redrawFireArea(e: EntityVisual): void {
  if (e.fireAreaGraphics && e.active) {
    e.fireAreaGraphics.clear();
    drawFireArea(e.fireAreaGraphics, e.sprite.x, e.sprite.y);
  }
}

/** Apply spike-flash tint and record the flash timestamp. */
export function triggerSpikeFlash(entities: EntityVisualMap, key: string): void {
  const e = entities.get(key);
  if (e && e.type === 'trap') {
    e.flashTime = performance.now();
    const sprite = e.sprite as Phaser.GameObjects.Sprite;
    sprite.setTint(0xffffff);
  }
}

/** Check if a trap's flash has expired and clear it. */
export function tickTrapFlash(e: EntityVisual, now: number): void {
  if (e.flashTime != null) {
    const elapsed = now - e.flashTime;
    if (elapsed > 200) {
      (e.sprite as Phaser.GameObjects.Sprite).clearTint();
      e.flashTime = undefined;
    }
  }
}
