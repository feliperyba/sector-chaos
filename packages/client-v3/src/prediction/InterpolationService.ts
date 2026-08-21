import type { EntityInterpolator } from './EntityInterpolator.js';
import type { StateSync } from '../network/StateSync.js';
import type { PlayerRenderer } from '../rendering/PlayerRenderer.js';
import type { EntityRenderer } from '../rendering/EntityRenderer.js';
import type { GameState } from '../controllers/GameState.js';
import type { AudioService } from '../audio/AudioService.js';

/**
 * Distance a remote player must travel (in world px) between footstep SFX.
 * ~120px ≈ ~2 tiles — matches the local player's 350ms throttle at base speed
 * (430px/s → ~150px/350ms). Slightly shorter to stay audible at a natural cadence.
 */
const REMOTE_FOOTSTEP_DISTANCE = 120;

export class InterpolationService {
  private readonly outPosition: { x: number; y: number } = { x: 0, y: 0 };
  /** Per-remote-player accumulated travel distance for footstep cadence. */
  private readonly footstepAccumulator = new Map<string, number>();
  /** Per-remote-player last interpolated position (for delta computation). */
  private readonly lastPosition = new Map<string, { x: number; y: number }>();

  constructor(
    private readonly playerInterpolator: EntityInterpolator,
    private readonly projectileInterpolator: EntityInterpolator,
    private readonly stateSync: StateSync,
    private readonly playerRenderer: PlayerRenderer,
    private readonly entityRenderer: EntityRenderer,
    private readonly state: GameState,
    private readonly audio: AudioService | null = null,
  ) {}

  /**
   * Advance interpolation for one frame. The optional `now` timestamp (ms) is
   * shared with the caller so every interpolation sample in the frame derives
   * from one consistent instant — omit to fall back to per-call
   * `performance.now()` (used by tests / non-GameScene callers).
   */
  update(now?: number): void {
    this.playerInterpolator.update();
    for (const [id] of this.stateSync.getEntities().players) {
      if (id === this.state.myId) continue;
      if (this.playerInterpolator.getInterpolatedPosition(id, this.outPosition, now)) {
        this.playerRenderer.updatePosition(id, this.outPosition.x, this.outPosition.y);
        // Remote footstep cadence: accumulate travel distance and fire a
        // positional footstep at each threshold crossing.
        if (this.audio) {
          this.updateRemoteFootsteps(id, this.outPosition.x, this.outPosition.y);
        }
      }
    }

    this.projectileInterpolator.update();
    for (const [id] of this.stateSync.getEntities().projectiles) {
      if (this.projectileInterpolator.getInterpolatedPosition(id, this.outPosition, now)) {
        this.entityRenderer.setProjectilePosition(id, this.outPosition.x, this.outPosition.y);
      }
    }
  }

  /** Accumulate travel distance for a remote player and emit footsteps. */
  private updateRemoteFootsteps(id: string, x: number, y: number): void {
    const last = this.lastPosition.get(id);
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      const moved = Math.sqrt(dx * dx + dy * dy);
      if (moved > 0.5) {
        // Ignore sub-pixel jitter from interpolation noise.
        const acc = (this.footstepAccumulator.get(id) ?? 0) + moved;
        if (acc >= REMOTE_FOOTSTEP_DISTANCE) {
          this.audio!.playAt('footstep', x, y, 0.15);
          this.footstepAccumulator.set(id, acc - REMOTE_FOOTSTEP_DISTANCE);
        } else {
          this.footstepAccumulator.set(id, acc);
        }
      }
      // Mutate the existing entry in place — zero-alloc steady state. Safe
      // because `lastPosition` is private and its only reader is the line
      // above (immediate synchronous read, reference never stored past this
      // call). A new entry is allocated only on first sight of the id.
      last.x = x;
      last.y = y;
    } else {
      this.lastPosition.set(id, { x, y });
    }
  }

  /** Clean up tracking state when a player is removed. */
  removePlayer(id: string): void {
    this.footstepAccumulator.delete(id);
    this.lastPosition.delete(id);
  }
}
