/**
 * LightingAtmosphereConfig — pure-logic atmosphere constants + helpers (ticket 12).
 *
 * This module is Phaser-free so the Seam A vitest regression guard can import
 * the canonical values + `atmosphereSeed` + `resolveFlameAnchors` WITHOUT
 * booting Phaser (which needs a canvas — unavailable under jsdom). The Phaser-
 * dependent `LightingAtmosphere` class re-exports everything here for the
 * orchestrator's grep + single-source-of-truth imports.
 *
 * Every value is verbatim from the validated 06 prototype
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:548-580 + 731-765`).
 * When the spec and the prototype disagree, the prototype's wired values win
 * (spec §"Further Notes"). DO NOT retune without a recorded HITL verdict —
 * these are the load-bearing values for the WOW look.
 *
 * ── Ticket 21 (atmosphere polish) ──
 *
 * The headline regressions from `01-diagnosis.md` §5 are addressed HERE, all as
 * pure values/functions so the Seam A test asserts them deterministically:
 * source-motivated embers (`FLAME_ANCHOR_KINDS`), parallax depth
 * (`EMBER/DUST_PARALLAX_BANDS`), viewport-scaled counts (`scaleAtmosphereCount`),
 * livelier air (`DUST_DRIFT_SPAN`). Each is re-documented at its own symbol.
 */
import { DesignTokens } from '../../ui/DesignTokens.js';
import { type LightKind } from './LightPalette.js';
import { gridToWorldPx, type LightPlacementTiled } from './LightPacker.js';

// ─── Canonical atmosphere tuning (verbatim from prototype.js:548-580, 731-765) ───

/** Warm ember body color (prototype.js:746 `g.fillStyle(0xffcc66, alpha)`). */
export const EMBER_COLOR = 0xffcc66;
/** White-hot ember core color (prototype.js:748 `g.fillStyle(0xffffff, alpha*0.85)`). */
export const EMBER_CORE_COLOR = 0xffffff;
/** Cool dust-mote color (prototype.js:760 `g.fillStyle(0xaaccff, shimmer)`). */
export const DUST_COLOR = 0xaaccff;

/**
 * Total ember particle count — the 1080p/zoom-1 BASELINE. Round-5c: 160 → 110
 * (owner verdict: 5b was "too much and distracting"). The runtime count is
 * scaled by {@link scaleAtmosphereCount} against the visible viewport area;
 * prototype baseline was 180 (prototype.js:555).
 */
export const EMBER_COUNT = 110;
/**
 * Total dust-mote particle count — the 1080p/zoom-1 BASELINE. Round-5c: 300 →
 * 190 (owner verdict: 5b was "too much and distracting"), SPLIT across the
 * on-screen sectors by area (per-sector emitters — see
 * LightingAtmosphereSectorField). Prototype baseline was 320 (prototype.js:571).
 */
export const DUST_COUNT = 190;

/** Ember size range — min. Round-5c: 1.6 → 1.5 (5b overshot; prototype 1.4). */
export const EMBER_SIZE_MIN = 1.5;
/** Ember size range — max. Round-5c: 3.0 → 2.6 (prototype 4.0, earlier "too big"). */
export const EMBER_SIZE_MAX = 2.6;
/** NEUTRAL dust size — min. Round-5d: 1.2 → 2.0 (far-band ≥ 3px visibility floor). */
export const DUST_SIZE_MIN = 2.0;
/** NEUTRAL dust size — max. Round-5d: 2.2 → 3.2 (same far-band floor). */
export const DUST_SIZE_MAX = 3.2;

/** Ember rise velocity range — min (prototype.js:562 `24 + ...*55` → 24..79 px/s). */
export const EMBER_RISE_MIN = 24;
/** Ember rise velocity range — max (24 + 1.0*55 = 79 px/s). */
export const EMBER_RISE_MAX = 79;
/**
 * Dust-mote drift velocity span — `(seed-0.5)*DUST_DRIFT_SPAN` → ±span/2 px/s.
 * History: 8 (dead air, diagnosis §5) → 28 (ticket 21 "alive air") → eased to
 * 20 (±10 px/s) for a calmer read once counts rose (more particles × the same
 * speed reads busier). Derived by eye against the seeded preview (no published
 * AAA drift value — research §5).
 */
export const DUST_DRIFT_SPAN = 20;

