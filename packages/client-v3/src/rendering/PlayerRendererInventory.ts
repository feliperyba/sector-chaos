/**
 * PlayerRendererInventory — inventory/appearance state-sync methods
 * (updateWeapon / hideWeapon / setFreshSpawn / resetForRespawn).
 *
 * Mechanical extraction from PlayerRenderer.ts (max-lines cap): bodies are
 * verbatim, `this.bundles` / `this.scene` / `this.armRenderer` /
 * `this.trailRenderer` → `ctx.` references (the PlayerRendererReactions
 * ctx pattern).
 */
import Phaser from 'phaser';
import { weaponRegistry, WeaponType } from '@sector-battle/shared';
import type { PlayerState } from '../types.js';
import { WEAPON_SPRITE_MAP, AnimationState } from '../types.js';
import { getTierColor, WEAPON_RENDER_SCALE } from './WeaponVisuals.js';
import type { ArmRenderer } from './ArmRenderer.js';
import type { WeaponTrailRenderer } from './WeaponTrailRenderer.js';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';

export interface InventoryContext {
  bundles: Map<string, PlayerRenderBundle>;
  scene: Phaser.Scene;
  armRenderer: ArmRenderer;
  trailRenderer: WeaponTrailRenderer;
}

export function resetForRespawn(ctx: InventoryContext, key: string, x: number, y: number): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const v = bundle.visual;
  bundle.controller.reset();
  bundle.driver.reset(v.equippedWeaponType);
  v.body.setAlpha(1).setVisible(true).setScale(v.baseScale, v.baseScale);
  v.leftHand.setAlpha(1).setVisible(true);
  v.rightHand.setAlpha(1).setVisible(true);
  v.weapon.setAlpha(0).setVisible(false); // D1: do NOT re-show on respawn — defer to inventory state
  v.equippedWeaponType = -1;
  v.weaponHidden = true;
  ctx.armRenderer.setAlpha(bundle.arms, 1);
  ctx.armRenderer.setVisible(bundle.arms, true);
  v.targetX = x;
  v.targetY = y;
  v.body.setPosition(x, y);
  v.bodyOffsetX = 0;
  v.bodyOffsetY = 0;
  v.bodyOffsetVelX = 0;
  v.bodyOffsetVelY = 0;
  v.bodyScaleX = 1.0;
  v.bodyScaleY = 1.0;
  v.bodyScaleVelX = 0;
  v.bodyScaleVelY = 0;
  v.hitStopRemaining = 0;
  v.prevAnimState = AnimationState.IDLE;
  v.trailCategory = null;
  v.victimImpactTime = 0;
  v.victimOffsetX = 0;
  v.victimOffsetY = 0;
  v.victimOffsetVelX = 0;
  v.victimOffsetVelY = 0;
  v.prevBodyX = x;
  v.prevBodyY = y;
  v.smoothVelX = 0;
  v.smoothVelY = 0;
  ctx.trailRenderer.stopTrail(bundle);
}

export function updateWeapon(ctx: InventoryContext, key: string, p: PlayerState): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const v = bundle.visual;
  const driver = bundle.driver;
  const weapon = p.weapons?.[p.activeSlot ?? 0];
  if (weapon && weapon.weaponType > 0) {
    // Ticket 20 dirty-check: a steady-state patch (same weapon, same tier, no
    // hide in effect) would only re-apply the exact texture/scale/origin/flip/
    // tint already on the sprite — skip it. The C1 re-show gate below reads
    // the SAME state, so a skipped patch could never have re-shown the weapon
    // (`!v.weaponHidden` is true here ⇒ the C1 branch would only have re-run
    // the idempotent setVisible(true).setAlpha(1)). A throw/break hide
    // (`weaponHidden === true`) deliberately FAILS this check so the C1
    // stale-patch gate below stays reachable exactly as before.
    if (
      v.equippedWeaponType === weapon.weaponType &&
      v.lastTier === weapon.tier &&
      !v.weaponHidden
    ) {
      return;
    }
    const sk = WEAPON_SPRITE_MAP[weapon.weaponType] ?? 'weapon_dagger';
    if (ctx.scene.textures.get('game').has(sk)) v.weapon.setTexture('game', sk);
    const def = weaponRegistry.getDefinition(weapon.weaponType as WeaponType);
    v.weapon.setScale(def.visual.scale * WEAPON_RENDER_SCALE);
    v.weapon.setOrigin(def.visual.originX, def.visual.originY);
    v.weapon.setFlipX(def.visual.flipX);
    v.weapon.setTint(getTierColor(weapon.tier));
    if (v.equippedWeaponType !== weapon.weaponType || !v.weaponHidden) {
      // C1: skip re-show on stale same-weapon patch (throw/break → slot-clear RTT)
      v.weapon.setVisible(true).setAlpha(1); // D1: restore alpha w/ visibility (secondary defense)
      v.weaponHidden = false;
    }
    if (v.equippedWeaponType !== weapon.weaponType) driver.setWeapon(weapon.weaponType);
    v.equippedWeaponType = weapon.weaponType;
    v.lastTier = weapon.tier;
  } else {
    // Ticket 20 dirty-check: a steady empty-slot patch (already fists + hidden)
    // would only re-assert the alpha-0/hidden state already in effect — skip
    // it. The per-frame empty-hide (PlayerRendererUpdate) remains the primary
    // D1 defense every frame; this setAlpha(0) is the secondary defense and is
    // applied on every transition INTO the empty state.
    if (v.equippedWeaponType === -1 && v.weaponHidden) {
      return;
    }
    v.weapon.setAlpha(0).setVisible(false); // D1: drop alpha as secondary defense (primary: per-frame empty-hide)
    v.weaponHidden = true; // empty/fists — keep hidden (B1)
    if (v.equippedWeaponType !== -1) {
      v.equippedWeaponType = -1;
      driver.setWeapon(WeaponType.FISTS);
    }
  }
}

/** Event-driven weapon hide for throw/break (B1); cleared by updateWeapon on a genuine change (C1). */
export function hideWeapon(ctx: InventoryContext, key: string): void {
  const v = ctx.bundles.get(key)?.visual;
  if (!v) return;
  v.weapon.setAlpha(0).setVisible(false); // D1: secondary defense (see updateWeapon empty branch)
  v.weaponHidden = true;
}

export function setFreshSpawn(ctx: InventoryContext, key: string, active: boolean): void {
  const bundle = ctx.bundles.get(key);
  if (!bundle) return;
  const v = bundle.visual;
  if (!active && v.freshSpawn) {
    v.body.setAlpha(1);
    v.leftHand.setAlpha(1);
    v.rightHand.setAlpha(1);
    if (v.equippedWeaponType >= 0) v.weapon.setAlpha(1); // D1: only restore alpha when a real weapon is equipped
  }
  if (active && !v.freshSpawn) {
    bundle.driver.setWeapon(v.equippedWeaponType >= 0 ? v.equippedWeaponType : WeaponType.FISTS);
  }
  v.freshSpawn = active;
}
