import { computeSnapThreshold } from '../types.js';
import type {
  LandmarkAssignment,
  LightPlacementTiled,
  MacroPoiNames,
  SectorLootTier,
  SectorType,
} from '@sector-battle/shared';
import { ExplosionLightRegistry } from '../rendering/lighting/ExplosionLightRegistry.js';
import { ImpactLightRegistry } from '../rendering/lighting/ImpactLightRegistry.js';

export class GameState {
  myId = '';
  mapLoaded = false;
  /**
   * Seed-authored loot-tier pyramid per sector (map-redesign ticket 02),
   * received once in the one-shot `mapData` message. Server-authoritative
   * identity data — the minimap tints sectors by tier from it. Null on
   * demo-TMX maps (no shared generation) → the minimap skips tier rendering.
   */
  sectorTiers: ReadonlyArray<ReadonlyArray<SectorLootTier>> | null = null;
  /**
   * Per-match hot sector (one non-central WARM sector upgraded to HOT for
   * the match) — the minimap marks it at match start. Null on demo maps.
   */
  hotSector: { row: number; col: number } | null = null;
  /**
   * Generated POI display name per sector (map-redesign ticket 03 /
   * DEC-001), received once in the one-shot `mapData` message. Server-
   * authored strings — every naming surface (minimap labels, enter-banner,
   * kill-feed location tags) renders FROM this grid and never generates
   * text client-side. Null on demo-TMX maps → those surfaces stay silent.
   */
  poiNames: ReadonlyArray<ReadonlyArray<string>> | null = null;
  /** Fixed-vocabulary macro-feature names (present features only). */
  macroPoiNames: MacroPoiNames | null = null;
  /**
   * Map designation, e.g. "RINGROAD • SPIRE • 63" (DEC-010) — shown at
   * match start (phase banner area) and on the results screen. Null on
   * demo maps.
   */
  designation: string | null = null;
  /**
   * Server-authored landmarks (map-redesign ticket 04 / DEC-002), received
   * once in the one-shot `mapData` message. The composite bake reads it at
   * map load (inside MapRenderer.render via the payload) and the minimap
   * icons read it per frame from here. The beacon LIGHTS ride the separate
   * lightPlacements array. Null on demo-TMX maps → no icons.
   */
  landmarks: LandmarkAssignment | null = null;
  /**
   * Server-authored sector type grid (map-redesign ticket 07 / DEC-006),
   * received once in the one-shot `mapData` message. The key for per-district
   * identity-sheet lookups (wall tints for live entities). Null on demo-TMX
   * maps → the legacy global wall tint.
   */
  sectorTypes: ReadonlyArray<ReadonlyArray<SectorType>> | null = null;
  /**
   * Map world width in pixels (`mapData.width * mapData.tileSize`), stashed
   * at map load. The naming surfaces use it to map world positions → sector
   * indices (the 4x4 grid spans exactly mapWorldW square).
   */
  mapWorldW = 0;
  /**
   * `performance.now()` of the most recent damage event on the LOCAL player
   * (written by the damage event handler). The enter-banner's combat-
   * suppression rule (DEC-001 banner discipline) reads it: while the player
   * is actively taking damage, transient banners stay suppressed.
   */
  lastLocalDamageAt = 0;
  /**
   * Deterministic static light-prop placements received once in the one-shot
   * `mapData` message (ticket 09). Cosmetic-only (GDD forbids fog of war).
   * Stashed here at map load so the lazily-booted lighting pipeline (which
   * boots on the first `update` after `mapLoaded`) can pick them up via
   * `bootLightingPipeline`. Re-uploaded if the set changes (ticket 11's
   * barrel-destruction re-upload reads this same field). Default empty.
   */
  lightPlacements: ReadonlyArray<LightPlacementTiled> = [];
  /**
   * Destructible-removal hook for static light cleanup (campfire fixture +
   * light disk). Set once by `bootLightingPipeline` (it closes over the
   * booted `LightingPipeline` + the scene's `LightPropRenderer`); invoked
   * from `ClientStateBridge.onDestructibleRemove` with the destroyed tile's
   * coords. Cosmetic-only — removing a campfire's motivated light is a visual
   * cleanup, not a visibility mechanic. Optional (undefined before the
   * pipeline boots / on Canvas fallback) → the bridge call is a safe no-op.
   */
  onLightPlacementRemoved?: (gridX: number, gridY: number) => void;
  /**
   * Per-explosion fire-light registry (ticket 11). Owns the brief fade-out
   * lifecycle for explosion lights — the ExplosionEventHandler registers on
   * every blast, the dynamic-light populator collects the live lights each
   * frame. Stored on GameState (the client-side mutable state bag) so both the
   * event bridge (constructed in GameSceneSetup) + the per-frame GameScene
   * update loop reach the same instance without a new GameScene field. Created
   * once at GameState construction; cleared on reset. Cosmetic-only.
   */
  readonly explosionLights = new ExplosionLightRegistry();
  /**
   * Per-combat-impact flash registry (ticket 09 / A3). Owns the brief flash +
   * decay lifecycle for combat-impact lights — the DamageEventHandler registers
   * on PlayerDamaged (melee hit) / ShieldBlocked / WeaponBroken, the
   * AttackEventHandler registers on ProjectileDestroyed (arrow impact); the
   * dynamic-light populator collects the live lights each frame. Stored on
   * GameState (the client-side mutable state bag) so the event bridge
   * (constructed in GameSceneSetup) + the per-frame GameScene update loop reach
   * the same instance without a new GameScene field. Created once at GameState
   * construction; cleared on reset. Cosmetic-only. Mirrors `explosionLights`.
   */
  readonly impactLights = new ImpactLightRegistry();
  localPos = { x: 0, y: 0 };
  localVelocity = { x: 0, y: 0 };
  rtt = { value: 0 };
  wasDead = false;
  lastActiveSlot = -1;
  footstepTimer = 0;
  freezeUntil = { value: 0 };
  localIsDashing = false;
  localDashRemaining = 0;
  correctionOffset = { x: 0, y: 0 };
  _returningToMenu = false;
  killCount = 0;

