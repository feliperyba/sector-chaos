import { getAttackCategory, weaponRegistry, type AttackCategory } from '@sector-battle/shared';
import type { WeaponType } from '@sector-battle/shared';

export interface JuiceParams {
  /** Hit-stop on CONTACT with flesh (ms). Walls/blocks/tiles scale from it. */
  hitStopMs: number;
  /** Camera shake on CONTACT (never on a whiffed swing). */
  shakeIntensity: number;
  shakeDurationMs: number;
  /** Directional camera punch at full strength (contact); whiffs use a fraction. */
  cameraPunch: number;
  /** Zoom punch on a confirmed flesh hit. */
  cameraZoomPct: number;
  cameraZoomMs: number;
  bodyLean: number;
  overshootPx: number;
  recoverySquashY: number;
  recoveryMs: number;
  trailGhosts: number;
  trailFadeMs: number;
  trailOpacity: number;
  /** Stroke width of the blade-segment trail ribbon (px). */
  trailWidth: number;
}

/**
 * Juice is CONTACT-driven: a swing through air only carries its own motion
 * (plus a slight directional camera lean); hit-stop, shake, and zoom fire on
 * the event that proves something was struck, scaled by what was struck —
 * flesh = full, indestructible wall = hardest/shortest, destructible = medium.
 *
 * Trail params (ghosts/fade/opacity/width) were juiced up for the new art —
 * richer arcs so swings read more visibly. Tune per category by eye.
 */
export const JUICE_CONFIGS: Record<AttackCategory, JuiceParams> = {
  fists: {
    hitStopMs: 35,
    shakeIntensity: 1.5,
    shakeDurationMs: 90,
    cameraPunch: 2,
    cameraZoomPct: 0,
    cameraZoomMs: 0,
    bodyLean: 8,
    overshootPx: 12,
    recoverySquashY: 0.95,
    recoveryMs: 80,
    trailGhosts: 4,
    trailFadeMs: 110,
    trailOpacity: 0.38,
    trailWidth: 4,
  },
  arc: {
    hitStopMs: 65,
    shakeIntensity: 2.5,
    shakeDurationMs: 130,
    cameraPunch: 4,
    cameraZoomPct: 1,
    cameraZoomMs: 80,
    bodyLean: 15,
    overshootPx: 20,
    recoverySquashY: 0.9,
    recoveryMs: 130,
    trailGhosts: 7,
    trailFadeMs: 160,
    trailOpacity: 0.58,
    trailWidth: 8,
  },
  line: {
    hitStopMs: 50,
    shakeIntensity: 2,
    shakeDurationMs: 100,
    cameraPunch: 3,
    cameraZoomPct: 0,
    cameraZoomMs: 0,
    bodyLean: 16,
    overshootPx: 15,
    recoverySquashY: 0.93,
    recoveryMs: 100,
    trailGhosts: 5,
    trailFadeMs: 100,
    trailOpacity: 0.5,
    trailWidth: 6,
  },
  ranged: {
    hitStopMs: 20,
    shakeIntensity: 1,
    shakeDurationMs: 60,
    cameraPunch: 1,
    cameraZoomPct: 0,
    cameraZoomMs: 0,
    bodyLean: 2,
    overshootPx: 5,
    recoverySquashY: 0.98,
    recoveryMs: 60,
    trailGhosts: 3,
    trailFadeMs: 60,
    trailOpacity: 0.4,
    trailWidth: 3,
  },
  shield: {
    hitStopMs: 70,
    shakeIntensity: 3,
    shakeDurationMs: 140,
    cameraPunch: 5,
    cameraZoomPct: 1,
    cameraZoomMs: 100,
    bodyLean: 12,
    overshootPx: 18,
    recoverySquashY: 0.88,
    recoveryMs: 150,
    trailGhosts: 3,
    trailFadeMs: 90,
    trailOpacity: 0.42,
    trailWidth: 10,
  },
  thrown: {
    hitStopMs: 25,
    shakeIntensity: 1,
    shakeDurationMs: 60,
    cameraPunch: 1.5,
    cameraZoomPct: 0,
    cameraZoomMs: 0,
    bodyLean: 5,
    overshootPx: 8,
    recoverySquashY: 0.95,
    recoveryMs: 70,
    trailGhosts: 4,
    trailFadeMs: 130,
    trailOpacity: 0.48,
    trailWidth: 4,
  },
};

/** Heaviest hitStaggerMs in the registry — normalizes per-weapon heft. */
const MAX_HIT_STAGGER_MS = 360;

/**
 * Per-WEAPON contact juice: the category baseline scaled by the weapon's
 * heft. hitStaggerMs is the registry's balance measure of how hard a weapon
 * lands (dagger 0 … hammer 280), so impact feedback rides the same stat —
 * a dagger stings (×0.75) while a hammer slams (×1.35) within the same
 * category, and tuning the registry retunes the feel automatically.
 */
export function getImpactJuice(weaponType: number): JuiceParams {
  const base = JUICE_CONFIGS[getAttackCategory(Math.max(0, weaponType))];
  let heft = 0.4;
  try {
    const stats = weaponRegistry.getDefinition(Math.max(0, weaponType) as WeaponType).baseStats;
    heft = Math.min(1, Math.max(0, (stats.hitStaggerMs ?? 0) / MAX_HIT_STAGGER_MS));
  } catch {
    /* unknown weapon — neutral heft */
  }
  const m = 0.75 + heft * 0.6;
  return {
    ...base,
    hitStopMs: base.hitStopMs * m,
    shakeIntensity: base.shakeIntensity * m,
    shakeDurationMs: base.shakeDurationMs * (0.85 + heft * 0.3),
    cameraPunch: base.cameraPunch * m,
    cameraZoomPct: base.cameraZoomPct * m,
  };
}

/** Contact-surface scaling applied on top of the per-category params. */
export const CONTACT_JUICE = {
  /** Whiffed swing: fraction of cameraPunch, nothing else. */
  whiffPunchScale: 0.35,
  /** Indestructible wall: abrupt dead stop — harder shake, shorter ring. */
  wallHitStopScale: 0.8,
  wallShakeScale: 1.4,
  wallShakeDurationScale: 0.6,
  /** Destructible tile breaking under the blade. */
  destructibleHitStopScale: 0.5,
  destructibleShakeScale: 0.9,
  /** Weapon-vs-shield clash (attacker side). */
  clashHitStopScale: 0.7,
  /** Victim screen feedback runs below attacker feedback. */
  victimShakeScale: 0.85,
  victimPunchScale: 0.7,
} as const;
