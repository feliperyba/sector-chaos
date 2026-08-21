/**
 * Asset registry for the client.
 *
 * All image/texture art is packed into Phaser 4 multipack atlases
 * (`game`, `ui`, `vfx`, `lightProps`) — see {@link ATLASES}. Each atlas is loaded with a
 * single `scene.load.multiatlas(key, json, imagePath)` call; individual frames
 * are referenced at use sites via the two-argument Phaser form
 * (`add.sprite(x, y, 'game', 'red_character')`, `setTexture('ui', 'panel')`,
 * `nineslice(x, y, 'ui', 'panel', ...)`). Frame keys are the bare asset names
 * exported by the spritesheet packer (the `filename` fields in each `*.json`).
 *
 * Audio (sfx/music/voiceover), fonts, and the two cursor PNGs are NOT part of
 * any atlas: audio lives in a Phaser audio sprite sheet; fonts load via CSS
 * @font-face; and the cursor PNGs are referenced as DOM CSS `url()` values for
 * the OS pointer, which cannot read atlas frames.
 */
export const ATLASES = {
  game: {
    json: 'assets/game.json',
    image: 'assets/game.png',
  },
  ui: {
    json: 'assets/ui.json',
    image: 'assets/ui.png',
  },
  vfx: {
    json: 'assets/vfx.json',
    image: 'assets/vfx.png',
  },
  /**
   * Light-prop spritesheet (ticket 16) — torch/candle/biome-glow prop art that
   * motivates the static map-gen light disks (the "motivated lighting" rule:
   * every light disk needs a visible fixture). Loaded as a separate sheet
   * because the `game` atlas is full (~4px slack). The `campfire` kind reuses
   * the existing `game/campfire` frame by reference — see {@link LightPropResolver}.
   */
  lightProps: {
    json: 'assets/light_props.json',
    image: 'assets/light_props.png',
  },
  /**
   * Kenney "Keyboard & Mouse" input prompts (settings controls guide). Frames
   * are the Kenney filenames sans extension (`keyboard_w`, `mouse_left`, …).
   * Packed by `scripts/asset-pipeline/build-input-prompts.ts` — re-run to
   * change the sprite set.
   */
  prompts: {
    json: 'assets/prompts.json',
    image: 'assets/prompts.png',
  },
} as const;

/** Texture keys for the multipack atlases. */
export type AtlasKey = keyof typeof ATLASES;

/**
 * Loads all three atlases into a scene's texture manager.
 *
 * The atlas JSON's `image` field is a bare filename (e.g. `"game.png"`), so
 * Phaser needs a `path` to resolve it relative to baseURL — that path is the
 * directory of the JSON file, derived here so the assets dir location is the
 * single source of truth.
 *
 * Idempotent: skips atlases already present in the Texture Manager (the menu
 * scenes may run after one another and share the global texture cache).
 */
export function loadAtlases(scene: Phaser.Scene): void {
  for (const [key, { json }] of Object.entries(ATLASES)) {
    if (scene.textures.exists(key)) continue;
    const path = json.substring(0, json.lastIndexOf('/') + 1);
    scene.load.multiatlas({ key, atlasURL: json, path });
  }
}

