import Phaser from 'phaser';
import type { MapRenderer } from './MapRenderer.js';
import type { EntityRendererVFX } from './EntityRendererVFX.js';
import { EntityTextureResolver } from './EntityTextureResolver.js';
import {
  addProjectile,
  updateProjectile,
  updateProjectileVisuals,
  setProjectilePosition,
  triggerProjectileBounce,
} from './EntityRendererProjectiles.js';
import type { ProjectileState, TrapState } from '../types.js';
import { VIEW_CULL_MARGIN_PX } from '../types.js';
import {
  addTrap as addTrapVisual,
  updateTrap as updateTrapVisual,
  redrawFireArea,
  triggerSpikeFlash,
  tickTrapFlash,
} from './EntityRendererTraps.js';
import { type EntityVisualMap } from './EntityTypes.js';
import { EntitySpritePool } from './EntitySpritePool.js';
import {
  addDestructible,
  removeDestructible,
  updateDestructible,
  refreshWallVisuals,
  getDestructiblePosition,
  isLightPropEntity,
  addChest,
  removeChest,
  updateChest,
  getChestPosition,
  addExit,
  removeExit,
  updateExit,
} from './EntityRendererWorld.js';
import {
  addWeaponPickup,
  removeWeaponPickup,
  updateWeaponPickup,
  addPowerUp,
  removePowerUp,
  updatePowerUp,
} from './EntityRendererItems.js';
import { addExplosion, removeExplosion } from './EntityRendererExplosions.js';
import type {
  DestructibleState,
  ChestState,
  WeaponPickupState,
  PowerUpState,
  ExplosionState,
  ExitState,
} from '../types.js';

/**
 * Perf ticket 21: the cull margin moved to the ONE shared client const
 * (types.ts VIEW_CULL_MARGIN_PX) that PlayerRenderer's per-player cull also
 * uses — the entity-side doc (extents this gate must cover: pickup/powerup
 * bob ±4px, the 44px powerup ground-glow decal, the 72px sonar ping, the
 * 3×3-tile fire-trap overlay's EXACT 192px reach) lives on that constant.
 */

/** Whether a GameObject's world position lies inside the padded view rect. */
function entityInView(
  sprite: { x: number; y: number },
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  return sprite.x >= minX && sprite.x <= maxX && sprite.y >= minY && sprite.y <= maxY;
}

/**
 * Manages the entity visual map — creation, removal, per-frame position
 * updates, and per-entity VFX (flash, bounce pulse, fire-area overlay).
 * Delegates heavy VFX work to EntityRendererVFX.
 *
 * Per-entity-type add/update/remove logic lives in the focused collaborator
 * modules (EntityRendererWorld, EntityRendererItems, EntityRendererExplosions)
 * as `lifecycle`-taking module functions. This class owns the shared STATE
 * (fields) + the LIFECYCLE (constructor, setMapRenderer, update, destroy,
 * removeEntity) and delegates the per-entity-type work. The public API is
 * byte-identical to the pre-refactor class: every public method (addChest,
 * addDestructible, addExplosion, …) keeps the same signature and is still
 * callable on the instance. Behavior is provably preserved by construction
 * (every moved body is verbatim modulo `this.` → `lifecycle.`).
 */
export class EntityRendererLifecycle {
  readonly entities: EntityVisualMap = new Map();
  readonly prevDestructibleHp = new Map<string, number>();
  readonly wallEntityPositions = new Map<string, { gridX: number; gridY: number }>();

  resolver: EntityTextureResolver;
  /**
   * Item-entity sprite pool (perf ticket 22) — weapon-pickup and power-up
   * icons acquire from it on add and park back on remove, so loot bursts
   * stop allocating/destroying display objects. Destroyed with the scene
   * (see {@link destroy}); other entity kinds keep direct destroy semantics.
   */
  readonly itemSpritePool: EntitySpritePool;

  constructor(
    public scene: Phaser.Scene,
    public vfx: EntityRendererVFX,
    public mapRenderer: MapRenderer | null,
  ) {
    this.resolver = new EntityTextureResolver(scene, mapRenderer);
    this.itemSpritePool = new EntitySpritePool(scene);
  }

  setMapRenderer(mr: MapRenderer): void {
    this.mapRenderer = mr;
    this.resolver = new EntityTextureResolver(this.scene, mr);
    refreshWallVisuals(this);
  }

  getMapRenderer(): MapRenderer | null {
    return this.mapRenderer;
  }

  /* ── Projectile (delegates to EntityRendererProjectiles) ── */

