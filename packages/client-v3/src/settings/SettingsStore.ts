import type Phaser from 'phaser';

/**
 * Client settings — persisted to `localStorage` so they survive reloads.
 *
 * The store is intentionally tiny: read/write the whole state as one JSON
 * blob under a versioned key. Nothing subscribes to it — settings are applied
 * eagerly at the write site (the settings modal) and once at boot (main.ts).
 */

const STORAGE_KEY = 'secto-chaos-settings-v1';

export interface ClientSettings {
  /** Master audio switch — SFX + music + voiceover (Phaser global mute). */
  soundEnabled: boolean;
}

const DEFAULTS: ClientSettings = {
  soundEnabled: true,
};

/**
 * Load the persisted settings, merged over defaults so entries added later
 * always have a value. Corrupt/unavailable storage degrades to defaults
 * (localStorage can throw in private-mode browsers).
 */
export function loadSettings(): ClientSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ClientSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist the settings. Best-effort — storage failures are swallowed. */
export function saveSettings(settings: ClientSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota/private-mode — settings live for this session only.
  }
}

/**
 * Apply the persisted sound setting to the game's GLOBAL sound manager.
 *
 * Every audio path in the client (SharedAudioService AND the scene-scoped
 * AudioService) plays through the game-wide SoundManager, so one mute flag
 * covers SFX + music + voiceover. Idempotent — safe to call at boot and again
 * on every toggle.
 */
export function applySoundSetting(game: Phaser.Game): void {
  game.sound.setMute(!loadSettings().soundEnabled);
}
