/**
 * LightingWorldCaptureRegistry — incremental maintenance of the lighting
 * pipeline's world-capture list (ticket 51 / INVESTIGATION.md §4.2 item 2.6).
 *
 * Replaces the per-frame O(N) full-display-list scan
 * (`buildWorldCaptureList`, kept as the comparator oracle) with event-driven
 * maintenance on the scene's own display-list add/remove events. Membership
 * + ORDER are proven identical to what the old scan produced, frame by frame
 * (the proof is below; the correctness harness asserts it empirically).
 *
 * ── Why Phaser's scene events make this tractable (ONE hook point) ──
 *
 * Phaser 4.1's DisplayList (`phaser/src/gameobjects/DisplayList.js`) emits
 * scene-level events from its list callbacks:
 *   - `addChildCallback` (:108) emits `Phaser.Scenes.Events.ADDED_TO_SCENE`
 *     on `scene.sys.events` for EVERY add — `scene.add.*` factory calls,
 *     `scene.add.existing`, direct `children.add`. One subscription covers
 *     every spawn path in the codebase (players, entities, VFX pool sprites,
 *     siege walls, HUD, tweens' targets — everything).
 *   - `removeChildCallback` (:143) emits `REMOVED_FROM_SCENE` for non-destroy
 *     removals. GOTCHA: `GameObject.destroy` → `removeFromDisplayList` calls
 *     `displayList.remove(this, true)` — `skipCallback=true` — so DESTROY
 *     does NOT fire the scene event. Instead `GameObject.destroy` emits
 *     `Phaser.GameObjects.Events.DESTROY` on the OBJECT
 *     (`GameObject.js:destroy`, emit happens BEFORE `removeFromDisplayList`).
 *     The registry therefore attaches one per-object DESTROY listener at
 *     ADDED time; both removal paths run the same idempotent removal.
 *
 * ── ORDER EQUIVALENCE PROOF (the risky part — full derivation) ──
 *
 * The albedo bake draws the list IN ARRAY ORDER (`albedoRT.draw(world)` →
 * DynamicTexture DRAW commands in sequence), so order matters wherever
 * semi-transparent sprites overlap (normal alpha blending is not
 * commutative). The registry mirrors the display list's array EXACTLY:
 *
 *  1. APPEND: `List.add` pushes to the end (ArrayUtils.Add) then fires the
 *     callback; the registry appends on ADDED_TO_SCENE — same position.
 *  2. SPLICE: removals splice both arrays; splices never reorder survivors.
 *  3. SORT: `DisplayList.depthSort()` (a STABLE sort by `_depth`) runs at
 *     RENDER time (`Systems.render` calls `displayList.depthSort()` then
 *     emits PRE_RENDER) and only when `sortChildrenFlag` is set (any
 *     add/remove/setDepth). The registry sorts its own array in its
 *     PRE_RENDER handler — which runs immediately AFTER the display list's
 *     sort, with no game code in between (the emit is the next statement).
 *     Same pre-state (induction), same stable comparator, same depths read
 *     at the same instant → identical post-state.
 *  4. Timing asymmetry (load-bearing): `LightingPipeline.update()` runs in
 *     the scene UPDATE phase — BEFORE this frame's render-time sort. So at
 *     capture time both arrays are "sorted as of last render + this frame's
 *     appends at the tail". The registry deliberately does NOT sort at
 *     update time; sorting there would interleave the tail early and
 *     diverge from what the old scan saw.
 *
 * ── FILTER EVALUATION TIMING (deferred, one-shot) ──
 *
 * The filter reads `depth`, but spawn chains set depth AFTER the add
 * (`scene.add.sprite(...).setDepth(15)` — the ADDED event fires with the
 * default depth 0). Evaluating the predicate at ADDED time would wrongly
 * capture HUD objects (depth set to 500+ post-add). The registry therefore
 * defers evaluation to the first `synchronize` AFTER the append (update or
 * PRE_RENDER — both run after the synchronous spawn chain completes) and
 * evaluates each appended entry exactly once (the `evalCursor` invariant:
 * every entry at index < evalCursor has passed the filter). Verified
 * codebase invariant (ticket 51 grep): NO mid-life `setDepth` exists —
 * every call is a spawn-time chain or lazy-create chain — so one-shot
 * evaluation matches the old scan's per-frame re-evaluation. The live
 * comparator window (`__LIGHTING_CAPTURE_COMPARE__`) guards this
 * invariant empirically.
 *
 * ── IGNORE-SET LIFECYCLE (the leak fix) ──
 *
 * `Camera.ignore` sets a bit on the OBJECT (`entry.cameraFilter |= id`,
 * BaseCamera.js) — there is no camera-side list to clean; a destroyed
 * object's flag dies with it. The leak was the pipeline's OWN
 * `ignoredOnMainCam` Set holding strong references to destroyed objects
 * forever (unbounded growth + blocked GC). The registry deletes the entry
 * on every removal path. The ignore itself is applied at UPDATE time only
 * (drained from `toIgnore`) — matching the old scan's timing exactly
 * (objects appended mid-frame were first ignored by the NEXT update's
 * scan; an object added between update and render still renders unlit on
 * the main camera for that single frame, exactly as before).
 */