  addProjectile(key: string, p: ProjectileState): void {
    addProjectile(this.entities, this.scene, this.resolver, key, p);
  }

  removeProjectile(key: string): void {
    this.removeEntity(key);
  }

  triggerProjectileBounce(key: string): void {
    triggerProjectileBounce(this.entities, key);
  }

  updateProjectile(key: string, p: ProjectileState): void {
    updateProjectile(this.entities, key, p);
  }

  updateProjectileVisuals(key: string, p: ProjectileState): void {
    updateProjectileVisuals(this.entities, key, p);
  }

  setProjectilePosition(key: string, x: number, y: number): void {
    setProjectilePosition(this.entities, key, x, y);
  }

  /* ── Destructible (delegates to EntityRendererWorld) ───── */

  addDestructible(key: string, d: DestructibleState): void {
    addDestructible(this, key, d);
  }

  removeDestructible(key: string): void {
    removeDestructible(this, key);
  }

  updateDestructible(key: string, d: DestructibleState): void {
    updateDestructible(this, key, d);
  }

  /* ── Chest (delegates to EntityRendererWorld) ──────────── */

  addChest(key: string, c: ChestState): void {
    addChest(this, key, c);
  }

  removeChest(key: string): void {
    removeChest(this, key);
  }

  updateChest(key: string, c: ChestState): void {
    updateChest(this, key, c);
  }

  /* ── WeaponPickup (delegates to EntityRendererItems) ───── */

  addWeaponPickup(key: string, wp: WeaponPickupState): void {
    addWeaponPickup(this, key, wp);
  }

  removeWeaponPickup(key: string): void {
    removeWeaponPickup(this, key);
  }

  updateWeaponPickup(key: string, wp: WeaponPickupState): void {
    updateWeaponPickup(this, key, wp);
  }

  /* ── Trap (delegates to EntityRendererTraps) ───────────── */

  addTrap(key: string, t: TrapState): void {
    addTrapVisual(this.entities, this.scene, this.resolver, key, t);
  }

  removeTrap(key: string): void {
    this.removeEntity(key);
  }

  updateTrap(key: string, t: TrapState): void {
    updateTrapVisual(this.entities, this.scene, this.resolver, key, t);
  }

  triggerSpikeFlash(key: string): void {
    triggerSpikeFlash(this.entities, key);
  }

  /* ── PowerUp (delegates to EntityRendererItems) ────────── */

  addPowerUp(key: string, p: PowerUpState): void {
    addPowerUp(this, key, p);
  }

  removePowerUp(key: string): void {
    removePowerUp(this, key);
  }

  updatePowerUp(key: string, p: PowerUpState): void {
    updatePowerUp(this, key, p);
  }

  /* ── Explosion (delegates to EntityRendererExplosions) ─── */

  addExplosion(key: string, e: ExplosionState): void {
    addExplosion(this, key, e);
  }

  removeExplosion(key: string): void {
    removeExplosion(this, key);
  }

  /* ── Exit (delegates to EntityRendererWorld) ───────────── */

  addExit(key: string, e: ExitState): void {
    addExit(this, key, e);
  }

  removeExit(key: string): void {
    removeExit(this, key);
  }

  updateExit(key: string, e: ExitState): void {
    updateExit(this, key, e);
  }

  /* ── Per-frame update ───────────────────────────────────── */

