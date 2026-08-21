/**
 * Design Tokens — Single source of truth for ALL UI constants.
 *
 * Every UI component, scene, and choreographer reads from here.
 * Zero magic numbers anywhere else. Values are `as const` for full type inference.
 *
 * Inspired by angry-aliens-phaser's token system.
 *
 * @see ADR 0004 (Color palette decision)
 * @see Issue #27
 */

// ---------------------------------------------------------------------------
// Color Tokens
// ---------------------------------------------------------------------------

/** Semantic color tokens derived from the gameplay palette. */
export const colors = {
  /** Pure black — overlays, backgrounds */
  black: 0x000000,
  /** Near-black — row backgrounds, dark panels */
  nearBlack: 0x111111,
  /** Darkest gray — slot backgrounds */
  darkestGray: 0x222222,
  /** Darker gray — slot borders */
  darkerGray: 0x333333,
  /** Dark gray — inactive slot borders */
  darkGray: 0x444444,
  /** Medium gray — minimap walkable terrain */
  mediumGray: 0x555555,
  /** Gray — depleted dash bar */
  gray: 0x666666,
  /** Light gray — disabled button tint */
  lightGray: 0x888888,
  /** Lighter gray — header backgrounds */
  lighterGray: 0xaaaaaa,
  /** Pale gray — active weapon slot highlight (no weapon) */
  paleGray: 0xbbbbcc,
  /** White — default text, default tint */
  white: 0xffffff,

  // --- Semantic gameplay colors ---

  /** Health bar (full), power-up: speed, pickup icon: health */
  green: 0x44ff44,
  /** Fresh-spawn aura, extracted weapons */
  mintGreen: 0x44ffaa,
  /** Tier 1 accent */
  emerald: 0x37d98c,
  /** Health bar (mid) / durability bar (mid) */
  yellow: 0xffff44,
  /** Active weapon slot highlight, speed-boost aura, target zone ring */
  amber: 0xffaa00,
  /** Tier 3 (legendary) gold */
  gold: 0xffd700,
  /** Health bar (low) / durability bar (low) */
  red: 0xff4444,
  /** Zone ring (current) */
  brightRed: 0xff0000,
  /** Danger overlay — outside zone */
  dangerRed: 0xff4400,
  /** Damage tint — low-HP entities */
  pink: 0xff8888,
  /** Explosion tint — bright warm */
  warmYellow: 0xffee88,
  /** Explosion tint — mid warm */
  warmOrange: 0xff8800,
  /** Explosion tint — golden */
  goldenOrange: 0xffcc44,
  /** Explosion tint — fire */
  fireOrange: 0xff8844,
  /** Explosion tint — dark fire */
  darkOrange: 0xff6622,
  /** Explosion tint — ember */
  ember: 0xffaa33,
  /** Explosion scorch mark — dark */
  scorch: 0x221100,
  /** Damage number — explosion-sourced */
  explosionTint: 0xff8844,
  /** Damage number — default */
  damageDefault: 0xffffff,

  // --- Power-up / status colors ---

  /** Barrier aura, shield pickup, dash bar */
  blue: 0x4488ff,
  /** Tier 2 accent */
  royalBlue: 0x5b7fff,
  /** Stagger overlay */
  staggerRed: 0xff4444,
  /** Minimap — player dot */
  cyan: 0x00ffff,
  /** Player-highlighted row in results */
  highlightGreen: 0x00ff88,
  /** Silver medal (2nd place) */
  silver: 0xc0c0c0,
  /** Bronze medal (3rd place) */
  bronze: 0xcd7f32,
  /** Map tile — background */
  mapBackground: 0x1a1a2e,
  /** Map tile — indestructible wall tint */
  indestructible: 0xbbbbcc,
  /** Map tile — chest (brown) */
  chestBrown: 0x8b4513,
  /** Map tile — wood */
  woodDark: 0x4a3a2a,
  /** Map tile — wood light */
  woodLight: 0xd2691e,
  /** Map tile — dark red */
  darkRed: 0x8b0000,
  /** Map tile — grass */
  grass: 0x00ff00,
  /** Exhaustion smoke tint */
  smokeGray: 0x333333,

  // --- Semantic component aliases ---

  /** Positive status — health, success (alias for green) */
  positive: 0x44ff44,
  /** Dark surface — track backgrounds (alias for darkestGray) */
  surfaceDark: 0x222222,
  /** Primary text color (alias for white) */
  ink: 0xffffff,
  /** Surface background — button faces, panels (alias for lighterGray) */
  surface: 0xaaaaaa,
  /** Accent / highlight (alias for amber) */
  accent: 0xffaa00,
  /** Muted / disabled (alias for lightGray) */
  muted: 0x888888,
  /** Destructive / danger (alias for red) */
  destructive: 0xff4444,
  /** Paper — default tint, neutral background (alias for white) */
  paper: 0xffffff,

  // --- Menu-specific palette (Ember on cast iron — medieval restyle, tickets 03/07) ---
  // Palette A per .scratch/menu-revamp/findings/03-identity.md §1. Every hex
  // here is verbatim from that decision — do not invent.

  /** Menu title text — cream (parchment-lit ember) */
  menuTitleText: 0xfff4e0,
  /** Menu title stroke — deep ember outline (painted relief, not real lighting) */
  menuTitleStroke: 0x140d08,
  /** Menu title outer glow — cream (reserved; no glow layer today) */
  menuTitleGlow: 0xfff4e0,
  /** Menu title shadow — pure black drop-shadow */
  menuTitleShadow: 0x000000,
  /** Menu button primary face — oxidized brass */
  menuBtnPrimary: 0xc89456,
  /** Menu button secondary face — cast iron */
  menuBtnSecondary: 0x3a3530,
  /** Menu button danger face — forge/blood ember */
  menuBtnDanger: 0x9a2a1a,
  /** Menu button label text — near-black (label hardcodes #ffffff in Button.ts for contrast on dark faces) */
  menuBtnText: 0x1a120b,
  /** Menu button label stroke — cream */
  menuBtnTextStroke: 0xfff4e0,
  /** Menu subtitle color — parchment cream (rendered on a translucent dark plate) */
  menuSubtitle: 0xd9c79a,
  // `menuVignette` RETIRED (ticket 03): dead token, no readers. The deferred
  // pipeline's screen-space vignette (shaders/lighting/final.frag, strength
  // 0.30) is the sole vignette source for the medieval diorama.
} as const;

