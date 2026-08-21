import type Phaser from 'phaser';
import { SpritePool } from './vfx/SpritePool.js';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * GHOST TAIL — shared motion-afterimage renderer (juice-pass-1 ticket 04).
 *
 * ONE system serves BOTH triggers:
 *   • DASH       — a ~480ms capture burst armed by `PlayerRenderer.triggerDash`
 *                  (the single entry point hit by BOTH the local input edge in
 *                  `GameSceneUpdate` and the remote `dashCooldown` 0→>0 edge in
 *                  `PlayerVisualSync.syncDash`).
 *   • SPEED BOOST — per-frame level-sync on the already-wired `speedBoostActive`
 *                  flag (`PlayerRenderer.setSpeedBoost` ← `PlayerVisualSync`);
 *                  NO second state readout is added (see ruling below).
 *
 * AURA-VS-TAIL DIVISION (binding ruling from ticket 03, also in the
 * `PowerAuraVFX.ts` header): the AURA conveys STATE (amber ring + spinners +
 * risers — radial, directionless); the GHOST TAIL conveys MOTION. Everything
 * here is velocity-coupled: afterimages are pose/facing/scale COPIES of the
 * body sprite, spawned along the movement vector, gated on actual movement.
 * There is deliberately NO ring, NO pulse, NO directionless element here.
 *
 * Each ghost is a pooled sprite snapshot (SpritePool.acquire — never bare
 * `scene.add.sprite`) of the CURRENT body: texture 'game' + its live atlas
 * frame (`${color}_character`, follows skin changes), world position, rotation,
 * and the dash-stretched (1.3/0.8) scale at capture time. Positions captured
 * are the RENDERED ones (predicted local / 67ms-interpolated remote) — zero
 * netcode, zero server work, render-only (never feeds back into prediction).
 *
 * Lifecycle: capture (per-player cadence gate) → live (fades per frame in
 * `render`) → release (expired / evicted / player torn down). View cull is
 * inherited: the capture call site lives in the IN-VIEW branch of
 * `updateAllPlayerFrames`, so off-screen players emit no ghosts, while
 * `render` sweeps the global live list from `PlayerRenderer.update` (outside
 * the per-player loop) so already-emitted ghosts keep fading after their owner
 * leaves the view. Teardown: `PlayerRenderer.destroyBundle` calls
 * `removeGhosts(bundle)` — a ghost can never outlive its player (the
 * "ghost arms" bug class).
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── OWNER RETUNE LIST (juice-pass-1 ticket 04) ──
 * Every number below is a taste parameter; retune in-browser against a
 * running build. Grouped: [dash] [speed boost] [shared]. Chosen values are
 * the best-judgment defaults recorded in the ticket-04 report.
 */

// ── Dash trigger (500ms @2×) — short bright burst ──
/** Capture cadence (ms). 60ms × 480ms window ≈ 8 ghosts per dash. */
const DASH_CAPTURE_INTERVAL_MS = 60;
/** Burst length armed by `triggerDash` (ms) — just under the 500ms dash. */
const DASH_CAPTURE_WINDOW_MS = 480;
/** Per-player cap on live dash ghosts (oldest-first eviction, template=8). */
const DASH_MAX_GHOSTS_PER_PLAYER = 8;
/** Ghost lifetime once emitted (ms). */
const DASH_FADE_MS = 400;
/** Alpha of a freshly emitted ghost (before age fade) — a hard, obvious
 *  afterimage burst (owner retune 2: 0.75 → 0.85). */
const DASH_BASE_OPACITY = 0.85;
/** Pale ice-blue: burst energy, distinct from the amber speed aura + the
 *  weapon-trail category tints. */
const DASH_TINT = 0xaee7ff;
/** Min smoothed speed (px/s) to emit — dashing into a wall displaces nothing,
 *  and a stationary player must not stack overlapping copies. 2× base speed
 *  is ~860 px/s, so real dashes clear this within the first ~2 captures. */
const DASH_MIN_MOVE_PX_S = 300;

// ── Speed boost trigger (7s @1.3×) — long steady ribbon ──
/** Capture cadence (ms) — sparser than dash: the state lasts 7s. */
const SPEED_CAPTURE_INTERVAL_MS = 90;
/** Per-player cap on live speed ghosts. */
const SPEED_MAX_GHOSTS_PER_PLAYER = 6;
/** Ghost lifetime once emitted (ms) — longer than dash (denser ribbon at the
 *  sparser cadence; owner retune 3). */
const SPEED_FADE_MS = 600;
/** Close under dash's 0.85 (dash still reads hardest): owner retune 2 raised
 *  BOTH together (0.5 → 0.75) so the speed ribbon no longer reads faint next
 *  to the dash burst. */
const SPEED_BASE_OPACITY = 0.75;
/** Warm amber — echoes the ticket-03 amber STATE aura hue, so tail and aura
 *  read as one effect (motion echo of the state, NOT a second readout). */
