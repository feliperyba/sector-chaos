import Phaser from 'phaser';
import { AssetManifest, loadAtlases } from '../assets/AssetManifest.js';
import { getSharedAudioService, SharedAudioService } from '../audio/SharedAudioService.js';
import { FontFamilies, waitForFont } from '../assets/FontLoader.js';
import { Button } from '../ui/components/Button.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import { MenuEntranceChoreographer } from '../ui/animations/MenuEntranceChoreographer.js';
import { MenuBackground, getMenuDioramaTitlePalette } from '../ui/layers/MenuBackground.js';
import type { MenuDioramaTitlePalette } from '../ui/layers/MenuBackground.js';
import type { MenuEntranceLayout } from '../ui/animations/MenuEntranceChoreographer.js';
import { SceneNavigator } from '../ui/transitions/SceneNavigator.js';
import { SCENE_KEYS } from '../ui/transitions/TransitionConfig.js';
import { MenuDirector } from '../ui/menu/MenuDirector.js';
import { SettingsModal } from '../ui/menu/SettingsModal.js';
import { attachSoftShadowPuddle } from '../ui/SoftShadow.js';

const BUTTON_MIN_WIDTH = 260;
const BUTTON_MAX_WIDTH = 390;
const BUTTON_WIDTH_RATIO = 0.74;
const BUTTON_HEIGHT = 66;
const BUTTON_GAP = 24;

const TITLE_Y_FRACTION = 0.18;
const BUTTON_Y_FRACTION = 0.48;

/**
 * Title backlight — a warm radial glow pooled BEHIND the logo so the title
 * floats over it (the "lit from under" impression). The glyph itself is NOT
 * captured into the lighting pipeline (capturing a flat decal washed/tinted its
 * face = read as light ON TOP, not behind); this glow carries the warm tone
 * instead. Additive over the lit diorama; flickered for a reactive feel.
 */
const TITLE_BACKLIGHT_ALPHA = 0.32;
const TITLE_BACKLIGHT_ALPHA_FLICKER = 0.44;
/** Glow diameter as a multiple of the logo width (extends past the glyphs). */
const TITLE_BACKLIGHT_SCALE = 1.9;
/** Glow center offset toward the campfire (fraction of logo height, + = down). */
const TITLE_BACKLIGHT_Y_OFFSET = 0.15;

/**
 * UI drop shadows — the depth cue. The title/buttons are flat decals on slot 0;
 * without a cast shadow they read as pasted-on. A soft, offset, from-above
 * shadow (light upper-left → shadow lower-right, the standard UI lighting
 * convention) makes each element read as lifted off the diorama. No blur filter
 * is used (no precedent in the codebase + unverified in WebGL); instead the
 * title stacks N logo-shaped layers at increasing offset + decreasing alpha to
 * synthesize a soft edge, and the buttons sit over a wide+short dark radial
 * "puddle". Tinted deep warm (title-stroke family) so the shadow reads as cast
 * shadow, not a black blob.
 */
const TITLE_SHADOW_TINT = 0x140d08; // deep warm (menuTitleStroke family)
const TITLE_SHADOW_LAYERS = [
  { dx: 3, dy: 6, alpha: 0.5 },
  { dx: 4, dy: 12, alpha: 0.36 },
  { dx: 5, dy: 20, alpha: 0.22 },
] as const;

export class MainMenuScene extends Phaser.Scene {
  private audio!: SharedAudioService;

  private choreographer: MenuEntranceChoreographer | null = null;
  private menuDirector: MenuDirector | null = null;
  private settingsModal: SettingsModal | null = null;
  private navigator!: SceneNavigator;

  private fadeOverlay!: Phaser.GameObjects.Rectangle;
  private menuBackground: MenuBackground | null = null;
  private impactLayer!: Phaser.GameObjects.Container;
  private titleGroup!: Phaser.GameObjects.Container;
  private titleSquashLayer!: Phaser.GameObjects.Container;
  private buttonContainers: Phaser.GameObjects.Container[] = [];

  private logoSprite!: Phaser.GameObjects.Sprite;
  /** Warm radial glow pooled behind the logo (the "lit from under" impression). */
  private titleBacklight!: Phaser.GameObjects.Sprite;

