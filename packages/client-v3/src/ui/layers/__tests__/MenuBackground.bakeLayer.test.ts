/**
 * bakeLayer unit tests for `MenuBackground` (ticket 26 — rotation/flipH prefactor).
 *
 * `bakeLayer` stamps a composition layer's tiles into a baked RenderTexture.
 * Ticket 26 adds optional `rotation?` (degrees clockwise) + `flipH?` to each
 * `MenuDioramaTileEntry` and applies them per-tile in `bakeLayer` BEFORE the
 * `rt.draw`. These tests pin the new orientation contract directly: the
 * function is exercised with SYNTHETIC layers carrying the new fields (no
 * registry variant sets them yet — that's ticket 27, the G2 focal-medallion's
 * rotated rug corners). What's pinned:
 *
 *   - A plain tile (no rotation/flipH) stamps byte-identical to pre-ticket-26
 *     (setRotation never called, flipX stays false) — the backward-compat
 *     guarantee that makes this a safe prefactor.
 *   - A tile with rotation=90 stamps with setRotation(Math.PI/2) — degrees are
 *     converted to radians (Phaser's setRotation is radians), mirroring
 *     `MapRenderer.renderStaticVisualLayers` (MapRenderer.ts:369) +
 *     `LightPropRenderer` (LightPropRenderer.ts:309) which consume the sibling
 *     `LightPlacementTiled.rotation` identically.
 *   - A tile with flipH=true stamps with setFlipX(true) (decoupled from scale —
 *     the ticket's named mechanism).
 *   - A tile with rotation=90 + flipH=true stamps BOTH rotated AND flipped
 *     (the ticket's named case).
 *
 * The same two mocks as `MenuBackground.canvas.test.ts` are used so the module
 * (which imports the WebGL-only `LightingPipeline` at load time) loads under
 * jsdom: `vi.mock('phaser')` (MenuBackground reads `Phaser.WEBGL`/
 * `BlendModes.ADD`) + `vi.mock('...LightingPipeline.js')` (short-circuits the
 * WebGL import chain). `bakeLayer` itself reads NO Phaser constant — the mocks
 * exist only to let the module load; the recording scene stub supplies the
 * runtime scene API (mirrors `makeRecordingScene` in the canvas test).
 */
import { describe, it, expect, vi } from 'vitest';

// MenuBackground imports Phaser as a VALUE for `Phaser.WEBGL` + `Phaser.BlendModes.ADD`
// (the Canvas guard). bakeLayer reads neither, but the module-level import runs on
// load, so the mock must be present. Values match Phaser's real renderer-type constants.
vi.mock('phaser', () => ({
  default: {
    WEBGL: 2,
    CANVAS: 1,
    BlendModes: { ADD: 'add' },
  },
}));

// Short-circuit the WebGL-only LightingPipeline import chain so `MenuBackground`
// loads under jsdom. Path is relative to this test file (3 levels up from
// `ui/layers/__tests__` to `src`, then down to `rendering/lighting`). The stub
// class is never constructed by bakeLayer.
vi.mock('../../../rendering/lighting/LightingPipeline.js', () => ({
  LightingPipeline: class LightingPipeline {},
}));

import type Phaser from 'phaser'; // real types for the scene-stub cast (mock is runtime-only).
import { bakeLayer, TILE_SIZE } from '../MenuBackground.js';
import { MENU_BG_SCROLL_FACTOR } from '../menuDioramaComposition.js';
import type { MenuDioramaLayer, MenuDioramaTileEntry } from '../menuDioramaComposition.js';

// ── Recording scene stub ──────────────────────────────────────────────────────
//
// Captures the per-sprite transforms bakeLayer applies. Mirrors the
// makeRecordingScene pattern in MenuBackground.canvas.test.ts but records the
// rotation/flip fields ticket 26 added (setRotation / setFlipX) alongside the
// pre-existing setScale / setDisplaySize. The recording (`rec`) is pushed to
// the `sprites` array; the chainable `s` is handed to bakeLayer.

