/**
 * Projectile rendering — add, update, remove, bounce-pulse for thrown/shot projectiles.
 * Extracted from EntityRendererLifecycle for single-responsibility.
 */
import Phaser from 'phaser';
import { weaponRegistry, WeaponType, AttackType } from '@sector-battle/shared';
import type { ProjectileState } from '../types.js';
import { WEAPON_SPRITE_MAP } from '../types.js';
import { type EntityVisual, type EntityVisualMap, hasEntitySprite } from './EntityTypes.js';
import { getTierColor, getWeaponDisplayScale } from './WeaponVisuals.js';
import type { EntityTextureResolver } from './EntityTextureResolver.js';

// ── Bounce pulse ───────────────────────────────────────────────────────────

export function applyBouncePulse(e: EntityVisual): void {
  if (e.bounceTime) {
    const bt = (performance.now() - e.bounceTime) / 150;
    const base = e.baseScale ?? 1;
    if (bt < 1) {
      const pulse = 1 + Math.sin(bt * Math.PI) * 0.3;
      e.sprite.setScale(base * pulse, base * pulse);
    } else {
      e.sprite.setScale(base, base);
      e.bounceTime = undefined;
    }
  }
}

// ── Projectile add ─────────────────────────────────────────────────────────

export function addProjectile(
  entities: EntityVisualMap,
  scene: Phaser.Scene,
  resolver: EntityTextureResolver,
  key: string,
  p: ProjectileState,
): void {
  if (entities.has(key)) return;
  const isArrow = p.bounces < 0;
  const spriteKey = isArrow ? 'weapon_arrow' : (WEAPON_SPRITE_MAP[p.weaponType] ?? 'weapon_dagger');
  const texKey = resolver.safeTexture(spriteKey, 'hit_spark');
  const sprite = scene.add.sprite(p.x, p.y, 'game', texKey).setOrigin(0.5).setDepth(15);
  const weaponScale = getWeaponDisplayScale(p.weaponType);
  sprite.setScale(weaponScale);
  const travelAngle = Math.atan2(p.velocityY, p.velocityX);
  let spins = false;
  if (!isArrow) {
    try {
      const def = weaponRegistry.getDefinition(p.weaponType as WeaponType);
      spins =
        def.baseStats.attackType === AttackType.ARC ||
        def.baseStats.attackType === AttackType.SHIELD;
    } catch {}
  }
  sprite.setRotation(spins ? travelAngle : travelAngle + Math.PI / 2);
  if (p.tier > 0) sprite.setTint(getTierColor(p.tier));
  entities.set(key, { sprite, type: 'projectile', spins, baseScale: weaponScale });
}

// ── Projectile update ──────────────────────────────────────────────────────

export function updateProjectile(
  entities: EntityVisualMap,
  key: string,
  p: ProjectileState,
): void {
  const e = entities.get(key);
  if (hasEntitySprite(e)) {
    e.sprite.setPosition(p.x, p.y);
    const travelAngle = Math.atan2(p.velocityY, p.velocityX);
    if (e.spins) {
      e.sprite.setRotation(travelAngle + (performance.now() / 1000) * 12);
    } else {
      e.sprite.setRotation(travelAngle + Math.PI / 2);
    }
    applyBouncePulse(e);
  }
}

export function updateProjectileVisuals(
  entities: EntityVisualMap,
  key: string,
  p: ProjectileState,
): void {
  const e = entities.get(key);
  if (hasEntitySprite(e)) {
    const travelAngle = Math.atan2(p.velocityY, p.velocityX);
    if (e.spins) {
      e.sprite.setRotation(travelAngle + (performance.now() / 1000) * 12);
    } else {
      e.sprite.setRotation(travelAngle + Math.PI / 2);
    }
    applyBouncePulse(e);
  }
}

export function setProjectilePosition(
  entities: EntityVisualMap,
  key: string,
  x: number,
  y: number,
): void {
  const e = entities.get(key);
  if (hasEntitySprite(e)) {
    e.sprite.setPosition(x, y);
    applyBouncePulse(e);
  }
}

export function triggerProjectileBounce(entities: EntityVisualMap, key: string): void {
  const e = entities.get(key);
  if (e && e.type === 'projectile') {
    e.bounceTime = performance.now();
  }
}
