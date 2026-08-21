import type Phaser from 'phaser';

/**
 * WalkStutter instrumentation (C5 diagnosis). Captures one structured line per
 * frame WHILE the local player is alive and moving, into an IN-MEMORY ring
 * buffer (NOT console.log — per-frame console.log costs several ms with
 * DevTools open and was itself a major frame-pacing artifact, see C5). A human
 * runs the game at their real refresh rate, walks around, then dumps the
 * buffer to a .log file via `window.__SECTO_WALK_SAVE()` for offline analysis.
 *
 * ## Why no per-frame console.log
 * The first capture attempt had this logger emit via console.log every moving
 * frame; the dump showed the game running at ~30fps (avg dt 27-33ms). That was
 * largely a MEASUREMENT artifact — console.log under DevTools is expensive, and
 * 2700 log calls/frame-budget is enough to halve the framerate. Buffering in
 * memory (array push, microseconds) removes the Heisenberg effect so the
 * frame-pacing read is trustworthy.
 *
 * ## What it distinguishes
 *  (A) Camera deadzone+lerp limit cycle (the C5 fix target): `lerp` ≠ 1 or
 *      `dz` ≠ null during local alive walk ⇒ rigid follow is NOT active.
 *      `screen` will also move opposite to travel (tagged <<<STUTTER).
 *  (B) Prediction visual non-monotonic: a recon correction jumps `co`
 *      (tagged <<RECON, only when |co| GROWS — decay doesn't count) ⇒ visual
 *      moves backward, dragging the camera with it.
 *  (C) Camera world-bounds clamp (edge of map): `clampΔ` large/constant ⇒
 *      camera pinned at a world edge (test artifact, not a follow bug).
 *  (D) Frame pacing: `dt!` flag when dt > 22ms (a hitched frame). Chronic
 *      hitching ⇒ the client can't sustain 60fps (render perf), which reads as
 *      a "constant stutter" during walk.
 *
 * ## Emit timing (deferred)
 * Phaser finalizes cam.scrollX/Y in Camera.preRender(), which runs AFTER
 * scene.update(). So reading scroll inside update() yields the PREVIOUS frame's
 * scroll. We stash the frame in `pending` on record() (called in update) and
 * emit it on the NEXT record() call, when cam.scrollX/Y is exactly that
 * stashed frame's render scroll. This makes `screen = visual − scroll` exact.
 *
 * ## Gating
 * Captures only while alive AND |localVelocity| > threshold (idle suppressed).
 * Disable with `window.__SECTO_WALK_DEBUG = false`. Dump+download with
 * `window.__SECTO_WALK_SAVE()`; raw text with `window.__SECTO_WALK_DUMP()`.
 */
const WALK_SPEED_THRESHOLD = 10;
const STUTTER_PX_THRESHOLD = 1.5;
const BUFFER_CAP = 60000;

/** Per-frame signals captured in scene.update (pre-render values). */
export interface WalkDebugFrame {
  isDead: boolean;
  dtMs: number;
  dirX: number;
  dirY: number;
  acc: number;
  substeps: number;
  lpX: number;
  lpY: number;
  lvX: number;
  lvY: number;
  coX: number;
  coY: number;
  visX: number;
  visY: number;
  ftX: number;
  ftY: number;
  lerpX: number;
  lerpY: number;
  dz: 'null' | { w: number; h: number };
  foX: number;
  foY: number;
  /** Server's last reported authoritative position (latest patch). */
  serverX: number;
  serverY: number;
  serverVx: number;
  serverVy: number;
  /** Server's lastProcessedInput (seq acked in the latest patch). */
  serverSeq: number;
  /** Count of other players within 256px of the local player (bot-proximity). */
  nearbyPlayers: number;
}

interface StashedFrame extends WalkDebugFrame {
  frame: number;
  t: number;
}