import Phaser from 'phaser';
import { logger } from '@sector-battle/shared';
import {
  passesWorldCaptureFilter,
  buildWorldCaptureList,
} from './LightingAlbedoRtBuilder.js';
import { getLightingDevFlags } from './LightingDevFlags.js';

/** Live filter inputs (read at evaluation time so resize rebuilds are honored). */
export interface WorldCaptureFilterInputs {
  /** The albedo RT (never drawn into itself). */
  albedoRT: Phaser.GameObjects.RenderTexture;
  /** Pipeline-internal RT shaders excluded from the capture (GOTCHA #5). */
  rtShaders: ReadonlyArray<Phaser.GameObjects.Shader>;
  /** Children with `depth >= worldDepthCutoff` are HUD/overlays (excluded). */
  worldDepthCutoff: number;
}

/** Steady-state stats for the dev-mode comparator (see `compareAgainstFullScan`). */
export interface WorldCaptureCompareStats {
  framesCompared: number;
  mismatchFrames: number;
  lastIncrementalLength: number;
  lastScanLength: number;
  /** Index of the first order divergence on the last mismatch (-1 = none/na). */
  lastFirstOrderDiff: number;
}

/**
 * Incrementally-maintained world-capture list. Construct after the scene's
 * world exists (seeds from the current display list); `synchronize()` once
 * per frame from `LightingPipeline.update` BEFORE the albedo draw; the
 * PRE_RENDER listener keeps order in sync with the display list's render
 * sort. `destroy()` on pipeline shutdown.
 */
export class LightingWorldCaptureRegistry {
  /**
   * The world-capture list in display-list order. After `synchronize()` this
   * is EXACTLY what the old per-frame full scan produced (the comparator
   * asserts it): all filter-passing entries, `[0, evalCursor)` slice.
   */
  readonly list: Phaser.GameObjects.GameObject[] = [];
  /**
   * World-depth GameObjects already ignored on the main camera. Cleaned on
   * every removal path (ticket 51: the old scan's set only ever grew,
   * pinning destroyed objects).
   */
  readonly ignoredOnMainCam: Set<Phaser.GameObjects.GameObject> = new Set();

  private readonly scene: Phaser.Scene;
  private readonly getFilterInputs: () => WorldCaptureFilterInputs;
  /** Membership mirror (O(1) removal checks; `list` holds the order). */
  private readonly inList = new Set<Phaser.GameObjects.GameObject>();
  /**
   * One-shot filter cursor: every entry at index < evalCursor has passed the
   * filter; entries at >= evalCursor are appended-but-unevaluated. Maintains
   * the invariant across splices (decremented when a spliced index is below
   * the cursor) and sorts (only run after evaluation empties the tail).
   */
  private evalCursor = 0;
  /** Newly-passing entries awaiting the update-time `cam.ignore` drain. */
  private readonly toIgnore: Phaser.GameObjects.GameObject[] = [];
  private destroyed = false;
  /** Ticket 51 harness stats (only updated while the dev flag is enabled). */
  readonly compareStats: WorldCaptureCompareStats = {
    framesCompared: 0,
    mismatchFrames: 0,
    lastIncrementalLength: 0,
    lastScanLength: 0,
    lastFirstOrderDiff: -1,
  };

