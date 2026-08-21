/**
 * MenuDioramaLighting — the fire / aura / atmosphere wiring for the menu
 * diorama (ticket 05). Owns the central campfire light + max-blend aura, the
 * perimeter torch / lantern prop sprites + their static lights, and the
 * atmosphere anchor wiring (embers + dust motes).
 *
 * This module is **consumed by ticket 06** (`MenuBackground`), which constructs
 * the `LightingPipeline` itself (via 01's boot helper) and owns the parallax /
 * vignette / baked-diorama RT. Ticket 05 only produces the fire + atmosphere
 * wiring that 06 calls. Do NOT construct a `LightingPipeline` here — take one
 * as a `boot()` argument (dependency-injected by 06).
 *
 * ── Reuse only (hard constraint) ──
 *
 * Every lighting primitive is a SHIPPED piece consumed via its public API:
 *   - `LightingPipeline.setPlacements` / `setWorldBounds` / `beginDynamicLights` /
 *     `addDynamicLight` (`LightingPipeline.ts:259,282,288,294`).
 *   - `LightPropRenderer.spawn` + `ensureAnims` (`LightPropRenderer.ts:201,110`) —
 *     the visible flame sprites (torch / lantern 6-frame flicker; campfire is a
 *     static `game/campfire` frame).
 *   - `LightPalette` (`LightPalette.ts:118`) + `HERO_LIGHT_OVERRIDES`
 *     (`:285`) — the campfire + aura color / radius / intensity / blend tuning.
 *   - `TorchFlicker.computeFlickerMulForKind('campfire', ...)` (`TorchFlicker.ts:272`)
 *     — applied AUTOMATICALLY to the static campfire placement by the packer
 *     (`LightingPipelineUpdate.ts:99-103`). This is 01's Path A (static
 *     placement, auto-flicker) — zero per-frame CPU for the fire's "roar."
 *   - `LightingAtmosphere` (embers + dust motes) — constructed + driven INSIDE
 *     the pipeline (`LightingPipeline.ts:221,336`). This module only feeds the
 *     placements + world bounds so the atmosphere's flame-anchor resolver
 *     (`resolveFlameAnchors`, `LightingAtmosphereConfig.ts:440`) picks up the
 *     campfire + torches + lanterns as ember anchors.
 *
 * No shipped lighting file is modified. No new light kinds / flicker math /
 * emitters / shader stages are introduced.
 *
 * ── Path A vs Path B (per 01 §Light-driving API) ──
 *
 * The **central campfire** uses **Path A** (static placement, auto-flicker) —
 * 01's recommended simplest path. The packer folds the campfire "roar" profile
 * (`TorchFlicker.ts:129-136`: lowAmp 0.28, ~0.175Hz slow roar, flareMul 1.6)
 * into the packed intensity each frame via `computeFlickerMulForKind`
 * (`LightingPipelineUpdate.ts:99-103`).
 *
 * The **aura** is forced onto **Path B** (dynamic light) by a type constraint,
 * not a preference: `LightPlacementTiled.kind` is the shared `LightKind`
 * (`@sector-battle/shared`), which EXCLUDES the client-only `'aura'`
 * (`ClientLightKind = LightKind | 'fire' | 'poison' | 'aura'`,
 * `LightPalette.ts:33`). So the aura cannot be a static placement — it is
 * re-submitted each frame via `addDynamicLight({..., blend:'max'}, STATIC)`.
 * The aura does NOT flicker (it is not a `FlickerFlameKind`; aura flicker is
 * OFF in `HERO_LIGHT_OVERRIDES.aura.flicker = false`).
 *
 * ── Coordinate system (02's locked coords) ──
 *
 * Tile size = 128 (`packages/shared/src/constants/grid.ts:3`). The placements
 * use 02's locked grid coords:
 *   - Central campfire: col 7.5, row 1.5 (behind the logo, 02 §4).
 *   - Perimeter ground torches: col 3 row 3 + col 12 row 3 (02 §5).
 *   - Perimeter hanging lanterns: col 5 row 4 + col 10 row 4 (02 §5).
 *
 * The packer / prop renderer convert grid→world via `gridToWorldPx(g, tileSize)
 * = g*tileSize + tileSize/2` (tile-center convention, `LightPacker.ts:128`).
 *
 * ── Atmosphere + parallax-scheme independence (per 01) ──
 *
 * The atmosphere emitters are a LIVE additive layer into the albedo RT
 * (`LightingPipelineAtmosphere.ts:58-74`). They render into the albedo capture
 * before the Sobel/HdrLit passes, so they are lit by the pipeline. They are
 * therefore **parallax-scheme-independent**: 04's later parallax choice affects
 * only the baked scene layers, not these live embers. If 04 later picks a
 * multi-layer scheme, the emitter depth stays on the world-depth band (the
 * atmosphere renders at `ATMOSPHERE_DEPTH` < `hudBg` 500); 06 only needs to
 * ensure the baked parallax RTs also stay below the cutoff.
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): the fire + aura +
 * embers are mood, never a visibility mechanic. The shipped ambient floor
 * `vec3(0.18,0.15,0.12)` (`LightingPipeline.ts:10`, `hdrLit.frag:20`) keeps the
 * diorama fully legible behind the logo.
 */