interface PrevEmitted {
  screenX: number;
  screenY: number;
  coX: number;
  coY: number;
  lvX: number;
  lvY: number;
}

export class WalkDebugLog {
  private cam: Phaser.Cameras.Scene2D.Camera;
  private frame = 0;
  private pending: StashedFrame | null = null;
  private prev: PrevEmitted | null = null;
  private headerSeen = false;
  private _enabled = true;
  private buffer: string[] = [];

  constructor(cam: Phaser.Cameras.Scene2D.Camera) {
    this.cam = cam;
  }

  set enabled(v: boolean) {
    this._enabled = v;
  }

  /** Called once per scene.update with this frame's pre-render signals. */
  record(f: WalkDebugFrame): void {
    if (!this._enabled) return;
    if ((globalThis as { __SECTO_WALK_DEBUG?: unknown }).__SECTO_WALK_DEBUG === false) {
      this.pending = null;
      this.prev = null;
      return;
    }
    // Emit previous frame now that cam.scrollX/Y == its render scroll.
    if (this.pending) this.emit(this.pending);
    this.frame++;
    this.pending = { ...f, frame: this.frame, t: performance.now() };
  }

  private pushLine(s: string): void {
    this.buffer.push(s);
    if (this.buffer.length > BUFFER_CAP) this.buffer.shift();
  }

