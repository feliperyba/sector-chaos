// ---------------------------------------------------------------------------
// Menu Animation Config
// ---------------------------------------------------------------------------

/**
 * Timing, easing, and visual constants for the main-menu choreography.
 *
 * Adapted from pixi-gamelab's MenuConfig.animation (GSAP) to Phaser tweens:
 *   - GSAP easing strings → Phaser easing strings
 *   - GSAP seconds       → Phaser milliseconds (×1000)
 *   - Pink color scheme   → Monochrome white/grey/black
 *
 * All durations in MILLISECONDS. All easing strings are Phaser-compatible.
 *
 * @see Issue #46
 * @see references/pixi-gamelab/src/features/menu/config/MenuConfig.ts
 */

/** Monochrome palette for menu highlights (Issue #66) */
const mono = {
  primary: 0x555566,
  deep: 0x333344,
  gold: 0xaaaaaa,
  white: 0xffffff,
} as const;

/**
 * Ember palette for the impact glow + ring waves — palette A (tickets 03/07).
 * Replaces the cool `mono` values the impact color fields used to read; the
 * particle burst (`ImpactEffect.BURST_TINTS`) uses the same family. Gradient
 * reads "fire igniting": hot brass core (glow + inner ring), cooling to forge
 * (middle ring), with a luminous cream halo (outer ring). Only the 4 impact
 * color fields were repointed to this; `mono` stays as the `MenuAnim.colors`
 * export. Timing/structure (alphas, strokes, radii, durations) UNTOUCHED.
 */
const ember = {
  brass: 0xc89456, // glow + ring 0 (was mono.primary) — hot core aura
  forge: 0x9a2a1a, // ring 1 (was mono.deep) — deep cooling ember
  cream: 0xfff4e0, // ring 2 (was mono.gold) — luminous outer halo
  whiteHot: 0xffffff,
} as const;

