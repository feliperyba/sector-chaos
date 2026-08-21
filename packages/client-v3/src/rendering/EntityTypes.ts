/**
 * Shared entity-rendering types + factory — extracted from
 * EntityRendererLifecycle and EntityRendererTraps to break the import cycles
 * (Lifecycle ↔ Projectiles, Lifecycle ↔ Traps) that existed when both partials
 * imported `EntityVisual` from Lifecycle while Lifecycle imported partial
 * helpers back. Behavioural logic is unchanged; this file only owns the
 * shared types and the previously duplicated `createEntitySprite` factory.
 */
import Phaser from 'phaser';

export interface EntityVisual {
  sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | Phaser.GameObjects.Graphics;
  type: string;
  baseY?: number;
  x?: number;
  y?: number;
  prevX?: number;
  prevY?: number;
  active?: boolean;
  bounceTime?: number;
  /** Base uniform scale (set at creation); bounce-pulse multiplies relative to this. */
  baseScale?: number;
  spins?: boolean;
  flashTime?: number;
  fireAreaGraphics?: Phaser.GameObjects.Graphics;
  /**
   * One-shot fire-area rebuild request (perf ticket 19). Set by `updateTrap`
   * on the inactive → active (arm → fire) transition; consumed — cleared — by
   * the per-frame loop's redraw gate so an off-screen fire trap rebuilds its
   * Graphics exactly once per state change instead of every frame.
   */
  fireAreaDirty?: boolean;
}

/**
 * Explosion entity record — deliberately carries NO GameObject (ticket #50).
 *
 * Everything the player sees for an explosion is created by the VFX layer
 * (`EntityRendererVFX.explosion.spawn` → `ExplosionVFX`); this record exists
 * only so the generic lifecycle can track the entity's presence in the
 * registry (removeEntity/destroy cleanup). Previously each explosion also
 * allocated a placeholder `Graphics` purely to satisfy the required-sprite
 * shape — it was never drawn to, yet it cost a GameObject allocation, a
 * display-list entry, an albedo-capture scan hit per frame, and (when the VFX
 * expired before the server removed the schema entity) an orphan in the scene
 * because the expiry callback deletes the registry entry without destroying
 * the sprite. `sprite` is declared `?: undefined` rather than omitted so the
 * registry union stays a property-narrowable discriminated union.
 */
export interface ExplosionEntityVisual {
  /** Always absent — explosions render exclusively through the VFX system. */
  sprite?: undefined;
  type: 'explosion';
  x?: number;
  y?: number;
}

/**
 * Light-prop entity record (map-polish ticket 08) — deliberately carries NO
 * GameObject, mirroring {@link ExplosionEntityVisual}.
 *
 * A `'light'` destructible (ticket 07: converted sconces/crystals, wire type
 * 4) renders EXCLUSIVELY through `LightPropRenderer` — its fixture frames
 * live in the `lightProps` atlas, not `game`, so the generic destructible
 * path must not spawn a crate/'crate_small' fallback sprite under it. This
 * record exists so the registry still tracks the entity's presence + tile
 * position: `DestructibleStateHandlers.onDestructibleRemove` reads the
 * position to fire the dust cloud + the tile-keyed light-off hook
 * (`gameState.onLightPlacementRemoved`), keeping the destroy→light-off
 * chain server-authoritative end-to-end (no sprite, no client-side state).
 */
export interface LightPropEntityVisual {
  /** Always absent — fixtures render exclusively via `LightPropRenderer`. */
  sprite?: undefined;
  type: 'light-prop';
  /** Server-authoritative world position (schema `DestructibleState.x/y`). */
  x: number;
  y: number;
}

/** Value type of the entity registry (`EntityRendererLifecycle.entities`). */
export type AnyEntityVisual = EntityVisual | ExplosionEntityVisual | LightPropEntityVisual;

/** The entity registry map — values discriminated by `type`. */
export type EntityVisualMap = Map<string, AnyEntityVisual>;

/**
 * Type guard: true when the record carries a live GameObject to render.
 * Explosion records never do. Keyed consumers (projectile/trap/chest/… lookups
 * by their own entity key) use this to narrow — a keyed lookup can only ever
 * return that kind's record, so the guard is exhaustive at runtime.
 */
export function hasEntitySprite(e: AnyEntityVisual | undefined): e is EntityVisual {
  return e !== undefined && e.sprite !== undefined;
}

export interface CreateEntitySpriteOptions {
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  displaySize?: number;
  depth: number;
}

export function createEntitySprite(
  scene: Phaser.Scene,
  x: number,
  y: number,
  textureKey: string,
  options: CreateEntitySpriteOptions,
): Phaser.GameObjects.Sprite | null {
  if (!scene.textures.get('game').has(textureKey)) return null;
  const size = options.displaySize ?? 128;
  const sprite = scene.add
    .sprite(x, y, 'game', textureKey)
    .setOrigin(0.5)
    .setDisplaySize(size, size)
    .setDepth(options.depth);
  if (options.rotation) sprite.setRotation(options.rotation);
  const sx = options.flipH ? -1 : 1;
  const sy = options.flipV ? -1 : 1;
  if (sx !== 1 || sy !== 1) sprite.setScale(sx, sy);
  return sprite;
}
