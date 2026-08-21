import Phaser from 'phaser';
import {
  AttackType,
  getAttackCategoryForAttack,
  resolveAttackType,
  msToTicks,
  COMBAT,
} from '@sector-battle/shared';
import type { PlayerState, AttackVisual } from '../types.js';
import { PLAYER_COLORS, AnimationState, VIEW_CULL_MARGIN_PX } from '../types.js';
import { AttackVFXRenderer } from './AttackVFXRenderer.js';
import { logger } from '@sector-battle/shared';
import { ArmRenderer } from './ArmRenderer.js';
import { JUICE_CONFIGS } from './JuiceConfig.js';
import { WeaponTrailRenderer } from './WeaponTrailRenderer.js';
import { GhostTailRenderer } from './GhostTailRenderer.js';
import { updateAllPlayerFrames } from './PlayerRendererUpdate.js';
import type { PlayerFrameContext, PlayerRenderBundle } from './PlayerRendererTypes.js';
import { createPlayerRenderBundle, COLOR_TINTS } from './PlayerRendererFactory.js';
import * as reactions from './PlayerRendererReactions.js';
import * as inventory from './PlayerRendererInventory.js';
import { debugArmLeak, type ArmLeakSnapshot } from './PlayerRendererDebug.js';

export interface SpriteState {
  x: number;
  y: number;
  facingAngle: number;
  animState: AnimationState;
  isMoving: boolean;
  visible: boolean;
  alpha: number;
  depth: number;
}

/**
 * SINGLE-OWNER player render lifecycle.
 *
 * Every per-player render object — body/hands/weapon/label sprites, the 4 IK
 * arm segments, the weapon trail, the animation controller + driver, and the
 * ArmJoints/DriverFrameInput scratch — lives on ONE `PlayerRenderBundle`
 * stored in `bundles` (keyed by playerId). `addPlayer` creates the whole unit,
 * `removePlayer`/`destroy` destroy the whole unit (`destroyBundle`), so no
 * render part can outlive its player: the "ghost arms at the teleport trap"
 * bug class (an arm-map entry surviving the visual-map entry, or vice versa)
 * is structurally impossible rather than patched around.
 */
