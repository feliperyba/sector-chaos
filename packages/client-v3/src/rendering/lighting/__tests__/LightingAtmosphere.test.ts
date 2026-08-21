import { describe, it, expect } from 'vitest';
import {
  EMBER_COLOR,
  EMBER_CORE_COLOR,
  DUST_COLOR,
  EMBER_COUNT,
  DUST_COUNT,
  EMBER_SIZE_MIN,
  EMBER_SIZE_MAX,
  DUST_SIZE_MIN,
  DUST_SIZE_MAX,
  EMBER_RISE_MIN,
  EMBER_RISE_MAX,
  DUST_DRIFT_SPAN,
  EMBER_TWINKLE_BASE,
  EMBER_TWINKLE_AMP,
  EMBER_LIFECYCLE_FORMULA,
  DUST_SHIMMER_BASE,
  DUST_SHIMMER_AMP,
  DUST_SHIMMER_FREQ,
  EMBER_TWINKLE_SPEED_MIN,
  EMBER_TWINKLE_SPEED_MAX,
  ATMOSPHERE_DEPTH,
  atmosphereSeed,
  resolveCampfireAnchors,
  resolveFlameAnchors,
  FLAME_ANCHOR_KINDS,
  EMBER_PARALLAX_BANDS,
  DUST_PARALLAX_BANDS,
  atmosphereParallaxBand,
  scaleAtmosphereCount,
  REFERENCE_VIEWPORT_AREA,
  DUST_FIELD_VIEWPORT_MULTIPLE,
  resolveDustEmitField,
  cameraFollowDustField,
  COUNT_FLOOR_MULTIPLE,
  COUNT_CEILING_MULTIPLE,
  EMBER_POOL_SIZE,
  DUST_POOL_SIZE,
  PARTICLE_TEXTURE_PX,
  particleScaleForSize,
  ATMOSPHERE_EMIT_FREQUENCY_MS,
  EMBER_EMIT_QUANTITY,
  DUST_EMIT_QUANTITY,
  type AtmosphereCameraState,
} from '../LightingAtmosphereConfig.js';
import { DesignTokens } from '../../../ui/DesignTokens.js';
import type { LightPlacementTiled } from '../LightPacker.js';

/**
 * Seam A regression guard for the atmosphere layer (ticket 12). Every value
 * here is verbatim from the validated 06 prototype
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:548-580 + 731-765`).
 * The orchestrator greps for these exact values; the spec's "AAA technique
 * stack" item 9 pins them. DO NOT retune without a recorded HITL verdict —
 * these are the load-bearing values for the WOW look (the final 6.5→7/10 +
 * WOW delta per the wayfinder 05-addendum blind A/B).
 */