// ---------------------------------------------------------------------------
// Font Tokens
// ---------------------------------------------------------------------------

/** Font family and size tokens. */
export const fonts = {
  family: {
    /** Primary UI font — Kenney Bold for hand-drawn game style */
    primary: '"Kenney Bold", "Courier New", monospace',
  },
  size: {
    /** Large title — main menu, results header */
    title: '72px',
    /** Section heading */
    heading: '32px',
    /** Body text — labels, table content */
    body: '22px',
    /** Small text — minimap labels, auxiliary info */
    small: '16px',
    /** Tiny text — timers, compact displays */
    tiny: '12px',
  },
  /** Font styles applied via Phaser Text configuration */
  style: {
    bold: 'bold',
    normal: 'normal',
  },
} as const;

// ---------------------------------------------------------------------------
// Spacing Tokens (4px grid)
// ---------------------------------------------------------------------------

/** Spacing on a 4px base grid. Use these for padding, margins, gaps. */
export const spacing = {
  /** 2px — hairline */
  xs: 2,
  /** 4px — tight */
  sm: 4,
  /** 8px — compact */
  md: 8,
  /** 12px — standard */
  lg: 12,
  /** 16px — comfortable */
  xl: 16,
  /** 20px — generous */
  xxl: 20,
  /** 24px — section gap */
  xxxl: 24,
  /** 32px — large section gap */
  huge: 32,
  /** 40px — major separation */
  massive: 40,
  /** 48px — layout-level spacing */
  colossal: 48,
} as const;

