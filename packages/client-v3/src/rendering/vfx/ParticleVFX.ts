import Phaser from 'phaser';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

interface BreakParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: number;
  startTime: number;
  duration: number;
}

interface TrapVfxEntry {
  type: number;
  x: number;
  y: number;
  startTime: number;
  duration: number;
}

interface TeleportFlashEntry {
  x: number;
  y: number;
  startTime: number;
  duration: number;
}

interface FireDotEntry {
  x: number;
  y: number;
}

/** `ParticleVFX.spawn` options — the Graphics-drawn particle variants. */
export type ParticleSpawnOptions =
  | { kind: 'trap'; trapType: number; x: number; y: number }
  | { kind: 'break'; x: number; y: number; type: number }
  | {
      kind: 'teleport';
      playerId: string;
      x: number;
      y: number;
      destX: number;
      destY: number;
    }
  | { kind: 'fire-dot'; playerId: string; active: boolean };

export class ParticleVFX implements VFXEffect<ParticleSpawnOptions> {
  readonly id = 'particle' as const;
  private scene: Phaser.Scene;
  private gfx: Phaser.GameObjects.Graphics;
  private breakParticles: BreakParticle[] = [];
  private trapVfx: TrapVfxEntry[] = [];
  private teleportVfx: TeleportFlashEntry[] = [];
  private fireDots = new Map<string, FireDotEntry>();

  constructor(scene: Phaser.Scene, _pool: SpritePool) {
    // `_pool`: the shared pool is injected into every effect for lifecycle
    // uniformity (ticket 52); this effect renders via a single Graphics object
    // and allocates no sprites, so the reference is intentionally unused.
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(17);
  }

  spawn(opts: ParticleSpawnOptions): void {
    switch (opts.kind) {
      case 'trap':
        this.triggerTrapVfx(opts.trapType, opts.x, opts.y);
        return;
      case 'break':
        this.triggerDestructibleBreak(opts.x, opts.y, opts.type);
        return;
      case 'teleport':
        this.triggerTeleportEffect(opts.playerId, opts.x, opts.y, opts.destX, opts.destY);
        return;
      case 'fire-dot':
        this.setPlayerFireDOT(opts.playerId, opts.active);
        return;
    }
  }