describe('LightingAtmosphere — atmosphere constants regression guard (Seam A)', () => {
  describe('EMBER colors (prototype.js:746-748)', () => {
    it('warm body color is exactly 0xffcc66', () => {
      // prototype.js:746 `g.fillStyle(0xffcc66, alpha)` — warmer/brighter.
      expect(EMBER_COLOR).toBe(0xffcc66);
    });

    it('white-hot core color is exactly 0xffffff', () => {
      // prototype.js:748 `g.fillStyle(0xffffff, alpha * 0.85)` — hot white core.
      expect(EMBER_CORE_COLOR).toBe(0xffffff);
    });
  });

  describe('DUST color (prototype.js:760)', () => {
    it('cool color is exactly 0xaaccff', () => {
      // prototype.js:760 `g.fillStyle(0xaaccff, shimmer)`.
      expect(DUST_COLOR).toBe(0xaaccff);
    });
  });

  describe('particle counts', () => {
    it('ember count is 110 (round-5c: pulled back from 160 — 5b overshot)', () => {
      // Prototype 180 → 120 → 5b 160 → 5c 110 (owner: "too much and
      // distracting"). Pool stays 4K-capable via COUNT_CEILING_MULTIPLE.
      expect(EMBER_COUNT).toBe(110);
    });

    it('dust total budget is 190 (round-5c: pulled back from 300, split by on-screen sector area)', () => {
      // Prototype 320 → 240 → 5b 300 → 5c 190 — the per-sector emitters split
      // this budget proportionally to their on-screen area.
      expect(DUST_COUNT).toBe(190);
    });
  });

  describe('EMBER size range (prototype.js:564)', () => {
    it('min size is 1.5 (round-5c: pulled back from 1.6; prototype 1.4)', () => {
      expect(EMBER_SIZE_MIN).toBe(1.5);
    });

    it('max size is 2.6 (round-5c: pulled back from 3.0; prototype 4.0)', () => {
      expect(EMBER_SIZE_MAX).toBe(2.6);
    });
  });

  describe('NEUTRAL dust size range (sector recipes own their bands — themes test)', () => {
    it('min size is 2.0 (round-5d: raised from 1.2 — the far-band visibility floor)', () => {
      // Round-5d: the seeded-map verdict ("barely noticeable / nothing at
      // all") — sub-3px far-band canvas Ø is invisible at gameplay attention.
      // 2.0 × 0.85 × 2 = 3.4px canvas at the far band (themes test pins the
      // ≥ 3px floor for every district + this neutral band).
      expect(DUST_SIZE_MIN).toBe(2.0);
    });

    it('max size is 3.2 (round-5d: raised from 2.2)', () => {
      expect(DUST_SIZE_MAX).toBe(3.2);
    });
  });

  describe('EMBER rise velocity (prototype.js:562)', () => {
    it('min rise is 24 px/s', () => {
      // prototype.js:562 `rise: 24 + aSeed(i*7) * 55` → 24..79 px/s.
      expect(EMBER_RISE_MIN).toBe(24);
    });

    it('max rise is 79 px/s (24 + 55)', () => {
      expect(EMBER_RISE_MAX).toBe(79);
    });
  });

  describe('DUST drift velocity (ticket 21 — raised from 8 to 28)', () => {
    it('drift span is 20 (polish: eased from 28 for a calmer flow with the higher count)', () => {
      // prototype.js:575 was `(aSeed(i*37) - 0.5) * 8` (~±4 px/s). Ticket 21
      // raised it to span 28 (±14 px/s, "alive air"). Polish: eased to 20 (±10
      // px/s) — pairing the count bump with a gentler drift keeps the air alive
      // without the busy feel at the new density.
      expect(DUST_DRIFT_SPAN).toBe(20);
    });
  });

  describe('EMBER twinkle alpha (prototype.js:742)', () => {
    it('base is 0.5 (0.5 + 0.5*sin(...))', () => {
      // prototype.js:742 `const twinkle = 0.5 + 0.5 * Math.sin(...)`.
      expect(EMBER_TWINKLE_BASE).toBe(0.5);
    });

    it('amplitude is 0.5', () => {
      expect(EMBER_TWINKLE_AMP).toBe(0.5);
    });
  });

  describe('EMBER lifecycle fade (prototype.js:743)', () => {
    it('is the sin(life*PI) formula (0→1→0 over the cycle)', () => {
      // prototype.js:743 `const lifeFade = Math.sin(e.life * Math.PI)`.
      expect(EMBER_LIFECYCLE_FORMULA).toBe('sin(life*PI)');
    });
  });

  describe('DUST shimmer alpha', () => {
    it('base is 0.55 (round-5c: pulled back from 0.65 — 5b overshot)', () => {
      // Prototype 0.4 → 0.55 → 5b 0.65 → 5c 0.55 (owner: "too much and
      // distracting"). Sector recipes carry their own bands (themes test).
      expect(DUST_SHIMMER_BASE).toBe(0.55);
    });

    it('amplitude is 0.2 (round-5c: pulled back from 0.25)', () => {
      expect(DUST_SHIMMER_AMP).toBe(0.2);
    });

    it('frequency is 1.0 (polish: eased from 1.5 for a calmer read)', () => {
      expect(DUST_SHIMMER_FREQ).toBe(1.0);
    });

    it('shimmer range is 0.35..0.75 (round-5c: pulled back from 0.40..0.90)', () => {
      // 0.55 ± 0.2 = [0.35, 0.75]. Prototype 0.4 ± 0.25 → [0.15, 0.65].
      expect(DUST_SHIMMER_BASE - DUST_SHIMMER_AMP).toBeCloseTo(0.35, 10);
      expect(DUST_SHIMMER_BASE + DUST_SHIMMER_AMP).toBeCloseTo(0.75, 10);
    });
  });

  describe('EMBER twinkle speed (prototype.js:566)', () => {
    it('min speed is 3 rad/s', () => {
      // prototype.js:566 `twinkleSpeed: 3 + aSeed(i*19) * 6` → 3..9 rad/s.
      expect(EMBER_TWINKLE_SPEED_MIN).toBe(3);
    });

    it('max speed is 9 rad/s (3 + 6)', () => {
      expect(EMBER_TWINKLE_SPEED_MAX).toBe(9);
    });
  });

  describe('ATMOSPHERE_DEPTH (albedo-RT capture proof)', () => {
    it('renders in the UNLIT vfxOverlay band, OUT of the world-light capture (round 5c / ticket-30 mechanism)', () => {
      // Additive particles are light emitters — being multiplied by the light
      // buffer rendered the layer invisible on the nearly-unlit demo map
      // (alive + emitting + sane alpha, zero visible output). Round 5c moves
      // the atmosphere to DesignTokens.depth.vfxOverlay (480, above the
      // gameplay VFX band, below hudBg 500); the emitters ALSO register with
      // excludeFromWorldLightCapture (see LightingAtmosphereEmitters) — the
      // same mechanism ticket 30 established for the beacon motes.
      expect(ATMOSPHERE_DEPTH).toBe(DesignTokens.depth.vfxOverlay);
      expect(ATMOSPHERE_DEPTH).toBeLessThan(DesignTokens.depth.hudBg);
    });
  });
});