  constructor(
    scene: Phaser.Scene,
    getFilterInputs: () => WorldCaptureFilterInputs,
  ) {
    this.scene = scene;
    this.getFilterInputs = getFilterInputs;
    scene.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, this.handleAdded);
    scene.events.on(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.handleRemoved);
    scene.events.on(Phaser.Scenes.Events.PRE_RENDER, this.handlePreRender);
    // Seed: mirror the display list as it stands at construction. Everything
    // starts unevaluated (cursor 0) so the FIRST synchronize filters with
    // update-time depths — identical to the old scan's first frame.
    const children = scene.children.list;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c && !this.inList.has(c)) this.append(c);
    }
  }

  /** Display-list append mirror (ADDED_TO_SCENE / ctor seed). */
  private append(c: Phaser.GameObjects.GameObject): void {
    this.inList.add(c);
    this.list.push(c);
    // Destroy does not fire REMOVED_FROM_SCENE (skipCallback=true) — the
    // per-object DESTROY listener is the removal hook for that path.
    c.on(Phaser.GameObjects.Events.DESTROY, this.handleObjectDestroy);
  }

  private readonly handleAdded = (c: Phaser.GameObjects.GameObject): void => {
    if (this.destroyed || !c || this.inList.has(c)) return;
    this.append(c);
  };

  private readonly handleRemoved = (c: Phaser.GameObjects.GameObject): void => {
    if (this.destroyed || !c) return;
    // Off the display list without destruction — detach the destroy hook so
    // the (still-alive) object does not pin the registry.
    c.off(Phaser.GameObjects.Events.DESTROY, this.handleObjectDestroy);
    this.remove(c);
  };

  private readonly handleObjectDestroy = (c: Phaser.GameObjects.GameObject): void => {
    if (this.destroyed || !c) return;
    this.remove(c);
  };

  /**
   * Drop members whose depth crossed the cutoff MID-LIFE (world→HUD
   * redepth). Grep-verified absent in the codebase (every `setDepth` is a
   * spawn-time or lazy-create chain — see the file header), so this is
   * unreachable insurance, not a hot-path cost: it makes the object VANISH
   * exactly like the old per-frame scan made it vanish (dropped from the
   * capture while its `cameraFilter` ignore bit persists) instead of
   * lingering lit at HUD depth. The reverse crossing (an eval-rejected
   * HUD object redepthed into the world) has NO event signal and is NOT
   * handled — the `__LIGHTING_CAPTURE_COMPARE__` live harness is the
   * tripwire for that class. Requires every entry to be evaluated (the
   * cursor invariant) — callers run it right after `evaluateNewEntries`.
   */
  private dropRetargetedToHud(): void {
    const cutoff = this.getFilterInputs().worldDepthCutoff;
    for (let i = 0; i < this.list.length; ) {
      const c = this.list[i]!;
      if ((c as Phaser.GameObjects.GameObject & { depth: number }).depth >= cutoff) {
        this.list.splice(i, 1);
        this.inList.delete(c);
        continue;
      }
      i++;
    }
    this.evalCursor = this.list.length;
  }

  /** Splice mirror + ignore-set cleanup (the ticket's leak fix). */
  private remove(c: Phaser.GameObjects.GameObject): void {
    const idx = this.list.indexOf(c);
    if (idx !== -1) {
      this.list.splice(idx, 1);
      if (idx < this.evalCursor) this.evalCursor--;
      this.inList.delete(c);
    }
    this.ignoredOnMainCam.delete(c);
  }

  /**
   * PRE_RENDER mirror of `DisplayList.depthSort()`. `Systems.render` runs the
   * display list's stable depth sort immediately before emitting PRE_RENDER,
   * so this handler re-establishes order parity at the exact moment the
   * display list's order changes (see the file-header proof, item 3).
   */
  private readonly handlePreRender = (): void => {
    if (this.destroyed) return;
    this.evaluateNewEntries();
    this.stableDepthSort();
  };

  /**
   * Evaluate appended-but-unevaluated tail entries against the CURRENT
   * filter inputs (deferred one-shot — see file header). Failures are
   * spliced in place so survivors keep their exact display-list position;
   * passes are queued for the update-time ignore drain.
   */
  private evaluateNewEntries(): void {
    const { albedoRT, rtShaders, worldDepthCutoff } = this.getFilterInputs();
    for (let i = this.evalCursor; i < this.list.length; ) {
      const c = this.list[i]!;
      if (!passesWorldCaptureFilter(c, albedoRT, rtShaders, worldDepthCutoff)) {
        this.list.splice(i, 1);
        this.inList.delete(c);
        continue;
      }
      this.toIgnore.push(c);
      i++;
    }
    this.evalCursor = this.list.length;
  }

  /**
   * Allocation-free stable sort by depth (insertion sort — the array is
   * nearly sorted in steady state, so this is ~O(N) comparisons). Strictly
   * `>` keeps equal-depth ties in place = stability, matching Phaser's
   * StableSort semantics.
   */
  private stableDepthSort(): void {
    const arr = this.list;
    for (let i = 1; i < arr.length; i++) {
      const item = arr[i]!;
      const depth = (item as Phaser.GameObjects.GameObject & { depth: number }).depth;
      let j = i - 1;
      while (j >= 0 && (arr[j]! as Phaser.GameObjects.GameObject & { depth: number }).depth > depth) {
        arr[j + 1] = arr[j]!;
        j--;
      }
      arr[j + 1] = item;
    }
  }

  /**
   * Per-frame update-phase entry point (call BEFORE drawing the albedo).
   * Evaluates the unevaluated tail, drops any member redepthed to HUD
   * mid-life, then drains the ignore queue — the exact point the old scan
   * applied `cam.ignore`, so ignore timing (and therefore the one-frame
   * unlit-render window for mid-frame spawns) is unchanged. When the dev
   * flag `__LIGHTING_CAPTURE_COMPARE__` is set, also runs the full-scan
   * oracle comparison (the correctness harness).
   */
  synchronize(): void {
    if (this.destroyed) return;
    this.evaluateNewEntries();
    this.dropRetargetedToHud();
    const cam = this.scene.cameras.main;
    for (let i = 0; i < this.toIgnore.length; i++) {
      const c = this.toIgnore[i]!;
      // Entries may have been removed between evaluation and this drain.
      if (!this.inList.has(c) || this.ignoredOnMainCam.has(c)) continue;
      cam.ignore(c);
      this.ignoredOnMainCam.add(c);
    }
    this.toIgnore.length = 0;
    if (getLightingDevFlags().captureCompare) {
      const equal = compareAgainstFullScan(
        this.scene,
        this.getFilterInputs(),
        this.list,
        this.compareStats,
      );
      if (!equal && this.compareStats.mismatchFrames === 1) {
        logger.warn(
          `[lighting] capture-compare mismatch: incremental=${this.compareStats.lastIncrementalLength} scan=${this.compareStats.lastScanLength} firstOrderDiff=${this.compareStats.lastFirstOrderDiff} — a spawn path is not covered (unlit-object risk).`,
        );
      }
    }
  }

  /** Tear down (pipeline shutdown): unsubscribe + release every reference. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, this.handleAdded);
    this.scene.events.off(Phaser.Scenes.Events.REMOVED_FROM_SCENE, this.handleRemoved);
    this.scene.events.off(Phaser.Scenes.Events.PRE_RENDER, this.handlePreRender);
    // Detach the per-object destroy hooks so objects that outlive the
    // pipeline (menu tear-down without scene destruction) release it.
    for (let i = 0; i < this.list.length; i++) {
      this.list[i]!.off(Phaser.GameObjects.Events.DESTROY, this.handleObjectDestroy);
    }
    this.list.length = 0;
    this.inList.clear();
    this.ignoredOnMainCam.clear();
    this.toIgnore.length = 0;
    this.evalCursor = 0;
  }
}

/**
 * Correctness harness (ticket 51 acceptance criterion): run the OLD full
 * display-list scan (`buildWorldCaptureList`) against what the incremental
 * registry produced and record any divergence. DEV-ONLY — costs the full
 * scan per frame while enabled (`__LIGHTING_CAPTURE_COMPARE__`), so it must
 * never default on. The scratch ignore set + no-op camera keep the oracle
 * free of side effects (the live pipeline already applied the real ignores).
 *
 * @returns true when the two lists are identical in length, membership AND
 * order; stats are updated in place either way.
 */
