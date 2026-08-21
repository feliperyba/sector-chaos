import { PlayerStatus } from '@sector-battle/shared';
import type { PlayerState } from '../types.js';
import { PLAYER_COLORS, WEAPON_SPRITE_MAP, AnimationState } from '../types.js';
import { PlayerAnimationController } from './PlayerAnimationController.js';
import { getWeaponVisualConfig, WEAPON_RENDER_SCALE } from './WeaponVisuals.js';
import { AnimSimDriver } from '../animation/AnimSimDriver.js';
import type { ArmRenderer } from './ArmRenderer.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';
import type { GhostTailState } from './GhostTailRenderer.js';
import type { PlayerVisual } from './PlayerRendererUpdate.js';
import { IDLE_LEFT, IDLE_RIGHT } from './PlayerRendererUpdate.js';
import { createArmJoints } from './PlayerRendererUpdateHelpers.js';

const COLOR_TINTS: Record<string, number> = {
  red: 0xff505a,
  blue: 0x5096ff,
  green: 0x50ff7e,
  yellow: 0xffe850,
  purple: 0xc850ff,
  orange: 0xff8c50,
  cyan: 0x50ffe8,
  pink: 0xff50c8,
};

export { COLOR_TINTS };

const BOT_DEBUG_ENABLED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('botDebug') === 'true';

/**
 * Create the COMPLETE per-player render bundle — body/hand/weapon/label
 * sprites, the 4 IK arm segments, the animation controller + driver, and the
 * per-player scratch objects (ArmJoints / DriverFrameInput) — as ONE unit.
 * Returns null if the body texture is missing.
 *
 * The counterpart of this creation unit is `PlayerRenderer.destroyBundle`:
 * everything created here dies there. No part of a player's render state is
 * owned anywhere else, so a player cannot be half-created or half-destroyed.
 */