/** Ember twinkle alpha base + amp (prototype.js:742 `0.5 + 0.5*sin(...)`). */
export const EMBER_TWINKLE_BASE = 0.5;
export const EMBER_TWINKLE_AMP = 0.5;
/** Ember lifecycle fade is `sin(life*PI)` (prototype.js:743) — 0→1→0 over the cycle. */
export const EMBER_LIFECYCLE_FORMULA = 'sin(life*PI)' as const;

/**
 * NEUTRAL dust shimmer alpha base + amp (band 0.35..0.75). Round-5c: base
 * 0.65 → 0.55 (owner verdict: 5b was "too much"; sector recipes carry their
 * own bands in LightingAtmosphereThemes — peaks pinned ≤ 0.85 there).
 * Prototype baseline was `0.4 + 0.25*sin`.
 */
export const DUST_SHIMMER_BASE = 0.55;
export const DUST_SHIMMER_AMP = 0.2;
/**
 * Dust-mote shimmer frequency. Polish: eased 1.5 → 1.0 so the shimmer breathes
 * slower (a calmer, "flowy" read — the 1.5Hz twinkle was a touch twitchy once
 * the count went up). Prototype baseline 1.5.
 */
export const DUST_SHIMMER_FREQ = 1.0;

/** Ember twinkle-speed range (prototype.js:566 `3 + ...*6` → 3..9 rad/s). */
export const EMBER_TWINKLE_SPEED_MIN = 3;
export const EMBER_TWINKLE_SPEED_MAX = 9;

/**
 * The depth at which atmosphere renders. Round 5c: the UNLIT overlay band
 * (`DesignTokens.depth.vfxOverlay` = 480) + registered OUT of the world-light
 * capture (`excludeFromWorldLightCapture` — ticket 30's mechanism). Additive
 * particles are light EMITTERS; multiplying them by the scene's light buffer
 * rendered the layer invisible on dim maps (the "no particles at all" verdict).
 */
export const ATMOSPHERE_DEPTH = DesignTokens.depth.vfxOverlay; // 480

/**
 * The generated particle texture's edge size in px (a 16×16 white circle).
 * Phaser renders a particle at `scale = s` as a sprite of pixel-diameter
 * `PARTICLE_TEXTURE_PX × s`.
 *
 * Ticket 11 (A8 §4.3) — the radius-vs-diameter fix. The prototype drew each
 * particle with `g.fillCircle(x, y, size)` (RADIUS `size` → diameter `2*size`);
 * the Phaser port reproduces that via `particleScaleForSize` = `(size*2)/16`. The
 * prior `size/16` form treated `size` as a diameter → ~2× too small → the far
 * parallax band (60% weight) dropped to sub-pixel (0.6px dust / 0.98px embers),
 * hiding ~60% of the dust. Post-fix: 1.2px / 1.96px (visibly above 1px).
 *
 * Lives in the Phaser-free config module so the Seam A vitest can assert the
 * scale math WITHOUT booting Phaser. Re-exported by LightingAtmosphereEmitters.
 */
export const PARTICLE_TEXTURE_PX = 16;

/**
 * Convert a prototype particle `size` (a `fillCircle` RADIUS in px) to the Phaser
 * `scale` reproducing the prototype's pixel-diameter (`2 × size`). Pure.
 */
export function particleScaleForSize(size: number): number {
  return (size * 2) / PARTICLE_TEXTURE_PX;
}

/**
 * The deterministic seed function from the prototype (prototype.js:551):
 *   `const aSeed = (i) => ((i * 2654435761) % 2147483648) / 2147483648;`
 * Reproduced verbatim so the per-particle phase/size distribution matches the
 * validated look bit-for-bit.
 */
export function atmosphereSeed(i: number): number {
  // prototype.js:551 — Knuth multiplicative hash mod 2^31, normalized to [0,1).
  return ((i * 2654435761) % 2147483648) / 2147483648;
}

// ─── Ticket 21 additions: source-motivated anchors + parallax depth ──────────