  private buttons: Button[] = [];
  private idleStarted = false;

  constructor() {
    super('MainMenuScene');
  }

  preload(): void {
    loadAtlases(this);

    // The single audio sprite sheet covers SFX, music, and voiceover.
    // Loaded in preload so it is in cache before create() calls playMusic.
    this.audio = getSharedAudioService(this.game);
    this.audio.loadAll(this);

    // The diamond wipe transition shader is NO LONGER loaded here — ticket 02
    // made `src/shaders/transition.frag` the single source, inlined into
    // TransitionScene via Vite `?raw` (no shader cache, no public/ copy, no
    // runtime fetch that can serve a stale or missing file).

    // Light cookie textures (lighting pipeline ticket 07). These are the
    // 512x512 grayscale radial-gradient falloff masks the HdrLit shader samples
    // at slots 2/3/4 to give lights a non-circular natural glow. They MUST be
    // registered as standalone texture keys (the vfx atlas also has
    // 'light_01/02/03' frames, but the pipeline's `add.shader(inputKeys)` binds
    // by standalone key, not atlas frame). Loaded here (the shared preload
    // scene) so they're in the global texture cache before GameScene boots the
    // lighting pipeline. Idempotent via exists() guard.
    for (const key of ['light_01', 'light_02', 'light_03']) {
      if (!this.textures.exists(key)) {
        this.load.image(key, `assets/${key}.png`);
      }
    }
  }

