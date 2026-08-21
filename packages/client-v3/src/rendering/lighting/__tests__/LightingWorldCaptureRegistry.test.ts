/**
 * Ticket 51 — the incremental world-capture-list correctness harness.
 *
 * The registry (`LightingWorldCaptureRegistry`) replaced the per-frame full
 * display-list scan with event-driven maintenance. A missed hook would
 * SILENTLY drop an object from the lit world (it renders nowhere: ignored on
 * the main camera, absent from the albedo) — normal testing might never
 * notice. This suite is the acceptance-criterion harness: a faithful fake of
 * Phaser-4.1's display-list mechanics (add/remove/destroy/setDepth/sort
 * timings verified against the phaser source — see the registry's file
 * header) drives both the registry AND the kept old-scan oracle
 * (`buildWorldCaptureList`), asserting the two produce IDENTICAL lists —
 * length, membership AND order — after every mutation sequence.
 *
 * Phaser mechanics faked here (with source citations):
 *  - `DisplayList.addChildCallback` (DisplayList.js:108) pushes to the list
 *    tail then emits `addedtoscene` on scene.events.
 *  - `GameObject.destroy` (GameObject.js) emits `destroy` on the OBJECT
 *    (before `removeAllListeners`), then `removeFromDisplayList` splices with
 *    skipCallback=true — NO scene-level `removedfromscene` on that path.
 *  - `List.remove(child)` (skipCallback=false) emits `removedfromscene`.
 *  - `Systems.render` (Systems.js:378) runs `displayList.depthSort()` (a
 *    STABLE sort by depth, only when `sortChildrenFlag` is set) THEN emits
 *    `prerender`.
 *  - `Components.Depth.setDepth` (Depth.js:56) sets `sortChildrenFlag`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('phaser', () => {
  return {
    default: {
      Scenes: {
        Events: {
          ADDED_TO_SCENE: 'addedtoscene',
          REMOVED_FROM_SCENE: 'removedfromscene',
          PRE_RENDER: 'prerender',
        },
      },
      GameObjects: { Events: { DESTROY: 'destroy' } },
    },
    // Named-export shape (for any transitive module that imports named).
    Scenes: {
      Events: {
        ADDED_TO_SCENE: 'addedtoscene',
        REMOVED_FROM_SCENE: 'removedfromscene',
        PRE_RENDER: 'prerender',
      },
    },
    GameObjects: { Events: { DESTROY: 'destroy' } },
  };
});

// The builder imports ALBEDO_RT_KEY (a value) from LightingPipeline.js —
// mocking that module keeps this test's import graph free of the pipeline's
// WebGL-only construction graph.
vi.mock('../LightingPipeline.js', () => ({ ALBEDO_RT_KEY: '__albedoRT' }));

import type Phaser from 'phaser';
import {
  LightingWorldCaptureRegistry,
  compareAgainstFullScan,
  type WorldCaptureFilterInputs,
  type WorldCaptureCompareStats,
} from '../LightingWorldCaptureRegistry.js';
import { buildWorldCaptureList } from '../LightingAlbedoRtBuilder.js';

/** Hand-rolled per-object emitter (the GameObject EventEmitter surface used). */
class FakeGameObject {
  depth = 0;
  type = 'Sprite';
  renderToTexture?: boolean;
  displayList: FakeDisplayList | null = null;
  ignoredOnMainCam = false;
  private readonly listeners = new Map<string, Array<(o: FakeGameObject) => void>>();
  on(ev: string, fn: (o: FakeGameObject) => void): this {
    const arr = this.listeners.get(ev) ?? [];
    arr.push(fn);
    this.listeners.set(ev, arr);
    return this;
  }
  off(ev: string, fn: (o: FakeGameObject) => void): this {
    const arr = this.listeners.get(ev);
    if (arr) this.listeners.set(ev, arr.filter((f) => f !== fn));
    return this;
  }
  emit(ev: string): void {
    for (const fn of [...(this.listeners.get(ev) ?? [])]) fn(this);
  }
  removeAllListeners(): void {
    this.listeners.clear();
  }
  setDepth(d: number): this {
    this.depth = d;
    this.displayList?.queueDepthSort();
    return this;
  }
}