/**
 * Static-placement light kinds that count as FLAME anchors (embers rise from
 * them). Ticket 21 broadened the old `kind === 'campfire'` filter to the warm-
 * flickering set; ticket 11 (A8) extends it to ALL flame kinds ticket 08 added
 * (research §5 — Noita/Diablo III source-motivated atmosphere). This now
 * mirrors the shared `FlameKind` union (`packages/shared/src/map/tiledTypes.ts`)
 * so every kind with a real fire + flame sprite is an ember source.
 *
 *   - `torch`      — the dominant flame kind (warm orange, flickers). The
 *                    biggest mood lever: embers everywhere torches are.
 *   - `campfire`   — the prototype's primary anchor (hero light).
 *   - `candle`     — warm steady yellow (ticket 16/17 prop). Tiny but numerous.
 *   - `fireplace`  — ticket 08 (A4): large indoor slow-roar flame. Reuses the
 *                    campfire sprite; the read relies on wall-adjacent placement
 *                    (ticket 10). Embers rise the same as a campfire.
 *   - `brazier`    — ticket 08 (A4): medium junction/plaza bowl-of-coals,
 *                    steady-medium flicker. A classic ember source.
 *   - `lantern`    — ticket 08 (A4): small enclosed flame behind glass, very
 *                    steady. Fewer embers per source (the glass muffles them),
 *                    but corridors are lantern-dense so the aggregate reads.
 *
 * Excluded by design (documented so the next agent doesn't re-add them):
 *   - `biome-glow` — a cool blue steady MAGICAL glow (palette color `[0.4, 0.68,
 *                   1.0]`, no flicker — see LightPalette.ts:84). Embers from a
 *                   magic glow would read wrong (research §5: atmosphere tied to
 *                   physical fire sources). It's ambient mood, not a flame.
 *   - `barrel-fire` — inert until a barrel explodes (ticket 18); the
 *                   barrel-fire LIGHT only exists during/after the explosion,
 *                   which arrives via the DYNAMIC feed (`keptDynamic` →
 *                   `resolveEmberAnchors` in LightingPipelineAtmosphere.ts),
 *                   NOT via static placements. Filtering it here too keeps the
 *                   static anchor list clean if a future placer ever emits a
 *                   static barrel-fire placement.
 *   - `aura`/`poison`/`fire` — `aura` is the cool player avatar light (magical,
 *                   not flame); `poison` is green magical; `fire` is a dynamic-
 *                   only kind (projectiles/explosions) that already reaches the
 *                   embers via the dynamic fire-color filter.
 */
export const FLAME_ANCHOR_KINDS: ReadonlySet<LightKind> = new Set<LightKind>([
  'torch',
  'campfire',
  'candle',
  'fireplace',
  'brazier',
  'lantern',
]);

/**
 * A parallax depth band. Near bands read as closer to camera (bigger particles,
 * faster motion); far bands read as receding (smaller, slower). research §5
 * "depth via parallax size/speed" + the prototype's varying-size motes.
 */
export interface AtmosphereParallaxBand {
  /** Multiplier applied to the layer's base size range. >1 = nearer (bigger). */
  sizeMul: number;
  /** Multiplier applied to the layer's base speed. >1 = nearer (faster). */
  speedMul: number;
  /** Relative weight of this band in the per-particle distribution (0..1). */
  weight: number;
}

/**
 * Ember parallax bands — 2 bands (near + far). Embers near the camera rise
 * faster + read larger (heat billowing up close); far embers are small slow
 * sparks receding into the gloom. The far band is weighted heavier (0.6) so the
 * bulk of embers read as ambient depth, with a near minority giving punch.
 */
export const EMBER_PARALLAX_BANDS: readonly AtmosphereParallaxBand[] = [
  { sizeMul: 1.15, speedMul: 1.5, weight: 0.4 }, // near — bigger, faster (toned down from 1.45)
  { sizeMul: 0.7, speedMul: 0.55, weight: 0.6 }, // far  — smaller, slower
];

/**
 * Dust-mote parallax bands — 2 bands (near + far). Near motes drift faster +
 * read larger (closer to the lens); far motes hang almost still + tiny (deep
 * background haze). research §5: the flat sheet is the documented anti-pattern;
 * the size/speed split is what makes the layer read as volumetric.
 *
 * Polish bump: the far band was 0.6× size → with the old 1.0–3.0px size range
 * the far motes dropped sub-pixel. Raised to 0.85× so far motes stay visibly
 * above 1px (the user: "barely see it"). Near band unchanged. Round-5d keeps
 * both bands (max rendered dust Ø stays ≤ 11px — the themes test pins it).
 */
export const DUST_PARALLAX_BANDS: readonly AtmosphereParallaxBand[] = [
  { sizeMul: 1.15, speedMul: 1.7, weight: 0.4 }, // near — bigger, faster (toned down from 1.5)
  { sizeMul: 0.85, speedMul: 0.4, weight: 0.6 }, // far — smaller, slower
];