export const MenuAnim = {
  /** Fade overlay transition at scene start */
  fadeIn: {
    duration: 420,
    ease: 'Quad.easeOut' as const,
  },

  /** Title drop + bounce + settle */
  title: {
    /** Y offset above target for starting position (px) */
    startY: -200,
    /** Starting rotation (radians, slight tilt) */
    startRotation: -0.1,
    /** Rotation at bounce peak (radians) */
    bounceRotation: 0.06,
    /** Starting scale */
    startScale: 0.4,
    /** Scale at overshoot peak */
    overshootScale: 1.08,
    /** Duration of initial drop (ms) */
    dropDuration: 450,
    /** Y offset below target at overshoot (px) */
    overshootY: 50,
    /** Easing for the drop */
    dropEase: 'Quad.easeOut' as const,
    /** Post-bounce rotation wobble steps */
    settleSteps: [
      { rotation: -0.025, duration: 60 },
      { rotation: 0.015, duration: 50 },
      { rotation: 0, duration: 70 },
    ] as const,
  },

  /** Squash/stretch bounce phases (4 phases with decreasing amplitude) */
  bounce: {
    phases: [
      { y: -20, rot: -0.03, squashX: 0.82, squashY: 1.25, dur: 140 },
      { y: 15, rot: 0.02, squashX: 1.18, squashY: 0.82, dur: 120 },
      { y: -6, rot: -0.012, squashX: 0.94, squashY: 1.08, dur: 100 },
      { y: 0, rot: 0, squashX: 1, squashY: 1, dur: 80 },
    ] as const,
    /** Elastic settle after phases complete (ms) */
    settleDuration: 280,
    settleEase: 'Elastic.easeOut' as const,
    /** Which phase index triggers the impact callback */
    impactPhaseIndex: 1,
    /** Squash duration as ratio of phase duration */
    squashDurationRatio: 0.8,
  },

  /** Impact flash: glow ellipse + ring waves + particle burst */
  impact: {
    glow: {
      radiusX: 350,
      radiusY: 80,
      color: ember.brass,
      alpha: 0.3,
      startScale: 0.6,
      targetScale: 1.5,
      duration: 400,
      ease: 'Quad.easeOut' as const,
      coreRadiusX: 200,
      coreRadiusY: 50,
      coreAlpha: 0.5,
      coreDuration: 250,
    },
    rings: {
      waves: [
        {
          radiusX: 420,
          radiusY: 70,
          stroke: 8,
          color: ember.brass,
          alpha: 0.55,
          startScale: 0.4,
          targetScale: 1.6,
          duration: 800,
          ease: 'Quad.easeOut' as const,
          delay: 0,
        },
        {
          radiusX: 480,
          radiusY: 80,
          stroke: 5,
          color: ember.forge,
          alpha: 0.4,
          startScale: 0.35,
          targetScale: 1.45,
          duration: 900,
          ease: 'Quad.easeOut' as const,
          delay: 40,
        },
        {
          radiusX: 540,
          radiusY: 95,
          stroke: 3,
          color: ember.cream,
          alpha: 0.25,
          startScale: 0.3,
          targetScale: 1.3,
          duration: 1050,
          ease: 'Quad.easeOut' as const,
          delay: 80,
        },
      ] as const,
    },
    burst: {
      particlesPerWave: 14,
      emitterLifetime: 300,
      maxParticles: 35,
      lifetimeMin: 1800,
      lifetimeMax: 2800,
      speedStart: 380,
      speedMid: 128,
      speedEnd: 0,
      speedMinMult: 0.6,
      spawnWidth: 850,
      spawnHeight: 70,
      scaleStart: 0,
      scalePeak: 0.65,
      scalePeakTime: 50,
      scaleHold: 0.75,
      scaleHoldTime: 450,
      scaleEnd: 0.35,
      scaleMinMult: 0.25,
      gravity: 200,
    },
  },

  /** Subtitle reveal after title settles */
  subtitle: {
    /** Y offset below final position at start (px) */
    startOffsetY: 28,
    /** Starting scale */
    startScale: 0.84,
    /** Reveal duration (ms) */
    duration: 420,
    /** Delay after title settle before reveal (ms) */
    delay: 450,
    /** Reveal easing */
    ease: 'Elastic.easeOut' as const,
  },

  /** Button entrance sequence */
  buttons: {
    /** Delay from scene start before first button enters (ms) */
    readyDelay: 1000,
    /** Delay when all buttons are settled → enable interactive (ms from start) */
    completeDelay: 1700,
    /** Stagger between successive buttons (ms) */
    stagger: 120,
    /** Y offset below target at start (px) */
    startOffsetY: 100,
    /** Starting rotation per button (radians) */
    rotations: [0.08, -0.06, 0.05] as const,
    /** Starting scale */
    startScale: 0.3,
    /** Phase 1: overshoot */
    overshoot: {
      duration: 280,
      overshootY: 20,
      scale: 1.15,
      ease: 'Back.easeOut' as const,
    },
    /** Phase 2: undershoot */
    undershoot: {
      duration: 100,
      undershootY: 8,
      scale: 0.92,
      ease: 'Quad.easeOut' as const,
    },
    /** Phase 3: settle bounce */
    settleBounce: {
      duration: 120,
      settleY: 3,
      scale: 1.04,
      ease: 'Back.easeOut' as const,
    },
    /** Phase 4: rest */
    rest: {
      duration: 180,
      ease: 'Elastic.easeOut' as const,
    },
    /** Post-entrance glow pulse */
    glowPulse: {
      scaleX: 1.03,
      scaleY: 0.97,
      duration: 800,
      delay: 200,
      repeat: 2,
      ease: 'Sine.easeInOut' as const,
    },
  },

  /** Camera shake on title impact */
  shake: {
    duration: 200,
    intensity: 0.005,
  },

  /** Monochrome color constants for impact/glow effects */
  colors: mono,

  /** Total choreography timeline length (ms) */
  totalDuration: 2000,
} as const;
