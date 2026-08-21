/**
 * Light-prop texture resolver — pure data module (no Phaser, no GPU).
 *
 * The sibling of {@link LightPalette}: where `LightPalette` resolves a
 * `LightKind` to its light color/tuning (the *glow*), this module resolves a
 * `LightKind` to the visible prop sprite atlas frame (the *fixture*). Together
 * they implement the AAA "motivated lighting" rule — every light disk needs a
 * visible fixture (`.scratch/lighting-system/art-polish/02-research.md` §2/§6/§7;
 * Level Design Book). The server emits only `{ gridX, gridY, kind, ... }`
 * placements with no textureKey (`LightPlacer.ts:235` comment: "the visible prop
 * sprite is resolved client-side"); this module is that client-side resolution.
 *
 * Ticket 16 (this file) created the mapping + the `lightProps` atlas art; ticket
 * 17 wired the resolved texture onto a visible GameObject at every placement.
 * Ticket 08 (A4) added `fireplace` / `brazier` / `lantern`:
 *   - `fireplace` REUSES the existing `game/campfire` frame (per user ruling +
 *     REVIEW item B2: the fireplace read relies on wall-adjacent indoor
 *     PLACEMENT in ticket 10, not sprite distinction). If post-ticket-10 it
 *     still reads as a campfire, a distinct sprite is the follow-up.
 *   - `brazier` + `lantern` get distinct procedural sprites in the `lightProps`
 *     atlas (see `.scratch/lighting-system-2/t08/generate_brazier_lantern.py` —
 *     dark-fantasy medieval, readable at 128×128 tile scale, top-down, hot
 *     white-yellow core + warm orange body so the prop reads as the SOURCE of
 *     the warm light disk).
 *
 * The `campfire` + `fireplace` kinds are special-cased to REUSE the existing
 * `game/campfire` atlas frame (the only flame frame that already existed in the
 * inventory) — they are NOT duplicated into the new sheet. Torch / candle /
 * brazier / lantern / biome-glow resolve to the `lightProps` atlas.
 *
 * The key type is the **shared** `LightKind` (placement contract) — NOT the
 * broader client `LightPalette` LightKind — so the resolver matches exactly the
 * kinds the server-side `LightPlacer` emits. `barrel-fire` is in the shared
 * union but barrels get NO static light (ticket 18 removes the wrong barrel
 * fire attribution); it resolves to `null` here so the resolver never throws on
 * a defensive kind, and ticket 17 simply skips placing a prop when the resolver
 * returns null.
 *
 * Cosmetic-only (GDD `docs/GDD.md:210`): a prop sprite is pure art — it carries
 * no vision/visibility semantics. The light disk it motivates is mood, never
 * gameplay.
 */
import type { FlameKind, LightKind } from '@sector-battle/shared';
import type { AtlasKey } from '../../assets/AssetManifest.js';

/**
 * A resolved prop-sprite texture: the Phaser two-arg form
 * `(texture, frame)` — e.g. `('game', 'campfire')` or `('lightProps', 'torch_01')`.
 * `null` means "no visible prop for this kind" (e.g. `barrel-fire`).
 */
export interface LightPropTexture {
  /** Atlas key — a member of {@link AtlasKey}. */
  readonly atlas: AtlasKey;
  /** Frame name (the `filename` field of the atlas JSON). */
  readonly frame: string;
}

/**
 * The static `LightKind` → prop-texture table.
 *
 * Ticket 08 (A4): added `fireplace` (reuses `game/campfire`), `brazier`
 * (distinct procedural sprite, 6 flicker frames), and `lantern` (distinct
 * procedural sprite, 6 flicker frames). The flame anims are listed in
 * {@link LIGHT_PROP_ANIMS}; biome-glow has its own 2-frame pulse.
 */