  private emit(cur: StashedFrame): void {
    const scrollX = this.cam.scrollX;
    const scrollY = this.cam.scrollY;
    const zoom = this.cam.zoom || 1;
    const halfW = this.cam.width / 2 / zoom;
    const halfH = this.cam.height / 2 / zoom;
    const screenX = cur.visX - scrollX;
    const screenY = cur.visY - scrollY;
    const expectedScrollX = cur.visX - halfW;
    const expectedScrollY = cur.visY - halfH;
    const clampDX = scrollX - expectedScrollX;
    const clampDY = scrollY - expectedScrollY;

    if (cur.isDead) {
      this.prev = null;
      return;
    }
    const speed = Math.hypot(cur.lvX, cur.lvY);
    if (speed < WALK_SPEED_THRESHOLD) {
      this.prev = null;
      return;
    }

    if (!this.headerSeen) {
      this.headerSeen = true;
      this.pushLine(
        '[WALK-HEADER] columns: f=frame dt=deltaMs acc=predAccumulator sub=substeps | dir=intendedDir ' +
          'lp=localPos lv=localVel co=correctionOffset vis=visualPos ft=followTarget | ' +
          'lerp dz fo=followOffset | scroll=cameraScroll screen=visual-scroll half=viewport/2 ' +
          'clampΔ=scroll-(visual-half) paceAlarm=dt>22ms configAlarm=lerp<1|deadzone. ' +
          '<<<STUTTER=screen moved opposite to travel. <<RECON=|correctionOffset| grew (new server correction).',
      );
    }

    let stutter = false;
    let dScreenX = 0;
    let dScreenY = 0;
    if (this.prev) {
      dScreenX = screenX - this.prev.screenX;
      dScreenY = screenY - this.prev.screenY;
      const sx = Math.sign(cur.lvX);
      const sy = Math.sign(cur.lvY);
      if (sx !== 0 && Math.sign(dScreenX) === -sx && Math.abs(dScreenX) > STUTTER_PX_THRESHOLD)
        stutter = true;
      if (sy !== 0 && Math.sign(dScreenY) === -sy && Math.abs(dScreenY) > STUTTER_PX_THRESHOLD)
        stutter = true;
    }

    // Real reconciliation = |co| grew (fresh correction); decay shrinks |co|.
    let recon = '';
    if (this.prev) {
      const prevMag = Math.hypot(this.prev.coX, this.prev.coY);
      const curMag = Math.hypot(cur.coX, cur.coY);
      if (curMag > prevMag + 0.5) {
        const dcoX = cur.coX - this.prev.coX;
        const dcoY = cur.coY - this.prev.coY;
        recon = ` Δco=(${dcoX.toFixed(2)},${dcoY.toFixed(2)}) coMag ${prevMag.toFixed(1)}->${curMag.toFixed(1)} <<RECON`;
      }
    }

    const paceAlarm = cur.dtMs > 22 ? ` dt!(${cur.dtMs.toFixed(1)}ms)` : '';
    let cfgAlarm = '';
    if (cur.lerpX < 0.999 || cur.lerpY < 0.999) cfgAlarm += ' lerp<1!';
    if (cur.dz !== 'null') cfgAlarm += ' deadzone!';

    const dz = cur.dz === 'null' ? 'null' : `${cur.dz.w.toFixed(0)}x${cur.dz.h.toFixed(0)}`;
    const tag = stutter ? '[STUTTER]' : '[WALK]';
    const stutterMark = stutter
      ? ` Δscr=(${dScreenX.toFixed(2)},${dScreenY.toFixed(2)}) <<<STUTTER`
      : '';

    this.pushLine(
      `${tag} f=${cur.frame} dt=${cur.dtMs.toFixed(1)} acc=${cur.acc.toFixed(4)} sub=${cur.substeps} ` +
        `dir=(${cur.dirX.toFixed(2)},${cur.dirY.toFixed(2)}) ` +
        `lp=(${cur.lpX.toFixed(1)},${cur.lpY.toFixed(1)}) ` +
        `lv=(${cur.lvX.toFixed(0)},${cur.lvY.toFixed(0)}) ` +
        `co=(${cur.coX.toFixed(1)},${cur.coY.toFixed(1)}) ` +
        `vis=(${cur.visX.toFixed(1)},${cur.visY.toFixed(1)}) ` +
        `ft=(${cur.ftX.toFixed(1)},${cur.ftY.toFixed(1)}) ` +
        `lerp=(${cur.lerpX.toFixed(3)},${cur.lerpY.toFixed(3)}) dz=${dz} ` +
        `fo=(${cur.foX.toFixed(1)},${cur.foY.toFixed(1)}) ` +
        `scroll=(${scrollX.toFixed(1)},${scrollY.toFixed(1)}) ` +
        `screen=(${screenX.toFixed(1)},${screenY.toFixed(1)}) ` +
        `half=(${halfW.toFixed(0)},${halfH.toFixed(0)}) ` +
        `clampΔ=(${clampDX.toFixed(1)},${clampDY.toFixed(1)}) ` +
        `srv=(${cur.serverX.toFixed(1)},${cur.serverY.toFixed(1)}) ` +
        `div=(${(cur.lpX - cur.serverX).toFixed(1)},${(cur.lpY - cur.serverY).toFixed(1)}) ` +
        `svq=(${cur.serverVx.toFixed(0)},${cur.serverVy.toFixed(0)}) sseq=${cur.serverSeq} ` +
        `near=${cur.nearbyPlayers}${paceAlarm}${cfgAlarm}${recon}${stutterMark}`,
    );

    this.prev = { screenX, screenY, coX: cur.coX, coY: cur.coY, lvX: cur.lvX, lvY: cur.lvY };
  }

  /** Return the captured lines joined with newlines (for download/analysis). */
  dump(): string {
    return this.buffer.join('\n');
  }

  clear(): void {
    this.buffer.length = 0;
    this.prev = null;
    this.pending = null;
  }

  destroy(): void {
    if (this.pending) this.emit(this.pending);
    this.pending = null;
    this.prev = null;
  }
}

declare global {
  interface Window {
    __SECTO_WALK_DEBUG?: boolean;
    __SECTO_WALK_DUMP?: () => string;
    __SECTO_WALK_SAVE?: () => number;
    // Bug 2 (lingering arms) live diagnostic — see PlayerRenderer.__debugArmLeak.
    __SECTO_ARMS_DUMP?: () => unknown;
  }
}
