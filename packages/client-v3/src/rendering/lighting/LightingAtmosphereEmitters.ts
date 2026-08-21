/**
 * LightingAtmosphereEmitters — the Phaser particle-emitter builders for the
 * atmosphere layer (ticket 12). Extracted from LightingAtmosphere.ts to respect
 * the 450-line file-length lint cap + to avoid `this`-aliasing in the emitter
 * callback closures (the callbacks read shared mutable state — global time +
 * flame anchors — via this bag instead of `const self = this`).
 *
 * Two builders, both returning a configured `ParticleEmitter` (additive blend,
 * world-space depth < hudBg, pooled). The prototype's exact tuning is encoded
 * into onEmit/onUpdate callbacks via the shared-state bag.
 *
 * ── Ticket 21 (atmosphere polish) ──
 *
 * Three additions encoded into the seed tables + emit callbacks (all
 * deterministic via `atmosphereSeed` / `atmosphereParallaxBand` so the Seam A
 * test can assert them):
 *   1. **Parallax depth** — each particle is assigned a parallax band
 *      (`EMBER_PARALLAX_BANDS` / `DUST_PARALLAX_BANDS`); size + speed are
 *      multiplied by the band's `sizeMul` / `speedMul`. Near band = bigger +
 *      faster (closer to camera), far band = smaller + slower (recedes). This
 *      is what makes the layer read as volumetric depth instead of a flat
 *      sheet (research §5 "depth via parallax size/speed").
 *   2. **Viewport-scaled counts** — `maxParticles` is the prototype's 1080p
 *      baseline; `maxAliveParticles` is set runtime-tunable by the controller
 *      via {@link setAtmosphereCounts} (scaled by visible area).
 *   3. **Livelier drift** — `DUST_DRIFT_SPAN` is now 28 (was 8); encoded into
 *      the seed table verbatim, no callback change needed.
 *
 * Reference: `docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:548-580,
 * 731-765` — the values are canonical (spec §"Further Notes": prototype wins).
 */
import Phaser from 'phaser';
import {
  EMBER_COLOR,
  EMBER_POOL_SIZE,
  EMBER_PARALLAX_BANDS,
  EMBER_RISE_MAX,
  EMBER_RISE_MIN,
  EMBER_SIZE_MAX,
  EMBER_SIZE_MIN,
  EMBER_TWINKLE_AMP,
  EMBER_TWINKLE_BASE,
  EMBER_TWINKLE_SPEED_MAX,
  EMBER_TWINKLE_SPEED_MIN,
  EMBER_EMIT_QUANTITY,
  DUST_COLOR,
  DUST_DRIFT_SPAN,
  DUST_PARALLAX_BANDS,
  DUST_POOL_SIZE,
  DUST_SHIMMER_AMP,
  DUST_SHIMMER_BASE,
  DUST_SHIMMER_FREQ,
  DUST_SIZE_MAX,
  DUST_SIZE_MIN,
  DUST_EMIT_QUANTITY,
  ATMOSPHERE_DEPTH,
  atmosphereParallaxBand,
  atmosphereSeed,
  particleScaleForSize,
  type CampfireAnchor,
} from './LightingAtmosphereConfig.js';
import type { SectorAtmosphereTheme } from './LightingAtmosphereThemes.js';
import { SECTOR_SHAPE_TEXTURE_KEY } from './LightingAtmosphereTextures.js';
import { excludeFromWorldLightCapture } from './LightingAlbedoRtBuilder.js';

/** Stable texture key for the generated white-circle particle sprite. */
export const ATMOSPHERE_PARTICLE_TEXTURE = '__atmosphereParticle';

// Ticket 11 (A8 §4.3): the radius→diameter scale fix + the texture-edge size
// live in the Phaser-free config module (LightingAtmosphereConfig.ts) so the
// Seam A vitest can assert the math WITHOUT booting Phaser. Re-exported here
// for grep + callers that import from the emitters module.
export { PARTICLE_TEXTURE_PX, particleScaleForSize } from './LightingAtmosphereConfig.js';

/**
 * Shared mutable state read by the emitter callbacks each particle update. The
 * LightingAtmosphere controller mutates these fields each frame; the callbacks
 * (built once here) re-read them every particle update so twinkle/shimmer stay
 * phase-locked to scene time (matching the prototype's global-`t` formulas).
 */