export const LIGHT_PROP_TEXTURES: Readonly<Record<LightKind, LightPropTexture | null>> = {
  torch: { atlas: 'lightProps', frame: 'torch_01' },
  campfire: { atlas: 'game', frame: 'campfire' },
  candle: { atlas: 'lightProps', frame: 'candle_01' },
  'biome-glow': { atlas: 'lightProps', frame: 'biome-glow_01' },
  'barrel-fire': null,
  // Ticket 08 (A4): fireplace reuses the campfire sprite (REVIEW item B2 — the
  // read relies on wall-adjacent indoor placement in ticket 10). The kind
  // distinction is in the LIGHT tuning (radius/intensity/flicker profile), not
  // the sprite.
  fireplace: { atlas: 'game', frame: 'campfire' },
  // Ticket 08 (A4): distinct procedural sprites (brazier = bowl of coals on a
  // stand; lantern = enclosed flame behind glass). See
  // `.scratch/lighting-system-2/t08/generate_brazier_lantern.py`.
  brazier: { atlas: 'lightProps', frame: 'brazier_01' },
  lantern: { atlas: 'lightProps', frame: 'lantern_01' },
  // Beacon (map-redesign ticket 04): the NEUTRAL crystal frame so the
  // per-placement theme `color` override (the sector type's identity hue,
  // map-polish ticket 03) tints it cleanly — same discipline as the menu
  // diorama's tinted crystals. Static fixture; the light disk's slow `pulse`
  // carries the "breathing" read.
  beacon: { atlas: 'lightProps', frame: 'biome-crystal_01' },
};

/**
 * Resolve a `LightKind` to its visible prop-sprite texture, or `null` if the
 * kind has no static prop (barrels). Pure data — no side effects, unit-testable.
 * Ticket 17 consumes this to spawn the visible fixture at each placement.
 */
export function resolveLightPropTexture(kind: LightKind): LightPropTexture | null {
  return LIGHT_PROP_TEXTURES[kind] ?? null;
}

/**
 * Re-export the shared {@link FlameKind} so existing imports from this module
 * (LightPropRenderer) keep resolving. Ticket 08: the canonical type now lives
 * in @sector-battle/shared (extended with fireplace/brazier/lantern).
 */
export type { FlameKind };

/**
 * Flame-bearing prop kinds → their sprite flicker animation frames in the
 * `lightProps` atlas.
 *
 * **Pixel-art fixture redesign:** every flame kind is now a STATIC fixture-only
 * sprite (1 frame) — the "living fire" feel comes from the LIGHT disk's flicker
 * (`TorchFlicker`), NOT from sprite animation. This mirrors the hand-painted
 * `game/campfire`, which is a static sprite lit by a flickering light disk.
 * Sprites that baked a flame/glow into the art clashed with the pixel-art tiles
 * (smooth gradients on hard-edged ground) — so all flame anims are empty here
 * and the fixtures are static.
 */
export const LIGHT_PROP_ANIMS: Readonly<Record<FlameKind, readonly string[]>> = {
  torch: [],
  campfire: [],
  candle: [],
  fireplace: [],
  brazier: [],
  lantern: [],
};

/**
 * The `biome-glow` crystal frame — a single static pixel-art crystal (the
 * fixture; the magical aura is the light disk). Previously a 2-frame pulse; now
 * static to match the fixture-only redesign + the hand-painted campfire.
 */
export const BIOME_GLOW_PULSE_FRAMES: readonly string[] = ['biome-glow_01'];

/**
 * The NEUTRAL crystal frames — a desaturated near-white derivative of
 * `biome-glow_01/02` (produced by `scripts/asset-pipeline/build-neutral-crystal.ts`
 * and appended into the `lightProps` atlas). Designed to `setTint` CLEANLY so a
 * single neutral frame recolors vividly to any hue — the menu diorama's per-
 * variant crystals (`forest` emerald, `crypt` violet, ...) all share this ONE
 * frame + a per-placement `color` tint. The original painted-blue `biome-glow_*`
 * frames would tint muddily, so they stay reserved for UNTINTED in-game biome-
 * glow (which keeps its cool-blue palette color).
 *
 * `LightPropRenderer` swaps to these frames only when a `biome-glow` placement
 * carries a per-placement `color` override (`LightPlacementTiled.color`).
 */
export const BIOME_CRYSTAL_FRAMES: readonly string[] = ['biome-crystal_01'];

/** The default neutral-crystal atlas frame (the first pulse frame). */
export const BIOME_CRYSTAL_FRAME_DEFAULT = 'biome-crystal_01';