/**
 * Deterministically assign a parallax band index to particle `i`. The hash is
 * independent of {@link atmosphereSeed} (different stride + offset) so band
 * assignment doesn't correlate with phase/size/twinkle. Pure → unit-testable
 * (the Seam A test asserts same-i → same-band, and that the band distribution
 * over many particles roughly matches the configured weights).
 *
 * @param i           particle index (stable per-particle).
 * @param bandCount   number of bands (length of the band array).
 * @returns           band index in `[0, bandCount)`.
 */
export function atmosphereParallaxBand(i: number, bandCount: number): number {
  if (bandCount <= 1) return 0;
  // Independent Knuth-style hash; the +5 offset + *31 stride decouple it from
  // atmosphereSeed(i) and atmosphereSeed(i*37+1) etc.
  const h = (i * 1597 + 517) >>> 0;
  return ((h * 2654435761) >>> 0) % bandCount;
}

/**
 * Reference viewport area (world px²) for the prototype's particle counts. The
 * 06 prototype + the live match both target 1920×1080 @ zoom 1, so the
 * prototype's 180 ember / 320 dust counts are the "correct density" baseline
 * for that area. {@link scaleAtmosphereCount} scales linearly from here.
 */
export const REFERENCE_VIEWPORT_AREA = 1920 * 1080;

/**
 * Scale a baseline particle count by the ratio of the current viewport area to
 * the 1080p reference, clamped to a sane range. Ticket 21: the diagnosis §5
 * flagged the fixed 180/320 counts as "sparse on 4K, a cloud when zoomed in."
 *
 * Scaling is by AREA (not linear dimension) because particle density is
 * per-unit-screen-area. Clamp: 0.5× keeps zoomed-in views from becoming a
 * cloud; {@link COUNT_CEILING_MULTIPLE} (2.5×) keeps 4K from being sparse
 * without blowing the draw budget (a 4K frame at 2.5× = 475 dust / 275 embers
 * — still ~2 draw calls per emitter, pooled).
 *
 * Pure → unit-testable.
 *
 * @param base     the 1080p baseline count ({@link EMBER_COUNT} / {@link DUST_COUNT}).
 * @param viewArea current visible viewport area in world px² (width × height,
 *                 already zoom-adjusted — pass `cam.worldView.width × height`).
 */
export function scaleAtmosphereCount(base: number, viewArea: number): number {
  if (!Number.isFinite(viewArea) || viewArea <= 0) return base;
  const ratio = viewArea / REFERENCE_VIEWPORT_AREA;
  const clamped = Math.max(COUNT_FLOOR_MULTIPLE, Math.min(COUNT_CEILING_MULTIPLE, ratio));
  return Math.round(base * clamped);
}

/**
 * The floor + ceiling multiples applied by {@link scaleAtmosphereCount}. The
 * pool size (maxParticles) is pre-allocated at `base × COUNT_CEILING_MULTIPLE`
 * by the emitter builders so the pool can accommodate the LARGEST expected
 * viewport (4K) without Phaser silently capping alive particles below the
 * target. {@link LightingAtmosphere.update} then tunes `maxAliveParticles`
 * within `[base × FLOOR, base × CEILING]` per the live viewport.
 */
export const COUNT_FLOOR_MULTIPLE = 0.5;
export const COUNT_CEILING_MULTIPLE = 2.5;

/**
 * Hard pool cap (maxParticles) for the ember emitter = baseline × ceiling.
 * Pre-allocated so a 4K viewport's higher `maxAliveParticles` target is
 * achievable (Phaser can't spawn more alive than the pool holds).
 */
export const EMBER_POOL_SIZE = Math.round(EMBER_COUNT * COUNT_CEILING_MULTIPLE);
/** Hard pool cap (maxParticles) for the dust emitter. See {@link EMBER_POOL_SIZE}. */
export const DUST_POOL_SIZE = Math.round(DUST_COUNT * COUNT_CEILING_MULTIPLE);

// ─── Ticket C3 — fill-rate fix (particles-per-cycle to reach target promptly) ──
//
// `quantity` (particles spawned per flow cycle) was unset → Phaser default 1 →
// 25/sec at frequency 40ms → the 180/320 targets were NEVER reached (dust took
// ~10s from cold). Fix: `quantity = ceil(targetCount / (avgLifespanMs / frequencyMs))`.
// Lives in the Phaser-free config so the Seam A vitest asserts the fill-rate
// contract without booting Phaser (same pattern as the pool sizes).