  reset(): void {
    this.myId = '';
    this.mapLoaded = false;
    this.sectorTiers = null;
    this.hotSector = null;
    this.poiNames = null;
    this.macroPoiNames = null;
    this.designation = null;
    this.landmarks = null;
    this.sectorTypes = null;
    this.mapWorldW = 0;
    this.lastLocalDamageAt = 0;
    this.lightPlacements = [];
    this.onLightPlacementRemoved = undefined;
    this.explosionLights.clear();
    this.impactLights.clear();
    this.localPos = { x: 0, y: 0 };
    this.localVelocity = { x: 0, y: 0 };
    this.rtt = { value: 0 };
    this.wasDead = false;
    this.lastActiveSlot = -1;
    this.footstepTimer = 0;
    this.freezeUntil = { value: 0 };
    this.localIsDashing = false;
    this.localDashRemaining = 0;
    this.correctionOffset = { x: 0, y: 0 };
    this._returningToMenu = false;
    this.killCount = 0;
  }

  /**
   * Apply the initial spawn position to the local player state. Called once
   * by ClientStateBridge.onPlayerAdd when the server confirms the local
   * player's spawn via the `playerAdded` schema callback. This is one of the
   * four phase-based external writers of `localPos` (spawn/resync/spectator/
   * respawn); routing it through a named method makes the spawn phase
   * discoverable instead of a bare `state.localPos.x = ...` write (ADR-0014
   * server-authoritative netcode — the server confirms the spawn, the client
   * seeds its simulation). Scalar args + mutate-in-place per ADR-0026
   * (zero allocation; the box identity of `localPos` is preserved so external
   * refs that captured it keep reading the updated values).
   *
   * @param x - Server-confirmed spawn X (world units).
   * @param y - Server-confirmed spawn Y (world units).
   */
  applySpawnPosition(x: number, y: number): void {
    this.localPos.x = x;
    this.localPos.y = y;
  }

  /**
   * Apply a server-authoritative resync position to the local player state.
   * Called by GameSceneSetup's PLAYER_RESYNC handler when the server pushes
   * a hard reposition (e.g. after a reconnect or a server-side teleport the
   * client cannot predict). This is one of the four phase-based external
   * writers of `localPos` (spawn/resync/spectator/respawn); unlike
   * `applyReconciledPosition` it is an unconditional snap (no
   * threshold gate, no `correctionOffset` smoothing — the server explicitly
   * told us to jump). Scalar args + mutate-in-place per ADR-0026 (zero
   * allocation; box identity preserved).
   *
   * @param x - Server-resync target X (world units).
   * @param y - Server-resync target Y (world units).
   */
  applyResyncPosition(x: number, y: number): void {
    this.localPos.x = x;
    this.localPos.y = y;
  }

  /**
   * Apply a spectator-follow position to the local player state. Called by
   * GameScene.update when the local player is dead and spectating — the
   * SpectatorController computes the followed target's interpolated position
   * each frame and writes it here so the camera and zone renderer follow the
   * spectated player. This is one of the four phase-based external writers of
   * `localPos` (spawn/resync/spectator/respawn); it is mutually exclusive in
   * time with the prediction-loop writer (the spectator branch runs only when
   * `isDead && spectator.isSpectating`). Scalar args + mutate-in-place per
   * ADR-0026 (zero allocation; box identity preserved).
   *
   * @param x - Spectated target's X (world units).
   * @param y - Spectated target's Y (world units).
   */
  applySpectatorPosition(x: number, y: number): void {
    this.localPos.x = x;
    this.localPos.y = y;
  }

  /**
   * Apply a respawn position to the local player state. Called by
   * PlayerLifecycleController.update when the local player transitions from
   * dead back to alive — the server has already placed the player at
   * `myPlayer.x/y` and the client seeds its prediction there. This is one of
   * the four phase-based external writers of `localPos`
   * (spawn/resync/spectator/respawn); the controller previously took
   * `localPos` as a function arg and mutated it directly, which leaked the
   * write past the state object. Routing it here makes the respawn phase
   * discoverable. Scalar args + mutate-in-place per ADR-0026 (zero
   * allocation; box identity preserved).
   *
   * @param x - Server-confirmed respawn X (world units).
   * @param y - Server-confirmed respawn Y (world units).
   */
  applyRespawnPosition(x: number, y: number): void {
    this.localPos.x = x;
    this.localPos.y = y;
  }

