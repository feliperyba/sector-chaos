import { weaponRegistry, FEATURES, type WeaponType } from '@sector-battle/shared';
import type { AttackChannelMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { MapRenderer } from '../../rendering/MapRenderer.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ImpactLightRegistry } from '../../rendering/lighting/ImpactLightRegistry.js';
import { resolveAttackTypeForProjectile } from '../../rendering/lighting/ProjectileLightTuning.js';
import { AttackType } from '@sector-battle/shared';
import {
  hash2,
  finalizeHash,
  flickerSeedFromHash,
} from '../../rendering/lighting/LightingHash.js';
import { getTierColor, getWeaponDisplayScale } from '../../rendering/WeaponVisuals.js';
import { CONTACT_JUICE, getImpactJuice } from '../../rendering/JuiceConfig.js';

export class AttackEventHandler {
  constructor(
    private readonly myId: { value: string },
    private readonly localPos: { x: number; y: number },
    private readonly audio: AudioService,
    private readonly entityRenderer: EntityRenderer,
    private readonly mapRenderer: MapRenderer,
    private readonly playerRenderer: PlayerRenderer,
    private readonly cameraService: CameraService,
    private readonly stateSync: StateSync,
    /**
     * Optional impact-light registry (ticket 09 / A3). When present, a brief
     * warm-white spark flash is registered on every RANGED projectile impact
     * (`ProjectileDestroyed`). Physical-throw impacts (ARC/LINE/THROWN) emit NO
     * flash — they emit no traveling light either (RANGED-only ruling), so a
     * stray spark disconnected from any streak would read wrong. Cosmetic-only.
     * Optional so existing tests/constructors that don't care about lighting
     * keep working.
     */
    private readonly impactLights?: ImpactLightRegistry,
  ) {}

  handle(data: AttackChannelMessage): void {
    if (data.eventType === 'WeaponWallHit') {
      // Melee swing struck a wall: interrupt + recoil (mirrors server impulses)
      this.playerRenderer.triggerWallHit(data.playerId);
      this.audio.playAt('wall_hit', data.x, data.y);
      if (data.playerId === this.myId.value) {
        // Indestructible surface: a dead stop — hard, short thud scaled by
        // the weapon, with a small camera shove toward the contact point.
        const juice = getImpactJuice(data.weaponType ?? 0);
        this.cameraService.shake(
          juice.shakeIntensity * CONTACT_JUICE.wallShakeScale,
          juice.shakeDurationMs * CONTACT_JUICE.wallShakeDurationScale,
        );
        const me = this.playerRenderer.getPlayerPosition(data.playerId);
        if (me) {
          const dx = data.x - me.x;
          const dy = data.y - me.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 0.01) {
            this.cameraService.punch(
              (dx / len) * juice.cameraPunch * 0.6,
              (dy / len) * juice.cameraPunch * 0.6,
            );
          }
        }
      }
      return;
    }
    if (data.eventType === 'ProjectileBounced') {
      this.audio.playAt('hit_melee', data.x, data.y);
      if (data.projectileId) {
        this.entityRenderer.triggerProjectileBounce(data.projectileId);
      }
      return;
    }
    if (data.eventType === 'ProjectileDestroyed') {
      if (data.hitTile && data.gridX != null && data.gridY != null) {
        this.mapRenderer.clearGridCell(data.gridX, data.gridY);
      }
      // Ticket 09 / A3 — arrow-impact flash. A RANGED bolt's impact produces a
      // brief warm-white spark at the impact point (the streak's terminus).
      // Gated to RANGED-only: physical-throw impacts (ARC/LINE/THROWN) emit NO
      // flash — they emit no traveling light either (RANGED-only ruling), so a
      // stray spark disconnected from any streak would read wrong. The wire
      // `ProjectileDestroyedMessage` does NOT carry `weaponType`/`attackType`
      // (the mapper omits both — verified), so we look the projectile entity up
      // in the client state to read its `weaponType` + resolve the AttackType.
      // The entity may already be despawned by the time the message arrives
      // (state patch + event are separate channels); in that case we fall back
      // to NO flash (better no flash than a wrong-type flash). Cosmetic-only.
      if (this.impactLights) {
        const proj = this.stateSync.getEntities().projectiles.get(data.projectileId);
        const weaponType = proj?.weaponType ?? data.weaponType;
        if (weaponType != null) {
          const attackType = resolveAttackTypeForProjectile(weaponType);
          if (attackType === AttackType.RANGED) {
            this.impactLights.register(
              data.x,
              data.y,
              'projectile',
              performance.now(),
              impactFlickerSeed(data.x, data.y, data.tick ?? 0),
            );
          }
        }
      }
      return;
    }
    if (data.eventType === 'WeaponShattered') {
      if (data.hitTile && data.gridX != null && data.gridY != null) {
        this.mapRenderer.clearGridCell(data.gridX, data.gridY);
        this.audio.playAt('wall_hit', data.x, data.y);
      }
      const weaponType = data.weaponType ?? 0;
      const tier = this.stateSync.getEntities().projectiles.get(data.projectileId)?.tier ?? 0;
      const tint = getTierColor(tier);
      const scale = getWeaponDisplayScale(weaponType);
      this.entityRenderer.triggerWeaponBreak(
        data.x,
        data.y,
        weaponType,
        data.direction ?? 0,
        tint,
        scale,
      );
      return;
    }
    if (data.attackType) {
      const atkType =
        data.attackType === 'ranged'
          ? 'ranged'
          : data.attackType === 'line'
            ? 'line'
            : data.attackType === 'thrown'
              ? 'thrown'
              : data.attackType === 'shield'
                ? 'shield'
                : 'arc';
      let windupMs = 250;
      let range = 160;
      let arcAngle: number | undefined;
      let outerRadius = 160;
      if (data.weaponType != null) {
        try {
          const def = weaponRegistry.getDefinition(data.weaponType as WeaponType);
          const isMelee = atkType === 'arc' || atkType === 'line';
          const stats =
            isMelee && def.meleeStats ? { ...def.baseStats, ...def.meleeStats } : def.baseStats;
          windupMs = stats.windupMs;
          range = stats.range;
          arcAngle = stats.arcAngle;
          outerRadius = stats.range;
        } catch {
          /* fallback to defaults */
        }
      }
      // Swept melee: the animated blade IS the hitbox — drawing the legacy
      // instant arc/line telegraph would show a shape combat no longer uses.
      const sweptMelee = FEATURES.SWEPT_MELEE && (atkType === 'arc' || atkType === 'line');
      if (!sweptMelee) {
        const playerPos = this.playerRenderer.getPlayerPosition(data.playerId ?? '');
        this.playerRenderer.addAttack({
          id: `atk_${data.tick}_${data.playerId ?? ''}`,
          playerId: data.playerId ?? '',
          type: atkType,
          angle: data.direction ?? 0,
          startTime: performance.now(),
          duration: Math.max(80, windupMs * 0.8),
          range,
          arcAngle,
          innerRadius: 0,
          outerRadius,
          lineWidth: 20,
          fireX: playerPos?.x ?? data.x ?? 0,
          fireY: playerPos?.y ?? data.y ?? 0,
        });
      }
      // Attack swing SFX — positional so nearby remote swings are audible.
      // The local player is at distance 0, so their own swing stays full volume.
      const fireX = data.x ?? 0;
      const fireY = data.y ?? 0;
      if (data.attackType === 'thrown') this.audio.playAt('hit_thrown', fireX, fireY);
      else this.audio.playAt('hit_melee', fireX, fireY);

      if (data.playerId === this.myId.value) {
        // A swing proves nothing was hit yet — only a light directional lean
        // along the attack. Hit-stop/shake/zoom belong to the CONTACT events
        // (PlayerDamaged, WeaponWallHit, tile break, ShieldBlocked).
        if (data.weaponType != null) {
          const juice = getImpactJuice(data.weaponType);
          const angle = data.direction ?? 0;
          const punch = juice.cameraPunch * CONTACT_JUICE.whiffPunchScale;
          this.cameraService.punch(Math.cos(angle) * punch, Math.sin(angle) * punch);
        }
      }
    }
    if (data.gridX != null && data.gridY != null && data.hitTile) {
      this.mapRenderer.clearGridCell(data.gridX, data.gridY);
      this.audio.playAt('wall_hit', data.x ?? 0, data.y ?? 0);
      // Destructible giving way under the blade: a medium crunch
      if (data.playerId === this.myId.value && data.weaponType != null) {
        const juice = getImpactJuice(data.weaponType);
        this.cameraService.shake(
          juice.shakeIntensity * CONTACT_JUICE.destructibleShakeScale,
          juice.shakeDurationMs * 0.7,
        );
        this.playerRenderer.addHitStop(
          data.playerId,
          juice.hitStopMs * CONTACT_JUICE.destructibleHitStopScale,
        );
      }
    }
  }
}

/**
 * Deterministic per-impact flicker seed (stable hash of position + tick). Pure
 * — same inputs → same seed → same pulse-phase jitter. Used so concurrent
 * impacts (a multi-hit sweep, a cluster of arrow strikes) don't all strobe in
 * lockstep; each gets a distinct phase derived from its unique position + tick.
 * Mirrors `explosionFlickerSeed` in ExplosionEventHandler (same hash family,
 * same bit layout). Ticket 09 / A3.
 */
function impactFlickerSeed(x: number, y: number, tick: number): number {
  const mixed = hash2(Math.floor(x), Math.floor(y)) ^ (tick * 83492791);
  return flickerSeedFromHash(finalizeHash(mixed));
}
