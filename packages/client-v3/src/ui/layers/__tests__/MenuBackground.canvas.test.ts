/**
 * Canvas-fallback unit tests for `MenuBackground` (ticket 09).
 *
 * The existing `MenuBackground.test.ts` covers the PURE composition contract (02
 * locked scene + 04 scrollFactors + camera neutral) but explicitly does NOT
 * import the `MenuBackground` class — its NOTE explains why: the class imports
 * the runtime `LightingPipeline` (WebGL-only — Phaser's import-time probe trips
 * under jsdom). These tests break that barrier with two targeted mocks so the
 * Canvas branch (the ticket 09 work) is genuinely exercised:
 *
 *   - `vi.mock('phaser')` — MenuBackground imports Phaser as a VALUE for
 *     `Phaser.WEBGL` (the Canvas guard, `MenuBackground.ts:270`) +
 *     `Phaser.BlendModes.ADD` (the aura blend). The mock supplies those.
 *   - `vi.mock('...LightingPipeline.js')` — short-circuits the WebGL-only
 *     transitive import chain (LightingFinalFilter / ResizeHandler / …) so the
 *     module loads under jsdom. The stub class is never constructed on the
 *     Canvas branch anyway (the WebGL guard bails before `new LightingPipeline`).
 *
 * Two test groups:
 *   1. Pure helpers (`computeCanvasAuraAlpha` / `computeCanvasAuraScaleMul` /
 *      `buildCanvasFallbackSpec`) — the no-black invariant as pure data: the
 *      aura alpha NEVER hits 0 (floored ~0.567 by the campfire profile), the
 *      backdrop always lists the BG grass base, the vignette is never opaque.
 *   2. Integration — a recording Phaser scene stub, boot on Canvas (renderer
 *      type ≠ WEBGL), assert the branch (a) doesn't crash, (b) produces a
 *      visible backdrop (3 RTs) + the aura sprite + the vignette (no-black),
 *      (c) the aura is driven by TorchFlicker in `update`, (d) destroy cleans
 *      up. Mirrors the `PlayerRenderer.hide.test.ts` chainable-stub pattern.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────-

// MenuBackground imports Phaser as a VALUE for `Phaser.WEBGL` + `Phaser.BlendModes.ADD`.
// The Canvas branch reads only those two; provide them. `Phaser.WEBGL = 2` /
// `Phaser.CANVAS = 1` match Phaser's real renderer-type constants.
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
// class is never constructed on the Canvas branch (the guard bails first).
vi.mock('../../../rendering/lighting/LightingPipeline.js', () => ({
  LightingPipeline: class LightingPipeline {},
}));

import type Phaser from 'phaser'; // real types for the scene-stub casts (mock is runtime-only)
import { computeFlickerMulForKind } from '../../../rendering/lighting/TorchFlicker.js';
import {
  MenuBackground,
  computeCanvasAuraAlpha,
  computeCanvasAuraScaleMul,
  buildCanvasFallbackSpec,
  CANVAS_AURA_BASE_ALPHA,
  CANVAS_AURA_FLICKER_AMP,
  CANVAS_AURA_FLICKER_SEED,
  CANVAS_AURA_TEXTURE_KEY,
  CANVAS_AURA_TINT,
  CANVAS_AURA_DIAMETER,
  CANVAS_VIGNETTE_STRENGTH,
  CANVAS_VIGNETTE_COLOR,
} from '../MenuBackground.js';
import {
  MENU_MID_SCROLL_FACTOR,
  getMenuDioramaAuraAnchor,
} from '../menuDioramaComposition.js';
import { DesignTokens } from '../../DesignTokens.js';

// ── Pure helper tests (no Phaser scene — the no-black invariant as data) ─────

describe('09 Canvas fallback — TorchFlicker aura alpha (no-black)', () => {
  it('alpha is ALWAYS > 0 across a long sample (never black — the hard invariant)', () => {
    // Sample 100s of campfire roar at 50ms resolution. The campfire profile
    // (TorchFlicker.ts:129-136) floors ~0.334 / flares ~1.6, so
    // alpha = 0.5 + 0.2*mul floors at ~0.567 — comfortably > 0 everywhere.
    let min = Infinity;
    for (let tMs = 0; tMs <= 100_000; tMs += 50) {
      const a = computeCanvasAuraAlpha(tMs);
      expect(a).toBeGreaterThan(0);
      if (a < min) min = a;
    }
    // Tighter floor: the glow is always clearly visible (not just barely > 0).
    expect(min).toBeGreaterThan(0.55);
  });

  it('alpha stays under 1 (no whiteout — the glow reads as a warm disk, not a flare)', () => {
    let max = -Infinity;
    for (let tMs = 0; tMs <= 100_000; tMs += 50) {
      const a = computeCanvasAuraAlpha(tMs);
      if (a > max) max = a;
    }
    expect(max).toBeLessThan(0.85);
  });

  it('is deterministic per (time, seed) — no random shimmer', () => {
    const a1 = computeCanvasAuraAlpha(12_345);
    const a2 = computeCanvasAuraAlpha(12_345);
    expect(a1).toBe(a2);
    // A different seed produces a (likely) different value — the seed is honored.
    const a3 = computeCanvasAuraAlpha(12_345, 99.9);
    expect(a3).not.toBe(a1);
  });

  it('matches the documented formula: BASE + AMP * campfireFlickerMul', () => {
    const tMs = 4_200;
    const mul = computeFlickerMulForKind('campfire', {
      t: tMs / 1000,
      seed: CANVAS_AURA_FLICKER_SEED,
    });
    expect(computeCanvasAuraAlpha(tMs)).toBeCloseTo(
      CANVAS_AURA_BASE_ALPHA + CANVAS_AURA_FLICKER_AMP * mul,
      10,
    );
  });

  it('reads as a slow roar, not a strobe (consecutive frames move gradually)', () => {
    // The campfire profile's dominant octave is sub-Hz (0.175Hz slow roar);
    // the fast octave (1.751Hz) contributes <~0.004 alpha/frame. The largest
    // frame-to-frame jump is the FLARE step (TorchFlicker.ts:127-128): when
    // `sin(t*0.7+seed*5)` crosses 0.86, the multiplier flips 1.0↔1.6 → up to
    // 0.2*0.6 = 0.12 alpha between two adjacent samples. A true strobe would
    // swing the full ~0.5 alpha range per frame; the roar stays well under 0.15.
    let maxFrameDelta = 0;
    for (let tMs = 0; tMs <= 10_000; tMs += 16) {
      const d = Math.abs(computeCanvasAuraAlpha(tMs + 16) - computeCanvasAuraAlpha(tMs));
      if (d > maxFrameDelta) maxFrameDelta = d;
    }
    expect(maxFrameDelta).toBeLessThan(0.15);
  });
});

describe('09 Canvas fallback — aura scale breathing', () => {
  it('scale multiplier stays near 1 (subtle ±~6% swell, never collapses the glow)', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let tMs = 0; tMs <= 100_000; tMs += 50) {
      const s = computeCanvasAuraScaleMul(tMs);
      if (s < min) min = s;
      if (s > max) max = s;
    }
    expect(min).toBeGreaterThan(0.93);
    expect(max).toBeLessThan(1.07);
  });

  it('is deterministic', () => {
    expect(computeCanvasAuraScaleMul(7_777)).toBe(computeCanvasAuraScaleMul(7_777));
  });
});

describe('09 Canvas fallback — spec (no-black recipe as data)', () => {
  // Ticket 14: `buildCanvasFallbackSpec` now takes the variant's aura anchor
  // (resolved from the registry — forest-bonfire = col 7.5, row 1.5).
  const spec = buildCanvasFallbackSpec(getMenuDioramaAuraAnchor('forest-bonfire'));

  it('keeps all 5 backdrop RT layers visible (BG grass is the no-black base)', () => {
    // Ticket 28: the backdrop grew from 3 (bg/mid/fg) to 5 (far/bg/mid/fg/fore).
    // BG's grass field fills the 2048×1152 stage edge-to-edge; without it the
    // sparse MID tiles (planks/paths/props) would leave transparent RT backdrop
    // → scene-clear black around the clearing. BG MUST stay.
    expect(spec.backdropLayerIds).toEqual(['far', 'bg', 'mid', 'fg', 'fore']);
    expect(spec.backdropLayerIds).toContain('bg');
  });

  it('collapses ALL non-MID scrollFactors to MID (single-plane drift — reduced parallax)', () => {
    // Ticket 28: the collapse set grew from BG+FG to FAR+BG+FG+FORE (every
    // non-MID RT). MID stays at 1.0 (the light-anchor invariant).
    expect(spec.collapsedScrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // 1.0
  });

  it('places the aura at 02\'s central-fire anchor (col 7.5, row 1.5 — behind the logo)', () => {
    expect(spec.aura.gridX).toBe(7.5);
    expect(spec.aura.gridY).toBe(1.5);
  });

  it('uses the light_01 cookie + warm tint + ADD blend + MID scrollFactor for the aura', () => {
    expect(spec.aura.textureKey).toBe(CANVAS_AURA_TEXTURE_KEY);
    expect(spec.aura.tint).toBe(CANVAS_AURA_TINT);
    expect(spec.aura.tint).toBe(0xffcc66); // campfire-warm per ticket 09 spec.
    expect(spec.aura.blendMode).toBe('ADD');
    expect(spec.aura.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR);
  });

  it('aura base alpha + flicker amp produce a never-0 roar (BASE + AMP*mul, BASE>0)', () => {
    expect(spec.aura.baseAlpha).toBe(CANVAS_AURA_BASE_ALPHA);
    expect(spec.aura.flickerAmp).toBe(CANVAS_AURA_FLICKER_AMP);
    expect(spec.aura.baseAlpha).toBeGreaterThan(0); // even if mul→0, alpha>0.
    expect(spec.aura.diameter).toBe(CANVAS_AURA_DIAMETER);
  });

  it('vignette is a screen-space overlay (scrollFactor 0) with nearBlack edges, strength ~0.30', () => {
    expect(spec.vignette.scrollFactor).toBe(0);
    expect(spec.vignette.color).toBe(CANVAS_VIGNETTE_COLOR);
    expect(spec.vignette.color).toBe(DesignTokens.color.nearBlack);
  });

  it('vignette strength is in (0,1) — mood, never fully opaque (no-black, no fog)', () => {
    // GDD docs/GDD.md:210 forbids fog of war; the vignette darkens edges only.
    expect(spec.vignette.strength).toBe(CANVAS_VIGNETTE_STRENGTH);
    expect(spec.vignette.strength).toBeGreaterThan(0);
    expect(spec.vignette.strength).toBeLessThan(1);
    expect(spec.vignette.strength).toBeLessThanOrEqual(0.4);
  });
});

// ── Integration: boot the real MenuBackground class on a Canvas scene stub ──

/**
 * A recording game-object: each setter records its arg + returns the rec for
 * chaining (mirrors `makeChainableGameObject` in PlayerRenderer.hide.test.ts,
 * but records the values the no-black assertions read back).
 */