export interface AtmosphereSharedState {
  /** Global scene time in seconds (drives twinkle/shimmer phase). */
  currentTimeSeconds: number;
  /** Current flame anchors (round-robin-assigned to spawned embers). */
  campfireAnchors: ReadonlyArray<CampfireAnchor>;
  /** Fallback anchor (camera center) used when no flame anchors are registered. */
  fallbackAnchor: CampfireAnchor;
}

/**
 * Phaser EmitterOp callback parameter types (the EmitterOpOnEmit/OnUpdate
 * signatures from phaser.d.ts:93759/93766). Aliased so the inline callbacks
 * get explicit types (TS7006 implicit-any guard).
 */
type Particle = Phaser.GameObjects.Particles.Particle;
type EmitCb = (particle?: Particle, key?: string, value?: number) => number;
type UpdateCb = (particle: Particle, key: string, t: number, value: number) => number;

/** Per-particle seed-index store (stashed on the Phaser Particle via a cast). */
interface EmberParticle extends Particle {
  seedIdx?: number;
}
interface DustParticle extends Particle {
  seedIdx?: number;
}

/**
 * Build the ember emitter. Up to EMBER_COUNT particles (1080p baseline 110),
 * warm tint, rising from flame positions (torches / campfires / candles /
 * dynamic fires). The prototype's twinkle + lifecycle fade are encoded into the
 * alpha onUpdate callback: `alpha = (0.5 + 0.5*sin(t*spd+phase)) * sin(life*PI)`.
 *
 * Ticket 21: per-particle size + rise are multiplied by the band's `sizeMul` /
 * `speedMul` so near-band embers read as bigger + faster (depth).
 */
