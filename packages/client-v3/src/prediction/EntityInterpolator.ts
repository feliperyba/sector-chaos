const INTERPOLATION_DELAY_MS = 67;
const MAX_SNAPSHOTS = 10;
const SNAP_THRESHOLD_SQ = 64 * 64;
/**
 * Hard cap on how far a velocity entity (projectile) is extrapolated past its
 * newest patch before its position freezes. Was 0.1s (100ms); at 30Hz patches
 * (~33ms spacing) any patch delayed by >67ms tripped the cap and froze the
 * projectile mid-flight — a common occurrence under server overrun that read
 * as "slow throws" and visible stalls. 0.3s (300ms) ≈ 9 patch intervals: the
 * projectile keeps gliding on its last known velocity through normal patch
 * jitter and only freezes on a genuine connection stall. For ARC/THROWN arcs
 * where the true path curves, 300ms of linear extrapolation overshoots at
 * most ~1 patch's worth before the next patch corrects it (smoothed — see
 * SMOOTH_TIMECONSTANT_S), which reads as a minor glide, not a freeze.
 */
const EXTRAPOLATION_CAP_S = 0.3;
/**
 * Time-constant (seconds) for smoothing the rendered position toward the
 * extrapolation target on each call. Kills the per-patch velocity-vector
 * discontinuity: when a patch changes the entity's velocity, the raw target
 * `newest.x + vx*elapsed` jumps discontinuously, but the smoothed output
 * glides toward it exponentially. 50ms (~3 frames @60Hz) is fast enough that
 * the entity tracks its true arc within one patch interval, slow enough that
 * the per-patch jump is invisible. `factor = 1 - exp(-dt/τ)` per frame.
 */
const SMOOTH_TIMECONSTANT_S = 0.05;

interface Snapshot {
  time: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

interface EntityBuffer {
  snapshots: Snapshot[];
  head: number;
  count: number;
  lastRenderX: number;
  lastRenderY: number;
  hasVelocity: boolean;
  /**
   * True once `getInterpolatedPosition` has emitted at least one position for
   * this entity. The FIRST render after spawn must equal the raw extrapolation
   * target (no prior position to blend from); subsequent renders blend toward
   * the target. Without this flag the first frame would blend from the
   * (uninitialized) spawn position and lag the entity behind its true spot.
   */
  hasRendered: boolean;
  /** Timestamp (ms) of the last `getInterpolatedPosition` call, for the
   * per-frame smoothing delta. */
  lastRenderTime: number;
}

export class EntityInterpolator {
  private entities = new Map<string, EntityBuffer>();
  private removed = new Set<string>();

  push(id: string, x: number, y: number, vx?: number, vy?: number): void {
    this.removed.delete(id);
    let buf = this.entities.get(id);
    if (!buf) {
      // Pre-allocate the ring of snapshot objects once; push() mutates the slot
      // in place instead of allocating a fresh object per call (~1,260
      // allocations/sec at 63 remote players × 20Hz).
      const snapshots: Snapshot[] = [];
      for (let i = 0; i < MAX_SNAPSHOTS; i++) snapshots.push({ time: 0, x: 0, y: 0 });
      buf = {
        snapshots,
        head: 0,
        count: 0,
        lastRenderX: x,
        lastRenderY: y,
        hasVelocity: vx !== undefined && vy !== undefined,
        hasRendered: false,
        lastRenderTime: 0,
      };
      this.entities.set(id, buf);
    }
    const snap = buf.snapshots[buf.head]!;
    snap.time = performance.now();
    snap.x = x;
    snap.y = y;
    snap.vx = vx;
    snap.vy = vy;
    buf.head = (buf.head + 1) % MAX_SNAPSHOTS;
    if (buf.count < MAX_SNAPSHOTS) buf.count++;
  }

  removeEntity(id: string): void {
    this.removed.add(id);
  }