/** Flow cadence (ms per emit cycle) both emitters use. */
export const ATMOSPHERE_EMIT_FREQUENCY_MS = 40;

/**
 * Embers per flow cycle: `ceil(EMBER_COUNT / (3500/40)) = ceil(110/87.5) = 2`.
 * Re-derived from the live count so spawn rate keeps up with the target
 * (steady-state alive ≈ 2 × 87.5 ≈ 175, capped by EMBER_POOL_SIZE + runtime
 * maxAliveParticles). Steady-state `quantity` (NOT a burst-at-construction) is
 * required because embers emit from `shared.campfireAnchors`, which the
 * controller populates per-frame (empty at construction) — a burst would
 * cluster all embers at the fallback anchor (camera center), the A5 symptom.
 */
export const EMBER_EMIT_QUANTITY = 2;

/** Dust per flow cycle: `ceil(DUST_COUNT / (10000/40)) = ceil(190/250) = 1` (round 5c). */
export const DUST_EMIT_QUANTITY = 1;

/**
 * The dust emit field is this multiple × the viewport (centered on the
 * camera), so the wrap (deathZone) happens off-screen — motes never pop at
 * the view edge.
 *
 * Map-polish ticket 31 (round 5): this camera-follow rect is THE field — the
 * ticket-11/A8 "world-wide dust" experiment returned the full world rect
 * (80×80 tiles @128px = 104.9M px²) while the live count stayed
 * viewport-scaled (240 @1080p), collapsing on-screen density to ≈4.7 motes
 * (≈13× below the camera-follow regime) — the owner's "mood particles are
 * totally gone". Zoom coverage is served by {@link scaleAtmosphereCount}
 * (viewArea scaling): zooming OUT raises the count while the field tracks the
 * view, keeping per-screen-area density constant at any zoom — which the
 * world-rect approach violated by construction.
 */
export const DUST_FIELD_VIEWPORT_MULTIPLE = 2.0;

/**
 * A snapshot of a flame anchor position (world px) the embers anchor to.
 * Extracted from the static placements whose kind ∈ {@link FLAME_ANCHOR_KINDS}
 * (torch / campfire / candle) and/or the dynamic fire lights
 * (barrel-fire / explosions / fire-traps that arrive via `keptDynamic`).
 */
export interface CampfireAnchor {
  x: number;
  y: number;
}

/**
 * Per-frame camera state the atmosphere needs. The camera fields place the
 * ember fallback anchor (camera center) + drive the viewport-area count
 * scaling + place the camera-following dust-mote emit field.
 */
export interface AtmosphereCameraState {
  /** World-px top-left of the visible view. */
  scrollX: number;
  scrollY: number;
  /** Visible view size in world px (already divided by zoom). */
  viewWidth: number;
  viewHeight: number;
}

/**
 * The dust-mote emit field (world px): the camera-following rect at
 * {@link DUST_FIELD_VIEWPORT_MULTIPLE} × the viewport, centered on the camera,
 * so the wrap happens off-screen (ticket 31 — see the constant's docstring for
 * why the world-rect experiment was reverted).
 */
export function cameraFollowDustField(cam: AtmosphereCameraState): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const fieldW = cam.viewWidth * DUST_FIELD_VIEWPORT_MULTIPLE;
  const fieldH = cam.viewHeight * DUST_FIELD_VIEWPORT_MULTIPLE;
  const fieldX = cam.scrollX + cam.viewWidth * 0.5 - fieldW * 0.5;
  const fieldY = cam.scrollY + cam.viewHeight * 0.5 - fieldH * 0.5;
  return { x: fieldX, y: fieldY, w: fieldW, h: fieldH };
}

/**
 * Resolve the dust-mote emit field (world px) for one frame: the
 * camera-following rect ({@link cameraFollowDustField}). Pure (no Phaser) →
 * unit-testable. The Seam A test pins the camera-follow contract: the field
 * tracks the camera at every scroll/zoom, so on-screen dust density stays
 * constant per screen area at any zoom.
 */
export function resolveDustEmitField(cam: AtmosphereCameraState): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return cameraFollowDustField(cam);
}

