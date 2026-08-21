/**
 * Shared player-rendering types — extracted from PlayerRendererUpdate to break
 * the cycle (Update ↔ UpdateHelpers) that existed when UpdateHelpers imported
 * `PlayerVisual` from Update while Update imported `applyBodyScaleSpring` back.
 * Behaviour is unchanged; this file only owns the shared type definition.
 */
import type Phaser from 'phaser';
import type { AnimationState } from '../types.js';
import type { AttackCategory } from '@sector-battle/shared';
import type { PlayerAnimationController } from './PlayerAnimationController.js';
import type { ArmRenderer, ArmJoints, PlayerArmSprites } from './ArmRenderer.js';
import type { WeaponTrailRenderer, TrailData } from './WeaponTrailRenderer.js';
import type { GhostTailRenderer, GhostTailState } from './GhostTailRenderer.js';
import type { AnimSimDriver, DriverFrameInput } from '../animation/AnimSimDriver.js';

export interface PlayerVisual {
  body: Phaser.GameObjects.Sprite;
  leftHand: Phaser.GameObjects.Sprite;
  rightHand: Phaser.GameObjects.Sprite;
  weapon: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  targetX: number;
  targetY: number;
  prevBodyX: number;
  prevBodyY: number;
  smoothVelX: number;
  smoothVelY: number;
  facingAngle: number;
  prevSpeed: number;
  prevStatus: number;
  prevHealth: number;
  baseScale: number;
  lastMoveTime: number;
  isMoving: boolean;
  freshSpawn: boolean;
  equippedWeaponType: number;
  /**
   * Persistent "weapon sprite should stay hidden" flag, set by the throw/break
   * event handlers (`PlayerRenderer.hideWeapon`) and cleared by `updateWeapon`
   * when a real weapon arrives in the slot. The per-frame block in
   * `PlayerRendererUpdate` respects this — it must NOT re-arm the weapon
   * (`setVisible(true)`) while this is true, even if `equippedWeaponType` is
   * still stale-positive during the throw/break → server-patch RTT window.
   *
   * Without this flag the per-frame `else if (equippedWeaponType >= 0)` branch
   * fights the event-driven hide: it re-arms the weapon every frame between the
   * event firing and `updateWeapon` clearing `equippedWeaponType` to -1, so the
   * thrown/broken weapon sprite flashes back onto the player's hand for one RTT.
   * See `.scratch/lighting-system-2/01-findings/B1-weapon-throw-break-render.md`
   * §3.2 (smoking gun) + §6 (scope of fix).
   */
  weaponHidden: boolean;
  /**
   * Tier of the weapon whose texture/scale/origin/flip/tint ops were last
   * applied by `updateWeapon` (ticket 20 dirty-check, together with
   * `equippedWeaponType` + `weaponHidden`). Only meaningful while
   * `equippedWeaponType >= 0` — the armed-branch dirty-check reads it solely
   * when the weapon type matches, so a stale value after a slot clear/respawn
   * (`equippedWeaponType === -1`) can never cause a false skip.
   */
  lastTier: number;
  bodyOffsetX: number;
  bodyOffsetY: number;
  bodyOffsetVelX: number;
  bodyOffsetVelY: number;
  bodyScaleX: number;
  bodyScaleY: number;
  bodyScaleVelX: number;
  bodyScaleVelY: number;
  hitStopRemaining: number;
  prevAnimState: AnimationState;
  trailCategory: AttackCategory | null;
  /** Timestamp of last incoming hit — drives victim squash + recoil decay. */
  victimImpactTime: number;
  /** Local-space direction of the incoming hit (for squash axis + recoil). */
  victimImpactDirX: number;
  victimImpactDirY: number;
  /** Heft of the weapon that struck (scales squash magnitude). */
  victimImpactHeft: number;
  /** Victim recoil offset (additive, spring-driven, independent of anim state). */
  victimOffsetX: number;
  victimOffsetY: number;
  victimOffsetVelX: number;
  victimOffsetVelY: number;
  /**
   * Current cull state (B4 perf C1). Tracks whether this player's sprites are
   * currently hidden because they're outside the view cull bounds. Toggled only
   * on the cull TRANSITION (visible→hidden, hidden→visible) — not every frame —
   * so it doesn't fight the death-fade / fresh-spawn / hit-flash visibility
   * logic that runs in the active path. When true, ALL of the player's sprites
   * (body, hands, weapon, label, 4 arm segments) are hidden so no stale
   * "ghost arms" linger at the viewport edge.
   */
  culled: boolean;
}

