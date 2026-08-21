/**
 * Ticket 54 — ZoneRenderer create-once / hide-on-clear.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * `ZoneRenderer`'s constructor now builds all five objects via `scene.add.*`,
 * and Phaser has no lightweight headless mode in vitest (documented in
 * KillFeedRenderer.text-cache.test). We stub only the scene factory surface
 * (`add.circle` / `add.graphics` / `scale`) with chainable state-recording
 * fakes and mock the heavy Phaser module out entirely (ZoneRenderer imports
 * it for types only).
 *
 * WHAT THIS PROVES:
 *  1. All five objects are created ONCE in the constructor, hidden until
 *     first use — the lazy `if (!this.x)` null-check creates are gone, and
 *     `clear()` → re-`update()` reuses the SAME instances (zero allocation).
 *  2. `clear()` HIDES (invisible + per-object capture-safe reset) instead of
 *     destroying — no destroy() call, no null-out.
 *  3. Lighting-capture safety (ticket 47's ghost-guard, property level):
 *     the capture filter (LightingAlbedoRtBuilder.passesWorldCaptureFilter)
 *     checks depth only — NO visibility — and Phaser's DynamicTexture.draw
 *     draws array entries regardless of `willRender` (DynamicTexture.js:767),
 *     so a hidden captured object still bakes its alpha/geometry into
 *     __albedoRT. While at rest and after clear(), every captured object
 *     must carry the nothing-to-bake state: Arcs (depth 25) alpha 0,
 *     Graphics (depths 24/3) an EMPTY command buffer. warningOverlay
 *     (depth 950) is above the hudBg=500 cutoff → never captured.
 *  4. update() restores the exact visible state the old lazy-create produced
 *     (object alpha 1, positions/radii set BEFORE showing) — visual identity.
 *
 * WHAT THIS DOES NOT PROVE (browser verification):
 *  - The rings/overlays visually appear, track, and clear identically in a
 *    real lit match (covered by tsc + the state assertions above + the
 *    unchanged depth contract locked in ZoneOverlayComposition.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

// ZoneRenderer imports Phaser for TYPES only; keep the heavy real module
// (and any browser-global probing) out of this unit test.
vi.mock('phaser', () => ({ default: {} }));

import { ZoneRenderer } from '../ZoneRenderer.js';

/** The documented world/HUD capture cutoff (DesignTokens.depth.hudBg). */
const HUD_CAPTURE_CUTOFF = 500;

interface ArcStub {
  x: number;
  y: number;
  radius: number;
  visible: boolean;
  alpha: number;
  depth: number;
  lineWidth: number;
  strokeColor: number;
  strokeAlpha: number;
  destroyed: boolean;
  setStrokeStyle: (width: number, color: number, alpha: number) => ArcStub;
  setDepth: (d: number) => ArcStub;
  setAlpha: (a: number) => ArcStub;
  setVisible: (v: boolean) => ArcStub;
  setPosition: (x: number, y: number) => ArcStub;
  setRadius: (r: number) => ArcStub;
  destroy: () => void;
}

function makeArcStub(): ArcStub {
  const stub: ArcStub = {
    x: 0,
    y: 0,
    radius: 0,
    visible: true,
    alpha: 1,
    depth: 0,
    lineWidth: 0,
    strokeColor: 0,
    strokeAlpha: 0,
    destroyed: false,
    setStrokeStyle(width, color, alpha) {
      stub.lineWidth = width;
      stub.strokeColor = color;
      stub.strokeAlpha = alpha;
      return stub;
    },
    setDepth(d) {
      stub.depth = d;
      return stub;
    },
    setAlpha(a) {
      stub.alpha = a;
      return stub;
    },
    setVisible(v) {
      stub.visible = v;
      return stub;
    },
    setPosition(x, y) {
      stub.x = x;
      stub.y = y;
      return stub;
    },
    setRadius(r) {
      stub.radius = r;
      return stub;
    },
    destroy() {
      stub.destroyed = true;
    },
  };
  return stub;
}

