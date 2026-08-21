import Phaser from 'phaser';
import type {
  ProjectileState,
  DestructibleState,
  ChestState,
  WeaponPickupState,
  TrapState,
  PowerUpState,
  ExplosionState,
  ExitState,
} from '../types.js';
import { WEAPON_SPRITE_MAP } from '../types.js';
import type { MapRenderer } from './MapRenderer.js';
import { EntityRendererVFX } from './EntityRendererVFX.js';
import { EntityRendererLifecycle } from './EntityRendererLifecycle.js';

/**
 * Facade for entity rendering. Delegates to:
 *  - EntityRendererLifecycle  — entity visual create/remove/update, entity map
 *  - EntityRendererVFX        — VFX subsystems (explosion, particles, siege, …)
 *
 * This class preserves the original public API so all existing consumers
 * (GameScene, ClientEventBridge, ClientStateBridge, GameSceneSetup) keep
 * working without import changes.
 */
export class EntityRenderer {
  private vfx: EntityRendererVFX;
  private lifecycle: EntityRendererLifecycle;

  constructor(private scene: Phaser.Scene) {
    this.vfx = new EntityRendererVFX(scene);
    this.lifecycle = new EntityRendererLifecycle(scene, this.vfx, null);
  }

  /* ── MapRenderer wiring ─────────────────────────────────── */

  setMapRenderer(mr: MapRenderer): void {
    this.lifecycle.setMapRenderer(mr);
    this.vfx.initSiege(mr);
  }

  /* ── Siege ──────────────────────────────────────────────── */

  addSiegeWarning(gridX: number, gridY: number, solidifyAt: number): void {
    // Siege is registered in initSiege() (it needs the map's tileSize); a
    // siege event before the map finishes loading is dropped — cosmetic VFX
    // must never crash the game.
    this.vfx.siege?.spawn({ kind: 'warning', gridX, gridY, solidifyAt });
  }

  confirmSiegeWall(gridX: number, gridY: number): void {
    this.vfx.siege?.spawn({
      kind: 'confirm',
      gridX,
      gridY,
      mapRenderer: this.lifecycle.getMapRenderer(),
    });
  }

  spawnDustCloud(x: number, y: number): void {
    // Same initSiege guard as the siege calls above.
    this.vfx.siege?.spawn({ kind: 'dust', x, y });
  }

  /* ── Projectile ─────────────────────────────────────────── */

  addProjectile(key: string, p: ProjectileState): void {
    this.lifecycle.addProjectile(key, p);
  }

  removeProjectile(key: string): void {
    this.lifecycle.removeProjectile(key);
  }

  triggerProjectileBounce(key: string): void {
    this.lifecycle.triggerProjectileBounce(key);
  }

  updateProjectile(key: string, p: ProjectileState): void {
    this.lifecycle.updateProjectile(key, p);
  }

  updateProjectileVisuals(key: string, p: ProjectileState): void {
    this.lifecycle.updateProjectileVisuals(key, p);
  }

  setProjectilePosition(key: string, x: number, y: number): void {
    this.lifecycle.setProjectilePosition(key, x, y);
  }

  /* ── Destructible ───────────────────────────────────────── */

  addDestructible(key: string, d: DestructibleState): void {
    this.lifecycle.addDestructible(key, d);
  }

  removeDestructible(key: string): void {
    this.lifecycle.removeDestructible(key);
  }

  updateDestructible(key: string, d: DestructibleState): void {
    this.lifecycle.updateDestructible(key, d);
  }

  /* ── Chest ──────────────────────────────────────────────── */

  addChest(key: string, c: ChestState): void {
    this.lifecycle.addChest(key, c);
  }

  removeChest(key: string): void {
    this.lifecycle.removeChest(key);
  }

  updateChest(key: string, c: ChestState): void {
    this.lifecycle.updateChest(key, c);
  }

  /* ── WeaponPickup ───────────────────────────────────────── */

  addWeaponPickup(key: string, wp: WeaponPickupState): void {
    this.lifecycle.addWeaponPickup(key, wp);
  }

  removeWeaponPickup(key: string): void {
    this.lifecycle.removeWeaponPickup(key);
  }

  updateWeaponPickup(key: string, wp: WeaponPickupState): void {
    this.lifecycle.updateWeaponPickup(key, wp);
  }

  /* ── Trap ───────────────────────────────────────────────── */

  addTrap(key: string, t: TrapState): void {
    this.lifecycle.addTrap(key, t);
  }

  removeTrap(key: string): void {
    this.lifecycle.removeTrap(key);
  }

  updateTrap(key: string, t: TrapState): void {
    this.lifecycle.updateTrap(key, t);
  }

  /* ── PowerUp ────────────────────────────────────────────── */