interface RecordedSprite {
  args: [number, number, string, string?];
  scale: number;
  displayW: number;
  displayH: number;
  rotation: number; // radians; default 0 (stays 0 unless setRotation is called).
  rotationSet: boolean; // whether setRotation was called at all.
  flipX: boolean; // default false.
  destroyed: boolean;
}
interface RecordedRT {
  args: [number, number, number, number];
  scrollFactor: number;
  depth: number;
  drawCalls: number;
  renderCalls: number;
  fillCalls: number; // ticket 28: bake-time haze wash call count.
  fillArgs: Array<{ color: number; alpha: number }>; // the haze color + alpha.
  destroyed: boolean;
}

function makeRecordingScene() {
  const sprites: RecordedSprite[] = [];
  const rts: RecordedRT[] = [];

  const makeSprite = (args: [number, number, string, string?]) => {
    const rec: RecordedSprite = {
      args,
      scale: 1,
      displayW: 0,
      displayH: 0,
      rotation: 0,
      rotationSet: false,
      flipX: false,
      destroyed: false,
    };
    const s = {
      setOrigin: () => s,
      setScale: (v: number) => {
        rec.scale = v;
        return s;
      },
      setDisplaySize: (w: number, h: number) => {
        rec.displayW = w;
        rec.displayH = h;
        return s;
      },
      setRotation: (r: number) => {
        rec.rotation = r;
        rec.rotationSet = true;
        return s;
      },
      setFlipX: (v: boolean) => {
        rec.flipX = v;
        return s;
      },
      destroy: () => {
        rec.destroyed = true;
      },
    };
    sprites.push(rec);
    return s;
  };

  const makeRT = (args: [number, number, number, number]) => {
    const rec: RecordedRT = {
      args,
      scrollFactor: 1,
      depth: 0,
      drawCalls: 0,
      renderCalls: 0,
      fillCalls: 0,
      fillArgs: [],
      destroyed: false,
    };
    const rt = {
      setOrigin: () => rt,
      setDepth: (d: number) => {
        rec.depth = d;
        return rt;
      },
      setScrollFactor: (sf: number) => {
        rec.scrollFactor = sf;
        return rt;
      },
      draw: () => {
        rec.drawCalls++;
        return rt;
      },
      // Ticket 28: bake-time haze wash (rt.fill(color, alpha)) — recorded so the
      // haze tests can assert it's called exactly once with the right args.
      fill: (color: number, alpha: number) => {
        rec.fillCalls++;
        rec.fillArgs.push({ color, alpha });
        return rt;
      },
      render: () => {
        rec.renderCalls++;
        return rt;
      },
      destroy: () => {
        rec.destroyed = true;
      },
    };
    rts.push(rec);
    return rt;
  };

  const scene = {
    add: {
      renderTexture: (...args: [number, number, number, number]) => makeRT(args),
      sprite: (...args: [number, number, string, string?]) => makeSprite(args),
    },
  };

  return { scene, sprites, rts };
}

// Build a single-tile layer. Orientation is per-tile, so one tile per layer
// isolates the behavior under test (plus a multi-tile case below).
function layerWith(tiles: MenuDioramaTileEntry[]): MenuDioramaLayer {
  return { id: 'bg', scrollFactor: MENU_BG_SCROLL_FACTOR, tiles };
}

