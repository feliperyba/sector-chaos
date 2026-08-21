import { PlayerStatus } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { StatusEffectRenderer } from '../../rendering/StatusEffectRenderer.js';
import type { PlayerState } from '../../types.js';

export interface PlayerVisualSyncDeps {
  myId: { value: string };
  playerRenderer: PlayerRenderer;
  statusEffects: StatusEffectRenderer;
  audio: AudioService;
  /** Current server tick from the synced game state (0 until first patch). */
  getServerTick: () => number;
}

/**
 * Syncs visual state from server patches.
 *
 * The server's anim phase is the single source of truth for EVERY player:
 * syncAnimPhase and stagger run for local and remote alike, so all clients
 * render the same authoritative animation. Local input prediction only
 * provides the instant START of blocks/dashes/windups (those edge triggers
 * stay local-driven in GameScene); the phase clock then converges to the
 * server's, and attacks the server rejected are cancelled by the driver.
 */
export class PlayerVisualSync {
  private readonly playerStaggerState = new Map<string, boolean>();
  private readonly playerFreshSpawnState = new Map<string, boolean>();
  private readonly playerWindupState = new Map<string, boolean>();
  private readonly playerDashCooldown = new Map<string, number>();
  private readonly playerWasDead = new Map<string, boolean>();
  private readonly deathTriggered = new Map<string, boolean>();
  /** Tracks previous activeSlot per remote player for weapon-switch edge detection. */
  private readonly playerActiveSlot = new Map<string, number>();

  constructor(private readonly deps: PlayerVisualSyncDeps) {}

  /**
   * Idempotent death-edge: trigger the death fade (driver → DYING) + drop status
   * effects the first time a player is seen dead. Called from BOTH
   * `handlePlayerChange` (the status-edge on subsequent patches) AND the bridge's
   * `onPlayerAdd` — so a player who arrives in the snapshot ALREADY dead
   * (reconnect-as-spectator, mid-match join with a corpse present) still enters
   * the fade. Without this, such a player's driver stays IDLE, the DYING fade
   * never runs, and the corpse's body + arms linger at full alpha forever
   * (`ArmRenderer` sprites are independent scene-root objects, so only the
   * DYING-fade / cull paths hide them; an on-screen IDLE corpse is never culled).
   * See `PlayerRendererUpdate.arms-linger.diag.test.ts` (S2) for the repro.
   */
  ensureDeathFade(p: PlayerState, key: string): void {
    const isDead =
      (p.status & (PlayerStatus.DYING | PlayerStatus.DEAD | PlayerStatus.SPECTATING)) !== 0;
    if (!isDead) return;
    if (this.deathTriggered.get(key) ?? false) return;
    this.deps.playerRenderer.triggerDeath(key);
    this.deps.statusEffects.removePlayer(key);
    this.deathTriggered.set(key, true);
  }

  handlePlayerChange(p: PlayerState, key: string): void {
    const isLocal = key === this.deps.myId.value;

    // ── Death detection via status bitmask ──
    // Fallback for when KILL_FEED message hasn't arrived yet (or is lost).
    // Once a player enters DYING/DEAD/SPECTATING, trigger the death fade
    // and stop all further visual updates on the corpse. Shared with
    // onPlayerAdd via ensureDeathFade so a player who arrives ALREADY dead
    // (reconnect-as-spectator / mid-match join) also fades — otherwise its
    // driver never enters DYING and its body + arms linger at full alpha
    // (the floating-arms bug; the cull can't help an on-screen corpse).
    this.ensureDeathFade(p, key);
    const isDead =
      (p.status & (PlayerStatus.DYING | PlayerStatus.DEAD | PlayerStatus.SPECTATING)) !== 0;
    if (isDead) return;

    // ── Universal: UI/visuals only, no animation state ──
    this.deps.playerRenderer.updateHealth(key, p.health, p.maxHealth);
    this.deps.playerRenderer.updateWeapon(key, p);
    if (!isLocal) {
      this.deps.playerRenderer.updateFacingAngle(key, p.facingAngle);
    }
    this.deps.statusEffects.updatePlayerStatus(key, p.x, p.y, p.status, 0);
    this.deps.statusEffects.updateBarrier(key, p.x, p.y, p.barrierActive);
    this.deps.statusEffects.updateSpeedBoost(key, p.x, p.y, p.speedBoostActive);
    // Ghost tail (ticket 04): level-sync the motion-tail gate off the same
    // patched flag the aura reads (tail = MOTION only; STATE lives in the
    // ticket-03 aura — see ruling in PowerAuraVFX's header).
    this.deps.playerRenderer.setSpeedBoost(key, !!p.speedBoostActive);

    // ── All players: server-authoritative animation state ──
    // Stagger is never predicted client-side — without this the local player
    // would skip the stagger pose entirely while remote views show it.
    const staggerStarted = this.syncStagger(key, p);
    this.syncAnimPhase(key, p);
    // Block hold/release follows the server for everyone — the local press is
    // predicted for instant guard-up, but the release edge only lives here.
    this.syncBlock(key, p);

    // ── Remote-only: edge triggers the local player predicts from input ──
    if (!isLocal) {
      this.syncDash(key, p);
      this.syncWeaponSwitch(key, p);
      this.syncWindup(key, p);
      this.syncRespawn(key, p);
    }

    // ── Local-only: audio hooks ──
    if (isLocal) {
      if (staggerStarted) this.deps.audio.playStagger();

      const isFreshSpawn = (p.status & PlayerStatus.FRESH_SPAWN) !== 0;
      const wasFreshSpawn = this.playerFreshSpawnState.get(key) ?? false;
      if (wasFreshSpawn && !isFreshSpawn) this.deps.audio.playSpawnProtectionEnd();
      this.playerFreshSpawnState.set(key, isFreshSpawn);

      // Fresh spawn visual handled by prediction, but set the flag for the renderer
      this.deps.playerRenderer.setFreshSpawn(key, isFreshSpawn);
    }
  }