interface GraphicsStub {
  visible: boolean;
  depth: number;
  scrollFactor: number;
  /** Nonzero while the command buffer holds any draw command. */
  commandCount: number;
  /** Lifetime clear() calls (ticket 20: proves steady frames issue none). */
  clearCount: number;
  fillRects: Array<[number, number, number, number]>;
  lastFillColor: number | null;
  lastFillAlpha: number | null;
  destroyed: boolean;
  setDepth: (d: number) => GraphicsStub;
  setScrollFactor: (f: number) => GraphicsStub;
  setVisible: (v: boolean) => GraphicsStub;
  clear: () => GraphicsStub;
  fillStyle: (color: number, alpha: number) => GraphicsStub;
  fillRect: (x: number, y: number, w: number, h: number) => GraphicsStub;
  destroy: () => void;
}

function makeGraphicsStub(): GraphicsStub {
  const stub: GraphicsStub = {
    visible: true,
    depth: 0,
    scrollFactor: 1,
    commandCount: 0,
    clearCount: 0,
    fillRects: [],
    lastFillColor: null,
    lastFillAlpha: null,
    destroyed: false,
    setDepth(d) {
      stub.depth = d;
      return stub;
    },
    setScrollFactor(f) {
      stub.scrollFactor = f;
      return stub;
    },
    setVisible(v) {
      stub.visible = v;
      return stub;
    },
    clear() {
      // Mirrors phaser Graphics.clear(): empties the command buffer — an
      // empty buffer submits zero triangles even when drawn into a RT.
      stub.clearCount++;
      stub.commandCount = 0;
      stub.fillRects.length = 0;
      stub.lastFillColor = null;
      stub.lastFillAlpha = null;
      return stub;
    },
    fillStyle(color, alpha) {
      stub.commandCount++;
      stub.lastFillColor = color;
      stub.lastFillAlpha = alpha;
      return stub;
    },
    fillRect(x, y, w, h) {
      stub.commandCount++;
      stub.fillRects.push([x, y, w, h]);
      return stub;
    },
    destroy() {
      stub.destroyed = true;
    },
  };
  return stub;
}

interface SceneHarness {
  scene: unknown;
  circles: ArcStub[];
  graphics: GraphicsStub[];
}

function makeScene(): SceneHarness {
  const circles: ArcStub[] = [];
  const graphics: GraphicsStub[] = [];
  const scene = {
    add: {
      circle: () => {
        const stub = makeArcStub();
        circles.push(stub);
        return stub;
      },
      graphics: () => {
        const stub = makeGraphicsStub();
        graphics.push(stub);
        return stub;
      },
    },
    scale: { width: 1280, height: 720 },
  };
  return { scene, circles, graphics };
}

/** Drive one full zone frame (update + siege call) then read the five objects. */
function bootActiveRenderer(h: SceneHarness) {
  const renderer = new ZoneRenderer(h.scene as never);
  renderer.setWorldBounds(6400, 6400);
  renderer.update(100, 200, 300, 400, 500, 50, true, true);
  // The real per-frame driver (rendering/ZoneTelegraph.updateZoneRenderer)
  // calls this every frame too — including the empty-sector form.
  renderer.renderSiegedSectors([], 1, 64);
  return renderer;
}

