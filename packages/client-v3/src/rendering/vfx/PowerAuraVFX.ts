import type Phaser from 'phaser';
import { DesignTokens } from '../../ui/DesignTokens.js';
import { SpritePool } from './SpritePool.js';

/** `Phaser.BlendModes.ADD` — spelled out so the Phaser import stays type-only. */
const BLEND_MODE_ADD = 1;

/** vfx-atlas particle frames render at 64px; divide target display px by this. */
const PARTICLE_TEX_SIZE = 64;

/** vfx-atlas frames used by the auras (availability-guarded at first attach). */
const BARRIER_GLINT_FRAMES = ['magic_01', 'magic_02', 'magic_03', 'magic_04', 'magic_05'] as const;
const SPEED_SPARK_FRAMES = ['spark_01', 'spark_02', 'spark_03', 'spark_04'] as const;
const SPEED_RISER_FRAMES = ['magic_02', 'magic_04'] as const;
const POP_RING_FRAME = 'circle_01';

/* ═══════════════════════════════════════════════════════════════════════════
 * ACTIVE-EFFECT AURAS — OWNER RETUNE LIST (juice-pass-1 ticket 03).
 * Every number below is a taste parameter; retune in-browser against a
 * running build. Grouped: [shield shimmer] [shield pop] [speed spinners]
 * [speed risers] [speed pop] [shared].
 *
 * AURA-VS-TAIL DIVISION (ticket 04 builds against this — do not duplicate):
 *   THIS FILE conveys STATE ONLY: "shield is up" (serene blue shimmer + big
 *   defensive ring) and "speed boost is active" (tight fast-spinning amber
 *   energy ring + upward energy flickers). Everything here is RADIAL and
 *   DIRECTIONLESS — it renders identically whether the player is standing
 *   still or sprinting, and never trails behind the player.
 *   The GHOST TAIL (ticket 04) conveys MOTION: progressive-transparency
 *   afterimages spawned along the velocity vector during speed boost + dash.
 *   Anything velocity-coupled, directional (chevrons, streak trails), or
 *   pose-copy (afterimages) belongs to the tail, not here.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Shield (barrier): serene blue shimmer orbiting the player ──
/** Orbiting glint count. */
const BARRIER_GLINT_COUNT = 5;
/** Orbit radius (px) — inside the r=58 defensive ring, around the body edge. */
const BARRIER_ORBIT_RADIUS = 44;
/** One full revolution takes this long (ms) — slow = calm/defensive. */
const BARRIER_ORBIT_PERIOD_MS = 3600;
/** Glint display size (px). */
const BARRIER_GLINT_DISPLAY = 26;
/** Glint alpha center. */
const BARRIER_GLINT_ALPHA = 0.55;
/** Glint twinkle depth (± alpha). */
const BARRIER_GLINT_TWINKLE_AMP = 0.25;
/** Twinkle speed (rad/ms divisor — smaller = faster). */
const BARRIER_GLINT_TWINKLE_MS = 170;

// ── Shield activation pop ──
/** Pop ring start/end diameters (px). */
const BARRIER_POP_FROM = 64;
const BARRIER_POP_TO = 168;
/** Pop ring peak alpha + duration (ms). */
const BARRIER_POP_ALPHA = 0.8;
const BARRIER_POP_DURATION = 360;
/** Pop spark count + travel distance (px). */
const BARRIER_POP_SPARKS = 6;
const BARRIER_POP_SPARK_DIST = 56;
/** Pop spark display size + lifetime (ms). */
const BARRIER_POP_SPARK_DISPLAY = 22;
const BARRIER_POP_SPARK_LIFE = 320;

// ── Speed (boost): tight, fast-spinning amber energy ring ──
/** Ring spark count. */
const SPEED_SPIN_COUNT = 6;
/** Spin ring radius (px) — tighter than shield's orbit (silhouette contrast). */
const SPEED_SPIN_RADIUS = 38;
/** Spin rate (revolutions per second) — fast = energetic. */
const SPEED_SPIN_RATE = 1.3;
/** Spark display size (px). */
const SPEED_SPARK_DISPLAY = 20;
/** Spark alpha center + flicker depth (±). */
const SPEED_SPARK_ALPHA = 0.55;
const SPEED_SPARK_FLICKER_AMP = 0.2;

