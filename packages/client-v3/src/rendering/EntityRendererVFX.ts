import Phaser from 'phaser';
import type { MapRenderer } from './MapRenderer.js';
import { ExplosionVFX } from './vfx/ExplosionVFX.js';
import { ParticleVFX } from './vfx/ParticleVFX.js';
import { SiegeVFX } from './vfx/SiegeVFX.js';
import { DestructionVFX } from './vfx/DestructionVFX.js';
import { PickupVFX } from './vfx/PickupVFX.js';
import { WeaponShatterVFX } from './vfx/WeaponShatterVFX.js';
import { DamageParticleVFX } from './vfx/DamageParticleVFX.js';
import { BarrelFuseVFX } from './vfx/BarrelFuseVFX.js';
import { SpritePool } from './vfx/SpritePool.js';
import type { VFXEffect, VFXEffectId } from './vfx/VFXEffect.js';

/**
 * Registry entry type. `never` makes `spawn` UNCALLABLE through the untyped
 * registry handle — spawn sites must go through the typed accessors below (or
 * the outer EntityRenderer forwards), keeping every call compile-time checked
 * against its effect's real options type. update/clear/destroy remain callable
 * so the facade can drive the lifecycle uniformly.
 */
type RegisteredVFXEffect = VFXEffect<never>;

/**
 * VFX registry (ticket 52): ONE map from effect id → VFXEffect plus the ONE
 * shared SpritePool, replacing the previous hand-written per-effect forwarder
 * methods. Construction is registration; the per-frame update and shutdown
 * destroy iterate the registry instead of naming each subsystem.
 *
 * Siege is registered late (initSiege needs the map's tile size) — before
 * that, `get('siege')` is undefined and the typed `siege` accessor returns
 * null, mirroring the old `siegeVFX!` undefined-guard.
 *
 * Update order note: effects run in registration order, which puts siege
 * (registered last) AFTER the constructor-registered effects instead of first.
 * Every effect's update touches only its own state (its sprites, its tracking
 * maps, its Graphics object), so the ordering is behaviorally irrelevant —
 * it is called out here in case that ever changes.
 */
export class EntityRendererVFX {
  private readonly spritePool: SpritePool;
  private readonly effects = new Map<VFXEffectId, RegisteredVFXEffect>();

  constructor(private scene: Phaser.Scene) {
    this.spritePool = new SpritePool(scene);
    this.register(new ExplosionVFX(scene, this.spritePool));
    this.register(new ParticleVFX(scene, this.spritePool));
    this.register(new DamageParticleVFX(scene, this.spritePool));
    this.register(new DestructionVFX(scene, this.spritePool));
    this.register(new PickupVFX(scene, this.spritePool));
    this.register(new WeaponShatterVFX(scene, this.spritePool));
    this.register(new BarrelFuseVFX(scene, this.spritePool));
  }

  /** Late registration: siege needs the loaded map's tile size. */
  initSiege(mapRenderer: MapRenderer): void {
    this.register(new SiegeVFX(this.scene, this.spritePool, mapRenderer.getTileSize()));
  }

  /* ── Registry surface ───────────────────────────────────── */

  register(effect: RegisteredVFXEffect): void {
    this.effects.set(effect.id, effect);
  }

  get(id: VFXEffectId): RegisteredVFXEffect | undefined {
    return this.effects.get(id);
  }

  has(id: VFXEffectId): boolean {
    return this.effects.has(id);
  }

  /* ── Typed views over the registry ──────────────────────── */

  get explosion(): ExplosionVFX {
    return this.effects.get('explosion') as ExplosionVFX;
  }

  get particle(): ParticleVFX {
    return this.effects.get('particle') as ParticleVFX;
  }

  get damage(): DamageParticleVFX {
    return this.effects.get('damage') as DamageParticleVFX;
  }

  get destruction(): DestructionVFX {
    return this.effects.get('destruction') as DestructionVFX;
  }

  get pickup(): PickupVFX {
    return this.effects.get('pickup') as PickupVFX;
  }

  get shatter(): WeaponShatterVFX {
    return this.effects.get('weapon-shatter') as WeaponShatterVFX;
  }

  get barrelFuse(): BarrelFuseVFX {
    return this.effects.get('barrel-fuse') as BarrelFuseVFX;
  }

  /** Null until `initSiege` — callers guard with `?.` (cosmetic VFX must
   * never crash the game for effects that cannot exist without the map). */
  get siege(): SiegeVFX | null {
    return (this.effects.get('siege') as SiegeVFX | undefined) ?? null;
  }

  /**
   * Juice-pass-1 ticket 06 — forward the synced server-tick source to the
   * barrel-fuse effect (the escalation reads it every frame).
   *
   * @param provider returns the current synced server tick (0 pre-patch).
   */
  setServerTickProvider(provider: () => number): void {
    this.barrelFuse.setServerTickProvider(provider);
  }

  /* ── Tick / lifecycle (registry-driven) ─────────────────── */

  update(delta: number): void {
    for (const effect of this.effects.values()) {
      effect.update(delta);
    }
  }

  destroy(): void {
    for (const effect of this.effects.values()) {
      effect.destroy();
    }
    this.effects.clear();
    this.spritePool.destroy();
  }
}