export function createPlayerRenderBundle(
  scene: Phaser.Scene,
  key: string,
  p: PlayerState,
  armRenderer: ArmRenderer,
): PlayerRenderBundle | null {
  const colorIdx = (p.color ?? 0) % PLAYER_COLORS.length;
  const color = PLAYER_COLORS[colorIdx] ?? 'red';
  const px = p.x ?? 0;
  const py = p.y ?? 0;

  const bodyKey = `${color}_character`;
  const handKey = `${color}_hand`;
  if (!scene.textures.get('game').has(bodyKey)) return null;

  const body = scene.add
    .sprite(px, py, 'game', bodyKey)
    .setOrigin(0.5)
    .setDisplaySize(96, 96)
    .setDepth(10);
  const handTex = scene.textures.get('game').has(handKey);
  const controller = new PlayerAnimationController();

  const leftHand = scene.add
    .sprite(px + IDLE_LEFT.x, py + IDLE_LEFT.y, 'game', handTex ? handKey : bodyKey)
    .setOrigin(0.5)
    .setDepth(12)
    .setFlipX(true);
  const rightHand = scene.add
    .sprite(px + IDLE_RIGHT.x, py + IDLE_RIGHT.y, 'game', handTex ? handKey : bodyKey)
    .setOrigin(0.5)
    .setDepth(12);

  const weaponKey = getWeaponKey(p);
  const hasWeapon =
    p.weapons?.[p.activeSlot ?? 0]?.weaponType != null &&
    (p.weapons[p.activeSlot ?? 0]?.weaponType ?? 0) > 0;
  const weaponWt = p.weapons?.[p.activeSlot ?? 0]?.weaponType;
  const vc = getWeaponVisualConfig(weaponWt ?? 0, {
    scale: 0.56,
    originX: 0.5,
    originY: 0.85,
    flipX: false,
  });
  const weapon = scene.add
    .sprite(px + IDLE_RIGHT.x, py + IDLE_RIGHT.y, 'game', weaponKey)
    .setOrigin(vc.originX, vc.originY)
    .setScale(vc.scale * WEAPON_RENDER_SCALE)
    .setFlipX(vc.flipX)
    .setDepth(11)
    .setVisible(hasWeapon)
    // D1: secondary defense — start at alpha 0 when no real weapon is equipped.
    // getWeaponKey returns 'weapon_dagger' for FISTS/empty, so the factory's
    // texture is the dagger. With only setVisible(false) guarding it, any
    // transient re-show (resetForRespawn's old unconditional setVisible(true),
    // a stale patch, a future regression) pops the dagger at body center.
    // Alpha 0 + the per-frame empty-hide (PlayerRendererUpdate) make the
    // "no real weapon ⇒ invisible" invariant structural. Restored to 1 on the
    // first genuine equip in PlayerRenderer.updateWeapon.
    .setAlpha(hasWeapon ? 1 : 0);

  const rawName = (p.name ?? key).substring(0, 10);
  const displayName = BOT_DEBUG_ENABLED && p.isBot ? `[BOT] ${rawName}` : rawName;
  const playerTint = COLOR_TINTS[color] ?? 0xffffff;
  const label = scene.add
    .text(px, py - 60, displayName, {
      fontSize: '14px',
      color: '#' + playerTint.toString(16).padStart(6, '0'),
      fontFamily: DesignTokens.font.family,
      stroke: '#000000',
      strokeThickness: 3,
    })
    .setOrigin(0.5)
    .setDepth(DesignTokens.depth.floating);

  const initialWeapon = weaponWt ?? -1;
  const driver = new AnimSimDriver(initialWeapon);

  // Ghost-tail capture state (ticket 04): plain data, dies with the bundle.
  // The pooled ghost SPRITES it later emits are released by destroyBundle via
  // GhostTailRenderer.removeGhosts.
  const ghostTail: GhostTailState = {
    lastCaptureAt: 0,
    dashUntil: 0,
    speedBoostActive: false,
  };

  const visual: PlayerVisual = {
    body,
    leftHand,
    rightHand,
    weapon,
    label,
    targetX: px,
    targetY: py,
    prevBodyX: px,
    prevBodyY: py,
    smoothVelX: 0,
    smoothVelY: 0,
    facingAngle: p.facingAngle ?? 0,
    prevSpeed: p.speed ?? 0,
    prevStatus: p.status ?? PlayerStatus.ALIVE,
    prevHealth: p.health ?? 100,
    baseScale: 1.0,
    lastMoveTime: 0,
    isMoving: false,
    freshSpawn: false,
    equippedWeaponType: -1,
    // Ticket 20 dirty-check state: -1 = "no weapon ops applied yet" (mirrors
    // the equippedWeaponType sentinel). Written only by updateWeapon.
    lastTier: -1,
    // Initial weaponHidden mirrors the initial sprite visibility: a player with
    // no equipped weapon (hasWeapon=false → setVisible(false)) starts hidden.
    // Cleared by updateWeapon when a real weapon arrives.
    weaponHidden: !hasWeapon,
    bodyOffsetX: 0,
    bodyOffsetY: 0,
    bodyOffsetVelX: 0,
    bodyOffsetVelY: 0,
    bodyScaleX: 1.0,
    bodyScaleY: 1.0,
    bodyScaleVelX: 0,
    bodyScaleVelY: 0,
    hitStopRemaining: 0,
    prevAnimState: AnimationState.IDLE,
    trailCategory: null,
    victimImpactTime: 0,
    victimImpactDirX: 1,
    victimImpactDirY: 0,
    victimImpactHeft: 0,
    victimOffsetX: 0,
    victimOffsetY: 0,
    victimOffsetVelX: 0,
    victimOffsetVelY: 0,
    culled: false,
  };

  return {
    visual,
    controller,
    driver,
    arms: armRenderer.createArms(COLOR_TINTS[color] ?? 0xffffff),
    armJoints: createArmJoints(),
    frameInput: {
      facingAngle: 0,
      bodyX: 0,
      bodyY: 0,
      bodyVelX: 0,
      bodyVelY: 0,
      isMoving: false,
      weaponType: 0,
      isWorldBlocked: undefined,
    },
    trail: null,
    ghostTail,
  };
}

export function getWeaponKey(p: PlayerState): string {
  const slot = p.activeSlot ?? 0;
  const wt = p.weapons?.[slot]?.weaponType;
  return wt && wt > 0 ? (WEAPON_SPRITE_MAP[wt] ?? 'weapon_dagger') : 'weapon_dagger';
}