import type Phaser from 'phaser';
import type { LightPlacementTiled } from '@sector-battle/shared';
import type { LightingPipeline } from '../../rendering/lighting/LightingPipeline.js';
import { LightPropRenderer } from '../../rendering/lighting/LightPropRenderer.js';

// ─── 02's locked composition coordinates (col / row on the 16×9 / 128px grid) ───

/** Tile size for the menu diorama (`packages/shared/src/constants/grid.ts:3`). */
export const MENU_DIORAMA_TILE_SIZE = 128;
/** Oversized stage (02 §3: 16 cols × 9 rows × 128px). Larger than the 1920×1080 viewport. */
export const MENU_DIORAMA_STAGE_W = 2048;
export const MENU_DIORAMA_STAGE_H = 1152;

/** Central campfire anchor (02 §4: behind the logo). */
export const CENTRAL_FIRE_COL = 7.5;
export const CENTRAL_FIRE_ROW = 1.5;
/** Perimeter ground torches (02 §5: flank the clearing mouth). */
export const PERIMETER_TORCH_A = { col: 3, row: 3 } as const;
export const PERIMETER_TORCH_B = { col: 12, row: 3 } as const;
/** Perimeter hanging lanterns (02 §5: light the path down). */
export const PERIMETER_LANTERN_A = { col: 5, row: 4 } as const;
export const PERIMETER_LANTERN_B = { col: 10, row: 4 } as const;

/** Options for {@link MenuDioramaLighting.boot}. */
export interface MenuDioramaLightingBootOptions {
  /** Grid→world px conversion factor (128 per `grid.ts`). */
  tileSize: number;
  /**
   * Oversized stage width in world px (2048 per 02 §3). No longer consumed
   * (ticket 31 removed the world-rect dust field; the camera-following field
   * covers the view) — kept in the interface so callers are untouched.
   */
  stageW: number;
  /**
   * Oversized stage height in world px (1152 per 02 §3). No longer consumed
   * (see `stageW`).
   */
  stageH: number;
  /**
   * The variant's static placements (campfire + perimeter fixtures) —
   * dependency-injected by `MenuBackground`, which resolves them from the
   * variant registry (`getMenuDioramaPlacements(variantId)`,
   * `menuDioramaComposition.ts`). Pre-ticket-14 this module built the placements
   * itself (`buildMenuDioramaPlacements`); ticket 14 moved that data into the
   * registry so 15 can vary it per variant, and this module now just CONSUMES
   * whatever placements the caller resolved (no `menuDioramaComposition` import
   * here → no module cycle: composition imports constants from this file).
   */
  placements: LightPlacementTiled[];
}

/**
 * Owns the menu diorama's fire + perimeter lights + atmosphere wiring.
 *
 * Lifecycle (consumed by ticket 06's `MenuBackground`):
 *   1. 06 constructs the `LightingPipeline` (via 01's boot helper, WebGL-guarded).
 *   2. 06 calls `menuDiorama.boot(scene, lighting, { tileSize, stageW, stageH })`
 *      ONCE after the baked diorama RT is in the scene (so the prop sprites land
 *      on the right scene + the pipeline captures them at depth 4 < hudBg 500).
 *   3. Each frame, 06 calls `menuDiorama.update(time, delta)` BEFORE
 *      `lighting.update(time/1000)` (the aura dynamic light must be in the
 *      budget list before the packer runs). The campfire flicker is handled
 *      inside `lighting.update()` (Path A auto-flicker) — `update()` here only
 *      re-submits the aura.
 *   4. On shutdown, 06 calls `menuDiorama.destroy()` to tear down the prop
 *      sprites. The pipeline itself (RTs, atmosphere, Final filter) is torn
 *      down separately by 06 via `lighting.shutdown()`.
 *
 * The atmosphere (embers + dust motes) is constructed + driven INSIDE the
 * `LightingPipeline` (`LightingPipeline.ts:221,336`); this module only feeds
 * `setPlacements` (campfire + torches + lanterns → flame anchors via
 * `resolveFlameAnchors`, `LightingAtmosphereConfig.ts:440`) + `setWorldBounds`
 * (so the dust-mote field covers the whole oversized stage, not just the
 * camera-follow rect). Do NOT drive the atmosphere from here — that would
 * double-drive it (the pipeline already calls `driveAtmosphere` in `update()`).
 */