/**
 * SINGLE-OWNER per-player render bundle (ticket: gpu-player-render-bundle).
 *
 * Everything the client creates to render ONE player — body sprite, both hand
 * sprites, weapon sprite, name label, the 4 IK arm-segment sprites, the weapon
 * trail, the animation controller + driver, and the per-player scratch objects
 * (ArmJoints / DriverFrameInput) — hangs off this ONE object, owned by
 * `PlayerRenderer.bundles` (keyed by playerId, exactly as before).
 *
 * The bundle is created as one unit in `createPlayerRenderBundle` and destroyed
 * as one unit in `PlayerRenderer.destroyBundle`. Before this, teardown was
 * scattered across `PlayerRenderer.visuals/controllers/drivers` +
 * `armJointsPool` + `frameInputPool` + `ArmRenderer.players` +
 * `WeaponTrailRenderer.trails` — six separately-keyed maps whose entries could
 * drift out of sync (a remove that missed one map orphaned that map's sprites:
 * the documented "ghost arms at the teleport trap" bug class). With the bundle,
 * an arm segment CANNOT outlive its body sprite: they are fields of the same
 * object, so a single `bundles.delete(key)` removes every render part or none.
 *
 * `trail` is the exception to "created with the bundle": it is `null` until the
 * first attack with trail ghosts starts (`WeaponTrailRenderer.startTrail`) and
 * is nulled again when the trail expires/is evicted. Its lifecycle is managed
 * by `WeaponTrailRenderer` through this field; ownership stays with the bundle.
 */
export interface PlayerRenderBundle {
  /** Sprites + smoothed velocity + juice springs (body, hands, weapon, label). */
  visual: PlayerVisual;
  /** Per-player hit-flash controller. */
  controller: PlayerAnimationController;
  /** Per-player deterministic animation sim driver. */
  driver: AnimSimDriver;
  /** The 4 IK arm-segment sprites (independent scene-root objects, depth 9). */
  arms: PlayerArmSprites;
  /** ADR-0026 per-player ArmJoints scratch (allocated once at add, zero per frame). */
  armJoints: ArmJoints;
  /** ADR-0026 per-player DriverFrameInput scratch (allocated once at add, zero per frame). */
  frameInput: DriverFrameInput;
  /** Active weapon-trail capture, if any (lifecycle managed by WeaponTrailRenderer). */
  trail: TrailData | null;
  /**
   * Ghost-tail capture state (juice-pass-1 ticket 04). Unlike `trail`, plain
   * data created WITH the bundle (every player can dash/be boosted); the ghost
   * SPRITES a player emits are pooled and released via
   * `GhostTailRenderer.removeGhosts` from `destroyBundle` — they can never
   * outlive the player (the "ghost arms" bug class).
   */
  ghostTail: GhostTailState;
}

/**
 * Pre-allocated per-frame context for `updateAllPlayerFrames` (ADR-0026
 * zero-allocation rendering).
 *
 * Built ONCE in the `PlayerRenderer` constructor and reused every frame —
 * NEVER reallocated. The stable fields are the bundle map and the two shared
 * renderers; only `worldBlocked` and the view-cull bounds are mutated
 * (`worldBlocked` via `PlayerRenderer.setWorldBlockedQuery` — the
 * tile-blocking query is not known at construction time, it is wired later
 * from `GameSceneSetup`; the cull bounds are rewritten each tick in
 * `PlayerRenderer.update()`).
 *
 * The 3 per-call values (`localPlayerId`, `clampedDt`, `now`) stay as
 * function parameters — they change every frame and are NOT part of this
 * context.
 */
export interface PlayerFrameContext {
  /** Per-player render bundles — the single owner of all per-player render parts. */
  readonly bundles: Map<string, PlayerRenderBundle>;
  /** Arm segment renderer (stateless geometry helper over `bundle.arms`). */
  readonly armRenderer: ArmRenderer;
  /** Weapon trail renderer (capture + render ghost trail via `bundle.trail`). */
  readonly trailRenderer: WeaponTrailRenderer;
  /** Ghost tail renderer (motion afterimages for dash + speed boost, ticket 04). */
  readonly ghostTailRenderer: GhostTailRenderer;
  /**
   * Tile-blocking query for pose containment. Mutable: `null` at
   * construction, set later via `setWorldBlockedQuery`. NOT stable.
   */
  worldBlocked: ((x: number, y: number) => boolean) | null;
  /**
   * World-space view culling bounds for the current frame. Updated each tick
   * from `PlayerRenderer.update()` before `updateAllPlayerFrames` runs.
   * Off-screen remote players (outside `viewMinX..viewMaxX` × `viewMinY..viewMaxY`)
   * skip the expensive per-frame work (anim sim substeps, spring integration,
   * sprite mutators, arm IK) — the dominant O(N) cost in a 64-player match
   * where ~80% of players are off the zoomed-in top-down camera at any instant.
   *
   * The local player and players in active death-fade are always processed
   * (local = input owner; death-fade must finish so corpses despawn cleanly).
   *
   * Mutable per-frame; NOT part of the stable-post-construction invariant.
   */
  viewMinX: number;
  viewMinY: number;
  viewMaxX: number;
  viewMaxY: number;
}
