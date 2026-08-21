/**
 * VFXEffect — the single lifecycle contract for every visual effect
 * (ticket 52 / INVESTIGATION.md §Client-GPU 4.3 item 3.1).
 *
 * Before this contract the seven effect classes exposed five different
 * lifecycle shapes (`create`/`trigger*`/`spawn` variants, some with no update,
 * some allocating sprites directly with no pool). This interface is the ONE
 * contract the VFX facade (`EntityRendererVFX`) drives:
 *
 *   spawn(opts) — play the effect once. `opts` is per-effect: each class
 *                 declares its own options type. Effects with several visual
 *                 variants (particle bursts, siege's two-phase warning/
 *                 confirm) use a discriminated union on `opts.kind` instead
 *                 of extra lifecycle methods.
 *   update(dt)  — per-frame tick (dt in ms). Effects without per-frame work
 *                 (tween-driven or caller-driven) implement a documented
 *                 no-op so the facade can drive every effect uniformly.
 *   clear()     — release every in-flight resource NOW but stay usable:
 *                 pooled sprites go back to the shared SpritePool, ad-hoc
 *                 textures are freed, tracked state is emptied. Rendering
 *                 state the effect still needs to keep working (e.g.
 *                 ParticleVFX's Graphics object) survives.
 *   destroy()   — full teardown (scene shutdown): clear() plus dropping the
 *                 effect's own rendering objects.
 *
 * RESOURCE-RELEASE DISCIPLINE (encoded here, enforced by the interface
 * conformance test in tests/rendering/VFXEffectInterface.test.ts):
 *
 *   1. Every sprite an effect shows MUST be acquired from the shared
 *      SpritePool injected at construction — never `scene.add.sprite` inside
 *      an effect (SpritePool is the only allocation point). Sprites are
 *      released back to the pool on expiry and on clear()/destroy().
 *      A sprite showing an ad-hoc texture (weapon-shatter fragments) must
 *      have its atlas texture restored BEFORE release so the slot returns to
 *      the pool bucket it was acquired from.
 *   2. Every ad-hoc texture an effect mints (the per-fragment Voronoi canvas
 *      crops of weapon shatter — ticket 46) MUST be freed when its visual
 *      expires — unique keys, guarded remove, freed on expiry even though
 *      the sprite itself returns to the pool.
 *
 * NARROW EXTENSIONS (allowed by the ticket's guardrail): an effect may expose
 * extra typed methods for calls that genuinely do not fit `spawn` — targeted
 * cancellation (`ExplosionVFX.remove`, `DestructionVFX.onRemove`), continuous
 * per-frame sync (`ParticleVFX.updateFireDotPositions`), and per-entity
 * modifier appliers (`PickupVFX.updatePickupBob`). These are additive; the
 * four lifecycle methods above remain the driven contract.
 */

/** Registry keys — the id every effect is registered under in the facade. */
export type VFXEffectId =
  | 'explosion'
  | 'particle'
  | 'siege'
  | 'destruction'
  | 'pickup'
  | 'weapon-shatter'
  | 'damage'
  | 'barrel-fuse';

/**
 * The lifecycle contract. `SpawnOptions` is the effect's own `spawn` opts type
 * (a discriminated union when the effect has several visual variants).
 */
export interface VFXEffect<SpawnOptions = unknown> {
  readonly id: VFXEffectId;
  /** Play the effect once. */
  spawn(opts: SpawnOptions): void;
  /** Per-frame tick (dt in ms). */
  update(dt: number): void;
  /** Release all in-flight resources; the effect stays usable afterwards. */
  clear(): void;
  /** Full teardown (scene shutdown). */
  destroy(): void;
}