  getInterpolatedPosition(id: string, out: { x: number; y: number }, now?: number): boolean {
    const buf = this.entities.get(id);
    if (!buf || buf.count < 1) return false;
    const ts = now ?? performance.now();

    if (buf.hasVelocity) {
      const newest = buf.snapshots[(buf.head - 1 + MAX_SNAPSHOTS) % MAX_SNAPSHOTS]!;
      const elapsed = (ts - newest.time) / 1000;
      const vx = newest.vx ?? 0;
      const vy = newest.vy ?? 0;
      const cappedElapsed = elapsed > EXTRAPOLATION_CAP_S ? EXTRAPOLATION_CAP_S : elapsed;
      const targetX = newest.x + vx * cappedElapsed;
      const targetY = newest.y + vy * cappedElapsed;
      // First render after spawn (or after the buffer was reset): emit the
      // raw target — there is no prior rendered position to blend from, so any
      // blend would just lag the entity behind its true spot on frame 1.
      if (!buf.hasRendered) {
        out.x = targetX;
        out.y = targetY;
        buf.lastRenderX = targetX;
        buf.lastRenderY = targetY;
        buf.lastRenderTime = ts;
        buf.hasRendered = true;
        return true;
      }
      // Subsequent renders: blend exponentially from the last rendered
      // position toward the raw extrapolation target. The blend factor is
      // frame-rate independent (`1 - exp(-dt/τ)`) and bounded by the
      // per-frame dt so the smoothing time-constant stays ~50ms regardless of
      // fps. This is what removes the per-patch velocity-vector discontinuity
      // (the "throws jitter" symptom): a velocity change glides over ~3 frames
      // instead of snapping the sprite to a new extrapolation line instantly.
      const dtS = ts > buf.lastRenderTime ? (ts - buf.lastRenderTime) / 1000 : 0;
      const blend = 1 - Math.exp(-dtS / SMOOTH_TIMECONSTANT_S);
      out.x = buf.lastRenderX + (targetX - buf.lastRenderX) * blend;
      out.y = buf.lastRenderY + (targetY - buf.lastRenderY) * blend;
      buf.lastRenderX = out.x;
      buf.lastRenderY = out.y;
      buf.lastRenderTime = ts;
      return true;
    }

    if (buf.count < 2) {
      const s = buf.snapshots[(buf.head - 1 + MAX_SNAPSHOTS) % MAX_SNAPSHOTS]!;
      out.x = s.x;
      out.y = s.y;
      return true;
    }
    const nowMs = ts;
    const renderTime = nowMs - INTERPOLATION_DELAY_MS;
    let older: Snapshot | null = null;
    let newer: Snapshot | null = null;
    for (let i = 0; i < buf.count; i++) {
      const idx = (buf.head - 1 - i + MAX_SNAPSHOTS) % MAX_SNAPSHOTS;
      const snap = buf.snapshots[idx]!;
      if (snap.time <= renderTime) {
        older = snap;
        break;
      }
      newer = snap;
    }
    if (!older) {
      const oldest = buf.snapshots[(buf.head - buf.count + MAX_SNAPSHOTS) % MAX_SNAPSHOTS]!;
      out.x = oldest.x;
      out.y = oldest.y;
      return true;
    }
    if (!newer) {
      out.x = older.x;
      out.y = older.y;
      return true;
    }
    const range = newer.time - older.time;
    if (range <= 0) {
      out.x = newer.x;
      out.y = newer.y;
      return true;
    }
    const t = Math.min(1, Math.max(0, (renderTime - older.time) / range));
    const x = older.x + (newer.x - older.x) * t;
    const y = older.y + (newer.y - older.y) * t;
    const newest = buf.snapshots[(buf.head - 1 + MAX_SNAPSHOTS) % MAX_SNAPSHOTS]!;
    const snapDx = x - newest.x;
    const snapDy = y - newest.y;
    if (snapDx * snapDx + snapDy * snapDy > SNAP_THRESHOLD_SQ) {
      out.x = newest.x;
      out.y = newest.y;
      return true;
    }
    out.x = x;
    out.y = y;
    return true;
  }

  /**
   * Return the most recently PUSHED (received) snapshot position for `id`,
   * WITHOUT extrapolation or smoothing. This is the latest AUTHORITATIVE-ish
   * position the client has received — pre-interpolation. Callers that need the
   * position the server consults right now (e.g. client-side collision
   * prediction that must mirror the server's `resolvePlayerCollision`) should
   * read this rather than `getInterpolatedPosition`, whose output lags by the
   * smoothing/delay buffer (ADR-0015/0020). That lag drove spurious PvP-
   * separation reconciliation corrections during oncoming overlaps (NET-29,
   * ADR-0020 addendum). Returns false (and leaves `out` untouched) if no
   * snapshot has ever been pushed for `id`.
   *
   * NOTE: this accessor only reads; it does NOT update `lastRenderX/Y` or
   * `lastRenderTime`, so it does not perturb the display interpolation path.
   */
  getLatestReceivedPosition(id: string, out: { x: number; y: number }): boolean {
    const buf = this.entities.get(id);
    if (!buf || buf.count < 1) return false;
    const newest = buf.snapshots[(buf.head - 1 + MAX_SNAPSHOTS) % MAX_SNAPSHOTS]!;
    out.x = newest.x;
    out.y = newest.y;
    return true;
  }

  update(): void {
    for (const id of this.removed) {
      this.entities.delete(id);
    }
    this.removed.clear();
  }

  has(id: string): boolean {
    return this.entities.has(id);
  }
}