// ── Speed risers: upward energy flickers (directionless STATE, not motion) ──
/** Riser count (staggered through the player). */
const SPEED_RISER_COUNT = 3;
/** One rise cycle (ms). */
const SPEED_RISER_PERIOD_MS = 750;
/** Rise from/to (px, relative to player center; negative = up). */
const SPEED_RISER_FROM_Y = 22;
const SPEED_RISER_TO_Y = -44;
/** Riser display size (px). */
const SPEED_RISER_DISPLAY = 16;
/** Riser peak alpha (sin-ramped in/out over the cycle). */
const SPEED_RISER_ALPHA = 0.45;
/** Horizontal wiggle amplitude (px). */
const SPEED_RISER_WIGGLE_X = 6;

// ── Speed activation pop ──
/** Pop ring start/end diameters (px). */
const SPEED_POP_FROM = 56;
const SPEED_POP_TO = 150;
/** Pop ring peak alpha + duration (ms). */
const SPEED_POP_ALPHA = 0.8;
const SPEED_POP_DURATION = 320;
/** Pop spark count + travel distance (px). */
const SPEED_POP_SPARKS = 5;
const SPEED_POP_SPARK_DIST = 48;
/** Pop spark display size + lifetime (ms). */
const SPEED_POP_SPARK_DISPLAY = 20;
const SPEED_POP_SPARK_LIFE = 280;

// ── Shared ──
/**
 * Sprite auras render just under the crisp status rings (statusEffects band
 * 210) so the player sprite + ring read first; still above the body (200).
 */
const AURA_SPRITE_DEPTH = DesignTokens.depth.statusEffects - 5;

/** Per-player sprite set for one active effect. */
interface AuraSpriteSet {
  sprites: Phaser.GameObjects.Sprite[];
}

/**
 * PowerAuraVFX — the pooled-sprite half of the active-effect auras (ticket 03).
 *
 * Owns its own SpritePool: the auras live and die with the per-player map in
 * StatusEffectRenderer (their driver), NOT with the entity registry — so they
 * must not share EntityRendererVFX's pool-owned-by-the-registry lifecycle.
 * Pool discipline is identical (acquire/release, never bare scene.add.sprite).
 *
 * Per-frame motion is direct math (no tweens) so `release` can reclaim a
 * player's sprites at any instant with nothing in flight. The one-shot
 * activation pops use the tween-release pattern (self-releasing on complete,
 * like DamageParticleVFX) and are deliberately NOT tracked per player — a pop
 * is a 300ms burst, not a persistent aura.
 */
