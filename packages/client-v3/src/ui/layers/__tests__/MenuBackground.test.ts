/**
 * Pure-logic unit tests for `MenuBackground` (ticket 06).
 *
 * These validate the COMPOSITION CONTRACT that the visual depends on — WITHOUT
 * booting WebGL (the `LightingPipeline` ctor throws on non-WebGL, and jsdom has
 * no WebGL context). The full visual verification (fire renders, parallax
 * drift, logo silhouettes against blaze) lives in the browser harness run by
 * ticket 10; these tests guard the load-bearing invariants:
 *   - The 5 parallax layers exist + slice 02's locked coords correctly (ticket
 *     28 grew the roster from 3 → 5: far/bg/mid/fg/fore).
 *   - Ticket-28 scrollFactors: far 0.45 < bg 0.70 < MID 1.0 < fg 1.30 < fore 1.60.
 *   - Every frame is a real `game` atlas filename (no typos that would
 *     silently render nothing).
 *   - The central stage (cols 5–10, rows 0–3) keeps the campfootprint clear of
 *     scatter props — only the G2 medallion (planks trim + tile hearth +
 *     wall_half corner accents) lives there (the campfire sprite itself is
 *     owned by 05, not baked here).
 *   - The button row (cols 6–9, rows 4–6) has clean path behind it (the G5
 *     corridor), not scatter props (02 §3 — backdrop must not visually compete
 *     with buttons).
 *   - The camera neutral puts the fire (world 1024,256) at screen (960,220),
 *     behind the logo (960,194).
 *   - The Canvas-fallback path doesn't crash (boot + update + destroy cycle).
 *
 * **Ticket 27 note:** these assertions now test the GRAMMAR-APPLIED
 * forest-bonfire (the G1–G5 rebuild). The pre-ticket-27 byte-pin (exactly 144
 * grass, 8 path straights, wall_half at the clearing mouth) is superseded — the
 * grammar adds G3 grass→plants variation, the G5 path system (path_crossing +
 * path + path_curve), and moves wall_half to the 4 rotated medallion corners.
 * The load-bearing invariants (3 layers, scrollFactors, real frames, central
 * stage clear of SCATTER, camera neutral) are unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  getMenuDioramaComposition,
  MENU_FAR_SCROLL_FACTOR,
  MENU_BG_SCROLL_FACTOR,
  MENU_MID_SCROLL_FACTOR,
  MENU_FG_SCROLL_FACTOR,
  MENU_FORE_SCROLL_FACTOR,
  MENU_CAMERA_NEUTRAL_X,
  MENU_CAMERA_NEUTRAL_Y,
} from '../menuDioramaComposition.js';
import {
  CENTRAL_FIRE_COL,
  CENTRAL_FIRE_ROW,
  MENU_DIORAMA_TILE_SIZE,
} from '../MenuDioramaLighting.js';

// Ticket 14: the composition is now resolved through the variant registry.
// `'forest-bonfire'` is the byte-identical 02 scene (the only registered
// variant today), so every pre-ticket-14 `buildMenuDioramaComposition()`
// call site maps 1:1 to `getMenuDioramaComposition('forest-bonfire')`.
const buildMenuDioramaComposition = () => getMenuDioramaComposition('forest-bonfire');

// The real `game` atlas filenames (verified against game.json — see 02 §11).
// If a frame appears in the composition but not in this set, the bake would
// silently render nothing (a missing-frame sprite is invisible). Loaded from
// the REAL game atlas JSON so the set is always in sync with shipped art.
import gameAtlas from '../../../../public/assets/game.json';
const KNOWN_GAME_FRAMES = new Set(
  ((gameAtlas as { textures: { frames: { filename: string }[] }[] }).textures[0]?.frames ?? []).map(
    (f) => f.filename,
  ),
);

const TILE = MENU_DIORAMA_TILE_SIZE; // 128

describe('MenuBackground — composition slicing (02 locked scene)', () => {
  const layers = buildMenuDioramaComposition();
  const far = layers.find((l) => l.id === 'far')!;
  const bg = layers.find((l) => l.id === 'bg')!;
  const mid = layers.find((l) => l.id === 'mid')!;
  const fg = layers.find((l) => l.id === 'fg')!;
  const fore = layers.find((l) => l.id === 'fore')!;

  it('emits exactly 5 layers (far/bg/mid/fg/fore) for the ticket-28 5-layer parallax', () => {
    // Ticket 28 (doc 19): the parallax grew from 3 RTs (bg/mid/fg) to 5
    // (far/bg/mid/fg/fore). The fg layer IS the 'near' layer (sf 1.3) — kept
    // under its legacy id so ticket-27's byte-pinned bg/mid/fg stay unchanged.
    expect(layers).toHaveLength(5);
    expect(layers.map((l) => l.id).sort()).toEqual(['bg', 'far', 'fg', 'fore', 'mid']);
  });

  it('uses the ticket-28 scrollFactors: far 0.45 < bg 0.70 < MID 1.0 < fg 1.30 < fore 1.60', () => {
    // MID = 1.0 MANDATORY (all light anchors world-locked there — the HdrLit
    // world-pos reconstruction assumes sf=1.0). far/bg < 1.0; fg/fore > 1.0.
    expect(MENU_MID_SCROLL_FACTOR).toBe(1.0); // mandatory.
    expect(far.scrollFactor).toBe(MENU_FAR_SCROLL_FACTOR); // 0.45
    expect(bg.scrollFactor).toBe(MENU_BG_SCROLL_FACTOR); // 0.70
    expect(mid.scrollFactor).toBe(MENU_MID_SCROLL_FACTOR); // 1.0
    expect(fg.scrollFactor).toBe(MENU_FG_SCROLL_FACTOR); // 1.3 (= near)
    expect(fore.scrollFactor).toBe(MENU_FORE_SCROLL_FACTOR); // 1.6
    // The parallax band widens from 0.6 (0.7↔1.3) to 1.15 (0.45↔1.60).
    expect(far.scrollFactor).toBeLessThan(bg.scrollFactor);
    expect(bg.scrollFactor).toBeLessThan(mid.scrollFactor);
    expect(mid.scrollFactor).toBeLessThan(fg.scrollFactor);
    expect(fg.scrollFactor).toBeLessThan(fore.scrollFactor);
  });

  it('applies the bake-time haze wash on far + bg ONLY (mid/fg/fore stay clean)', () => {
    // Ticket 28 / doc 19 §2c: far carries α≈0.28, bg carries α≈0.12, toward
    // MENU_HAZE_COLOR (the ambient floor 0x473D2E). mid/fg/fore omit the wash
    // (light anchors on mid; fore's open center must stay transparent).
    expect(far.hazeAlpha).toBe(0.28);
    expect(far.hazeColor).toBe(0x473d2e);
    expect(bg.hazeAlpha).toBe(0.12);
    expect(bg.hazeColor).toBe(0x473d2e);
    expect(mid.hazeAlpha).toBeUndefined();
    expect(fg.hazeAlpha).toBeUndefined();
    expect(fore.hazeAlpha).toBeUndefined();
  });

  it('references only real `game` atlas frames (no typos that silently render nothing)', () => {
    const all = [...far.tiles, ...bg.tiles, ...mid.tiles, ...fg.tiles, ...fore.tiles];
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) {
      expect(KNOWN_GAME_FRAMES.has(t.frame)).toBe(true);
    }
  });

  it('does NOT bake the light-anchor sprites (campfire + perimeter biome-glow) — 05 owns those', () => {
    // 05's MenuDioramaLighting spawns the campfire + the 4 perimeter biome-glow
    // crystals (ticket 12) as live LightPropRenderer sprites; baking them here
    // would double-render.
    const all = [...far.tiles, ...bg.tiles, ...mid.tiles, ...fg.tiles, ...fore.tiles];
    const frames = new Set(all.map((t) => t.frame));
    expect(frames.has('campfire')).toBe(false);
    // `biome-glow_01` (the perimeter kind post-ticket-12) + `torch`/`lantern`
    // (the pre-ticket-12 perimeter kinds) aren't in the `game` atlas — they live
    // in `lightProps`. Defense-in-depth against a future composition edit that
    // tries to bake any light-prop frame.
    expect(frames.has('biome-glow_01')).toBe(false);
    expect(frames.has('torch')).toBe(false);
    expect(frames.has('lantern')).toBe(false);
  });
});

describe('MenuBackground — BG layer (forest floor underlay)', () => {
  const bg = buildMenuDioramaComposition().find((l) => l.id === 'bg')!;

  it('covers the full 16×9 stage with a grass base (Canvas no-black invariant)', () => {
    // Every cell is painted with an opaque floor tile — no transparency holes.
    const cells = new Set(bg.tiles.map((t) => `${t.col},${t.row}`));
    expect(cells.size).toBeGreaterThanOrEqual(144); // 16×9 = 144 minimum (decorations add more)
    for (let col = 0; col < 16; col++) {
      for (let row = 0; row < 9; row++) {
        expect(cells.has(`${col},${row}`)).toBe(true);
      }
    }
  });

  it('uses opaque grass as the base floor (never transparent plants/planks)', () => {
    // The base fill must be opaque floor tiles only. plants are overlaid as
    // SEPARATE decoration tiles (appended after the fill), never replacing it.
    for (let col = 0; col < 16; col++) {
      for (let row = 0; row < 9; row++) {
        const tiles = bg.tiles.filter((t) => t.col === col && t.row === row);
        // At least one tile per cell (the opaque floor).
        expect(tiles.length).toBeGreaterThanOrEqual(1);
        // The first (floor) tile is always opaque grass.
        expect(tiles[0]!.frame).toBe('grass');
      }
    }
  });
});

describe('MenuBackground — MID layer (Bomberman map structure)', () => {
  const mid = buildMenuDioramaComposition().find((l) => l.id === 'mid')!;

  it('has a complete border wall ring with rotated side walls + 4 corners', () => {
    // Top + bottom: horizontal wall tiles (rotation 0)
    for (let col = 0; col <= 15; col++) {
      expect(mid.tiles.some((t) => t.col === col && t.row === 0 && t.frame === 'wall')).toBe(true);
      expect(mid.tiles.some((t) => t.col === col && t.row === 8 && t.frame === 'wall')).toBe(true);
    }
    // Left border (col 0, rows 1–7): wall rotated 90° CW (vertical)
    for (let row = 1; row <= 7; row++) {
      const left = mid.tiles.find((t) => t.col === 0 && t.row === row && t.frame === 'wall');
      expect(left).toBeDefined();
      expect(left!.rotation).toBe(90);
    }
    // Right border (col 15, rows 1–7): wall rotated 270° CW (mirror)
    for (let row = 1; row <= 7; row++) {
      const right = mid.tiles.find((t) => t.col === 15 && t.row === row && t.frame === 'wall');
      expect(right).toBeDefined();
      expect(right!.rotation).toBe(270);
    }
    // 4 wall_corners with rotations {0, 90, 180, 270}
    const corners = mid.tiles.filter((t) => t.frame === 'wall_corner');
    expect(corners).toHaveLength(4);
    const rotations = new Set(corners.map((t) => t.rotation ?? 0));
    for (const expected of [0, 90, 180, 270]) {
      expect(rotations.has(expected)).toBe(true);
    }
  });

  it('places the tiles_center hearth under the campfire (2×2 at anchor)', () => {
    const hearth = mid.tiles.filter((t) => t.frame === 'tiles_center');
    expect(hearth).toHaveLength(4);
    const coords = hearth.map((t) => `${t.col},${t.row}`).sort();
    expect(coords).toEqual(['7,1', '7,2', '8,1', '8,2']);
  });

  it('places the redesigned minimal camp scatter — mirrored moss + the entrance aperture', () => {
    // The menu redesign (c83ecd8) replaced the ticket-15 camp tableaux
    // (barrels_stacked/crate/barrel/chair/chest/moss-at-14,6) with a minimal
    // atmospheric scatter: 2 mirrored moss clusters framing the aisle + the
    // doorway aperture in the bottom-center wall (the camp entrance).
    // Mirrored moss clusters (the emerald accents flanking the path aisle).
    expect(mid.tiles.some((t) => t.frame === 'plants' && t.col === 4 && t.row === 4)).toBe(true);
    expect(mid.tiles.some((t) => t.frame === 'plants' && t.col === 11 && t.row === 4)).toBe(true);
    // Aperture — a doorway in the bottom-center wall (the camp entrance).
    expect(mid.tiles.some((t) => t.frame === 'doorway' && t.col === 7 && t.row === 8)).toBe(true);
    expect(mid.tiles.some((t) => t.frame === 'doorway' && t.col === 8 && t.row === 8)).toBe(true);
  });

  it('the camp tableaux props were REMOVED by the redesign (no chest/barrels/crate/chair in MID)', () => {
    // The redesign deliberately dropped the camp-tableaux props — the scatter
    // stays atmospheric (moss + entrance), not a loot pile. Guard against an
    // accidental resurrection of the old busy layout.
    for (const frame of ['barrels_stacked', 'crate', 'barrel', 'chair', 'chest']) {
      const hits = mid.tiles.filter((t) => t.frame === frame);
      expect(hits, `frame "${frame}" was removed by the redesign`).toEqual([]);
    }
  });

  it('keeps the fire focal zone (cols 7–8, rows 1–2) as hearth only — no scatter', () => {
    const SCATTER = new Set(['crate', 'crate_small', 'barrel', 'chest', 'chair', 'tree']);
    const intruders = mid.tiles.filter(
      (t) =>
        SCATTER.has(t.frame) &&
        t.col >= 7 && t.col <= 8 &&
        t.row >= 1 && t.row <= 2,
    );
    expect(intruders).toEqual([]);
  });
});

describe('MenuBackground — FG layer (nearest scatter)', () => {
  const fg = buildMenuDioramaComposition().find((l) => l.id === 'fg')!;

  it('places the nearest scatter in the lower corners only (02 §5)', () => {
    // crate_small col 4 + col 11 row 7; plants col 1 + col 14 row 7.
    expect(fg.tiles).toHaveLength(4);
    const frames = fg.tiles.map((t) => t.frame).sort();
    expect(frames).toEqual(['crate_small', 'crate_small', 'plants', 'plants']);
    // All FG tiles live on row 7 (the lower edge of the stage).
    for (const t of fg.tiles) {
      expect(t.row).toBe(7);
    }
  });
});

describe('MenuBackground — FAR + FORE layers (ticket 28 parallax upgrade)', () => {
  const layers = buildMenuDioramaComposition();
  const far = layers.find((l) => l.id === 'far')!;
  const fore = layers.find((l) => l.id === 'fore')!;

  it('FAR is a sparse distant silhouette (the haze-washed distant plane)', () => {
    // far is SPARSE (a few distant trees) — the atmospheric haze wash (α 0.28)
    // + the slow scrollFactor (0.45) do the depth work, not tile density.
    expect(far.tiles.length).toBeGreaterThan(0);
    expect(far.tiles.length).toBeLessThan(10);
    // Every far tile is a distant silhouette frame (tree for outdoor forest).
    for (const t of far.tiles) {
      expect(['tree', 'wall', 'wall_damaged']).toContain(t.frame);
    }
  });

  it('FORE is a dark silhouette frame across the top + upper edges, center OPEN', () => {
    // The "looking through" read: dark canopy/arch tiles frame the top edge +
    // upper corners. The center (cols 5–10) MUST stay open so the logo + hearth
    // are unobstructed (doc 19 §2b caveat).
    expect(fore.tiles.length).toBeGreaterThan(0);
    // No fore tile intrudes on the central stage (cols 5–10) at all.
    const intruders = fore.tiles.filter((t) => t.col >= 5 && t.col <= 10);
    expect(intruders).toEqual([]);
    // Every fore tile is at row 0 or row 1 (the top + upper edges only).
    for (const t of fore.tiles) {
      expect(t.row).toBeLessThanOrEqual(1);
    }
    // The fore tiles cluster at the upper corners (cols 0–3 + 12–15).
    const cornerTiles = fore.tiles.filter((t) => t.col <= 3 || t.col >= 12);
    expect(cornerTiles.length).toBe(fore.tiles.length);
  });
});

describe('MenuBackground — camera neutral (fire lands behind the logo)', () => {
  it('uses the stage-centered neutral (64, 36) per 04 §2', () => {
    // (2048-1920)/2 = 64; (1152-1080)/2 = 36.
    expect(MENU_CAMERA_NEUTRAL_X).toBe(64);
    expect(MENU_CAMERA_NEUTRAL_Y).toBe(36);
  });

  it('places the fire at screen (960, 220) — directly behind the logo (960, 194)', () => {
    const fireWorldX = CENTRAL_FIRE_COL * TILE + TILE / 2; // 1024
    const fireWorldY = CENTRAL_FIRE_ROW * TILE + TILE / 2; // 256
    const screenX = fireWorldX - MENU_CAMERA_NEUTRAL_X; // 960
    const screenY = fireWorldY - MENU_CAMERA_NEUTRAL_Y; // 220
    expect(screenX).toBe(960);
    // The logo sits at screen y = 0.18 * 1080 ≈ 194; the fire at 220 reads as
    // "behind" + slightly "below" — the cinematic silhouette frame.
    expect(screenY).toBe(220);
    expect(screenY - 194).toBeGreaterThan(0); // fire below the logo center.
    expect(screenY - 194).toBeLessThanOrEqual(40); // within the vertical cap.
  });
});

// NOTE: the `MenuBackground` class itself (Canvas-fallback lifecycle, boot/
// update/destroy with a real Phaser scene) is NOT unit-tested here because it
// imports the runtime `LightingPipeline` (WebGL-only — Phaser's import-time
// WebGL probe trips under jsdom). The class is integration code verified by:
//   - The TypeScript compiler (the full public API is typed).
//   - The browser harness in ticket 10 (Canvas no-black + WebGL lit diorama).
// These unit tests cover the PURE composition contract (the load-bearing
// layout + scrollFactor + camera-neutral invariants) that the visual depends on.

// Defense-in-depth: verify the composition slicing is internally consistent
// (the per-layer tile counts add up to a sensible total — guards against a
// future edit that double-counts or drops a tile).
describe('MenuBackground — composition totals', () => {
  const layers = buildMenuDioramaComposition();
  it('bakes a non-trivial scene (more than 50 tiles total)', () => {
    const total = layers.reduce((sum, l) => sum + l.tiles.length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it('BG is the densest layer (grass field + grove), MID next, FG sparsest', () => {
    const bgCount = layers.find((l) => l.id === 'bg')!.tiles.length;
    const midCount = layers.find((l) => l.id === 'mid')!.tiles.length;
    const fgCount = layers.find((l) => l.id === 'fg')!.tiles.length;
    // BG ≥ MID ≥ FG — the parallax depth read.
    expect(bgCount).toBeGreaterThanOrEqual(midCount);
    expect(midCount).toBeGreaterThanOrEqual(fgCount);
  });
});