// ---------------------------------------------------------------------------
// Duration Tokens (milliseconds)
// ---------------------------------------------------------------------------

/** Animation durations in milliseconds. */
export const duration = {
  /** 50ms — instant feedback (button click) */
  instant: 50,
  /** 80ms — hover-in, quick reaction */
  fast: 80,
  /** 120ms — hover-out, settle */
  quick: 120,
  /** 200ms — standard transition */
  standard: 200,
  /** 200ms — alias for standard */
  normal: 200,
  /** 300ms — smooth transition, panel reveal */
  smooth: 300,
  /** 500ms — scene entrance, emphasis */
  emphasis: 500,
  /** 800ms — choreographed entrance */
  entrance: 800,
  /** 1000ms — slow dramatic reveal */
  dramatic: 1000,
  /** 1500ms — very slow, cinematic */
  cinematic: 1500,
} as const;

// ---------------------------------------------------------------------------
// Easing Tokens
// ---------------------------------------------------------------------------

/**
 * Phaser-compatible easing strings.
 * Phaser uses string identifiers like 'Quad.easeOut', not GSAP-style objects.
 */
export const easing = {
  /** Linear — no easing */
  linear: 'Linear',
  /** Quad ease-in — slow start */
  quadIn: 'Quad.easeIn',
  /** Quad ease-out — fast start, slow end */
  quadOut: 'Quad.easeOut',
  /** Quad ease-in-out — smooth both ends */
  quadInOut: 'Quad.easeInOut',
  /** Cubic ease-out — snappy deceleration */
  cubicOut: 'Cubic.easeOut',
  /** Cubic ease-in-out — smooth but pronounced */
  cubicInOut: 'Cubic.easeInOut',
  /** Back ease-out — overshoot settle */
  backOut: 'Back.easeOut',
  /** Elastic ease-out — bouncy settle */
  elasticOut: 'Elastic.easeOut',
  /** Bounce ease-out — physical bounce */
  bounceOut: 'Bounce.easeOut',
  /** Bounce — alias for bounceOut */
  bounce: 'Bounce.easeOut' as const,
  /** Snappy — alias for quadOut */
  snappy: 'Quad.easeOut' as const,
  /** Expo ease-out — sharp deceleration */
  expoOut: 'Expo.easeOut',
  /** Sine ease-out — gentle deceleration */
  sineOut: 'Sine.easeOut',
  /** Sine ease-in-out — gentle both ends */
  sineInOut: 'Sine.easeInOut',
} as const;

// ---------------------------------------------------------------------------
// Depth Layer Tokens
// ---------------------------------------------------------------------------

/**
 * Z-depth layers for draw ordering.
 * Lower values render behind higher values.
 * Gaps left intentionally for future layers.
 */