  async create(): Promise<void> {
    // Phaser 4 does NOT auto-invoke the Scene's `shutdown` method (only
    // `update` is auto-bound — see SceneManager.create, `sys.sceneUpdate`).
    // Without this binding, `shutdown()` below is dead code: the scene's
    // `menuBackground`/`menuDirector` survive a stop→start reboot as stale
    // references to destroyed pipelines, and the async `create()` font-await
    // window below drives one of them → `albedoRT.camera` is null →
    // `setScroll` TypeError every frame. GameScene.ts:358 uses this exact
    // pattern; the three menu/transition scenes must too.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);

    await Promise.all([waitForFont(FontFamilies.kenneyBold), waitForFont(FontFamilies.caveat)]);

    const { width, height } = this.scale;

    this.input.setDefaultCursor(`url('${AssetManifest.ui.cursor.pointer_toon_a}'), pointer`);

    this.audio.setFadeScene(this);

    this.navigator = new SceneNavigator(this);

    // MenuBackground owns the lit medieval diorama + parallax + atmosphere
    // (ticket 06). Replaces the flat `solidBg` rect + `LogoPatternLayer`. It
    // takes over depth bands `background`(0)/+1/+2 (the 3 baked RTs); the
    // logo/buttons (depth `sceneUi+1`=1001) + `fadeOverlay` (`overlay`=1100)
    // stay exactly where they are — the pipeline composites them on slot 0.
    this.menuBackground = new MenuBackground({ variant: 'mainMenu' });
    this.menuBackground.boot(this);

    // Resolve the title-flare palette from the picked diorama variant so the
    // impact particles + ring waves + glow match the backdrop's tones (warm
    // fire + the variant's biome accent) instead of the hardcoded warm-only
    // ember set. boot() above is synchronous, so getVariantId() is set; the
    // 'forest-bonfire' fallback is purely defensive (never hit in practice).
    const variantId = this.menuBackground.getVariantId();
    const titlePalette: MenuDioramaTitlePalette = getMenuDioramaTitlePalette(
      variantId ?? 'forest-bonfire',
    );

    this.fadeOverlay = this.add.rectangle(
      width / 2,
      height / 2,
      width,
      height,
      DesignTokens.colors.black,
    );
    this.fadeOverlay.setAlpha(1);
    this.fadeOverlay.setDepth(DesignTokens.depth.overlay);
    this.fadeOverlay.setScrollFactor(0);

    const titleX = width / 2;
    const titleY = height * TITLE_Y_FRACTION;

    this.titleGroup = this.add.container(titleX, titleY);
    this.titleGroup.setDepth(DesignTokens.depth.sceneUi + 1);
    // The MenuBackground drives the camera scroll for parallax (ticket 06);
    // pin the UI to the screen so it doesn't drift with the backdrop. The
    // entrance choreographer tweens positions/scale/alpha — scrollFactor is
    // independent of those, so this is a non-invasive render-layer concern.
    this.titleGroup.setScrollFactor(0);

    this.titleSquashLayer = this.add.container(0, 0);
    this.titleGroup.add(this.titleSquashLayer);

    // Logo is a generated Phaser.Text captured to a canvas texture. Ticket 03
    // chose option (a): re-tint/emboss (no new art). The `menuTitle*` tokens are
    // wired LIVE here — text reads menuTitleText (cream), with a menuTitleStroke
    // (deep ember) painted as relief. The logo stays a crisp decal at depth 1001
    // (≥ the pipeline's 500 capture cutoff) — it is NOT captured into the
    // albedo. Capturing a flat glyph lit its face uniformly (albedo × light) and
    // read as a tinted wash ON TOP of the title, not light from behind. Instead
    // a warm backlight glow is seated behind the logo (see titleBacklight below)
    // so the logo floats over a pooled glow = the "lit from under" impression.
    const titleColor = '#' + DesignTokens.color.menuTitleText.toString(16).padStart(6, '0');
    const titleStroke = '#' + DesignTokens.color.menuTitleStroke.toString(16).padStart(6, '0');
    const logoText = this.add.text(0, 0, 'SECTOR CHAOS', {
      fontFamily: DesignTokens.font.family,
      fontSize: '72px',
      color: titleColor,
      stroke: titleStroke,
      strokeThickness: 6,
      align: 'center',
    });
    logoText.setOrigin(0.5, 0.5);

    const logoTextureKey = 'logo_generated';
    if (!this.textures.exists(logoTextureKey)) {
      this.textures.addCanvas(logoTextureKey, logoText.canvas);
    }
    const logoTexWidth = this.textures.get(logoTextureKey).get(0).width;
    logoText.destroy();

    const logoScale = (width * 0.36) / logoTexWidth;

    // Soft drop shadow — stacked logo-shaped layers at increasing offset +
    // decreasing alpha synthesize a soft edge (no blur filter). Seated behind
    // the logo (added before it) + offset lower-right (light upper-left = the
    // standard UI depth cue). These bob with the title via titleSquashLayer.
    for (const layer of TITLE_SHADOW_LAYERS) {
      const shadow = this.add.sprite(layer.dx, layer.dy, logoTextureKey);
      shadow.setOrigin(0.5, 0.5);
      shadow.setTint(TITLE_SHADOW_TINT);
      shadow.setAlpha(layer.alpha);
      shadow.setScale(logoScale);
      this.titleSquashLayer.add(shadow);
    }

    this.logoSprite = this.add.sprite(0, 0, logoTextureKey);
    this.logoSprite.setOrigin(0.5, 0.5);
    this.logoSprite.setScale(logoScale);
    this.titleSquashLayer.add(this.logoSprite);

    this.impactLayer = this.add.container(0, this.logoSprite.displayHeight / 2);
    this.titleGroup.add(this.impactLayer);
    this.titleGroup.moveTo(this.impactLayer, 0);

    // ── Backlight glow behind the title (the "lit from under" impression) ──
    // The logo is a crisp decal (NOT captured into the albedo — capturing it
    // washed/tinted the glyph, reading as light ON TOP). This warm radial pool
    // sits behind the logo at depth `sceneUi` (one below the title's sceneUi+1)
    // and one notch toward the campfire, so the title floats over it. Additive
    // over the lit diorama; tinted with the variant's warm tone (matches the
    // campfire); a slow flicker tween gives a reactive, fire-lit feel. Reuses
    // the radial 'light_01' cookie (loaded in preload). Knobs at the top of file.
    this.titleBacklight = this.add.sprite(
      titleX,
      titleY + this.logoSprite.displayHeight * TITLE_BACKLIGHT_Y_OFFSET,
      'light_01',
    );
    this.titleBacklight.setOrigin(0.5, 0.5);
    this.titleBacklight.setDepth(DesignTokens.depth.sceneUi);
    this.titleBacklight.setScrollFactor(0);
    this.titleBacklight.setTint(titlePalette.warm);
    this.titleBacklight.setBlendMode(Phaser.BlendModes.ADD);
    this.titleBacklight.setScale(
      (this.logoSprite.displayWidth * TITLE_BACKLIGHT_SCALE) / this.titleBacklight.width,
    );
    this.titleBacklight.setAlpha(TITLE_BACKLIGHT_ALPHA);
    this.tweens.add({
      targets: this.titleBacklight,
      alpha: { from: TITLE_BACKLIGHT_ALPHA, to: TITLE_BACKLIGHT_ALPHA_FLICKER },
      duration: 1100,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });

    this.buttonContainers = [];
    this.buttons = [];

    const buttonW = Math.min(
      BUTTON_MAX_WIDTH,
      Math.max(BUTTON_MIN_WIDTH, width * BUTTON_WIDTH_RATIO),
    );
    const buttonStartY = height * BUTTON_Y_FRACTION;

    const buttonConfigs: Array<{
      label: string;
      variant: 'primary' | 'secondary' | 'danger';
      disabled: boolean;
      handler?: () => void;
    }> = [
      {
        label: 'JOIN',
        variant: 'primary',
        disabled: false,
        handler: () => {
          if (this.menuDirector) {
            this.menuDirector.transitionToScene(SCENE_KEYS.MATCHMAKING, this.navigator);
          }
        },
      },
      {
        label: 'TEST SCENE',
        variant: 'danger',
        disabled: false,
        handler: () => {
          if (this.menuDirector) {
            // The TEST SCENE is a dev preview for gameplay/visual sanity and
            // must load the hand-authored demo TMX map — NOT a procedural
            // seeded map (that path is reserved for live multiplayer; verify
            // mood via the seeded dev preview instead). Ticket 15 (d7e9867)
            // flipped this literal to 'seeded' to give the lighting tickets a
            // lit map to verify against; that rationale is now satisfied by
            // the live seeded multiplayer path, so the literal reverts to
            // 'demo'. See .scratch/lighting-system-2/01-findings/B3-test-scene-map-regression.md.
            this.menuDirector.transitionToScene(SCENE_KEYS.GAME, this.navigator, {
              mapType: 'demo',
            });
          }
        },
      },
      {
        label: 'SETTINGS',
        variant: 'secondary',
        disabled: false,
        handler: () => {
          this.settingsModal?.open();
        },
      },
    ];

    for (let i = 0; i < buttonConfigs.length; i++) {
      const cfg = buttonConfigs[i]!;

      const container = this.add.container(titleX, buttonStartY + i * (BUTTON_HEIGHT + BUTTON_GAP));
      container.setDepth(DesignTokens.depth.sceneUi + 1);
      // Pin to screen (MenuBackground drives camera scroll for parallax — see
      // titleGroup comment above).
      container.setScrollFactor(0);
      container.setSize(buttonW, BUTTON_HEIGHT);
      this.buttonContainers.push(container);

      // Soft cast-shadow puddle under the button — a wide+short dark radial
      // that reads as the button lifted off the diorama (depth). Added as the
      // button container's back-most child so it follows the entrance tween.
      attachSoftShadowPuddle(container, buttonW, BUTTON_HEIGHT);

      const button = new Button(this, 0, 0, {
        label: cfg.label,
        variant: cfg.variant,
        width: buttonW,
        height: BUTTON_HEIGHT,
        disabled: true,
      });
      container.add(button);

      if (cfg.handler) {
        button.on('button.click', cfg.handler);
      }

      this.buttons.push(button);
    }

    const layout = this.calculateLayout(width, height);

    this.choreographer = new MenuEntranceChoreographer({
      scene: this,
      fadeOverlay: this.fadeOverlay,
      titleLayer: this.titleGroup,
      titleSquashLayer: this.titleSquashLayer,
      impactLayer: this.impactLayer,
      buttonContainers: this.buttonContainers,
      camera: this.cameras.main,
      titlePalette,
      onButtonsReady: () => {
        for (let i = 0; i < this.buttons.length; i++) {
          if (!buttonConfigs[i]!.disabled) {
            this.buttons[i]!.setDisabled(false);
          }
        }

        for (const button of this.buttons) {
          const content = button.getContent();
          this.tweens.add({
            targets: content.face,
            scaleX: 1.03,
            scaleY: 0.97,
            duration: 800,
            ease: 'Sine.easeInOut',
            yoyo: true,
            repeat: 2,
            delay: 200,
          });
        }
      },
    });

    this.choreographer.play(layout);

    this.menuDirector = new MenuDirector({
      scene: this,
      audio: this.audio,
      choreographer: this.choreographer,
      onEntranceComplete: () => {
        if (!this.idleStarted) {
          this.idleStarted = true;
          this.startTitleIdleAnimation();
        }
      },
    });
    this.menuDirector.start();

    // Settings modal — built lazily on first open; owns its ESC key + input
    // blocking while visible. Destroyed on shutdown with the rest of the UI.
    this.settingsModal = new SettingsModal(this, this.audio);

    this.input.once('pointerdown', () => {
      this.audio.unlockAudioContext();
    });

    SceneNavigator.requestReveal(this);

    if ((window as unknown as Record<string, unknown>).__SECTO_DEBUG__ || import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__SECTO_DEBUG__ = {
        // The console helper is a dev-entry point (NOT the TEST SCENE button,
        // NOT the live matchmaking path). Defaulting it to 'demo' keeps the
        // no-arg `__SECTO_DEBUG__.goToGame()` consistent with the TEST SCENE
        // literal above; pass 'seeded' explicitly for mood/A/B regression.
        // Ticket 15 (d7e9867) flipped this default to 'seeded'; reverted per
        // B3 findings (dev-entry only, live path unaffected).
        goToGame: (roomName?: string, botFillTo?: number) => {
          if (this.menuDirector) {
            this.menuDirector.transitionToScene(SCENE_KEYS.GAME, this.navigator, {
              mapType: 'demo',
              roomName,
              botFillTo: botFillTo ?? 4,
            });
          }
        },
        goToMatchmaking: () => {
          if (this.menuDirector) {
            this.menuDirector.transitionToScene(SCENE_KEYS.MATCHMAKING, this.navigator);
          }
        },
        scene: () => this.scene.key,
      };
    }
  }