export function buildEmberEmitter(
  scene: Phaser.Scene,
  shared: AtmosphereSharedState,
): Phaser.GameObjects.Particles.ParticleEmitter {
  // Precompute per-particle seeds so each ember has a stable phase + twinkle
  // speed + size + rise (matches the prototype's deterministic per-i init at
  // prototype.js:555-569), with the parallax-band multipliers folded in. The
  // table covers the full POOL (EMBER_POOL_SIZE = baseline × ceiling) so a 4K
  // viewport's higher maxAliveParticles target finds a deterministic seed for
  // every particle (no seed-table overflow → cyclic reuse).
  const bandCount = EMBER_PARALLAX_BANDS.length;
  const seeds = new Float32Array(EMBER_POOL_SIZE * 6);
  for (let i = 0; i < EMBER_POOL_SIZE; i++) {
    const band =
      EMBER_PARALLAX_BANDS[atmosphereParallaxBand(i, bandCount)] ?? EMBER_PARALLAX_BANDS[0]!;
    seeds[i * 6 + 0] =
      (EMBER_RISE_MIN + atmosphereSeed(i * 7 + 1) * (EMBER_RISE_MAX - EMBER_RISE_MIN)) *
      band.speedMul;
    seeds[i * 6 + 1] = (atmosphereSeed(i * 11 + 3) - 0.5) * 18 * band.speedMul; // horizontal drift
    seeds[i * 6 + 2] =
      (EMBER_SIZE_MIN + atmosphereSeed(i * 13 + 5) * (EMBER_SIZE_MAX - EMBER_SIZE_MIN)) *
      band.sizeMul;
    seeds[i * 6 + 3] = atmosphereSeed(i * 17 + 7) * Math.PI * 2; // twinkle phase
    seeds[i * 6 + 4] =
      EMBER_TWINKLE_SPEED_MIN +
      atmosphereSeed(i * 19 + 9) * (EMBER_TWINKLE_SPEED_MAX - EMBER_TWINKLE_SPEED_MIN);
    seeds[i * 6 + 5] = atmosphereSeed(i * 23 + 11); // life init [0,1)
  }
  // Stable per-particle index counter (the emitCallback assigns the next seed
  // slot modulo EMBER_POOL_SIZE, so respawned embers cycle through the seed table).
  let nextSeedIdx = 0;

  const emitter = scene.add.particles(0, 0, ATMOSPHERE_PARTICLE_TEXTURE, {
    maxParticles: EMBER_POOL_SIZE, // pool ceiling (4K-capable); runtime scales maxAliveParticles down
    frequency: 40, // continuous flow: re-emit as particles die so count stays at the cap
    quantity: EMBER_EMIT_QUANTITY, // 2/cycle keeps the 110 target supplied (~175 pool-capped)
    lifespan: { min: 2500, max: 4500 }, // lifecycle fade (sin(life*PI)) drives the alpha
    scale: {
      onEmit: ((particle: Particle) => {
        const idx = (particle as EmberParticle).seedIdx ?? 0;
        // Ticket 11 (A8 §4.3): radius→diameter fix. `size` is a fillCircle RADIUS;
        // particleScaleForSize yields the scale that reproduces the prototype's
        // 2×size pixel-diameter (was `size / 16`, ~2× too small → sub-pixel far band).
        return particleScaleForSize(seeds[idx * 6 + 2] ?? EMBER_SIZE_MIN);
      }) as EmitCb,
      onUpdate: ((_p: Particle, _k: string, _t: number, value: number) => value) as UpdateCb,
    },
    tint: EMBER_COLOR, // warm body color (white-hot core reads via additive blend)
    alpha: {
      onEmit: (() => 0) as EmitCb,
      onUpdate: ((particle: Particle, _key: string, lifeT: number) => {
        const idx = (particle as EmberParticle).seedIdx ?? 0;
        const phase = seeds[idx * 6 + 3] ?? 0;
        const twinkleSpeed = seeds[idx * 6 + 4] ?? EMBER_TWINKLE_SPEED_MIN;
        const t = shared.currentTimeSeconds;
        const twinkle = EMBER_TWINKLE_BASE + EMBER_TWINKLE_AMP * Math.sin(t * twinkleSpeed + phase);
        const lifeFade = Math.sin(lifeT * Math.PI); // 0→1→0 (prototype.js:743)
        const alpha = twinkle * lifeFade;
        return alpha < 0.02 ? 0 : alpha;
      }) as UpdateCb,
    },
    // Phaser 4 speedX/speedY are emit-only — the prototype assigns velocity once
    // at spawn (prototype.js:562-563); the sin-sway is folded into the emit value
    // via the per-particle phase (a faithful approximation of prototype.js:740).
    speedY: {
      onEmit: ((particle: Particle) =>
        -(seeds[((particle as EmberParticle).seedIdx ?? 0) * 6 + 0] ?? EMBER_RISE_MIN)) as EmitCb,
    },
    speedX: {
      onEmit: ((particle: Particle) => {
        const idx = (particle as EmberParticle).seedIdx ?? 0;
        const drift = seeds[idx * 6 + 1] ?? 0;
        const phase = seeds[idx * 6 + 3] ?? 0;
        return drift * Math.sin(shared.currentTimeSeconds * 2 + phase);
      }) as EmitCb,
    },
    emitZone: {
      source: new Phaser.Geom.Rectangle(-45, -20, 90, 40), // prototype.js:560-561 cluster spread
      type: 'random',
    } as unknown as Phaser.Types.GameObjects.Particles.ParticleEmitterRandomZoneConfig,
    blendMode: 'ADD', // glows against dark (prototype.js:549)
    // Round-robin-assign each particle to a flame anchor + reposition it there
    // at emit (faithful port of prototype.js:556 `cfIdx = floor(seed*n)`).
    // Distributes embers across all flame anchors — NOT all at one fire.
    emitCallback: (particle: Particle) => {
      (particle as EmberParticle).seedIdx = nextSeedIdx;
      const anchorIdx = nextSeedIdx % Math.max(1, shared.campfireAnchors.length);
      const anchor = shared.campfireAnchors[anchorIdx] ?? shared.fallbackAnchor;
      particle.x += anchor.x;
      particle.y += anchor.y;
      nextSeedIdx = (nextSeedIdx + 1) % EMBER_POOL_SIZE;
    },
  });
  emitter.setScrollFactor(1); // world-space (moves with camera)
  // Round 5c: the UNLIT overlay band + out of the world-light capture (ticket
  // 30's mechanism) — additive particles must not be multiplied by the light
  // buffer (invisible on dim maps otherwise).
  emitter.setDepth(ATMOSPHERE_DEPTH);
  excludeFromWorldLightCapture(emitter);
  return emitter;
}