const SPEED_TINT = 0xffd98a;
/** Min smoothed speed (px/s) — the tail conveys MOTION: a standing (or barely
 *  drifting) boosted player emits nothing. Boosted walk ≈ 559 px/s. */
const SPEED_MIN_MOVE_PX_S = 250;

// ── Shared ──
/** Opacity curve: alpha = baseOpacity · (1 − age/fadeMs)^GAMMA per ghost.
 *  Persistent sprites fade by AGE alone (newest-brightest → oldest-faintest,
 *  the same progression the weapon trail's extra `(i / len)` rank factor
 *  produces for transient segments). GAMMA > 1 decays FASTER than linear
 *  through mid-life; ~1.0 = steady presence held until near the end (owner
 *  retune 2). */
const FADE_GAMMA = 1.1;
/** Below the body (10) and the IK arms (9), above ground entities (8): every
 *  part of the CURRENT player renders on top of its past ghosts. */
const GHOST_DEPTH = 8.5;
/** Hard cap on TOTAL live ghost sprites across ALL players (oldest-first
 *  eviction at the cap, mirroring the weapon trail's MAX_CONCURRENT=8). */
const MAX_TOTAL_LIVE_GHOSTS = 64;
/** Alpha floor under which a still-fading ghost is released early (px alpha,
 *  not life fraction — the same 0.01–0.02 cull band as the weapon trail). */
const ALPHA_RELEASE_FLOOR = 0.02;

/** Per-trigger look parameters — the single table BOTH triggers read. */
interface GhostModeParams {
  /** Capture cadence gate (ms). */
  readonly intervalMs: number;
  /** Per-player live-ghost cap (oldest-first eviction). */
  readonly maxPerPlayer: number;
  /** Ghost lifetime once emitted (ms). */
  readonly fadeMs: number;
  /** Alpha of a freshly emitted ghost. */
  readonly baseOpacity: number;
  /** Ghost sprite tint. */
  readonly tint: number;
  /** Min smoothed speed (px/s) to emit. */
  readonly minMovePxSec: number;
}

const DASH_PARAMS: GhostModeParams = {
  intervalMs: DASH_CAPTURE_INTERVAL_MS,
  maxPerPlayer: DASH_MAX_GHOSTS_PER_PLAYER,
  fadeMs: DASH_FADE_MS,
  baseOpacity: DASH_BASE_OPACITY,
  tint: DASH_TINT,
  minMovePxSec: DASH_MIN_MOVE_PX_S,
};

const SPEED_PARAMS: GhostModeParams = {
  intervalMs: SPEED_CAPTURE_INTERVAL_MS,
  maxPerPlayer: SPEED_MAX_GHOSTS_PER_PLAYER,
  fadeMs: SPEED_FADE_MS,
  baseOpacity: SPEED_BASE_OPACITY,
  tint: SPEED_TINT,
  minMovePxSec: SPEED_MIN_MOVE_PX_S,
};

/** One live afterimage (a pooled sprite + its fade clock). */
interface GhostEntry {
  /** Owning bundle — per-player cap accounting + teardown sweep. */
  owner: PlayerRenderBundle;
  sprite: Phaser.GameObjects.Sprite;
  bornAt: number;
  baseOpacity: number;
  fadeMs: number;
}

/**
 * Per-player ghost-tail capture state. Owned by the player's
 * `PlayerRenderBundle` (`bundle.ghostTail`) — same single-owner pattern as
 * `bundle.trail`: plain data created with the bundle, so it can never drift
 * out of sync with the player visual maps. The SPRITES a player emits are
 * pooled scene objects tracked here in `GhostTailRenderer` and released by
 * `removeGhosts` from `PlayerRenderer.destroyBundle`.
 */
export interface GhostTailState {
  /** Last emission timestamp — the cadence gate. */
  lastCaptureAt: number;
  /** Dash capture-window end (performance.now ms); armed by `triggerDash`. */
  dashUntil: number;
  /** Synced speed-boost level flag (patched via `PlayerRenderer.setSpeedBoost`). */
  speedBoostActive: boolean;
}

export class GhostTailRenderer {
  private readonly pool: SpritePool;
  /**
   * Live ghosts in EMIT order (index 0 = globally oldest). Single source of
   * truth for the fade sweep, the global cap eviction, and teardown — no
   * player-keyed map that could drift (the "ghost" leak class).
   */
  private readonly live: GhostEntry[] = [];

  constructor(scene: Phaser.Scene) {
    this.pool = new SpritePool(scene);
  }

  /**
   * Arm the dash capture burst. Called from `PlayerRenderer.triggerDash` —
   * the ONE entry point shared by the local input edge and the remote
   * `dashCooldown` edge. Dash takes precedence over speed boost while the
   * window is open (brighter, faster cadence).
   */
  triggerDash(bundle: PlayerRenderBundle, now: number): void {
    bundle.ghostTail.dashUntil = now + DASH_CAPTURE_WINDOW_MS;
  }