  update(): void {
    const now = performance.now();
    // ── Entity view cull (perf ticket 19) ──
    // Phaser 4.1 has no automatic frustum cull, so this loop used to run the
    // bob/pulse/fire-area work for EVERY entity on the map each frame — O(total
    // entities), growing with map loot rather than visible action. We mirror
    // the PlayerRenderer cull: pad the camera's world view (zoom already baked
    // into worldView — it is a world-space rect) by VIEW_CULL_MARGIN_PX and
    // skip the per-frame animation transforms for entities outside it.
    //
    // PHASE CONSISTENCY (the load-bearing constraint): every gated animation
    // is a PURE function of absolute time — pickup bob sin(now/400 + seed),
    // powerup icon pulse sin(now·2π·1.1Hz + seed) + glow breath + ping
    // t = (now/1600 + phase)%1, exit pulse sin(now/600), fire-area pulse
    // sin(now/200). Nothing accumulates phase across frames, so an entity
    // culled for N seconds and re-entering view shows EXACTLY the values a
    // never-culled entity shows at the same `now` (pinned by
    // __tests__/EntityRendererCull.test.ts).
    //
    // A missing camera (headless test stub / not yet booted) means "cannot
    // prove off-screen" → infinite bounds → animate everything, matching the
    // pre-cull behaviour (same fallback semantics as ExplosionVFX's cull).
    const wv = this.scene.cameras?.main?.worldView;
    const minX = wv ? wv.x - VIEW_CULL_MARGIN_PX : -Infinity;
    const minY = wv ? wv.y - VIEW_CULL_MARGIN_PX : -Infinity;
    const maxX = wv ? wv.right + VIEW_CULL_MARGIN_PX : Infinity;
    const maxY = wv ? wv.bottom + VIEW_CULL_MARGIN_PX : Infinity;
    for (const [key, e] of this.entities) {
      // The gated kinds (weaponpickup/powerup/exit/trap) always carry a
      // sprite; sprite-less explosion/light-prop records match no branch.
      if (
        e.type === 'weaponpickup' &&
        e.baseY != null &&
        entityInView(e.sprite, minX, minY, maxX, maxY)
      ) {
        this.vfx.pickup.updatePickupBob(e.sprite as Phaser.GameObjects.Sprite, e.baseY, key, now);
      }
      if (
        e.type === 'powerup' &&
        e.baseY != null &&
        entityInView(e.sprite, minX, minY, maxX, maxY)
      ) {
        this.vfx.pickup.updatePowerupBob(e.sprite, e.baseY, key, now);
        // Ticket 03 pickup pop: decal breathing + radius sonar ping.
        this.vfx.pickup.updatePowerUpGlow(key, now);
      }
      if (e.type === 'exit' && e.active && entityInView(e.sprite, minX, minY, maxX, maxY)) {
        const pulse = Math.sin(now / 600) * 0.15 + 0.85;
        e.sprite.setAlpha(pulse);
      }
      if (e.type === 'trap') {
        // Flash-tint expiry runs at every cull state: it is a cheap one-shot
        // state clear (not a per-frame rebuild) and a trap that re-enters
        // view must never carry a stale white tint past its 200ms window.
        tickTrapFlash(e, now);
        // Fire-area redraw gate (perf ticket 19): the overlay's alpha pulses,
        // so on-screen it re-issues clear + 9 fillRect — a full Graphics
        // vertex re-upload — every frame (unchanged). OFF-screen it rebuilds
        // solely on the state-change flag (arm → fire, set by updateTrap),
        // exactly once, then goes silent: zero per-frame rebuilds.
        if (e.fireAreaDirty || entityInView(e.sprite, minX, minY, maxX, maxY)) {
          redrawFireArea(e);
          e.fireAreaDirty = false;
        }
      }
    }
  }

  /* ── Misc helpers ───────────────────────────────────────── */

  getDestructiblePosition(key: string): { x: number; y: number } | null {
    return getDestructiblePosition(this, key);
  }

  /** Ticket 08: whether the tracked destructible is a converted light prop. */
  isLightPropDestructible(key: string): boolean {
    return isLightPropEntity(this, key);
  }

  getChestPosition(key: string): { x: number; y: number } | null {
    return getChestPosition(this, key);
  }

  removeEntity(key: string): void {
    const e = this.entities.get(key);
    if (e) {
      // Explosions carry no sprite (ticket #50) — skip the destroy cleanly.
      // fireAreaGraphics only ever coexists with a sprite (traps).
      if (e.sprite) {
        if (e.type === 'weaponpickup' || e.type === 'powerup') {
          // Pooled kinds (perf ticket 22): park the icon back on the item
          // pool instead of destroying it. These records always carry a
          // Sprite created via itemSpritePool.acquire.
          this.itemSpritePool.release(e.sprite as Phaser.GameObjects.Sprite);
        } else {
          e.sprite.destroy();
        }
        if (e.fireAreaGraphics) e.fireAreaGraphics.destroy();
      }
      this.entities.delete(key);
    }
  }

  destroy(): void {
    for (const e of this.entities.values()) {
      // Explosions carry no sprite (ticket #50) — skip the destroy cleanly.
      // fireAreaGraphics only ever coexists with a sprite (traps).
      if (e.sprite) {
        e.sprite.destroy();
        if (e.fireAreaGraphics) e.fireAreaGraphics.destroy();
      }
    }
    this.entities.clear();
    this.prevDestructibleHp.clear();
    // Live item sprites were destroyed above; this frees every PARKED pool
    // slot (scene shutdown — no pooled memory survives the match).
    this.itemSpritePool.destroy();
  }
}