  /**
   * Apply a reconciled server-authoritative position to the local player
   * state. The canonical competitive-netcode model (Quake 3 / Fiedler /
   * Overwatch / Valorant): **the client's predicted position is authoritative
   * for feel. The server only corrects genuine large desync, and when it does,
   * the correction is visually smoothed so the player never sees a teleport.**
   *
   * The reconciler has already done rewind-and-replay. This method handles the
   * result with two simple rules:
   *
   * 1. **error < snap threshold**: IGNORE — no write. localPos, velocity, and
   *    correctionOffset are all untouched. The prediction runs uninterrupted.
   *    During normal play this is ALWAYS the path — the server's acked
   *    position is stale by 1-2 ticks (~7-14px at BASE_SPEED), which is below
   *    the 16px threshold. The prediction feels exactly like offline play.
   *
   * 2. **error ≥ snap threshold**: genuine desync (rare — respawn, collision
   *    mismatch, massive drift). Snap localPos to the reconciled position so
   *    the sim resyncs, absorb the delta into correctionOffset so the VISUAL
   *    glides to the new position instead of teleporting, AND adopt the
   *    reconciled velocity into localVelocity so the post-correction
   *    pos/vel state is consistent (NET-04 — the velocity is no longer
   *    silently dropped on the snap path). The offset decays at
   *    ERROR_DECAY_RATE=30 (~100ms — imperceptible). Because this path fires
   *    RARELY (only on ≥16px genuine desync), the offset can never accumulate
   *    into a steady-state drag.
   *
   * The velocity write is direct-set (no blended channel, no extension to the
   * ADR-0005/0010 render-offset model). It only fires on the genuine-desync
   * snap path, so it cannot introduce steady-state drift; it merely guarantees
   * that when a correction DOES fire, the visual does not glide forward on a
   * stale prediction velocity. ADR-0033 governs only the replay's INPUT seed;
   * this touches the OUTPUT velocity only and does not change the seed.
   *
   * WHY EVERY PRIOR ATTEMPT FAILED:
   * - Original (threshold=1px, rate=10): corrections fired EVERY patch (1px
   *   threshold is below normal tick staleness), offset accumulated (rate=10
   *   too slow at 60Hz patches) → permanent 20-68px drag → renderSpd=235.
   * - Drop (ignore all small): drift accumulated in localPos → periodic
   *   16px hard-snap → visible teleport.
   * - Blend (drag localPos toward server): directly decelerated the sim →
   *   sluggish.
   * - CPSR 3-tier (threshold=4px): still too low — normal divergence exceeded
   *   4px, smooth tier fired every patch, offset accumulated → sluggish.
   *
   * The fix: threshold = snapThreshold (16px+RTT). Normal tick staleness
   * (7-14px) is below this, so corrections DON'T FIRE during normal play.
   * The prediction runs uninterrupted — smooth, full-speed, no drag. Only
   * genuine ≥16px desync triggers a correction, and that correction is
   * visually smoothed so it reads as a brief glide, not a teleport.
   */
  applyReconciledPosition(
    reconciledX: number,
    reconciledY: number,
    reconciledVelX: number,
    reconciledVelY: number,
    rttMs = 0,
  ): boolean {
    const deltaX = reconciledX - this.localPos.x;
    const deltaY = reconciledY - this.localPos.y;
    const posError = Math.hypot(deltaX, deltaY);

    const snapThreshold = computeSnapThreshold(rttMs);

    // Prediction authoritative — NO WRITE. This is the normal-play path.
    // The server's acked position is 1-2 ticks stale (7-14px), below the 16px
    // threshold. No correction, no offset, no disruption. localPos,
    // localVelocity, and correctionOffset are all untouched (ADR-0005/0010
    // render-offset model preserved on this path).
    if (posError < snapThreshold) return false;

    // Genuine desync (≥16px — rare). Snap localPos to resync the sim, absorb
    // the delta into correctionOffset so the VISUAL position glides smoothly
    // to the new sim position instead of teleporting, and adopt the reconciled
    // velocity so localVelocity is consistent with the snapped localPos
    // (NET-04 — previously the reconciled velocity was silently dropped here,
    // leaving localVelocity at the prediction's value and the post-correction
    // pos/vel pair inconsistent → the visual glided forward on a stale
    // velocity). The offset decays at ERROR_DECAY_RATE=30 (~100ms). Because
    // this fires rarely (only on genuine large desync), the offset can never
    // accumulate. Direct-set only — no blended/velocity-smoothing channel.
    this.localPos.x = reconciledX;
    this.localPos.y = reconciledY;
    this.localVelocity.x = reconciledVelX;
    this.localVelocity.y = reconciledVelY;
    this.correctionOffset.x -= deltaX;
    this.correctionOffset.y -= deltaY;
    return true;
  }
}