export const AssetManifest = {
  /**
   * SFX / music / voiceover are NOT loaded as individual files at runtime —
   * they live in a single Phaser audio sprite sheet
   * (`public/assets/audio/spritesheet/audiosprite.{ogg,json}`) loaded via
   * `scene.load.audioSprite()`. These blocks remain as the source-of-truth
   * mapping of `audioKey → source file(s)` that the spritesheet generator
   * (`scripts/asset-pipeline/build-audio-spritesheet.ts`) reads to produce
   * `audio-sprite-markers.ts` (the typed `audioKey → marker` maps the runtime
   * actually consumes). The individual `.ogg` files themselves are no longer
   * in the repo — see the generator's docstring for regeneration instructions.
   */
  sfx: {
    hit_melee: [
      'assets/audio/ImpactSounds/Audio/impactPunch_heavy_000.ogg',
      'assets/audio/ImpactSounds/Audio/impactPunch_heavy_001.ogg',
      'assets/audio/ImpactSounds/Audio/impactPunch_heavy_002.ogg',
      'assets/audio/ImpactSounds/Audio/impactPunch_heavy_003.ogg',
    ],
    hit_shield: [
      'assets/audio/ImpactSounds/Audio/impactMetal_heavy_001.ogg',
      'assets/audio/ImpactSounds/Audio/impactMetal_heavy_002.ogg',
      'assets/audio/ImpactSounds/Audio/impactMetal_heavy_003.ogg',
    ],
    hit_thrown: [
      'assets/audio/ImpactSounds/Audio/impactWood_heavy_000.ogg',
      'assets/audio/ImpactSounds/Audio/impactWood_heavy_001.ogg',
      'assets/audio/ImpactSounds/Audio/impactWood_heavy_002.ogg',
    ],
    dash: ['assets/audio/InterfaceSounds/Audio/switch_002.ogg'],
    pickup_weapon: ['assets/audio/InterfaceSounds/Audio/confirmation_001.ogg'],
    pickup_powerup: ['assets/audio/InterfaceSounds/Audio/confirmation_002.ogg'],
    chest_open: ['assets/audio/InterfaceSounds/Audio/open_001.ogg'],
    chest_rare: ['assets/audio/InterfaceSounds/Audio/open_003.ogg'],
    player_kill: ['assets/audio/ImpactSounds/Audio/impactPunch_heavy_001.ogg'],
    player_hurt: [
      'assets/audio/ImpactSounds/Audio/impactPunch_medium_000.ogg',
      'assets/audio/ImpactSounds/Audio/impactPunch_medium_001.ogg',
      'assets/audio/ImpactSounds/Audio/impactSoft_medium_000.ogg',
    ],
    player_death: ['assets/audio/ImpactSounds/Audio/impactBell_heavy_002.ogg'],
    player_stagger: ['assets/audio/ImpactSounds/Audio/impactSoft_medium_000.ogg'],
    weapon_break: ['assets/audio/ImpactSounds/Audio/impactMetal_heavy_000.ogg'],
    weapon_switch: ['assets/audio/InterfaceSounds/Audio/switch_001.ogg'],
    weapon_drop: ['assets/audio/ImpactSounds/Audio/impactWood_light_000.ogg'],
    wall_hit: [
      'assets/audio/ImpactSounds/Audio/impactPunch_medium_001.ogg',
      'assets/audio/ImpactSounds/Audio/impactWood_medium_000.ogg',
    ],
    trap_trigger: ['assets/audio/ImpactSounds/Audio/impactMetal_heavy_000.ogg'],
    trap_spike: ['assets/audio/ImpactSounds/Audio/impactMetal_heavy_000.ogg'],
    trap_fire: ['assets/audio/ImpactSounds/Audio/impactGlass_heavy_000.ogg'],
    trap_teleport: ['assets/audio/InterfaceSounds/Audio/glitch_001.ogg'],
    trap_reveal: ['assets/audio/InterfaceSounds/Audio/click_001.ogg'],
    zone_damage: ['assets/audio/ImpactSounds/Audio/impactGeneric_light_000.ogg'],
    zone_warning: ['assets/audio/InterfaceSounds/Audio/tick_001.ogg'],
    zone_shrink: ['assets/audio/InterfaceSounds/Audio/maximize_003.ogg'],
    countdown_beep: ['assets/audio/InterfaceSounds/Audio/tick_002.ogg'],
    match_start: ['assets/audio/InterfaceSounds/Audio/maximize_001.ogg'],
    countdown_go: ['assets/audio/InterfaceSounds/Audio/maximize_002.ogg'],
    victory: ['assets/audio/InterfaceSounds/Audio/maximize_002.ogg'],
    defeat: ['assets/audio/ImpactSounds/Audio/impactBell_heavy_001.ogg'],
    footstep: [
      'assets/audio/ImpactSounds/Audio/footstep_concrete_000.ogg',
      'assets/audio/ImpactSounds/Audio/footstep_concrete_001.ogg',
      'assets/audio/ImpactSounds/Audio/footstep_concrete_002.ogg',
      'assets/audio/ImpactSounds/Audio/footstep_concrete_003.ogg',
      'assets/audio/ImpactSounds/Audio/footstep_concrete_004.ogg',
    ],
    powerup_activate: ['assets/audio/Music Jingles/Audio (Steeldrum)/jingles-steel_00.ogg'],
    spawn_protection_end: ['assets/audio/InterfaceSounds/Audio/click_003.ogg'],
    siege_wall_drop: ['assets/audio/ImpactSounds/Audio/impactMetal_heavy_003.ogg'],
    siege_wall_warning: ['assets/audio/InterfaceSounds/Audio/minimize_001.ogg'],
    barrel_explode: [
      'assets/audio/ImpactSounds/Audio/impactBell_heavy_003.ogg',
      'assets/audio/ImpactSounds/Audio/impactBell_heavy_004.ogg',
    ],
  },
  music: {
    menu: 'assets/audio/Music Loops/Retro/Retro Beat.ogg',
    lobby: 'assets/audio/Music Loops/Loops/Wacky Waiting.ogg',
    gameplay: 'assets/audio/Music Loops/Loops/Mission Plausible.ogg',
    results: 'assets/audio/Music Loops/Loops/Game Over.ogg',
  },
  voiceover: {
    countdown_3: 'assets/audio/VoiceoverPack/Audio (Female)/3.ogg',
    countdown_2: 'assets/audio/VoiceoverPack/Audio (Female)/2.ogg',
    countdown_1: 'assets/audio/VoiceoverPack/Audio (Female)/1.ogg',
    go: 'assets/audio/VoiceoverPack/Audio (Female)/go.ogg',
    hurry_up: 'assets/audio/VoiceoverPack/Audio (Female)/hurry_up.ogg',
    power_up: 'assets/audio/VoiceoverPack/Audio (Female)/power_up.ogg',
  },
  ui: {
    /**
     * Cursor PNGs are referenced as DOM CSS `url()` values for the OS pointer
     * via `scene.input.setDefaultCursor(url(...))`. The browser needs a real
     * file URL here — an atlas frame cannot be a CSS cursor — so these two PNGs
     * remain standalone files outside the atlases.
     */
    cursor: {
      pointer_toon_a: 'assets/UI/cursor/pointer_toon_a.png',
      target_round_a: 'assets/UI/cursor/target_round_a.png',
    },
    fonts: {
      kenney_bold: {
        woff: 'assets/UI/fonts/kenney_bold-webfont.woff',
        woff2: 'assets/UI/fonts/kenney_bold-webfont.woff2',
        familyName: 'Kenney Bold',
      },
      /** Google Font loaded via CSS link in index.html — no local file */
      caveat: {
        familyName: 'Caveat',
        googleFont: true,
      },
    },
  },
} as const;
