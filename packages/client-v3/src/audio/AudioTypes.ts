/** Hearing range categories for positional audio. Map tile = 64px. */
export type AudioCategory = 'quiet' | 'normal' | 'loud';

/**
 * Per-key hearing ranges (in world pixels). A positional sound beyond its
 * category's range is skipped entirely; within range, volume fades linearly
 * from full (at distance 0) to 0 (at the range edge). The categories mirror
 * the existing camera-shake distances (600px normal, 1600px siege).
 */
export const HEARING_RANGE: Record<AudioCategory, number> = {
  /** Footsteps, weapon switch, dash — only the immediate vicinity. */
  quiet: 600,
  /** Attacks, hits, pickups, traps, shield blocks, hurt, kill, death. */
  normal: 1000,
  /** Explosions, barrel blasts, siege wall drops. */
  loud: 1600,
};

/**
 * Assigns each SFX key to a hearing-range category. Keys not listed default
 * to `'normal'`. Sounds played via `play()` (non-positional) are unaffected —
 * this map is only consulted by `playAt()`.
 */
export const AUDIO_CATEGORY: Record<string, AudioCategory> = {
  // quiet — movement / inventory
  footstep: 'quiet',
  weapon_switch: 'quiet',
  dash: 'quiet',
  // loud — detonations
  barrel_explode: 'loud',
  siege_wall_drop: 'loud',
  // all other keys default to 'normal'
};

/**
 * Distance-based volume attenuation. Returns `null` if the sound is beyond
 * hearing range (caller should skip it entirely), otherwise the scaled
 * volume in `[0, baseVolume]`. Linear falloff: full volume at distance 0,
 * fading to 0 at the range edge.
 */
export function attenuationForDistance(
  dist: number,
  baseVolume: number,
  category: AudioCategory,
): number | null {
  const range = HEARING_RANGE[category];
  if (dist >= range) return null;
  return baseVolume * (1 - dist / range);
}

/** Common interface for audio services. */
export interface IAudioService {
  play(key: string, volume?: number): void;
  /**
   * Play a positional SFX: volume attenuates with distance from the local
   * player to `(x, y)` based on the sound's {@link AudioCategory}, and the
   * sound is skipped entirely beyond its hearing range. Pass an explicit
   * `category` override for sounds not in the {@link AUDIO_CATEGORY} map.
   */
  playAt(key: string, x: number, y: number, baseVolume?: number, category?: AudioCategory): void;
  playVoiceover(key: string): void;
  destroy(): void;
  playHit(): void;
  playDash(): void;
  playPickup(): void;
  playPickupPowerUp(): void;
  playChestOpen(): void;
  playExplosion(): void;
  playKill(): void;
  playHurt(): void;
  playWeaponSwitch(): void;
  playMatchStart(): void;
  playWeaponBreak(): void;
  playShieldBlock(): void;
  playDeath(): void;
  playVictory(): void;
  playDefeat(): void;
  playWallHit(): void;
  playZoneDamage(): void;
  playZoneWarning(): void;
  playTrapTrigger(): void;
  playTrapReveal(): void;
  playCountdownBeep(): void;
  playStagger(): void;
  playHitThrown(): void;
  playFootstep(): void;
  playChestRare(): void;
  playPowerUpActivate(): void;
  playSpawnProtectionEnd(): void;
  playSiegeWallDrop(): void;
  playSiegeWallWarning(): void;
  playBarrelExplode(): void;
  playWeaponDrop(): void;
  playZoneShrink(): void;
  playCountdownGo(): void;
}

/**
 * Abstract base class holding the shared convenience methods that delegate
 * to {@link play}. Both {@link AudioService} (scene-scoped) and
 * {@link SharedAudioService} (game-scoped singleton) extend this so the
 * ~35 `playXxx()` helpers exist in exactly ONE place while each subclass
 * keeps its own lifecycle and `play()` implementation.
 */
export abstract class BaseAudioService implements IAudioService {
  abstract play(key: string, volume?: number): void;
  abstract playAt(
    key: string,
    x: number,
    y: number,
    baseVolume?: number,
    category?: AudioCategory,
  ): void;
  abstract playVoiceover(key: string): void;
  abstract destroy(): void;

  playHit(): void {
    this.play('hit_melee');
  }
  playDash(): void {
    this.play('dash');
  }
  playPickup(): void {
    this.play('pickup_weapon');
  }
  playPickupPowerUp(): void {
    this.play('pickup_powerup');
  }
  playChestOpen(): void {
    this.play('chest_open');
  }
  playExplosion(): void {
    this.play('explosion');
  }
  playKill(): void {
    this.play('player_kill');
  }
  playHurt(): void {
    this.play('player_hurt');
  }
  playWeaponSwitch(): void {
    this.play('weapon_switch');
  }
  playMatchStart(): void {
    this.play('match_start');
  }
  playWeaponBreak(): void {
    this.play('weapon_break');
  }
  playShieldBlock(): void {
    this.play('hit_shield');
  }
  playDeath(): void {
    this.play('player_death');
  }
  playVictory(): void {
    this.play('victory');
  }
  playDefeat(): void {
    this.play('defeat');
  }
  playWallHit(): void {
    this.play('wall_hit');
  }
  playZoneDamage(): void {
    this.play('zone_damage');
  }
  playZoneWarning(): void {
    this.play('zone_warning');
  }
  playTrapTrigger(): void {
    this.play('trap_trigger');
  }
  playTrapReveal(): void {
    this.play('trap_reveal');
  }
  playCountdownBeep(): void {
    this.play('countdown_beep');
  }
  playStagger(): void {
    this.play('player_stagger');
  }
  playHitThrown(): void {
    this.play('hit_thrown');
  }
  playFootstep(): void {
    this.play('footstep', 0.15);
  }
  playChestRare(): void {
    this.play('chest_rare');
  }
  playPowerUpActivate(): void {
    this.play('powerup_activate');
  }
  playSpawnProtectionEnd(): void {
    this.play('spawn_protection_end');
  }
  playSiegeWallDrop(): void {
    this.play('siege_wall_drop');
  }
  playSiegeWallWarning(): void {
    this.play('siege_wall_warning');
  }
  playBarrelExplode(): void {
    this.play('barrel_explode');
  }
  playWeaponDrop(): void {
    this.play('weapon_drop');
  }
  playZoneShrink(): void {
    this.play('zone_shrink');
  }
  playCountdownGo(): void {
    this.play('countdown_go');
  }
}