export class MenuDioramaLighting {
  private scene: Phaser.Scene | null = null;
  private lighting: LightingPipeline | null = null;
  private propRenderer: LightPropRenderer | null = null;

  /**
   * Wire the fire / aura / atmosphere into the pipeline. Call ONCE after the
   * baked diorama RT exists (06 owns that RT). Idempotent-ish: a second call
   * tears down the previous `LightPropRenderer` first (defensive against a
   * double-boot), matching `LightPropRenderer.spawn`'s own clear-first contract.
   */
  boot(
    scene: Phaser.Scene,
    lighting: LightingPipeline,
    opts: MenuDioramaLightingBootOptions,
  ): void {
    this.scene = scene;
    this.lighting = lighting;
    const { tileSize, placements } = opts;

    // Static placements: the variant's central campfire (Path A auto-flicker) +
    // perimeter fixtures. Both the light disks (packer resolves the palette by
    // kind) AND the visible flame sprites (renderer resolves the texture by
    // kind) are driven by this one list. (`LightingPipeline.setPlacements`,
    // `LightingPipeline.ts:259`.) Ticket 14: `placements` is now injected by the
    // caller (resolved from the variant registry) — pre-ticket-14 this module
    // built them itself via `buildMenuDioramaPlacements`.
    lighting.setPlacements(placements);

    // Dust motes: the atmosphere's camera-following field (ticket 31 —
    // `resolveDustEmitField`, LightingAtmosphereConfig) covers the diorama
    // view + margin automatically as the menu camera drifts. The diorama has
    // no sector grid, so the motes carry the NEUTRAL theme (canonical cool
    // tint — LightingAtmosphereThemes).

    // Visible flame sprites: torch / lantern (6-frame flicker @ 9fps) + campfire
    // (static `game/campfire` — its flicker lives in the light disk). `spawn`
    // calls `ensureAnims(scene)` internally (`LightPropRenderer.ts:203`) and
    // sets each sprite at depth `LIGHT_PROP_DEPTH` (4, `< hudBg` 500) so the
    // pipeline captures them into the albedo RT (`LightPropRenderer.ts:83,223`).
    // The deferred pipeline then lights them naturally (the "motivated lighting"
    // rule). Re-boot tears down the previous sprites first.
    this.propRenderer?.shutdown();
    this.propRenderer = new LightPropRenderer(scene);
    this.propRenderer.spawn(placements, tileSize);
  }

  /**
   * Per-frame hook. Retained as a no-op for the 06 lifecycle contract (06 calls
   * this BEFORE `lighting.update(time/1000)`). The aura dynamic light it used to
   * re-submit was REMOVED — the campfire's own disk is now the sole hero (the
   * 5-tile additive aura was the single biggest clutter source). All per-frame
   * light motion now lives INSIDE `lighting.update()`: the campfire/support
   * flicker (Path A) + the crystal pulse (the packer's `p.pulse` branch). This
   * method does NOT touch the pipeline (no double-drive) and is a no-op before
   * `boot()` / after `destroy()`. Kept (not deleted) so 06's call site stays
   * stable + any future per-frame menu-light work has a home.
   */
  update(_time: number, _delta: number): void {
    // No-op since the aura removal. See the doc above.
  }

  /**
   * Tear down the prop sprites. Best-effort — never throws (mirrors
   * `LightPropRenderer.shutdown`, `LightPropRenderer.ts:283`). The pipeline
   * itself (RTs / atmosphere / Final filter) is torn down separately by 06 via
   * `lighting.shutdown()` — this method does NOT touch the pipeline.
   */
  destroy(): void {
    this.propRenderer?.shutdown();
    this.propRenderer = null;
    this.scene = null;
    this.lighting = null;
  }

  /** The booted `LightPropRenderer` (null before boot / after destroy). Exposed
   * for 06's diagnostic + screenshot follow-ups (read-only intent). */
  getPropRenderer(): LightPropRenderer | null {
    return this.propRenderer;
  }
}