/**
 * Resolve the FLAME anchor positions (world px) from the pipeline's static
 * placements + the dynamic fire lights (ticket 21: ALL flame kinds are ember
 * sources — see {@link FLAME_ANCHOR_KINDS} for the fiction + exclusions;
 * dynamic fires arrive color-filtered from `resolveEmberAnchors` in
 * LightingPipelineAtmosphere). Pure — no Phaser, unit-testable.
 *
 * Static placements are filtered by {@link FLAME_ANCHOR_KINDS}
 * (`{torch, campfire, candle}` — see its docstring for the biome-glow /
 * barrel-fire exclusions). Dynamic fire positions (already color-filtered to
 * the warm-hot palette by `resolveEmberAnchors` in LightingPipelineAtmosphere)
 * are folded in to cover barrel-fire / explosions / fire-traps that don't have
 * static placements.
 *
 * Map-polish ticket 31 (round 5): when `camera` is provided, the static slice
 * is the `maxAnchors` placements NEAREST the camera (deterministic tie-break
 * by placement index), NOT the first-N in generation order — the first-N slice
 * measured as always-the-top-band campfires on every seed (all 120 embers rose
 * in one map corner; players elsewhere saw zero). Without `camera` the legacy
 * first-N order stands (back-compat for non-positional callers).
 *
 * @param placements    the static map-gen placements (flame kinds become anchors).
 * @param tileSize      grid→world px conversion factor.
 * @param dynamicLights optional dynamic fire positions (barrel-fire/explosions/
 *                      fire-traps — already filtered to the warm-hot palette).
 * @param camera        optional camera center (world px) — selects the nearest
 *                      static anchors instead of the first-N by generation order.
 * @param maxAnchors    cap to keep the ember budget sane at 64-player scale.
 */
export function resolveFlameAnchors(
  placements: ReadonlyArray<LightPlacementTiled>,
  tileSize: number,
  dynamicLights?: ReadonlyArray<{ x: number; y: number }>,
  camera?: { x: number; y: number },
  maxAnchors = 8,
): CampfireAnchor[] {
  const out: CampfireAnchor[] = [];
  if (camera) {
    // Nearest-K selection: keep the K closest candidates (squared distance;
    // ties resolve to the LOWER placement index — deterministic per seed).
    let farthestIdx = -1;
    let farthestDist = -1;
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      if (!FLAME_ANCHOR_KINDS.has(p.kind)) continue;
      const x = gridToWorldPx(p.gridX, tileSize);
      const y = gridToWorldPx(p.gridY, tileSize);
      const dist = (x - camera.x) * (x - camera.x) + (y - camera.y) * (y - camera.y);
      if (out.length < maxAnchors) {
        out.push({ x, y });
        if (dist > farthestDist) {
          farthestDist = dist;
          farthestIdx = out.length - 1;
        }
      } else if (farthestIdx >= 0 && dist < farthestDist) {
        out[farthestIdx] = { x, y };
        // Re-scan the small K-sized slice for the new farthest (K ≤ 8).
        farthestIdx = 0;
        farthestDist = (out[0]!.x - camera.x) ** 2 + (out[0]!.y - camera.y) ** 2;
        for (let j = 1; j < out.length; j++) {
          const d = (out[j]!.x - camera.x) ** 2 + (out[j]!.y - camera.y) ** 2;
          if (d > farthestDist) {
            farthestDist = d;
            farthestIdx = j;
          }
        }
      }
    }
  } else {
    for (let i = 0; i < placements.length && out.length < maxAnchors; i++) {
      const p = placements[i]!;
      if (FLAME_ANCHOR_KINDS.has(p.kind)) {
        out.push({ x: gridToWorldPx(p.gridX, tileSize), y: gridToWorldPx(p.gridY, tileSize) });
      }
    }
  }
  // Fold in dynamic fire positions as transient ember anchors — capped so a
  // 64-player explosion spam doesn't balloon the anchor list.
  if (dynamicLights) {
    for (let i = 0; i < dynamicLights.length && out.length < maxAnchors; i++) {
      out.push({ x: dynamicLights[i]!.x, y: dynamicLights[i]!.y });
    }
  }
  return out;
}

/**
 * @deprecated use {@link resolveFlameAnchors} (ticket 21 broadened campfire-only
 *   to all flame kinds). Alias so existing call-sites + tests keep compiling.
 */
export const resolveCampfireAnchors = resolveFlameAnchors;