interface RecordedSprite {
  args: [number, number, string, string?];
  alpha: number;
  displayW: number;
  displayH: number;
  scrollFactor: number;
  depth: number;
  tint: number;
  blendMode: unknown;
  destroyed: boolean;
}
interface RecordedRT {
  args: [number, number, number, number];
  scrollFactor: number;
  depth: number;
  destroyed: boolean;
  drawCalls: number;
  renderCalls: number;
  fillCalls: number; // ticket 28: bake-time haze wash (rt.fill) call count.
  fillArgs: Array<{ color: number; alpha: number }>; // the haze color + alpha per call.
}
interface RecordedImage {
  args: [number, number, string];
  scrollFactor: number;
  depth: number;
  alpha: number;
  originX: number;
  originY: number;
  destroyed: boolean;
}

const CANVAS_RENDERER_TYPE = 1; // Phaser.CANVAS (the mock's value).

function makeRecordingScene() {
  const sprites: RecordedSprite[] = [];
  const rts: RecordedRT[] = [];
  const images: RecordedImage[] = [];
  const existingTextures = new Set<string>(['light_01', 'game']); // MainMenuScene.preload.

  const canvasCtx = {
    fillStyle: '',
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
  };
  const canvasTex = { getContext: () => canvasCtx, refresh: () => {} };

  const makeSprite = (args: [number, number, string, string?]): RecordedSprite => {
    const rec: RecordedSprite = {
      args,
      alpha: 1,
      displayW: 0,
      displayH: 0,
      scrollFactor: 1,
      depth: 0,
      tint: 0xffffff,
      blendMode: null,
      destroyed: false,
    };
    const s = {
      setOrigin: () => s,
      setScale: () => s,
      // Ticket 26 added `rotation?`/`flipH?` consumption in `bakeLayer`
      // (MenuBackground.ts:343-344); ticket 27 is the first to actually set
      // `rotation` on tiles (the G2 rug corners), so these mock methods are
      // now exercised on the Canvas-fallback path. No-ops (the Canvas test
      // only verifies boot/update/destroy lifecycle + no-black, not rotation).
      setRotation: () => s,
      setFlipX: () => s,
      setDisplaySize: (w: number, h: number) => {
        rec.displayW = w;
        rec.displayH = h;
        return s;
      },
      setTint: (t: number) => {
        rec.tint = t;
        return s;
      },
      setAlpha: (a: number) => {
        rec.alpha = a;
        return s;
      },
      setBlendMode: (b: unknown) => {
        rec.blendMode = b;
        return s;
      },
      setScrollFactor: (sf: number) => {
        rec.scrollFactor = sf;
        return s;
      },
      setDepth: (d: number) => {
        rec.depth = d;
        return s;
      },
      setVisible: () => s,
      destroy: () => {
        rec.destroyed = true;
      },
    };
    Object.assign(s, { __rec: rec });
    sprites.push(rec);
    return s as unknown as RecordedSprite & { __rec: RecordedSprite };
  };

  const makeRT = (args: [number, number, number, number]): RecordedRT => {
    const rec: RecordedRT = {
      args,
      scrollFactor: 1,
      depth: 0,
      destroyed: false,
      drawCalls: 0,
      renderCalls: 0,
      fillCalls: 0,
      fillArgs: [],
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
      // Ticket 28: bake-time haze wash (rt.fill(color, alpha)) — the
      // atmospheric-perspective overlay applied INSIDE bakeLayer for far/bg.
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
    return rt as unknown as RecordedRT & { __rec: RecordedRT };
  };

  const makeImage = (args: [number, number, string]): RecordedImage => {
    const rec: RecordedImage = {
      args,
      scrollFactor: 1,
      depth: 0,
      alpha: 1,
      originX: 0,
      originY: 0,
      destroyed: false,
    };
    const img = {
      setOrigin: (x: number, y: number) => {
        rec.originX = x;
        rec.originY = y;
        return img;
      },
      setScrollFactor: (sf: number) => {
        rec.scrollFactor = sf;
        return img;
      },
      setDepth: (d: number) => {
        rec.depth = d;
        return img;
      },
      setAlpha: (a: number) => {
        rec.alpha = a;
        return img;
      },
      destroy: () => {
        rec.destroyed = true;
      },
    };
    images.push(rec);
    return img as unknown as RecordedImage & { __rec: RecordedImage };
  };

  const scene = {
    add: {
      renderTexture: (...args: [number, number, number, number]) => makeRT(args),
      sprite: (...args: [number, number, string, string?]) => makeSprite(args),
      image: (...args: [number, number, string]) => makeImage(args),
    },
    textures: {
      exists: (k: string) => existingTextures.has(k),
      createCanvas: (k: string) => {
        existingTextures.add(k); // mimic real createCanvas registering the key.
        return canvasTex;
      },
    },
    cameras: {
      main: { setScroll: () => {}, width: 1920, height: 1080, scrollX: 64, scrollY: 36 },
    },
    input: { activePointer: { x: 960, y: 540 } },
    game: { renderer: { type: CANVAS_RENDERER_TYPE } }, // ≠ WEBGL (2) → Canvas branch.
    events: { on: () => {}, emit: () => {} },
    tweens: { add: () => {} }, // unused on the Canvas branch (TorchFlicker replaces the tween).
  };

  return { scene, sprites, rts, images };
}

describe('09 Canvas fallback — boot/update/destroy on a Canvas scene (no-black)', () => {
  it('boot() on Canvas does not throw + isCanvasFallback() is true', () => {
    const { scene } = makeRecordingScene();
    const bg = new MenuBackground();
    expect(() => bg.boot(scene as unknown as Phaser.Scene)).not.toThrow();
    expect(bg.isCanvasFallback()).toBe(true);
    expect(bg.getLighting()).toBeNull(); // no pipeline on Canvas.
    bg.destroy();
  });

  it('produces a visible backdrop (5 baked RTs) — never a black screen', () => {
    const { scene, rts } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    // Ticket 28: 5 RTs baked (far + bg + mid + fg + fore).
    expect(rts.length).toBe(5);
    expect(rts.every((r) => !r.destroyed)).toBe(true);
    bg.destroy();
  });

  it('collapses ALL non-MID RT scrollFactors to MID (single-plane reduced parallax)', () => {
    const { scene, rts } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    // Ticket 28: bake order is far, bg, mid, fg, fore. The Canvas fallback
    // collapses far + bg + fg + fore to MID (1.0); MID stays at 1.0. All five
    // RTs end up at sf=1.0 (single-plane drift).
    expect(rts[0]!.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // far 0.45 → 1.0
    expect(rts[1]!.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // bg 0.70 → 1.0
    expect(rts[2]!.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // mid (unchanged)
    expect(rts[3]!.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // fg 1.30 → 1.0
    expect(rts[4]!.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // fore 1.60 → 1.0
    bg.destroy();
  });

  it('bakes the haze wash into far + bg RTs ONLY (mid/fg/fore get no fill)', () => {
    // Ticket 28: the bake-time haze (rt.fill) is applied INSIDE bakeLayer for
    // far (α 0.28) + bg (α 0.12); mid/fg/fore omit it. This proves the haze is
    // a bake-time overlay (the fill call happens once at boot, not per frame).
    const { scene, rts } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    // far (rts[0]) + bg (rts[1]) each got exactly one fill call.
    expect(rts[0]!.fillCalls).toBe(1); // far haze α 0.28
    expect(rts[0]!.fillArgs[0]!.alpha).toBe(0.28);
    expect(rts[1]!.fillCalls).toBe(1); // bg haze α 0.12
    expect(rts[1]!.fillArgs[0]!.alpha).toBe(0.12);
    // mid + fg + fore got NO fill (clean — light anchors on mid, fore's open
    // center must stay transparent).
    expect(rts[2]!.fillCalls).toBe(0);
    expect(rts[3]!.fillCalls).toBe(0);
    expect(rts[4]!.fillCalls).toBe(0);
    bg.destroy();
  });

  it('produces the aura glow sprite at the fire anchor (light_01, warm tint, ADD)', () => {
    const { scene, sprites } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    // Exactly one aura sprite uses the light_01 cookie (bake temps use 'game').
    const aura = sprites.filter((s) => s.args[2] === 'light_01');
    expect(aura).toHaveLength(1);
    const a = aura[0]!;
    expect(a.tint).toBe(0xffcc66); // campfire-warm.
    expect(a.blendMode).toBe('add'); // Phaser.BlendModes.ADD (mock).
    expect(a.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // anchored to MID.
    // Initial alpha seeded by TorchFlicker (always > 0 — no-black).
    expect(a.alpha).toBe(computeCanvasAuraAlpha(0));
    expect(a.alpha).toBeGreaterThan(0);
    // Sized large (the aura diameter, 640px — the WebGL aura radius×2).
    expect(a.displayW).toBe(CANVAS_AURA_DIAMETER);
    bg.destroy();
  });

  it('produces the vignette overlay (screen-space, nearBlack, strength ~0.30)', () => {
    const { scene, images } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    expect(images).toHaveLength(1);
    const v = images[0]!;
    expect(v.args[2]).toBe('__menuCanvasVignette');
    expect(v.scrollFactor).toBe(0); // screen-space — doesn't drift.
    expect(v.alpha).toBe(CANVAS_VIGNETTE_STRENGTH); // ~0.30.
    expect(v.alpha).toBeGreaterThan(0);
    expect(v.alpha).toBeLessThan(1); // mood, never opaque (no-black).
    bg.destroy();
  });

  it('update() drives the aura alpha/scale via TorchFlicker (no dumb tween)', () => {
    const { scene, sprites } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    const aura = sprites.find((s) => s.args[2] === 'light_01')!;
    const alphaAfterBoot = aura.alpha;

    // Drive a few frames; the alpha must track computeCanvasAuraAlpha(time)
    // exactly (the TorchFlicker formula), and never hit 0.
    let minAlpha = Infinity;
    for (let tMs = 0; tMs <= 5000; tMs += 100) {
      bg.update(tMs, 16);
      expect(aura.alpha).toBeCloseTo(computeCanvasAuraAlpha(tMs), 10);
      expect(aura.alpha).toBeGreaterThan(0);
      if (aura.alpha < minAlpha) minAlpha = aura.alpha;
      // Scale breathing re-applies setDisplaySize around the diameter.
      expect(aura.displayW).toBeGreaterThan(0);
    }
    expect(minAlpha).toBeGreaterThan(0.55); // never black.
    // The alpha actually CHANGED over the sample (the drive is live, not static).
    expect(new Set([alphaAfterBoot, aura.alpha]).size).toBeGreaterThan(1);
    bg.destroy();
  });

  it('isCanvasFallback() is false before boot / after destroy', () => {
    const bg = new MenuBackground();
    expect(bg.isCanvasFallback()).toBe(false); // before boot.
    bg.destroy();
    expect(bg.isCanvasFallback()).toBe(false); // after destroy.
  });

  it('update() before boot / after destroy is a safe no-op', () => {
    const bg = new MenuBackground();
    expect(() => bg.update(1000, 16)).not.toThrow();
    bg.destroy();
    expect(() => bg.update(2000, 16)).not.toThrow();
  });

  it('destroy() tears down the aura + vignette + RTs (no leak on re-boot)', () => {
    const { scene, sprites, images, rts } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    const aura = sprites.find((s) => s.args[2] === 'light_01')!;
    bg.destroy();
    expect(aura.destroyed).toBe(true);
    expect(images[0]!.destroyed).toBe(true);
    expect(rts.every((r) => r.destroyed)).toBe(true);
    expect(bg.isCanvasFallback()).toBe(false); // destroyed → not "active".
  });

  it('boot() is idempotent (a second call is a no-op, does not double-create)', () => {
    const { scene, sprites, rts } = makeRecordingScene();
    const bg = new MenuBackground();
    bg.boot(scene as unknown as Phaser.Scene);
    const auraCount = sprites.filter((s) => s.args[2] === 'light_01').length;
    const rtCount = rts.length;
    bg.boot(scene as unknown as Phaser.Scene); // second boot — no-op.
    expect(sprites.filter((s) => s.args[2] === 'light_01').length).toBe(auraCount);
    expect(rts.length).toBe(rtCount);
    bg.destroy();
  });
});