/** Faithful DisplayList + Systems.render simulation (see file header). */
class FakeDisplayList {
  readonly list: FakeGameObject[] = [];
  sortChildrenFlag = false;
  private readonly scene: FakeScene;
  constructor(scene: FakeScene) {
    this.scene = scene;
  }
  queueDepthSort(): void {
    this.sortChildrenFlag = true;
  }
  /** List.add + addChildCallback (push, then scene event). */
  add(obj: FakeGameObject): void {
    if (obj.displayList === this) return; // addChildCallback's no-op guard
    this.list.push(obj);
    obj.displayList = this;
    this.queueDepthSort();
    this.scene.events.emit('addedtoscene', obj);
  }
  /** List.remove(child) — skipCallback=false → scene event fires. */
  remove(obj: FakeGameObject): void {
    const i = this.list.indexOf(obj);
    if (i === -1) return;
    this.list.splice(i, 1);
    this.queueDepthSort();
    obj.displayList = null;
    this.scene.events.emit('removedfromscene', obj);
  }
  /** GameObject.destroy — object `destroy` event, NO scene event (skip=true). */
  destroy(obj: FakeGameObject): void {
    obj.emit('destroy');
    obj.removeAllListeners();
    const i = this.list.indexOf(obj);
    if (i !== -1) this.list.splice(i, 1);
    this.queueDepthSort();
    obj.displayList = null;
  }
  /** Systems.render: (stable) depth sort if flagged, then PRE_RENDER emit. */
  render(): void {
    if (this.sortChildrenFlag) {
      // Insertion sort = stable, mirrors Phaser's StableSort outcome.
      const arr = this.list;
      for (let i = 1; i < arr.length; i++) {
        const item = arr[i]!;
        let j = i - 1;
        while (j >= 0 && arr[j]!.depth > item.depth) {
          arr[j + 1] = arr[j]!;
          j--;
        }
        arr[j + 1] = item;
      }
      this.sortChildrenFlag = false;
    }
    this.scene.events.emit('prerender');
  }
}

class FakeScene {
  readonly events = new (class {
    private readonly map = new Map<string, Array<(o: FakeGameObject) => void>>();
    on(ev: string, fn: (o: FakeGameObject) => void): void {
      this.map.set(ev, [...(this.map.get(ev) ?? []), fn]);
    }
    off(ev: string, fn: (o: FakeGameObject) => void): void {
      this.map.set(ev, (this.map.get(ev) ?? []).filter((f) => f !== fn));
    }
    emit(ev: string, o?: FakeGameObject): void {
      for (const fn of [...(this.map.get(ev) ?? [])]) fn(o!);
    }
  })();
  readonly children: FakeDisplayList;
  readonly cameras = {
    main: {
      ignore: (c: unknown) => {
        (c as FakeGameObject).ignoredOnMainCam = true;
      },
    },
  };
  constructor() {
    this.children = new FakeDisplayList(this);
  }
}

interface Fixture {
  scene: FakeScene;
  registry: LightingWorldCaptureRegistry;
  filterInputs: WorldCaptureFilterInputs;
  stats: WorldCaptureCompareStats;
  /** The old full scan, run on the fake display list (the oracle). */
  oracle(): Phaser.GameObjects.GameObject[];
  /** update() + render() frame: synchronize, then compare, then sort+prerender. */
  frame(): boolean;
}