  /** Level-sync the speed-boost flag (every patch, not an edge). */
  setSpeedBoost(bundle: PlayerRenderBundle, active: boolean): void {
    bundle.ghostTail.speedBoostActive = active;
  }

  /**
   * Per-frame capture gate. Called from the IN-VIEW branch of
   * `updateAllPlayerFrames` AFTER the body transform finalizes (position,
   * rotation, dash-stretch scale) — so off-screen players emit nothing
   * (inherited view cull) and each ghost snapshots the exact rendered pose.
   *
   * `speedPxSec` is the caller's smoothed body speed; both triggers require
   * actual movement (the tail conveys MOTION — see the ruling).
   */
  capture(
    bundle: PlayerRenderBundle,
    body: Phaser.GameObjects.Sprite,
    speedPxSec: number,
    now: number,
  ): void {
    const tail = bundle.ghostTail;
    const params = now < tail.dashUntil ? DASH_PARAMS : tail.speedBoostActive ? SPEED_PARAMS : null;
    if (!params) return;
    if (speedPxSec < params.minMovePxSec) return;
    if (now - tail.lastCaptureAt < params.intervalMs) return;
    tail.lastCaptureAt = now;
    this.emit(bundle, body, params, now);
  }

  private emit(
    bundle: PlayerRenderBundle,
    body: Phaser.GameObjects.Sprite,
    params: GhostModeParams,
    now: number,
  ): void {
    // Per-player cap: evict THIS player's oldest ghosts first (ring-buffer
    // semantics — the template's `while (ghosts.length > ghostCount) shift()`).
    while (this.countOwnedBy(bundle) >= params.maxPerPlayer) {
      if (!this.releaseOldestOwnedBy(bundle)) break;
    }
    // Global hard cap: evict the globally-oldest ghost (any owner).
    while (this.live.length >= MAX_TOTAL_LIVE_GHOSTS) {
      this.releaseAt(0);
    }
    const sprite = this.pool.acquire('game', body.frame.name, body.x, body.y);
    sprite
      .setRotation(body.rotation)
      .setScale(body.scaleX, body.scaleY)
      .setTint(params.tint)
      .setDepth(GHOST_DEPTH)
      .setAlpha(params.baseOpacity);
    this.live.push({
      owner: bundle,
      sprite,
      bornAt: now,
      baseOpacity: params.baseOpacity,
      fadeMs: params.fadeMs,
    });
  }

  /**
   * Fade sweep — runs from `PlayerRenderer.update` OUTSIDE the per-player
   * loop (like `trailRenderer.render(now)`), so ghosts keep fading even when
   * their owner is culled off-screen. In-place compaction, zero allocation.
   */
  render(now: number): void {
    const live = this.live;
    let write = 0;
    for (let read = 0; read < live.length; read++) {
      const ghost = live[read]!;
      const life = 1 - (now - ghost.bornAt) / ghost.fadeMs;
      // Life check FIRST: pow(negative, gamma) is NaN, and an expired ghost is
      // released regardless of the alpha floor.
      if (life <= 0) {
        this.pool.release(ghost.sprite);
        continue;
      }
      const alpha = ghost.baseOpacity * Math.pow(life, FADE_GAMMA);
      if (alpha < ALPHA_RELEASE_FLOOR) {
        this.pool.release(ghost.sprite);
        continue;
      }
      ghost.sprite.setAlpha(alpha);
      live[write] = ghost;
      write++;
    }
    live.length = write;
  }

  /**
   * Release every ghost owned by this bundle — wired into
   * `PlayerRenderer.destroyBundle` so ghosts can never outlive their player.
   */
  removeGhosts(bundle: PlayerRenderBundle): void {
    const live = this.live;
    let write = 0;
    for (let read = 0; read < live.length; read++) {
      const ghost = live[read]!;
      if (ghost.owner === bundle) {
        this.pool.release(ghost.sprite);
      } else {
        live[write] = ghost;
        write++;
      }
    }
    live.length = write;
  }

  /** Release all live ghosts + destroy the pool (scene shutdown). */
  destroy(): void {
    for (const ghost of this.live) this.pool.release(ghost.sprite);
    this.live.length = 0;
    this.pool.destroy();
  }

  // ── Eviction helpers (live is emit-ordered, so "first match" = oldest) ──

  private countOwnedBy(bundle: PlayerRenderBundle): number {
    let count = 0;
    for (const ghost of this.live) if (ghost.owner === bundle) count++;
    return count;
  }

  /** Find + release `bundle`'s oldest ghost. False when it owns none. */
  private releaseOldestOwnedBy(bundle: PlayerRenderBundle): boolean {
    for (let i = 0; i < this.live.length; i++) {
      if (this.live[i]!.owner === bundle) {
        this.releaseAt(i);
        return true;
      }
    }
    return false;
  }

  private releaseAt(index: number): void {
    const ghost = this.live[index];
    if (!ghost) return;
    this.live.splice(index, 1);
    this.pool.release(ghost.sprite);
  }
}
