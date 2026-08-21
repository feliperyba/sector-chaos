import Phaser from 'phaser';
import { GRID, type ZoneUpdateChannelMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { HUDManager } from '../../hud/HUDManager.js';

export class ZoneEventHandler {
  constructor(
    private readonly localPos: { x: number; y: number },
    private readonly myId: { value: string },
    private readonly audio: AudioService,
    private readonly cameraService: CameraService,
    private readonly entityRenderer: EntityRenderer,
    private readonly hud: HUDManager,
    private readonly scene: Phaser.Scene,
  ) {}

  handle(data: ZoneUpdateChannelMessage): void {
    if (data.eventType === 'ZoneWarning') {
      this.audio.playZoneWarning();
    }
    if (data.eventType === 'ZoneDamage') {
      const damaged = [...(data.playersDamaged ?? [])];
      if (damaged.some((p) => p.playerId === this.myId.value)) {
        this.audio.playZoneDamage();
      }
    }
    if (data.eventType === 'ZonePhaseChanged') {
      this.audio.playZoneShrink();
    }
    if (data.eventType === 'SiegeWallWarning') {
      this.entityRenderer.addSiegeWarning(data.gridX, data.gridY, data.solidifyAt);
      this.audio.playSiegeWallWarning();
    }
    if (data.eventType === 'SiegeWallDropped') {
      this.entityRenderer.confirmSiegeWall(data.gridX, data.gridY);
      if (data.audible) {
        // Distance-based screenshake: full force at impact, fading to zero.
        // Siege blocks are heavy — use a longer falloff than explosions.
        const TILE_SIZE = GRID.TILE_SIZE;
        const impactX = data.gridX * TILE_SIZE + TILE_SIZE / 2;
        const impactY = data.gridY * TILE_SIZE + TILE_SIZE / 2;
        // Siege wall drop SFX — positional (loud). playAt gates by hearing
        // range so distant drops are inaudible.
        this.audio.playAt('siege_wall_drop', impactX, impactY, 0.5, 'loud');
        const dx = impactX - this.localPos.x;
        const dy = impactY - this.localPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const SHAKE_RANGE = 1600;
        if (dist < SHAKE_RANGE) {
          const intensity = 32 * (1 - dist / SHAKE_RANGE);
          const duration = 300 * (1 - (dist / SHAKE_RANGE) * 0.5);
          this.cameraService.shake(intensity, duration);
        }
      }
    }
    if (data.eventType === 'SectorSiegeStarted') {
      this.hud.setStatusText('Sector under siege!', true);
      this.scene.time.delayedCall(2000, () => this.hud.setStatusText('', false));
    }
    if (data.eventType === 'SuddenDeathEscalation') {
      this.hud.setStatusText('SUDDEN DEATH!', true);
      this.scene.time.delayedCall(3000, () => this.hud.setStatusText('', false));
      this.audio.playVoiceover('hurry_up');
    }
    if (data.eventType === 'SuddenDeathTriggered') {
      this.hud.setStatusText('SUDDEN DEATH TRIGGERED!', true);
      this.scene.time.delayedCall(4000, () => this.hud.setStatusText('', false));
      this.audio.playVoiceover('hurry_up');
    }
  }
}