/**
 * The per-emitter dust recipe (round 5c). One per sector (from
 * LightingAtmosphereThemes) + one neutral — each emitter carries its own
 * shape texture, hue, size band, drift, settle and shimmer band, so crossing
 * a sector border swaps the whole particle SILHOUETTE, not just a tint delta.
 */
export interface DustEmitterRecipe {
  /** Body tint (the district's saturated family hue / DUST_COLOR). */
  tint: number;
  /** Texture key (the district's shape / the shared circle for neutral). */
  textureKey: string;
  /** Size band (prototype `size` units — a `fillCircle` RADIUS in px). */
  sizeMin: number;
  sizeMax: number;
  /** Drift-speed multiplier (folds into the seeded vx/vy). */
  speedMul: number;
  /** Constant downward drift (px/s) at emit. */
  driftYBias: number;
  /** Shimmer alpha band + speed (per-frame sin, phase from the seed table). */
  shimmerBase: number;
  shimmerAmp: number;
  shimmerFreq: number;
}

/** The neutral recipe — the pre-ticket global dust behavior (demo/menu/boot). */
export function neutralDustRecipe(): DustEmitterRecipe {
  return {
    tint: DUST_COLOR,
    textureKey: ATMOSPHERE_PARTICLE_TEXTURE,
    sizeMin: DUST_SIZE_MIN,
    sizeMax: DUST_SIZE_MAX,
    speedMul: 1,
    driftYBias: 0,
    shimmerBase: DUST_SHIMMER_BASE,
    shimmerAmp: DUST_SHIMMER_AMP,
    shimmerFreq: DUST_SHIMMER_FREQ,
  };
}

/** Convert a sector theme into its emitter recipe. */
export function sectorDustRecipe(theme: SectorAtmosphereTheme): DustEmitterRecipe {
  return {
    tint: theme.dustTint,
    textureKey: SECTOR_SHAPE_TEXTURE_KEY[theme.shape],
    sizeMin: theme.sizeMin,
    sizeMax: theme.sizeMax,
    speedMul: theme.speedMul,
    driftYBias: theme.driftYBias,
    shimmerBase: theme.shimmerBase,
    shimmerAmp: theme.shimmerAmp,
    shimmerFreq: theme.shimmerFreq,
  };
}

/**
 * Build a dust emitter from a recipe (round 5c: one per sector + one neutral).
 * Per-particle size + drift are multiplied by the parallax band's `sizeMul` /
 * `speedMul` (ticket 21 volumetric depth); the recipe's constants fold into
 * the seed table once at build time — unlike 5b there is NO per-particle
 * position-sampled theming (the emitter IS the theme).
 *
 * Zone contract: `emitZone` is this sector's slice of the camera-follow field
 * (mutated per frame by the controller); `deathZone` is the FULL field rect
 * shared by all dust emitters — motes die off-screen at the field edge, never
 * at an on-screen sector border.
 */