export const depth = {
  /** Background tiles */
  background: 0,
  /** Floor decorations, grid patterns */
  floorDecor: 50,
  /** In-game entities — items on the ground */
  entities: 100,
  /** In-game entities — player sprites */
  players: 200,
  /** Status effect auras (fresh spawn, barrier, speed) */
  statusEffects: 210,
  /** Floating elements — damage numbers, name tags */
  floating: 300,
  /** Visual effects — explosions, particles */
  vfx: 400,
  /**
   * Overlay VFX — world-space particles that render ABOVE the deferred
   * lighting composite but BELOW the HUD (map-polish ticket 30). Objects in
   * this band must be registered out of the lighting world-capture
   * (`excludeFromWorldLightCapture`, LightingAlbedoRtBuilder) so they are
   * neither captured into the albedo RT nor ignored on the main camera —
   * they render into the camera scene texture, which the Final filter
   * alpha-composites OVER the lit world (the HUD's slot-0 path). The beacon
   * motes live here: sparks floating over the crystal glow, not washed into
   * it. 480 keeps a 20-step gap under hudBg and an 80-step gap over the
   * world-VFX band.
   */
  vfxOverlay: 480,
  /** HUD background panels */
  hudBg: 500,
  /** HUD content — bars, slots, text */
  hudContent: 510,
  /** Minimap background */
  minimapBg: 900,
  /** Minimap content */
  minimapContent: 910,
  /** Spectator HUD background */
  spectatorBg: 950,
  /** Spectator HUD content */
  spectatorContent: 951,
  /** Scene UI — menus, modals */
  sceneUi: 1000,
  /**
   * Modal layer — settings modal backdrop + content. Above all scene UI
   * (menu buttons at sceneUi+1), below the scene-transition overlay so the
   * diamond wipe still covers it.
   */
  modal: 1090,
  /** Full-screen overlays — results screen, loading */
  overlay: 1100,
  /** Top-level — cursors, debug */
  top: 1200,
} as const;

// ---------------------------------------------------------------------------
// NineSlice Inset Constants
// ---------------------------------------------------------------------------

/** Inset values for NineSlice textures. Defines corner sizes for slicing. */
export const nineSliceInsets = {
  /** Small corner (16px) — buttons, small panels */
  small: 16,
  /** Medium corner (24px) — medium panels */
  medium: 24,
  /** Large corner (32px) — large panels, modals */
  large: 32,
} as const;

// ---------------------------------------------------------------------------
// Alpha / Opacity Tokens
// ---------------------------------------------------------------------------

/** Commonly reused alpha values. */
export const alpha = {
  /** Fully opaque */
  full: 1,
  /** Semi-transparent overlay */
  semiOverlay: 0.85,
  /** Modal overlay background */
  modalBg: 0.7,
  /** HUD background */
  hudBg: 0.6,
  /** Disabled element */
  disabled: 0.4,
  /** Subtle tint */
  subtle: 0.2,
  /** Faint tint */
  faint: 0.15,
  /** Very faint tint */
  veryFaint: 0.1,
  /** Barely visible */
  ghost: 0.05,
  /** Fully transparent */
  transparent: 0,
} as const;

// ---------------------------------------------------------------------------
// Composite Design Tokens Object
// ---------------------------------------------------------------------------

/** All design tokens in a single frozen object. */
export const DesignTokens = {
  colors,
  fonts,
  spacing,
  duration,
  easing,
  depth,
  nineSliceInsets,
  alpha,

  // --- Semantic shortcuts for component compatibility ---

  /** Alias for .colors */
  color: colors,
  /** Structured font access matching component expectations */
  font: {
    family: fonts.family.primary,
    flavorFamily: 'Caveat',
    size: {
      xs: 10,
      sm: 12,
      md: 16,
      lg: 20,
      xl: 24,
      xxl: 32,
      xxxl: 48,
    },
    lineHeight: {
      sm: 16,
      md: 20,
      lg: 26,
      xl: 32,
      xxl: 40,
    },
  },
  /** NineSlice inset shortcuts for components */
  nineSlice: {
    panel: {
      left: nineSliceInsets.medium,
      right: nineSliceInsets.medium,
      top: nineSliceInsets.medium,
      bottom: nineSliceInsets.medium,
    },
    panelBorder: {
      left: nineSliceInsets.medium,
      right: nineSliceInsets.medium,
      top: nineSliceInsets.medium,
      bottom: nineSliceInsets.medium,
    },
    buttonSquare: {
      left: nineSliceInsets.small,
      right: nineSliceInsets.small,
      top: nineSliceInsets.small,
      bottom: nineSliceInsets.small,
    },
  },
  /** Shadow styling defaults */
  shadow: {
    color: colors.nearBlack,
    alpha: alpha.ghost,
    offset: { x: 2, y: 4 },
  },
} as const;
