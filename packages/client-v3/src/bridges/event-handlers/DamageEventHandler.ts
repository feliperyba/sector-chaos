import { EntityType } from '@sector-battle/shared';
import type { DamageChannelMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { DamageNumberRenderer } from '../../rendering/DamageNumberRenderer.js';
import type { EntityRenderer } from '../../rendering/EntityRenderer.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ImpactLightRegistry } from '../../rendering/lighting/ImpactLightRegistry.js';
import { hash2, finalizeHash, flickerSeedFromHash } from '../../rendering/lighting/LightingHash.js';
import { CONTACT_JUICE, getImpactJuice } from '../../rendering/JuiceConfig.js';
import { markEventDamage } from '../damageCache.js';

export class DamageEventHandler {
  constructor(
    private readonly myId: { value: string },
    private readonly localPos: { x: number; y: number },
    private readonly audio: AudioService,
    private readonly cameraService: CameraService,
    private readonly damageNumbers: DamageNumberRenderer,
    private readonly entityRenderer: EntityRenderer,
    private readonly playerRenderer: PlayerRenderer,
    private readonly stateSync: StateSync,
    /**
     * Optional impact-light registry (ticket 09 / A3). When present, brief
     * flashes are registered on:
     *   - `PlayerDamaged` with a weapon-hit damage type (melee/thrown/ranged/
     *     projectile) → `melee` warm-spark flash at the contact point.
     *   - `ShieldBlocked` → `block` spark-white-blue flash at the clash point.
     *   - `WeaponBroken` → `break` warm-orange shatter flash at the weapon pos.
     * NOT registered for: `barrel_explosion` (ExplosionLightRegistry covers
     * blasts — double-lighting would blow out), `zone_damage`/`sudden_death`/
     * `siege_crush` (no contact point, not a weapon hit). Cosmetic-only.
     * Optional so existing tests/constructors that don't care about lighting
     * keep working.
     */
    private readonly impactLights?: ImpactLightRegistry,
    /**
     * Map-redesign ticket 03 — fired when the LOCAL player takes damage so
     * the enter-banner can suppress itself during combat (banner discipline,
     * DEC-001). Optional so existing tests/constructors keep working.
     */
    private readonly onLocalDamaged?: () => void,
  ) {}

  handle(data: DamageChannelMessage): void {
    if (data.eventType === 'PlayerDamaged' || data.knockbackX !== undefined) {
      this.playerRenderer.triggerHitFlash(data.playerId);

      // Damage particles — spawned for ALL players (local + remote)
      if (data.eventType === 'PlayerDamaged') {
        markEventDamage(data.playerId);
        const px = data.x ?? 0;
        const py = data.y ?? 0;
        if (data.sourceType === EntityType.EXPLOSION || data.damageType === 'barrel_explosion') {
          this.entityRenderer.spawnFireParticles(px, py);
        } else if (data.damageType !== 'zone_damage' && data.damageType !== 'sudden_death') {
          this.entityRenderer.spawnBloodParticles(px, py);
        }
        // Ticket 09 / A3 — melee-hit spark. A weapon-on-player hit (melee/thrown
        // /ranged/projectile) produces a brief warm-spark flash at the contact
        // point. Gated to the weapon-hit damage types: barrel_explosion is
        // covered by ExplosionLightRegistry (double-lighting would blow out);
        // zone_damage/sudden_death/siege_crush have no meaningful contact point
        // (environmental/passive damage, not a weapon swing); trap_damage is
        // environmental too (a trap is not a weapon swing — out of scope per the
        // ticket's "ARC/LINE/THROWN connects on a player" wording). Cosmetic.
        if (
          this.impactLights &&
          (data.damageType === 'melee_hit' ||
            data.damageType === 'thrown_hit' ||
            data.damageType === 'ranged_hit' ||
            data.damageType === 'projectile_hit')
        ) {
          this.impactLights.register(
            px,
            py,
            'melee',
            performance.now(),
            impactFlickerSeed(px, py, data.tick),
          );
        }
      }

      // Deterministic victim flinch — same pure impulse the server applied
      if (data.knockbackX || data.knockbackY) {
        this.playerRenderer.applyHitFlinch(
          data.playerId,
          data.knockbackX ?? 0,
          data.knockbackY ?? 0,
        );
      }
      const dmgColor = data.sourceType === EntityType.EXPLOSION ? 0xff8844 : 0xffffff;
      this.damageNumbers.spawn(data.x ?? 0, data.y ?? 0, data.damage ?? 0, false, dmgColor);
      // Hurt SFX — positional so nearby fights are audible. The local player
      // is at distance 0 so their own hurt stays at full volume.
      this.audio.playAt('player_hurt', data.x ?? 0, data.y ?? 0);

      if (data.playerId === this.myId.value) {
        // Ticket 03 — combat-suppression timestamp for the enter-banner.
        this.onLocalDamaged?.();
        // Victim feedback scales with the INCOMING weapon (dagger sting vs
        // hammer slam), kept below the attacker's own contact feedback.
        let shakeIntensity = 2.5;
        let shakeDuration = 120;
        const sourcePlayer = data.sourceId ? this.stateSync.getPlayer(data.sourceId) : undefined;
        if (sourcePlayer) {
          const srcWeapon = sourcePlayer.weapons?.[sourcePlayer.activeSlot ?? 0];
          if (srcWeapon && srcWeapon.weaponType > 0) {
            const juice = getImpactJuice(srcWeapon.weaponType);
            shakeIntensity = juice.shakeIntensity * CONTACT_JUICE.victimShakeScale;
            shakeDuration = juice.shakeDurationMs;

            if (data.knockbackX != null || data.knockbackY != null) {
              const kbLen = Math.sqrt((data.knockbackX ?? 0) ** 2 + (data.knockbackY ?? 0) ** 2);
              if (kbLen > 0.01) {
                this.cameraService.punch(
                  ((data.knockbackX ?? 0) / kbLen) *
                    juice.cameraPunch *
                    CONTACT_JUICE.victimPunchScale,
                  ((data.knockbackY ?? 0) / kbLen) *
                    juice.cameraPunch *
                    CONTACT_JUICE.victimPunchScale,
                );
              }
            }
          }
        }

        this.cameraService.shake(shakeIntensity, shakeDuration);
      }
      if (data.knockbackX || data.knockbackY) {
        const e = this.stateSync.getEntities().players.get(data.playerId);
        if (e) {
          this.playerRenderer.updatePosition(data.playerId, data.x ?? e.x, data.y ?? e.y);
        }
      }
      // Attacker-side flesh-hit reaction (gated inside to mid-melee swings)
      if (data.sourceId && data.sourceId !== data.playerId) {
        this.playerRenderer.triggerMeleeHitReaction(data.sourceId);

        // Hit-confirm reward for the LOCAL attacker: this is where the
        // weapon's full weight lands — shake, shove toward the victim, zoom.
        if (data.sourceId === this.myId.value) {
          const me = this.stateSync.getPlayer(this.myId.value);
          const myWeapon = me?.weapons?.[me.activeSlot ?? 0];
          if (myWeapon && myWeapon.weaponType > 0) {
            const juice = getImpactJuice(myWeapon.weaponType);
            this.cameraService.shake(juice.shakeIntensity, juice.shakeDurationMs);
            const kbLen = Math.sqrt((data.knockbackX ?? 0) ** 2 + (data.knockbackY ?? 0) ** 2);
            if (kbLen > 0.01) {
              // Knockback points away from me — the swing's travel direction
              this.cameraService.punch(
                ((data.knockbackX ?? 0) / kbLen) * juice.cameraPunch,
                ((data.knockbackY ?? 0) / kbLen) * juice.cameraPunch,
              );
            }
            if (juice.cameraZoomPct > 0) this.cameraService.zoomPunch(juice.cameraZoomPct);
          }
        }
      }
    }
    if (data.eventType === 'WeaponBroken') {
      // Weapon-break SFX — positional so you hear nearby players' weapons shatter.
      const brokenPlayer = this.stateSync.getPlayer(data.playerId);
      this.audio.playAt(
        'weapon_break',
        data.x ?? brokenPlayer?.x ?? 0,
        data.y ?? brokenPlayer?.y ?? 0,
      );
      if (brokenPlayer) {
        this.entityRenderer.triggerDestructibleBreak(brokenPlayer.x, brokenPlayer.y, 2);
        // Capture the weapon's current world pose BEFORE hiding — getWeaponWorldState
        // returns null once the sprite is invisible, and the shatter VFX needs the
        // real rotation/tint/scale to look right.
        const ws = this.playerRenderer.getWeaponWorldState(data.playerId);
        this.entityRenderer.triggerWeaponBreak(
          ws?.x ?? brokenPlayer.x,
          ws?.y ?? brokenPlayer.y,
          data.weaponType,
          ws?.rotation ?? brokenPlayer.facingAngle,
          ws?.tint ?? 0xffffff,
          ws?.scale ?? 0.56,
        );
        // The weapon has shattered — hide the held sprite now rather than waiting
        // for the next state patch to clear the slot. Closes the 1-RTT window
        // where the per-frame re-arm branch would keep the broken weapon visible
        // on the player's hand through the stagger. (B1 fix)
        this.playerRenderer.hideWeapon(data.playerId);
        // Ticket 09 / A3 — weapon-break shatter flash. A brief warm-orange flash
        // at the weapon's world position (the same pose the shatter VFX uses, so
        // the light + the particles coincide — matches the user's "spark a light
        // together with the particles to match the mood" ruling). Cosmetic.
        if (this.impactLights) {
          const bx = ws?.x ?? brokenPlayer.x;
          const by = ws?.y ?? brokenPlayer.y;
          this.impactLights.register(
            bx,
            by,
            'break',
            performance.now(),
            impactFlickerSeed(bx, by, data.tick),
          );
        }
      }
    }
    if (data.eventType === 'ShieldBlocked') {
      // Shield-block clash — positional so you hear nearby parries.
      this.audio.playAt('hit_shield', data.x ?? 0, data.y ?? 0);
      // Weapon-vs-shield clash: both sides recoil (mirrors the server impulses)
      this.playerRenderer.triggerBlockClash(
        data.playerId,
        data.sourceId,
        data.contactX,
        data.contactY,
        data.attackerWeaponType,
      );
      // Spawn visual shield block impact particles at the contact point
      this.entityRenderer.spawnShieldBlockParticles(data.x, data.y, data.contactX, data.contactY);
      // Ticket 09 / A3 — shield-block spark. A brief spark-white-blue flash at
      // the clash point — matches the existing block particles (the user's
      // example: "the block of the shield should spark a light together with the
      // block particles to match the mood"). Prefers the swept-melee
      // `contactX/contactY` (where the attacker's blade met the guard) when
      // present, falls back to the defender's `x/y`. Cosmetic.
      if (this.impactLights) {
        const bx = data.contactX ?? data.x ?? 0;
        const by = data.contactY ?? data.y ?? 0;
        this.impactLights.register(
          bx,
          by,
          'block',
          performance.now(),
          impactFlickerSeed(bx, by, data.tick),
        );
      }
      // Floating "BLOCK" indicator — bluish, rises and fades like damage numbers
      this.damageNumbers.spawnLabel(data.x ?? 0, data.y ?? 0, 'BLOCK', 0x66ccff);
      // Metal-on-shield jolt for whichever side of the clash is local
      if (data.playerId === this.myId.value || data.sourceId === this.myId.value) {
        const juice = getImpactJuice(data.attackerWeaponType ?? 0);
        this.cameraService.shake(juice.shakeIntensity * 0.8, juice.shakeDurationMs * 0.6);
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