  update(time: number, delta: number): void {
    // MenuBackground drives parallax + 05's fire/aura + the lighting pipeline
    // (replaces the old `logoPatternLayer.updateDrift` call — ticket 06).
    this.menuBackground?.update(time, delta);
    this.menuDirector?.update(time, delta);
  }

  shutdown(): void {
    this.settingsModal?.destroy();
    this.settingsModal = null;
    this.menuDirector?.destroy();
    this.menuDirector = null;
    this.menuBackground?.destroy();
    this.menuBackground = null;
    this.choreographer = null;
    this.idleStarted = false;
  }

  private startTitleIdleAnimation(): void {
    this.tweens.add({
      targets: this.titleSquashLayer,
      y: { from: -3, to: 3 },
      duration: 3000,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });
  }

  private calculateLayout(screenWidth: number, screenHeight: number): MenuEntranceLayout {
    const cx = screenWidth / 2;
    const titleY = screenHeight * TITLE_Y_FRACTION;
    const buttonStartY = screenHeight * BUTTON_Y_FRACTION;
    const buttonW = Math.min(
      BUTTON_MAX_WIDTH,
      Math.max(BUTTON_MIN_WIDTH, screenWidth * BUTTON_WIDTH_RATIO),
    );

    for (const container of this.buttonContainers) {
      container.setSize(buttonW, BUTTON_HEIGHT);
    }

    const buttonTargets: { x: number; y: number }[] = [];
    for (let i = 0; i < this.buttonContainers.length; i++) {
      buttonTargets.push({
        x: cx,
        y: buttonStartY + i * (BUTTON_HEIGHT + BUTTON_GAP),
      });
    }

    return {
      titleX: cx,
      titleY,
      subtitleY: titleY + 176,
      buttonTargets,
    };
  }
}