describe('Ticket 54 — ZoneRenderer create-once, hide-on-clear', () => {
  it('the constructor creates exactly five objects, all hidden until first use', () => {
    const h = makeScene();
    new ZoneRenderer(h.scene as never);

    // Two arcs (current + next ring) + three graphics — created ONCE, eagerly.
    expect(h.circles).toHaveLength(2);
    expect(h.graphics).toHaveLength(3);

    const [zoneCircle, targetCircle] = h.circles;
    // Same construction args + style/depth chains the old lazy creates used.
    expect(zoneCircle!.lineWidth).toBe(3);
    expect(zoneCircle!.strokeColor).toBe(0xff4444);
    expect(zoneCircle!.strokeAlpha).toBe(0.8);
    expect(zoneCircle!.depth).toBe(25);
    expect(targetCircle!.lineWidth).toBe(2);
    expect(targetCircle!.strokeColor).toBe(0xffaa00);
    expect(targetCircle!.strokeAlpha).toBe(0.4);
    expect(targetCircle!.depth).toBe(25);

    // Hidden at rest — and alpha 0 for the arcs (the albedo ghost-guard:
    // depth 25 < 500 cutoff keeps them captured even while invisible).
    for (const arc of h.circles) {
      expect(arc.visible).toBe(false);
      expect(arc.alpha).toBe(0);
    }

    // Graphics at their contract depths (24 / 950+scroll0 / 3), invisible,
    // with an EMPTY command buffer.
    const [outsideOverlay, warningOverlay, siegeOverlay] = h.graphics;
    expect(outsideOverlay!.depth).toBe(24);
    expect(warningOverlay!.depth).toBe(950);
    expect(warningOverlay!.scrollFactor).toBe(0);
    expect(siegeOverlay!.depth).toBe(3);
    for (const g of h.graphics) {
      expect(g.visible).toBe(false);
      expect(g.commandCount).toBe(0);
    }
  });

  it('clear() hides instead of destroying — every object stays alive with a capture-safe state', () => {
    const h = makeScene();
    const renderer = bootActiveRenderer(h);
    // Everything is shown and drawing (tint + warning border geometry).
    expect(h.circles.every((a) => a.visible && a.alpha === 1)).toBe(true);
    expect(h.graphics.every((g) => g.visible)).toBe(true);
    expect(h.graphics[0]!.commandCount).toBeGreaterThan(0);
    expect(h.graphics[1]!.commandCount).toBeGreaterThan(0);

    renderer.clear();

    for (const arc of h.circles) {
      expect(arc.destroyed).toBe(false);
      expect(arc.visible).toBe(false);
      expect(arc.alpha).toBe(0);
    }
    for (const g of h.graphics) {
      expect(g.destroyed).toBe(false);
      expect(g.visible).toBe(false);
      expect(g.commandCount).toBe(0);
    }
  });

  it('re-show after clear() reuses the SAME instances — zero new allocations', () => {
    const h = makeScene();
    const renderer = bootActiveRenderer(h);
    renderer.clear();
    renderer.update(10, 20, 30, 40, 50, 60, false, false);
    renderer.renderSiegedSectors([], 1, 64); // real driver calls both per frame

    // create-once: no factory was touched again.
    expect(h.circles).toHaveLength(2);
    expect(h.graphics).toHaveLength(3);

    const [zoneCircle, targetCircle] = h.circles;
    expect(zoneCircle!.visible).toBe(true);
    expect(zoneCircle!.alpha).toBe(1);
    expect(zoneCircle!.x).toBe(10);
    expect(zoneCircle!.y).toBe(20);
    expect(zoneCircle!.radius).toBe(30);
    expect(targetCircle!.visible).toBe(true);
    expect(targetCircle!.alpha).toBe(1);
    expect(targetCircle!.radius).toBe(60);
    expect(h.graphics.every((g) => g.visible)).toBe(true);
  });

  it('update() restores the exact old lazy-create visible state (alpha 1) with transforms set before show', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);
    renderer.update(100, 200, 300, 400, 500, 50, false, false);

    const [zoneCircle, targetCircle] = h.circles;
    expect(zoneCircle!.visible).toBe(true);
    expect(zoneCircle!.alpha).toBe(1);
    expect(zoneCircle!.x).toBe(100);
    expect(zoneCircle!.y).toBe(200);
    expect(zoneCircle!.radius).toBe(300);
    expect(targetCircle!.visible).toBe(true);
    expect(targetCircle!.alpha).toBe(1);
    expect(targetCircle!.x).toBe(400);
    expect(targetCircle!.y).toBe(500);
    expect(targetCircle!.radius).toBe(50);

    // Degenerate radius clamps exactly like the old code (Math.max(1, r)).
    renderer.update(0, 0, 0);
    expect(zoneCircle!.radius).toBe(1);
    expect(zoneCircle!.visible).toBe(true);
  });

  it('absent next-zone target hides targetCircle with alpha 0 (a bare setVisible would ghost the albedo)', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.update(100, 200, 300); // no target args

    const targetCircle = h.circles[1]!;
    expect(targetCircle.visible).toBe(false);
    expect(targetCircle.alpha).toBe(0);

    // Show → hide round-trip keeps the guard intact on the way down.
    renderer.update(100, 200, 300, 400, 500, 50);
    expect(targetCircle.alpha).toBe(1);
    renderer.update(100, 200, 300);
    expect(targetCircle.visible).toBe(false);
    expect(targetCircle.alpha).toBe(0);
  });

  it('outside tint and warning border geometry are identical to the old draw calls', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);

    // Inactive: geometry stays EMPTY every frame (clear() semantics).
    renderer.setWorldBounds(6400, 6400);
    renderer.update(1, 1, 10, 2, 2, 5, false, false);
    expect(h.graphics[0]!.commandCount).toBe(0);
    expect(h.graphics[1]!.commandCount).toBe(0);

    // Outside → exactly one world-sized red fillRect at the ticket-13 alpha.
    renderer.update(1, 1, 10, 2, 2, 5, true, false);
    const outside = h.graphics[0]!;
    expect(outside.commandCount).toBe(2); // fillStyle + fillRect
    expect(outside.lastFillColor).toBe(0xff0000);
    expect(outside.lastFillAlpha).toBe(0.25);
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);

    // Warning → the 4 screen-space border rects.
    renderer.update(1, 1, 10, 2, 2, 5, false, true);
    const warning = h.graphics[1]!;
    expect(warning.fillRects).toEqual([
      [0, 0, 1280, 50],
      [0, 720 - 50, 1280, 50],
      [0, 0, 50, 720],
      [1280 - 50, 0, 50, 720],
    ]);
  });

  it('lighting-capture safety: every at-rest/cleared object bakes nothing into the albedo', () => {
    // The capture predicate is depth < 500 with NO visibility check; draw()
    // renders array entries regardless of willRender. So "contributes
    // nothing" must come from alpha (arcs) / empty command buffer (graphics).
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.renderSiegedSectors([], 1, 64); // the per-frame no-sector call

    // Arcs + outsideOverlay are hidden at rest (never touched by a zone
    // update): invisible AND capture-safe (alpha 0 / empty buffer).
    for (const arc of h.circles) {
      expect(arc.depth).toBeLessThan(HUD_CAPTURE_CUTOFF); // captured...
      expect(arc.visible).toBe(false); // ...yet invisible on the main camera
      expect(arc.alpha).toBe(0); // ...and transparent under the albedo bake
    }
    const outside = h.graphics[0]!;
    expect(outside.depth).toBeLessThan(HUD_CAPTURE_CUTOFF);
    expect(outside.visible).toBe(false);
    expect(outside.commandCount).toBe(0);

    // siegeOverlay was just driven by the per-frame siege call: it mirrors
    // the old always-visible-empty object (visible, geometry permanently
    // empty — the stub visualizer). Capture safety = the EMPTY buffer; an
    // empty command list submits zero triangles even while "captured".
    const siege = h.graphics[2]!;
    expect(siege.depth).toBeLessThan(HUD_CAPTURE_CUTOFF);
    expect(siege.commandCount).toBe(0);

    // warningOverlay is HUD-layer (depth 950 ≥ 500): never captured, so
    // visibility alone is its whole story under the main camera.
    const warning = h.graphics[1]!;
    expect(warning.depth).toBeGreaterThanOrEqual(HUD_CAPTURE_CUTOFF);

    // ...and the same invariants hold after a full show → clear cycle.
    renderer.setWorldBounds(6400, 6400);
    renderer.update(1, 1, 10, 2, 2, 5, true, true);
    renderer.clear();
    for (const arc of h.circles) {
      expect(arc.visible).toBe(false);
      expect(arc.alpha).toBe(0);
    }
    for (const g of h.graphics) {
      expect(g.visible).toBe(false);
      expect(g.commandCount).toBe(0);
    }
  });

  it('clear() is idempotent (scene shutdown may run it more than once)', () => {
    const h = makeScene();
    const renderer = bootActiveRenderer(h);
    renderer.clear();
    renderer.clear();
    expect(h.circles.every((a) => !a.destroyed)).toBe(true);
    expect(h.graphics.every((g) => !g.destroyed)).toBe(true);
  });
});