  removePlayer(key: string): void {
    this.playerStaggerState.delete(key);
    this.playerFreshSpawnState.delete(key);
    this.playerWindupState.delete(key);
    this.playerDashCooldown.delete(key);
    this.playerWasDead.delete(key);
    this.deathTriggered.delete(key);
    this.playerActiveSlot.delete(key);
  }

  // ── Remote-only sync methods ──

  private syncBlock(key: string, p: PlayerState): void {
    // Level sync, not edge: a locally predicted block the server never
    // confirmed has no falling edge and would lock the BLOCK pose forever.
    this.deps.playerRenderer.syncBlock(key, !!p.isBlocking);
  }

  /** Returns true on the not-staggered → staggered edge. */
  private syncStagger(key: string, p: PlayerState): boolean {
    const isStaggered = (p.status & PlayerStatus.STAGGERED) !== 0;
    const wasStaggered = this.playerStaggerState.get(key) ?? false;
    const started = isStaggered && !wasStaggered;
    if (started) {
      this.deps.playerRenderer.triggerStagger(key);
    }
    this.playerStaggerState.set(key, isStaggered);
    return started;
  }

  private syncDash(key: string, p: PlayerState): void {
    const prevCooldown = this.playerDashCooldown.get(key) ?? 0;
    const currCooldown = p.dashCooldown ?? 0;
    if (currCooldown > 0 && prevCooldown === 0) {
      this.deps.playerRenderer.triggerDash(key);
      // Positional dash SFX for remote players (local player's own dash is
      // triggered from input via AudioTriggerService).
      this.deps.audio.playAt('dash', p.x, p.y, 0.4);
    }
    this.playerDashCooldown.set(key, currCooldown);
  }

  /** Plays a positional weapon-switch SFX on remote slot change. */
  private syncWeaponSwitch(key: string, p: PlayerState): void {
    const currSlot = p.activeSlot ?? 0;
    const prevSlot = this.playerActiveSlot.get(key);
    if (prevSlot !== undefined && prevSlot !== currSlot) {
      this.deps.audio.playAt('weapon_switch', p.x, p.y, 0.4);
    }
    this.playerActiveSlot.set(key, currSlot);
  }

  private syncWindup(key: string, p: PlayerState): void {
    const isWindup = !!p.isWindupActive;
    const wasWindup = this.playerWindupState.get(key) ?? false;
    if (isWindup && !wasWindup) {
      this.deps.playerRenderer.startWindup(
        key,
        p.windupWeaponType ?? 0,
        p.windupAttackType === 'thrown',
      );
    }
    this.playerWindupState.set(key, isWindup);
  }

  /**
   * Align the remote attack cycle to the server's phase clock: the swing must
   * render where/when the authoritative hitbox actually sweeps. Edge triggers
   * alone start the windup ~RTT late; this re-bases progress every patch.
   */
  private syncAnimPhase(key: string, p: PlayerState): void {
    const serverTick = this.deps.getServerTick();
    if (serverTick <= 0) return;
    const phaseStartTick = p.animPhaseStartTick ?? 0;
    const ageTicks = Math.max(0, serverTick - phaseStartTick);
    const fallbackWeapon = p.weapons?.[p.activeSlot ?? 0]?.weaponType ?? 0;
    this.deps.playerRenderer.applyServerAnimPhase(
      key,
      p.animPhase ?? 0,
      ageTicks,
      p.comboIndex ?? 0,
      p.isWindupActive && p.windupWeaponType ? p.windupWeaponType : fallbackWeapon,
      p.windupAttackType ?? '',
      // B4 H6: thread the absolute server tick + phase-start tick so the driver
      // can advance its lagging simTick to match (root cause of the persistent
      // phase-clock drift warnings). Without this, a slow frame / hit-stop drops
      // the client simTick behind and the drift compounds every patch.
      serverTick,
      phaseStartTick,
    );
  }

  private syncRespawn(key: string, p: PlayerState): void {
    const wasDead = this.playerWasDead.get(key) ?? false;
    const isDead =
      (p.status & (PlayerStatus.DYING | PlayerStatus.DEAD | PlayerStatus.SPECTATING)) !== 0;
    if (wasDead && !isDead) {
      this.deps.playerRenderer.resetForRespawn(key, p.x, p.y);
      this.deathTriggered.delete(key);
    }
    this.playerWasDead.set(key, isDead);
  }
}