export class PowerAuraVFX {
  private readonly scene: Phaser.Scene;
  private readonly pool: SpritePool;
  private readonly barrierAuras = new Map<string, AuraSpriteSet>();
  private readonly speedAuras = new Map<string, AuraSpriteSet>();
  /** Lazily-resolved frame availability (after atlas preload). */
  private framesAvailable: boolean | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.pool = new SpritePool(scene);
  }

  /* ── Attach / detach (edge-driven by StatusEffectRenderer) ── */

  /** Acquire the shield shimmer orbiters for `key` (no-op when already on). */
  attachBarrier(key: string, x: number, y: number): void {
    if (this.barrierAuras.has(key)) return;
    if (!this.areFramesAvailable()) {
      // Track even without sprites so detach/double-attach stay idempotent.
      this.barrierAuras.set(key, { sprites: [] });
      return;
    }
    const sprites: Phaser.GameObjects.Sprite[] = [];
    for (let i = 0; i < BARRIER_GLINT_COUNT; i++) {
      const spr = this.pool.acquire(
        'vfx',
        BARRIER_GLINT_FRAMES[i % BARRIER_GLINT_FRAMES.length]!,
        x,
        y,
      );
      spr.setDepth(AURA_SPRITE_DEPTH).setOrigin(0.5).setBlendMode(BLEND_MODE_ADD);
      spr.setTint(DesignTokens.colors.blue);
      spr.setScale(BARRIER_GLINT_DISPLAY / PARTICLE_TEX_SIZE);
      sprites.push(spr);
    }
    this.barrierAuras.set(key, { sprites });
  }

  /** Release the shield shimmer for `key`. */
  detachBarrier(key: string): void {
    const set = this.barrierAuras.get(key);
    if (!set) return;
    for (const spr of set.sprites) this.pool.release(spr);
    this.barrierAuras.delete(key);
  }

  /** Acquire the speed spin ring + risers for `key` (no-op when already on). */
  attachSpeed(key: string, x: number, y: number): void {
    if (this.speedAuras.has(key)) return;
    if (!this.areFramesAvailable()) {
      this.speedAuras.set(key, { sprites: [] });
      return;
    }
    const sprites: Phaser.GameObjects.Sprite[] = [];
    for (let i = 0; i < SPEED_SPIN_COUNT; i++) {
      const spr = this.pool.acquire('vfx', SPEED_SPARK_FRAMES[i % SPEED_SPARK_FRAMES.length]!, x, y);
      spr.setDepth(AURA_SPRITE_DEPTH).setOrigin(0.5).setBlendMode(BLEND_MODE_ADD);
      spr.setTint(DesignTokens.colors.amber);
      spr.setScale(SPEED_SPARK_DISPLAY / PARTICLE_TEX_SIZE);
      sprites.push(spr);
    }
    for (let i = 0; i < SPEED_RISER_COUNT; i++) {
      const spr = this.pool.acquire('vfx', SPEED_RISER_FRAMES[i % SPEED_RISER_FRAMES.length]!, x, y);
      spr.setDepth(AURA_SPRITE_DEPTH).setOrigin(0.5).setBlendMode(BLEND_MODE_ADD);
      spr.setTint(DesignTokens.colors.amber);
      spr.setScale(SPEED_RISER_DISPLAY / PARTICLE_TEX_SIZE);
      sprites.push(spr);
    }
    this.speedAuras.set(key, { sprites });
  }

  /** Release the speed aura for `key`. */
  detachSpeed(key: string): void {
    const set = this.speedAuras.get(key);
    if (!set) return;
    for (const spr of set.sprites) this.pool.release(spr);
    this.speedAuras.delete(key);
  }

  /* ── One-shot activation pops (tween-release, fire-and-forget) ── */

  /** Shield gained: blue ring wave + sparks at the player. */
  barrierPop(x: number, y: number): void {
    this.pop(x, y, DesignTokens.colors.blue, {
      from: BARRIER_POP_FROM,
      to: BARRIER_POP_TO,
      alpha: BARRIER_POP_ALPHA,
      duration: BARRIER_POP_DURATION,
      sparks: BARRIER_POP_SPARKS,
      sparkDist: BARRIER_POP_SPARK_DIST,
      sparkDisplay: BARRIER_POP_SPARK_DISPLAY,
      sparkLife: BARRIER_POP_SPARK_LIFE,
    });
  }

  /** Speed boost gained: amber ring wave + sparks at the player. */
  speedPop(x: number, y: number): void {
    this.pop(x, y, DesignTokens.colors.amber, {
      from: SPEED_POP_FROM,
      to: SPEED_POP_TO,
      alpha: SPEED_POP_ALPHA,
      duration: SPEED_POP_DURATION,
      sparks: SPEED_POP_SPARKS,
      sparkDist: SPEED_POP_SPARK_DIST,
      sparkDisplay: SPEED_POP_SPARK_DISPLAY,
      sparkLife: SPEED_POP_SPARK_LIFE,
    });
  }

  /* ── Per-frame anim (driven from StatusEffectRenderer.movePlayer) ── */

  /** Advance the shield shimmer orbit around (x, y). */
  updateBarrier(key: string, x: number, y: number): void {
    const set = this.barrierAuras.get(key);
    if (!set || set.sprites.length === 0) return;
    const now = performance.now();
    const n = set.sprites.length;
    for (let i = 0; i < n; i++) {
      const spr = set.sprites[i]!;
      const angle =
        (i / n) * Math.PI * 2 + (now / BARRIER_ORBIT_PERIOD_MS) * Math.PI * 2;
      spr.setPosition(x + Math.cos(angle) * BARRIER_ORBIT_RADIUS, y + Math.sin(angle) * BARRIER_ORBIT_RADIUS);
      spr.setAlpha(
        BARRIER_GLINT_ALPHA +
          BARRIER_GLINT_TWINKLE_AMP * Math.sin(now / BARRIER_GLINT_TWINKLE_MS + i * 2.1),
      );
      spr.setRotation((now / 4000) * Math.PI * 2 + i);
    }
  }

  /** Advance the speed spin ring + risers around (x, y). */
  updateSpeed(key: string, x: number, y: number): void {
    const set = this.speedAuras.get(key);
    if (!set || set.sprites.length === 0) return;
    const now = performance.now();
    const spinN = Math.min(SPEED_SPIN_COUNT, set.sprites.length);
    // Spinners: fast rotation on a tight ring.
    for (let i = 0; i < spinN; i++) {
      const spr = set.sprites[i]!;
      const angle = (i / spinN) * Math.PI * 2 + (now / 1000) * SPEED_SPIN_RATE * Math.PI * 2;
      spr.setPosition(x + Math.cos(angle) * SPEED_SPIN_RADIUS, y + Math.sin(angle) * SPEED_SPIN_RADIUS);
      spr.setAlpha(
        SPEED_SPARK_ALPHA + SPEED_SPARK_FLICKER_AMP * Math.sin(now / 90 + i * 1.7),
      );
      spr.setRotation(angle + Math.PI / 2);
    }
    // Risers: sin-ramped upward flickers, phase-staggered.
    for (let r = 0; r < SPEED_RISER_COUNT; r++) {
      const spr = set.sprites[spinN + r];
      if (!spr) break;
      const t = ((now / SPEED_RISER_PERIOD_MS) + r / SPEED_RISER_COUNT) % 1;
      const riseY = SPEED_RISER_FROM_Y + (SPEED_RISER_TO_Y - SPEED_RISER_FROM_Y) * t;
      spr.setPosition(
        x + Math.sin(t * Math.PI * 2 + r) * SPEED_RISER_WIGGLE_X,
        y + riseY,
      );
      spr.setAlpha(Math.sin(t * Math.PI) * SPEED_RISER_ALPHA);
    }
  }

  /* ── Teardown ── */

  /** Release both auras for a player (death/leave — must never outlive them). */
  removePlayer(key: string): void {
    this.detachBarrier(key);
    this.detachSpeed(key);
  }

  /** Release every aura; the effect stays usable afterwards. */
  clear(): void {
    // Deleting during Map iteration is spec-safe (visited entries may vanish).
    for (const key of this.barrierAuras.keys()) this.detachBarrier(key);
    for (const key of this.speedAuras.keys()) this.detachSpeed(key);
  }

  /** Full teardown (scene shutdown). */
  destroy(): void {
    this.clear();
    this.pool.destroy();
  }

  /* ── Internals ── */

  /** Shared activation-pop implementation (expanding ring + radial sparks). */
  private pop(
    x: number,
    y: number,
    tint: number,
    cfg: {
      from: number;
      to: number;
      alpha: number;
      duration: number;
      sparks: number;
      sparkDist: number;
      sparkDisplay: number;
      sparkLife: number;
    },
  ): void {
    if (!this.areFramesAvailable()) return;
    const d = (px: number) => px / PARTICLE_TEX_SIZE;

    const ring = this.pool.acquire('vfx', POP_RING_FRAME, x, y);
    ring.setDepth(AURA_SPRITE_DEPTH).setOrigin(0.5).setTint(tint).setAlpha(cfg.alpha);
    ring.setScale(d(cfg.from));
    this.scene.tweens.add({
      targets: ring,
      scale: d(cfg.to),
      alpha: 0,
      duration: cfg.duration,
      ease: 'Cubic.easeOut',
      onComplete: () => this.pool.release(ring),
    });

    for (let i = 0; i < cfg.sparks; i++) {
      const spr = this.pool.acquire(
        'vfx',
        SPEED_SPARK_FRAMES[i % SPEED_SPARK_FRAMES.length]!,
        x,
        y,
      );
      spr.setDepth(AURA_SPRITE_DEPTH).setOrigin(0.5).setBlendMode(BLEND_MODE_ADD);
      spr.setTint(tint).setAlpha(0.9).setScale(d(cfg.sparkDisplay));
      const angle = (i / cfg.sparks) * Math.PI * 2;
      this.scene.tweens.add({
        targets: spr,
        x: x + Math.cos(angle) * cfg.sparkDist,
        y: y + Math.sin(angle) * cfg.sparkDist,
        scale: 0,
        alpha: 0,
        duration: cfg.sparkLife,
        ease: 'Quad.easeOut',
        onComplete: () => this.pool.release(spr),
      });
    }
  }

  /** Resolve frame availability once (after atlas preload). */
  private areFramesAvailable(): boolean {
    if (this.framesAvailable === null) {
      const tex = this.scene.textures.get('vfx');
      this.framesAvailable =
        tex.has(BARRIER_GLINT_FRAMES[0]!) &&
        tex.has(SPEED_SPARK_FRAMES[0]!) &&
        tex.has(POP_RING_FRAME);
    }
    return this.framesAvailable;
  }
}
