import Phaser from 'phaser';
import type { AttackCategory } from '@sector-battle/shared';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';

const MAX_CONCURRENT = 8;
const DEFAULT_TRAIL_WIDTH = 4;
/** Trail covers the outer portion of the blade (tip-weighted). */
const TRAIL_BLADE_START = 0.35;

const CATEGORY_TINTS: Record<AttackCategory, number> = {
  arc: 0xffaa00,
  line: 0xffffff,
  fists: 0xccddff,
  ranged: 0xcccccc,
  shield: 0x4488ff,
  thrown: 0xff8800,
};

interface GhostFrame {
  /** Blade segment at capture time — the trail paints the swept hitbox. */
  gripX: number;
  gripY: number;
  tipX: number;
  tipY: number;
  time: number;
}

/**
 * Per-player weapon-trail capture state. Owned by the player's
 * `PlayerRenderBundle` (`bundle.trail`): the bundle's teardown nulls the field
 * and unregisters the object here, so a trail can never outlive its player
 * (the old player-keyed map in this class could drift out of sync with the
 * player visual maps — the "ghost" leak class this renderer belonged to).
 */
export interface TrailData {
  ghosts: GhostFrame[];
  ghostCount: number;
  fadeMs: number;
  baseOpacity: number;
  tint: number;
  width: number;
  capturing: boolean;
}

/** Start-order registry entry (drives MAX_CONCURRENT eviction + draw order). */
interface TrailRegistryEntry {
  trail: TrailData;
  bundle: PlayerRenderBundle;
}

export class WeaponTrailRenderer {
  /**
   * Active trails in START order. NOT keyed by player — the per-player state
   * lives on `bundle.trail`; this list only preserves the historical
   * insertion-order semantics (oldest-first eviction at the MAX_CONCURRENT cap
   * and first-started-first-drawn render order).
   */
  private active: TrailRegistryEntry[] = [];
  private gfx: Phaser.GameObjects.Graphics;
  private cameraCenterX = 0;
  private cameraCenterY = 0;
  private cullDistanceSq = 400 * 400;

  constructor(scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setDepth(19);
  }

  setCameraCenter(cx: number, cy: number): void {
    this.cameraCenterX = cx;
    this.cameraCenterY = cy;
  }

  startTrail(
    bundle: PlayerRenderBundle,
    ghostCount: number,
    fadeMs: number,
    baseOpacity: number,
    category: AttackCategory,
    width: number = DEFAULT_TRAIL_WIDTH,
  ): void {
    const existingIdx = this.active.findIndex((e) => e.bundle === bundle);
    if (this.active.length >= MAX_CONCURRENT && existingIdx < 0) {
      // At capacity and this player has no trail yet — forget the OLDEST trail
      // (start order). Null the owner's field too so its captureFrame/stopTrail
      // become no-ops, exactly like the old map delete did.
      const oldest = this.active.shift()!;
      if (oldest.bundle.trail === oldest.trail) oldest.bundle.trail = null;
    }
    const trail: TrailData = {
      ghosts: [],
      ghostCount,
      fadeMs,
      baseOpacity,
      tint: CATEGORY_TINTS[category] ?? 0xffffff,
      width,
      capturing: true,
    };
    bundle.trail = trail;
    if (existingIdx >= 0) {
      // Re-start for a player that already has a trail: replace the data but
      // keep the registry position (Map.set on an existing key preserved
      // insertion order).
      this.active[existingIdx]!.trail = trail;
    } else {
      this.active.push({ trail, bundle });
    }
  }

  captureFrame(
    bundle: PlayerRenderBundle,
    gripX: number,
    gripY: number,
    tipX: number,
    tipY: number,
  ): void {
    const trail = bundle.trail;
    if (!trail || !trail.capturing) return;
    trail.ghosts.push({ gripX, gripY, tipX, tipY, time: performance.now() });
    while (trail.ghosts.length > trail.ghostCount) {
      trail.ghosts.shift();
    }
  }

  stopTrail(bundle: PlayerRenderBundle): void {
    const trail = bundle.trail;
    if (trail) trail.capturing = false;
  }

  render(now: number): void {
    this.gfx.clear();
    const active = this.active;
    let write = 0;
    for (let read = 0; read < active.length; read++) {
      const entry = active[read]!;
      const trail = entry.trail;
      let keep = true;
      if (trail.ghosts.length === 0) {
        if (!trail.capturing) keep = false;
      } else {
        let anyVisible = false;
        for (const ghost of trail.ghosts) {
          const dx = ghost.tipX - this.cameraCenterX;
          const dy = ghost.tipY - this.cameraCenterY;
          if (dx * dx + dy * dy < this.cullDistanceSq) {
            anyVisible = true;
            break;
          }
        }
        if (anyVisible) {
          const allExpired = this.renderTrail(trail, now);
          if (allExpired && !trail.capturing) keep = false;
        }
      }
      if (keep) {
        active[write] = entry;
        write++;
      } else {
        // Expired/empty + stopped: forget the trail entirely (same as the old
        // map delete — the owner's later captureFrame/stopTrail are no-ops).
        entry.bundle.trail = null;
      }
    }
    active.length = write;
  }

  private renderTrail(trail: TrailData, now: number): boolean {
    let allExpired = true;
    const len = trail.ghosts.length;
    for (let i = 0; i < len; i++) {
      const ghost = trail.ghosts[i]!;
      const age = now - ghost.time;
      if (age > trail.fadeMs) continue;
      allExpired = false;
      const t = 1 - age / trail.fadeMs;
      const alpha = trail.baseOpacity * t * (i / len);
      if (alpha < 0.01) continue;

      // Draw the outer portion of the captured blade segment — the trail is
      // a ghost of the actual swept hitbox, not a fixed-size decal.
      const sx = ghost.gripX + (ghost.tipX - ghost.gripX) * TRAIL_BLADE_START;
      const sy = ghost.gripY + (ghost.tipY - ghost.gripY) * TRAIL_BLADE_START;
      this.gfx.lineStyle(trail.width, trail.tint, alpha);
      this.gfx.lineBetween(sx, sy, ghost.tipX, ghost.tipY);
    }
    return allExpired;
  }

  /** Unregister + drop a bundle's trail (single-owner teardown path). */
  removeTrail(bundle: PlayerRenderBundle): void {
    const trail = bundle.trail;
    if (!trail) return;
    bundle.trail = null;
    const idx = this.active.findIndex((e) => e.trail === trail);
    if (idx >= 0) this.active.splice(idx, 1);
  }

  destroy(): void {
    this.active.length = 0;
    this.gfx.destroy();
  }
}
