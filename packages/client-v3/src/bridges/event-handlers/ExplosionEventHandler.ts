import Phaser from 'phaser';
import type { ExplosionChannelMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';
import type { ExplosionLightRegistry } from '../../rendering/lighting/ExplosionLightRegistry.js';
import {
  hash2,
  finalizeHash,
  flickerSeedFromHash,
} from '../../rendering/lighting/LightingHash.js';

export class ExplosionEventHandler {
  constructor(
    private readonly localPos: { x: number; y: number },
    private readonly audio: AudioService,
    private readonly cameraService: CameraService,
    private readonly entityRenderer: EntityRenderer,
    private readonly mapRenderer: MapRenderer,
    private readonly scene: Phaser.Scene,
    /**
     * Optional explosion-light registry (ticket 11). When present, a brief hot
     * fire-palette light is registered on every BarrelExploded/explosion event
     * so the deferred pipeline flashes the blast. Cosmetic-only. Optional so
     * existing tests/constructors that don't care about lighting keep working.
     */
    private readonly explosionLights?: ExplosionLightRegistry,
  ) {}

  handle(data: ExplosionChannelMessage): void {
    if (data.eventType === 'DestructibleRespawned') return;
    if (data.x != null && data.y != null) {
      const dx = data.x - this.localPos.x;
      const dy = data.y - this.localPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const shakeDist = 600;
      if (dist < shakeDist) {
        const intensity = 8 * (1 - dist / shakeDist);
        this.cameraService.shake(intensity, 400);
      }
      const flashDist = 300;
      if (dist < flashDist) {
        const alpha = 0.4 * (1 - dist / flashDist);
        const cam = this.scene.cameras.main;
        const flash = this.scene.add
          .rectangle(
            cam.worldView.x + cam.worldView.width / 2,
            cam.worldView.y + cam.worldView.height / 2,
            cam.worldView.width,
            cam.worldView.height,
            0xffffff,
            alpha,
          )
          .setDepth(100)
          .setScrollFactor(0);
        this.scene.tweens.add({
          targets: flash,
          alpha: 0,
          duration: 150,
          onComplete: () => {
            flash.destroy();
          },
        });
      }
    }
    this.audio.playAt('barrel_explode', data.x ?? 0, data.y ?? 0, 0.5, 'loud');
    if (data.gridX != null && data.gridY != null) {
      this.mapRenderer.clearGridCell(data.gridX, data.gridY);
    }
    if (data.x != null && data.y != null && data.destructibleType != null) {
      this.entityRenderer.triggerDestructibleBreak(
        data.x,
        data.y,
        data.destructibleType as unknown as number,
      );
      this.entityRenderer.spawnDustCloud(data.x, data.y);
    }
    // Ticket 18 — tightened light attribution. A fire explosion light is
    // registered ONLY on BarrelExploded events. Per the user's ruling ("only
    // the explosions create them, together with any fire source like fire
    // traps"), static barrels are inert and a crate break
    // (DestructibleDestroyed) is NOT a fire event — crates are plain wood, so
    // they produce no light at all (decided: skip entirely rather than emit a
    // cool dust flash, to keep the explosion-light path unambiguous and
    // lowest-risk). The barrel explosion flash remains the sole
    // destructible fire-attribution; it scales radius + intensity from the
    // authoritative blast radius carried on BarrelExploded. Cosmetic-only.
    if (
      this.explosionLights &&
      data.eventType === 'BarrelExploded' &&
      data.x != null &&
      data.y != null
    ) {
      // Deterministic per-explosion flicker seed derived from position + tick so
      // concurrent flashes don't strobe in unison (cheap stable hash).
      const seed = explosionFlickerSeed(data.x, data.y, data.tick ?? 0);
      this.explosionLights.register(data.x, data.y, data.radius, performance.now(), seed);
    }
  }
}

/**
 * Deterministic per-explosion flicker seed (stable hash of position + tick).
 * Pure — same inputs → same seed → same flicker phase. Used so concurrent
 * explosions (a barrel chain) don't all strobe in lockstep; each gets a
 * distinct phase derived from its unique position. Shares the central `hash2`
 * helper (ticket 24) with the static + dynamic populator paths; the tick term
 * is mixed in BEFORE the finalizer to preserve the historical bit layout.
 */
function explosionFlickerSeed(x: number, y: number, tick: number): number {
  const mixed = hash2(Math.floor(x), Math.floor(y)) ^ (tick * 83492791);
  return flickerSeedFromHash(finalizeHash(mixed));
}