function makeFixture(): Fixture {
  const scene = new FakeScene();
  const albedoRT = new FakeGameObject();
  albedoRT.type = 'RenderTexture';
  const shaderRefs = [0, 1, 2, 3, 4].map(() => {
    const s = new FakeGameObject();
    s.type = 'Shader';
    s.renderToTexture = true;
    return s;
  });
  const filterInputs: WorldCaptureFilterInputs = {
    albedoRT: albedoRT as unknown as Phaser.GameObjects.RenderTexture,
    rtShaders: shaderRefs as unknown as Phaser.GameObjects.Shader[],
    worldDepthCutoff: 500,
  };
  const sceneAsPhaser = scene as unknown as Phaser.Scene;
  // Pipeline ctor order: build() adds the RT + shaders FIRST (pre-registry —
  // they'd be picked up by the seed), then constructs the registry.
  scene.children.add(albedoRT);
  for (const s of shaderRefs) scene.children.add(s);
  const registry = new LightingWorldCaptureRegistry(sceneAsPhaser, () => filterInputs);
  const stats: WorldCaptureCompareStats = {
    framesCompared: 0,
    mismatchFrames: 0,
    lastIncrementalLength: 0,
    lastScanLength: 0,
    lastFirstOrderDiff: -1,
  };
  const oracle = () => {
    const out: Phaser.GameObjects.GameObject[] = [];
    buildWorldCaptureList(
      {
        children: scene.children.list as unknown as Phaser.GameObjects.GameObject[],
        albedoRT: filterInputs.albedoRT,
        rtShaders: filterInputs.rtShaders,
        worldDepthCutoff: filterInputs.worldDepthCutoff,
      },
      out,
      { ignore: () => undefined } as unknown as Phaser.Cameras.Scene2D.Camera,
      new Set(),
    );
    return out;
  };
  const frame = () => {
    registry.synchronize();
    const equal = compareAgainstFullScan(
      sceneAsPhaser,
      filterInputs,
      registry.list,
      stats,
    );
    scene.children.render();
    return equal;
  };
  return { scene, registry, filterInputs, stats, oracle, frame };
}

const worldObj = (depth: number): FakeGameObject => {
  const o = new FakeGameObject();
  o.setDepth(depth);
  return o;
};