  addPowerUp(key: string, p: PowerUpState): void {
    this.lifecycle.addPowerUp(key, p);
  }

  removePowerUp(key: string): void {
    this.lifecycle.removePowerUp(key);
  }

  updatePowerUp(key: string, p: PowerUpState): void {
    this.lifecycle.updatePowerUp(key, p);
  }

  /* ── Explosion ──────────────────────────────────────────── */

  addExplosion(key: string, e: ExplosionState): void {
    this.lifecycle.addExplosion(key, e);
  }

  removeExplosion(key: string): void {
    this.lifecycle.removeExplosion(key);
  }

  /* ── Exit ───────────────────────────────────────────────── */

  addExit(key: string, e: ExitState): void {
    this.lifecycle.addExit(key, e);
  }

  removeExit(key: string): void {
    this.lifecycle.removeExit(key);
  }

  updateExit(key: string, e: ExitState): void {
    this.lifecycle.updateExit(key, e);
  }

  /* ── VFX triggers ───────────────────────────────────────── */

  triggerTrapVfx(trapType: number, x: number, y: number): void {
    this.vfx.particle.spawn({ kind: 'trap', trapType, x, y });
  }

  setPlayerFireDOT(playerId: string, active: boolean): void {
    this.vfx.particle.spawn({ kind: 'fire-dot', playerId, active });
  }

  triggerTeleportEffect(
    playerId: string,
    x: number,
    y: number,
    destX: number,
    destY: number,
  ): void {
    this.vfx.particle.spawn({ kind: 'teleport', playerId, x, y, destX, destY });
  }

  triggerDestructibleBreak(x: number, y: number, type: number): void {
    this.vfx.particle.spawn({ kind: 'break', x, y, type });
  }

  spawnBloodParticles(x: number, y: number): void {
    this.vfx.damage.spawn({ kind: 'blood', x, y });
  }

  spawnFireParticles(x: number, y: number): void {
    this.vfx.damage.spawn({ kind: 'fire', x, y });
  }

  spawnTeleportParticles(x: number, y: number): void {
    this.vfx.damage.spawn({ kind: 'teleport', x, y });
  }

  /**
   * Shield block impact particles — for weapon-vs-shield clashes.
   * Spawns metallic particles and sparks at the impact point.
   */
  spawnShieldBlockParticles(x: number, y: number, contactX?: number, contactY?: number): void {
    this.vfx.damage.spawn({ kind: 'shield-block', x, y, contactX, contactY });
  }

  /**
   * Power-up collection burst (juice-pass-1 ticket 03) — tinted ring + glints +
   * sparks at the collection point. `tint` keys the burst to the power-up type
   * (see `powerUpTint` in PickupVFX).
   */
  spawnPowerUpCollectBurst(x: number, y: number, tint: number): void {
    this.vfx.damage.spawn({ kind: 'powerup', x, y, tint });
  }

  triggerWeaponBreak(
    x: number,
    y: number,
    weaponType: number,
    facingAngle: number,
    tint: number,
    scale: number,
  ): void {
    const textureKey = WEAPON_SPRITE_MAP[weaponType] ?? 'weapon_dagger';
    this.vfx.shatter.spawn({ x, y, textureKey, facingAngle, tint, weaponScale: scale });
  }

  updateFireDotPositions(positions: Map<string, { x: number; y: number }>): void {
    this.vfx.particle.updateFireDotPositions(positions);
  }

  /**
   * Juice-pass-1 ticket 06 — inject the synced server-tick source the primed
   * barrel fire reads every frame (`StateSync.getTick()`, the synced live-tick
   * source). Set once at scene setup, after the StateSync instance exists.
   *
   * @param provider returns the current synced server tick (0 pre-patch).
   */
  setServerTickProvider(provider: () => number): void {
    this.vfx.setServerTickProvider(provider);
  }

  triggerSpikeFlash(key: string): void {
    this.lifecycle.triggerSpikeFlash(key);
  }

  /* ── Query ──────────────────────────────────────────────── */

  getDestructiblePosition(key: string): { x: number; y: number } | null {
    return this.lifecycle.getDestructiblePosition(key);
  }

  /** Ticket 08: whether the tracked destructible is a converted light prop. */
  isLightPropDestructible(key: string): boolean {
    return this.lifecycle.isLightPropDestructible(key);
  }

  getChestPosition(key: string): { x: number; y: number } | null {
    return this.lifecycle.getChestPosition(key);
  }

  /* ── Per-frame update ───────────────────────────────────── */

  update(delta: number): void {
    this.lifecycle.update();
    this.vfx.update(delta);
  }

  /* ── Lifecycle ──────────────────────────────────────────── */

  destroy(): void {
    this.lifecycle.destroy();
    this.vfx.destroy();
  }
}