export function compareAgainstFullScan(
  scene: Phaser.Scene,
  filterInputs: WorldCaptureFilterInputs,
  incremental: ReadonlyArray<Phaser.GameObjects.GameObject>,
  stats: WorldCaptureCompareStats,
): boolean {
  const scan: Phaser.GameObjects.GameObject[] = [];
  const scratchIgnored = new Set<Phaser.GameObjects.GameObject>();
  const noopCam = { ignore: (_entries: unknown) => undefined };
  buildWorldCaptureList(
    {
      children: scene.children.list,
      albedoRT: filterInputs.albedoRT,
      rtShaders: filterInputs.rtShaders,
      worldDepthCutoff: filterInputs.worldDepthCutoff,
    },
    scan,
    noopCam as unknown as Phaser.Cameras.Scene2D.Camera,
    scratchIgnored,
  );

  stats.framesCompared++;
  stats.lastIncrementalLength = incremental.length;
  stats.lastScanLength = scan.length;
  let equal = scan.length === incremental.length;
  const n = Math.min(scan.length, incremental.length);
  let firstOrderDiff = -1;
  for (let i = 0; i < n; i++) {
    if (scan[i] !== incremental[i]) {
      equal = false;
      firstOrderDiff = i;
      break;
    }
  }
  stats.lastFirstOrderDiff = firstOrderDiff;
  if (!equal) stats.mismatchFrames++;
  return equal;
}
