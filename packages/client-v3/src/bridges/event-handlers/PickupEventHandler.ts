import type { PickupChannelMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import { powerUpTint } from '../../rendering/vfx/PickupVFX.js';
import type { StateSync } from '../../network/StateSync.js';
import { markEventDamage } from '../damageCache.js';

export class PickupEventHandler {
  constructor(
    private readonly myId: { value: string },
    private readonly localPos: { x: number; y: number },
    private readonly audio: AudioService,
    private readonly cameraService: CameraService,
    private readonly entityRenderer: EntityRenderer,
    private readonly stateSync: StateSync,
  ) {}

  handle(data: PickupChannelMessage): void {
    if (data.eventType === 'WeaponPickupCollected') {
      const p = this.stateSync.getPlayer(data.playerId);
      this.audio.playAt('pickup_weapon', p?.x ?? 0, p?.y ?? 0);
    }
    if (data.eventType === 'ChestOpened') {
      const p = this.stateSync.getPlayer(data.playerId);
      const px = p?.x ?? 0;
      const py = p?.y ?? 0;
      if (data.tier >= 2) this.audio.playAt('chest_rare', px, py);
      else this.audio.playAt('chest_open', px, py);
    }
    if (data.eventType === 'PowerUpCollected') {
      const p = this.stateSync.getPlayer(data.playerId);
      const px = p?.x ?? 0;
      const py = p?.y ?? 0;
      this.audio.playAt('pickup_powerup', px, py);
      this.audio.playAt('powerup_activate', px, py);
      // Ticket 03 pickup pop: tinted collection burst (visual half of the
      // feedback; audio above is the other half). Tint keys to the power-up
      // type so heal/shield/speed pops read differently at a glance.
      this.entityRenderer.spawnPowerUpCollectBurst(px, py, powerUpTint(data.powerUpType));
      // Voiceover is a global announcement — only for the local collector.
      if (data.playerId === this.myId.value) this.audio.playVoiceover('power_up');
    }
    if (data.eventType === 'TrapTriggered') {
      // Mark target as recently event-damaged so silent damage detection
      // doesn't spawn fire particles for spike/teleport traps
      if (data.targetId) markEventDamage(data.targetId);

      const trap = this.stateSync.getEntities().traps.get(data.trapId);
      const tx = trap?.x ?? 0;
      const ty = trap?.y ?? 0;
      // Trap SFX — positional at the trap location.
      if (data.trapType === 0) this.audio.playAt('trap_spike', tx, ty);
      else if (data.trapType === 1) this.audio.playAt('trap_fire', tx, ty);
      else if (data.trapType === 2) this.audio.playAt('trap_teleport', tx, ty);
      else this.audio.playAt('trap_trigger', tx, ty);
      this.cameraService.shake(3, 150);
      // Victim hurt — positional (local victim at distance 0 = full volume).
      if (data.targetId === this.myId.value) this.audio.playAt('player_hurt', tx, ty);

      if (trap) {
        this.entityRenderer.triggerTrapVfx(data.trapType, trap.x, trap.y);
        if (data.trapType === 0) {
          this.entityRenderer.triggerSpikeFlash(data.trapId);
          this.entityRenderer.spawnBloodParticles(trap.x, trap.y);
        } else if (data.trapType === 1) {
          this.entityRenderer.spawnFireParticles(trap.x, trap.y);
        }
      }

      if (data.trapType === 2 && data.targetId && trap) {
        const player = this.stateSync.getPlayer(data.targetId);
        if (player) {
          this.entityRenderer.triggerTeleportEffect(
            data.targetId,
            trap.x,
            trap.y,
            player.x,
            player.y,
          );
          // Depart particles at trap position immediately
          this.entityRenderer.spawnTeleportParticles(trap.x, trap.y);
          // Arrive particles at destination — delayed so state sync updates position first
          setTimeout(() => {
            const updated = this.stateSync.getPlayer(data.targetId);
            if (updated) {
              this.entityRenderer.spawnTeleportParticles(updated.x, updated.y);
            }
          }, 200);
        }
      }
    }
    if (data.eventType === 'ChestRejected') {
      const p = this.stateSync.getPlayer(data.playerId);
      this.audio.playAt('hit_melee', p?.x ?? 0, p?.y ?? 0);
    }
    if (data.eventType === 'ChestOpeningInterrupted') {
      if (data.playerId === this.myId.value) this.audio.playHit();
    }
    if (data.eventType === 'PowerUpEffectExpired') {
      // No position available for an expired power-up — play at local pos
      // (quiet UI feedback, not a world event).
      this.audio.playHit();
    }
    if (data.eventType === 'TrapCooldownExpired') {
      const trap = this.stateSync.getEntities().traps.get(data.trapId);
      const tx = trap?.x ?? 0;
      const ty = trap?.y ?? 0;
      if (data.trapType === 0) this.audio.playAt('trap_spike', tx, ty);
      else if (data.trapType === 1) this.audio.playAt('trap_fire', tx, ty);
      else if (data.trapType === 2) this.audio.playAt('trap_teleport', tx, ty);
    }
  }
}