describe('LightingWorldCaptureRegistry (ticket 51 correctness harness)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = makeFixture();
  });

  it('seeds + filters identically to the old full scan on the first frame', () => {
    const player = worldObj(10);
    const entity = worldObj(8);
    const hud = worldObj(510);
    f.scene.children.add(player);
    f.scene.children.add(entity);
    f.scene.children.add(hud);
    expect(f.frame()).toBe(true);
    // frame() also drove the render (stable depth sort on BOTH sides) — the
    // post-render order is depth-sorted: entity(8) before player(10).
    expect(f.registry.list).toEqual([entity, player]);
    expect(f.oracle()).toEqual([entity, player]);
  });

  it('captures spawned world objects + ignores them on the main camera', () => {
    const player = worldObj(10);
    f.scene.children.add(player);
    f.frame();
    expect(f.registry.list).toContain(player);
    expect(player.ignoredOnMainCam).toBe(true);
  });

  it('defers filter evaluation past spawn-chain setDepth (HUD add with late depth)', () => {
    // The hazard: `scene.add.text(...).setDepth(600)` fires ADDED_TO_SCENE
    // while depth is still the default 0 — evaluating at add time would
    // wrongly capture + camera-ignore the HUD object.
    const hud = new FakeGameObject();
    f.scene.children.add(hud); // added at default depth 0
    hud.setDepth(600); // ...the chained setDepth, same synchronous block
    f.frame();
    expect(f.registry.list).not.toContain(hud);
    expect(hud.ignoredOnMainCam).toBe(false);
    expect(f.frame()).toBe(true);
  });

  it('removes destroyed members from the list AND the ignore set (leak fix)', () => {
    const objs = Array.from({ length: 5 }, () => worldObj(10));
    for (const o of objs) f.scene.children.add(o);
    f.frame();
    expect(f.registry.ignoredOnMainCam.size).toBe(5);
    f.scene.children.destroy(objs[2]!);
    f.scene.children.destroy(objs[4]!);
    f.frame();
    expect(f.registry.list).toEqual([objs[0], objs[1], objs[3]]);
    expect(f.registry.ignoredOnMainCam.has(objs[2]! as never)).toBe(false);
    expect(f.registry.ignoredOnMainCam.has(objs[4]! as never)).toBe(false);
    expect(f.registry.ignoredOnMainCam.size).toBe(3);
    expect(f.frame()).toBe(true);
  });

  it('handles non-destroy removal (REMOVED_FROM_SCENE) + re-add', () => {
    const o = worldObj(12);
    f.scene.children.add(o);
    f.frame();
    f.scene.children.remove(o); // moved off the display list, not destroyed
    f.frame();
    expect(f.registry.list).not.toContain(o);
    f.scene.children.add(o); // re-added later (e.g. scene re-entry)
    f.frame();
    expect(f.registry.list).toContain(o);
    expect(o.ignoredOnMainCam).toBe(true);
    expect(f.frame()).toBe(true);
  });

  it('an add+destroy within one frame leaves no ghost (never evaluated)', () => {
    const transient = worldObj(10);
    f.scene.children.add(transient);
    f.scene.children.destroy(transient);
    f.frame();
    expect(f.registry.list).not.toContain(transient);
    expect(f.registry.ignoredOnMainCam.size).toBe(0);
    expect(f.frame()).toBe(true);
  });

  it('keeps display-list ORDER across interleaved depths + render sorts', () => {
    // Interleave: appended out of depth order, then sorted at render — the
    // registry's PRE_RENDER mirror must match the display list's order.
    const a = worldObj(10);
    const b = worldObj(3);
    const c = worldObj(25);
    const d = worldObj(8);
    const e = worldObj(510); // HUD — must drop out, not participate in order
    for (const o of [a, b, c, d, e]) f.scene.children.add(o);
    f.frame(); // comparator before render: tail order (old scan's quirk)
    f.frame(); // post-render: depth-sorted on both sides
    expect(f.registry.list).toEqual(f.oracle());
    expect(f.registry.list).toEqual([b, d, a, c]);
  });

  it('mirrors the POST_UPDATE-add ordering (evaluated + sorted at PRE_RENDER)', () => {
    const early = worldObj(10);
    f.scene.children.add(early);
    f.frame(); // frame N: early captured; render sorts
    // A spawn AFTER update N but before render N (POST_UPDATE / tween path).
    const late = worldObj(2); // lower depth → render sort interleaves it FIRST
    f.scene.children.add(late);
    f.scene.children.render(); // render N: their sort + registry PRE_RENDER
    // Frame N+1: both sides now have `late` interleaved by depth.
    expect(f.frame()).toBe(true);
    expect(f.registry.list).toEqual([late, early]);
  });

  it('defers cam.ignore to the update drain (old scan timing), not PRE_RENDER', () => {
    const early = worldObj(10);
    f.scene.children.add(early);
    f.frame();
    const late = worldObj(4);
    f.scene.children.add(late);
    f.scene.children.render(); // PRE_RENDER evaluates `late`…
    // …but the ignore drain only runs at the next update (old-scan timing:
    // a mid-frame spawn still renders unlit on the main cam for one frame).
    expect(f.registry.list).toContain(late);
    expect(late.ignoredOnMainCam).toBe(false);
    f.frame();
    expect(late.ignoredOnMainCam).toBe(true);
  });

  it('excludes pipeline-internal RTs/shaders (by ref AND defensive Shader check)', () => {
    // By reference: a rebuilt shader not yet in rtShaders is still excluded
    // defensively when type === 'Shader' && renderToTexture.
    const rogueShader = new FakeGameObject();
    rogueShader.type = 'Shader';
    rogueShader.renderToTexture = true;
    f.scene.children.add(rogueShader);
    f.frame();
    expect(f.registry.list).not.toContain(rogueShader);
    // The albedo RT itself (by reference) never gets drawn into itself.
    expect(f.registry.list).not.toContain(f.filterInputs.albedoRT);
    expect(f.frame()).toBe(true);
  });

  it('simulates a resize rebuild: old shaders destroyed, new ones rejected', () => {
    const world = worldObj(9);
    f.scene.children.add(world);
    f.frame();
    // destroyRtStages: destroy the albedo RT + all 5 shaders…
    const oldRt = f.filterInputs.albedoRT;
    f.scene.children.destroy(oldRt as unknown as FakeGameObject);
    const oldShaders = [...f.filterInputs.rtShaders];
    for (const s of oldShaders) f.scene.children.destroy(s as unknown as FakeGameObject);
    // …rebuild: fresh RT + shaders, filter inputs updated in place.
    const newRt = new FakeGameObject();
    newRt.type = 'RenderTexture';
    const newShaders = [0, 1, 2, 3, 4].map(() => {
      const s = new FakeGameObject();
      s.type = 'Shader';
      s.renderToTexture = true;
      return s;
    });
    f.filterInputs.albedoRT = newRt as unknown as Phaser.GameObjects.RenderTexture;
    f.filterInputs.rtShaders = newShaders as unknown as Phaser.GameObjects.Shader[];
    f.scene.children.add(newRt);
    for (const s of newShaders) f.scene.children.add(s);
    f.frame();
    expect(f.registry.list).toEqual([world]); // only the world object survives
    expect(f.frame()).toBe(true);
  });

  it('keeps pooled objects (hidden, still on the display list) captured', () => {
    // SpritePool.release only hides + deactivates — no display-list event —
    // the object must stay captured exactly like the old scan kept it.
    const pooled = worldObj(14);
    f.scene.children.add(pooled);
    f.frame();
    // (release: setVisible(false) — not modeled here; no events fire.)
    f.frame();
    expect(f.registry.list).toContain(pooled);
  });

  it('the comparator itself catches a manufactured divergence (non-vacuous)', () => {
    const a = worldObj(10);
    f.scene.children.add(a);
    f.frame();
    expect(f.stats.mismatchFrames).toBe(0);
    // Tamper: splice a foreign object into the registry's list mid-order.
    const ghost = worldObj(7);
    (f.registry.list as Phaser.GameObjects.GameObject[]).unshift(
      ghost as unknown as Phaser.GameObjects.GameObject,
    );
    expect(
      compareAgainstFullScan(
        f.scene as unknown as Phaser.Scene,
        f.filterInputs,
        f.registry.list,
        f.stats,
      ),
    ).toBe(false);
    expect(f.stats.mismatchFrames).toBe(1);
    expect(f.stats.lastFirstOrderDiff).toBe(0);
  });

  it('destroy() unsubscribes: later scene events do not resurrect state', () => {
    const a = worldObj(10);
    f.scene.children.add(a);
    f.frame();
    expect(a.ignoredOnMainCam).toBe(true);
    f.registry.destroy();
    // destroy clears every structure (releases object references) — later
    // scene churn must not mutate anything nor throw.
    const b = worldObj(11);
    f.scene.children.add(b);
    f.scene.children.destroy(a);
    f.registry.synchronize(); // no-op on a destroyed registry
    expect(f.registry.list).toHaveLength(0);
    expect(f.registry.ignoredOnMainCam.size).toBe(0);
    expect(b.ignoredOnMainCam).toBe(false); // never processed post-destroy
  });

  it('stress: randomized add/destroy/remove/redepth churn stays equal', () => {
    // Deterministic LCG (no Math.random — sim-side hard rule respected).
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pool: FakeGameObject[] = [];
    for (let step = 0; step < 600; step++) {
      const roll = rand();
      if (roll < 0.45 || pool.length < 3) {
        const o = new FakeGameObject();
        o.setDepth(Math.floor(rand() * 700)); // crosses the 500 boundary at spawn
        if (rand() < 0.3) o.type = rand() < 0.5 ? 'Shader' : 'Text';
        if (o.type === 'Shader') o.renderToTexture = rand() < 0.5;
        f.scene.children.add(o);
        pool.push(o);
        // Spawn-chain setDepth (the deferred-eval hazard) some of the time.
        if (rand() < 0.5) o.setDepth(Math.floor(rand() * 700));
      } else if (roll < 0.75) {
        const i = Math.floor(rand() * pool.length);
        f.scene.children.destroy(pool[i]!);
        pool.splice(i, 1);
      } else if (roll < 0.85) {
        const i = Math.floor(rand() * pool.length);
        f.scene.children.remove(pool[i]!);
        pool.splice(i, 1);
      } else {
        // Mid-life redepth of a CURRENT MEMBER (world→world and world→HUD
        // are both handled — the sweep drops HUD-crossers like the old scan
        // did). The UNMODELED class is HUD→world resurrection (an
        // eval-rejected object redepthed into range — grep-verified absent
        // in the codebase, tripwired live by `__LIGHTING_CAPTURE_COMPARE__`),
        // so the churn redepths only registry members.
        const members = f.registry.list as unknown as FakeGameObject[];
        if (members.length > 0) {
          members[Math.floor(rand() * members.length)]!.setDepth(
            Math.floor(rand() * 700),
          );
        }
      }
      if (step % 3 === 0) expect(f.frame()).toBe(true);
    }
    expect(f.frame()).toBe(true);
    expect(f.stats.framesCompared).toBeGreaterThan(100);
    expect(f.stats.mismatchFrames).toBe(0);
  });
});