describe('26 bakeLayer — rotation/flipH orientation (ticket 26 prefactor)', () => {
  it('a plain tile (no rotation/flipH) stamps byte-identical to pre-ticket-26 (backward-compat)', () => {
    const { scene, sprites, rts } = makeRecordingScene();
    bakeLayer(scene as unknown as Phaser.Scene, layerWith([{ frame: 'tile', col: 0, row: 0 }]), 0);

    expect(sprites).toHaveLength(1);
    const s = sprites[0]!;
    // No orientation applied: setRotation never called, flipX stays false.
    expect(s.rotationSet).toBe(false);
    expect(s.rotation).toBe(0);
    expect(s.flipX).toBe(false);
    // The stamp still drew + rendered (the bake path ran end-to-end).
    expect(rts[0]!.drawCalls).toBe(1);
    expect(rts[0]!.renderCalls).toBe(1);
    // Temp sprite is torn down after the bake (no leak).
    expect(s.destroyed).toBe(true);
  });

  it("a tile with rotation=90 stamps with setRotation(Math.PI/2) — degrees→radians (Phaser's setRotation is radians)", () => {
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([{ frame: 'tiles_corner', col: 0, row: 0, rotation: 90 }]),
      0,
    );
    const s = sprites[0]!;
    expect(s.rotationSet).toBe(true);
    expect(s.rotation).toBeCloseTo(Math.PI / 2, 10);
    // flipH not set → flipX stays false.
    expect(s.flipX).toBe(false);
  });

  it('a tile with flipH=true stamps with setFlipX(true) (decoupled from scale)', () => {
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([{ frame: 'tiles_corner', col: 0, row: 0, flipH: true }]),
      0,
    );
    const s = sprites[0]!;
    expect(s.flipX).toBe(true);
    // rotation not set → setRotation never called.
    expect(s.rotationSet).toBe(false);
  });

  it('a tile with rotation=90 + flipH=true stamps BOTH rotated AND flipped (the ticket case)', () => {
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([{ frame: 'tiles_corner', col: 0, row: 0, rotation: 90, flipH: true }]),
      0,
    );
    const s = sprites[0]!;
    expect(s.rotationSet).toBe(true);
    expect(s.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(s.flipX).toBe(true);
  });

  it('rotation/flipH compose with the existing scale handling (scale 2 + rotation 180 + flip)', () => {
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([{ frame: 'campfire', col: 7, row: 1, scale: 2, rotation: 180, flipH: true }]),
      0,
    );
    const s = sprites[0]!;
    expect(s.scale).toBe(2); // existing scale still applied.
    expect(s.rotation).toBeCloseTo(Math.PI, 10); // 180° → π rad.
    expect(s.flipX).toBe(true);
    // scale !== 1 → the setDisplaySize branch is skipped (pre-existing behavior).
    expect(s.displayW).toBe(0);
    expect(s.displayH).toBe(0);
  });

  it('a layer with a mix of plain + rotated + flipped tiles stamps each independently', () => {
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([
        { frame: 'tile', col: 0, row: 0 }, // plain
        { frame: 'tile', col: 1, row: 0, rotation: 270 }, // rotated
        { frame: 'tile', col: 2, row: 0, flipH: true }, // flipped
        { frame: 'tile', col: 3, row: 0, rotation: 90, flipH: true }, // both
      ]),
      0,
    );
    expect(sprites).toHaveLength(4);
    expect(sprites[0]!.rotationSet).toBe(false);
    expect(sprites[0]!.flipX).toBe(false);
    expect(sprites[1]!.rotation).toBeCloseTo((270 * Math.PI) / 180, 10);
    expect(sprites[1]!.flipX).toBe(false);
    expect(sprites[2]!.rotationSet).toBe(false);
    expect(sprites[2]!.flipX).toBe(true);
    expect(sprites[3]!.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(sprites[3]!.flipX).toBe(true);
  });

  it('places each tile at the correct stage pixel (col*TILE + TILE/2) regardless of orientation', () => {
    // Orientation must NOT shift the tile's stamp position — the sprite is
    // origin-centered (0.5) so rotation/flip pivot around the cell center.
    const { scene, sprites } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWith([{ frame: 'tiles_corner', col: 5, row: 3, rotation: 45, flipH: true }]),
      0,
    );
    const [x, y] = sprites[0]!.args;
    expect(x).toBe(5 * TILE_SIZE + TILE_SIZE / 2);
    expect(y).toBe(3 * TILE_SIZE + TILE_SIZE / 2);
  });
});

// ─── Ticket 28 — bake-time haze wash (doc 19 §2c, REUSE-ONLY) ──────────────
//
// The haze is a BAKE-TIME overlay applied INSIDE bakeLayer: after `rt.draw(temps)`
// stamps the tiles + BEFORE `rt.render()` flushes, a single `rt.fill(hazeColor,
// hazeAlpha)` is called (a translucent source-over blend toward the ambient
// floor color, NOT a shader pass). The fill executes once at boot — the
// pipeline sees the hazed pixels as ordinary albedo. These tests pin:
//   - A layer WITH hazeColor + hazeAlpha>0 calls rt.fill exactly once with the
//     right (color, alpha). This is the reuse-only proof (the haze mechanism
//     is a plain rt.fill, not a LightingPipeline/shader edit).
//   - A layer WITHOUT haze fields (or alpha=0) does NOT call rt.fill — the
//     mid/fg/fore layers stay clean.
//   - The fill is called AFTER draw + BEFORE render (the bake order: stamp
//     tiles → haze wash → flush). Verified by call ordering.

