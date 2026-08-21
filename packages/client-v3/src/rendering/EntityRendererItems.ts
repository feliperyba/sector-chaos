/**
 * Item-entity rendering — weapon pickups + power-ups.
 *
 * Originally extracted byte-identical from `EntityRendererLifecycle` (with
 * `this.` → `lifecycle.`). Juice-pass-1 ticket 03 since layered the power-up
 * "pop" onto this path: addPowerUp attaches a pooled ground glow + radius
 * ping (PickupVFX), removePowerUp releases it, updatePowerUp syncs the
 * server-active flag. Weapon-pickup functions remain unchanged.
 *
 * Perf ticket 22: both add paths acquire their icon sprite from the
 * lifecycle's item sprite pool (`EntitySpritePool` — the SpritePool house
 * pattern) and the remove paths release it, so loot bursts (crate breaks,
 * death drops, ground-weapon rolls) perform zero net sprite constructions
 * after warm-up. Final sprite state per add is unchanged.
 */
import type { WeaponPickupState, PowerUpState } from '../types.js';
import { WEAPON_SPRITE_MAP } from '../types.js';
import { getTierColor, getWeaponDisplayScale } from './WeaponVisuals.js';
import { hasEntitySprite } from './EntityTypes.js';
import { powerUpTint } from './vfx/PickupVFX.js';
import type { EntityRendererLifecycle } from './EntityRendererLifecycle.js';

/* ── WeaponPickup ───────────────────────────────────────── */

export function addWeaponPickup(
  lifecycle: EntityRendererLifecycle,
  key: string,
  wp: WeaponPickupState,
): void {
  if (lifecycle.entities.has(key)) return;
  const textureKey =
    wp.textureKey && lifecycle.resolver.hasFrame(wp.textureKey)
      ? wp.textureKey
      : (WEAPON_SPRITE_MAP[wp.weaponType] ?? 'weapon_dagger');
  const actualKey = lifecycle.resolver.safeTexture(textureKey, 'weapon_dagger');
  if (!lifecycle.resolver.hasFrame(actualKey)) return;
  const sprite = lifecycle.itemSpritePool
    .acquire('game', actualKey, wp.x, wp.y)
    .setOrigin(0.5)
    .setDepth(8);
  const weaponScale = getWeaponDisplayScale(wp.weaponType);
  const flipX = wp.flipH ? -1 : 1;
  const flipY = wp.flipV ? -1 : 1;
  sprite.setScale(weaponScale * flipX, weaponScale * flipY);
  sprite.setTint(getTierColor(wp.tier));
  if (wp.rotation) sprite.setRotation(wp.rotation);
  lifecycle.entities.set(key, { sprite, type: 'weaponpickup', baseY: wp.y });
}

export function removeWeaponPickup(lifecycle: EntityRendererLifecycle, key: string): void {
  lifecycle.removeEntity(key);
}

export function updateWeaponPickup(
  lifecycle: EntityRendererLifecycle,
  key: string,
  wp: WeaponPickupState,
): void {
  const e = lifecycle.entities.get(key);
  if (!hasEntitySprite(e)) return;
  e.sprite.setAlpha(wp.lifetime > 0 ? 1 : 0.3);
}

/* ── PowerUp ────────────────────────────────────────────── */

export function addPowerUp(lifecycle: EntityRendererLifecycle, key: string, p: PowerUpState): void {
  if (lifecycle.entities.has(key)) return;
  // Power-up icons live in the `ui` atlas (icon_cross/shield/star), with a
  // `vfx`-atlas fallback (circle_01) — they are NOT in `game`.
  const uiTexture = lifecycle.scene.textures.get('ui');
  const vfxTexture = lifecycle.scene.textures.get('vfx');
  const configs: Record<number, { tex: string; tint: number }> = {
    0: { tex: 'icon_cross', tint: powerUpTint(0) },
    1: { tex: 'icon_shield', tint: powerUpTint(1) },
    2: { tex: 'icon_star', tint: powerUpTint(2) },
  };
  const cfg = configs[p.type] ?? configs[0]!;
  let texture = 'vfx';
  let frame = 'circle_01';
  if (uiTexture.has(cfg.tex)) {
    texture = 'ui';
    frame = cfg.tex;
  }
  if (!vfxTexture.has(frame) && texture === 'vfx') return;
  const sprite = lifecycle.itemSpritePool
    .acquire(texture, frame, p.x, p.y)
    .setOrigin(0.5)
    .setDisplaySize(48, 48)
    .setDepth(8)
    .setAlpha(0.9)
    .setTint(cfg.tint);
  lifecycle.entities.set(key, { sprite, type: 'powerup', baseY: p.y });
  // Ticket 03 pickup pop: ground glow decal + radius sonar ping (pooled via
  // SpritePool inside PickupVFX; released on removePowerUp). The icon's
  // post-setDisplaySize scale is captured as the pulse base.
  lifecycle.vfx.pickup.attachPowerUpGlow(key, p.x, p.y, cfg.tint, sprite.scaleX);
}

export function removePowerUp(lifecycle: EntityRendererLifecycle, key: string): void {
  // Release the pooled glow sprites BEFORE dropping the registry entry so the
  // ground visuals never outlive the item.
  lifecycle.vfx.pickup.detachPowerUpGlow(key);
  lifecycle.removeEntity(key);
}

export function updatePowerUp(
  lifecycle: EntityRendererLifecycle,
  key: string,
  p: PowerUpState,
): void {
  const e = lifecycle.entities.get(key);
  if (!hasEntitySprite(e)) return;
  e.sprite.setAlpha(p.isActive ? 0.7 : 0.2);
  // Deactivated power-ups (server-authoritative) hide their glow; the per-frame
  // icon pulse in PickupVFX respects this flag too (ghost icon, no pulse).
  lifecycle.vfx.pickup.setPowerUpActive(key, p.isActive);
}
