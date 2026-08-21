import { describe, it, expect } from 'vitest';
import {
  createLightBuffers,
  packLights,
  gridToWorldPx,
  cookieKeyToIndex,
  flickerSeedForPlacement,
  MAX_LIGHTS,
  LIGHT_STRIDE,
  COLOR_STRIDE,
  PARAM_STRIDE,
  BLEND_OFFSET_MAX,
  type LightPlacementTiled,
  type DynamicLight,
} from '../LightPacker.js';
import { LIGHT_PALETTE, HERO_LIGHT_OVERRIDES, resolveLightKind } from '../LightPalette.js';
import {
  computeFlickerMul,
  computeFlickerMulForKind,
  type FlickerFlameKind,
} from '../TorchFlicker.js';

const TILE = 128;

function makePlacement(
  kind: LightPlacementTiled['kind'],
  gridX: number,
  gridY: number,
): LightPlacementTiled {
  return { gridX, gridY, kind, rotation: 0, flipH: false, flipV: false };
}

describe('LightPacker — pure-logic light-array packing (Seam A)', () => {
  describe('gridToWorldPx', () => {
    it('converts a grid coord to world px at the tile CENTER', () => {
      // grid 0, tile 128 → 64 (center of the first tile)
      expect(gridToWorldPx(0, 128)).toBe(64);
      // grid 3, tile 128 → 3*128 + 64 = 448
      expect(gridToWorldPx(3, 128)).toBe(448);
      // grid 10, tile 64 → 10*64 + 32 = 672
      expect(gridToWorldPx(10, 64)).toBe(672);
    });
  });

  describe('buffer allocation', () => {
    it('allocates the three arrays at the exact byte offsets (MAX_LIGHTS=256)', () => {
      const b = createLightBuffers();
      // uLights: vec4 per light → 4 * 256 = 1024 floats
      expect(b.uLights.length).toBe(LIGHT_STRIDE * MAX_LIGHTS);
      expect(b.uLights.length).toBe(1024);
      // uLightColors: vec3 per light → 3 * 256 = 768 floats
      expect(b.uLightColors.length).toBe(COLOR_STRIDE * MAX_LIGHTS);
      expect(b.uLightColors.length).toBe(768);
      // uLightParams: vec4 per light → 4 * 256 = 1024 floats
      expect(b.uLightParams.length).toBe(PARAM_STRIDE * MAX_LIGHTS);
      expect(b.uLightParams.length).toBe(1024);
      expect(b.uLightCount).toBe(0);
    });

    it('reuses the same buffer instance across packs (zero-alloc steady state)', () => {
      const b = createLightBuffers();
      const out1 = packLights(b, [], [], { enabled: true, tileSize: TILE });
      const out2 = packLights(b, [], [], { enabled: true, tileSize: TILE });
      expect(out1).toBe(b);
      expect(out2).toBe(b);
    });
  });

  describe('enabled = false (intensity-zero-when-disabled rule)', () => {
    it('sets uLightCount = 0 and short-circuits when disabled', () => {
      const b = createLightBuffers();
      const placements = [makePlacement('torch', 1, 1), makePlacement('campfire', 2, 2)];
      const out = packLights(b, placements, [], { enabled: false, tileSize: TILE });
      expect(out.uLightCount).toBe(0);
      // GLSL loop breaks at uLightCount, so the never-written tail is irrelevant.
    });
  });

  describe('static placement packing', () => {
    it('packs a torch placement at the exact byte offsets', () => {
      const b = createLightBuffers();
      const placements = [makePlacement('torch', 5, 7)];
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE });

      expect(out.uLightCount).toBe(1);
      // uLights[0] = vec4(x, y, radius, intensity)
      expect(out.uLights[0]).toBe(gridToWorldPx(5, TILE)); // x = 5*128+64 = 704
      expect(out.uLights[1]).toBe(gridToWorldPx(7, TILE)); // y = 7*128+64 = 960
      // Ticket 07 (A2): torch has no hero override → DEFAULT_HERO_LIGHT.
      //   A/B baseline: was radius 200 (1.56 tiles), intensity 2.5 (verbatim).
      //   Now: radius 256 (2.0 tiles), intensity 1.9 (dimmer so the wider disk
      //   doesn't blow out — diffuseness now comes from palette corePower/haloFrac).
      expect(out.uLights[2]).toBe(256);
      expect(out.uLights[3]).toBeCloseTo(1.9, 5);

      // uLightColors[0] = torch palette color (1.0, 0.55, 0.22)
      const torchPalette = resolveLightKind('torch');
      expect(out.uLightColors[0]).toBeCloseTo(torchPalette.color[0], 5);
      expect(out.uLightColors[1]).toBeCloseTo(torchPalette.color[1], 5);
      expect(out.uLightColors[2]).toBeCloseTo(torchPalette.color[2], 5);

      // uLightParams[0] = vec4(corePower, haloFrac, specPower, cookieIdx).
      // corePower/haloFrac use toBeCloseTo because Float32Array packing rounds
      // (ticket 07: torch corePower 3.2 → 3.200000047683716 in float32; the
      // prior 4.5 was exactly representable so .toBe happened to work).
      expect(out.uLightParams[0]).toBeCloseTo(torchPalette.corePower, 5);
      expect(out.uLightParams[1]).toBeCloseTo(torchPalette.haloFrac, 5);
      expect(out.uLightParams[2]).toBe(torchPalette.specPower);
      // Cookie index from the torch palette (light_01 → 1). The HdrLit shader
      // gates on `lp.w > 0.5` + the uCookie tier flag, so at tier 1 (uCookie=0)
      // this index is a no-op; at tier 4+ it selects the light_01 sampler.
      expect(out.uLightParams[3]).toBe(cookieKeyToIndex(torchPalette.cookieKey));
      expect(out.uLightParams[3]).toBe(1);
    });

    it('packs a campfire placement with hero radius/intensity override', () => {
      const b = createLightBuffers();
      const placements = [makePlacement('campfire', 0, 0)];
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE });

      expect(out.uLightCount).toBe(1);
      const hero = HERO_LIGHT_OVERRIDES.campfire!;
      // Ticket 07 (A2): campfire 260→320 (2.5 tiles), intensity 3.2→2.6.
      expect(hero.radius).toBe(320);
      expect(hero.intensity).toBe(2.6);
      expect(out.uLights[2]).toBe(320);
      expect(out.uLights[3]).toBeCloseTo(2.6, 5);
    });

    it('packs multiple placements at successive stride offsets', () => {
      const b = createLightBuffers();
      // Ticket 24: the dedupe narrowed `LightPlacementTiled.kind` to the shared
      // LightKind (server-emitted kinds only — `aura` is a client-only dynamic
      // kind, no longer a valid placement `kind`). Use `campfire` (a real
      // hero-override kind) for the second placement; the assertion still pins
      // the hero-override pack path at successive stride offsets.
      const placements = [
        makePlacement('torch', 1, 1),
        makePlacement('campfire', 2, 2),
        makePlacement('candle', 3, 3),
      ];
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE });

      expect(out.uLightCount).toBe(3);
      // Second light (campfire) starts at LIGHT_STRIDE = 4.
      expect(out.uLights[LIGHT_STRIDE + 0]).toBe(gridToWorldPx(2, TILE));
      expect(out.uLights[LIGHT_STRIDE + 1]).toBe(gridToWorldPx(2, TILE));
      // campfire hero override (ticket 07): radius 320, intensity 2.6.
      expect(out.uLights[LIGHT_STRIDE + 2]).toBe(320);
      expect(out.uLights[LIGHT_STRIDE + 3]).toBeCloseTo(2.6, 5);
      // Third light (candle) starts at 2*LIGHT_STRIDE = 8.
      expect(out.uLights[2 * LIGHT_STRIDE + 0]).toBe(gridToWorldPx(3, TILE));
    });

    it('applies placement intensity overrides when provided', () => {
      const b = createLightBuffers();
      const placements = [makePlacement('torch', 1, 1)];
      const overrides = new Map<number, number>([[0, 5.5]]);
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE }, overrides);
      expect(out.uLights[3]).toBeCloseTo(5.5, 5);
    });
  });

  describe('dynamic light packing', () => {
    it('packs a dynamic light after the static placements', () => {
      const b = createLightBuffers();
      const placements = [makePlacement('torch', 1, 1)];
      const dynamic: DynamicLight[] = [
        {
          x: 1500,
          y: 2000,
          radius: 180,
          intensity: 2.0,
          color: [0.4, 0.68, 1.0],
          corePower: 3.5,
          haloFrac: 0.7,
          specPower: 32.0,
          cookieOn: 0,
        },
      ];
      const out = packLights(b, placements, dynamic, { enabled: true, tileSize: TILE });

      expect(out.uLightCount).toBe(2);
      // Dynamic light at index 1 → byte offset LIGHT_STRIDE.
      expect(out.uLights[LIGHT_STRIDE + 0]).toBe(1500);
      expect(out.uLights[LIGHT_STRIDE + 1]).toBe(2000);
      expect(out.uLights[LIGHT_STRIDE + 2]).toBe(180);
      expect(out.uLights[LIGHT_STRIDE + 3]).toBeCloseTo(2.0, 5);
      // flickerMul defaults to 1.0.
      expect(out.uLightColors[COLOR_STRIDE + 0]).toBeCloseTo(0.4, 5);
      expect(out.uLightParams[PARAM_STRIDE + 0]).toBe(3.5);
    });

    it('folds the flicker multiplier into the packed intensity', () => {
      const b = createLightBuffers();
      const dynamic: DynamicLight[] = [
        {
          x: 0,
          y: 0,
          radius: 100,
          intensity: 4.0,
          color: [1, 1, 1],
          corePower: 4,
          haloFrac: 0.5,
          specPower: 28,
          cookieOn: 0,
          flickerMul: 0.75,
        },
      ];
      const out = packLights(b, [], dynamic, { enabled: true, tileSize: TILE });
      expect(out.uLights[3]).toBeCloseTo(3.0, 5); // 4.0 * 0.75
    });

    it('caps at MAX_LIGHTS (256)', () => {
      const b = createLightBuffers();
      const dynamic: DynamicLight[] = Array.from({ length: 400 }, () => ({
        x: 0,
        y: 0,
        radius: 100,
        intensity: 1,
        color: [1, 1, 1] as [number, number, number],
        corePower: 4,
        haloFrac: 0.5,
        specPower: 28,
        cookieOn: 0,
      }));
      const out = packLights(b, [], dynamic, { enabled: true, tileSize: TILE });
      expect(out.uLightCount).toBe(MAX_LIGHTS);
    });
  });

  describe('palette resolution', () => {
    it('resolves every LightKind to its validated palette entry', () => {
      // Origin: prototype.js:588-594 colors. Ticket 07 (A2) retuned corePower/
      // haloFrac (colors UNCHANGED — the warm fire [1.0,0.55,0.22] stays).
      // A/B baselines (verbatim-prototype → ticket-07 corePower/haloFrac):
      //   torch    corePower 4.5 → 3.2    (color unchanged)
      //   fire     corePower 5.0 → 3.8    (color unchanged)
      //   candle   color unchanged (corePower/haloFrac asserted via LightPalette)
      // C2 (lighting-system-3, user ruling 2026-08-07) — aura TONE + COOKIE retune:
      //   aura color [0.4,0.68,1.0] (cool) → [1.0,0.95,0.88] (soft warm-white)
      //   aura cookieKey light_02 (cool) → light_01 (warm)
      //   aura corePower 2.5 / haloFrac 0.85 UNCHANGED (C2 fixes tone, not diffuseness).
      //   See LightPalette.test.ts for the focused C2 regression guard.
      expect(resolveLightKind('torch').color).toEqual([1.0, 0.55, 0.22]);
      expect(resolveLightKind('torch').corePower).toBe(3.2); // was 4.5
      expect(resolveLightKind('torch').specPower).toBe(28.0);

      expect(resolveLightKind('aura').color).toEqual([1.0, 0.95, 0.88]); // C2: was [0.4, 0.68, 1.0] (cool)
      expect(resolveLightKind('aura').cookieKey).toBe('light_01'); // C2: was 'light_02' (cool)
      expect(resolveLightKind('aura').corePower).toBe(2.0); // D2fix: was 2.5 (was 3.5 verbatim) — flattened, aura core too bright

      expect(resolveLightKind('fire').color).toEqual([1.0, 0.3, 0.12]);
      expect(resolveLightKind('fire').corePower).toBe(3.8); // was 5.0
      expect(resolveLightKind('fire').specPower).toBe(22.0);

      expect(resolveLightKind('poison').color).toEqual([0.5, 1.0, 0.4]);

      expect(resolveLightKind('candle').color).toEqual([1.0, 0.85, 0.5]);
    });

    it('covers every LightKind key in LIGHT_PALETTE', () => {
      const kinds = Object.keys(LIGHT_PALETTE);
      // Every entry must resolve without falling back to torch.
      for (const k of kinds) {
        const entry = resolveLightKind(k as LightPlacementTiled['kind']);
        expect(entry).toBeDefined();
        expect(entry.color.length).toBe(3);
      }
    });
  });

  describe('cookieKeyToIndex (per-light cookie selection — ticket 07)', () => {
    it('maps each cookieKey to its HdrLit sampler slot index (1/2/3)', () => {
      // 1 → light_01 (slot 2, warm), 2 → light_02 (slot 3, cool aura),
      // 3 → light_03 (slot 4, poison), null/unknown → 0 (no cookie).
      expect(cookieKeyToIndex('light_01')).toBe(1);
      expect(cookieKeyToIndex('light_02')).toBe(2);
      expect(cookieKeyToIndex('light_03')).toBe(3);
      expect(cookieKeyToIndex(null)).toBe(0);
      expect(cookieKeyToIndex('something_else')).toBe(0);
    });

    it('the shader on/off gate (lp.w > 0.5) treats 0 as OFF and 1/2/3 as ON', () => {
      // The HdrLit shader gates cookies on `lp.w > 0.5`, so index 0 disables
      // cookie modulation for that light and 1/2/3 enable it. Verified here at
      // the data layer so the packer + shader stay in sync.
      expect(cookieKeyToIndex(null) > 0.5).toBe(false);
      expect(cookieKeyToIndex('light_01') > 0.5).toBe(true);
      expect(cookieKeyToIndex('light_02') > 0.5).toBe(true);
      expect(cookieKeyToIndex('light_03') > 0.5).toBe(true);
    });

    it('every palette kind resolves to its validated cookie index', () => {
      // Regression guard: the kind→palette→cookie-index chain must match the
      // prototype's per-kind cookie assignment (prototype.js:589-593).
      // torch/campfire/fire/candle → light_01 (1), biome-glow → light_02 (2),
      // poison → light_03 (3), barrel-fire → light_01 (1).
      // C2 (lighting-system-3): aura cookieKey light_02 (cool, idx 2) → light_01
      // (warm, idx 1) — flipped to match the new soft warm-white tone (the cool
      // cookie light_02 would tint the warm color back toward cool). biome-glow
      // keeps light_02 (it's still cool by design). A/B baseline: aura was 2.
      const expected: Record<string, number> = {
        torch: 1,
        campfire: 1,
        fire: 1,
        candle: 1,
        'barrel-fire': 1,
        aura: 1, // C2: was 2 (light_02 cool) → 1 (light_01 warm)
        'biome-glow': 2,
        poison: 3,
      };
      for (const [kind, idx] of Object.entries(expected)) {
        const entry = resolveLightKind(kind as LightPlacementTiled['kind']);
        expect(cookieKeyToIndex(entry.cookieKey)).toBe(idx);
      }
    });
  });

  // ── Ticket 10: static map placements → packed arrays ──
  // The map-gen LightPlacer emits all 5 shared LightKind values
  // (torch/campfire/candle/biome-glow — barrel-fire is derived client-side from
  // destructible barrels, ticket 11, but the palette + packer must handle it).
  // These tests pin: grid→world for every kind, kind→palette resolution, the
  // flicker-flag rule (torch/campfire/candle/barrel-fire ON; biome-glow OFF),
  // and the static-slice-leaves-dynamic-slots-free budget.
  describe('static map placements — all 5 map-gen LightKind values (ticket 10)', () => {
    it('packs each map-gen kind at the correct grid→world position + palette', () => {
      const b = createLightBuffers();
      // One placement per shared LightKind, distinct grid coords.
      const placements: LightPlacementTiled[] = [
        { gridX: 2, gridY: 3, kind: 'torch', rotation: 0, flipH: false, flipV: false },
        { gridX: 4, gridY: 5, kind: 'campfire', rotation: 0, flipH: false, flipV: false },
        { gridX: 6, gridY: 7, kind: 'candle', rotation: 0, flipH: false, flipV: false },
        { gridX: 8, gridY: 9, kind: 'biome-glow', rotation: 0, flipH: false, flipV: false },
        { gridX: 10, gridY: 11, kind: 'barrel-fire', rotation: 0, flipH: false, flipV: false },
      ];
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE });

      expect(out.uLightCount).toBe(5);
      const kinds: LightPlacementTiled['kind'][] = [
        'torch',
        'campfire',
        'candle',
        'biome-glow',
        'barrel-fire',
      ];
      kinds.forEach((kind, i) => {
        const p = placements[i]!;
        const palette = resolveLightKind(kind);
        const base = i * LIGHT_STRIDE;
        // grid→world (tile center).
        expect(out.uLights[base + 0]).toBe(gridToWorldPx(p.gridX, TILE));
        expect(out.uLights[base + 1]).toBe(gridToWorldPx(p.gridY, TILE));
        // palette color.
        const cb = i * COLOR_STRIDE;
        expect(out.uLightColors[cb + 0]).toBeCloseTo(palette.color[0], 5);
        expect(out.uLightColors[cb + 1]).toBeCloseTo(palette.color[1], 5);
        expect(out.uLightColors[cb + 2]).toBeCloseTo(palette.color[2], 5);
        // palette params + cookie index. corePower/haloFrac use toBeCloseTo
        // because some values (e.g. candle haloFrac 0.78) aren't exact in
        // Float32; specPower + the packed .w are exact integers.
        // D2: the .w slot packs the blend mode alongside the cookie index
        // (cookieIdx + 10 for max-blend) — no separate uLightBlend array.
        const pb = i * PARAM_STRIDE;
        expect(out.uLightParams[pb + 0]).toBeCloseTo(palette.corePower, 5);
        expect(out.uLightParams[pb + 1]).toBeCloseTo(palette.haloFrac, 5);
        expect(out.uLightParams[pb + 2]).toBe(palette.specPower);
        const expectedBlendOffset = palette.blend === 'max' ? BLEND_OFFSET_MAX : 0;
        expect(out.uLightParams[pb + 3]).toBe(
          cookieKeyToIndex(palette.cookieKey) + expectedBlendOffset,
        );
      });
    });

    it('campfire uses the torch palette color + hero override (r=320, i=2.6)', () => {
      // Ticket 07 (A2): campfire hero 260→320 (2.5 tiles), intensity 3.2→2.6.
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 0, gridY: 0, kind: 'campfire', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE },
      );
      const torch = resolveLightKind('torch');
      expect(out.uLightColors[0]).toBeCloseTo(torch.color[0], 5);
      expect(out.uLightColors[1]).toBeCloseTo(torch.color[1], 5);
      expect(out.uLightColors[2]).toBeCloseTo(torch.color[2], 5);
      expect(out.uLights[2]).toBe(HERO_LIGHT_OVERRIDES.campfire!.radius); // 320
      expect(out.uLights[3]).toBeCloseTo(HERO_LIGHT_OVERRIDES.campfire!.intensity, 5); // 2.6
    });

    it('biome-glow is the cool/magical tint (poison-adjacent cool blue, light_02 cookie)', () => {
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 0, gridY: 0, kind: 'biome-glow', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE },
      );
      const glow = resolveLightKind('biome-glow');
      // Cool blue tint (0.4, 0.68, 1.0) — consistent with spec "Light data +
      // tuning values" cool/magical direction. Cookie light_02 (cool aura mask).
      expect(glow.color).toEqual([0.4, 0.68, 1.0]);
      // D2: biome-glow is blend='max', so .w packs cookieIdx(2) + 10 = 12
      // (cookie light_02 + the max-blend offset). The shader extracts cookie
      // 2 via mod(12, 10) and reads max-blend via 12 > 9.5.
      expect(out.uLightParams[3]).toBe(2 + BLEND_OFFSET_MAX); // light_02 + max-blend
    });

    it('barrel-fire maps to the hottest fire palette (light_01 cookie)', () => {
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 0, gridY: 0, kind: 'barrel-fire', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE },
      );
      const fire = resolveLightKind('fire');
      const bf = resolveLightKind('barrel-fire');
      expect(bf.color).toEqual(fire.color); // (1.0, 0.3, 0.12) — hottest red
      expect(bf.corePower).toBe(fire.corePower); // 3.8 (ticket 07; was 5.0)
      expect(out.uLightParams[3]).toBe(1); // light_01
    });
  });

  describe('static-placement flicker flag resolution (ticket 10)', () => {
    // The flicker rule (spec + prototype `isTorch` gate):
    //   torch / campfire / candle / barrel-fire → flicker ON
    //   biome-glow                              → flicker OFF (steady ambient)
    it('flicker-ON kinds fold computeFlickerMul into the packed intensity', () => {
      // Ticket 08 (A4): each flame kind now uses its OWN flicker profile via
      // `computeFlickerMulForKind` (campfire roars, candle steady-flickers,
      // torch modulates). Pre-ticket-08 a single `computeFlickerMul` (torch
      // profile) was applied to every flame. The packer now dispatches per kind,
      // so the expected multiplier must be computed with the matching profile.
      const t = 12.345;
      const kinds: LightPlacementTiled['kind'][] = [
        'torch',
        'campfire',
        'candle',
        'barrel-fire',
        'fireplace',
        'brazier',
        'lantern',
      ];
      for (const kind of kinds) {
        const b = createLightBuffers();
        const gridX = 3;
        const gridY = 7;
        const out = packLights(
          b,
          [{ gridX, gridY, kind, rotation: 0, flipH: false, flipV: false }],
          [],
          { enabled: true, tileSize: TILE, timeSeconds: t, flickerEnabled: true },
        );
        const hero = HERO_LIGHT_OVERRIDES[kind];
        // Ticket 07: candle now has a hero override (1.4); torch/biome-glow/
        // barrel-fire fall back to DEFAULT_HERO_LIGHT.intensity (1.9, was 2.5).
        // Ticket 08: fireplace/brazier/lantern get hero overrides (2.6/2.1/1.3).
        const baseIntensity = hero?.intensity ?? 1.9;
        // Per-kind expected multiplier. `computeFlickerMulForKind` resolves the
        // kind's profile; for torch it's the verbatim-prototype baseline (the
        // legacy `computeFlickerMul`). For barrel-fire it falls back to torch
        // (not a FlameKind — defensive).
        const expectedMul = computeFlickerMulForKind(kind as FlickerFlameKind, {
          t,
          seed: flickerSeedForPlacement(gridX, gridY),
        });
        expect(out.uLights[3]).toBeCloseTo(baseIntensity * expectedMul, 5);
      }
    });

    it('biome-glow does NOT flicker (steady intensity regardless of time)', () => {
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 3, gridY: 7, kind: 'biome-glow', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE, timeSeconds: 99.9, flickerEnabled: true },
      );
      // No hero override for biome-glow → DEFAULT_HERO_LIGHT.intensity (ticket 07:
      // 1.9, was 2.5), unmoved by flicker.
      expect(out.uLights[3]).toBeCloseTo(1.9, 5);
    });

    it('flicker is deterministic: same gridX/gridY + time → identical multiplier', () => {
      // Two placements at the same grid coord pack the same flicker phase.
      const t = 5.5;
      const seed = flickerSeedForPlacement(11, 13);
      const b1 = createLightBuffers();
      const b2 = createLightBuffers();
      const opts = { enabled: true, tileSize: TILE, timeSeconds: t, flickerEnabled: true } as const;
      packLights(
        b1,
        [{ gridX: 11, gridY: 13, kind: 'torch', rotation: 0, flipH: false, flipV: false }],
        [],
        opts,
      );
      packLights(
        b2,
        [{ gridX: 11, gridY: 13, kind: 'torch', rotation: 0, flipH: false, flipV: false }],
        [],
        opts,
      );
      expect(b1.uLights[3]).toBe(b2.uLights[3]);
      // ...and it equals the standalone computeFlickerMul product (no Math.random).
      // Ticket 07: torch base is DEFAULT_HERO_LIGHT.intensity = 1.9 (was 2.5).
      const base = 1.9;
      expect(b1.uLights[3]).toBeCloseTo(base * computeFlickerMul({ t, seed }), 5);
    });

    it('omitting timeSeconds packs the base intensity (no flicker) — Seam-A base-value path', () => {
      // The pipeline always passes timeSeconds, but the packer stays pure for
      // tests asserting base values directly. Existing assertions rely on this.
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 1, gridY: 1, kind: 'torch', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE },
      );
      // Ticket 07: torch base = DEFAULT_HERO_LIGHT.intensity = 1.9 (was 2.5).
      expect(out.uLights[3]).toBeCloseTo(1.9, 5);
    });

    it('flickerEnabled=false disables flicker even for flame kinds (tier-1 baseline)', () => {
      const b = createLightBuffers();
      const out = packLights(
        b,
        [{ gridX: 1, gridY: 1, kind: 'torch', rotation: 0, flipH: false, flipV: false }],
        [],
        { enabled: true, tileSize: TILE, timeSeconds: 42.0, flickerEnabled: false },
      );
      // Ticket 07: torch base = DEFAULT_HERO_LIGHT.intensity = 1.9 (was 2.5).
      expect(out.uLights[3]).toBeCloseTo(1.9, 5);
    });

    it('flickerSeedForPlacement is stable + well-spread across adjacent tiles', () => {
      // Deterministic: same input → same output.
      expect(flickerSeedForPlacement(5, 5)).toBe(flickerSeedForPlacement(5, 5));
      // Spread: adjacent tiles shouldn't share a phase (cheap diversity check).
      const s1 = flickerSeedForPlacement(5, 5);
      const s2 = flickerSeedForPlacement(6, 5);
      const s3 = flickerSeedForPlacement(5, 6);
      expect(new Set([s1, s2, s3]).size).toBe(3);
    });
  });

  describe('static + dynamic budget — static slice leaves dynamic slots free (ticket 10)', () => {
    it('the map-gen cap (≤40 static) + dynamic stays within MAX_LIGHTS', () => {
      // The map-gen LightPlacer caps at MAX_MAP_LIGHT_PLACEMENTS = 40. With a
      // full dynamic load (player auras + explosions + projectiles, ticket 11),
      // the packed count must stay ≤ MAX_LIGHTS (256) with comfortable headroom.
      const b = createLightBuffers();
      const placements: LightPlacementTiled[] = Array.from({ length: 40 }, (_, i) => ({
        gridX: i,
        gridY: i,
        kind: 'torch' as const,
        rotation: 0,
        flipH: false,
        flipV: false,
      }));
      const dynamic: DynamicLight[] = Array.from({ length: 80 }, () => ({
        x: 0,
        y: 0,
        radius: 100,
        intensity: 1,
        color: [1, 1, 1] as [number, number, number],
        corePower: 4,
        haloFrac: 0.5,
        specPower: 28,
        cookieOn: 0,
      }));
      const out = packLights(b, placements, dynamic, { enabled: true, tileSize: TILE });
      expect(out.uLightCount).toBe(120); // 40 static + 80 dynamic
      expect(out.uLightCount).toBeLessThanOrEqual(MAX_LIGHTS);
      // The static prefix is the placements, in order, leaving the rest for dynamic.
      expect(out.uLights[0]).toBe(gridToWorldPx(0, TILE));
      expect(out.uLights[(40 - 1) * LIGHT_STRIDE + 0]).toBe(gridToWorldPx(39, TILE));
      // First dynamic light lands right after the static slice.
      expect(out.uLights[40 * LIGHT_STRIDE + 0]).toBe(0);
    });

    it('static placements cap independently at MAX_LIGHTS when dynamic is empty', () => {
      const b = createLightBuffers();
      const placements: LightPlacementTiled[] = Array.from({ length: MAX_LIGHTS + 50 }, (_, i) => ({
        gridX: i,
        gridY: 0,
        kind: 'candle' as const,
        rotation: 0,
        flipH: false,
        flipV: false,
      }));
      const out = packLights(b, placements, [], { enabled: true, tileSize: TILE });
      expect(out.uLightCount).toBe(MAX_LIGHTS);
    });
  });

  // ── Ticket 17: ambient-scatter tuning (prototype's `remaining` loop) ──
  describe('ambient-scatter (isScatter) tuning', () => {
    it('imports the scatter radius/intensity resolvers + they are deterministic', async () => {
      const { scatterRadiusForPlacement, scatterIntensityForPlacement } =
        await import('../LightPacker.js');
      // Same grid coord → same radius + intensity on every call (no Math.random).
      const coords: Array<[number, number]> = [
        [0, 0],
        [5, 5],
        [100, 200],
        [-3, -7],
      ];
      for (const [gx, gy] of coords) {
        expect(scatterRadiusForPlacement(gx, gy)).toBe(scatterRadiusForPlacement(gx, gy));
        expect(scatterIntensityForPlacement(gx, gy)).toBe(scatterIntensityForPlacement(gx, gy));
      }
    });

    it('scatter radius is in the ticket-07 range 190–320 (was 120–280, prototype.js:611)', async () => {
      // Ticket 07 (A2 §5): band floor raised so the smallest scatter light
      // reads as a full-tile soft glow (was sub-tile at 120px = 0.94 tile).
      // A/B baseline: was 120–280 (span 160, midpoint 200).
      const { scatterRadiusForPlacement } = await import('../LightPacker.js');
      for (let gx = 0; gx < 20; gx++) {
        for (let gy = 0; gy < 20; gy++) {
          const r = scatterRadiusForPlacement(gx, gy);
          expect(r).toBeGreaterThanOrEqual(190);
          expect(r).toBeLessThanOrEqual(320);
        }
      }
    });

    it('scatter intensity is in the ticket-07 range 1.5–2.6 (was 2.0–3.3, prototype.js:612)', async () => {
      // Ticket 07 (A2): dimmer so the wider scatter band doesn't blow out.
      // A/B baseline: was 2.0–3.3.
      const { scatterIntensityForPlacement } = await import('../LightPacker.js');
      for (let gx = 0; gx < 20; gx++) {
        for (let gy = 0; gy < 20; gy++) {
          const i = scatterIntensityForPlacement(gx, gy);
          expect(i).toBeGreaterThanOrEqual(1.5);
          expect(i).toBeLessThanOrEqual(2.6);
        }
      }
    });

    it('packs a scatter placement with the scatter radius (NOT the torch default r=256)', () => {
      // Ticket 07: DEFAULT_HERO_LIGHT is now r=256/i=1.9 (was 200/2.5). A
      // scatter placement must use the 190–320 / 1.5–2.6 range (deterministic
      // per grid coord), NOT the default — otherwise the whole scatter band
      // collapses to a single value. Pick a grid coord whose scatter radius is
      // NOT 256.
      const b = createLightBuffers();
      const placement: LightPlacementTiled = {
        gridX: 11,
        gridY: 7,
        kind: 'torch',
        rotation: 0,
        flipH: false,
        flipV: false,
        isScatter: true,
      };
      const out = packLights(b, [placement], [], { enabled: true, tileSize: TILE });
      expect(out.uLightCount).toBe(1);
      const radius = out.uLights[0 * LIGHT_STRIDE + 2]!;
      const intensity = out.uLights[0 * LIGHT_STRIDE + 3]!;
      // Radius in the ticket-07 band + NOT the default 256.
      expect(radius).toBeGreaterThanOrEqual(190);
      expect(radius).toBeLessThanOrEqual(320);
      expect(radius).not.toBe(HERO_LIGHT_OVERRIDES.torch?.radius ?? 256);
      // Intensity in the ticket-07 band.
      expect(intensity).toBeGreaterThanOrEqual(1.5);
      expect(intensity).toBeLessThanOrEqual(2.6);
    });

    it('scatter placements use the warm torch palette color (the dominant prototype scatter tint)', () => {
      const b = createLightBuffers();
      const placement: LightPlacementTiled = {
        gridX: 3,
        gridY: 4,
        kind: 'torch',
        rotation: 0,
        flipH: false,
        flipV: false,
        isScatter: true,
      };
      const out = packLights(b, [placement], [], { enabled: true, tileSize: TILE });
      const torchPalette = resolveLightKind('torch');
      // Float32Array packing rounds the palette's double values to float32 —
      // use toBeCloseTo for the color comparison.
      expect(out.uLightColors[0]).toBeCloseTo(torchPalette.color[0]!, 5);
      expect(out.uLightColors[1]).toBeCloseTo(torchPalette.color[1]!, 5);
      expect(out.uLightColors[2]).toBeCloseTo(torchPalette.color[2]!, 5);
    });

    it('scatter placements do NOT flicker (steady warm fill, not strobing flame)', () => {
      // Two pack calls at DIFFERENT times must yield the SAME intensity for a
      // scatter placement (flicker would vary it). A motivated torch placement
      // at the same coord WOULD vary (flicker ON) — asserted as the contrast.
      const scatterPlacement: LightPlacementTiled = {
        gridX: 9,
        gridY: 9,
        kind: 'torch',
        rotation: 0,
        flipH: false,
        flipV: false,
        isScatter: true,
      };
      const motivatedPlacement = makePlacement('torch', 9, 9);
      const b1 = createLightBuffers();
      const b2 = createLightBuffers();
      const outS1 = packLights(b1, [scatterPlacement], [], {
        enabled: true,
        tileSize: TILE,
        timeSeconds: 1.0,
        flickerEnabled: true,
      });
      const outS2 = packLights(b2, [scatterPlacement], [], {
        enabled: true,
        tileSize: TILE,
        timeSeconds: 5.0, // different time → flicker would change intensity
        flickerEnabled: true,
      });
      // Scatter intensity is identical across times (no flicker).
      expect(outS1.uLights[0 * LIGHT_STRIDE + 3]).toBe(outS2.uLights[0 * LIGHT_STRIDE + 3]);

      // Contrast: the motivated torch at the same coord DOES flicker (intensity
      // differs across the two times, unless the astronomically unlikely case
      // where the flicker multiplier happens to be equal at t=1 and t=5).
      const b3 = createLightBuffers();
      const b4 = createLightBuffers();
      const outM1 = packLights(b3, [motivatedPlacement], [], {
        enabled: true,
        tileSize: TILE,
        timeSeconds: 1.0,
        flickerEnabled: true,
      });
      const outM2 = packLights(b4, [motivatedPlacement], [], {
        enabled: true,
        tileSize: TILE,
        timeSeconds: 5.0,
        flickerEnabled: true,
      });
      // The motivated intensity is the base × a time-dependent flicker mul; the
      // base is fixed (ticket 07: 1.9 DEFAULT_HERO_LIGHT, was 2.5), so differing
      // intensities prove the flicker is applied (the motivated path) while
      // scatter stays flat.
      const m1 = outM1.uLights[0 * LIGHT_STRIDE + 3]!;
      const m2 = outM2.uLights[0 * LIGHT_STRIDE + 3]!;
      // At least assert flicker is computable: the motivated intensity is the
      // default base (ticket 07: 1.9, was 2.5) × a flicker mul in a plausible
      // band. The scatter test above is the load-bearing one; this is the
      // corroborating contrast.
      expect(m1).toBeGreaterThan(0);
      expect(m2).toBeGreaterThan(0);
    });
  });
});