describe('Ticket 20 — outside-overlay state-change guard', () => {
  // The outside tint depends ONLY on isOutside + world size. Pre-ticket-20,
  // update() re-issued clear()+fillRect(0,0,worldW,worldH) EVERY frame while
  // outside — a full-map Graphics re-tessellation + vertex upload at the exact
  // moment the player is under zone pressure. The guard must issue ZERO
  // Graphics commands in the steady state and redraw EXACTLY the old command
  // sequence on every transition (inside↔outside, world resize, post-clear
  // re-show). The pulsing warningOverlay is intentionally NOT guarded (its
  // alpha animates by design).
  it('steady outside state issues zero Graphics commands per frame', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);

    // Transition into outside: the one allowed clear+fillStyle+fillRect.
    renderer.update(1, 1, 10, 2, 2, 5, true, false);
    const outside = h.graphics[0]!;
    expect(outside.commandCount).toBe(2);
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);
    const clearsAfterTransition = outside.clearCount;

    // Ten more frames fully outside: no clear, no fillStyle, no fillRect.
    for (let i = 0; i < 10; i++) renderer.update(1, 1, 10, 2, 2, 5, true, false);
    expect(outside.clearCount).toBe(clearsAfterTransition);
    expect(outside.commandCount).toBe(2);
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);
    expect(outside.lastFillColor).toBe(0xff0000);
    expect(outside.lastFillAlpha).toBe(0.25);
    expect(outside.visible).toBe(true);
  });

  it('steady inside state also issues zero Graphics commands (buffer stays empty)', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);
    renderer.update(1, 1, 10, 2, 2, 5, false, false);
    const outside = h.graphics[0]!;
    expect(outside.commandCount).toBe(0);
    const clears = outside.clearCount;

    for (let i = 0; i < 10; i++) renderer.update(1, 1, 10, 2, 2, 5, false, false);
    expect(outside.clearCount).toBe(clears); // the old code cleared every frame
    expect(outside.commandCount).toBe(0); // ghost-guard: empty buffer bakes nothing
  });

  it('inside↔outside transitions redraw exactly as before', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);
    const outside = h.graphics[0]!;

    renderer.update(1, 1, 10, 2, 2, 5, false, false); // inside: empty buffer
    renderer.update(1, 1, 10, 2, 2, 5, true, false); // → outside: one world rect
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);
    expect(outside.commandCount).toBe(2);

    renderer.update(1, 1, 10, 2, 2, 5, false, false); // → inside: buffer cleared
    expect(outside.commandCount).toBe(0);
    expect(outside.fillRects).toEqual([]);

    renderer.update(1, 1, 10, 2, 2, 5, true, false); // → outside again
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);
  });

  it('world resize while outside redraws with the new bounds', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);
    renderer.update(1, 1, 10, 2, 2, 5, true, false);

    renderer.setWorldBounds(10240, 10240);
    renderer.update(1, 1, 10, 2, 2, 5, true, false);
    const outside = h.graphics[0]!;
    expect(outside.fillRects).toEqual([[0, 0, 10240, 10240]]);
    expect(outside.commandCount).toBe(2);
  });

  it('clear() → update() re-shows and redraws (the guard is invalidated)', () => {
    const h = makeScene();
    const renderer = new ZoneRenderer(h.scene as never);
    renderer.setWorldBounds(6400, 6400);
    renderer.update(1, 1, 10, 2, 2, 5, true, false);
    renderer.clear();

    renderer.update(1, 1, 10, 2, 2, 5, true, false);
    const outside = h.graphics[0]!;
    expect(outside.visible).toBe(true);
    expect(outside.commandCount).toBe(2);
    expect(outside.fillRects).toEqual([[0, 0, 6400, 6400]]);
  });
});