export class PlayerRenderer {
  private scene: Phaser.Scene;
  private bundles = new Map<string, PlayerRenderBundle>();
  private vfxRenderer: AttackVFXRenderer;
  private trailRenderer: WeaponTrailRenderer;
  private ghostTailRenderer: GhostTailRenderer;
  private localPlayerId: string | null = null;
  private armRenderer: ArmRenderer;
  private lastFrameTime = 0;
  private frameContext!: PlayerFrameContext;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.vfxRenderer = new AttackVFXRenderer(scene);
    this.trailRenderer = new WeaponTrailRenderer(scene);
    this.ghostTailRenderer = new GhostTailRenderer(scene);
    this.armRenderer = new ArmRenderer(scene);
    this.frameContext = {
      bundles: this.bundles,
      armRenderer: this.armRenderer,
      trailRenderer: this.trailRenderer,
      ghostTailRenderer: this.ghostTailRenderer,
      worldBlocked: null,
      // View cull bounds — overwritten each tick in update() before the
      // per-player loop runs. Initialised to infinity so the very first frame
      // (before update sets the real camera rect) processes everyone, matching
      // the pre-cull behaviour.
      viewMinX: -Infinity,
      viewMinY: -Infinity,
      viewMaxX: Infinity,
      viewMaxY: Infinity,
    };
  }

  addPlayer(key: string, p: PlayerState): void {
    // Single owner: a re-add for an existing key is a no-op. (The old design
    // needed a defensive destroy-old-set in ArmRenderer.addPlayer because the
    // arm map could hold sprites for a key whose visual was already replaced —
    // overwriting the entry orphaned the previous 4 sprites. With the bundle
    // there is exactly one owner and one object; an early return cannot orphan
    // anything.)
    if (this.bundles.has(key)) return;
    const bundle = createPlayerRenderBundle(this.scene, key, p, this.armRenderer);
    if (!bundle) {
      logger.error(`Body texture missing for player ${key}`);
      return;
    }
    this.bundles.set(key, bundle);

    if (key === this.localPlayerId) {
      bundle.visual.label.setVisible(false);
    }
  }

  removePlayer(key: string): void {
    const bundle = this.bundles.get(key);
    // No defensive per-subsystem teardown: every render part of a player hangs
    // off the bundle, so destroying it (and deleting the single map entry)
    // removes ALL of them or NONE of them. No-op when the key was never added.
    if (!bundle) return;
    this.destroyBundle(bundle);
    this.bundles.delete(key);
  }

  /** Destroy every render part of one player — the single teardown unit. */
  private destroyBundle(bundle: PlayerRenderBundle): void {
    this.trailRenderer.removeTrail(bundle);
    // Ghost-tail sprites are pooled scene objects — release them HERE so a
    // ghost can never outlive its player (the "ghost arms" bug class).
    this.ghostTailRenderer.removeGhosts(bundle);
    this.armRenderer.destroyArms(bundle.arms);
    const v = bundle.visual;
    v.body.destroy();
    v.leftHand.destroy();
    v.rightHand.destroy();
    v.weapon.destroy();
    v.label.destroy();
    bundle.trail = null;
  }

  updatePosition(key: string, x: number, y: number): void {
    const v = this.bundles.get(key)?.visual;
    if (v) {
      v.targetX = x;
      v.targetY = y;
    }
  }

  /**
   * Read a player's current interpolated render position — the SAME value
   * `InterpolationService` writes to `targetX/targetY` each frame (which
   * `updateAllPlayerFrames` then copies onto the body sprite). Used by the
   * spectator camera so it tracks the smooth interpolated stream the sprite
   * renders at, instead of the raw authoritative patch position
   * (`stateSync.getPlayer().x/y`, which stair-steps at PATCH_RATE). Feeding the
   * camera the raw stream while the sprite glided on the 67 ms interpolator
   * produced per-patch camera↔sprite divergence — the visible spectator jitter.
   * Returns false when the player has no visual yet (the spectator camera falls
   * back to the raw position in that case).
   */
  getRenderPosition(key: string, out: { x: number; y: number }): boolean {
    const v = this.bundles.get(key)?.visual;
    if (!v) return false;
    out.x = v.targetX;
    out.y = v.targetY;
    return true;
  }

  setLocalPlayerId(id: string): void {
    this.localPlayerId = id;
    this.bundles.get(id)?.visual.label.setVisible(false);
  }

  /** Tile-blocking query for pose containment (same grid logic as server). */
  setWorldBlockedQuery(fn: (x: number, y: number) => boolean): void {
    // Load-bearing: mutates the pre-allocated context's worldBlocked field.
    this.frameContext.worldBlocked = fn;
  }

  private reactionCtx(): reactions.ReactionContext {
    return { bundles: this.bundles, localPlayerId: this.localPlayerId };
  }

  private inventoryCtx(): inventory.InventoryContext {
    return {
      bundles: this.bundles,
      scene: this.scene,
      armRenderer: this.armRenderer,
      trailRenderer: this.trailRenderer,
    };
  }

  /** Attacker-side hit-confirm: recoil impulse + hit-stop for the local player. */
  triggerMeleeHitReaction(key: string): void {
    reactions.triggerMeleeHitReaction(this.reactionCtx(), key);
  }

  /** Victim flinch from PlayerDamaged (world knockback vector from the event). */
  applyHitFlinch(key: string, kbWorldX: number, kbWorldY: number): void {
    reactions.applyHitFlinch(this.reactionCtx(), key, kbWorldX, kbWorldY);
  }

  /** Weapon-vs-shield clash from ShieldBlocked: both sides recoil. */
  triggerBlockClash(
    defenderId: string,
    attackerId: string,
    contactX: number | undefined,
    contactY: number | undefined,
    attackerWeaponType: number | undefined,
  ): void {
    reactions.triggerBlockClash(
      this.reactionCtx(),
      defenderId,
      attackerId,
      contactX,
      contactY,
      attackerWeaponType,
    );
  }

  /** Melee swing struck a wall: interrupt + recoil (WeaponWallHit event). */
  triggerWallHit(key: string): void {
    reactions.triggerWallHit(this.reactionCtx(), key);
  }

  snapPosition(key: string, x: number, y: number): void {
    const v = this.bundles.get(key)?.visual;
    if (!v) return;
    v.targetX = x;
    v.targetY = y;
    // Only a teleport-scale jump (respawn, spectator swap) hard-resets the
    // velocity tracking. This is called every frame for the local player —
    // resetting prevBody/smoothVel each time would zero the measured velocity
    // and permanently suppress the local walk animation.
    const dx = x - v.body.x;
    const dy = y - v.body.y;
    if (dx * dx + dy * dy > 100 * 100) {
      v.body.x = x;
      v.body.y = y;
      v.prevBodyX = x;
      v.prevBodyY = y;
      v.smoothVelX = 0;
      v.smoothVelY = 0;
    }
  }

  updateHealth(key: string, health: number, _maxHealth: number): void {
    const v = this.bundles.get(key)?.visual;
    if (v && v.prevHealth > 0 && health > v.prevHealth) this._onHeal?.(key, health - v.prevHealth);
    if (v) v.prevHealth = health;
  }

  private _onHeal: ((key: string, amount: number) => void) | null = null;
  setHealCallback(cb: (key: string, amount: number) => void): void {
    this._onHeal = cb;
  }

  resetForRespawn(key: string, x: number, y: number): void {
    inventory.resetForRespawn(this.inventoryCtx(), key, x, y);
  }

  updateWeapon(key: string, p: PlayerState): void {
    inventory.updateWeapon(this.inventoryCtx(), key, p);
  }

  /** Event-driven weapon hide for throw/break (B1); cleared by updateWeapon on a genuine change (C1). */
  hideWeapon(key: string): void {
    inventory.hideWeapon(this.inventoryCtx(), key);
  }

  setFreshSpawn(key: string, active: boolean): void {
    inventory.setFreshSpawn(this.inventoryCtx(), key, active);
  }

  triggerHitFlash(key: string): void {
    this.bundles.get(key)?.controller.triggerHitFlash(performance.now());
  }

  triggerDeath(key: string): void {
    this.bundles.get(key)?.driver.triggerDeath();
  }

  triggerDash(key: string): void {
    const bundle = this.bundles.get(key);
    if (!bundle) return;
    bundle.driver.triggerDash();
    // Ghost tail (ticket 04): arm the dash capture burst. This is the SINGLE
    // dash entry point — hit by BOTH the local input edge (GameSceneUpdate)
    // and the remote `dashCooldown` 0→>0 edge (PlayerVisualSync.syncDash).
    this.ghostTailRenderer.triggerDash(bundle, performance.now());
  }

  /**
   * Ghost tail (ticket 04): level-sync the server's `speedBoostActive` flag so
   * the per-frame capture gate can key off it (motion tail ONLY — the STATE
   * readout is the ticket-03 aura; see the ruling in PowerAuraVFX's header).
   */
  setSpeedBoost(key: string, active: boolean): void {
    const bundle = this.bundles.get(key);
    if (bundle) this.ghostTailRenderer.setSpeedBoost(bundle, active);
  }

  triggerStagger(key: string): void {
    // Default stagger length (weapon-break stagger); the exact server window
    // recovers via the synced status bitmask
    this.bundles.get(key)?.driver.triggerStagger(msToTicks(COMBAT.WEAPON_BREAK_STAGGER * 1000));
  }

  startWindup(key: string, weaponType: number, thrown = false): void {
    const bundle = this.bundles.get(key);
    if (!bundle) return;
    const driver = bundle.driver;
    if (thrown && weaponType <= 0) return;

    const attackType = resolveAttackType(weaponType, thrown ? AttackType.THROWN : undefined);

    if (attackType === AttackType.SHIELD) {
      if (!driver.blocking) driver.setBlockHeld(true);
      return;
    }

    if (driver.inAttackCycle) return;

    const poseCategory = getAttackCategoryForAttack(weaponType, attackType);
    const juice = JUICE_CONFIGS[poseCategory];
    if (juice.trailGhosts > 0) {
      this.trailRenderer.startTrail(
        bundle,
        juice.trailGhosts,
        juice.trailFadeMs,
        juice.trailOpacity,
        poseCategory,
        juice.trailWidth,
      );
      bundle.visual.trailCategory = poseCategory;
    }

    driver.startAttack(weaponType, thrown);
  }

  /** REMOTE players: re-base the attack phase clock to the server's. */
  applyServerAnimPhase(
    key: string,
    phase: number,
    ageTicks: number,
    comboIndex: number,
    weaponType: number,
    attackType: string,
    serverTick?: number,
    serverPhaseStartTick?: number,
  ): void {
    this.bundles
      .get(key)
      ?.driver.applyServerPhase(
        phase,
        ageTicks,
        comboIndex,
        weaponType,
        attackType,
        serverTick,
        serverPhaseStartTick,
      );
  }

  /** Level-sync the block state to the server (see AnimSimDriver). */
  syncBlock(key: string, serverBlocking: boolean): void {
    this.bundles.get(key)?.driver.syncServerBlock(serverBlocking);
  }

  /** Add contact hit-stop (only honored for the local player's visual). */
  addHitStop(key: string, ms: number): void {
    const v = this.bundles.get(key)?.visual;
    if (v && key === this.localPlayerId) v.hitStopRemaining += ms;
  }

  addAttack(visual: AttackVisual): void {
    this.vfxRenderer.addAttack(visual);
  }

  getPlayerPosition(key: string): { x: number; y: number } | null {
    const v = this.bundles.get(key)?.visual;
    if (!v) return null;
    return { x: v.body.x, y: v.body.y };
  }

  updateFacingAngle(key: string, angle: number): void {
    const v = this.bundles.get(key)?.visual;
    if (v) v.facingAngle = angle;
  }

  update(_delta: number): void {
    const now = performance.now();
    const dt = this.lastFrameTime > 0 ? (now - this.lastFrameTime) / 1000 : 1 / 60;
    this.lastFrameTime = now;
    const clampedDt = Math.min(dt, 1 / 20);

    const cam = this.scene.cameras.main;
    this.trailRenderer.setCameraCenter(cam.scrollX + cam.width / 2, cam.scrollY + cam.height / 2);

    // World-space view bounds for per-player culling. We pad the camera's world
    // view by VIEW_CULL_MARGIN_PX so sprites entering the frame don't pop — the
    // full pose/sim is already running by the time they're visible. camera.zoom
    // is already baked into worldView (it's a world-space rect), so we work
    // directly in world coordinates here.
    const wv = cam.worldView;
    const ctx = this.frameContext;
    ctx.viewMinX = wv.x - VIEW_CULL_MARGIN_PX;
    ctx.viewMinY = wv.y - VIEW_CULL_MARGIN_PX;
    ctx.viewMaxX = wv.right + VIEW_CULL_MARGIN_PX;
    ctx.viewMaxY = wv.bottom + VIEW_CULL_MARGIN_PX;

    updateAllPlayerFrames(this.frameContext, this.localPlayerId, clampedDt, now);

    this.vfxRenderer.drawAttacks(this.bundles, now);

    this.trailRenderer.render(now);
    // Ghost fade sweep runs OUTSIDE the per-player loop so already-emitted
    // ghosts keep fading even once their owner is culled off-screen.
    this.ghostTailRenderer.render(now);
  }

  getWeaponWorldState(
    key: string,
  ): { x: number; y: number; rotation: number; tint: number; scale: number } | null {
    const v = this.bundles.get(key)?.visual;
    if (!v || !v.weapon.visible) return null;
    return {
      x: v.weapon.x,
      y: v.weapon.y,
      rotation: v.weapon.rotation,
      tint: v.weapon.tint ? (v.weapon.tint as number) : 0xffffff,
      scale: v.weapon.scaleX,
    };
  }

  getSpriteState(key: string): SpriteState | null {
    const bundle = this.bundles.get(key);
    if (!bundle) return null;
    const v = bundle.visual;
    return {
      x: v.body.x,
      y: v.body.y,
      facingAngle: v.facingAngle,
      animState: bundle.driver.animState ?? AnimationState.IDLE,
      isMoving: v.isMoving,
      visible: v.body.visible,
      alpha: v.body.alpha,
      depth: v.body.depth,
    };
  }

  /**
   * Perf ticket 21 allocation-free peeks — the per-frame telemetry deps
   * (TelemetrySampler.sampleFrame via GameSceneHelpers) used to pay a fresh
   * 8-field SpriteState per call (2 allocs + 2 Map lookups per frame) just to
   * read one field. These return the SAME primitives getSpriteState would
   * (including the `?? AnimationState.IDLE` / missing-bundle fallbacks the
   * telemetry closures' `?? false` / `?? 0` coalesced to). getSpriteState
   * stays for cold readers (DebugBridge dev console).
   */
  peekIsMoving(key: string): boolean {
    return this.bundles.get(key)?.visual.isMoving ?? false;
  }

  peekAnimState(key: string): number {
    return this.bundles.get(key)?.driver.animState ?? AnimationState.IDLE;
  }

  setColor(key: string, colorIdx: number): void {
    const bundle = this.bundles.get(key);
    if (!bundle) return;
    const v = bundle.visual;
    const color = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length] ?? 'red';
    const bodyKey = `${color}_character`;
    const handKey = `${color}_hand`;
    if (this.scene.textures.get('game').has(bodyKey)) v.body.setTexture('game', bodyKey);
    if (this.scene.textures.get('game').has(handKey)) {
      v.leftHand.setTexture('game', handKey);
      v.rightHand.setTexture('game', handKey);
    }
    this.armRenderer.setTint(bundle.arms, COLOR_TINTS[color] ?? 0xffffff);
  }

  /**
   * DEBUG (Bug 2 — lingering arms): diagnose arm-sprite visibility state.
   * With the single-owner bundle, `orphanArmKeys` is structurally empty — arm
   * segments are fields of the same object as the body, so they cannot outlive
   * it. The field is kept (always []) so the `window.__SECTO_ARMS_DUMP` output
   * shape is unchanged for live captures; it now serves as the single
   * assertion of the bundle invariant. Body in PlayerRendererDebug.ts.
   */
  __debugArmLeak(): ArmLeakSnapshot {
    return debugArmLeak(this.bundles, this.localPlayerId);
  }

  destroy(): void {
    for (const bundle of this.bundles.values()) {
      this.destroyBundle(bundle);
    }
    this.bundles.clear();
    this.vfxRenderer.destroy();
    this.trailRenderer.destroy();
    this.ghostTailRenderer.destroy();
  }
}