  private triggerDestructibleBreak(x: number, y: number, type: number): void {
    const now = performance.now();
    const configs: Record<
      number,
      {
        color: number;
        count: number;
        speed: number;
        size: number;
        duration: number;
        altColor?: number;
      }
    > = {
      0: { color: 0x8b6914, count: 5, speed: 120, size: 6, duration: 400 },
      1: { color: 0xff4400, count: 8, speed: 100, size: 6, duration: 400, altColor: 0xffaa33 },
      2: { color: 0x999999, count: 5, speed: 140, size: 4, duration: 400 },
      3: { color: 0x888888, count: 5, speed: 130, size: 6, duration: 400 },
    };
    const cfg = configs[type] ?? configs[0]!;
    for (let i = 0; i < cfg.count; i++) {
      const angle = (i / cfg.count) * Math.PI * 2 + Math.random() * 0.5;
      const speed = cfg.speed * (0.6 + Math.random() * 0.8);
      this.breakParticles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: cfg.size * (0.7 + Math.random() * 0.6),
        color: cfg.altColor && i % 2 === 0 ? cfg.altColor : cfg.color,
        startTime: now,
        duration: cfg.duration,
      });
    }
  }

  private triggerTrapVfx(trapType: number, x: number, y: number): void {
    const durations = [300, 500, 400];
    this.trapVfx.push({
      type: trapType,
      x,
      y,
      startTime: performance.now(),
      duration: durations[trapType] ?? 400,
    });
  }

  private triggerTeleportEffect(
    _playerId: string,
    x: number,
    y: number,
    destX: number,
    destY: number,
  ): void {
    const now = performance.now();
    this.teleportVfx.push({ x, y, startTime: now, duration: 400 });
    this.teleportVfx.push({ x: destX, y: destY, startTime: now, duration: 400 });
  }

  private setPlayerFireDOT(playerId: string, active: boolean): void {
    if (active) {
      if (!this.fireDots.has(playerId)) {
        this.fireDots.set(playerId, { x: 0, y: 0 });
      }
    } else {
      this.fireDots.delete(playerId);
    }
  }

  /**
   * Continuous per-frame sync (narrow interface extension, not a spawn): the
   * fire-DOT auras follow their players, so GameScene feeds current positions
   * every frame rather than re-spawning the effect.
   */
  updateFireDotPositions(positions: Map<string, { x: number; y: number }>): void {
    for (const [id, pos] of positions) {
      const entry = this.fireDots.get(id);
      if (entry) {
        entry.x = pos.x;
        entry.y = pos.y;
      }
    }
  }

  update(dt: number): void {
    const now = performance.now();
    this.gfx.clear();

    for (let i = this.breakParticles.length - 1; i >= 0; i--) {
      const p = this.breakParticles[i]!;
      const elapsed = now - p.startTime;
      if (elapsed > p.duration) {
        this.breakParticles.splice(i, 1);
        continue;
      }
      const step = dt / 1000;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.vy += 200 * step;
      const alpha = 1 - elapsed / p.duration;
      this.gfx.fillStyle(p.color, alpha);
      this.gfx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }

    for (let i = this.trapVfx.length - 1; i >= 0; i--) {
      const vfx = this.trapVfx[i]!;
      const elapsed = now - vfx.startTime;
      if (elapsed > vfx.duration) {
        this.trapVfx.splice(i, 1);
        continue;
      }
      const t = elapsed / vfx.duration;
      const alpha = 1 - t;

      if (vfx.type === 0) {
        const radius = 20 + t * 60;
        this.gfx.lineStyle(3, 0x8b4513, alpha);
        for (let a = 0; a < 8; a++) {
          const angle = (a / 8) * Math.PI * 2;
          this.gfx.lineBetween(
            vfx.x + Math.cos(angle) * 10,
            vfx.y + Math.sin(angle) * 10,
            vfx.x + Math.cos(angle) * radius,
            vfx.y + Math.sin(angle) * radius,
          );
        }
        this.gfx.fillStyle(0x8b4513, alpha * 0.3);
        this.gfx.fillCircle(vfx.x, vfx.y, radius * 0.5);
      } else if (vfx.type === 1) {
        const radius = 15 + t * 50;
        this.gfx.fillStyle(0xff4400, alpha * 0.5);
        this.gfx.fillCircle(vfx.x, vfx.y, radius);
        for (let p = 0; p < 6; p++) {
          const angle = (p / 6) * Math.PI * 2 + t * 2;
          const pr = 20 + t * 40;
          this.gfx.fillStyle(0xff8800, alpha * 0.7);
          this.gfx.fillCircle(
            vfx.x + Math.cos(angle) * pr,
            vfx.y + Math.sin(angle) * pr,
            6 * (1 - t),
          );
        }
      } else if (vfx.type === 2) {
        const radius = 10 + t * 60;
        this.gfx.lineStyle(3, 0x4488ff, alpha);
        this.gfx.strokeCircle(vfx.x, vfx.y, radius);
        this.gfx.lineStyle(2, 0xffffff, alpha * 0.5);
        this.gfx.strokeCircle(vfx.x, vfx.y, radius * 0.7);
      }
    }

    for (let i = this.teleportVfx.length - 1; i >= 0; i--) {
      const vfx = this.teleportVfx[i]!;
      const elapsed = now - vfx.startTime;
      if (elapsed > vfx.duration) {
        this.teleportVfx.splice(i, 1);
        continue;
      }
      const t = elapsed / vfx.duration;
      const alpha = 1 - t;
      const radius = 10 + t * 50;
      this.gfx.fillStyle(0xffffff, alpha * 0.6);
      this.gfx.fillCircle(vfx.x, vfx.y, radius);
      this.gfx.lineStyle(2, 0x4488ff, alpha * 0.8);
      this.gfx.strokeCircle(vfx.x, vfx.y, radius * 1.3);
    }

    for (const entry of this.fireDots.values()) {
      const bob = Math.sin(now / 200) * 3;
      const auraAlpha = 0.3 + 0.1 * Math.sin(now / 300);
      this.gfx.fillStyle(0xff4400, auraAlpha);
      this.gfx.fillCircle(entry.x, entry.y + bob, 40);
      for (let p = 0; p < 4; p++) {
        const angle = (p / 4) * Math.PI * 2 + now / 500;
        const pr = 25 + Math.sin(now / 150 + p) * 10;
        this.gfx.fillStyle(0xff8800, 0.4);
        this.gfx.fillCircle(
          entry.x + Math.cos(angle) * pr,
          entry.y + bob + Math.sin(angle) * pr,
          5,
        );
      }
    }
  }

  /** Drop every in-flight particle/aura; the Graphics object stays usable. */
  clear(): void {
    this.breakParticles.length = 0;
    this.trapVfx.length = 0;
    this.teleportVfx.length = 0;
    this.fireDots.clear();
  }

  destroy(): void {
    this.clear();
    this.gfx.destroy();
  }
}
