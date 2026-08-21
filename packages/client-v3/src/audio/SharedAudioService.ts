import Phaser from 'phaser';
import {
  AUDIO_SPRITE_KEY,
  AUDIO_SPRITE_JSON_PATH,
  MUSIC_MARKER_MAP,
  SFX_MARKER_MAP,
  VOICEOVER_MARKER_MAP,
} from '../assets/audio-sprite-markers.js';
import {
  attenuationForDistance,
  AUDIO_CATEGORY,
  type AudioCategory,
  BaseAudioService,
} from './AudioTypes.js';

let sharedInstance: SharedAudioService | null = null;

export function getSharedAudioService(game: Phaser.Game): SharedAudioService {
  if (!sharedInstance) {
    sharedInstance = new SharedAudioService(game);
  }
  return sharedInstance;
}

/**
 * Game-scoped singleton audio service backed by the same single Phaser audio
 * sprite sheet as {@link AudioService}. See that class's docstring for the
 * sprite-sheet layout and regeneration instructions.
 *
 * Unlike {@link AudioService} (scene-scoped), this instance survives scene
 * transitions so music keeps playing across menu → matchmaking → game. The
 * trade-off is that it must be told which scene is driving the loader
 * (`loadAll(scene)`) because Phaser's loader is scene-scoped even though the
 * resulting cache is game-global.
 */
export class SharedAudioService extends BaseAudioService {
  private game: Phaser.Game;
  private loaded = false;
  private activeCount = 0;
  private currentMusic: Phaser.Sound.WebAudioSound | null = null;
  private currentVoiceover: Phaser.Sound.BaseSound | null = null;
  private pendingMusic: { key: string; volume: number } | null = null;
  private fadeScene: Phaser.Scene | null = null;
  /**
   * Live local-player world position. Set via {@link setLocalPos} from the
   * GameScene (which owns the GameState.localPos ref). Defaults to origin
   * until the first scene wires it; positional sounds gate to full volume at
   * distance 0 until then.
   */
  private localPos: { x: number; y: number } = { x: 0, y: 0 };

  constructor(game: Phaser.Game) {
    super();
    this.game = game;
  }

  setFadeScene(scene: Phaser.Scene): void {
    this.fadeScene = scene;
  }

  /** Wire the live local-player position ref for positional audio. */
  setLocalPos(pos: { x: number; y: number }): void {
    this.localPos = pos;
  }

  loadAll(scene: Phaser.Scene): void {
    if (!scene.cache.audio.exists(AUDIO_SPRITE_KEY)) {
      scene.load.audioSprite(AUDIO_SPRITE_KEY, AUDIO_SPRITE_JSON_PATH);
    }
    this.loaded = true;
  }

  unlockAudioContext(): void {
    if (this.game.sound.locked) {
      this.game.sound.unlock();
    }
    this.checkPendingMusic();
  }

  private checkPendingMusic(): void {
    if (this.pendingMusic && !this.game.sound.locked) {
      const { key, volume } = this.pendingMusic;
      this.pendingMusic = null;
      this.doPlayMusic(key, volume);
    }
  }

  playMusic(key: string, volume = 0.3, _fadeMs = 0): void {
    if (this.game.sound.locked) {
      this.pendingMusic = { key, volume };
      return;
    }
    this.doPlayMusic(key, volume);
  }

  private doPlayMusic(key: string, volume: number): void {
    this.stopMusic();
    if (!this.loaded) return;
    const marker = MUSIC_MARKER_MAP[key];
    if (!marker) return;
    const cache = this.game.cache.audio;
    if (!cache.exists(AUDIO_SPRITE_KEY)) return;
    try {
      // NOTE: `loop: true` MUST be passed at play time, not to addAudioSprite.
      // addAudioSprite force-resets `loop` to false on every per-marker config
      // (it reads the JSON marker's `loop` field, defaulting to false), so a
      // global loop flag on addAudioSprite is silently discarded. BaseSound.play
      // applies the play-time config AFTER the marker config, so { loop: true }
      // here correctly overrides the marker's loop:false.
      const sound = this.game.sound.addAudioSprite(AUDIO_SPRITE_KEY, {
        volume,
      }) as Phaser.Sound.WebAudioSound;
      this.currentMusic = sound;
      sound.play(marker, { loop: true });
    } catch {
      this.currentMusic = null;
    }
  }

  stopMusic(fadeMs = 0): void {
    if (!this.currentMusic) return;
    const music = this.currentMusic;
    this.currentMusic = null;

    if (fadeMs > 0 && music.isPlaying && this.fadeScene) {
      const startVol = music.volume ?? 0;
      this.fadeScene.tweens.addCounter({
        from: startVol,
        to: 0,
        duration: fadeMs,
        onUpdate: (tween: Phaser.Tweens.Tween) => {
          if (music.isPlaying) {
            music.setVolume(tween.getValue() ?? 0);
          }
        },
        onComplete: () => {
          if (music.isPlaying) music.stop();
          music.destroy();
        },
      });
    } else {
      if (music.isPlaying) music.stop();
      music.destroy();
    }
  }

  play(key: string, volume = 0.5): void {
    if (!this.loaded || this.activeCount >= 8) return;
    const markers = SFX_MARKER_MAP[key];
    if (!markers || markers.length === 0) return;
    const marker = markers[Math.floor(Math.random() * markers.length)]!;
    const cache = this.game.cache.audio;
    if (!cache.exists(AUDIO_SPRITE_KEY)) return;
    this.activeCount++;
    try {
      const sound = this.game.sound.addAudioSprite(AUDIO_SPRITE_KEY, { volume });
      sound.once('complete', () => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        sound.destroy();
      });
      sound.play(marker);
    } catch {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  playAt(key: string, x: number, y: number, baseVolume = 0.5, category?: AudioCategory): void {
    const cat = category ?? AUDIO_CATEGORY[key] ?? 'normal';
    const dx = x - this.localPos.x;
    const dy = y - this.localPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const volume = attenuationForDistance(dist, baseVolume, cat);
    if (volume === null) return; // beyond hearing range — skip entirely
    this.play(key, volume);
  }

  playVoiceover(key: string): void {
    if (!this.loaded) return;
    if (this.currentVoiceover && this.currentVoiceover.isPlaying) {
      this.currentVoiceover.stop();
      this.currentVoiceover.destroy();
      this.currentVoiceover = null;
    }
    const marker = VOICEOVER_MARKER_MAP[key];
    if (!marker) return;
    const cache = this.game.cache.audio;
    if (!cache.exists(AUDIO_SPRITE_KEY)) return;
    try {
      const sound = this.game.sound.addAudioSprite(AUDIO_SPRITE_KEY, { volume: 0.8 });
      sound.once('complete', () => {
        this.currentVoiceover = null;
      });
      this.currentVoiceover = sound;
      sound.play(marker);
    } catch {
      this.currentVoiceover = null;
    }
  }

  destroy(): void {
    this.stopMusic();
    if (this.currentVoiceover) {
      if (this.currentVoiceover.isPlaying) this.currentVoiceover.stop();
      this.currentVoiceover.destroy();
      this.currentVoiceover = null;
    }
    this.activeCount = 0;
    this.loaded = false;
    this.pendingMusic = null;
    this.fadeScene = null;
    sharedInstance = null;
  }
}