describe('28 bakeLayer — bake-time haze wash (ticket 28 / doc 19 §2c)', () => {
  // Build a layer with optional haze fields. The id is 'far' (matching the
  // production far layer) but bakeLayer is layer-id-agnostic — it reads only
  // hazeColor/hazeAlpha.
  function layerWithHaze(
    tiles: MenuDioramaTileEntry[],
    haze?: { color: number; alpha: number },
  ): MenuDioramaLayer {
    return {
      id: 'far',
      scrollFactor: MENU_BG_SCROLL_FACTOR,
      tiles,
      ...(haze ? { hazeColor: haze.color, hazeAlpha: haze.alpha } : {}),
    };
  }

  it('a layer WITH hazeColor + hazeAlpha>0 calls rt.fill exactly once with the right args', () => {
    const { scene, rts } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWithHaze([{ frame: 'tree', col: 0, row: 0 }], { color: 0x473d2e, alpha: 0.28 }),
      0,
    );
    const rt = rts[0]!;
    expect(rt.fillCalls).toBe(1); // exactly one fill — the bake-time haze wash.
    expect(rt.fillArgs).toEqual([{ color: 0x473d2e, alpha: 0.28 }]);
    // The tiles were still drawn + rendered (the bake path ran end-to-end).
    expect(rt.drawCalls).toBe(1);
    expect(rt.renderCalls).toBe(1);
  });

  it('a layer WITHOUT haze fields does NOT call rt.fill (mid/fg/fore stay clean)', () => {
    const { scene, rts } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWithHaze([{ frame: 'tile', col: 0, row: 0 }]), // no haze fields.
      0,
    );
    expect(rts[0]!.fillCalls).toBe(0);
    expect(rts[0]!.fillArgs).toEqual([]);
    // The tiles were still drawn + rendered (haze absence doesn't break the bake).
    expect(rts[0]!.drawCalls).toBe(1);
    expect(rts[0]!.renderCalls).toBe(1);
  });

  it('a layer with hazeAlpha=0 does NOT call rt.fill (the guard skips zero-alpha)', () => {
    const { scene, rts } = makeRecordingScene();
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWithHaze([{ frame: 'tile', col: 0, row: 0 }], { color: 0x473d2e, alpha: 0 }),
      0,
    );
    expect(rts[0]!.fillCalls).toBe(0);
  });

  it('the haze fill is called AFTER draw + BEFORE render (bake order: stamp → wash → flush)', () => {
    // The DynamicTexture command buffer preserves order: draw pushes DRAW
    // commands, fill pushes a FILL command, render flushes the buffer. So the
    // FILL executes AFTER the tiles are stamped (it blends OVER them) + the
    // render() flush captures both. This test verifies bakeLayer calls them in
    // the right order (draw → fill → render) — proving the haze blends over
    // the tiles, not under them.
    const callOrder: string[] = [];
    const { scene } = makeRecordingScene();
    // Wrap the scene's renderTexture factory to record the call sequence.
    const original = scene.add.renderTexture;
    scene.add.renderTexture = (...args: [number, number, number, number]) => {
      const rt = original(...args);
      const wrappedDraw = rt.draw;
      const wrappedFill = rt.fill;
      const wrappedRender = rt.render;
      (rt as { draw: unknown }).draw = (...d: unknown[]) => {
        callOrder.push('draw');
        return (wrappedDraw as (...a: unknown[]) => unknown)(...d);
      };
      (rt as { fill: unknown }).fill = (...f: unknown[]) => {
        callOrder.push('fill');
        return (wrappedFill as (...a: unknown[]) => unknown)(...f);
      };
      (rt as { render: unknown }).render = (...r: unknown[]) => {
        callOrder.push('render');
        return (wrappedRender as (...a: unknown[]) => unknown)(...r);
      };
      return rt;
    };
    bakeLayer(
      scene as unknown as Phaser.Scene,
      layerWithHaze([{ frame: 'tree', col: 0, row: 0 }], { color: 0x473d2e, alpha: 0.28 }),
      0,
    );
    // draw → fill → render (the haze blends OVER the stamped tiles, then flush).
    expect(callOrder).toEqual(['draw', 'fill', 'render']);
  });
});