export function buildDustEmitter(
  scene: Phaser.Scene,
  shared: AtmosphereSharedState,
  recipe: DustEmitterRecipe,
  emitZone: Phaser.Geom.Rectangle,
  deathZone: Phaser.Geom.Rectangle,
): Phaser.GameObjects.Particles.ParticleEmitter {
  // Per-particle seeds (prototype.js:571-579) with the parallax-band AND
  // recipe multipliers folded in. The table covers the full POOL
  // (DUST_POOL_SIZE = baseline × ceiling) so a 4K viewport's higher
  // maxAliveParticles target finds a deterministic seed.
  const bandCount = DUST_PARALLAX_BANDS.length;
  const seeds = new Float32Array(DUST_POOL_SIZE * 4);
  for (let i = 0; i < DUST_POOL_SIZE; i++) {
    const band =
      DUST_PARALLAX_BANDS[atmosphereParallaxBand(i, bandCount)] ?? DUST_PARALLAX_BANDS[0]!;
    seeds[i * 4 + 0] =
      (atmosphereSeed(i * 37 + 1) - 0.5) * DUST_DRIFT_SPAN * band.speedMul * recipe.speedMul; // vx
    seeds[i * 4 + 1] =
      (atmosphereSeed(i * 41 + 3) - 0.5) * DUST_DRIFT_SPAN * band.speedMul * recipe.speedMul; // vy
    seeds[i * 4 + 2] =
      (recipe.sizeMin + atmosphereSeed(i * 43 + 5) * (recipe.sizeMax - recipe.sizeMin)) *
      band.sizeMul;
    seeds[i * 4 + 3] = atmosphereSeed(i * 47 + 7) * Math.PI * 2; // shimmer phase
  }
  let nextSeedIdx = 0;

  const emitter = scene.add.particles(0, 0, recipe.textureKey, {
    maxParticles: DUST_POOL_SIZE, // pool ceiling (4K-capable); runtime scales maxAliveParticles down
    frequency: 40,
    quantity: DUST_EMIT_QUANTITY,
    lifespan: { min: 8000, max: 12000 }, // dust motes float, not flicker
    scale: {
      // Ticket 11 (A8 §4.3): radius→diameter fix (Ø = 2 × size; see ember).
      onEmit: ((particle: Particle) => {
        const idx = (particle as DustParticle).seedIdx ?? 0;
        return particleScaleForSize(seeds[idx * 4 + 2] ?? recipe.sizeMin);
      }) as EmitCb,
      onUpdate: ((_p: Particle, _k: string, _t: number, value: number) => value) as UpdateCb,
    },
    tint: recipe.tint, // the district hue — constant per emitter (round 5c)
    alpha: {
      onEmit: (() => 0) as EmitCb,
      onUpdate: ((particle: Particle) => {
        const idx = (particle as DustParticle).seedIdx ?? 0;
        const phase = seeds[idx * 4 + 3] ?? 0;
        return (
          recipe.shimmerBase +
          recipe.shimmerAmp * Math.sin(shared.currentTimeSeconds * recipe.shimmerFreq + phase)
        );
      }) as unknown as UpdateCb,
    },
    speedX: {
      onEmit: ((particle: Particle) =>
        seeds[((particle as DustParticle).seedIdx ?? 0) * 4 + 0] ?? 0) as EmitCb,
    },
    speedY: {
      onEmit: ((particle: Particle) =>
        (seeds[((particle as DustParticle).seedIdx ?? 0) * 4 + 1] ?? 0) +
        recipe.driftYBias) as EmitCb,
    },
    emitZone: {
      source: emitZone, // this sector's slice of the camera-follow field
      type: 'random',
    } as unknown as Phaser.Types.GameObjects.Particles.ParticleEmitterRandomZoneConfig,
    deathZone: {
      source: deathZone, // the FULL field — motes never pop at a sector border
      type: 'onLeave',
    } as unknown as Phaser.Types.GameObjects.Particles.ParticleEmitterDeathZoneConfig,
    blendMode: 'ADD',
    emitCallback: (particle: Particle) => {
      (particle as DustParticle).seedIdx = nextSeedIdx;
      nextSeedIdx = (nextSeedIdx + 1) % DUST_POOL_SIZE;
    },
  });
  emitter.setScrollFactor(1);
  // Round 5c: the UNLIT overlay band + out of the world-light capture — see
  // the ember builder note (ticket 30 mechanism).
  emitter.setDepth(ATMOSPHERE_DEPTH);
  excludeFromWorldLightCapture(emitter);
  return emitter;
}

/**
 * Generate the shared white-circle particle texture (16×16, like the existing
 * ImpactEffect particle precedent). Both embers (tinted warm) and dust motes
 * (tinted cool) sample this; Phaser's particle system applies the per-emitter
 * `tint`. Drawn once at construction; the texture persists in the texture mgr.
 */
export function ensureAtmosphereParticleTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(ATMOSPHERE_PARTICLE_TEXTURE)) return;
  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(8, 8, 8);
  gfx.generateTexture(ATMOSPHERE_PARTICLE_TEXTURE, 16, 16);
  gfx.destroy();
}

/** Remove the generated particle texture (best-effort shutdown). */
export function destroyAtmosphereParticleTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(ATMOSPHERE_PARTICLE_TEXTURE)) {
    scene.textures.remove(ATMOSPHERE_PARTICLE_TEXTURE);
  }
}