describe('atmosphereSeed — deterministic per-i seed (prototype.js:551)', () => {
  it('is deterministic for a fixed i', () => {
    // prototype.js:551 `const aSeed = (i) => ((i * 2654435761) % 2147483648) / 2147483648`.
    expect(atmosphereSeed(0)).toBe(atmosphereSeed(0));
    expect(atmosphereSeed(7)).toBe(atmosphereSeed(7));
  });

  it('returns values in [0, 1)', () => {
    for (let i = 0; i < 100; i++) {
      const s = atmosphereSeed(i);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it('matches the prototype formula exactly for i=1', () => {
    // ((1 * 2654435761) % 2147483648) / 2147483648
    const expected = ((1 * 2654435761) % 2147483648) / 2147483648;
    expect(atmosphereSeed(1)).toBe(expected);
  });
});

describe('resolveFlameAnchors — flame anchor resolution (ticket 21 broadened)', () => {
  /** Build a placement of the given kind at grid (gx, gy). */
  function placement(
    kind: LightPlacementTiled['kind'],
    gx: number,
    gy: number,
  ): LightPlacementTiled {
    return { gridX: gx, gridY: gy, kind, rotation: 0, flipH: false, flipV: false };
  }

  it('resolves campfire placements to world px via gridToWorldPx (grid*tileSize + tileSize/2)', () => {
    // tileSize 64, campfire at grid (10, 20) → world (10*64+32, 20*64+32) = (672, 1312).
    const anchors = resolveFlameAnchors([placement('campfire', 10, 20)], 64);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.x).toBe(10 * 64 + 32);
    expect(anchors[0]!.y).toBe(20 * 64 + 32);
  });

  it('resolveCampfireAnchors is a back-compat alias for resolveFlameAnchors (ticket 21)', () => {
    // The deprecated alias shares the implementation — same input → same output.
    const placements = [placement('torch', 5, 5), placement('campfire', 10, 20)];
    expect(resolveCampfireAnchors(placements, 64)).toEqual(resolveFlameAnchors(placements, 64));
  });

  it('broadens anchors to ALL flame kinds: torch + campfire + candle + fireplace + brazier + lantern (ticket 21 + ticket 11)', () => {
    // Ticket 21: embers are source-motivated from every flame, not just
    // campfires. Torches are the dominant prop kind, so they're the biggest
    // mood lever. Ticket 11 (A8): extended to the 3 new fire kinds ticket 08
    // added (fireplace/brazier/lantern) — every kind with a real fire + flame
    // sprite is an ember source. The test pins the broadened contract.
    const anchors = resolveFlameAnchors(
      [
        placement('torch', 5, 5),
        placement('campfire', 10, 20),
        placement('candle', 15, 25),
        placement('fireplace', 30, 30),
        placement('brazier', 40, 40),
        placement('lantern', 50, 50),
      ],
      64,
    );
    expect(anchors).toHaveLength(6);
    expect(anchors[0]).toEqual({ x: 5 * 64 + 32, y: 5 * 64 + 32 }); // torch
    expect(anchors[1]).toEqual({ x: 10 * 64 + 32, y: 20 * 64 + 32 }); // campfire
    expect(anchors[2]).toEqual({ x: 15 * 64 + 32, y: 25 * 64 + 32 }); // candle
    expect(anchors[3]).toEqual({ x: 30 * 64 + 32, y: 30 * 64 + 32 }); // fireplace
    expect(anchors[4]).toEqual({ x: 40 * 64 + 32, y: 40 * 64 + 32 }); // brazier
    expect(anchors[5]).toEqual({ x: 50 * 64 + 32, y: 50 * 64 + 32 }); // lantern
  });

  it('excludes biome-glow (cool steady magical glow — NOT a flame; research §5)', () => {
    // biome-glow palette color [0.4, 0.68, 1.0] is cool blue + steady (no
    // flicker). Embers from a magical glow would read wrong — it's ambient
    // mood, not a physical flame source. See FLAME_ANCHOR_KINDS docstring.
    const anchors = resolveFlameAnchors(
      [placement('biome-glow', 1, 1), placement('torch', 2, 2)],
      64,
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({ x: 2 * 64 + 32, y: 2 * 64 + 32 }); // only the torch
  });

  it('excludes barrel-fire from STATIC placements (it arrives via the dynamic feed)', () => {
    // Barrels are inert until explosion (ticket 18); the barrel-fire light
    // exists only during/after explosion, which reaches the embers via the
    // keptDynamic fire-color filter in LightingPipelineAtmosphere, NOT via
    // static placements. Keep the static filter clean.
    const anchors = resolveFlameAnchors(
      [placement('barrel-fire', 1, 1), placement('campfire', 2, 2)],
      64,
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({ x: 2 * 64 + 32, y: 2 * 64 + 32 }); // only the campfire
  });

  it('caps the anchor count (so 64-player explosion spam does not balloon the budget)', () => {
    // Many campfires + many dynamic fires — capped at maxAnchors (default 8).
    const placements: LightPlacementTiled[] = [];
    for (let i = 0; i < 20; i++) placements.push(placement('campfire', i, i));
    const dynamicFires = Array.from({ length: 20 }, (_, i) => ({ x: i * 100, y: i * 100 }));
    const anchors = resolveFlameAnchors(placements, 64, dynamicFires);
    expect(anchors.length).toBeLessThanOrEqual(8);
  });

  it('folds in dynamic fire positions (barrel-fire/explosions/fire-traps) as transient anchors', () => {
    const anchors = resolveFlameAnchors([], 64, [
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ]);
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toEqual({ x: 100, y: 200 });
    expect(anchors[1]).toEqual({ x: 300, y: 400 });
  });

  it('returns empty when no flame placements and no dynamic fires', () => {
    expect(resolveFlameAnchors([], 64)).toEqual([]);
    // A biome-glow-only map produces no flame anchors (biome-glow is NOT flame).
    expect(resolveFlameAnchors([placement('biome-glow', 1, 1)], 64)).toEqual([]);
  });

  it('respects a custom maxAnchors cap', () => {
    const placements: LightPlacementTiled[] = [];
    for (let i = 0; i < 10; i++) placements.push(placement('campfire', i, i));
    expect(resolveFlameAnchors(placements, 64, undefined, undefined, 3)).toHaveLength(3);
  });

  // ── Ticket 31 (round 5): camera-aware nearest-anchor selection ────────────
  // The legacy first-N-by-generation-order slice measured as always-the-top-
  // band campfires on every seed (generation scan order is spatially
  // arbitrary) — all 120 embers rose in one map corner. With a camera, the
  // static slice must be the NEAREST flame placements.

  it('ticket 31: with a camera, selects the NEAREST flame placements (not generation order)', () => {
    // Two far campfires first in generation order, one near torch last.
    const placements: LightPlacementTiled[] = [
      placement('campfire', 50, 50),
      placement('campfire', 60, 60),
      placement('torch', 2, 2),
    ];
    // Camera at tile (0,0) center = (32, 32) px. maxAnchors 1 → the near torch.
    const anchors = resolveFlameAnchors(placements, 64, undefined, { x: 32, y: 32 }, 1);
    expect(anchors).toEqual([{ x: 2 * 64 + 32, y: 2 * 64 + 32 }]);
  });

  it('ticket 31: nearest selection is deterministic — equal distances resolve to the earlier placement', () => {
    // Both campfires equidistant from the camera; the lower placement index
    // (generation order) must win so the selection is stable per seed.
    const placements: LightPlacementTiled[] = [
      placement('campfire', 4, 4),
      placement('campfire', 0, 0),
    ];
    const camera = { x: 2 * 64 + 32, y: 2 * 64 + 32 }; // equidistant to both centers
    const anchors = resolveFlameAnchors(placements, 64, undefined, camera, 1);
    expect(anchors).toEqual([{ x: 4 * 64 + 32, y: 4 * 64 + 32 }]); // first placement wins
  });

  it('ticket 31: without a camera, keeps the legacy first-N generation order (back-compat)', () => {
    const placements: LightPlacementTiled[] = [
      placement('campfire', 50, 50),
      placement('campfire', 60, 60),
      placement('torch', 2, 2),
    ];
    const anchors = resolveFlameAnchors(placements, 64, undefined, undefined, 2);
    expect(anchors).toEqual([
      { x: 50 * 64 + 32, y: 50 * 64 + 32 },
      { x: 60 * 64 + 32, y: 60 * 64 + 32 },
    ]);
  });

  it('ticket 31: dynamic fires fold in AFTER the nearest static slice (near-action anchors)', () => {
    const placements: LightPlacementTiled[] = [placement('campfire', 50, 50)];
    const anchors = resolveFlameAnchors(placements, 64, [{ x: 10, y: 10 }], { x: 0, y: 0 }, 2);
    expect(anchors).toEqual([
      { x: 50 * 64 + 32, y: 50 * 64 + 32 },
      { x: 10, y: 10 },
    ]);
  });

  it('FLAME_ANCHOR_KINDS pins exactly all 6 flame kinds (ticket 21 + ticket 11/A8 + ticket 08)', () => {
    // The discriminator is the load-bearing decision — pin it so a future
    // change can't quietly narrow it back to campfire-only or accidentally
    // include biome-glow. Ticket 11 (A8) extended the set from {torch, campfire,
    // candle} to all 6 flame kinds (added fireplace/brazier/lantern from
    // ticket 08). This now mirrors the shared `FlameKind` union
    // (packages/shared/src/map/tiledTypes.ts) — every kind with a real fire +
    // flame sprite is an ember source.
    expect([...FLAME_ANCHOR_KINDS].sort()).toEqual([
      'brazier',
      'campfire',
      'candle',
      'fireplace',
      'lantern',
      'torch',
    ]);
  });
});

// ─── Ticket 21: parallax depth + viewport-scaled counts (Seam A) ──────────────
//
// Pure-logic regression guards for the additions that make the atmosphere read
// as volumetric depth instead of a flat sheet (research §5 "depth via parallax
// size/speed") + keep coverage consistent across resolutions (diagnosis §5
// "fixed count regardless of viewport size"). All deterministic so the same
// input always yields the same band assignment / count.
describe('atmosphereParallaxBand — deterministic per-particle band (ticket 21)', () => {
  it('returns a valid band index in [0, bandCount)', () => {
    for (let i = 0; i < 100; i++) {
      const b = atmosphereParallaxBand(i, EMBER_PARALLAX_BANDS.length);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(EMBER_PARALLAX_BANDS.length);
    }
  });

  it('is deterministic (same i → same band) — the Seam A determinism contract', () => {
    for (let i = 0; i < 50; i++) {
      expect(atmosphereParallaxBand(i, 2)).toBe(atmosphereParallaxBand(i, 2));
    }
    // Cross-check two calls at representative indices produce identical results
    // across separate invocations (no hidden mutable state).
    const firstRun = Array.from({ length: 20 }, (_, i) => atmosphereParallaxBand(i, 2));
    const secondRun = Array.from({ length: 20 }, (_, i) => atmosphereParallaxBand(i, 2));
    expect(secondRun).toEqual(firstRun);
  });

  it('returns 0 when bandCount <= 1 (degenerate — single band)', () => {
    expect(atmosphereParallaxBand(0, 0)).toBe(0);
    expect(atmosphereParallaxBand(7, 1)).toBe(0);
  });

  it('distributes particles across BOTH bands (near + far) over many particles', () => {
    // The depth cue only works if both bands are populated — if all particles
    // landed in one band the layer would read flat again. Over 180 particles
    // both bands must be non-empty.
    const counts = [0, 0];
    for (let i = 0; i < EMBER_COUNT; i++) {
      counts[atmosphereParallaxBand(i, 2)]!++;
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
  });

  it('is decoupled from atmosphereSeed (band assignment != phase/size hash)', () => {
    // If band assignment correlated with phase, all near-band particles would
    // share a twinkle phase. Verify the two hashes produce different orderings.
    let collisions = 0;
    for (let i = 0; i < 100; i++) {
      const band = atmosphereParallaxBand(i, 2);
      const seedBucket = Math.floor(atmosphereSeed(i) * 2);
      if (band === seedBucket) collisions++;
    }
    // Some overlap is expected by chance (~50%), but not 100% — that would mean
    // the hashes are correlated.
    expect(collisions).toBeLessThan(100);
  });
});

describe('parallax band design — near is bigger+faster, far is smaller+slower', () => {
  it('EMBER_PARALLAX_BANDS has at least 2 bands (the ticket minimum for depth)', () => {
    expect(EMBER_PARALLAX_BANDS.length).toBeGreaterThanOrEqual(2);
  });

  it('DUST_PARALLAX_BANDS has at least 2 bands', () => {
    expect(DUST_PARALLAX_BANDS.length).toBeGreaterThanOrEqual(2);
  });

  it('the near band (index 0) has sizeMul > 1 AND speedMul > 1 for both layers', () => {
    // Near = bigger + faster (closer to camera). research §5.
    const emberNear = EMBER_PARALLAX_BANDS[0]!;
    const dustNear = DUST_PARALLAX_BANDS[0]!;
    expect(emberNear.sizeMul).toBeGreaterThan(1);
    expect(emberNear.speedMul).toBeGreaterThan(1);
    expect(dustNear.sizeMul).toBeGreaterThan(1);
    expect(dustNear.speedMul).toBeGreaterThan(1);
  });

  it('the far band (last index) has sizeMul < 1 AND speedMul < 1 for both layers', () => {
    // Far = smaller + slower (recedes). The size/speed split is what reads as
    // volumetric depth (research §5).
    const emberFar = EMBER_PARALLAX_BANDS[EMBER_PARALLAX_BANDS.length - 1]!;
    const dustFar = DUST_PARALLAX_BANDS[DUST_PARALLAX_BANDS.length - 1]!;
    expect(emberFar.sizeMul).toBeLessThan(1);
    expect(emberFar.speedMul).toBeLessThan(1);
    expect(dustFar.sizeMul).toBeLessThan(1);
    expect(dustFar.speedMul).toBeLessThan(1);
  });

  it('band weights sum to 1 (a valid distribution)', () => {
    const emberSum = EMBER_PARALLAX_BANDS.reduce((s, b) => s + b.weight, 0);
    const dustSum = DUST_PARALLAX_BANDS.reduce((s, b) => s + b.weight, 0);
    expect(emberSum).toBeCloseTo(1, 6);
    expect(dustSum).toBeCloseTo(1, 6);
  });
});

describe('scaleAtmosphereCount — viewport-area density scaling (ticket 21)', () => {
  it('returns the baseline at the 1080p reference area (1920×1080)', () => {
    expect(scaleAtmosphereCount(EMBER_COUNT, REFERENCE_VIEWPORT_AREA)).toBe(EMBER_COUNT);
    expect(scaleAtmosphereCount(DUST_COUNT, REFERENCE_VIEWPORT_AREA)).toBe(DUST_COUNT);
  });

  it('scales UP for larger viewports (4K — was sparse at fixed count)', () => {
    // 4K viewport ≈ 4× the reference area → clamped to 2.5× (the cap).
    const count = scaleAtmosphereCount(DUST_COUNT, 3840 * 2160);
    expect(count).toBeGreaterThan(DUST_COUNT);
    expect(count).toBe(Math.round(DUST_COUNT * 2.5)); // capped
  });

  it('scales DOWN for smaller viewports (zoomed-in — was a cloud at fixed count)', () => {
    // Half reference area → half the count (above the 0.5× floor).
    const count = scaleAtmosphereCount(DUST_COUNT, REFERENCE_VIEWPORT_AREA * 0.5);
    expect(count).toBe(Math.round(DUST_COUNT * 0.5));
  });

  it('clamps to the 0.5× floor for tiny viewports', () => {
    const count = scaleAtmosphereCount(EMBER_COUNT, REFERENCE_VIEWPORT_AREA * 0.1);
    expect(count).toBe(Math.round(EMBER_COUNT * 0.5));
  });

  it('clamps to the 2.5× ceiling for huge viewports (keeps draw budget sane)', () => {
    const count = scaleAtmosphereCount(EMBER_COUNT, REFERENCE_VIEWPORT_AREA * 10);
    expect(count).toBe(Math.round(EMBER_COUNT * 2.5));
  });

  it('returns the baseline for non-finite / non-positive area (defensive)', () => {
    expect(scaleAtmosphereCount(EMBER_COUNT, 0)).toBe(EMBER_COUNT);
    expect(scaleAtmosphereCount(EMBER_COUNT, Number.NaN)).toBe(EMBER_COUNT);
    expect(scaleAtmosphereCount(EMBER_COUNT, -100)).toBe(EMBER_COUNT);
  });

  it('is deterministic (same area → same count)', () => {
    expect(scaleAtmosphereCount(DUST_COUNT, 2000000)).toBe(
      scaleAtmosphereCount(DUST_COUNT, 2000000),
    );
  });
});

describe('DUST_FIELD_VIEWPORT_MULTIPLE — camera-follow field (ticket 21; ticket 31 restores it as THE field)', () => {
  it('is >= 1.5 so the wrap-at-bounds happens off-screen (no pop at view edge)', () => {
    // Ticket 31: this multiple defines THE dust field (the camera-follow rect
    // at multiple × viewport). Pin the lower bound so the wrap never pops at
    // the view edge — see DUST_FIELD_VIEWPORT_MULTIPLE's docstring for why the
    // A8 world-rect was reverted (≈13× on-screen density collapse).
    expect(DUST_FIELD_VIEWPORT_MULTIPLE).toBeGreaterThanOrEqual(1.5);
  });
});

describe('particle pool sizing — pool ceiling accommodates the largest viewport (ticket 21)', () => {
  it('COUNT_FLOOR_MULTIPLE is 0.5 and COUNT_CEILING_MULTIPLE is 2.5 (the scale clamp)', () => {
    // Pin the clamp range so the pool sizing math stays consistent with
    // scaleAtmosphereCount's clamp.
    expect(COUNT_FLOOR_MULTIPLE).toBe(0.5);
    expect(COUNT_CEILING_MULTIPLE).toBe(2.5);
  });

  it('EMBER_POOL_SIZE = EMBER_COUNT × ceiling (so a 4K viewport can actually reach its target)', () => {
    // Phaser can't spawn more alive particles than the pool holds. The pool is
    // pre-allocated at baseline × ceiling so maxAliveParticles scaling up to the
    // 4K ceiling (2.5×) is achievable, not silently capped.
    expect(EMBER_POOL_SIZE).toBe(Math.round(EMBER_COUNT * COUNT_CEILING_MULTIPLE));
    expect(EMBER_POOL_SIZE).toBeGreaterThanOrEqual(EMBER_COUNT); // pool >= baseline always
  });

  it('DUST_POOL_SIZE = DUST_COUNT × ceiling', () => {
    expect(DUST_POOL_SIZE).toBe(Math.round(DUST_COUNT * COUNT_CEILING_MULTIPLE));
    expect(DUST_POOL_SIZE).toBeGreaterThanOrEqual(DUST_COUNT);
  });

  it('the pool is never smaller than the largest scaled count (the invariant)', () => {
    // For any viewport, scaleAtmosphereCount returns <= base × ceiling = pool.
    // Verify across a range of viewport areas including the 4K extreme.
    for (const area of [
      REFERENCE_VIEWPORT_AREA * 0.1,
      REFERENCE_VIEWPORT_AREA,
      REFERENCE_VIEWPORT_AREA * 4,
      REFERENCE_VIEWPORT_AREA * 100,
    ]) {
      expect(scaleAtmosphereCount(DUST_COUNT, area)).toBeLessThanOrEqual(DUST_POOL_SIZE);
      expect(scaleAtmosphereCount(EMBER_COUNT, area)).toBeLessThanOrEqual(EMBER_POOL_SIZE);
    }
  });
});

// ─── Ticket 11 (A8) — world-wide dust + sub-pixel fix + all-flame-kinds anchors ─
//
// Three regressions ticket 11 (A8) caught by reading the actual emit-field code
// (not the commit title):
//  (a) ticket 21's "world-wide dust" title was a misnomer — it landed a 2×
//      viewport CAMERA-FOLLOWING field. The dust emit field must be the WORLD-
//      BOUNDS rect (prototype.js:571-580 world-wide spread).
//  (b) the emitter scale `size/16` treated the prototype's `size` (a fillCircle
//      RADIUS) as a DIAMETER → ~2× too small → the far parallax band (60%
//      weight) dropped to 0.6px dust / 0.98px embers (sub-pixel, dropped by
//      the rasterizer) → ~60% of dust invisible. The fix reproduces the
//      prototype's pixel-diameter (`2 × size`).
//  (c) FLAME_ANCHOR_KINDS missed the 3 new fire kinds ticket 08 added
//      (fireplace/brazier/lantern). Embers must rise from every flame source.
// All pure → unit-testable without booting Phaser.

describe('resolveDustEmitField — camera-following dust field (ticket 31; reverts the A8 world-rect)', () => {
  /** Build a camera-state with a 1920×1080 view at the given scroll. */
  function cam(
    scrollX = 0,
    scrollY = 0,
    viewWidth = 1920,
    viewHeight = 1080,
  ): AtmosphereCameraState {
    return { scrollX, scrollY, viewWidth, viewHeight };
  }

  it('ticket 31: returns the camera-following rect (2× viewport, centered on the view)', () => {
    // The load-bearing re-pin: the A8 world-rect experiment (full 104.9M px²
    // field with a viewport-scaled count) collapsed on-screen density to
    // ≈4.7 motes @1080p — the owner's "mood particles are totally gone". The
    // camera-follow rect restores ≈60 in-view motes; zoom coverage comes from
    // scaleAtmosphereCount (viewArea scaling), NOT from inflating the field.
    const field = resolveDustEmitField(cam(100, 200));
    expect(field.w).toBe(1920 * DUST_FIELD_VIEWPORT_MULTIPLE);
    expect(field.h).toBe(1080 * DUST_FIELD_VIEWPORT_MULTIPLE);
    expect(field.x).toBe(100 + 1920 * 0.5 - field.w * 0.5);
    expect(field.y).toBe(200 + 1080 * 0.5 - field.h * 0.5);
  });

  it('tracks the camera as it pans (the field follows the view — constant on-screen density)', () => {
    const f1 = resolveDustEmitField(cam(0, 0));
    const f2 = resolveDustEmitField(cam(2000, 1500));
    expect(f2.x - f1.x).toBe(2000);
    expect(f2.y - f1.y).toBe(1500);
    expect(f2.w).toBe(f1.w);
    expect(f2.h).toBe(f1.h);
  });

  it('scales the field with the view at deep zoom (zoomed-out views still get their own field)', () => {
    // A zoomed-out 3840×2160 view: the field is 2× THAT view, and the live
    // count scales up with viewArea (scaleAtmosphereCount) — per-screen-area
    // density stays constant at any zoom, the property the world-rect broke.
    const field = resolveDustEmitField(cam(0, 0, 3840, 2160));
    expect(field.w).toBe(3840 * DUST_FIELD_VIEWPORT_MULTIPLE);
    expect(field.h).toBe(2160 * DUST_FIELD_VIEWPORT_MULTIPLE);
  });

  it('cameraFollowDustField is the field shape (named for clarity)', () => {
    expect(cameraFollowDustField(cam(100, 200))).toEqual(resolveDustEmitField(cam(100, 200)));
  });

  it('is deterministic (same camera state → same field)', () => {
    const c = cam(123, 456);
    expect(resolveDustEmitField(c)).toEqual(resolveDustEmitField(c));
  });
});

describe('particleScaleForSize — radius→diameter sub-pixel fix (ticket 11/A8 §4.3)', () => {
  it('PARTICLE_TEXTURE_PX is 16 (the generated white-circle texture edge)', () => {
    // Pin the texture size — the scale formula divides by this. The texture is
    // generated at 16×16 in ensureAtmosphereParticleTexture.
    expect(PARTICLE_TEXTURE_PX).toBe(16);
  });

  it('returns size*2/16 so the rendered pixel-diameter = 2*size (prototype fillCircle radius)', () => {
    // The prototype's fillCircle(x, y, size) drew RADIUS size → DIAMETER 2*size.
    // Phaser renders a particle at scale s as a sprite of diameter 16*s. To
    // reproduce the prototype's 2*size diameter: 16*scale = 2*size → scale =
    // 2*size/16. Verify the formula.
    for (const size of [0.5, 1.0, 1.4, 2.0, 3.0, 4.0]) {
      expect(particleScaleForSize(size)).toBeCloseTo((size * 2) / 16, 10);
    }
  });

  it('the rendered pixel-diameter is 2×size (matches the prototype, NOT size)', () => {
    // The load-bearing assertion: at scale=particleScaleForSize(size), Phaser
    // renders a sprite of pixel-diameter PARTICLE_TEXTURE_PX × scale = 2*size.
    // This is the prototype's diameter. The prior `size/16` form rendered
    // diameter=size (2× too small).
    for (const size of [0.6, 1.0, 1.4, 3.0]) {
      const renderedDiameter = PARTICLE_TEXTURE_PX * particleScaleForSize(size);
      expect(renderedDiameter).toBeCloseTo(2 * size, 10);
      // And it is NOT the buggy `size` (the prior diameter).
      expect(renderedDiameter).not.toBeCloseTo(size, 10);
    }
  });

  it('the DUST far-band worst case is comfortably visible (round-5d floor: canvas Ø >= 3px)', () => {
    // Far-band sizeMul 0.85; round-5d: DUST_SIZE_MIN 2.0.
    // Worst case: 2.0 × 0.85 = 1.7 → rendered diameter 2 × 1.7 = 3.4px.
    const dustFarWorstCaseSize = DUST_SIZE_MIN * DUST_PARALLAX_BANDS[1]!.sizeMul; // 2.0 * 0.85 = 1.7
    const renderedDiameter = PARTICLE_TEXTURE_PX * particleScaleForSize(dustFarWorstCaseSize);
    expect(dustFarWorstCaseSize).toBeCloseTo(1.7, 10); // the input size (radius)
    expect(renderedDiameter).toBeCloseTo(3.4, 10); // the rendered diameter
    expect(renderedDiameter).toBeGreaterThanOrEqual(3.0); // the 5d far-band floor
  });

  it('the EMBER far-band worst case is visibly above 1px post-fix (was 0.98px borderline)', () => {
    // A8 §4.3 era: EMBER_SIZE_MIN (1.4) × far-band 0.7 = 0.98 → 1.96px post-fix.
    // Round-5c: EMBER_SIZE_MIN 1.5 × 0.7 = 1.05 → 2.1px (clearly visible).
    const emberFarWorstCaseSize = EMBER_SIZE_MIN * EMBER_PARALLAX_BANDS[1]!.sizeMul; // 1.5 * 0.7 = 1.05
    const renderedDiameter = PARTICLE_TEXTURE_PX * particleScaleForSize(emberFarWorstCaseSize);
    expect(emberFarWorstCaseSize).toBeCloseTo(1.05, 10);
    expect(renderedDiameter).toBeCloseTo(2.1, 10);
    expect(renderedDiameter).toBeGreaterThan(1.0);
  });

  it('the far-band is no longer the sub-pixel band — every band renders above 1px at size-min', () => {
    // Sweep every band for both layers at the SIZE_MIN extreme. Post-fix, NO
    // band drops below 1px at the minimum size (the prior bug made the far
    // band 0.6px / 0.98px). This is the "no sub-pixel far band" regression guard.
    for (const band of DUST_PARALLAX_BANDS) {
      const size = DUST_SIZE_MIN * band.sizeMul;
      const rendered = PARTICLE_TEXTURE_PX * particleScaleForSize(size);
      expect(rendered).toBeGreaterThan(1.0);
    }
    for (const band of EMBER_PARALLAX_BANDS) {
      const size = EMBER_SIZE_MIN * band.sizeMul;
      const rendered = PARTICLE_TEXTURE_PX * particleScaleForSize(size);
      expect(rendered).toBeGreaterThan(1.0);
    }
  });

  it('is pure / deterministic (same size → same scale)', () => {
    expect(particleScaleForSize(2.5)).toBe(particleScaleForSize(2.5));
  });
});

describe('FLAME_ANCHOR_KINDS — all 6 flame kinds are ember sources (ticket 11/A8 + ticket 08)', () => {
  /** Build a placement of the given kind at grid (gx, gy). */
  function placement(
    kind: LightPlacementTiled['kind'],
    gx: number,
    gy: number,
  ): LightPlacementTiled {
    return { gridX: gx, gridY: gy, kind, rotation: 0, flipH: false, flipV: false };
  }

  it('every ticket-08 fire kind resolves to an ember anchor (fireplace + brazier + lantern)', () => {
    // Ticket 08 added fireplace/brazier/lantern (each with a real fire + flame
    // sprite). Ticket 11 (A8) broadened FLAME_ANCHOR_KINDS so embers rise from
    // every one of them — not just torch/campfire/candle. The dev-map "embers
    // cluster at screen center" symptom (A5 coupling) recovers in a real seeded
    // match once these kinds are placed (ticket 10).
    for (const kind of ['fireplace', 'brazier', 'lantern'] as const) {
      const anchors = resolveFlameAnchors([placement(kind, 7, 7)], 64);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toEqual({ x: 7 * 64 + 32, y: 7 * 64 + 32 });
    }
  });

  it('a mixed map with all 6 flame kinds resolves all 6 as anchors', () => {
    const anchors = resolveFlameAnchors(
      [
        placement('torch', 1, 1),
        placement('campfire', 2, 2),
        placement('candle', 3, 3),
        placement('fireplace', 4, 4),
        placement('brazier', 5, 5),
        placement('lantern', 6, 6),
      ],
      64,
    );
    expect(anchors).toHaveLength(6);
    // Order preserved (the resolution is order-stable).
    expect(anchors.map((a) => a.x)).toEqual([
      1 * 64 + 32,
      2 * 64 + 32,
      3 * 64 + 32,
      4 * 64 + 32,
      5 * 64 + 32,
      6 * 64 + 32,
    ]);
  });

  it('still excludes biome-glow + barrel-fire from STATIC placements', () => {
    // The ticket-21 exclusions carry forward: biome-glow (cool magical glow, no
    // flame) + barrel-fire (inert until explosion; arrives via the dynamic
    // feed). A map with only these must produce ZERO static flame anchors.
    expect(
      resolveFlameAnchors([placement('biome-glow', 1, 1), placement('barrel-fire', 2, 2)], 64),
    ).toEqual([]);
  });
});

// ─── Ticket C3 — fill-rate fix (particles-per-cycle to reach target promptly) ──
//
// The prior A8 fix (commit 2af222b) correctly made dust world-wide + fixed the
// sub-pixel scale bug, but MISSED the fill-rate bug: `quantity` was unset on
// both emitters → Phaser default 1 → 1 particle / 40ms = 25/sec → the 180/320
// targets were NEVER reached (steady-state ~60-90% of target, ~10s cold-start).
// The fix sizes `quantity` so spawn-rate × lifespan ≈ target count.
//
// These are pure-logic Seam A guards over the exported config constants (no
// Phaser boot). The live-frame "particles visible" check is the load-bearing
// Seam C browser verification (flagged for the orchestrator's independent
// before/after screenshot + vision analysis).
describe('EMBER/DUST_EMIT_QUANTITY — fill-rate fix (ticket C3)', () => {
  it('EMBER_EMIT_QUANTITY is set (>= 1) so the spawn rate reaches the 110 target', () => {
    expect(EMBER_EMIT_QUANTITY).toBeGreaterThanOrEqual(1);
  });

  it('DUST_EMIT_QUANTITY is set (>= 1) so the spawn rate reaches the 190 target', () => {
    expect(DUST_EMIT_QUANTITY).toBeGreaterThanOrEqual(1);
  });

  it('EMBER_EMIT_QUANTITY matches the fill-rate formula (ceil(110 / (3500/40)) = 2)', () => {
    // quantity = ceil(targetCount / (avgLifespanMs / frequencyMs))
    //   ember lifespan 2500..4500 → avg 3500; frequency 40 → 3500/40 = 87.5 cycles
    //   ceil(110 / 87.5) = ceil(1.26) = 2.
    const emberAvgLifespan = 3500;
    const expected = Math.ceil(EMBER_COUNT / (emberAvgLifespan / ATMOSPHERE_EMIT_FREQUENCY_MS));
    expect(EMBER_EMIT_QUANTITY).toBe(expected);
    expect(EMBER_EMIT_QUANTITY).toBe(2);
  });

  it('DUST_EMIT_QUANTITY matches the fill-rate formula (ceil(190 / (10000/40)) = 1)', () => {
    //   dust lifespan 8000..12000 → avg 10000; frequency 40 → 10000/40 = 250 cycles
    //   ceil(190 / 250) = ceil(0.76) = 1 (round 5c re-derivation).
    const dustAvgLifespan = 10000;
    const expected = Math.ceil(DUST_COUNT / (dustAvgLifespan / ATMOSPHERE_EMIT_FREQUENCY_MS));
    expect(DUST_EMIT_QUANTITY).toBe(expected);
    expect(DUST_EMIT_QUANTITY).toBe(1);
  });

  it('ATMOSPHERE_EMIT_FREQUENCY_MS is 40 (the flow cadence both emitters use)', () => {
    // Pin the cadence — the quantity math + the steady-state estimates divide by it.
    expect(ATMOSPHERE_EMIT_FREQUENCY_MS).toBe(40);
  });
});

describe('ticket C3 — steady-state alive stays under the pool ceiling', () => {
  it('ember steady-state (quantity × lifespan/frequency) does not exceed EMBER_POOL_SIZE', () => {
    // Steady-state alive ≈ quantity × (avgLifespan / frequency). Worst-case
    // (longest lifespan) is the upper bound the pool must absorb.
    const maxLifespan = 4500;
    const steadyStateMax = EMBER_EMIT_QUANTITY * (maxLifespan / ATMOSPHERE_EMIT_FREQUENCY_MS);
    // The pool (450) must accommodate the worst-case alive count. There is headroom.
    expect(steadyStateMax).toBeLessThanOrEqual(EMBER_POOL_SIZE);
    // And the target (180) is reachable (steady-state at avg lifespan > target).
    const steadyStateAvg = EMBER_EMIT_QUANTITY * (3500 / ATMOSPHERE_EMIT_FREQUENCY_MS);
    expect(steadyStateAvg).toBeGreaterThanOrEqual(EMBER_COUNT);
  });

  it('dust steady-state (quantity × lifespan/frequency) does not exceed DUST_POOL_SIZE', () => {
    const maxLifespan = 12000;
    const steadyStateMax = DUST_EMIT_QUANTITY * (maxLifespan / ATMOSPHERE_EMIT_FREQUENCY_MS);
    // 2 × (12000/40) = 600 < 800 (DUST_POOL_SIZE). Headroom for the runtime
    // maxAliveParticles scaling + the deathZone recycling.
    expect(steadyStateMax).toBeLessThanOrEqual(DUST_POOL_SIZE);
    const steadyStateAvg = DUST_EMIT_QUANTITY * (10000 / ATMOSPHERE_EMIT_FREQUENCY_MS);
    expect(steadyStateAvg).toBeGreaterThanOrEqual(DUST_COUNT);
  });
});

describe('ticket C3 — determinism preserved (no Math.random in the fill-rate path)', () => {
  it('the atmosphere config + emitter modules introduce NO Math.random (seedIdx round-robin stays deterministic)', () => {
    // The fill-rate fix raises `quantity` (N particles per cycle instead of 1).
    // Phaser calls the emitCallback N times per cycle; each call advances
    // nextSeedIdx by the SAME round-robin `(+1) % POOL_SIZE` as before — so the
    // seedIdx assignment sequence is still a pure function of emit count (no
    // randomness). This grep is the deterministic-source guard: neither the
    // Phaser-free config nor the emitter builders may call Math.random / random().
    // (Mirrors the no-Math.random contract the live code already satisfies.)
    const fs = require('node:fs') as typeof import('fs');
    const path = require('node:path') as typeof import('path');
    const cfgSrc = fs.readFileSync(
      path.join(__dirname, '..', 'LightingAtmosphereConfig.ts'),
      'utf8',
    );
    const emitSrc = fs.readFileSync(
      path.join(__dirname, '..', 'LightingAtmosphereEmitters.ts'),
      'utf8',
    );
    expect(cfgSrc).not.toMatch(/Math\.random|\brandom\(\)/);
    expect(emitSrc).not.toMatch(/Math\.random|\brandom\(\)/);
  });

  it('EMBER_EMIT_QUANTITY + DUST_EMIT_QUANTITY are stable integers (the seedIdx stride is constant)', () => {
    // A fractional or NaN quantity would make the per-cycle emit count
    // non-deterministic. Pin them as safe positive integers.
    expect(Number.isInteger(EMBER_EMIT_QUANTITY)).toBe(true);
    expect(Number.isInteger(DUST_EMIT_QUANTITY)).toBe(true);
    expect(EMBER_EMIT_QUANTITY).toBeGreaterThan(0);
    expect(DUST_EMIT_QUANTITY).toBeGreaterThan(0);
  });
});
